const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const files = ['about.html', 'analytics-config.js', 'analytics.js', 'app.js', 'data.js', 'index.html', 'model.js', 'streams.json', 'style.css'];
const bannerPaths = fs.readFileSync('dist/index.html', 'utf8').match(/id="top-banner"[^>]+data-sources="([^"]*)"/)[1].split(/\s+/).filter(Boolean);
assert.deepEqual(fs.readdirSync('dist').sort(), bannerPaths.length ? [...files, 'banners'].sort() : files);
if (bannerPaths.length) {
  assert(fs.lstatSync('dist/banners').isDirectory());
  const bannerFiles = bannerPaths.map(source => {
    assert.match(source, /^banners\/[a-z0-9-]+\.webp$/);
    return path.basename(source);
  });
  assert.deepEqual(fs.readdirSync('dist/banners').sort(), bannerFiles.sort());
  for (const source of bannerPaths) {
    const filename = path.join('dist', source);
    assert(fs.lstatSync(filename).isFile());
    const image = fs.readFileSync(filename);
    assert.equal(image.toString('ascii', 0, 4), 'RIFF');
    assert.equal(image.toString('ascii', 8, 12), 'WEBP');
  }
}
const forbidden = [
  /AIza[\w-]{35}|gh[pousr]_[\w]{25,}|github_pat_[\w]{24,}|-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/,
  /(?:drive|docs)\.google\.com\/|[\w.%+-]+@[\w.-]+\.[a-z]{2,}/i,
  /(?:www\.googleapis\.com|api\.twitch\.tv|id\.twitch\.tv)\//i,
];
for (const name of files) {
  const file = path.join('dist', name);
  assert(fs.lstatSync(file).isFile());
  const contents = fs.readFileSync(file, 'utf8');
  if (forbidden.some(pattern => pattern.test(contents))) {
    throw Error('Public asset scan failed in ' + name);
  }
}
