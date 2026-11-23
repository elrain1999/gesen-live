const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const M=require('../dist/model.js');
const {production,now,stream}=require('./helpers.cjs');
const source=production(), registered=M.channels(source), channel=registered[0];
test('production population and excluded IDs; multiple channels stay separate',()=>{
  assert.equal(registered.length,70);
  assert.equal(registered.filter(c=>c.platform==='YouTube').length,59);
  assert.equal(registered.filter(c=>c.platform==='Twitch').length,11);
  assert.equal(registered.filter(c=>c.platform==='YouTube'&&!c.youtube_channel_id).length,10);
  assert.equal(M.channels({...source,channels:[...source.channels,{...channel,record_id:'hold',status:'on_hold'},{...channel,record_id:'reject',status:'excluded'}]}).length,70);
  const will=registered.filter(c=>c.display_name.includes('WILL'));assert.ok(will.length>=2);
  assert.equal(new Set(will.map(c=>c.record_id)).size,will.length);
});
test('generated data contains only production display and identity fields',()=>{
  const context={window:{}};vm.runInNewContext(fs.readFileSync('dist/data.js','utf8'),context);
  const generated=JSON.parse(JSON.stringify(context.window.CHANNEL_DATA));
  assert.deepEqual(generated.channels.map(c=>c.record_id),M.activeChannels(registered).map(c=>c.record_id));
  const publicKeys=['record_id','status','platform','display_name','channel_url','youtube_handle','youtube_channel_id'];
  assert.deepEqual(generated.channels,M.activeChannels(registered).map(c=>Object.fromEntries(publicKeys.map(k=>[k,c[k]]))));
  assert.doesNotMatch(fs.readFileSync('dist/index.html','utf8'),/SAMPLE_DATA|サンプルデータ/);
});
test('Real Bout Special aliases never count as Garou Special',()=>{
  for(const title of [
    'REAL BOUT 餓狼伝説SPECIAL', 'リアルバウト餓狼伝説SPECIAL',
    'リアルバウト餓狼伝説スペシャル', 'Real Bout Fatal Fury Special',
    'REAL BOUT SPECIAL', 'RB SPECIAL', 'RBSP', 'ＲＢＳＰ（餓狼伝説ＳＰＥＣＩＡＬ）',
    'RB-SPECIAL: Fatal Fury Special', 'リアルバウト餓狼伝説2', '餓狼伝説3'
  ]) assert.equal(M.classify(title),'unknown',title);
  assert.equal(M.classify('Fatal Fury Special'),'garousp');
  assert.equal(M.classify('RBSP / 餓狼伝説SPECIAL'),'garousp');
  assert.equal(M.classify('REAL BOUT 餓狼伝説SPECIAL / 3rd STRIKE'),'third');
  const streamTitle = 'REAL BOUT 餓狼伝説SPECIAL 対戦会';
  assert.equal(M.streams({streams:[stream(channel,{title:streamTitle})]},registered,Date.parse(now))[0].game,'unknown');
  assert.equal(M.games.length,7);
});
test('conservative game classification accepts unknown and does not mix similar games',()=>{
  for(const [title,id] of [['ガロスペ','garousp'],['餓狼伝説SPECIAL','garousp'],['真サム対戦','shinsam'],['3rd STRIKE','third'],['カプエス2','cvs2'],['ヴァンパイアセイヴァー','savior'],['スパⅡX','sf2'],['北斗の拳','hokuto'],['餓狼MOW','unknown'],['ヴァンパイアハンター','unknown'],['SF6','unknown'],['ガロスペ / スパ2X','unknown']])assert.equal(M.classify(title),id,title);
});
test('URL allowlists reject injected or unrelated links and thumbnails',()=>{
  for(const value of ['javascript:alert(1)','http://youtube.com/','https://youtube.com.evil.test/',new URL('/', 'https://' + ['user:pass', 'youtube.com'].join('@')).href,'https://example.com/'])assert.equal(M.safeUrl(value,'YouTube'),null);
  assert.ok(M.safeUrl(channel.channel_url,'YouTube'));
  assert.equal(M.safeUrl('https://example.com/img','YouTube',true),null);
});
test('stream validation: dedup, approval gate, malformed records, stale and expiry',()=>{
  const s=stream(channel);const get=a=>M.streams({streams:a},registered,Date.parse(now));
  assert.equal(get([s,s,null,{}, {...s,id:'excluded',channel_id:'unknown'}]).length,1);
  assert.equal(get([{...s,fetched_at:'2026-11-17T08:00:00Z'}])[0].stale,true);
  assert.equal(get([{...s,fetched_at:'2026-11-15T00:00:00Z'}]).length,0);
  assert.equal(get([{...s,starts_at:'broken'}]).length,0);
  assert.equal(get([{...s,status:'upcoming',starts_at:'2026-11-16T09:00:00Z'}]).length,0);
  assert.equal(get([{...s,status:'archive',starts_at:'2026-09-01T00:00:00Z'}]).length,0);
  assert.equal(get([{...s,fetched_at:'2026-11-18T00:00:00Z'}]).length,0);
});
test('combined filters search channel associations without changing input',()=>{
  const before=JSON.stringify(registered);
  assert.ok(registered.filter(c=>M.matches(c,'','Twitch','')).every(c=>c.platform==='Twitch'));
  const fixture={...channel,venues:['対戦会場'],games:[{title:'スパ2X'}]};
  assert.ok(M.matches(fixture,'sf2','',''));
  assert.ok(M.matches(fixture,'',fixture.platform,'対戦会場'));
  assert.equal(M.matches(channel,'','Twitch',''),false);
  assert.equal(JSON.stringify(registered),before);
});
