const fs=require('node:fs');
const path=require('node:path');
const M=require('../dist/model.js');
const {failure}=require('./providers/http.cjs');
// Twitch is frozen: do not import, authenticate, collect, or probe its adapter.
const providers={YouTube:require('./providers/youtube.cjs')};
function merge(previous,result,registered,now){
  const successful=new Set(result.checks.filter(c=>['ok','not_available','channel_unavailable'].includes(c.status)&&c.coverage!=='recent_uploads').map(c=>c.channel_id+':'+c.kind));
  const verified=new Set((result.verified_ids||[]).map(s=>s.channel_id+':'+s.id));
  const fresh=result.streams||[];
  const freshIds=new Set(fresh.map(s=>s.channel_id+':'+s.id));
  // Positive observations survive a failed discovery scan. Verified ID transitions
  // remove old live/upcoming copies even when the new state is an archive.
  const kept=previous.filter(s=>!successful.has(s.channel_id+':'+s.status)&&!verified.has(s.channel_id+':'+s.id)&&!freshIds.has(s.channel_id+':'+s.id));
  return M.streams({streams:[...fresh,...kept]},registered,Date.parse(now)).map(({game,stale,channel,...s})=>s);
}
function atomicWrite(filename,value){
  fs.mkdirSync(path.dirname(filename),{recursive:true});const temporary=filename+'.tmp';
  fs.writeFileSync(temporary,JSON.stringify(value,null,2)+'\n');fs.renameSync(temporary,filename);
}
async function main({dataDir=process.env.RETRO_RING_DATA_DIR||'data',now=new Date().toISOString(),collectors=providers,env=process.env}={}){
  // Always use the authoritative approved population, even for an isolated probe.
  const registered=M.channels(JSON.parse(fs.readFileSync('data/channels.public.json')));
  let previous={streams:[]};try{previous=JSON.parse(fs.readFileSync(path.join(dataDir,'streams.json')));if(!Array.isArray(previous.streams))throw Error();}catch{console.error('SNAPSHOT_MISSING_OR_INVALID: starting without cache');previous={streams:[]};}
  previous.streams=M.streams(previous,registered,Date.parse(now)).map(({game,stale,channel,...s})=>s);
  let state={};try{const cached=JSON.parse(fs.readFileSync(path.join(dataDir,'fetch-state.json')));if(cached&&typeof cached==='object'&&!Array.isArray(cached))state=cached;}catch{}
  const result={schema_version:1,generated_at:now,streams:[],checks:[],providers:{},resolutions:[],telemetry:{}};
  for(const [name,provider] of Object.entries(collectors)){
    if(name!=='YouTube')continue; // Also guard injected collectors and future wiring.
    const channels=registered.filter(c=>c.platform===name);let update;
    try{update=await provider.collect(channels,{key:env.YOUTUBE_API_KEY,previous:previous.streams,state:state[name],now});}
    catch(error){update={streams:[],checks:channels.flatMap(c=>['live','upcoming','archive'].map(kind=>({channel_id:c.record_id,kind,status:'error',checked_at:now,...failure(error)}))),provider:{status:'error',message:'取得に失敗しました。配信していないことを意味しません。'}};}
    result.streams.push(...merge(previous.streams,update,channels,now));result.checks.push(...update.checks);result.providers[name]=update.provider;
    result.resolutions.push(...(update.resolutions||[]));result.telemetry[name]=update.telemetry||{};
    if(update.state)state[name]=update.state;
    const checkCounts={};
    const liveCounts={ok:0,partial:0,deferred:0,error:0};
    for(const check of update.checks){
      checkCounts[check.status]=(checkCounts[check.status]||0)+1;
      if(check.kind==='live')liveCounts[check.status]=(liveCounts[check.status]||0)+1;
      if(check.error_code)console.error(`${name} ${check.channel_id} ${check.kind}: ${check.status} ${check.endpoint||'collector'} ${check.error_code} (${check.reason||check.category})`);
    }
    console.log(`${name}: ${update.provider.status}; checks=${JSON.stringify(checkCounts)}`);
    console.log(`${name} live channel checks: ${JSON.stringify(liveCounts)}`);
    console.log(`${name} API telemetry: ${JSON.stringify(result.telemetry[name])}`);
  }
  const previousSuccess=previous.last_success_at||
    (previous.streams.some(s=>s.fetched_at===previous.generated_at)?previous.generated_at:null);
  result.last_success_at=result.checks.some(c=>['ok','partial'].includes(c.status)||(c.observed||0)>0)?now:previousSuccess;
  result.providers.Twitch={status:'frozen',message:'Twitchは開発・取得・表示を凍結中です'};
  // Each file is replaced atomically; never overwrite a good snapshot with a partial write.
  atomicWrite(path.join(dataDir,'fetch-state.json'),state);
  atomicWrite(path.join(dataDir,'streams.json'),result);
  return result;
}
if(require.main===module)main().catch(()=>{console.error('UPDATE_FAILED: previous snapshot file preserved');process.exitCode=1;});
module.exports={merge,main,atomicWrite};
