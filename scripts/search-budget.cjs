// Reserve before collection. GitHub Contents SHA is an optimistic lock shared by all triggers.
const fs=require('node:fs');
const {quotaDay,searchRunLimit}=require('./providers/youtube.cjs');
const branch='youtube-quota-state',file='search-budget.json',limit=80;
async function reserve({token,repository,now=new Date().toISOString(),fetcher=fetch}={}){
  if(!token||repository!=='elrain1999/gesen-live')return {allowed:0,reason:'shared_ledger_unavailable'};
  const day=quotaDay(now),slot=String(Math.floor(Date.parse(now)/900000));
  const base='https://api.github.com/repos/'+repository;
  async function api(route,method='GET',body){
    const r=await fetcher(base+route,{method,headers:{authorization:'Bearer '+token,accept:'application/vnd.github+json','content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),redirect:'error',signal:AbortSignal.timeout(10000)});
    return {status:r.status,data:r.ok?await r.json():null};
  }
  try{
    for(let attempt=0;attempt<5;attempt++){
      const read=await api('/contents/'+file+'?ref='+branch);
      if(read.status===404){
        // No history cannot prove unused quota. Burn this PT day on first setup/recovery.
        const ref=await api('/git/ref/heads/main');
        if(ref.status!==200)break;
        await api('/git/refs','POST',{ref:'refs/heads/'+branch,sha:ref.data.object.sha});
        await api('/contents/'+file,'PUT',{branch,message:'Initialize conservative YouTube search ledger',content:Buffer.from(JSON.stringify({day,used:limit,slots:[]})).toString('base64')});
        continue;
      }
      if(read.status!==200)break;
      const stored=JSON.parse(Buffer.from(read.data.content,'base64').toString());
      if(!/^\d{4}-\d{2}-\d{2}$/.test(stored.day)||stored.day>day||!Number.isInteger(stored.used)||stored.used<0||stored.used>limit||!Array.isArray(stored.slots))break;
      const ledger=stored.day===day?stored:{day,used:0,slots:[]};
      if(ledger.slots.includes(slot))return {allowed:0,day,used:ledger.used,reason:'slot_already_reserved'};
      const allowed=Math.min(searchRunLimit(now),limit-ledger.used);
      if(!allowed)return {allowed:0,day,used:ledger.used,reason:'daily_limit'};
      const next={day,used:ledger.used+allowed,slots:[...ledger.slots,slot]};
      const write=await api('/contents/'+file,'PUT',{branch,sha:read.data.sha,message:'Reserve YouTube search attempts '+day,content:Buffer.from(JSON.stringify(next)).toString('base64')});
      if(write.status===200)return {allowed,day,used:next.used,reason:'reserved'};
      if(![409,422].includes(write.status))break;
    }
  }catch{}
  return {allowed:0,reason:'shared_ledger_unavailable'};
}
if(require.main===module)reserve({token:process.env.GH_TOKEN,repository:process.env.GITHUB_REPOSITORY}).then(result=>{
  console.log('Search reservation:',JSON.stringify(result));
  fs.mkdirSync('data',{recursive:true});
  fs.writeFileSync('data/search-reservation.json',JSON.stringify(result));
  if(result.reason==='shared_ledger_unavailable')console.error('::warning::Shared quota ledger unavailable; search disabled.');
  fs.appendFileSync(process.env.GITHUB_ENV,`YOUTUBE_SEARCH_ALLOWANCE=${result.allowed}\nYOUTUBE_SEARCH_DAY=${result.day||''}\n`);
});
module.exports={reserve};
