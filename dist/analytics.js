(() => {
  'use strict';
  const token = window.CLOUDFLARE_WEB_ANALYTICS_TOKEN;
  if (location.origin !== 'https://elrain1999.github.io' ||
      !location.pathname.startsWith('/gesen-live/') ||
      typeof token !== 'string' || !/^[a-f0-9]{32}$/i.test(token)) return;

  const beacon = document.createElement('script');
  beacon.defer = true;
  beacon.src = 'https://static.cloudflareinsights.com/beacon.min.js';
  beacon.dataset.cfBeacon = JSON.stringify({ token });
  document.body.append(beacon);

  const analyticsNotice = document.getElementById('analytics-enabled');
  if (analyticsNotice) {
    analyticsNotice.hidden = false;
    document.getElementById('analytics-disabled').hidden = true;
  }
})();
