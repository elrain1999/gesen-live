const {setTimeout:delay}=require('node:timers/promises');
const {request,failure,APIError}=require('./http.cjs');

const dailySearchLimit=80;
const pendingEndMaxAge=2*3600000;
const kinds=['live','upcoming','archive'];
const quotaDay=now=>new Intl.DateTimeFormat('en-CA',{timeZone:'America/Los_Angeles',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(now));
const handle=value=>String(value||'').normalize('NFC').toLowerCase();
const channelId=value=>/^UC[\w-]{22}$/.test(value);
const batches=(ids)=>Array.from({length:Math.ceil(ids.length/50)},(_,i)=>ids.slice(i*50,i*50+50));

function collectorAPI({key,next,telemetry,fetcher,pause,clock}) {
  const blocked=new Map();
  const retried=new Set();
  const deferred=error=>Object.assign(new APIError(error.message),error,{deferred:true});
  let fatal;
  let nextSearchAt=0;
  return async function api(resource,params,record,runLimit=Infinity) {
    const stats=telemetry.endpoints[resource]??={requests:0,rate_limits:0,retries:0,succeeded:0,failed:0,retry_succeeded:0};
    const defer=Date.parse(next.cooldowns[resource]?.until);
    if(fatal)throw deferred(fatal);
    if(blocked.has(resource))throw deferred(blocked.get(resource));
    if(resource==='search'&&next.search_quota_day===next.day){
      const error=new APIError('API_YOUTUBE_SEARCH_QUOTA',{reason:'quotaExceeded'});error.endpoint=resource;throw deferred(error);
    }
    if(defer>clock()){
      const stored=next.cooldowns[resource];
      const error=new APIError(stored.error_code,{status:stored.status,reason:stored.reason,retryAt:defer});
      error.category=stored.category;error.endpoint=resource;
      throw deferred(error);
    }
    if(record&&(next.search_used>=dailySearchLimit||telemetry.search_requests>=runLimit))return null;
    const isSearch=resource==='search';
    const retries=retried.has(resource)?0:isSearch?1:2;
    for(let retry=0;;retry++){
      if(record&&(next.search_used>=dailySearchLimit||telemetry.search_requests>=runLimit))return null;
      if(resource==='search'){
        next.search_used++;telemetry.search_requests++;
      }else{
        if(next.rest_used>=8000){
          const error=new APIError('API_LOCAL_DAILY_LIMIT');
          error.category='quota';error.endpoint=resource;fatal=error;throw deferred(error);
        }
        next.rest_used++;
      }
      if(telemetry.requests)await pause(Math.max(120,isSearch?nextSearchAt-clock():0));
      if(isSearch)nextSearchAt=clock()+1000;
      stats.requests++;
      if(retry)stats.retries++;
      try{
        const data=await request('https://www.googleapis.com/youtube/v3/'+resource+'?'+new URLSearchParams({...params,key}),{fetcher,telemetry,clock});
        if(!Array.isArray(data?.items))throw new APIError('API_INVALID_SHAPE');
        if(record)next.searched.push(record);
        stats.succeeded++;
        if(retry){stats.retry_succeeded++;telemetry.recovered++;}
        delete next.cooldowns[resource];
        return data;
      }catch(error){
        stats.failed++;
        let rateEvent;
        if(error.status===429){
          rateEvent={method:resource+'.list',request_number:telemetry.requests,reason:error.reason||null,
            retry_after_present:error.retryAfterPresent,backoff_elapsed_ms:0};
          telemetry.http_429.push(rateEvent);
        }
        error.endpoint=resource;
        const codes=telemetry.failed_responses[resource]??={};
        const code=failure(error).error_code;
        codes[code]=(codes[code]||0)+1;
        if(error.category==='auth'||(error.category==='quota'&&resource!=='search'))fatal=error;
        if(resource==='search'&&error.category==='quota'){blocked.set(resource,error);next.search_quota_day=next.day;}
        if(error.category!=='rate_limit')throw error;
        stats.rate_limits++;
        const required=Math.max(0,(Date.parse(error.retry_at)||0)-clock());
        retried.add(resource);
        // Search gets one delayed retry per run. Longer server waits carry over to the next run.
        const wait=Math.max(required,isSearch?10000:1000*2**retry);
        const maxWait=isSearch?15000:3000;
        if(retry<retries&&wait<=maxWait&&(!record||(next.search_used<dailySearchLimit&&telemetry.search_requests<runLimit))){
          const before=clock();
          await pause(wait);
          if(rateEvent)rateEvent.backoff_elapsed_ms=Math.max(0,clock()-before);
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

const visibleOwner=(video,row)=>video?.snippet?.channelId===row.id&&video.status?.privacyStatus!=='private';

function broadcast(video,row,now){
  const details=video.liveStreamingDetails;
  if(!details||!visibleOwner(video,row))return null;
  let status;
  if(details.actualEndTime)status='archive';
  else if(details.actualStartTime){
    if(video.snippet.liveBroadcastContent!=='live')return null;
    status='live';
  }else if(details.scheduledStartTime)status='upcoming';
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
    try{result=await api('videos',{part:'snippet,liveStreamingDetails,status',id:batch.join(',')});}
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
  const telemetry={requests:0,search_requests:0,recovered:0,failed_responses:{},endpoints:{},http_429:[]};
  const day=quotaDay(now);
  const sameDay=state.day===day;
  const next={...state,day,search_used:sameDay?state.search_used||0:0,rest_used:sameDay?state.rest_used||0:0,
    searched:sameDay?[...(state.searched||[])]:[],search_cursor:sameDay?{...state.search_cursor}:{},identifiers:{...state.identifiers},known:{...state.known},
    uploads:{...state.uploads},cooldowns:{...state.cooldowns},last_success:{...state.last_success}};
  if(!key)return {streams,checks:channels.flatMap(c=>kinds.map(kind=>({channel_id:c.record_id,kind,status:'not_configured',category:'auth',checked_at:now}))),verified_ids,resolutions,telemetry,state:next,provider:{status:'not_configured',message:'APIキー未設定のため配信情報は未取得'}};
  const api=collectorAPI({key,next,telemetry,fetcher,pause,clock});
  const pendingEnd=state.pending_end||{};
  const nowMs=Date.parse(now);
  next.pending_end={};
  const offset=sameDay?state.cursor||0:((state.cursor||0)+(state.day?40:0))%Math.max(1,channels.length);
  next.cursor=offset;
  const rows=[...channels.slice(offset),...channels.slice(0,offset)].map(channel=>{
    const cached=next.identifiers[channel.record_id];
    const id=channel.youtube_channel_id||(cached?.handle===channel.youtube_handle&&
      Date.parse(now)-Date.parse(cached.verified_at)<30*86400000&&channelId(cached.id)?cached.id:null);
    const recent=previous.filter(s=>s.channel_id===channel.record_id&&s.status!=='archive').map(s=>s.id);
    const cachedKnown=(next.known[channel.record_id]||[]).filter(id=>!pendingEnd[id]||nowMs-Date.parse(pendingEnd[id])<pendingEndMaxAge);
    const known=new Set([...recent,...cachedKnown]);
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

  // Give one existing live-search slot to a likely follow-on broadcast.
  // A recently ended stream is a discovery hint, never evidence of a live stream.
  const recentEnd=row=>{
    let latest=0;
    for(const id of row.candidates){
      const video=broadcast(details.get(id)||{},row,now);
      if(video?.status==='live')return 0;
      if(video?.status==='archive')latest=Math.max(latest,Date.parse(video.ends_at)||0);
    }
    return latest>=Date.parse(now)-6*3600000?latest:0;
  };

  // A dedicated live scan takes precedence over every upcoming search.
  for(const [kind,limit] of [['live',6],['upcoming',2]]){
    const start=telemetry.search_requests;
    const index=eligible.findIndex(r=>r.channel.record_id===next.search_cursor[kind]);
    const rotation=index<0?0:index+1;
    const queue=[...eligible.slice(rotation),...eligible.slice(0,rotation)];
    let priority;
    if(kind==='live'){
      const ranked=queue.filter(row=>!next.searched.includes(row.channel.record_id+':live'))
        .map(row=>({row,end:recentEnd(row)})).filter(item=>item.end).sort((a,b)=>b.end-a.end);
      priority=ranked[0]?.row;
    }
    for(const row of priority?[priority,...queue.filter(item=>item!==priority)]:queue){
      if(telemetry.search_requests-start>=limit)break;
      const ticket=row.channel.record_id+':'+kind;
      if(next.searched.includes(ticket)||next.search_used>=dailySearchLimit)continue;
      try{
        const result=await api('search',{part:'id',channelId:row.id,eventType:kind,type:'video',maxResults:'50'},ticket,start+limit);
        row.discovery[kind]={complete:!!result&&!result.nextPageToken};
        if(result&&row!==priority)next.search_cursor[kind]=row.channel.record_id;
        for(const item of result?.items||[])if(item.id?.videoId)row.candidates.add(item.id.videoId);
      }catch(error){row.discovery[kind]={error};}
    }
    await verifyVideos(groupCandidates(eligible,'candidates'),api,details,failed);
  }

  telemetry.daily={pt_day:day,search_requests:next.search_used,local_search_limit:dailySearchLimit,other_requests:next.rest_used};
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
      if(!details.has(id)){
        retained.push(id);
        if(row.known.has(id)&&pendingEnd[id])next.pending_end[id]=pendingEnd[id];
        continue;
      }
      verified_ids.push({channel_id:c.record_id,id});
      const video=details.get(id);
      const stream=broadcast(video||{},row,now);
      if(!stream){
        const details=video?.liveStreamingDetails;
        // Keep a known ID in the existing batches while YouTube fills in the end time.
        if(row.known.has(id)&&visibleOwner(video,row)&&Number.isFinite(Date.parse(details?.actualStartTime))&&!details.actualEndTime){
          retained.push(id);
          next.pending_end[id]=pendingEnd[id]||now;
        }
        continue;
      }
      streams.push(stream);observed[stream.status]++;
      if(stream.status!=='archive')retained.push(id);
    }
    next.known[c.record_id]=retained.slice(0,200);
    for(const kind of kinds){
      const err=row.identityError||row.detailsError||row.uploadsError||row.discovery[kind]?.error;
      const complete=!!row.id&&!err&&(kind==='archive'||row.discovery[kind]?.complete);
      const status=!row.id?'unresolved_id':err?(err.deferred?'deferred':'error'):complete?'ok':'partial';
      const ticket=c.record_id+':'+kind;
      if(complete)next.last_success[ticket]=now;
      checks.push({channel_id:c.record_id,kind,status,checked_at:now,
        ...(status==='unresolved_id'?{category:'identity'}:{}),...(err?failure(err):{}),
        ...(err?.endpoint?{endpoint:err.endpoint}:{}),
        ...(next.last_success[ticket]?{last_success_at:next.last_success[ticket]}:{}),
        coverage:kind==='archive'?'recent_uploads':complete?'bounded_scan':'known_and_recent',observed:observed[kind]});
    }
  }
  const failedCheck=check=>!['ok','partial'].includes(check.status);
  const errors=checks.some(failedCheck);
  const anyCoverage=streams.length>0||checks.some(check=>!failedCheck(check));
  const status=errors?(anyCoverage?'partial':'error'):'ok';
  return {streams,checks,verified_ids,resolutions,telemetry,state:next,provider:{status}};
}
module.exports={collect,quotaDay};
