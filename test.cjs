const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const http=require('node:http');
const path=require('node:path');
const {chromium}=require('playwright');
const {root,production}=require('./tests/helpers.cjs');
(async()=>{
  let browser,host;
  try{
    const projectPath='/' + (process.env.GITHUB_REPOSITORY?.split('/')[1] || 'retro-ring') + '/';
    host=http.createServer(async(req,res)=>{
      if(req.url==='/https-preview/'){
        try{res.setHeader('Content-Type','text/html; charset=utf-8');res.end(await fs.readFile(path.join(root,'artifacts/https-preview/index.html')));}catch{res.writeHead(404);res.end();}return;
      }
      const requestPath=new URL(req.url,'http://localhost').pathname;
      const pathname=requestPath.startsWith(projectPath) ? requestPath.slice(projectPath.length-1) : requestPath;
      const name=pathname==='/'?'index.html':pathname.slice(1);
      if(!['index.html','about.html','style.css','model.js','data.js','app.js','streams.json'].includes(name)){res.writeHead(404);res.end();return;}
      try{const body=await fs.readFile(path.join(root,'dist',name));res.setHeader('Content-Type',({'.js':'text/javascript','.css':'text/css','.json':'application/json','.html':'text/html'})[path.extname(name)]);res.end(body);}catch{res.writeHead(500);res.end();}
    });
    await new Promise((resolve,reject)=>{host.once('error',reject);host.listen(0,'127.0.0.1',resolve);});
    const options={headless:true,args:['--no-sandbox']};
    if(process.env.CHROMIUM_PATH)options.executablePath=process.env.CHROMIUM_PATH;
    else if(require('node:fs').existsSync('/usr/bin/chromium'))options.executablePath='/usr/bin/chromium';
    browser=await chromium.launch(options);
    await fs.mkdir(path.join(root,'artifacts'),{recursive:true});
    const base=`http://127.0.0.1:${host.address().port}`;
    const active=production().channels.filter(c=>c.platform==='YouTube');
    const sourceSnapshot=JSON.parse(await fs.readFile(path.join(root,'dist/streams.json'),'utf8'));
    const baseline=require('./dist/model.js').streams(sourceSnapshot,active);
    const report={snapshot_generated_at:sourceSnapshot.generated_at, registered:active.length,real_records:baseline.length};
    const stamp=Date.now(), iso=ms=>new Date(stamp+ms).toISOString();
    const fixture={schema_version:1,generated_at:iso(0),providers:{YouTube:{status:'ok'}},checks:[],streams:[]};
    for(const [id,status,title,viewers,start] of [
      ['aaa00000001','live','ガロスペ <img src=x>',null,-10000],
      ['aaa00000002','live','真サム 対戦',0,-20000],
      ['aaa00000003','live','北斗の拳 対戦',32,-30000],
      ['aaa00000004','upcoming','ガロスペ 予定',null,86400000],
      ['aaa00000005','archive','真サム 過去',null,-3600000],
      ['aaa00000006','archive','RBSP（餓狼伝説SPECIAL）大会',null,-3600000],
      ['aaa00000007','archive','KOF98 店舗対戦',null,-3600000],
      ['aaa00000008','archive','3rd STRIKE 対戦',null,-3600000],
      ['aaa00000009','archive','CvS2 対戦',null,-3600000],
      ['aaa00000010','archive','ヴァンパイアセイヴァー 対戦',null,-3600000],
      ['aaa00000011','archive','スパ2X 対戦',null,-3600000]]){
      fixture.streams.push({id,status,title,concurrent_viewers:viewers,starts_at:iso(start),fetched_at:iso(0),channel_id:active[0].record_id,url:'https://www.youtube.com/watch?v='+id});
    }
    fixture.streams[2].thumbnail_url='https://i.ytimg.com/vi/aaa00000003/mqdefault.jpg';
    fixture.streams.push(fixture.streams[2]);
    for(const prefix of ['/',projectPath]){
      const page=await browser.newPage({viewport:{width:390,height:844}});
      const errors=[];
      page.on('pageerror',e=>errors.push(String(e)));
      await page.goto(base+prefix,{waitUntil:'domcontentloaded'});
      await page.waitForFunction(()=>!document.getElementById('fetch-status').textContent.includes('読み込み中'));
      assert.equal(await page.locator('.card').count(),baseline.length);
      for(const width of [360,375,390,768,1440]){
        await page.setViewportSize({width,height:844});
        assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
      }
      await page.setViewportSize({width:390,height:844});
      await page.screenshot({path:path.join(root,'artifacts/mobile-portal.png'),timeout:15000});
      await page.click('#about-link');
      assert.equal(await page.locator('.sources a.channel').count(),59);
      assert.equal(new Set(await page.locator('.sources a.channel').evaluateAll(nodes=>nodes.map(n=>n.href))).size,59);
      await page.click('.back');
      let online=true;
      let responseSnapshot=fixture;
      await page.route('https://i.ytimg.com/**',route=>route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="32" height="18"/>'}));
      await page.route('**/streams.json',route=>online?route.fulfill({json:responseSnapshot}):route.fulfill({status:503,body:''}));
      await page.reload({waitUntil:'domcontentloaded'});
      await page.waitForSelector('#live .card');
      const ids=()=>page.locator('#live .card').evaluateAll(nodes=>nodes.map(n=>n.dataset.video));
      assert.deepEqual(await ids(),['aaa00000003','aaa00000002','aaa00000001']);
      assert.equal(await page.locator('.card').count(),11);
      assert.match(await page.locator('#live').innerText(),new RegExp(active[0].display_name));
      await page.waitForFunction(()=>document.querySelector('#live .thumb img')?.naturalWidth > 0);
      assert.match(await page.locator('#updated').innerText(),/最終更新.+日本時間/);
      assert.match(await page.locator('#live').innerText(),/0人/);
      assert.match(await page.locator('#live').innerText(),/不明/);
      assert.equal(await page.locator('#live h3 img').count(),0);
      await page.selectOption('#sort','time');
      assert.deepEqual(await ids(),['aaa00000001','aaa00000002','aaa00000003']);
      const card=page.locator('#live .card').first();
      const box=await card.boundingBox();
      for(const [x,y] of [[2,box.height/2],[box.width-8,box.height/2]]){
        assert.equal(await card.evaluate((node,[x,y])=>{
          const b=node.getBoundingClientRect();return document.elementFromPoint(b.x+x,b.y+y)?.closest('a')===node;
        },[x,y]),true);
      }
      await page.context().route('https://www.youtube.com/**',route=>route.fulfill({body:'YouTube test destination'}));
      const opened=page.waitForEvent('popup');
      await card.focus();await page.keyboard.press('Enter');
      const popup=await opened;
      await popup.waitForURL(fixture.streams[0].url);
      await popup.close();
      await page.click('#games-toggle');
      assert.equal(await page.locator('#games button').count(),8);
      await page.click('[data-game=garousp]');await page.click('[data-game=shinsam]');await page.click('#games-toggle');
      assert.equal(await page.locator('.card').count(),4);
      await page.click('[data-state=live]');
      assert.equal(await page.locator('.card').count(),2);
      await page.click('[data-state=archive]');await page.click('[data-state=upcoming]');
      assert.equal(await page.locator('.card').count(),0);
      assert.match(await page.locator('#results').innerText(),/該当する配信情報がありません/);
      await page.click('[data-state=live]');await page.click('#games-toggle');await page.click('[data-game=""]');
      online=false;
      await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));
      await page.waitForFunction(()=>document.getElementById('fetch-status').textContent.includes('読み込めません'));
      assert.equal((await ids()).length,3);
      online=true;
      await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));
      await page.waitForFunction(()=>document.getElementById('fetch-status').textContent==='');
      await page.click('[data-state=archive]');
      await page.click('[data-state=upcoming]');
      for(const [game,expected] of [
        ['garousp',2],['shinsam',2],['third',1],['cvs2',1],
        ['savior',1],['sf2',1],['hokuto',1]
      ]){
        await page.click('[data-game="'+game+'"]');
        assert.equal(await page.locator('.card').count(),expected,game);
        await page.click('[data-game=""]');
      }
      assert.equal(await page.locator('.card').count(),11);
      assert.ok(await page.getByText('KOF98 店舗対戦',{exact:true}).isVisible());
      await page.click('#games-toggle');
      const empty={...fixture,streams:[]};
      const loadSnapshot=async(snapshot,status)=>{
        responseSnapshot=snapshot;
        await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));
        await page.waitForFunction(wanted=>document.getElementById('fetch-status').textContent===wanted,status);
        assert.equal(await page.locator('.card').count(),0);
      };
      await loadSnapshot({...empty,generated_at:iso(-3600000*3)},'配信情報の更新が途絶えています。');
      assert.match(await page.locator('#results').innerText(),/現在の配信件数は未確認/);
      await loadSnapshot({...empty,providers:{YouTube:{status:'not_configured'}}},'YouTube APIキーが未設定のため、配信情報は未取得です。');
      assert.match(await page.locator('#updated').innerText(),/最終取得試行/);
      await loadSnapshot({...empty,checks:[{kind:'live',status:'partial'}]},'一部の配信元は確認範囲が限られています。');
      assert.match(await page.locator('#results').innerText(),/現在の配信件数は未確認/);
      await loadSnapshot({...empty,providers:{YouTube:{status:'partial'}},last_success_at:iso(-1000),
        checks:[{channel_id:active[0].record_id,kind:'live',status:'ok'},
          {channel_id:active[1].record_id,kind:'live',status:'partial'},
          {channel_id:active[2].record_id,kind:'live',status:'error'}]},
        '一部またはすべての配信情報を取得できていません。 ライブ確認 1／3件完了、1件は一部確認、1件は取得失敗・未確認。');
      assert.match(await page.locator('#updated').innerText(),/最終取得成功/);
      await loadSnapshot(empty,'');
      assert.match(await page.locator('#results').innerText(),/条件に該当する配信情報がありません/);
      assert.deepEqual(errors,[]);
      await page.close();
    }
    await fs.writeFile(path.join(root,'artifacts/browser-real-data.json'),JSON.stringify(report,null,2));
    if(baseline.length){
      for(const [location,reportName] of [
        [base+'/https-preview/','https-preview-browser.json'],
        [require('node:url').pathToFileURL(path.join(root,'artifacts/youtube-preview.html')).href,'file-preview-validation.json']
      ]){
        const page=await browser.newPage({viewport:{width:390,height:844}});
        const violations=[],requests=[];
        await page.exposeFunction('recordPolicy',v=>violations.push(v));
        await page.addInitScript(()=>document.addEventListener('securitypolicyviolation',e=>window.recordPolicy(e.violatedDirective)));
        page.on('request',req=>{if(/streams\.json|googleapis\.com/.test(req.url()))requests.push(req.url());});
        await page.goto(location,{waitUntil:'domcontentloaded'});
        await page.waitForSelector('.card');
        assert.equal(await page.locator('.card').count(),baseline.length);
        await page.click('#about-link');await page.waitForSelector('#offline-about:visible');assert.equal(await page.locator('#offline-about:visible a.channel').count(),59);
        await page.locator('.back').click();await page.locator('#offline-about').waitFor({state:'hidden'});assert.equal(await page.locator('#offline-about').isVisible(),false);
        await page.clock.install({time:new Date()});
        await page.clock.setSystemTime(new Date(Date.parse(sourceSnapshot.generated_at)+25*3600000));
        await page.selectOption('#sort','time');
        assert.equal(await page.locator('.card').count(),0);
        assert.deepEqual(requests,[]);assert.deepEqual(violations,[]);
        await fs.writeFile(path.join(root,'artifacts',reportName),JSON.stringify({...report,passed:true,expired_hidden:true,android_brave_device_verified:false},null,2));
        await page.close();
      }
    }
    console.log('PASS browser: both site paths, mobile widths, keyboard and card targets, filters, sorting, errors and available real previews');
  }finally{if(browser)await browser.close();if(host)host.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
