import {appendFileSync,readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {isRecent,readPublishedSnapshot,snapshotTimes} from '../cloudflare/worker.mjs';

export async function collectionMode(snapshot,{fetcher=fetch,now=Date.now,key='',publish=false}={}){
  const checkedAt=now();
  const cached=snapshotTimes(snapshot,checkedAt);
  if(!cached||!isRecent(cached.generated,checkedAt))return 'fetch';
  if(!publish||cached.success!==cached.generated||!['ok','partial'].includes(snapshot.providers?.YouTube?.status))return 'skip';

  // Cache is saved before Pages deploys. Reuse a successful unpublished collection.
  const published=await readPublishedSnapshot(fetcher,now,'actions-'+key);
  return published&&published.generated>=cached.generated?'skip':'reuse';
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  let snapshot;
  try{snapshot=JSON.parse(readFileSync('data/streams.json','utf8'));}catch{}
  const key=process.env.GITHUB_RUN_ID+'-'+process.env.GITHUB_RUN_ATTEMPT;
  const mode=await collectionMode(snapshot,{key,publish:process.env.PUBLISH_PAGES==='true'});
  console.log('Automatic collection mode:',mode);
  appendFileSync(process.env.GITHUB_OUTPUT,`mode=${mode}\n`);
}
