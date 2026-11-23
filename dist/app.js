(() => {
  'use strict';
  const M = window.RetroRing;
  const byId = id => document.getElementById(id);
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const clock = new Intl.DateTimeFormat('ja-JP',{timeZone:'Asia/Tokyo',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
  const formatTime = value => Number.isFinite(Date.parse(value)) ? clock.format(new Date(value)) : '未取得';
  const labels = {live:'ライブ',upcoming:'予定',archive:'アーカイブ'};
  const states = new Set(Object.keys(labels));
  const games = new Set();
  const shortNames = {garousp:'ガロスペ',shinsam:'真サム',cvs2:'カプエス2',sf2:'ストリートファイターII系'};
  const snapshotPreview = window.RETRO_RING_OFFLINE_SNAPSHOT;
  let snapshot = snapshotPreview || {};
  let error = '';
  let registered;
  try { registered = M.activeChannels(M.channels(window.CHANNEL_DATA)); }
  catch { byId('fetch-status').textContent='配信元一覧を読み込めませんでした。'; return; }

  const gamePanel = byId('games');
  for (const [id,label] of [['','すべて'],...M.games]) {
    const button = document.createElement('button');
    button.textContent = shortNames[id] || label;
    button.dataset.game = id;
    gamePanel.append(button);
  }
  function toggle(selection, value) {
    if (selection.has(value)) selection.delete(value);
    else selection.add(value);
  }
  byId('states').addEventListener('click', event => {
    if (!event.target.matches('[data-state]')) return;
    toggle(states,event.target.dataset.state);
    render();
  });
  gamePanel.addEventListener('click', event => {
    if (!event.target.matches('[data-game]')) return;
    const game = event.target.dataset.game;
    if (game) toggle(games,game);
    else games.clear();
    render();
  });
  byId('games-toggle').onclick = event => {
    gamePanel.hidden = !gamePanel.hidden;
    event.currentTarget.setAttribute('aria-expanded', String(!gamePanel.hidden));
  };
  byId('sort').onchange = render;
  byId('results').addEventListener('error', event => {
    if(event.target.matches('img')) event.target.hidden=true;
  },true);
  function card(item) {
    const live = item.status === 'live';
    const image = M.safeUrl(item.thumbnail_url,'YouTube',true);
    const viewers = Number.isSafeInteger(item.concurrent_viewers) ? item.concurrent_viewers.toLocaleString('ja-JP')+'人' : '不明';
    const uncertain = item.stale || error || item.fetched_at !== snapshot.generated_at;
    const badge = labels[item.status]+(live && uncertain ? '・要再確認' : '');
    return '<a class="card '+item.status+'" data-video="'+escape(item.id)+'" href="'+escape(M.safeUrl(item.url,'YouTube'))+'" target="_blank" rel="noopener noreferrer"><div class="thumb"><small>画像なし</small>'+
      (image ? '<img src="'+escape(image)+'" loading="lazy" alt="" referrerpolicy="no-referrer">' : '')+'<span class="badge">'+badge+'</span></div><div class="body"><h3>'+escape(item.title)+'</h3>'+
      '<p class="meta">'+escape(item.channel.display_name)+' · YouTube</p><p class="meta">'+(item.status==='upcoming'?'配信予定：':'配信開始：')+formatTime(item.starts_at)+'</p>'+
      (live?'<p class="meta">同時視聴者数：'+viewers+'</p>':'')+'</div></a>';
  }
  function render() {
    for (const b of byId('states').children) b.setAttribute('aria-pressed',String(states.has(b.dataset.state)));
    for (const b of gamePanel.children) b.setAttribute('aria-pressed',String(b.dataset.game ? games.has(b.dataset.game) : !games.size));
    byId('games-toggle').textContent=games.size?'ゲーム選択（'+games.size+'）':'ゲーム選択';
    const now = Date.now();
    const provider = snapshot.providers?.YouTube?.status;
    const generated = Date.parse(snapshot.generated_at);
    const rows=M.streams(snapshot,registered,now).filter(s=>states.has(s.status) && (!games.size || games.has(s.game)));
    let notice = error;
    if (!notice) {
      if (!snapshot.schema_version) notice = '配信情報を読み込み中…';
      else if (provider === 'not_configured') notice = 'YouTube APIキーが未設定のため、配信情報は未取得です。';
      else if (provider !== 'ok') notice = '一部またはすべての配信情報を取得できていません。';
      else if (!Number.isFinite(generated) || generated > now + 300000) notice = '取得日時を確認できません。';
      else if (now - generated > 2 * 3600000) notice = '配信情報の更新が途絶えています。';
      else if (!rows.length && states.size && snapshot.checks?.some(check=>states.has(check.kind) && check.status!=='ok')) {
        notice = '一部の配信元は確認範囲が限られています。';
      }
    }
    const liveChecks=(snapshot.checks||[]).filter(check=>check.kind==='live'&&check.channel_id);
    if(states.has('live')&&liveChecks.length){
      const incomplete=liveChecks.filter(check=>check.status==='partial').length;
      const complete=liveChecks.filter(check=>check.status==='ok').length;
      const failed=liveChecks.length-complete-incomplete;
      if(incomplete||failed)notice+=(notice?' ':'')+'ライブ確認 '+complete+'／'+liveChecks.length+'件完了、'+incomplete+
        '件は一部確認、'+failed+'件は取得失敗・未確認。';
    }
    byId('fetch-status').textContent = notice;
    byId('updated').textContent = (snapshotPreview?'固定プレビュー · ':'')+
      (provider === 'ok' ? '最終更新 ' : '最終取得試行 ')+formatTime(snapshot.generated_at)+'（日本時間）'+
      (provider!=='ok'&&snapshot.last_success_at?' · 最終取得成功 '+formatTime(snapshot.last_success_at):'');
    const sort=byId('sort').value;
    const html=Object.entries(labels).filter(([state])=>states.has(state)).map(([state,label])=>{
      const items=rows.filter(row=>row.status===state).sort((a,b)=>{
        if(state==='live' && sort==='viewers'){
          const difference=(b.concurrent_viewers??-1)-(a.concurrent_viewers??-1);
          if(difference) return difference;
        }
        const difference=Date.parse(b.starts_at)-Date.parse(a.starts_at);
        return (state==='upcoming' && sort==='viewers' ? -difference : difference) || a.id.localeCompare(b.id);
      });
      if(!items.length)return '';
      return '<section id="'+state+'"><h2>'+label+'<small>'+items.length+'件</small></h2><div class="grid">'+items.map(card).join('')+'</div></section>';
    }).join('') || (notice && states.size ? '<p>現在の配信件数は未確認です。</p>' : '<p>条件に該当する配信情報がありません。</p>');
    const results=byId('results');
    if(html!==lastHtml){
      const focused=document.activeElement?.dataset.video;
      results.innerHTML=html;
      if(focused) Array.from(results.querySelectorAll('.card')).find(a=>a.dataset.video===focused)?.focus({preventScroll:true});
      lastHtml=html;
    }
  }
  let lastHtml='';
  render();
  if(snapshotPreview){
    const about=byId('offline-about');
    if(about){
      function navigate(){
        const show=location.hash==='#about';
        document.querySelector('main').hidden=show;about.hidden=!show;
        byId('about-link').hidden=show;
        document.title=(show?'このサイトについて | ':'')+'ゲーセン対戦台LIVE';
        if(show)about.focus();
      }
      window.addEventListener('hashchange',navigate);navigate();
    }
    setInterval(render,60000);
    return;
  }
  let pending=false;
  async function refresh(){
    if(pending)return;
    pending=true;
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),12000);
    try {
      const response=await fetch('streams.json',{signal:controller.signal,cache:'no-store'});
      if(!response.ok)throw Error();
      const data=await response.json();
      if(data?.schema_version!==1 || !Array.isArray(data.streams) || !Array.isArray(data.checks) || data.checks.some(c=>!c||typeof c!=='object'))throw Error();
      snapshot=data;error='';
    } catch {error='配信情報を読み込めませんでした。';}
    finally {clearTimeout(timer);pending=false;render();}
  }
  refresh();
  setInterval(()=>{if(!document.hidden)refresh();},300000);
  setInterval(render,60000);
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)refresh();});
})();
