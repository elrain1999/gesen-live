const {setTimeout:delay}=require('node:timers/promises');
const {request,failure,APIError}=require('./http.cjs');

const kinds=['live','upcoming','archive'];
const quotaDay=now=>new Intl.DateTimeFormat('en-CA',{timeZone:'America/Los_Angeles',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(now));
const handle=value=>String(value||'').normalize('NFC').toLowerCase();
const channelId=value=>/^UC[\w-]{22}$/.test(value);
const batches=(ids)=>Array.from({length:Math.ceil(ids.length/50)},(_,i)=>ids.slice(i*50,i*50+50));

function collectorAPI({key,next,telemetry,fetcher,pause,clock}) {
  const blocked=new Map();
  const retried=new Set();
  let fatal;
  return async function api(resource,params,record,runLimit=Infinity) {
    const stats=telemetry.endpoints[resource]??={requests:0,rate_limits:0,retries:0};
    const defer=Date.parse(next.cooldowns[resource]?.until);
    if(fatal)throw fatal;
    if(blocked.has(resource))throw blocked.get(resource);
    if(resource==='search'&&next.search_quota_day===next.day){
      const error=new APIError('API_YOUTUBE_SEARCH_QUOTA',{reason:'quotaExceeded'});error.endpoint=resource;throw error;
    }
    if(defer>clock()){
      const stored=next.cooldowns[resource];
      const error=new APIError(stored.error_code,{status:stored.status,reason:stored.reason,retryAt:defer});
      error.category=stored.category;error.endpoint=resource;
      throw error;
    }
    if(record&&(next.search_used>=80||telemetry.search_requests>=runLimit))return null;
    const retries=retried.has(resource)?0:2;
    for(let retry=0;;retry++){
      if(record&&(next.search_used>=80||telemetry.search_requests>=runLimit))return null;
      if(resource==='search'){
        next.search_used++;telemetry.search_requests++;
      }else{
        if(next.rest_used>=8000){
          const error=new APIError('API_LOCAL_DAILY_LIMIT');
          error.category='quota';fatal=error;throw error;
        }
        next.rest_used++;
      }
      if(telemetry.requests)await pause(120);
      stats.requests++;
      if(retry)stats.retries++;
      try{
        const data=await request('https://www.googleapis.com/youtube/v3/'+resource+'?'+new URLSearchParams({...params,key}),{fetcher,telemetry,clock});
        if(!Array.isArray(data?.items))throw new APIError('API_INVALID_SHAPE');
        if(record)next.searched.push(record);
        delete next.cooldowns[resource];
        return data;
      }catch(error){
        error.endpoint=resource;
        if(error.category==='auth'||(error.category==='quota'&&resource!=='search'))fatal=error;
        if(resource==='search'&&error.category==='quota'){blocked.set(resource,error);next.search_quota_day=next.day;}
        if(error.category!=='rate_limit')throw error;
        stats.rate_limits++;
        const required=Math.max(0,(Date.parse(error.retry_at)||0)-clock());
        retried.add(resource);
        if(retry<retries&&required<=3000&&(!record||(next.search_used<80&&telemetry.search_requests<runLimit))){
          await pause(Math.max(required,1000*2**retry));
          continue;
        }
        const until=new Date(clock()+Math.max(required,300000)).toISOString();
        error.retry_at=until;
        blocked.set(resource,error);
        next.cooldowns[resource]={...failure(error),status:error.status,until};
        throw error;
      }
    }
  };
}

function broadcast(video,row,now){
  const details=video.liveStreamingDetails;
  if(!details||row.id!==video.snippet?.channelId)return null;
  const status=details.actualEndTime?'archive':details.actualStartTime?'live':details.scheduledStartTime?'upcoming':null;
  const starts=details.actualStartTime||details.scheduledStartTime;
  if(!status||!Number.isFinite(Date.parse(starts))||typeof video.snippet.title!=='string')return null;
  const raw=details.concurrentViewers;
  const viewers=(typeof raw==='string'||typeof raw==='number')&&/^\d+$/.test(String(raw))&&Number.isSafeInteger(Number(raw))?Number(raw):null;
  return {id:video.id,channel_id:row.channel.record_id,source_channel_id:row.id,status,title:video.snippet.title,
    starts_at:starts,ends_at:details.actualEndTime||null,url:'https://www.youtube.com/watch?v='+encodeURIComponent(video.id),
    thumbnail_url:video.snippet.thumbnails?.medium?.url||null,fetched_at:now,kind:'broadcast',
    ...(status==='live'?{concurrent_viewers:viewers}:{})};
}

async function verifyVideos(candidates,api,details,failed){
  for(const batch of batches([...candidates.keys()].filter(id=>!details.has(id)&&!failed.has(id)))){
    let result;
    try{result=await api('videos',{part:'snippet,liveStreamingDetails',id:batch.join(',')});}
    catch(error){
      for(const id of batch){
        failed.add(id);
        for(const row of candidates.get(id))row.detailsError=error;
      }
      continue;
    }
    const returned=new Map(result.items.map(v=>[v.id,v]));
    for(const id of batch)details.set(id,returned.get(id)||null);
  }
}

function groupCandidates(rows,kind){
  const byVideo=new Map();
  for(const row of rows)for(const id of row[kind]){
    if(!byVideo.has(id))byVideo.set(id,new Set());
    byVideo.get(id).add(row);
  }
  return byVideo;
}

async function collect(channels,{key,previous=[],state={},now=new Date().toISOString(),fetcher=fetch,
  pause=fetcher===fetch?delay:async()=>{},clock=fetcher===fetch?Date.now:()=>Date.parse(now)}={}) {
  const streams=[],checks=[],verified_ids=[],resolutions=[];
  const telemetry={requests:0,search_requests:0,endpoints:{}};
  const day=quotaDay(now);
  const sameDay=state.day===day;
  const next={...state,day,search_used:sameDay?state.search_used||0:0,rest_used:sameDay?state.rest_used||0:0,
    searched:sameDay?[...(state.searched||[])]:[],search_cursor:sameDay?{...state.search_cursor}:{},identifiers:{...state.identifiers},known:{...state.known},
    uploads:{...state.uploads},cooldowns:{...state.cooldowns},last_success:{...state.last_success}};
  if(!key)return {streams,checks:channels.flatMap(c=>kinds.map(kind=>({channel_id:c.record_id,kind,status:'not_configured',category:'auth',checked_at:now}))),verified_ids,resolutions,telemetry,state:next,provider:{status:'not_configured',message:'APIキー未設定のため配信情報は未取得'}};
  const api=collectorAPI({key,next,telemetry,fetcher,pause,clock});
  const offset=sameDay?state.cursor||0:((state.cursor||0)+(state.day?40:0))%Math.max(1,channels.length);
  next.cursor=offset;
  const rows=[...channels.slice(offset),...channels.slice(0,offset)].map(channel=>{
    const cached=next.identifiers[channel.record_id];
    const id=channel.youtube_channel_id||(cached?.handle===channel.youtube_handle&&
      Date.parse(now)-Date.parse(cached.verified_at)<30*86400000&&channelId(cached.id)?cached.id:null);
    const recent=previous.filter(s=>s.channel_id===channel.record_id&&s.status!=='archive').map(s=>s.id);
    const known=new Set([...recent,...(next.known[channel.record_id]||[])]);
    return {channel,id,known,candidates:new Set(known),discovery:{}};
  });
  const details=new Map();
  const failed=new Set();

  // Confirm active/queued videos before spending requests on discovery.
  await verifyVideos(groupCandidates(rows.filter(r=>r.id),'known'),api,details,failed);

  const metadata=new Map();
  const unresolved=rows.filter(r=>!r.id);
  const missingPlaylists=[...new Set(rows.filter(r=>r.id&&!next.uploads[r.id]?.playlist).map(r=>r.id))];
  for(const batch of batches(missingPlaylists)){
    try{
      const result=await api('channels',{part:'contentDetails',id:batch.join(',')});
      for(const entry of result.items)if(batch.includes(entry.id))metadata.set(entry.id,entry);
    }catch(error){for(const row of rows)if(batch.includes(row.id))row.uploadsError=error;}
  }
  for(const row of unresolved){
    const c=row.channel;
    try{
      const result=await api('channels',{part:'snippet,contentDetails',forHandle:c.youtube_handle});
      const matches=result.items.filter(v=>channelId(v.id)&&handle(v.snippet?.customUrl)===handle(c.youtube_handle));
      if(matches.length===1){
        const [match]=matches;row.id=match.id;metadata.set(match.id,match);
        next.identifiers[c.record_id]={id:match.id,handle:c.youtube_handle,verified_at:now,source:'YouTube Data API channels.list(forHandle)'};
      }
    }catch(error){row.identityError=error;}
  }

  // Recent uploads provide one cheap discovery path even when search is limited.
  const eligible=rows.filter(r=>r.id);
  const seenPlaylists=new Map();
  for(const row of eligible){
    if(row.uploadsError)continue;
    const playlist=next.uploads[row.id]?.playlist||metadata.get(row.id)?.contentDetails?.relatedPlaylists?.uploads;
    if(!playlist){row.uploadsError=new APIError('API_CHANNEL_UNAVAILABLE',{status:404});continue;}
    next.uploads[row.id]={day,playlist};
    try{
      if(!seenPlaylists.has(playlist))seenPlaylists.set(playlist,api('playlistItems',{part:'contentDetails',playlistId:playlist,maxResults:'20'}));
      const result=await seenPlaylists.get(playlist);
      for(const v of result.items)if(v.contentDetails?.videoId)row.candidates.add(v.contentDetails.videoId);
    }catch(error){row.uploadsError=error;if(error.status===404)delete next.uploads[row.id];}
  }
  await verifyVideos(groupCandidates(eligible,'candidates'),api,details,failed);

  // A dedicated live scan takes precedence over every upcoming search.
  for(const [kind,limit] of [['live',6],['upcoming',2]]){
    const start=telemetry.search_requests;
    const index=eligible.findIndex(r=>r.channel.record_id===next.search_cursor[kind]);
    const rotation=index<0?0:index+1;
    const queue=[...eligible.slice(rotation),...eligible.slice(0,rotation)];
    for(const row of queue){
      if(telemetry.search_requests-start>=limit)break;
      const ticket=row.channel.record_id+':'+kind;
      if(next.searched.includes(ticket)||next.search_used>=80)continue;
      const before=telemetry.search_requests;
      try{
        const result=await api('search',{part:'id',channelId:row.id,eventType:kind,type:'video',maxResults:'50'},ticket,start+limit);
        row.discovery[kind]={complete:!!result&&!result.nextPageToken};
        for(const item of result?.items||[])if(item.id?.videoId)row.candidates.add(item.id.videoId);
      }catch(error){row.discovery[kind]={error};}
      if(telemetry.search_requests>before)next.search_cursor[kind]=row.channel.record_id;
    }
    await verifyVideos(groupCandidates(eligible,'candidates'),api,details,failed);
  }

  for(const row of rows){
    const c=row.channel;
    if(!c.youtube_channel_id){
      resolutions.push({channel_id:c.record_id,handle:c.youtube_handle,status:row.id?'verified':'unresolved',
        ...(row.id?{youtube_channel_id:row.id,verified_at:next.identifiers[c.record_id].verified_at}:{}),
        ...(row.identityError?failure(row.identityError):{})});
    }
    const retained=[];
    const observed={live:0,upcoming:0,archive:0};
    for(const id of row.candidates){
      if(!row.id)break;
      if(!details.has(id)){retained.push(id);continue;}
      verified_ids.push({channel_id:c.record_id,id});
      const stream=broadcast(details.get(id)||{},row,now);
      if(!stream)continue;
      streams.push(stream);observed[stream.status]++;
      if(stream.status!=='archive')retained.push(id);
    }
    next.known[c.record_id]=retained.slice(0,200);
    for(const kind of kinds){
      const err=row.identityError||row.detailsError||row.uploadsError||row.discovery[kind]?.error;
      const complete=!!row.id&&!err&&(kind==='archive'||row.discovery[kind]?.complete);
      const status=!row.id?'unresolved_id':err?'error':complete?'ok':'partial';
      const ticket=c.record_id+':'+kind;
      if(complete)next.last_success[ticket]=now;
      checks.push({channel_id:c.record_id,kind,status,checked_at:now,
        ...(status==='unresolved_id'?{category:'identity'}:{}),...(err?failure(err):{}),
        ...(err?.endpoint?{endpoint:err.endpoint}:{}),
        ...(next.last_success[ticket]?{last_success_at:next.last_success[ticket]}:{}),
        coverage:kind==='archive'?'recent_uploads':complete?'bounded_scan':'known_and_recent',observed:observed[kind]});
    }
  }
  const errors=checks.some(c=>['error','unresolved_id'].includes(c.status));
  return {streams,checks,verified_ids,resolutions,telemetry,state:next,provider:{status:errors?'partial':'ok',
    message:errors?'公式APIの一部が未取得です。チャンネル別の取得結果を確認できます。':'公式API取得（直近の投稿と既知の配信を確認。新規検索はライブ優先、PT日あたり最大80回）'}};
}
module.exports={collect,quotaDay};
