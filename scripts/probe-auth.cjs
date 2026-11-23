// Optional real, credential-free negative tests. Never reads or sends API secrets.
const fs=require('node:fs');
const {request,failure}=require('./providers/http.cjs');
const source=require('../data/channels.public.json').channels;
(async()=>{
 const probes=[['YouTube','https://www.googleapis.com/youtube/v3/channels?'+new URLSearchParams({part:'id',id:source.find(c=>c.youtube_channel_id).youtube_channel_id})]];
 const results=[];
 for(const [platform,url]of probes){try{await request(url);results.push({platform,result:'unexpected_success_without_auth'});}catch(error){results.push({platform,result:'credential_free_negative_probe',...failure(error)});}}
 const report={checked_at:new Date().toISOString(),authenticated_data_retrieved:false,results};
 fs.mkdirSync('artifacts',{recursive:true});fs.writeFileSync('artifacts/auth-probe.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
})().catch(()=>{console.error('PROBE_FAILED');process.exitCode=1;});
