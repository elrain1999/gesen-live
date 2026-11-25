import {pathToFileURL} from 'node:url';

const worker = 'gesen-live-scheduler';
const secretName = 'GITHUB_DISPATCH_TOKEN';
const expectedCrons = ['47 0-7,15-23 * * *', '4,19,34,49 8-14 * * *'];

export async function checkDeployment(phase, {accountId, token, fetcher = fetch}) {
  if (!['preflight', 'verify'].includes(phase)) throw new Error('Unknown deployment check');
  if (!/^[a-f0-9]{32}$/i.test(accountId || '')) throw new Error('Set the CLOUDFLARE_ACCOUNT_ID repository variable');
  if (!token) throw new Error('Set the CLOUDFLARE_API_TOKEN repository secret');

  const base = `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${worker}`;
  async function read(path, label) {
    let response;
    try {
      response = await fetcher(base + path, {
        headers: {authorization: 'Bearer ' + token, accept: 'application/json'},
        redirect: 'error',
        signal: AbortSignal.timeout(15000)
      });
    } catch {
      throw new Error(`Cloudflare ${label} request failed`);
    }
    if (!response.ok) throw new Error(`Cloudflare ${label} returned HTTP ${response.status}`);
    let body;
    try {
      body = await response.json();
    } catch {
      throw new Error(`Cloudflare ${label} returned invalid JSON`);
    }
    if (body?.success !== true) throw new Error(`Cloudflare ${label} did not confirm success`);
    return body.result;
  }

  // This endpoint returns binding metadata without retrieving the secret value.
  const binding = await read('/secrets/' + secretName, 'Worker secret metadata');
  if (binding?.name !== secretName || binding.type !== 'secret_text') {
    throw new Error('The existing Worker must have GITHUB_DISPATCH_TOKEN registered as a Secret');
  }
  if (phase === 'preflight') return;

  const {schedules} = (await read('/schedules', 'Cron schedules')) || {};
  if (!Array.isArray(schedules) || schedules.length !== expectedCrons.length ||
      !expectedCrons.every(cron => schedules.some(schedule => schedule?.cron === cron))) {
    throw new Error('The two expected UTC Cron Triggers were not confirmed');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const phase = process.argv[2];
  try {
    await checkDeployment(phase, {
      accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
      token: process.env.CLOUDFLARE_API_TOKEN
    });
    console.log(phase === 'verify'
      ? 'Existing Worker Secret binding and both UTC Cron Triggers verified'
      : 'Existing Worker and Secret binding verified');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
