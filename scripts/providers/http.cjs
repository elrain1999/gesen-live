const reasons=new Set(['quotaExceeded','dailyLimitExceeded','keyInvalid','accessNotConfigured','forbidden','channelNotFound','playlistNotFound','invalidParameter','invalidCredentials']);
class APIError extends Error {
  constructor(code,{status,reason,retryAt}={}) {
    super(code);this.status=status;this.reason=reason;
    this.category=reason==='quotaExceeded'||reason==='dailyLimitExceeded'?'quota':status===429?'rate_limit':status===401||reason==='keyInvalid'||reason==='accessNotConfigured'||reason==='invalidCredentials'?'auth':status===404?'channel':code==='API_NETWORK_OR_TIMEOUT'?'network':'api';
    if(Number.isFinite(retryAt))this.retry_at=new Date(retryAt).toISOString();
  }
}
async function request(url,{headers={},method='GET',body,allow404=false,fetcher=fetch,telemetry}={}) {
  let response;
  try {response=await fetcher(url,{headers,method,body,signal:AbortSignal.timeout(15000)});}
  catch {throw new APIError('API_NETWORK_OR_TIMEOUT');}
  if(telemetry){telemetry.requests=(telemetry.requests||0)+1;for(const field of ['limit','remaining','reset']){const value=response.headers?.get('ratelimit-'+field);if(value!=null&&Number.isFinite(Number(value)))telemetry['rate_'+field]=Number(value);}}
  if(allow404&&response.status===404)return null;
  if(!response.ok){
    let data;try{data=await response.json();}catch{}
    const raw=data?.error?.errors?.[0]?.reason;
    const reason=reasons.has(raw)?raw:undefined;
    const reset=Number(response.headers?.get('ratelimit-reset'))*1000;
    const after=Number(response.headers?.get('retry-after'));
    const retryAt=reset>Date.now()?reset:after>0?Date.now()+after*1000:undefined;
    throw new APIError(`API_HTTP_${response.status}`,{status:response.status,reason,retryAt});
  }
  try{return await response.json();}catch{throw new APIError('API_INVALID_JSON');}
}
const errorCode=error=>/^API_[A-Z0-9_]+$/.test(error?.message)?error.message:'API_INVALID_RESPONSE';
const failure=error=>({error_code:errorCode(error),category:error?.category||'api',...(error?.reason?{reason:error.reason}:{}),...(error?.retry_at?{retry_at:error.retry_at}:{})});
module.exports={request,errorCode,failure,APIError};
