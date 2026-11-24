const {appendFileSync}=require('node:fs');

async function checkPublishedSnapshot({fetcher=fetch,now=Date.now,key=''}={}){
  const url=new URL('https://elrain1999.github.io/gesen-live/streams.json');
  if(key)url.searchParams.set('schedule_check',key);

  try{
    const response=await fetcher(url,{
      cache:'no-store',headers:{accept:'application/json'},redirect:'error',signal:AbortSignal.timeout(8000)
    });
    if(!response.ok)return {refresh:true,reason:'pages_http_error'};
    const snapshot=await response.json();
    const checkedAt=now();
    const lastSuccess=Date.parse(snapshot?.last_success_at);
    const generated=Date.parse(snapshot?.generated_at);
    if(snapshot?.schema_version!==1||!Number.isFinite(lastSuccess)||!Number.isFinite(generated)||
      lastSuccess>generated||generated>checkedAt)return {refresh:true,reason:'invalid_snapshot'};

    const jstHour=new Date(checkedAt+9*3600000).getUTCHours();
    const maxAge=(jstHour>=17?10:60)*60000;
    return checkedAt-lastSuccess>=maxAge
      ? {refresh:true,reason:'last_success_stale'}
      : {refresh:false,reason:'last_success_fresh'};
  }catch{
    // An unreachable Pages endpoint cannot prove that production is up to date.
    return {refresh:true,reason:'pages_check_failed'};
  }
}

if(require.main===module){
  const key=process.env.GITHUB_RUN_ID+'-'+process.env.GITHUB_RUN_ATTEMPT;
  checkPublishedSnapshot({key}).then(({refresh,reason})=>{
    console.log(`Schedule backup: ${reason}, refresh=${refresh}`);
    appendFileSync(process.env.GITHUB_OUTPUT,`refresh=${refresh}\n`);
  }).catch(()=>{
    console.error('Could not write backup decision');
    process.exitCode=1;
  });
}

module.exports={checkPublishedSnapshot};
