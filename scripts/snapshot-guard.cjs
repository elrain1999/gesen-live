const fs=require('node:fs');
const {atomicWrite}=require('./update.cjs');
function times(s){
  const generated=Date.parse(s?.generated_at),success=Date.parse(s?.last_success_at);
  return s?.schema_version===1&&Array.isArray(s.streams)&&Array.isArray(s.checks)&&Number.isFinite(generated)&&generated<=Date.now()&&(!s.last_success_at||(Number.isFinite(success)&&success<=generated))?{generated,success:Number.isFinite(success)?success:0}:null;
}
function canReplace(candidate,current){
  const a=times(candidate),b=times(current);
  return !!a&&(!b||(a.generated>=b.generated&&a.success>=b.success));
}
async function published(fetcher=fetch){
  const response=await fetcher('https://elrain1999.github.io/gesen-live/streams.json?freshness='+Date.now(),{cache:'no-store',headers:{accept:'application/json','cache-control':'no-cache'},redirect:'error',signal:AbortSignal.timeout(10000)});
  if(!response.ok)throw Error('PUBLISHED_SNAPSHOT_UNAVAILABLE');
  const data=await response.json();
  if(!times(data))throw Error('PUBLISHED_SNAPSHOT_INVALID');
  return data;
}
async function guard(mode,{fetcher=fetch}={}){
  // Fail closed on a failed public read: never publish an unverified restore.
  const live=await published(fetcher);
  const filename=mode==='restore'?'data/streams.json':'dist/streams.json';
  let local;try{local=JSON.parse(fs.readFileSync(filename));}catch{}
  if(mode==='restore'){
    if(!canReplace(local,live)){
      atomicWrite(filename,live);
      console.log('Restored newer published snapshot; API state remains separate');
    }
  }else if(!canReplace(local,live))throw Error('SNAPSHOT_ROLLBACK_REFUSED');
}
if(require.main===module)guard(process.argv[2]).catch(()=>{console.error('SNAPSHOT_FRESHNESS_NOT_PROVEN: stopped before collection/publication');process.exitCode=1;});
module.exports={times,canReplace,guard};
