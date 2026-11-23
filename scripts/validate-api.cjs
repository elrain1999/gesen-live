const fs=require('node:fs');
const path=require('node:path');
const {main,atomicWrite}=require('./update.cjs');
const M=require('../dist/model.js');
function report(snapshot,registered){
  const channels=M.activeChannels(registered).map(c=>{
    const resolution=snapshot.resolutions?.find(r=>r.channel_id===c.record_id);
    const results=['live','upcoming','archive'].map(kind=>{
      const check=snapshot.checks.find(x=>x.channel_id===c.record_id&&x.kind===kind)||{status:'not_checked'};
      const count=snapshot.streams.filter(x=>x.channel_id===c.record_id&&x.status===kind&&x.fetched_at===snapshot.generated_at).length;
      const outcome=check.status==='not_configured'?'auth_not_configured':check.status==='unresolved_id'?'channel_id_unresolved':check.status==='channel_unavailable'?'channel_unavailable':check.category==='auth'?'authentication_error':['quota','rate_limit'].includes(check.category)?'api_limit':check.status==='error'?'request_failed':['ok','partial','not_available'].includes(check.status)?count?'api_success_with_broadcast':'api_success_no_broadcast_in_scanned_window':'not_checked';
      return {kind,outcome,count,coverage:check.coverage||'bounded_scan',...(check.error_code?{error_code:check.error_code}:{}),...(check.category?{category:check.category}:{})};
    });
    return {record_id:c.record_id,platform:c.platform,display_name:c.display_name,identifier:c.platform==='Twitch'?'login_confirmed':c.youtube_channel_id?'fixed_id_from_phase4':resolution?.status==='verified'?'fixed_id_verified_by_api':'fixed_id_unresolved',results};
  });
  const counts={};for(const c of channels)for(const r of c.results)counts[r.outcome]=(counts[r.outcome]||0)+1;
  return {schema_version:1,checked_at:snapshot.generated_at,counts,channels_with_broadcast:new Set(snapshot.streams.filter(s=>s.fetched_at===snapshot.generated_at).map(s=>s.channel_id)).size,channels,telemetry:snapshot.telemetry,notes:['No synthetic broadcasts are stored.','No-broadcast outcomes apply only to the scanned API window.','Provider authentication failure does not establish channel availability.']};
}
async function validate(){
  const dir=process.env.RETRO_RING_DATA_DIR||'data';
  const snapshot=await main({dataDir:dir});
  const registered=M.channels(JSON.parse(fs.readFileSync('data/channels.public.json')));
  const result=report(snapshot,registered);atomicWrite(path.join(dir,'api-validation.json'),result);
  console.log('API_VALIDATION '+JSON.stringify(result.counts));
  return result;
}
if(require.main===module)validate().catch(()=>{console.error('API_VALIDATION_FAILED');process.exitCode=1;});
module.exports={report,validate};
