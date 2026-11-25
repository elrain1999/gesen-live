const fs=require('node:fs');
function incomplete(report,reservation){
  const failures=new Set(['api_limit','request_failed','authentication_error','channel_id_unresolved','request_deferred','auth_not_configured']);
  return reservation.reason==='shared_ledger_unavailable'||Object.entries(report.counts).some(([key,count])=>failures.has(key)&&count>0);
}
if(require.main===module){
  const report=JSON.parse(fs.readFileSync('report/data/api-validation.json'));
  const reservation=JSON.parse(fs.readFileSync('report/data/search-reservation.json'));
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,`Acquisition outcomes: ${JSON.stringify(report.counts)}\nSearch reservation: ${JSON.stringify(reservation)}\n`);
  if(incomplete(report,reservation)){
    console.error('::error::YouTube acquisition is incomplete; usable partial data was published when safe. See acquisition outcomes.');
    process.exitCode=1;
  }
}
module.exports={incomplete};
