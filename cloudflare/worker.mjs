const hourlyCron = '47 0-7,15-23 * * *';
const eveningCron = '4,14,24,34,44,54 8-14 * * *';
const dispatchUrl = 'https://api.github.com/repos/elrain1999/gesen-live/actions/workflows/update.yml/dispatches';
const pagesUrl = 'https://elrain1999.github.io/gesen-live/streams.json';
const minute = 60000;
const dispatchErrorNames = ['Error', 'TypeError', 'TimeoutError', 'AbortError', 'NetworkError'];

function jstHour(time) {
  return new Date(time + 9 * 60 * minute).getUTCHours();
}

export function isScheduledSlot({ cron, scheduledTime }) {
  if (!Number.isFinite(scheduledTime)) return false;
  const minutes = new Date(scheduledTime).getUTCMinutes();
  return jstHour(scheduledTime) < 17
    ? cron === hourlyCron && minutes === 47
    : cron === eveningCron && minutes % 10 === 4;
}

// Leave room for runner startup and publishing before the next 60/10-minute slot.
export function isRecent(time, now) {
  const age = now - time;
  return age >= 0 && age < (jstHour(now) < 17 ? 50 : 8) * minute;
}

export function snapshotTimes(snapshot, now) {
  if (snapshot?.schema_version !== 1 || !Array.isArray(snapshot.streams)) return null;
  const generated = Date.parse(snapshot.generated_at);
  if (!Number.isFinite(generated) || generated > now) return null;
  const success = Date.parse(snapshot.last_success_at);
  return { generated, success: Number.isFinite(success) && success <= generated ? success : null };
}

export async function readPublishedSnapshot(fetcher, now, key) {
  const url = new URL(pagesUrl);
  url.searchParams.set('scheduler_check', key);
  try {
    const response = await fetcher(url, {
      headers: { accept: 'application/json', 'cache-control': 'no-cache' },
      redirect: 'manual',
      signal: AbortSignal.timeout(8000)
    });
    if (response.ok) return snapshotTimes(await response.json(), now());
  } catch {
    // A Pages outage cannot establish freshness.
  }
  return null;
}

function dispatchFailure(error, signal) {
  const exception = dispatchErrorNames.includes(error?.name) ? error.name : 'UnknownError';
  const timeout = signal.reason?.name === 'TimeoutError' || exception === 'TimeoutError';
  if (timeout) return { exception, timeout, category: 'timeout' };
  if (exception === 'AbortError') return { exception, timeout, category: 'aborted' };
  const message = typeof error?.message === 'string' ? error.message : '';
  if (message.startsWith('Invalid redirect value')) return { exception, timeout, category: 'invalid_redirect' };
  if (/\b(?:network|dns|tls|connection|socket)\b/i.test(message)) return { exception, timeout, category: 'network_error' };
  return { exception, timeout, category: 'fetch_error' };
}

export async function runScheduled(event, env, { fetcher = fetch, now = Date.now, logger = console } = {}) {
  if (!isScheduledSlot(event)) {
    logger.log('cron_ignored');
    return;
  }
  const scheduledAt = new Date(event.scheduledTime).toISOString();
  if (!env.GITHUB_DISPATCH_TOKEN) {
    logger.error('github_dispatch_token_missing', scheduledAt);
    throw new Error('github_dispatch_token_missing');
  }

  const published = await readPublishedSnapshot(fetcher, now, 'worker-' + event.scheduledTime);
  if (published?.success != null && isRecent(published.success, now())) {
    logger.log('pages_fresh', scheduledAt, new Date(published.success).toISOString());
    return;
  }
  logger.log(published ? 'pages_stale' : 'pages_unconfirmed', scheduledAt);

  const startedAt = now();
  const signal = AbortSignal.timeout(10000);
  let response;
  try {
    response = await fetcher(dispatchUrl, {
      method: 'POST',
      headers: {
        accept: 'application/vnd.github+json',
        authorization: 'Bearer ' + env.GITHUB_DISPATCH_TOKEN,
        'content-type': 'application/json',
        'user-agent': 'gesen-live-scheduler',
        'x-github-api-version': '2022-11-28'
      },
      body: JSON.stringify({ ref: 'main', inputs: { cloudflare: 'true' }, return_run_details: true }),
      // Workers supports manual redirects. Never forward the authenticated POST to another URL.
      redirect: 'manual',
      signal
    });
  } catch (error) {
    logger.error('github_dispatch_unconfirmed', scheduledAt, {
      ...dispatchFailure(error, signal),
      elapsed_ms: Math.max(0, now() - startedAt)
    });
    throw new Error('github_dispatch_unconfirmed');
  }
  const elapsed_ms = Math.max(0, now() - startedAt);
  if (response.status !== 204 && response.status !== 200) {
    const category = response.status >= 300 && response.status < 400 ? 'redirect_refused' : 'http_rejected';
    logger.error('github_dispatch_rejected', scheduledAt, response.status, { category, elapsed_ms });
    throw new Error('github_dispatch_rejected');
  }
  let runId;
  if (response.status === 200) {
    try {
      const details = await response.json();
      if (Number.isSafeInteger(details?.workflow_run_id) && details.workflow_run_id > 0) runId = details.workflow_run_id;
    } catch {}
  }
  if (runId) logger.log('github_dispatch_accepted', scheduledAt, response.status, runId, { elapsed_ms });
  else logger.log('github_dispatch_accepted', scheduledAt, response.status, { elapsed_ms });
}

export default {
  scheduled(event, env) {
    // A network failure after POST can still mean GitHub accepted the dispatch.
    event.noRetry();
    return runScheduled(event, env);
  }
};
