const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const production=()=>JSON.parse(fs.readFileSync(path.join(root,'data/channels.public.json')));
const now='2026-11-17T10:00:00.000Z';
const stream=(channel,extra={})=>({id:'real-video-id',channel_id:channel.record_id,status:'live',title:'ガロスペ対戦会',url:'https://www.youtube.com/watch?v=real-video-id',starts_at:'2026-11-17T09:00:00.000Z',fetched_at:now,...extra});
module.exports={root,production,now,stream};
