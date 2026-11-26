const fs=require('node:fs');
const path=require('node:path');
const failures=new Set(['api_limit','request_failed','authentication_error','channel_id_unresolved','request_deferred','auth_not_configured','channel_unavailable','not_checked']);
const outcomes=new Set([...failures,'api_success_with_broadcast','api_success_no_broadcast_in_scanned_window']);
const reservations=new Set(['reserved','daily_limit','slot_already_reserved','shared_ledger_unavailable']);
const good=new Set(['ok','partial','not_available']);
const kinds=['live','upcoming','archive'];
function classify(report,reservation,audit,{collect,deploy}={}){
  const failure=reason=>({state:'FAILURE',reason});
  if(collect!=='success')return failure('collection_not_successful');
  if(deploy!=='success')return failure('publication_not_successful');
  if(report?.schema_version!==1||audit?.passed!==true||audit.errors?.length!==0||
    report.checked_at!==audit.generated_at||!Number.isFinite(Date.parse(report.checked_at))||
    !Array.isArray(report.channels)||!report.channels.length||report.channels.length!==audit.input_channels||
    audit.checks!==report.channels.length*3||!Number.isInteger(audit.records)||audit.records<0||
    !Number.isInteger(audit.visible_now?.total)||audit.visible_now.total<0||audit.visible_now.total>audit.records||
    !reservation||!reservations.has(reservation.reason))return failure('invalid_acquisition_evidence');
  const seen=new Set(),counts={};let successful=0,failed=0;
  for(const channel of report.channels){
    if(!channel||seen.has(channel.record_id)||!Array.isArray(channel.results)||channel.results.length!==3)return failure('invalid_channel_evidence');
    seen.add(channel.record_id);
    for(const kind of kinds){
      const rows=channel.results.filter(r=>r?.kind===kind);
      if(rows.length!==1)return failure('invalid_channel_evidence');
      const row=rows[0];
      if(audit.by_channel?.[channel.record_id]?.checks?.[kind]!==row.status||
        !Number.isInteger(row.count)||row.count<0||!outcomes.has(row.outcome))return failure('inconsistent_channel_evidence');
      counts[row.outcome]=(counts[row.outcome]||0)+1;
      if(good.has(row.status))successful++;
      if(!good.has(row.status)||failures.has(row.outcome))failed++;
    }
  }
  if(!report.counts||Object.keys(report.counts).length!==Object.keys(counts).length||
    Object.entries(counts).some(([key,value])=>report.counts[key]!==value))return failure('inconsistent_outcome_counts');
  // Cached records and deploy success alone cannot turn a total acquisition outage into PARTIAL.
  const endpoints=report.telemetry?.YouTube?.endpoints||{};
  if(!successful||!Object.values(endpoints).some(s=>Number.isInteger(s.succeeded)&&s.succeeded>0))return failure('no_successful_acquisition');
  const partial=failed>0||reservation.reason==='shared_ledger_unavailable';
  if(partial&&audit.visible_now.total===0)return failure('no_usable_partial_data');
  return {state:partial?'PARTIAL':'SUCCESS',reason:partial?'usable_partial_data_published':'acquired_and_published',successful_checks:successful,failed_checks:failed,visible_records:audit.visible_now.total,search_budget:reservation.reason};
}
function diagnostics(report){
  const endpoints=new Set(['search','videos','playlistItems','channels','collector']);
  const categories=new Set(['quota','rate_limit','auth','identity','network','api','channel']);
  const codes=new Set(['API_INVALID_JSON','API_INVALID_RESPONSE','API_NETWORK_OR_TIMEOUT','API_INVALID_SHAPE','API_CHANNEL_UNAVAILABLE','API_LOCAL_DAILY_LIMIT','API_YOUTUBE_SEARCH_QUOTA']);
  return (Array.isArray(report?.channels)?report.channels:[]).filter(c=>c&&Array.isArray(c.results)).flatMap(c=>c.results.filter(r=>r&&(!good.has(r.status)||failures.has(r.outcome))).map(r=>({
    channel:/^CH-\d{2}-\d{6}$/.test(c.record_id)?c.record_id:'unknown',
    kind:kinds.includes(r.kind)?r.kind:'unknown',
    endpoint:endpoints.has(r.endpoint)?r.endpoint:'collector',
    cause:(/^API_HTTP_[1-5][0-9]{2}$/.test(r.error_code||'')||codes.has(r.error_code))?r.error_code:categories.has(r.category)?r.category:'unconfirmed'
  })));
}
function run({directory='report',env=process.env,logger=console}={}){
  let report,reservation,audit,result;
  const jobs={collect:env.COLLECT_RESULT,deploy:env.DEPLOY_RESULT};
  try{
    report=JSON.parse(fs.readFileSync(path.join(directory,'data/api-validation.json')));
    reservation=JSON.parse(fs.readFileSync(path.join(directory,'data/search-reservation.json')));
    audit=JSON.parse(fs.readFileSync(path.join(directory,'artifacts/youtube-audit.json')));
    result=classify(report,reservation,audit,jobs);
  }catch{result={state:'FAILURE',reason:'missing_or_invalid_acquisition_evidence'};}
  const details=diagnostics(report);
  const summary=`## YouTube acquisition: ${result.state}\n\n${JSON.stringify(result)}\n\n`+
    (details.length?'| Channel | Kind | API | Cause |\n|---|---|---|---|\n'+details.map(d=>`| ${d.channel} | ${d.kind} | ${d.endpoint} | ${d.cause} |`).join('\n')+'\n':'');
  fs.appendFileSync(env.GITHUB_STEP_SUMMARY,summary);
  if(env.GITHUB_OUTPUT)fs.appendFileSync(env.GITHUB_OUTPUT,`state=${result.state}\n`);
  logger.log(`YouTube acquisition: ${JSON.stringify(result)}`);
  for(const detail of details)logger.log(JSON.stringify(detail));
  if(result.state==='PARTIAL')logger.warn('::warning::YouTube acquisition is partial; audited usable data was published. See Job Summary and collection logs.');
  if(result.state==='FAILURE')logger.error('::error::YouTube acquisition/publication failed. Previous valid data is retained where available.');
  return result.state==='FAILURE'?1:0;
}
if(require.main===module)process.exitCode=run();
module.exports={classify,diagnostics,run};
