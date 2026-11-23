const fs = require('node:fs');
const crypto = require('node:crypto');
const model = require('../dist/model.js');
const input = fs.readFileSync('data/channels.public.json');
const source = JSON.parse(input);
const audit = require('../data/phase4-audit.json');
const phase12 = require('../data/phase12-release.json');
const release = require('../data/phase13-release.json');
if (phase12.base_public_sha256 !== audit.public_sha256 ||
    release.base_public_sha256 !== phase12.public_sha256) throw Error('Registry baseline mismatch');
if (crypto.createHash('sha256').update(input).digest('hex') !== release.public_sha256) throw Error('Public registry changed: review required');
const channels = model.channels(source);
const additions = [...phase12.approved_additions, ...release.approved_additions];
const approved = [...audit.approved_record_ids, ...additions];
if (channels.length !== approved.length || source.channels.length !== approved.length ||
    channels.map(c => c.record_id).sort().join() !== approved.sort().join()) throw Error('Approved IDs changed');
const promotions = additions.filter(id => audit.hold_record_ids.includes(id));
if (promotions.sort().join() !== [...phase12.promoted_from_hold].sort().join() ||
    channels.some(c => audit.rejected_record_ids.includes(c.record_id))) throw Error('Approval status mismatch');
const youtube = channels.filter(c => c.platform === 'YouTube');
if (youtube.length !== audit.counts.candidate_platforms.YouTube + additions.length ||
    channels.filter(c => c.platform === 'Twitch').length !== audit.counts.candidate_platforms.Twitch) throw Error('Platform count mismatch');
const fixedIds = youtube.map(c => c.youtube_channel_id).filter(Boolean);
if (new Set(fixedIds).size !== fixedIds.length) throw Error('Duplicate YouTube channel ID');
// Publish only approved display fields; provenance and original review notes remain in data/.
const keys = ['record_id','status','platform','display_name','channel_url','youtube_handle','youtube_channel_id','twitch_login','regions','venues','events','games','associations'];
const active=model.activeChannels(channels);
const output = {schema_version:1,channels:active.map(c=>Object.fromEntries(keys.map(k=>[k,c[k]])))};
fs.writeFileSync('dist/data.js','// Generated from the production registry. Do not edit.\nwindow.CHANNEL_DATA = '+JSON.stringify(output)+';\n');
let snapshot = JSON.parse(fs.readFileSync(process.env.RETRO_RING_SNAPSHOT||'data/streams.json','utf8'));
snapshot = {...snapshot, checks:(snapshot.checks||[]).filter(c=>active.some(a=>a.record_id===c?.channel_id)),providers:{YouTube:snapshot.providers?.YouTube||{status:'not_configured',message:'YouTube API未設定'}},streams:model.streams(snapshot,active).map(({channel,game,stale,...s})=>s)};
fs.writeFileSync('dist/streams.json',JSON.stringify(snapshot,null,2)+'\n');
console.log(`Built: ${active.length} active YouTube channels (${channels.length} registry records preserved); adapter Twitch frozen; ${snapshot.streams.length} real stream records`);

// These links were checked against the venues' websites or tournament listings.
const venueLinks = {
  'GiGO札幌駅西口': {HP:'https://www.gigo.co.jp/shops/sapporo-nishiguchi'},
  'ファンタジスタ': {HP:'https://www.amfantasista.com/'},
  'ゲームセンターWILL': {X:'https://x.com/gamecenter_will'},
  '西日暮里ゲームスポットバーサス': {HP:'https://www.game-versus.net/'},
  'ゲームセンターテクノポリス': {HP:'https://am-factory.jp/tecnopolis/', X:'https://twitter.com/gc_tecnopolis'},
  'プレイスポットビッグワン2nd': {X:'https://x.com/public_bigone'}
};
const escapeHtml = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const groups = new Map();
for (const channel of active) {
  const group = channel.venues.join(' ／ ') || channel.display_name;
  if (!groups.has(group)) groups.set(group, []);
  groups.get(group).push(channel);
}
const directory = Array.from(groups, ([name, members]) => {
  const links = members.map(c => '<a class="channel" target="_blank" rel="noopener noreferrer" href="'+escapeHtml(c.channel_url)+'">'+escapeHtml(c.display_name)+'</a>');
  for (const [label, url] of Object.entries(venueLinks[name] || {})) {
    links.push('<a target="_blank" rel="noopener noreferrer" href="'+escapeHtml(url)+'">公式'+label+'</a>');
  }
  return '<article><h3>'+escapeHtml(name)+'</h3>'+links.join('')+'</article>';
});
const about = fs.readFileSync('dist/about.html','utf8');
fs.writeFileSync('dist/about.html', about.replace(/<!-- directory -->[\s\S]*?<!-- \/directory -->/, () => '<!-- directory -->\n'+directory.join('\n')+'\n<!-- /directory -->'));
