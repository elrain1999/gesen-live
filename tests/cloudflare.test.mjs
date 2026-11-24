import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import worker,{isRecent,isScheduledSlot,runScheduled} from '../cloudflare/worker.mjs';
import {collectionMode} from '../scripts/collection-mode.mjs';
import {checkDeployment} from '../cloudflare/check-deployment.mjs';

const minute=60000;
const now=Date.parse('2026-11-24T08:14:00Z');
const early=Date.parse('2026-11-24T00:47:00Z');
const eveningCron='4,14,24,34,44,54 8-14 * * *';
const hourlyCron='47 0-7,15-23 * * *';
const event={cron:eveningCron,scheduledTime:now};
const dispatchUrl='https://api.github.com/repos/elrain1999/gesen-live/actions/workflows/update.yml/dispatches';
const token='mock-secret-value';
const env={GITHUB_DISPATCH_TOKEN:token};
const snapshot=(generated,success=generated,status='ok')=>({
  schema_version:1,generated_at:new Date(generated).toISOString(),
  last_success_at:success===null?null:new Date(success).toISOString(),
  providers:{YouTube:{status}},streams:[]
});

function mockNetwork(published,responseStatus=204){
  const calls=[],logs=[];
  const logger={log:(...args)=>logs.push(args),error:(...args)=>logs.push(args)};
  const fetcher=async(url,options)=>{
    calls.push({url:String(url),options});
    if(options.method==='POST'){
      if(responseStatus instanceof Error)throw responseStatus;
      return {status:responseStatus,json:async()=>{throw new Error(token);}};
    }
    if(published instanceof Error)throw published;
    return {ok:published!==null,json:async()=>published};
  };
  return {calls,logs,fetcher,logger,now:()=>now};
}

test('Wrangler and the Worker accept exactly 59 UTC slots across the JST date boundary',()=>{
  assert.equal(typeof worker.scheduled,'function');
  assert.equal(worker.fetch,undefined);
  const config=readFileSync('cloudflare/wrangler.toml','utf8');
  assert.ok(config.includes(`crons = ["${hourlyCron}", "${eveningCron}"]`));
  let count=0;
  const start=Date.parse('2026-11-23T15:00:00Z');
  for(let offset=0;offset<1440;offset++){
    const scheduledTime=start+offset*minute;
    const hour=Math.floor(offset/60),min=offset%60;
    const matches=[hourlyCron,eveningCron].filter(cron=>isScheduledSlot({cron,scheduledTime}));
    const expected=hour<17?min===47:min%10===4;
    assert.equal(matches.length,Number(expected));
    count+=matches.length;
  }
  assert.equal(count,59);
  assert.equal(isScheduledSlot({cron:'* * * * *',scheduledTime:now}),false);
});

test('freshness permits the next target interval across JST day and evening boundaries',()=>{
  for(const [checkedAt,maxAge] of [['2026-11-24T07:59:59Z',50],['2026-11-24T08:00:00Z',8],
    ['2026-11-24T14:59:59Z',8],['2026-11-24T15:00:00Z',50]]){
    const time=Date.parse(checkedAt);
    assert.equal(isRecent(time-(maxAge*minute-1),time),true,checkedAt);
    assert.equal(isRecent(time-maxAge*minute,time),false,checkedAt);
  }
  assert.equal(isRecent(Date.parse('2026-11-24T14:55:00Z'),Date.parse('2026-11-24T15:47:00Z')),false);
  assert.equal(isRecent(now+1,now),false);
});

test('stale Pages dispatches main with the Cloudflare flag and logs acceptance only',async()=>{
  const mock=mockNetwork(snapshot(now-minute,now-20*minute,'error'));
  await runScheduled(event,env,mock);
  assert.equal(mock.calls.length,2);
  const [probe,dispatch]=mock.calls;
  assert.equal(new URL(probe.url).origin,'https://elrain1999.github.io');
  assert.equal(probe.options.headers.authorization,undefined);
  assert.equal(probe.options.redirect,'manual');
  assert.equal(dispatch.url,dispatchUrl);
  assert.equal(dispatch.options.headers.authorization,'Bearer '+token);
  assert.equal(dispatch.options.redirect,'manual');
  assert.deepEqual(JSON.parse(dispatch.options.body),{ref:'main',inputs:{cloudflare:'true'},return_run_details:true});
  assert.deepEqual(mock.logs.at(-1),['github_dispatch_accepted',new Date(now).toISOString(),204,{elapsed_ms:0}]);
  assert.doesNotMatch(JSON.stringify(mock.logs),new RegExp(token));
});

test('fresh Pages or an unexpected trigger avoids dispatch',async()=>{
  const fresh=mockNetwork(snapshot(now-5*minute));
  await runScheduled(event,env,fresh);
  assert.equal(fresh.calls.length,1);
  assert.equal(fresh.logs[0][0],'pages_fresh');
  const wrong=mockNetwork(null);
  await runScheduled({...event,cron:'* * * * *'},env,wrong);
  assert.equal(wrong.calls.length,0);
  assert.equal(wrong.logs[0][0],'cron_ignored');
});

test('unavailable, invalid, or future Pages snapshots allow one dispatch',async()=>{
  for(const pages of [null,new Error('network'),{},snapshot(now+minute),snapshot(now-minute,null)]){
    const mock=mockNetwork(pages);
    await runScheduled(event,env,mock);
    assert.equal(mock.calls.filter(c=>c.url===dispatchUrl).length,1);
  }
});

test('missing credentials fail without network access',async()=>{
  const mock=mockNetwork(null);
  await assert.rejects(runScheduled(event,{},mock),/^Error: github_dispatch_token_missing$/);
  assert.equal(mock.calls.length,0);
});

test('dispatch HTTP errors and redirects record status without following or retrying',async()=>{
  for(const status of [302,401,403,404,422,429,503]){
    const mock=mockNetwork(null,status);
    await assert.rejects(runScheduled(event,env,mock),/^Error: github_dispatch_rejected$/);
    assert.equal(mock.calls.length,2);
    assert.deepEqual(mock.logs.at(-1),['github_dispatch_rejected',new Date(now).toISOString(),status,{
      category:status===302?'redirect_refused':'http_rejected',elapsed_ms:0
    }]);
    assert.doesNotMatch(JSON.stringify(mock.logs),new RegExp(token));
  }
});

test('dispatch exceptions record safe diagnostics and elapsed time without retrying',async()=>{
  const cases=[
    [new Error(token),'Error','fetch_error'],
    [Object.assign(new Error(token),{name:token}),'UnknownError','fetch_error'],
    [new TypeError('Invalid redirect value '+token),'TypeError','invalid_redirect'],
    [new TypeError('Network connection failed '+token),'TypeError','network_error'],
    [new DOMException(token,'AbortError'),'AbortError','aborted'],
    [new DOMException(token,'TimeoutError'),'TimeoutError','timeout']
  ];
  for(const [error,exception,category] of cases){
    const mock=mockNetwork(null,error);
    let reading=now;
    await assert.rejects(runScheduled(event,env,{...mock,now:()=>{reading+=75;return reading;}}),
      /^Error: github_dispatch_unconfirmed$/);
    assert.equal(mock.calls.length,2);
    assert.deepEqual(mock.logs.at(-1),['github_dispatch_unconfirmed',new Date(now).toISOString(),{
      exception,category,timeout:category==='timeout',elapsed_ms:75
    }]);
    assert.doesNotMatch(JSON.stringify(mock.logs),new RegExp(token));
  }
});

test('dispatch accepts a 200 response and logs only a valid numeric run ID',async()=>{
  const detailed=mockNetwork(null,200);
  await runScheduled(event,env,detailed);
  assert.deepEqual(detailed.logs.at(-1),['github_dispatch_accepted',new Date(now).toISOString(),200,{elapsed_ms:0}]);
  const fetcher=async(url,options)=>options.method==='POST'?{
    status:200,json:async()=>({workflow_run_id:123,html_url:token})
  }:{ok:false};
  await runScheduled(event,env,{...detailed,fetcher});
  assert.deepEqual(detailed.logs.at(-1),['github_dispatch_accepted',new Date(now).toISOString(),200,123,{elapsed_ms:0}]);
  assert.doesNotMatch(JSON.stringify(detailed.logs),new RegExp(token));
});

test('the Cron handler turns off retry for this non-idempotent dispatch',async()=>{
  let disabled=false;
  const scheduled={...event,noRetry:()=>{disabled=true;}};
  await worker.scheduled({...scheduled,cron:'* * * * *'},{});
  assert.equal(disabled,true);
});

test('a second serialized automatic run skips recent work in either order',async()=>{
  for(const [checkedAt,elapsed] of [[now,5],[early,30]]){
    const completed=checkedAt-elapsed*minute;
    for(const first of ['schedule','cloudflare']){
      const options={...mockNetwork(snapshot(completed)),now:()=>checkedAt,publish:true};
      assert.equal(await collectionMode(undefined,options),'fetch',first);
      assert.equal(await collectionMode(snapshot(completed),options),'skip',first);
    }
  }
});

test('a recent unpublished success can deploy from the cache without another API collection',async()=>{
  const completed=now-minute;
  for(const publicData of [snapshot(now-15*minute),null]){
    const mock=mockNetwork(publicData);
    assert.equal(await collectionMode(snapshot(completed),{...mock,publish:true}),'reuse');
    assert.equal(mock.calls.length,1);
  }
  const newer=mockNetwork(snapshot(now));
  assert.equal(await collectionMode(snapshot(completed),{...newer,publish:true}),'skip');
});

test('recent failure does not repeat YouTube requests or deploy a failed cache',async()=>{
  const mock=mockNetwork(null);
  assert.equal(await collectionMode(snapshot(now-minute,now-20*minute,'error'),{...mock,publish:true}),'skip');
  assert.equal(await collectionMode(snapshot(now-minute),{...mock,publish:false}),'skip');
  assert.equal(mock.calls.length,0);
  assert.equal(await collectionMode(snapshot(now-8*minute),{...mock,publish:true}),'fetch');
  assert.equal(await collectionMode(snapshot(now+minute),{...mock,publish:true}),'fetch');
  assert.equal(await collectionMode({}, {...mock,publish:true}),'fetch');
});

test('deployment preflight and verification use only the named Worker and preserve the Secret',async()=>{
  const calls=[];
  const accountId='a'.repeat(32);
  const fetcher=async(url,options)=>{
    calls.push(url);
    assert.equal(options.headers.authorization,'Bearer '+token);
    assert.equal(options.method,undefined);
    assert.equal(options.redirect,'error');
    const result=url.endsWith('/schedules')
      ? {schedules:[{cron:eveningCron},{cron:hourlyCron}]}
      : {name:'GITHUB_DISPATCH_TOKEN',type:'secret_text'};
    return {ok:true,json:async()=>({success:true,result})};
  };
  const base=`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/gesen-live-scheduler`;
  const options={accountId,token,fetcher};
  await checkDeployment('preflight',options);
  assert.deepEqual(calls,[base+'/secrets/GITHUB_DISPATCH_TOKEN']);
  await checkDeployment('verify',options);
  assert.deepEqual(calls.slice(1),[base+'/secrets/GITHUB_DISPATCH_TOKEN',base+'/schedules']);
});

test('deployment checks stop on missing credentials, inaccessible Worker or incorrect Cron',async()=>{
  const accountId='a'.repeat(32);
  const noNetwork=()=>assert.fail('request should be skipped');
  await assert.rejects(checkDeployment('preflight',{accountId,fetcher:noNetwork}),/CLOUDFLARE_API_TOKEN/);
  await assert.rejects(checkDeployment('preflight',{token,fetcher:noNetwork}),/CLOUDFLARE_ACCOUNT_ID/);
  const rejected=async()=>({ok:false,status:403,json:async()=>assert.fail('error body should not be read')});
  await assert.rejects(checkDeployment('preflight',{accountId,token,fetcher:rejected}),/HTTP 403/);
  const invalid=async url=>({ok:true,json:async()=>({
    success:true,result:url.endsWith('/schedules')?{schedules:[{cron:eveningCron}]}
      :{name:'GITHUB_DISPATCH_TOKEN',type:'secret_text'}
  })});
  await assert.rejects(checkDeployment('verify',{accountId,token,fetcher:invalid}),/two expected UTC Cron/);
  const unexpected=async()=>({ok:true,json:async()=>({success:true,result:{name:'GITHUB_DISPATCH_TOKEN',type:'plain_text'}})});
  await assert.rejects(checkDeployment('preflight',{accountId,token,fetcher:unexpected}),/registered as a Secret/);
});
