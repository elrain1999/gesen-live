const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {reserve}=require('../scripts/search-budget.cjs');
const {canReplace,guard}=require('../scripts/snapshot-guard.cjs');
const Y=require('../scripts/providers/youtube.cjs');
const {production}=require('./helpers.cjs');
const now='2026-11-25T10:00:00Z';
function mockLedger(initial){
 let state=initial,version=1;
 const calls=[];
 const fetcher=async(url,options)=>{
  calls.push({url,method:options.method});
  const body=options.body&&JSON.parse(options.body);
  let status=200,data={};
  if(url.includes('/git/ref/heads'))data={object:{sha:'main-sha'}};
  else if(url.endsWith('/git/refs'))status=201;
  else if(options.method==='GET'){
   if(!state)status=404;
   else data={sha:String(version),content:Buffer.from(JSON.stringify(state)).toString('base64')};
  }else if(body.sha!==undefined&&body.sha!==String(version))status=409;
  else if(state&&body.sha===undefined)status=422;
  else {state=JSON.parse(Buffer.from(body.content,'base64').toString());version++;status=body.sha?200:201;}
  return {ok:status<300,status,json:async()=>data};
 };
 return {fetcher,calls,get state(){return state;}};
}
const options=mock=>({token:'sentinel-secret',repository:'elrain1999/gesen-live',now,fetcher:mock.fetcher});
test('parallel Worker, schedule, manual and push share a CAS reservation; retry consumes its reservation',async()=>{
 const mock=mockLedger({day:Y.quotaDay(now),used:0,slots:[]});
 const results=await Promise.all(Array.from({length:4},()=>reserve(options(mock))));
 assert.equal(results.reduce((n,r)=>n+r.allowed,0),2);
 assert.equal(mock.state.used,2);
 assert.equal(results.filter(r=>r.reason==='slot_already_reserved').length,3);
 assert.doesNotMatch(JSON.stringify(mock.state),/sentinel-secret/);
});
test('near limit reserves only remaining attempts and missing/corrupt ledger stops search',async()=>{
 const mock=mockLedger({day:Y.quotaDay(now),used:79,slots:[]});
 assert.equal((await reserve(options(mock))).allowed,1);
 assert.equal((await reserve({...options(mock),now:'2026-11-25T10:15:00Z'})).allowed,0);
 assert.equal(mock.state.used,80);
 const missing=mockLedger();assert.equal((await reserve(options(missing))).allowed,0);assert.equal(missing.state.used,80);
 const corrupt=mockLedger({day:Y.quotaDay(now),used:-1,slots:[]});assert.equal((await reserve(options(corrupt))).allowed,0);
 const offline={...options(mock),fetcher:async()=>{throw Error('sentinel-secret');}};
 assert.deepEqual(await reserve(offline),{allowed:0,reason:'shared_ledger_unavailable'});
});
test('PT midnight resets ledger and summer reset uses Los Angeles daylight saving',async()=>{
 const mock=mockLedger({day:'2026-11-24',used:80,slots:[]});
 assert.equal((await reserve({...options(mock),now:'2026-11-25T07:59:59Z'})).allowed,0);
 assert.equal((await reserve({...options(mock),now:'2026-11-25T08:00:00Z'})).allowed,2);
 assert.equal(mock.state.day,'2026-11-25');
 assert.equal(Y.quotaDay('2026-07-01T06:59:59Z'),'2026-06-30');
 assert.equal(Y.quotaDay('2026-07-01T07:00:00Z'),'2026-07-01');
});
test('normal 17 hourly and 28 evening slots reserve 73 attempts in one PT day',async()=>{
 const mock=mockLedger({day:'2026-11-25',used:0,slots:[]});
 let total=0;
 for(let minute=0;minute<1440;minute++){
  const time=new Date(Date.parse('2026-11-25T08:00:00Z')+minute*60000);
  const hour=new Date(time.getTime()+9*3600000).getUTCHours();
  if(hour>=17?time.getUTCMinutes()%15===4:time.getUTCMinutes()===10)
   total+=(await reserve({...options(mock),now:time.toISOString()})).allowed;
 }
 assert.equal(total,73);assert.equal(mock.state.used,73);
});
test('cache loss and many manual runs never resurrect more than 80 shared attempts',async()=>{
 const mock=mockLedger({day:Y.quotaDay(now),used:0,slots:[]});let total=0;
 for(let i=0;i<56;i++)total+=(await reserve({...options(mock),now:new Date(Date.parse('2026-11-25T08:00Z')+i*900000).toISOString()})).allowed;
 assert.equal(total,80);assert.equal(mock.state.used,80);
});
test('normal/daytime/near-limit/429 retries obey allowances while non-search still works',async()=>{
 const channel=production().channels.find(c=>c.youtube_channel_id);
 for(const [time,used,allowance,status,expected] of [[now,0,2,200,2],['2026-11-25T00:00Z',0,2,200,1],[now,79,2,429,1],[now,0,2,429,2],[now,0,0,200,0]]){
  const calls=[];
  const result=await Y.collect([channel],{key:'fixture',now:time,searchAllowance:allowance,state:{day:Y.quotaDay(time),search_used:used,uploads:{[channel.youtube_channel_id]:{playlist:'uploads'}}},fetcher:async url=>{
   const route=new URL(url).pathname.split('/').pop();calls.push(route);
   return {ok:route!=='search'||status===200,status:route==='search'?status:200,headers:{get:()=>null},json:async()=>route==='search'&&status===429?{error:{errors:[{reason:'rateLimitExceeded'}]}}:{items:[]}};
  }});
  assert.equal(calls.filter(c=>c==='search').length,expected);
  assert.equal(result.state.search_used,used+expected);
  assert.ok(calls.includes('playlistItems'));
 }
});
const snapshot=(generated,success=generated)=>({schema_version:1,generated_at:generated,last_success_at:success,checks:[],streams:[],providers:{YouTube:{status:'ok'}}});
test('old backup cannot overwrite newer attempt or newer successful data; equal reuse is allowed',()=>{
 const old=snapshot('2026-11-23T14:34Z'),recent=snapshot(now);
 assert.equal(canReplace(old,recent),false);
 assert.equal(canReplace(recent,old),true);
 assert.equal(canReplace(recent,recent),true);
 assert.equal(canReplace(snapshot('2026-11-25T10:15Z',old.generated_at),recent),false);
 assert.equal(canReplace({},recent),false);
});
test('restore selects newer published snapshot, preserves newer local data and rejects stale publication',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'snapshot-guard-')),cwd=process.cwd();
 try{
  process.chdir(dir);fs.mkdirSync('data');fs.mkdirSync('dist');
  const old=snapshot('2026-11-23T14:34Z'),recent=snapshot(now);
  const fetcher=async()=>({ok:true,json:async()=>recent});
  fs.writeFileSync('data/streams.json',JSON.stringify(old));
  await guard('restore',{fetcher});assert.deepEqual(JSON.parse(fs.readFileSync('data/streams.json')),recent);
  await guard('restore',{fetcher:async()=>({ok:true,json:async()=>old})});assert.deepEqual(JSON.parse(fs.readFileSync('data/streams.json')),recent);
  fs.writeFileSync('dist/streams.json',JSON.stringify(old));await assert.rejects(guard('publish',{fetcher}),/ROLLBACK/);
  fs.writeFileSync('dist/streams.json',JSON.stringify(recent));await guard('publish',{fetcher});
  await assert.rejects(guard('publish',{fetcher:async()=>({ok:false})}),/UNAVAILABLE/);
 }finally{process.chdir(cwd);fs.rmSync(dir,{recursive:true,force:true});}
});

test('a reservation from yesterday cannot authorize calls after collection starts on the new PT day',async()=>{
 const channel=production().channels.find(c=>c.youtube_channel_id);const routes=[];
 await Y.collect([channel],{key:'fixture',now:'2026-11-25T08:00:00Z',searchAllowance:2,reservationDay:'2026-11-24',fetcher:async url=>{
  const u=new URL(url);routes.push(u.pathname.split('/').pop());return {ok:true,status:200,json:async()=>({items:[]})};
 }});
 assert.ok(!routes.includes('search'));
});
