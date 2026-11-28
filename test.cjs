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
      if(!['index.html','about.html','style.css','model.js','data.js','app.js','streams.json','analytics-config.js','analytics.js'].includes(name) &&
         !/^banners\/[a-z0-9-]+\.webp$/.test(name)){res.writeHead(404);res.end();return;}
      try{const body=await fs.readFile(path.join(root,'dist',name));res.setHeader('Content-Type',({'.js':'text/javascript','.css':'text/css','.json':'application/json','.html':'text/html','.webp':'image/webp'})[path.extname(name)]);res.end(body);}catch{res.writeHead(500);res.end();}
    });
    await new Promise((resolve,reject)=>{host.once('error',reject);host.listen(0,'127.0.0.1',resolve);});
    const options={headless:true,args:['--no-sandbox']};
    if(process.env.CHROMIUM_PATH)options.executablePath=process.env.CHROMIUM_PATH;
    else if(require('node:fs').existsSync('/usr/bin/chromium'))options.executablePath='/usr/bin/chromium';
    browser=await chromium.launch(options);
    await fs.mkdir(path.join(root,'artifacts'),{recursive:true});
    const base=`http://127.0.0.1:${host.address().port}`;
    const model=require('./dist/model.js');
    const active=model.activeChannels(model.channels(production()));
    const sourceSnapshot=JSON.parse(await fs.readFile(path.join(root,'dist/streams.json'),'utf8'));
    const baseline=require('./dist/model.js').streams(sourceSnapshot,active);
    const report={snapshot_generated_at:sourceSnapshot.generated_at, registered:active.length,real_records:baseline.length};
    const stamp=Date.now(), iso=ms=>new Date(stamp+ms).toISOString();
    const fixture={schema_version:1,generated_at:iso(0),providers:{YouTube:{status:'ok'}},checks:[],streams:[]};
    for(const [id,status,title,viewers,start] of [
      ['aaa00000001','live','ガロスペ・KOF98 <img src=x>',null,-10000],
      ['aaa00000002','live','真サム 対戦',0,-20000],
      ['aaa00000003','live','北斗の拳 対戦',32,-30000],
      ['aaa00000004','upcoming','ガロスペ・KOF98 予定',null,86400000],
      ['aaa00000005','archive','真サム 過去',null,-3600000],
      ['aaa00000006','archive','RBSP（餓狼伝説SPECIAL）大会',null,-3600000],
      ['aaa00000007','archive','ガロスペ・KOF98 店舗対戦',null,-3600000],
      ['aaa00000008','archive','3rd STRIKE / SFZ3 / GGXX 対戦',null,-3600000],
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
      await page.addInitScript(()=>{Math.random=()=>Number(sessionStorage.getItem('testBannerDraw')??'0.1');});
      await page.goto(base+prefix,{waitUntil:'domcontentloaded'});
      await page.waitForFunction(()=>!document.getElementById('fetch-status').textContent.includes('読み込み中'));
      assert.equal(await page.locator('.card').count(),baseline.length);
      const banner=page.locator('#top-banner');
      const fallbackTitle=page.locator('header h1');
      const controlsFit=()=>page.evaluate(()=>{
        const game=document.querySelector('#games-toggle').getBoundingClientRect();
        const sort=document.querySelector('#sort').getBoundingClientRect();
        return game.top===sort.top && game.right<sort.left && sort.right<=innerWidth &&
          game.height>=44 && sort.height>=44;
      });
      const checkBannerHeight=width=>banner.evaluate((image,mobile)=>{
        const expectedHeight=image.clientWidth*image.naturalHeight/image.naturalWidth*(mobile ? .88 : 1);
        return Math.abs(image.clientHeight-expectedHeight)<2 &&
          (!mobile || getComputedStyle(image).objectPosition==='50% 0%');
      },width<=540);
      await banner.waitFor({state:'visible'});
      assert.match(await banner.getAttribute('src'),/ryu-terry\.webp$/);
      for(const width of [320,360,361,375,390,768,1440]){
        await page.setViewportSize({width,height:844});
        assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
        assert.ok(await controlsFit(),`controls share a row at ${width}px`);
        assert.ok(await checkBannerHeight(width),width);
        assert.ok(await page.evaluate(()=>{
          const stamp=document.querySelector('header #updated').getBoundingClientRect();
          const about=document.querySelector('#about-link').getBoundingClientRect();
          return !document.querySelector('main #updated') && stamp.right<=about.left &&
            Math.abs(stamp.top+stamp.height/2-about.top-about.height/2)<1;
        }));
      }
      await page.setViewportSize({width:390,height:844});
      if(prefix==='/'){
        for(const [draw,filename] of [[0.5,'geese-bison.webp'],[0.9,'chun-li-mai.webp']]){
          await page.evaluate(value=>sessionStorage.setItem('testBannerDraw',value),String(draw));
          await page.reload({waitUntil:'domcontentloaded'});
          await banner.waitFor({state:'visible'});
          assert.equal(await banner.getAttribute('src'),'banners/'+filename);
          assert.ok(await checkBannerHeight(390));
          await page.fill('#archive-search','対戦');
          assert.equal(await banner.getAttribute('src'),'banners/'+filename);
          await page.fill('#archive-search','');
        }
        await page.route('**/banners/*.webp',route=>route.abort());
        await page.reload();
        assert.equal(await banner.isVisible(),false);
        assert.ok((await fallbackTitle.boundingBox()).width>1);
        assert.ok(await page.locator('#about-link').isVisible());
        await page.unroute('**/banners/*.webp');
        await page.reload();
        await banner.waitFor({state:'visible'});
      }
      await page.screenshot({path:path.join(root,'artifacts/mobile-portal.png'),timeout:15000});
      await page.click('#about-link');
      assert.equal(await page.locator('h1').innerText(),'このサイトについて');
      assert.equal(await page.getByText('配信元一覧',{exact:true}).count(),0);
      assert.ok(await page.locator('#analytics-disabled').isVisible());
      assert.equal(await page.locator('#analytics-enabled').isVisible(),false);
      assert.equal(await page.locator('main a[href="https://www.cloudflare.com/policies/privacy/"]').count(),1);
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
      assert.match(await page.locator('#updated').innerText(),/最終取得試行 \d{2}\/\d{2} \d{2}:\d{2}.*JST/);
      assert.ok((await page.locator('#updated').boundingBox()).height<20);
      await page.setViewportSize({width:1440,height:844});
      assert.match(await page.locator('#updated').innerText(),/最終取得試行.+日本時間/);
      await page.setViewportSize({width:390,height:844});
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
      assert.deepEqual(await page.locator('#games button').allTextContents(),[
        'すべて','餓狼伝説SPECIAL','真サムライスピリッツ','ストリートファイターIII 3rd STRIKE',
        'CAPCOM VS. SNK 2','ヴァンパイアシリーズ','ストリートファイターIIシリーズ','北斗の拳',
        'ストリートファイターZEROシリーズ','ザ・キング・オブ・ファイターズシリーズ',
        'ギルティギアシリーズ','餓狼伝説シリーズ','サムライスピリッツシリーズ'
      ]);
      await page.setViewportSize({width:320,height:844});
      for(const button of await page.locator('#games button:not([data-game=""])').all()) await button.click();
      assert.match(await page.locator('#games-toggle').innerText(),/12/);
      assert.ok(await controlsFit(),'controls share a row at 320px with all categories selected');
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
      await page.click('[data-game=""]');
      await page.setViewportSize({width:390,height:844});
      await page.click('[data-game=garousp]');await page.click('[data-game=shinsam]');await page.click('#games-toggle');
      assert.equal(await page.locator('.card').count(),5);
      await page.click('[data-state=live]');
      assert.equal(await page.locator('.card').count(),3);
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
        ['garousp',3],['shinsam',2],['third',1],['cvs2',1],
        ['savior',1],['sf2',1],['hokuto',1],['sfzero',1],['kof',3],
        ['guiltygear',1],['fatalfury',4],['samuraispirits',2]
      ]){
        await page.click('[data-game="'+game+'"]');
        assert.equal(await page.locator('.card').count(),expected,game);
        await page.click('[data-game=""]');
      }
      await page.click('[data-game=garousp]');
      await page.click('[data-game=kof]');
      for(const state of ['live','upcoming','archive']){
        assert.equal(await page.locator('#'+state+' .card').count(),1);
      }
      await page.click('[data-game=""]');
      assert.equal(await page.locator('.card').count(),11);
      assert.ok(await page.getByText('ガロスペ・KOF98 店舗対戦',{exact:true}).isVisible());
      const archiveSearch=page.getByRole('searchbox',{name:'アーカイブのタイトル検索'});
      assert.equal(await page.locator('#archive > h2 + label').getByRole('searchbox').count(),1);
      assert.equal(await page.locator('#live input, #upcoming input, .filters input').count(),0);
      await page.click('[data-game=kof]');
      await archiveSearch.fill('  ｋｏｆ９８　店舗  ');
      assert.ok(await archiveSearch.evaluate(node=>document.activeElement===node));
      assert.equal(await page.locator('#archive h2 small').textContent(),'1件');
      assert.ok(await page.locator('#archive').getByText('ガロスペ・KOF98 店舗対戦').isVisible());
      assert.equal(await page.locator('#live h2 small').textContent(),'1件');
      assert.equal(await page.locator('#upcoming h2 small').textContent(),'1件');
      await page.click('[data-game=shinsam]');
      await page.click('[data-game=kof]');
      assert.equal(await page.locator('#archive h2 small').textContent(),'0件');
      await page.click('[data-game=""]');
      await page.click('[data-state=archive]');
      assert.equal(await archiveSearch.isVisible(),false);
      await page.click('[data-state=archive]');
      assert.equal(await archiveSearch.inputValue(),'  ｋｏｆ９８　店舗  ');
      await archiveSearch.fill('');
      assert.equal(await page.locator('#archive h2 small').textContent(),'7件');
      await page.click('#games-toggle');
      const empty={...fixture,streams:[]};
      const loadSnapshot=async(snapshot,status,count=0)=>{
        responseSnapshot=snapshot;
        await page.reload({waitUntil:'domcontentloaded'});
        await page.waitForFunction(wanted=>document.getElementById('fetch-status').textContent===wanted,status);
        assert.equal(await page.locator('.card').count(),count);
      };
      const beforeRollback=await page.locator('#updated-time').textContent();
      responseSnapshot={...fixture,generated_at:iso(-48*3600000),streams:[]};
      await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));
      await page.waitForFunction(()=>document.getElementById('fetch-status').textContent.includes('読み込めませんでした'));
      assert.equal(await page.locator('#updated-time').textContent(),beforeRollback);
      assert.equal(await page.locator('.card').count(),11);
      await loadSnapshot(fixture,'',11);
      const staleTime=iso(-67*60000);
      const vampireFixtures=['【ヴァンパイア】 初代対戦','Night Warriors / 3rd STRIKE'].map((title,i)=>{
        const id='aaa0000001'+(2+i);
        return {...fixture.streams[9],id,title,url:'https://www.youtube.com/watch?v='+id};
      });
      responseSnapshot={...fixture,streams:[...fixture.streams,...vampireFixtures]};
      await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));
      await page.locator('#archive').getByText(vampireFixtures[0].title).waitFor();
      await page.click('#games-toggle');
      await page.click('[data-game=savior]');
      assert.equal(await page.locator('#archive h2 small').textContent(),'3件');
      await archiveSearch.fill('night warriors');
      assert.equal(await page.locator('#archive h2 small').textContent(),'1件');
      await archiveSearch.fill('');
      await page.click('[data-game=""]');
      await page.click('#games-toggle');
      const otherGame={...fixture.streams[4],title:'SOUND VOLTEX 店舗配信'};
      responseSnapshot={...fixture,streams:fixture.streams.map(row=>row.id===otherGame.id?otherGame:row)};
      await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));
      await page.locator('#archive').getByText(otherGame.title).waitFor();
      await archiveSearch.fill('sound voltex');
      assert.equal(await page.locator('#archive h2 small').textContent(),'1件');
      assert.ok(await page.locator('#archive').getByText(otherGame.title).isVisible());
      await archiveSearch.fill('');
      const stalledNotice='更新が止まっています。現在のライブ配信状況は確認できません。';
      await loadSnapshot({...fixture,generated_at:staleTime,last_success_at:staleTime,providers:{YouTube:{status:'partial'}},
        streams:fixture.streams.map(row=>({...row,fetched_at:staleTime}))},stalledNotice,8);
      assert.equal(await page.locator('#live').count(),0);
      assert.equal(await page.locator('#upcoming .card').count(),1);
      assert.equal(await page.locator('#archive .card').count(),7);
      await loadSnapshot(fixture,'',11);
      await loadSnapshot({...empty,generated_at:staleTime},stalledNotice);
      assert.match(await page.locator('#results').innerText(),/現在の配信件数は未確認/);
      await loadSnapshot({...empty,providers:{YouTube:{status:'not_configured'}}},'配信情報の更新に失敗しました。');
      assert.match(await page.locator('#updated').innerText(),/最終取得試行/);
      await loadSnapshot({...empty,checks:[{kind:'live',status:'partial'}]},'一部の配信元は確認範囲が限られています。');
      assert.match(await page.locator('#results').innerText(),/現在の配信件数は未確認/);
      await loadSnapshot({...empty,providers:{YouTube:{status:'partial'}},last_success_at:iso(-1000),
        checks:[{channel_id:active[0].record_id,kind:'live',status:'ok'},
          {channel_id:active[1].record_id,kind:'live',status:'partial'},
          {channel_id:active[2].record_id,kind:'live',status:'error'}]},
        '一部の配信情報を確認できませんでした。');
      assert.match(await page.locator('#updated').innerText(),/最終取得成功/);
      for(const [statuses,message] of [
        [['deferred'],'API制限により、一部の確認を見送りました。'],
        [['error','deferred'],'取得エラーが発生し、一部の確認を見送りました。']
      ]) {
        await loadSnapshot({...empty,providers:{YouTube:{status:'partial'}},
          checks:statuses.map(status=>({kind:'live',status}))},message);
      }
      await loadSnapshot({...empty,providers:{YouTube:{status:'error'}}},'配信情報の更新に失敗しました。');
      await loadSnapshot(empty,'');
      assert.match(await page.locator('#results').innerText(),/条件に該当する配信情報がありません/);
      assert.deepEqual(errors,[]);
      await page.close();
    }
    const analyticsPage=await browser.newPage();
    const analyticsRequests=[];
    let analyticsToken='';
    await analyticsPage.route('https://elrain1999.github.io/**',route=>{
      const pathname=new URL(route.request().url()).pathname;
      if(pathname.endsWith('/analytics-config.js')){
        return route.fulfill({contentType:'application/javascript',body:'window.CLOUDFLARE_WEB_ANALYTICS_TOKEN = '+JSON.stringify(analyticsToken)+';'});
      }
      return route.fulfill({path:path.join(root,'dist',pathname.endsWith('/analytics.js')?'analytics.js':'about.html')});
    });
    await analyticsPage.route('https://static.cloudflareinsights.com/**',route=>{
      analyticsRequests.push(route.request().url());
      return route.fulfill({contentType:'application/javascript',body:'window.testBeacon = document.currentScript.dataset.cfBeacon;'});
    });
    const productionAbout='https://elrain1999.github.io/gesen-live/about.html';
    await analyticsPage.goto(productionAbout);
    assert.ok(await analyticsPage.locator('#analytics-disabled').isVisible());
    assert.deepEqual(analyticsRequests,[]);
    analyticsToken='a'.repeat(32);
    await analyticsPage.reload();
    await analyticsPage.waitForFunction(()=>Boolean(window.testBeacon));
    assert.deepEqual(JSON.parse(await analyticsPage.evaluate(()=>window.testBeacon)),{token:analyticsToken});
    assert.deepEqual(analyticsRequests,['https://static.cloudflareinsights.com/beacon.min.js']);
    assert.ok(await analyticsPage.locator('#analytics-enabled').isVisible());
    assert.equal(await analyticsPage.locator('#analytics-disabled').isVisible(),false);
    await analyticsPage.goto('https://elrain1999.github.io/other-project/about.html');
    assert.ok(await analyticsPage.locator('#analytics-disabled').isVisible());
    assert.equal(analyticsRequests.length,1);
    await analyticsPage.close();
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
        await page.click('#about-link');
        const about=page.locator('#offline-about:visible');
        await about.waitFor();
        assert.equal(await about.getByText('配信元一覧',{exact:true}).count(),0);
        assert.ok(await about.locator('#analytics-disabled').isVisible());
        assert.equal(await about.locator('#analytics-enabled').isVisible(),false);
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
