const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const files = ['about.html', 'app.js', 'data.js', 'index.html', 'model.js', 'streams.json', 'style.css'];
assert.deepEqual(fs.readdirSync('dist').sort(), files);
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
