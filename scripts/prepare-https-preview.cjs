// Prepare a static, keyless deployment candidate. This command never deploys.
const fs=require('node:fs');
const crypto=require('node:crypto');
const {execFileSync}=require('node:child_process');
const {audit}=require('./audit-snapshot.cjs');
const model=require('../dist/model.js');
fs.rmSync('artifacts/https-preview',{recursive:true,force:true});
fs.rmSync('artifacts/https-preview-report.json',{force:true});
const bytes=fs.readFileSync('dist/streams.json');
const snapshot=JSON.parse(bytes);
const registry=JSON.parse(fs.readFileSync('data/channels.public.json'));
const result=audit(snapshot,registry,{requireOwnership:true});
if(!result.passed||result.warnings.length||!result.visible_now.total)throw Error('A current, ownership-audited real snapshot is required');
if(Date.now()-Date.parse(snapshot.generated_at)>86400000)throw Error('Snapshot has expired');
execFileSync(process.execPath,['scripts/export-preview.cjs'],{stdio:'inherit'});
let html=fs.readFileSync('artifacts/youtube-preview.html','utf8');
// Inline scripts are authorized by content hash; data never becomes executable markup.
const hashes=[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m=>"'sha256-"+crypto.createHash('sha256').update(m[1]).digest('base64')+"'");
const csp="default-src 'none'; script-src "+hashes.join(' ')+"; style-src 'unsafe-inline'; img-src https://i.ytimg.com; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
html=html.replace('<head>','<head><meta http-equiv="Content-Security-Policy" content="'+csp+'"><meta name="referrer" content="no-referrer"><meta name="robots" content="noindex,nofollow,noarchive">');
// Fail closed on credential patterns or any configured credential value. Never print matches.
const patterns=[/AIza[\w-]{20,}/,/\b(?:gh[pousr]_[\w]{20,}|github_pat_[\w]{20,})\b/,/-----BEGIN [\w ]*PRIVATE KEY-----/,/Bearer\s+[\w.-]{20,}/i];
const values=Object.entries(process.env).filter(([k,v])=>/(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(k)&&v&&v.length>=12).map(([,v])=>v);
if(patterns.some(p=>p.test(html))||values.some(v=>html.includes(v)))throw Error('Credential scan failed; candidate was not written');
const output='artifacts/https-preview';
fs.mkdirSync(output,{recursive:true});
fs.writeFileSync(output+'/index.html',html);
// Only this allowlisted directory is eligible for upload; never repository/data/.env.
const metadata={schema_version:1,snapshot_generated_at:snapshot.generated_at,snapshot_sha256:crypto.createHash('sha256').update(bytes).digest('hex'),html_sha256:crypto.createHash('sha256').update(html).digest('hex'),records:result.records,visible_at_preparation:result.visible_now,ownership_confirmed:result.ownership_confirmed_records,registered:model.activeChannels(model.channels(registry)).length,automatic_api_updates:false,data_expires_at:new Date(Date.parse(snapshot.generated_at)+86400000).toISOString(),credential_scan:'passed',deployed:false};
fs.writeFileSync('artifacts/https-preview-report.json',JSON.stringify(metadata,null,2)+'\n');
console.log('Prepared HTTPS candidate: '+result.visible_now.total+' real records; credentials scan passed; no deployment');
