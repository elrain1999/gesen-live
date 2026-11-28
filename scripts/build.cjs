const fs = require('node:fs');
const crypto = require('node:crypto');
const model = require('../dist/model.js');

const input = fs.readFileSync('data/channels.public.json');
const source = JSON.parse(input);
const registryHash = '00feb852f35a858e8c9ea1ba31ca84d2d8cb64ddf9c6e0ebf327e038e3d09858';
if (crypto.createHash('sha256').update(input).digest('hex') !== registryHash) throw Error('Public registry changed: review required');
const channels = model.channels(source);
const active = model.activeChannels(channels);
if (source.channels.length !== 70 || channels.length !== 69 || active.length !== 58) throw Error('Platform count mismatch');
const fixedIds = active.map(c => c.youtube_channel_id).filter(Boolean);
if (new Set(fixedIds).size !== fixedIds.length) throw Error('Duplicate YouTube channel ID');

const fields = (record, keys) => Object.fromEntries(keys.filter(key => record[key] !== undefined).map(key => [key, record[key]]));
const channelKeys = ['record_id','status','platform','display_name','channel_url','youtube_handle','youtube_channel_id'];
const output = {schema_version:1,channels:active.map(c=>fields(c,channelKeys))};
fs.writeFileSync('dist/data.js','// Generated from the production registry. Do not edit.\nwindow.CHANNEL_DATA = '+JSON.stringify(output)+';\n');

const sourceSnapshot = JSON.parse(fs.readFileSync(process.env.RETRO_RING_SNAPSHOT||'data/streams.json','utf8'));
const activeIds = new Set(active.map(c=>c.record_id));
const streamKeys = ['id','channel_id','source_channel_id','status','title','starts_at','ends_at','url','thumbnail_url','fetched_at','kind','concurrent_viewers'];
const snapshot = {
  schema_version:sourceSnapshot.schema_version,
  generated_at:sourceSnapshot.generated_at,
  last_success_at:sourceSnapshot.last_success_at,
  providers:{YouTube:{status:sourceSnapshot.providers?.YouTube?.status||'not_configured'}},
  checks:(sourceSnapshot.checks||[]).filter(c=>activeIds.has(c?.channel_id)).map(c=>fields(c,['channel_id','kind','status'])),
  resolutions:(sourceSnapshot.resolutions||[]).filter(r=>r.status==='verified'&&activeIds.has(r.channel_id))
    .map(r=>fields(r,['channel_id','handle','status','youtube_channel_id','verified_at'])),
  streams:model.streams(sourceSnapshot,active).map(s=>fields(s,streamKeys))
};
fs.writeFileSync('dist/streams.json',JSON.stringify(snapshot,null,2)+'\n');
console.log(`Built: ${active.length} active YouTube channels (${source.channels.length} registry records preserved); adapter Twitch frozen; ${snapshot.streams.length} real stream records`);
