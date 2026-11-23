(function(root, factory) {
  const api = factory();
  if (typeof module === 'object') module.exports = api;
  else root.RetroRing = api;
})(typeof globalThis === 'object' ? globalThis : this, function() {
  'use strict';
  const games = [
    ['garousp','餓狼伝説SPECIAL', /餓狼伝説\s*special|ガロスペ|fatal fury special/i],
    ['shinsam','真サムライスピリッツ', /真サムライ|真サム|samurai shodown\s*(?:ii|2)\b/i],
    ['third','ストリートファイターIII 3rd STRIKE', /3rd\s*strike|スト(?:リートファイター)?(?:III|3)(?:\s*3rd|サード)|ストIII|サード|\b3rd\b/i],
    ['cvs2','CAPCOM VS. SNK 2', /capcom\s*vs\.?\s*snk\s*2|カプエス\s*2|\bcvs\s*2\b/i],
    ['savior','ヴァンパイアセイヴァー', /ヴァンパイアセイヴァー|バンパイアセイバー|セイヴァー|vampire savior|darkstalkers\s*3/i],
    ['sf2','ストリートファイターIIシリーズ', /ストリートファイター(?:ii|Ⅱ)(?!i)|スパ(?:2|ii|Ⅱ)|スト(?:2|ii|Ⅱ)(?!i)|street fighter\s*ii(?!i)|super turbo|\bssf2x\b/i],
    ['hokuto','北斗の拳', /北斗の拳|hokuto no ken|fist of the north star/i]
  ];
  // The longer Real Bout title can contain the entire Fatal Fury Special alias.
  const realBoutTitle = /(?:(?:リアル[\s・-]*バウト|\breal[\s-]*bout\b)(?:[\s・-]*special)?|\brb(?:sp|[\s・-]*special)?\b)[\s・:()\[\]【】-]*(?:餓狼伝説\s*(?:special|スペシャル)|fatal\s+fury\s+special|ガロスペ)/gi;
  const classify = title => {
    const normalized = String(title || '').normalize('NFKC');
    const fatalFury = normalized.replace(realBoutTitle, ' ');
    const hits = games.filter(([id,,pattern]) => pattern.test(id === 'garousp' ? fatalFury : normalized));
    return hits.length === 1 ? hits[0][0] : 'unknown';
  };
  function safeUrl(value, platform, image=false) {
    try {
      const u = new URL(value);
      const hosts = image ? ['i.ytimg.com','static-cdn.jtvnw.net'] : platform === 'YouTube' ? ['www.youtube.com','youtube.com','youtu.be'] : ['www.twitch.tv','twitch.tv'];
      return u.protocol === 'https:' && !u.username && !u.password && hosts.includes(u.hostname) ? u.href : null;
    } catch { return null; }
  }
  function channels(input) {
    if (input?.schema_version !== 1 || !Array.isArray(input.channels)) throw new Error('チャンネル台帳の形式が不正です');
    const seen = new Set();
    return input.channels.filter(c => {
      if (!c || c.status !== 'approved_candidate' || !['YouTube','Twitch'].includes(c.platform) || typeof c.record_id !== 'string' || !c.record_id || seen.has(c.record_id) || !safeUrl(c.channel_url,c.platform)) return false;
      seen.add(c.record_id); return true;
    });
  }
  const liveMaxAge = 65 * 60000; // Hourly collection plus a short publishing grace period.
  function streams(snapshot, registered, now=Date.now(), {keepUnconfirmedLive=false}={}) {
    const byId = new Map(registered.map(c => [c.record_id,c]));
    const seen = new Set();
    return (Array.isArray(snapshot?.streams) ? snapshot.streams : []).filter(s => {
      const c = byId.get(s?.channel_id);
      const key = `${c?.platform}:${s?.id}`;
      if (!c || typeof s.id !== 'string' || !s.id || seen.has(key) || !['live','upcoming','archive'].includes(s.status) || !safeUrl(s.url,c.platform) || typeof s.title !== 'string' || !Number.isFinite(Date.parse(s.starts_at)) || !Number.isFinite(Date.parse(s.fetched_at))) return false;
      if (now-Date.parse(s.fetched_at)>86400000 || Date.parse(s.fetched_at)>now+300000) return false;
      if (s.status==='archive' && now-Date.parse(s.starts_at)>30*86400000) return false;
      if (s.status==='live' && !keepUnconfirmedLive && now-Date.parse(s.fetched_at)>=liveMaxAge) return false;
      if (s.status==='upcoming' && Date.parse(s.ends_at || s.starts_at)<now) return false;
      seen.add(key); return true;
    }).map(s => ({...s, game: classify(s.title), stale: now-Date.parse(s.fetched_at)>3600000, channel:byId.get(s.channel_id)}));
  }
  function matches(channel, game, platform, query) {
    return (!platform || channel.platform === platform) && (!query || [channel.display_name,...(channel.venues||[]),...(channel.events||[])].join(' ').normalize('NFKC').toLowerCase().includes(query.normalize('NFKC').toLowerCase())) &&
      (!game || (game==='other' ? (channel.games||[]).some(g=>classify(g.title)==='unknown') : (channel.games||[]).some(g=>classify(g.title)===game)));
  }
  const activeChannels = registered => registered.filter(c=>c.platform==='YouTube');
  return {games,classify,safeUrl,channels,streams,matches,activeChannels,liveMaxAge};
});
