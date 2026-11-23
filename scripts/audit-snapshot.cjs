const fs=require('node:fs');const path=require('node:path');const crypto=require('node:crypto');
const M=require('../dist/model.js');
function audit(snapshot,registry,{now=Date.now(),requireOwnership=false}={}){
 const channels=M.activeChannels(M.channels(registry)), byId=new Map(channels.map(c=>[c.record_id,c]));
 const generated=Date.parse(snapshot.generated_at),counts={live:0,upcoming:0,archive:0},owners=new Set(),byChannel={};
 const errors=[],warnings=[],seen=new Set();let ownershipConfirmed=0;
 const resolutions=new Map((snapshot.resolutions||[]).filter(r=>r.status==='verified').map(r=>[r.channel_id,r]));
 for(const c of channels)byChannel[c.record_id]={name:c.display_name,live:0,upcoming:0,archive:0,checks:{}};
 if(!Number.isFinite(generated)||generated>now+300000)errors.push({code:'INVALID_GENERATED_AT'});
 for(const s of snapshot.streams||[]){
  const c=byId.get(s.channel_id),fields={id:s.id,channel_id:s.channel_id};
  const fail=code=>errors.push({code,...fields});
  if(!c){fail('UNAPPROVED_OR_INACTIVE_CHANNEL');continue;}
  if(!/^[\w-]{11}$/.test(s.id||'')){fail('INVALID_VIDEO_ID');continue;}
  if(seen.has(s.id))fail('DUPLICATE_VIDEO');seen.add(s.id);
  let url;try{url=new URL(s.url);}catch{fail('INVALID_VIDEO_URL');}
  if(!url||url.protocol!=='https:'||url.hostname!=='www.youtube.com'||url.pathname!=='/watch'||url.searchParams.get('v')!==s.id)fail('VIDEO_URL_ID_MISMATCH');
  const resolution=resolutions.get(c.record_id);
  const validResolution=resolution&&resolution.handle===c.youtube_handle&&/^UC[\w-]{22}$/.test(resolution.youtube_channel_id||'')&&Number.isFinite(Date.parse(resolution.verified_at))&&Date.parse(resolution.verified_at)<=generated+300000;
  const expected=c.youtube_channel_id||(validResolution?resolution.youtube_channel_id:null);
  if(!expected)fail('CHANNEL_ID_UNRESOLVED');
  if(s.source_channel_id){if(s.source_channel_id!==expected)fail('VIDEO_CHANNEL_MISMATCH');else ownershipConfirmed++;}
  else if(requireOwnership)fail('OWNERSHIP_EVIDENCE_MISSING');
  const start=Date.parse(s.starts_at),fetched=Date.parse(s.fetched_at),end=Date.parse(s.ends_at);
  if(!Number.isFinite(start)||!Number.isFinite(fetched)||fetched>generated+300000||fetched>now+300000)fail('INVALID_TIMESTAMPS');
  if(['live','archive'].includes(s.status)&&start>fetched+300000)fail('FUTURE_ACTUAL_START');
  if(s.status==='live'&&s.ends_at)fail('LIVE_ALREADY_ENDED');
  if(s.status==='archive'&&(!Number.isFinite(end)||end<start||end>fetched+300000))fail('INVALID_ARCHIVE_END');
  if(s.status==='upcoming'&&s.ends_at)fail('UPCOMING_WITH_ACTUAL_END');
  if(!['live','upcoming','archive'].includes(s.status)){fail('INVALID_STATE');continue;}
  if(typeof s.title!=='string'||!s.title.trim())fail('EMPTY_TITLE');
  if(s.thumbnail_url&&!M.safeUrl(s.thumbnail_url,'YouTube',true))fail('INVALID_THUMBNAIL');
  counts[s.status]++;byChannel[c.record_id][s.status]++;owners.add(c.record_id);
 }
 const checked=new Set();
 for(const check of snapshot.checks||[]){if(!byId.has(check.channel_id))continue;const key=check.channel_id+':'+check.kind;if(checked.has(key))errors.push({code:'DUPLICATE_CHECK',channel_id:check.channel_id});checked.add(key);byChannel[check.channel_id].checks[check.kind]=check.status;}
 for(const c of channels)for(const kind of ['live','upcoming','archive'])if(!checked.has(c.record_id+':'+kind))errors.push({code:'MISSING_CHECK',channel_id:c.record_id,kind});
 if(ownershipConfirmed<(snapshot.streams||[]).length)warnings.push('Historical snapshot omits response channel IDs; ownership is supported by the ingestion guard, not independently rechecked.');
 const visible=M.streams(snapshot,channels,now);
 return {schema_version:1,generated_at:snapshot.generated_at,audited_at:new Date(now).toISOString(),input_channels:channels.length,checks:checked.size,records:(snapshot.streams||[]).length,counts,distinct_channels_with_broadcast:owners.size,channels_by_state:Object.fromEntries(['live','upcoming','archive'].map(k=>[k,Object.values(byChannel).filter(c=>c[k]>0).length])),ownership_confirmed_records:ownershipConfirmed,visible_now:{total:visible.length,...Object.fromEntries(['live','upcoming','archive'].map(k=>[k,visible.filter(s=>s.status===k).length]))},duplicate_video_ids:(snapshot.streams||[]).length-seen.size,by_channel:byChannel,telemetry:snapshot.telemetry?.YouTube||{},errors,warnings,passed:errors.length===0};
}
if(require.main===module){
 const input=process.argv[2]||'data/streams.json',output=process.argv[3]||'artifacts/youtube-audit.json';
 const bytes=fs.readFileSync(input),result=audit(JSON.parse(bytes),JSON.parse(fs.readFileSync('data/channels.public.json')),{requireOwnership:process.env.REQUIRE_OWNERSHIP==='1'});result.input_sha256=crypto.createHash('sha256').update(bytes).digest('hex');
 fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({passed:result.passed,channels:result.input_channels,checks:result.checks,records:result.records,counts:result.counts,channels_by_state:result.channels_by_state,ownership_confirmed:result.ownership_confirmed_records,errors:result.errors.length,warnings:result.warnings}));if(!result.passed)process.exitCode=1;
}
module.exports={audit};
