const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');const os=require('node:os');const path=require('node:path');
const Y=require('../scripts/providers/youtube.cjs'),T=require('../scripts/providers/twitch.cjs');
const {merge,main}=require('../scripts/update.cjs');
const {request}=require('../scripts/providers/http.cjs');
const {report}=require('../scripts/validate-api.cjs');
const {production,now,stream}=require('./helpers.cjs');
const all=production().channels, yt=all.find(c=>c.youtube_channel_id),tw=all.find(c=>c.platform==='Twitch');
const reply=(data,status=200,headers={})=>({ok:status>=200&&status<300,status,headers:{get:key=>headers[key]??null},json:async()=>data});
const metadata={items:[{id:yt.youtube_channel_id,contentDetails:{relatedPlaylists:{uploads:'u'}}}]};
test('YouTube search quota does not discard successfully fetched archives or repeatedly consume failed searches',async()=>{
 const routes=[];
 const fetcher=async url=>{const route=new URL(url).pathname.split('/').pop();routes.push(route);
 if(route==='search')return reply({error:{errors:[{reason:'quotaExceeded'}]}},403);
 if(route==='channels')return reply(metadata);
 if(route==='playlistItems')return reply({items:[{contentDetails:{videoId:'v'}}]});
 return reply({items:[{id:'v',snippet:{channelId:yt.youtube_channel_id,title:'ガロスペ'},liveStreamingDetails:{actualStartTime:now,actualEndTime:now}}]});};
 const r=await Y.collect([yt],{key:'secret',now,fetcher});
 assert.equal(routes.filter(x=>x==='search').length,1);assert.equal(r.streams[0].status,'archive');
 assert.equal(r.checks.find(c=>c.kind==='archive').status,'ok');assert.equal(r.checks.find(c=>c.kind==='live').category,'quota');
 assert.equal(merge([],r,[yt],now).length,1);
});
test('YouTube partial discovery still transitions known live IDs and expires deleted IDs',async()=>{
 const old=stream(yt,{id:'live'}),deleted=stream(yt,{id:'deleted'});
 const fetcher=async url=>{const route=new URL(url).pathname.split('/').pop();if(route==='search')return reply({},500);if(route==='channels')return reply(metadata);if(route==='playlistItems')return reply({items:[]});return reply({items:[{id:'live',snippet:{channelId:yt.youtube_channel_id,title:'終了'},liveStreamingDetails:{actualStartTime:now,actualEndTime:now}}]});};
 const r=await Y.collect([yt],{key:'x',previous:[old,deleted],now,fetcher});
 const merged=merge([old,deleted],r,[yt],now);assert.equal(merged.length,1);assert.equal(merged[0].status,'archive');
});
test('YouTube daily search budget is 80, spreads calls over runs, rotates coverage and uses PT reset',async()=>{
 const channels=Array.from({length:50},(_,i)=>({...yt,record_id:'c'+i}));let searchCalls=0;
 const fetcher=async url=>{const route=new URL(url).pathname.split('/').pop();if(route==='search'){searchCalls++;return reply({items:[]});}if(route==='channels')return reply(metadata);return reply({items:[]});};
 let state;
 for(let i=0;i<20;i++){
   searchCalls=0;const result=await Y.collect(channels,{key:'x',now,state,fetcher});state=result.state;
   assert.ok(searchCalls<=8);
 }
 assert.equal(state.search_used,80);
 assert.equal(new Set(state.searched).size,80);
 assert.ok(channels.every(c=>state.searched.includes(c.record_id+':live')));
 searchCalls=0;const rerun=await Y.collect(channels,{key:'x',now,state,fetcher});assert.equal(searchCalls,0);
 const tomorrow=await Y.collect(channels,{key:'x',now:'2026-11-18T10:00:00Z',state:rerun.state,fetcher});
 assert.equal(searchCalls,8);assert.equal(tomorrow.state.searched[0],'c40:live');
 assert.equal(Y.quotaDay('2026-11-18T07:59:59Z'),'2026-11-17');assert.equal(Y.quotaDay('2026-11-18T08:00:00Z'),'2026-11-18');
});
test('YouTube fixed ID is resolved only by exact official handle match and source ledger is unchanged',async()=>{
 const unresolved=all.find(c=>c.youtube_handle&&!c.youtube_channel_id),before=JSON.stringify(unresolved);
 const id='UC'+'a'.repeat(22);let customUrl=unresolved.youtube_handle;
 const fetcher=async url=>{const u=new URL(url),route=u.pathname.split('/').pop();
 if(route==='channels'&&u.searchParams.has('forHandle'))return reply({items:[{id,snippet:{customUrl},contentDetails:{relatedPlaylists:{uploads:'u'}}}]});
 if(route==='search'||route==='playlistItems')return reply({items:[]});return reply(metadata);};
 const r=await Y.collect([unresolved],{key:'x',now,fetcher});assert.equal(r.resolutions[0].status,'verified');assert.equal(r.state.identifiers[unresolved.record_id].id,id);assert.equal(JSON.stringify(unresolved),before);
 customUrl='@different';const missing=await Y.collect([unresolved],{key:'x',now,fetcher});assert.equal(missing.resolutions[0].status,'unresolved');assert.ok(missing.checks.every(x=>x.status==='unresolved_id'));
});
test('YouTube authentication failure blocks additional calls and remains distinct from channel absence',async()=>{
 let calls=0;const r=await Y.collect([yt,{...yt,record_id:'second'}],{key:'private',now,fetcher:async()=>{calls++;return reply({error:{errors:[{reason:'keyInvalid'}]}},400);}});
 assert.equal(calls,1);assert.ok(r.checks.every(c=>c.category==='auth'));assert.doesNotMatch(JSON.stringify(r),/private/);
});
test('Twitch rate limit stops further calls, persists reset, and preserves old streams',{skip:'Twitch全面凍結'},async()=>{
 let calls=0;
 const fetcher=async url=>{calls++;const route=new URL(url).pathname.split('/').pop();if(route==='token')return reply({access_token:'hidden'});if(route==='users')return reply({data:[{id:'1',login:tw.twitch_login}]});return reply({},429,{'retry-after':'3600'});};
 const r=await T.collect([tw],{clientId:'client',clientSecret:'secret',now,fetcher});assert.equal(calls,3);assert.ok(r.checks.every(x=>x.category==='rate_limit'));assert.ok(r.state.retry_after);
 let retried=0;await T.collect([tw],{clientId:'client',clientSecret:'secret',state:r.state,now,fetcher:()=>{retried++;throw Error();}});assert.equal(retried,0);
 const old={...stream(tw),url:tw.channel_url};assert.equal(merge([old],r,[tw],now).length,1);assert.doesNotMatch(JSON.stringify(r),/hidden|secret/);
});
test('Twitch OAuth rejection is an auth failure and not a channel problem',{skip:'Twitch全面凍結'},async()=>{
 await assert.rejects(T.collect([tw],{clientId:'x',clientSecret:'secret',fetcher:async()=>reply({message:'secret'},400)}),e=>e.category==='auth'&&!e.message.includes('secret'));
});
test('Twitch user missing is channel unavailable; missing schedule differs from API failure',{skip:'Twitch全面凍結'},async()=>{
 const r=await T.collect([tw],{clientId:'x',clientSecret:'y',now,fetcher:async url=>new URL(url).pathname.endsWith('/token')?reply({access_token:'t'}):reply({data:[]})});
 assert.ok(r.checks.every(c=>c.status==='channel_unavailable'));
 assert.equal(merge([{...stream(tw),url:tw.channel_url}],r,[tw],now).length,0);
});
test('update uses isolated data directory, handles corrupt cache and records every approval without auth',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'retro-ring-'));
 try{fs.writeFileSync(path.join(dir,'streams.json'),'{bad');const r=await main({dataDir:dir,now,env:{}});assert.equal(r.checks.length,59*3);assert.equal(r.streams.length,0);assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'streams.json'))).schema_version,1);
 const v=report(r,all);assert.equal(v.channels.length,59);assert.equal(v.counts.auth_not_configured,177);assert.equal(v.channels.filter(c=>c.identifier==='fixed_id_unresolved').length,10);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('report separates API limit, auth error, channel issue, identity unresolved and successful empty window',()=>{
 const snapshot={generated_at:now,streams:[],checks:[{channel_id:yt.record_id,kind:'live',status:'error',category:'quota'},{channel_id:yt.record_id,kind:'upcoming',status:'error',category:'auth'},{channel_id:yt.record_id,kind:'archive',status:'ok'},{channel_id:tw.record_id,kind:'live',status:'channel_unavailable'},{channel_id:tw.record_id,kind:'upcoming',status:'unresolved_id'}]};
 const r=report(snapshot,[yt,tw]);assert.equal(r.counts.api_limit,1);assert.equal(r.counts.authentication_error,1);assert.equal(r.counts.api_success_no_broadcast_in_scanned_window,1);assert.equal(r.counts.channel_unavailable,undefined);assert.equal(r.counts.channel_id_unresolved,undefined);
});
test('HTTP error reason allowlist cannot leak arbitrary response text',async()=>{
 await assert.rejects(request('https://example.com/',{fetcher:async()=>reply({error:{errors:[{reason:'MY_SECRET'}]}},403)}),e=>!JSON.stringify(e).includes('MY_SECRET')&&e.message==='API_HTTP_403');
});
test('YouTube non-search budget stops at 8000 per PT day without issuing another request',async()=>{
 let calls=0;const r=await Y.collect([yt],{key:'x',now,state:{day:Y.quotaDay(now),search_used:80,rest_used:8000},fetcher:async()=>{calls++;return reply({items:[]});}});
 assert.equal(calls,0);assert.ok(r.checks.every(c=>c.error_code==='API_LOCAL_DAILY_LIMIT'));
});
test('live cache expires after two hours even while the page is left open',()=>{
 const M=require('../dist/model.js'),s=stream(yt,{fetched_at:'2026-11-17T07:59:59Z'});
 assert.equal(M.streams({streams:[s]},[yt],Date.parse(now)).length,0);
});

test('search 429 retries once after a longer delay and leaves recent and known live results usable',async()=>{
 const calls=[], waits=[];
 const cached=stream(yt,{id:'known',fetched_at:'2026-11-17T09:00:00Z'});
 const video=(id)=>({id,snippet:{channelId:yt.youtube_channel_id,title:'エヌアイン完全世界'},liveStreamingDetails:{actualStartTime:now}});
 const fetcher=async url=>{
   const u=new URL(url), endpoint=u.pathname.split('/').pop();
   calls.push(endpoint);
   if(endpoint==='search')return reply({},429);
   if(endpoint==='channels')return reply(metadata);
   if(endpoint==='playlistItems')return reply({items:[{contentDetails:{videoId:'new'}}]});
   return reply({items:u.searchParams.get('id').split(',').map(video)});
 };
 let time=Date.parse(now);
 const first=await Y.collect([yt],{key:'fixture',now,previous:[cached],fetcher,clock:()=>time,
   pause:async ms=>{waits.push(ms);time+=ms;}});
 assert.deepEqual(calls,['videos','channels','playlistItems','videos','search','search']);
 assert.deepEqual(waits.filter(ms=>ms>=1000),[10000]);
 assert.deepEqual(first.telemetry.endpoints.search,{requests:2,rate_limits:2,retries:1});
 assert.deepEqual(first.streams.map(s=>s.id),['known','new']);
 assert.equal(first.checks.find(c=>c.kind==='live').status,'error');
 assert.equal(first.checks.find(c=>c.kind==='live').endpoint,'search');
 assert.equal(first.checks.find(c=>c.kind==='archive').status,'ok');
 assert.equal(first.checks.find(c=>c.kind==='upcoming').status,'deferred');
 calls.length=0;
 const second=await Y.collect([yt],{key:'fixture',now,state:first.state,fetcher});
 assert.deepEqual(calls,['videos','playlistItems']);
 assert.equal(second.streams.length,2);
});

test('YouTube batches video lookups across channels and preserves ownership filtering',async()=>{
 const other={...yt,record_id:'other',youtube_channel_id:'UC'+'b'.repeat(22)};
 const byPlaylist=new Map([['one','a'],['two','b']]);
 const calls=[];
 const fetcher=async url=>{
   const u=new URL(url),resource=u.pathname.split('/').pop();
   calls.push(resource);
   if(resource==='channels')return reply({items:[
     {id:yt.youtube_channel_id,contentDetails:{relatedPlaylists:{uploads:'one'}}},
     {id:other.youtube_channel_id,contentDetails:{relatedPlaylists:{uploads:'two'}}},
   ]});
   if(resource==='playlistItems')return reply({items:[
     {contentDetails:{videoId:byPlaylist.get(u.searchParams.get('playlistId'))}},
     {contentDetails:{videoId:'shared'}},
   ]});
   if(resource==='search')return reply({items:[]});
   assert.deepEqual(u.searchParams.get('id').split(',').sort(),['a','b','shared']);
   return reply({items:['a','b','shared'].map(id=>({
     id,snippet:{channelId:id==='b'?other.youtube_channel_id:yt.youtube_channel_id,title:'KOF XI'},
     liveStreamingDetails:{actualStartTime:now},
   }))});
 };
 const result=await Y.collect([yt,other],{key:'fixture',now,fetcher});
 assert.equal(calls.filter(x=>x==='channels').length,1);
 assert.equal(calls.filter(x=>x==='videos').length,1);
 assert.deepEqual(result.streams.map(s=>[s.id,s.channel_id]),[['a',yt.record_id],['shared',yt.record_id],['b',other.record_id]]);
});

test('honours Retry-After without long waits and keeps unrelated archive cache',async()=>{
 const cached=stream(yt,{id:'old',status:'archive',fetched_at:'2026-11-17T09:00:00Z'});
 const waits=[];
 const fetcher=async url=>{
   const resource=new URL(url).pathname.split('/').pop();
   if(resource==='search')return reply({},429,{'retry-after':'1200'});
   if(resource==='channels')return reply(metadata);
   return reply({items:[]});
 };
 const r=await Y.collect([yt],{key:'fixture',now,fetcher,pause:async ms=>{waits.push(ms);}});
 assert.equal(r.telemetry.search_requests,1);
 assert.ok(waits.every(ms=>ms===120));
 assert.ok(Date.parse(r.state.cooldowns.search.until)-Date.parse(now)>=1200*1000);
 assert.deepEqual(merge([cached],r,[yt],now),[cached]);
});

test('known live cache expires during an outage when no video detail has been confirmed',async()=>{
 const old=stream(yt,{id:'old',fetched_at:'2026-11-17T07:59:59Z'});
 const r=await Y.collect([yt],{key:'fixture',previous:[old],now,fetcher:async()=>reply({error:{errors:[{reason:'dailyLimitExceeded'}]}},403)});
 assert.equal(r.telemetry.requests,1);
 assert.equal(r.verified_ids.length,0);
 assert.equal(merge([old],r,[yt],now).length,0);
 assert.equal(r.checks[0].category,'quota');
});

test('a successful 429 retry clears the warning while retaining the failed response count',async()=>{
 let searchCalls=0;
 const waits=[];
 let time=Date.parse(now);
 const fetcher=async url=>{
   const resource=new URL(url).pathname.split('/').pop();
   if(resource==='channels')return reply(metadata);
   if(resource==='search'&&++searchCalls===1)return reply({},429,{'retry-after':'12'});
   return reply({items:[]});
 };
 const result=await Y.collect([yt],{key:'fixture',now,fetcher,clock:()=>time,
   pause:async ms=>{waits.push(ms);time+=ms;}});
 assert.deepEqual(waits.filter(ms=>ms>=1000),[12000,1000]);
 assert.equal(result.provider.status,'ok');
 assert.ok(result.checks.every(c=>c.status==='ok'));
 assert.equal(result.telemetry.recovered,1);
 assert.deepEqual(result.telemetry.failed_responses,{search:{API_HTTP_429:1}});
 assert.equal(result.telemetry.requests,5);
});

test('live search uses an existing slot to check for a follow-on broadcast',async()=>{
 const recent={...yt,record_id:'recent',youtube_channel_id:'UC'+'z'.repeat(22)};
 const channels=[yt,recent];
 const search=[];
 const fetcher=async url=>{
   const request=new URL(url);
   const resource=request.pathname.split('/').pop();
   if(resource==='channels')return reply({items:channels.map(c=>({id:c.youtube_channel_id,contentDetails:{relatedPlaylists:{uploads:c.record_id}}}))});
   if(resource==='playlistItems')return reply({items:request.searchParams.get('playlistId')==='recent'?[{contentDetails:{videoId:'ended'}}]:[]});
   if(resource==='search'){
     const id=request.searchParams.get('channelId'),kind=request.searchParams.get('eventType');
     search.push([id,kind]);
     return reply({items:id===recent.youtube_channel_id&&kind==='live'?[{id:{videoId:'new'}}]:[]});
   }
   const id=request.searchParams.get('id');
   const liveStreamingDetails=id==='ended'?{actualStartTime:'2026-11-17T09:00:00Z',actualEndTime:now}:{actualStartTime:now};
   return reply({items:[{id,snippet:{channelId:recent.youtube_channel_id,title:'KOF XI'},liveStreamingDetails}]});
 };
 const result=await Y.collect(channels,{key:'fixture',now,fetcher});
 assert.deepEqual(search[0],[recent.youtube_channel_id,'live']);
 assert.equal(search.length,4);
 assert.equal(result.streams.find(s=>s.id==='new').status,'live');
 assert.equal(result.streams.find(s=>s.id==='ended').status,'archive');
});
