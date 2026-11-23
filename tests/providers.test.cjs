const {test}=require('node:test');
const assert=require('node:assert/strict');
const Y=require('../scripts/providers/youtube.cjs');
const T=require('../scripts/providers/twitch.cjs');
const {merge}=require('../scripts/update.cjs');
const {request}=require('../scripts/providers/http.cjs');
const {production,now,stream}=require('./helpers.cjs');
const all=production().channels, youtube=all.find(c=>c.youtube_channel_id), twitch=all.find(c=>c.platform==='Twitch');
const reply=(data,status=200)=>({ok:status>=200&&status<300,status,json:async()=>data});
test('no credentials makes no API calls',async()=>{
  const fetcher=()=>{throw Error('should not call');};
  for(const provider of [Y])assert.equal((await provider.collect([],{fetcher})).provider.status,'not_configured');
});
test('YouTube handles concurrent streams, upcoming, archive, ordinary upload and ownership',async()=>{
  let searches=0;const fetcher=async url=>{
    const u=new URL(url),route=u.pathname.split('/').pop();
    if(route==='search'){searches++;return reply({items:[{id:{videoId:'a'}},{id:{videoId:'b'}},{id:{videoId:'c'}}]});}
    if(route==='channels')return reply({items:[{contentDetails:{relatedPlaylists:{uploads:'playlist'}}}]});
    if(route==='playlistItems')return reply({items:[{contentDetails:{videoId:'d'}}]});
    if(route==='videos')return reply({items:[
      ...['a','b'].map(id=>({id,snippet:{channelId:youtube.youtube_channel_id,title:'3rd STRIKE',thumbnails:{}},liveStreamingDetails:{actualStartTime:now}})),
      {id:'c',snippet:{channelId:youtube.youtube_channel_id,title:'予定'},liveStreamingDetails:{scheduledStartTime:'2026-11-18T00:00:00Z'}},
      {id:'d',snippet:{channelId:youtube.youtube_channel_id,title:'終了'},liveStreamingDetails:{actualStartTime:now,actualEndTime:now}},
      {id:'regular',snippet:{channelId:youtube.youtube_channel_id,title:'通常動画'}},
      {id:'foreign',snippet:{channelId:'different',title:'別'},liveStreamingDetails:{actualStartTime:now}}
    ]});throw Error('unknown endpoint');
  };
  const result=await Y.collect([youtube],{key:'test-secret',now,fetcher});
  assert.deepEqual(result.streams.map(s=>s.status),['live','live','upcoming','archive']);
  assert.equal(searches,2);assert.ok(result.checks.every(c=>c.status==='ok'));
  searches=0;await Y.collect([youtube],{key:'test-secret',state:result.state,now,fetcher});assert.equal(searches,0);
});
test('YouTube unresolved IDs are not guessed and failures remain errors',async()=>{
  const unresolved=all.find(c=>c.platform==='YouTube'&&!c.youtube_channel_id);
  const skipped=await Y.collect([unresolved],{key:'x',now,fetcher:()=>{throw Error('called');}});
  assert.ok(skipped.checks.every(c=>c.status==='unresolved_id'));
  const result=await Y.collect([youtube],{key:'x',now,fetcher:async()=>reply({},403)});
  assert.ok(result.checks.every(c=>c.status==='error'));assert.equal(result.provider.status,'partial');
});
test('Twitch auth, live/VOD dedup, canceled/vacation schedule, 404 and partial failure',{skip:'Twitch全面凍結：既存テストを保存し実行しない'},async()=>{
  let scheduleStatus=200, videosStatus=200;
  const fetcher=async url=>{
    const u=new URL(url),route=u.pathname.split('/').pop();
    if(route==='token')return reply({access_token:'fake-token'});
    if(route==='users')return reply({data:[{id:'123',login:twitch.twitch_login}]});
    if(route==='streams')return reply({data:[{id:'live-id',user_id:'123',title:'北斗の拳',started_at:now,thumbnail_url:'https://static-cdn.jtvnw.net/{width}x{height}.jpg'}]});
    if(route==='videos')return reply({data:[{id:'ongoing',user_id:'123',stream_id:'live-id'},{id:'vod',user_id:'123',stream_id:'ended',title:'3rd STRIKE',created_at:now,url:'https://www.twitch.tv/videos/9',thumbnail_url:'https://static-cdn.jtvnw.net/%{width}x%{height}.jpg'}]},videosStatus);
    if(route==='schedule')return reply({data:{segments:[{id:'future',title:'対戦会',start_time:'2026-11-18T00:00:00Z',end_time:'2026-11-18T01:00:00Z'},{id:'canceled',canceled_until:now,start_time:now,end_time:now}]}},scheduleStatus);
    throw Error('unknown endpoint');
  };
  const params={clientId:'x',clientSecret:'y',now,fetcher};
  const result=await T.collect([twitch],params);
  assert.deepEqual(result.streams.map(s=>s.status),['live','archive','upcoming']);
  assert.ok(result.streams[1].thumbnail_url.includes('/480x270'));
  scheduleStatus=404;videosStatus=500;
  const partial=await T.collect([twitch],params);
  assert.equal(partial.checks.find(c=>c.kind==='archive').status,'error');
  assert.equal(partial.checks.find(c=>c.kind==='upcoming').status,'not_available');
  assert.equal(partial.checks.find(c=>c.kind==='live').status,'ok');
});
test('failed partitions preserve timestamp; successful empty replaces; expired cache removed',()=>{
  const old=stream(youtube,{fetched_at:'2026-11-17T08:00:00Z'});
  const update={streams:[],checks:[{channel_id:youtube.record_id,kind:'live',status:'error'}]};
  assert.equal(merge([old],update,[youtube],now)[0].fetched_at,old.fetched_at);
  update.checks[0].status='ok';assert.equal(merge([old],update,[youtube],now).length,0);
  update.checks[0].status='error';assert.equal(merge([{...old,fetched_at:'2026-10-01T00:00:00Z'}],update,[youtube],now).length,0);
});
test('HTTP errors redact secret URLs and response bodies',async()=>{
  await assert.rejects(request('https://example.com/?key=SECRET',{fetcher:async()=>reply({secret:'SECRET'},429)}),/^Error: API_HTTP_429$/);
  await assert.rejects(request('https://example.com/?key=SECRET',{fetcher:async()=>{throw Error('SECRET');}}),/^Error: API_NETWORK_OR_TIMEOUT$/);
});

test('viewer count from existing video details; upload playlist cache survives refresh',async()=>{
  const calls=[];
  const ids=['aaa00000001','aaa00000002','aaa00000003','aaa00000004'];
  const fetcher=async url=>{
    const resource=new URL(url).pathname.split('/').pop();calls.push(resource);
    if(resource==='channels')return reply({items:[{contentDetails:{relatedPlaylists:{uploads:'upload-list'}}}]});
    if(resource==='playlistItems')return reply({items:ids.map(videoId=>({contentDetails:{videoId}}))});
    if(resource==='search')return reply({items:[]});
    return reply({items:ids.map((id,i)=>({id,snippet:{channelId:youtube.youtube_channel_id,title:'北斗の拳'},liveStreamingDetails:{actualStartTime:now,concurrentViewers:['25','0',undefined,'invalid'][i]}}))});
  };
  const first=await Y.collect([youtube],{key:'fixture',now,fetcher});
  assert.deepEqual(first.streams.map(s=>s.concurrent_viewers),[25,0,null,null]);
  calls.length=0;
  await Y.collect([youtube],{key:'fixture',now,state:first.state,fetcher});
  assert.deepEqual(calls,['playlistItems','videos']);
});
