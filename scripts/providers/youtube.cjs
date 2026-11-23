const {request,failure,APIError}=require('./http.cjs');
const kinds=['live','upcoming','archive'];
const quotaDay=now=>new Intl.DateTimeFormat('en-CA',{timeZone:'America/Los_Angeles',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(now));
const handle=value=>String(value||'').normalize('NFC').toLowerCase();
async function collect(channels,{key,previous=[],state={},now=new Date().toISOString(),fetcher=fetch}={}) {
  const streams=[],checks=[],verified_ids=[],resolutions=[],telemetry={requests:0,search_requests:0};
  const day=quotaDay(now);
  const next={...state,day,search_used:state.day===day?state.search_used||0:0,rest_used:state.day===day?state.rest_used||0:0,searched:state.day===day?state.searched||[]:[],identifiers:{...(state.identifiers||{})},known:{...(state.known||{})},uploads:{...(state.uploads||{})}};
  let fatal,searchBlocked;
  const api=async(resource,params)=>{
    if(fatal)throw fatal;
    if(resource==='search'&&searchBlocked)throw searchBlocked;
    if(resource!=='search'){
      if(next.rest_used>=8000){const error=new APIError('API_LOCAL_DAILY_LIMIT');error.category='quota';fatal=error;throw error;}
      next.rest_used++;
    }
    try{return await request('https://www.googleapis.com/youtube/v3/'+resource+'?'+new URLSearchParams({...params,key}),{fetcher,telemetry});}
    catch(e){if(resource==='search'&&e.category==='quota')searchBlocked=e;else if(['auth','quota','rate_limit'].includes(e.category))fatal=e;throw e;}
  };
  if(!key)return {streams,checks:channels.flatMap(c=>kinds.map(kind=>({channel_id:c.record_id,kind,status:'not_configured',category:'auth',checked_at:now}))),verified_ids,resolutions,telemetry,state:next,provider:{status:'not_configured',message:'APIキー未設定のため配信情報は未取得'}};
  const offset=state.day===day?state.cursor||0:((state.cursor||0)+(state.day?40:0))%Math.max(1,channels.length);next.cursor=offset;
  const ordered=[...channels.slice(offset),...channels.slice(0,offset)];
  for(const c of ordered){
    let id=c.youtube_channel_id, meta, identityFailure;
    if(!id){
      const cached=next.identifiers[c.record_id];
      if(cached?.handle===c.youtube_handle && Date.parse(now)-Date.parse(cached.verified_at)<30*86400000 && /^UC[\w-]{22}$/.test(cached.id))id=cached.id;
      else try{
        const r=await api('channels',{part:'snippet,contentDetails',forHandle:c.youtube_handle});
        const matches=(r.items||[]).filter(v=>/^UC[\w-]{22}$/.test(v.id)&&handle(v.snippet?.customUrl)===handle(c.youtube_handle));
        if(matches.length===1){meta=matches[0];id=meta.id;next.identifiers[c.record_id]={id,handle:c.youtube_handle,verified_at:now,source:'YouTube Data API channels.list(forHandle)'};}
      }catch(e){identityFailure=e;}
      resolutions.push({channel_id:c.record_id,handle:c.youtube_handle,status:id?'verified':'unresolved',...(id?{youtube_channel_id:id,verified_at:next.identifiers[c.record_id].verified_at}:{}),...(identityFailure?failure(identityFailure):{})});
    }
    const check=(kind,status,extra={})=>checks.push({channel_id:c.record_id,kind,status,checked_at:now,...extra});
    if(!id){for(const kind of kinds)check(kind,'unresolved_id',{category:'identity',...(identityFailure?failure(identityFailure):{})});continue;}
    const candidates=new Set([...previous.filter(s=>s.channel_id===c.record_id).map(s=>s.id),...(next.known[c.record_id]||[])]);
    const discovery={};
    for(const kind of ['live','upcoming']){
      const ticket=c.record_id+':'+kind;
      discovery[kind]={complete:false};
      if(next.searched.includes(ticket))continue;
      if(next.search_used>=80){discovery[kind].limited=true;continue;}
      // Count attempts, including failed calls, before issuing them.
      if(fatal||searchBlocked){discovery[kind].error=fatal||searchBlocked;continue;}
      next.search_used++;telemetry.search_requests++;next.searched.push(ticket);
      try{
        const r=await api('search',{part:'id',channelId:id,eventType:kind,type:'video',maxResults:'50'});
        if(!Array.isArray(r.items))throw new APIError('API_INVALID_SHAPE');
        for(const item of r.items)if(item.id?.videoId)candidates.add(item.id.videoId);
        discovery[kind].complete=!r.nextPageToken;
      }catch(e){discovery[kind].error=e;}
    }
    let uploadsError;
    try{
      const cached = next.uploads[id];
      let playlistId = cached?.day === day ? cached.playlist : null;
      if (!playlistId) {
        if (!meta) {
          const response = await api('channels', {part:'contentDetails', id});
          meta = response.items?.[0];
        }
        playlistId = meta?.contentDetails?.relatedPlaylists?.uploads;
        if (playlistId) next.uploads[id] = {day, playlist:playlistId};
      }
      if(!playlistId)throw new APIError('API_CHANNEL_UNAVAILABLE',{status:404});
      const r=await api('playlistItems',{part:'contentDetails',playlistId,maxResults:'20'});
      if(!Array.isArray(r.items))throw new APIError('API_INVALID_SHAPE');
      for(const v of r.items)if(v.contentDetails?.videoId)candidates.add(v.contentDetails.videoId);
    }catch(e){uploadsError=e;if(e.status===404)delete next.uploads[id];}
    const ids=[...candidates], retained=new Set();let detailsError;
    for(let offset=0;offset<ids.length;offset+=50){
      const batch=ids.slice(offset,offset+50);
      try{
        const r=await api('videos',{part:'snippet,liveStreamingDetails',id:batch.join(',')});
        if(!Array.isArray(r.items))throw new APIError('API_INVALID_SHAPE');
        // Successful detail lookup authoritatively expires deleted/private/non-live IDs.
        verified_ids.push(...batch.map(video_id=>({channel_id:c.record_id,id:video_id})));
        for(const v of r.items){
          if(v.snippet?.channelId!==id||!v.liveStreamingDetails)continue;
          const d=v.liveStreamingDetails;
          const status=d.actualEndTime?'archive':d.actualStartTime?'live':d.scheduledStartTime?'upcoming':null;
          if(!status)continue;
          if(status!=='archive')retained.add(v.id);
          const rawViewers = d.concurrentViewers;
          const hasCount = (typeof rawViewers === 'string' || typeof rawViewers === 'number') &&
            /^\d+$/.test(String(rawViewers)) && Number.isSafeInteger(Number(rawViewers));
          const viewers = hasCount ? Number(rawViewers) : null;
          streams.push({...(status==='live' ? {concurrent_viewers:viewers} : {}),id:v.id,channel_id:c.record_id,source_channel_id:v.snippet.channelId,status,title:v.snippet.title,starts_at:d.actualStartTime||d.scheduledStartTime,ends_at:d.actualEndTime||null,url:'https://www.youtube.com/watch?v='+encodeURIComponent(v.id),thumbnail_url:v.snippet.thumbnails?.medium?.url||null,fetched_at:now,kind:'broadcast'});
        }
      }catch(e){detailsError=e;for(const id of batch)retained.add(id);}
    }
    next.known[c.record_id]=[...retained].slice(0,200);
    for(const kind of kinds){
      const err=detailsError||uploadsError||discovery[kind]?.error;
      const complete=kind==='archive'?!err:!err&&discovery[kind].complete;
      check(kind,err?'error':complete?'ok':'partial',{...(err?failure(err):{}),coverage:complete?'bounded_scan':'known_and_recent',observed:streams.filter(s=>s.channel_id===c.record_id&&s.status===kind).length});
    }
  }
  const errors=checks.some(c=>['error','unresolved_id'].includes(c.status));
  return {streams,checks,verified_ids,resolutions,telemetry,state:next,provider:{status:errors?'partial':'ok',message:errors?'公式APIの一部が未取得です。チャンネル別の取得結果を確認できます。':'公式API取得（最近20動画＋既知の配信／ライブ・予定の新規検索はPT日あたり最大80回）'}};
}
module.exports={collect,quotaDay};
