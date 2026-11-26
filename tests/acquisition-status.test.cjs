const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {classify,run,diagnostics}=require('../scripts/check-acquisition.cjs');
const {report:makeReport}=require('../scripts/validate-api.cjs');
const {audit:makeAudit}=require('../scripts/audit-snapshot.cjs');
const {production}=require('./helpers.cjs');
const {merge}=require('../scripts/update.cjs');
const M=require('../dist/model.js');
const registry=production(),channels=M.activeChannels(M.channels(registry));
const now='2026-11-26T09:04:00.000Z';
const jobs={collect:'success',deploy:'success'},reservation={reason:'reserved'};
function evidence({failedChannels=0,records=true}={}){
 const owner=channels.find(c=>c.youtube_channel_id);
 const snapshot={schema_version:1,generated_at:now,last_success_at:now,providers:{YouTube:{status:failedChannels?'partial':'ok'}},
  telemetry:{YouTube:{endpoints:{playlistItems:{succeeded:channels.length-failedChannels}}}},
  checks:channels.flatMap((c,i)=>['live','upcoming','archive'].map(kind=>({channel_id:c.record_id,kind,status:i<failedChannels?'error':'ok',...(i<failedChannels?{error_code:'API_HTTP_500',category:'api',endpoint:'playlistItems'}:{})}))),
  streams:records?[{id:'abcdEFGh123',channel_id:owner.record_id,source_channel_id:owner.youtube_channel_id,status:'archive',title:'KOF98',starts_at:'2026-11-26T08:00Z',ends_at:'2026-11-26T09:00Z',fetched_at:now,url:'https://www.youtube.com/watch?v=abcdEFGh123'}]:[]};
 // In a total outage these records are retained cache, never fresh observations.
 if(failedChannels===channels.length){snapshot.last_success_at='2026-11-26T08:00Z';for(const row of snapshot.streams)row.fetched_at=snapshot.last_success_at;}
 return {snapshot,report:makeReport(snapshot,M.channels(registry)),audit:makeAudit(snapshot,registry,{now:Date.parse(now),requireOwnership:true})};
}
const state=(e,options=jobs,res=reservation)=>classify(e.report,res,e.audit,options).state;
test('all channels acquired and published, including a valid empty snapshot, are SUCCESS',()=>{
 assert.equal(state(evidence()),'SUCCESS');assert.equal(state(evidence({records:false})),'SUCCESS');
});
test('one channel failed but audited usable data published is PARTIAL, not FAILURE',()=>{
 const e=evidence({failedChannels:1});assert.ok(e.audit.passed);assert.equal(state(e),'PARTIAL');
 assert.equal(classify(e.report,reservation,e.audit,jobs).failed_checks,3);
 assert.deepEqual(diagnostics(e.report)[0],{channel:channels[0].record_id,kind:'live',endpoint:'playlistItems',cause:'API_HTTP_500'});
});
test('total failure remains FAILURE even when old valid records are deployed',()=>{
 assert.equal(state(evidence({failedChannels:channels.length})),'FAILURE');
 assert.equal(state(evidence({failedChannels:channels.length,records:false})),'FAILURE');
});
test('publication failure/cancellation/skip or collection failure cannot be classified PARTIAL',()=>{
 for(const deploy of ['failure','cancelled','skipped',undefined])assert.equal(state(evidence({failedChannels:1}),{...jobs,deploy}),'FAILURE');
 assert.equal(state(evidence(),{...jobs,collect:'failure'}),'FAILURE');
});
test('corrupt, mismatched, incomplete or failed audit evidence is FAILURE',()=>{
 for(const mutate of [e=>e.audit.passed=false,e=>e.audit.errors.push({code:'VIDEO_CHANNEL_MISMATCH'}),e=>e.audit.generated_at='2026-11-25T00:00Z',e=>e.report.channels.pop(),e=>e.report.channels[0]=null,e=>e.report.counts={},e=>e.report.channels[0].results.pop(),e=>e.audit.by_channel[channels[0].record_id].checks.live='ok']){
  const e=evidence({failedChannels:1});mutate(e);assert.equal(state(e),'FAILURE');
 }
 assert.equal(classify({},reservation,{},jobs).state,'FAILURE');
});
test('partial acquisition without usable records fails, and a quota ledger outage is visible',()=>{
 assert.equal(state(evidence({failedChannels:1,records:false})),'FAILURE');
 assert.equal(state(evidence(),jobs,{reason:'shared_ledger_unavailable'}),'PARTIAL');
 assert.equal(state(evidence(),jobs,{reason:'daily_limit'}),'SUCCESS');
});
test('CLI succeeds with PARTIAL, writes Summary/warnings/diagnostics, and fails on total outage',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'acquisition-status-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 fs.mkdirSync(path.join(dir,'data'));fs.mkdirSync(path.join(dir,'artifacts'));
 const logs=[],logger={log:s=>logs.push(s),warn:s=>logs.push(s),error:s=>logs.push(s)};
 const env={COLLECT_RESULT:'success',DEPLOY_RESULT:'success',GITHUB_STEP_SUMMARY:path.join(dir,'summary'),GITHUB_OUTPUT:path.join(dir,'output')};
 const save=e=>{fs.writeFileSync(path.join(dir,'data/api-validation.json'),JSON.stringify(e.report));fs.writeFileSync(path.join(dir,'artifacts/youtube-audit.json'),JSON.stringify(e.audit));fs.writeFileSync(path.join(dir,'data/search-reservation.json'),JSON.stringify(reservation));};
 save(evidence({failedChannels:1}));assert.equal(run({directory:dir,env,logger}),0);
 assert.match(fs.readFileSync(env.GITHUB_STEP_SUMMARY,'utf8'),/PARTIAL[\s\S]*playlistItems[\s\S]*API_HTTP_500/);
 assert.match(fs.readFileSync(env.GITHUB_OUTPUT,'utf8'),/state=PARTIAL/);assert.ok(logs.some(s=>s.startsWith('::warning::')));
 assert.ok(!logs.some(s=>s.startsWith('::error::')));
 save(evidence({failedChannels:channels.length}));assert.equal(run({directory:dir,env,logger}),1);
 assert.match(fs.readFileSync(env.GITHUB_STEP_SUMMARY,'utf8'),/FAILURE/);
 fs.writeFileSync(path.join(dir,'data/api-validation.json'),'{bad');assert.equal(run({directory:dir,env,logger}),1);
});
test('status evaluation is read-only; failed acquisition preserves previous data and its warning status',()=>{
 const e=evidence({failedChannels:channels.length}),previous=e.snapshot.streams;
 const result={streams:[],checks:e.snapshot.checks,provider:{status:'error'}};
 const kept=merge(previous,result,channels,now);
 assert.equal(kept[0].id,previous[0].id);assert.equal(kept[0].fetched_at,previous[0].fetched_at);
 const before=JSON.stringify(e);state(e);assert.equal(JSON.stringify(e),before);
 assert.equal(e.snapshot.providers.YouTube.status,'partial');
 assert.deepEqual(diagnostics({channels:[null,{results:null},{results:[null]}]}),[]);
 assert.doesNotMatch(JSON.stringify(diagnostics({channels:[{record_id:'secret',results:[{status:'error',endpoint:'secret',error_code:'API_SECRET',category:'secret'}]}]})),/secret|API_SECRET/);
});
test('reporting runs after deploy, receives both job results, and does not turn intentional skips into failures',()=>{
 const workflow=fs.readFileSync('.github/workflows/update.yml','utf8');
 assert.match(workflow,/acquisition_status:\n    needs: \[collect, deploy\]/);
 assert.match(workflow,/COLLECT_RESULT: \$\{\{ needs.collect.result \}\}/);
 assert.match(workflow,/DEPLOY_RESULT: \$\{\{ needs.deploy.result \}\}/);
 assert.doesNotMatch(workflow.slice(workflow.indexOf('  acquisition_status:')),/needs.collect.result != 'success'/);
 assert.doesNotMatch(workflow,/continue-on-error/);
});
