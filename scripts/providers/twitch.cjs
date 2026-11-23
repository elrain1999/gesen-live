const {request,failure,APIError}=require('./http.cjs');
async function collect(channels,{clientId,clientSecret,state={},now=new Date().toISOString(),fetcher=fetch}={}) {
  const telemetry={requests:0};
  const failedChecks=error=>channels.flatMap(c=>['live','upcoming','archive'].map(kind=>({channel_id:c.record_id,kind,status:'error',checked_at:now,...failure(error)})));
  if(state.retry_after && Date.parse(state.retry_after)>Date.parse(now)){const e=new APIError('API_HTTP_429',{status:429,retryAt:Date.parse(state.retry_after)});return {streams:[],checks:failedChecks(e),state,telemetry,provider:{status:'error',message:'APIレート制限の解除待ちです'}};}
  if(!clientId||!clientSecret)return {streams:[],checks:channels.flatMap(c=>['live','upcoming','archive'].map(kind=>({channel_id:c.record_id,kind,status:'not_configured',category:'auth',checked_at:now}))),telemetry,provider:{status:'not_configured',message:'API認証未設定のため配信情報は未取得'}};
  let token;
  try {token=await request('https://id.twitch.tv/oauth2/token',{method:'POST',body:new URLSearchParams({client_id:clientId,client_secret:clientSecret,grant_type:'client_credentials'}),fetcher,telemetry});}
  catch(error){if(!['network','rate_limit'].includes(error.category))error.category='auth';throw error;}
  if(typeof token.access_token!=='string')throw Error('API_TOKEN_UNAVAILABLE');
  let blocked;const next={};
  const api=async(resource,params,allow404=false)=>{
    if(blocked)throw blocked;
    try{return await request('https://api.twitch.tv/helix/'+resource+'?'+new URLSearchParams(params),{headers:{'Client-ID':clientId,Authorization:'Bearer '+token.access_token},fetcher,allow404,telemetry});}
    catch(error){if(['auth','rate_limit'].includes(error.category)){blocked=error;if(error.category==='rate_limit')next.retry_after=error.retry_at||new Date(Date.parse(now)+3600000).toISOString();}throw error;}
  };
  let users;
  try{users=await api('users',channels.map(c=>['login',c.twitch_login]));}
  catch(error){return {streams:[],checks:failedChecks(error),state:next,telemetry,provider:{status:'error',message:'アカウント照会に失敗しました。配信状況は未確認です。'}};}
  if(!Array.isArray(users.data))throw Error('API_INVALID_SHAPE');
  const userByLogin=new Map(users.data.map(u=>[u.login.toLowerCase(),u]));
  const streams=[],checks=[];
  let live,liveError;
  try {live=await api('streams',channels.map(c=>['user_login',c.twitch_login]).concat([['first','100']]));if(!Array.isArray(live.data))throw Error();} catch(error) {live=null;liveError=failure(error);}
  for(const c of channels){
    const check=(kind,status)=>checks.push({channel_id:c.record_id,kind,status,checked_at:now});
    const user=userByLogin.get(c.twitch_login.toLowerCase());
    if(!user){for(const k of ['live','upcoming','archive'])check(k,'channel_unavailable');continue;}
    const thumb=s=>typeof s==='string'?s.replaceAll('%{width}','480').replaceAll('%{height}','270').replaceAll('{width}','480').replaceAll('{height}','270'):null;
    if(live){
      for(const s of live.data.filter(s=>s.user_id===user.id))streams.push({id:s.id,channel_id:c.record_id,status:'live',title:s.title,starts_at:s.started_at,url:c.channel_url,thumbnail_url:thumb(s.thumbnail_url),fetched_at:now,kind:'broadcast'});
      check('live','ok');
    }else {check('live','error');Object.assign(checks[checks.length-1],liveError);}
    try {
      const result=await api('videos',{user_id:user.id,type:'archive',first:'20'});
      if(!Array.isArray(result.data))throw Error();
      for(const v of result.data)if(v.user_id===user.id && !live?.data.some(s=>s.id===v.stream_id))streams.push({id:v.id,channel_id:c.record_id,status:'archive',title:v.title,starts_at:v.created_at,url:v.url,thumbnail_url:thumb(v.thumbnail_url),fetched_at:now,kind:'broadcast'});
      check('archive','ok');
    }catch(error){check('archive','error');Object.assign(checks[checks.length-1],failure(error));}
    try {
      const result=await api('schedule',{broadcaster_id:user.id,first:'20',start_time:now},true);
      if(result && !Array.isArray(result.data?.segments))throw Error();
      const vacation=result?.data?.vacation;
      for(const s of result?.data?.segments||[]){
        if(s.canceled_until || Date.parse(s.end_time)<=Date.parse(now))continue;
        if(vacation && Date.parse(s.start_time)<Date.parse(vacation.end_time) && Date.parse(s.end_time)>Date.parse(vacation.start_time))continue;
        streams.push({id:'schedule:'+s.id,channel_id:c.record_id,status:'upcoming',title:s.title||'配信予定',starts_at:s.start_time,ends_at:s.end_time,url:c.channel_url+'/schedule',thumbnail_url:null,fetched_at:now,kind:'schedule'});
      }
      check('upcoming',result?'ok':'not_available');
    }catch(error){check('upcoming','error');Object.assign(checks[checks.length-1],failure(error));}
  }
  const errors=checks.some(c=>c.status==='error');
  return {streams,checks,state:next,telemetry,provider:{status:errors?'partial':'ok',message:errors?'一部の取得に失敗しました。最新状況は元チャンネルで確認してください':'公式API取得（ライブ・最近20件の公開VOD・登録された予定20件）'}};
}
module.exports={collect};
