// Private, portable snapshot preview: no server, key, API request or deployment.
const fs=require('node:fs');const path=require('node:path');
const {audit}=require('./audit-snapshot.cjs');
const snapshot=JSON.parse(fs.readFileSync('dist/streams.json'));
const registry=JSON.parse(fs.readFileSync('data/channels.public.json'));
const result=audit(snapshot,registry);
if(!result.passed)throw Error('Snapshot audit failed: preview not exported');
const inline=value=>value.replace(/<\/script/gi,'<\\/script');
const safeJson=JSON.stringify(snapshot).replace(/</g,'\\u003c').replace(/\u2028/g,'\\u2028').replace(/\u2029/g,'\\u2029');
let html=fs.readFileSync('dist/index.html','utf8');
html=html.replace('<link rel="stylesheet" href="style.css">','<style>'+fs.readFileSync('dist/style.css','utf8')+'</style>');
html=html.replace(/<script src="(?:model|data|app|analytics(?:-config)?)\.js" defer><\/script>/g,'');
const about=fs.readFileSync('dist/about.html','utf8').match(/<main class="about">([\s\S]*?)<\/main>/)[1];
html=html.replace('href="about.html"','href="#about"').replace('</main>',()=>'</main><main class="about" id="offline-about" tabindex="-1" hidden>'+about.replace('href="index.html"','href="#"')+'</main>');
html=html.replace('</body>',()=>`<script>${inline(fs.readFileSync('dist/model.js','utf8'))}</script><script>${inline(fs.readFileSync('dist/data.js','utf8'))}</script><script>window.RETRO_RING_OFFLINE_SNAPSHOT=${safeJson};</script><script>${inline(fs.readFileSync('dist/app.js','utf8'))}</script></body>`);
fs.mkdirSync('artifacts',{recursive:true});fs.writeFileSync(path.join('artifacts','youtube-preview.html'),html);
console.log(`Exported private file preview: ${result.visible_now.total} real records, ${result.input_channels} YouTube channels`);
