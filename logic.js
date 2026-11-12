/* HO’s Hunt — rules for real-world hide and seek (pure logic: no DOM, no network; also loaded by Node tests).
 *
 * One room = one state document. Every phone changes it with a transaction (no single "host device" has to
 * stay awake), and each phone writes its own GPS position to its own document.
 * Roles: 'S' = seeker side (술래 / 좀비 / 경찰), 'H' = hider side (숨는 사람 / 생존자 / 도둑).
 * Times are server-clock milliseconds; settings durations are in seconds. */
(function (root) {
  'use strict';
  const MODES = {
    classic: { name: '클래식', icon: '🛡️', S: '술래', H: '숨는 사람', desc: '술래와 숨는 사람이 끝까지 그대로. 잡히면 탈락이에요.' },
    zombie: { name: '좀비', icon: '🧟', S: '좀비', H: '생존자', desc: '잡히면 좀비가 되어 같이 쫓아요. 끝까지 살아남으면 승리!' },
    cops: { name: '경찰과 도둑', icon: '🚓', S: '경찰', H: '도둑', desc: '잡힌 도둑은 감옥(자기장 중심)에 갇혀요. 다른 도둑이 감옥에 오면 모두 탈출!' },
  };
  const DEF = { mode: 'classic', seekers: 1, dur: 900, radius: 800, stages: 3, reveal: 120, catchR: 15, hide: 120 };
  const LIM = { seekers: [1, 10], dur: [10, 7200], radius: [50, 5000], stages: [0, 6], reveal: [5, 1800], catchR: [3, 100], hide: [0, 1800] };
  const COLORS = ['#ff4d5e', '#2ef59a', '#ffcc33', '#4da3ff', '#ff7ae0', '#ff9a3d', '#9b7bff', '#3de0e0', '#c6ff4d', '#ff6f91'];
  const PING_COOLDOWN = 60000;
  const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

  // ---- geometry (metres) ----
  const RAD = Math.PI / 180, EARTH = 6371000;
  function dist(a, b) {
    if (!a || !b) return Infinity;
    const dLat = (b.lat - a.lat) * RAD, dLng = (b.lng - a.lng) * RAD;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin(dLng / 2) ** 2;
    return 2 * EARTH * Math.asin(Math.min(1, Math.sqrt(h)));
  }
  function dest(c, m, deg) {
    const d = m / EARTH, b = deg * RAD, la = c.lat * RAD, lo = c.lng * RAD;
    const la2 = Math.asin(Math.sin(la) * Math.cos(d) + Math.cos(la) * Math.sin(d) * Math.cos(b));
    const lo2 = lo + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(la), Math.cos(d) - Math.sin(la) * Math.sin(la2));
    return { lat: la2 / RAD, lng: lo2 / RAD };
  }
  const okPoint = p => !!p && Number.isFinite(p.lat) && Number.isFinite(p.lng) && Math.abs(p.lat) <= 90 && Math.abs(p.lng) <= 180;

  // ---- room ----
  function newRoom(uid, name, now) {
    return { v: 1, app: 'hunt', host: uid, phase: 'lobby', made: now, round: 0, set: Object.assign({}, DEF), center: null,
      players: { [uid]: { n: name, c: 0, j: now } }, log: [] };
  }
  const ids = st => Object.keys(st.players).sort((a, b) => st.players[a].j - st.players[b].j || (a < b ? -1 : 1));
  const cleanName = s => String(s || '').replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, '').trim().slice(0, 12);
  function join(st, uid, name, now) {
    name = cleanName(name);
    if (!name) return '닉네임을 입력해 주세요';
    if (st.players[uid]) { st.players[uid].n = name; return true; }
    if (st.phase !== 'lobby') return '이미 게임이 시작됐어요. 끝나면 들어올 수 있어요';
    if (ids(st).length >= 20) return '방이 꽉 찼어요 (20명)';
    const used = new Set(ids(st).map(u => st.players[u].c));
    let c = 0; while (used.has(c) && c < COLORS.length - 1) c++;
    st.players[uid] = { n: name, c, j: now };
    return true;
  }
  function settings(st, uid, patch) {
    if (st.host !== uid) return '방장만 바꿀 수 있어요';
    if (st.phase !== 'lobby') return '게임 중에는 바꿀 수 없어요';
    for (const k of Object.keys(patch || {})) {
      if (k === 'mode') { if (typeof patch.mode === 'string' && has(MODES, patch.mode)) st.set.mode = patch.mode; }
      else if (has(LIM, k) && Number.isFinite(Number(patch[k]))) st.set[k] = Math.round(clamp(Number(patch[k]), LIM[k][0], LIM[k][1]));
    }
    return true;
  }
  function setCenter(st, uid, c) {
    if (st.host !== uid || st.phase !== 'lobby') return '방장만 정할 수 있어요';
    st.center = c && okPoint(c) ? { lat: c.lat, lng: c.lng } : null;
    return true;
  }
  function setFixed(st, uid, target, on) {
    if (st.host !== uid || st.phase !== 'lobby') return '방장만 정할 수 있어요';
    const p = st.players[target]; if (!p) return '없는 사람이에요';
    if (on) p.fix = 1; else delete p.fix;
    return true;
  }
  function takeHost(st, uid) { if (!st.players[uid]) return '방에 들어와 있어야 해요'; st.host = uid; return true; }

  function start(st, uid, now, center, rnd) {
    if (st.host !== uid) return '방장만 시작할 수 있어요';
    if (st.phase !== 'lobby') return '이미 시작했어요';
    const list = ids(st);
    if (list.length < 2) return '2명 이상 있어야 시작할 수 있어요';
    const c = st.center || center;
    if (!okPoint(c)) return '자기장 중심을 정할 위치가 필요해요 (위치 권한을 허용하거나 지도를 눌러 주세요)';
    rnd = rnd || Math.random;
    const want = clamp(st.set.seekers, 1, list.length - 1);
    const S = list.filter(u => st.players[u].fix).slice(0, list.length - 1);
    const rest = list.filter(u => !S.includes(u));
    for (let k = rest.length - 1; k > 0; k--) { const j = Math.floor(rnd() * (k + 1)); const x = rest[k]; rest[k] = rest[j]; rest[j] = x; }
    while (S.length < want) S.push(rest.shift());
    for (const u of list) {
      const p = st.players[u];
      p.role = S.includes(u) ? 'S' : 'H'; p.orig = p.role; p.out = 0;
      delete p.by; delete p.at; delete p.left;
    }
    st.phase = 'run'; st.t0 = now; st.center = { lat: c.lat, lng: c.lng }; st.round = (st.round || 0) + 1;
    st.pings = { k: 0, at: 0, locs: {} }; st.manual = {}; st.cool = {}; st.catches = {}; st.rescues = {}; st.end = null;
    st.log = [{ at: now, k: 'start' }];
    return true;
  }

  // ---- timeline ----
  const hideEnd = st => st.t0 + st.set.hide * 1000;
  const endAt = st => hideEnd(st) + st.set.dur * 1000;
  function phase(st, now) {
    if (st.phase !== 'run') return st.phase;
    return now < hideEnd(st) ? 'hide' : now < endAt(st) ? 'play' : 'ending';
  }
  // 자기장: shrinks `stages` times, evenly over the game, from `radius` down to a quarter of it (centre fixed)
  function zone(st, now) {
    const n = st.set.stages, R0 = st.set.radius, rad = i => (n ? R0 - R0 * 0.75 * i / n : R0);
    if (st.phase !== 'run') return { r: R0, i: 0, n, next: null, nr: null };
    const h = hideEnd(st), D = st.set.dur * 1000, at = k => h + D * k / (n + 1);
    let i = 0;
    while (i < n && now >= at(i + 1)) i++;
    return { r: rad(i), i, n, next: i < n ? at(i + 1) : null, nr: i < n ? rad(i + 1) : null };
  }
  // seekers get everyone's position every `reveal` seconds after hiding time
  function revealK(st, now) {
    if (st.phase !== 'run' || now < hideEnd(st)) return 0;
    return Math.floor((Math.min(now, endAt(st)) - hideEnd(st)) / (st.set.reveal * 1000));
  }
  const nextReveal = (st, now) => hideEnd(st) + (revealK(st, now) + 1) * st.set.reveal * 1000;

  // ---- play ----
  const live = p => !!p && !p.left;
  const hiders = st => ids(st).filter(u => st.players[u].role === 'H' && live(st.players[u]));
  const freeHiders = st => hiders(st).filter(u => !st.players[u].out);
  const seekers = st => ids(st).filter(u => st.players[u].role === 'S' && live(st.players[u]));
  function over(st, at, win, why) { st.phase = 'over'; st.end = { at, win, why }; st.log.push({ at, k: 'over', win, why }); }
  function check(st, now) {
    if (st.phase !== 'run') return;
    if (!freeHiders(st).length) over(st, now, 'S', 'all');
    else if (!seekers(st).length) over(st, now, 'H', 'noseeker');
  }
  function doCatch(st, actor, target, now, self) {
    if (phase(st, now) !== 'play') return '지금은 잡을 수 없어요';
    const a = st.players[actor], b = st.players[target];
    if (!live(a) || a.role !== 'S') return '잡을 수 있는 역할이 아니에요';
    if (!live(b) || b.role !== 'H' || b.out) return '이미 잡혔거나 잡을 수 없는 사람이에요';
    st.catches[actor] = (st.catches[actor] || 0) + 1;
    b.by = actor; b.at = now;
    if (st.set.mode === 'zombie') b.role = 'S'; else b.out = 1;
    st.log.push({ at: now, k: 'catch', a: actor, b: target, self: self ? 1 : 0 });
    check(st, now);
    return true;
  }
  // 경찰과 도둑: a free robber reaching the jail frees everyone in it
  function rescue(st, actor, now) {
    if (st.set.mode !== 'cops' || phase(st, now) !== 'play') return '지금은 구출할 수 없어요';
    const a = st.players[actor];
    if (!live(a) || a.role !== 'H' || a.out) return '갇히지 않은 도둑만 구출할 수 있어요';
    const jailed = hiders(st).filter(u => st.players[u].out);
    if (!jailed.length) return '감옥이 비어 있어요';
    for (const u of jailed) { st.players[u].out = 0; delete st.players[u].by; }
    st.rescues[actor] = (st.rescues[actor] || 0) + jailed.length;
    st.log.push({ at: now, k: 'rescue', a: actor, n: jailed.length });
    return true;
  }
  function ping(st, k, locs) {
    if (st.phase !== 'run' || !(k > (st.pings.k || 0))) return '이미 공개됐어요';
    const clean = {};
    for (const u of Object.keys(locs || {})) { const p = locs[u]; if (st.players[u] && okPoint(p)) clean[u] = { lat: p.lat, lng: p.lng, at: p.at || 0 }; }
    st.pings = { k, at: hideEnd(st) + k * st.set.reveal * 1000, locs: clean };
    return true;
  }
  function manualPing(st, actor, target, loc, now) {
    if (phase(st, now) !== 'play') return '지금은 위치를 확인할 수 없어요';
    const a = st.players[actor], b = st.players[target];
    if (!live(a) || a.role !== 'S' || !live(b) || b.role !== 'H' || b.out) return '확인할 수 없는 사람이에요';
    if (now - (st.cool[actor] || 0) < PING_COOLDOWN) return '조금 뒤에 다시 쓸 수 있어요';
    if (!okPoint(loc)) return '그 사람 위치 신호가 없어요';
    st.manual[target] = { lat: loc.lat, lng: loc.lng, at: now, by: actor };
    st.cool[actor] = now;
    st.log.push({ at: now, k: 'ping', a: actor, b: target });
    return true;
  }
  function finish(st, now) {
    if (st.phase !== 'run' || now < endAt(st)) return '아직 시간이 남았어요';
    over(st, endAt(st), freeHiders(st).length ? 'H' : 'S', 'time');
    return true;
  }
  function leave(st, uid, now) {
    const p = st.players[uid]; if (!p) return true;
    if (st.phase === 'run') { p.left = 1; st.log.push({ at: now, k: 'left', a: uid }); check(st, now); }
    else delete st.players[uid];
    if (st.host === uid) { const next = ids(st).find(u => !st.players[u].left); if (next) st.host = next; }
    return true;
  }
  function reset(st, uid) {
    if (st.host !== uid) return '방장만 다시 시작할 수 있어요';
    if (st.phase !== 'over') return '게임이 끝나야 해요';
    for (const u of ids(st)) {
      const p = st.players[u];
      if (p.left) { delete st.players[u]; continue; }
      delete p.role; delete p.orig; delete p.out; delete p.by; delete p.at;
    }
    st.phase = 'lobby'; st.end = null; st.pings = null; st.manual = {}; st.cool = {};
    return true;
  }
  // who earned what, for the result screen
  function summary(st) {
    const list = ids(st).map(u => ({ u, p: st.players[u] }));
    const sk = list.filter(x => x.p.orig === 'S').map(x => ({ u: x.u, n: x.p.n, c: (st.catches || {})[x.u] || 0 }));
    const zb = list.filter(x => x.p.orig === 'H' && x.p.role === 'S').map(x => ({ u: x.u, n: x.p.n, c: (st.catches || {})[x.u] || 0 }));
    const hd = list.filter(x => x.p.orig === 'H').map(x => ({ u: x.u, n: x.p.n, caught: !!x.p.by && (x.p.out || x.p.role === 'S'), left: !!x.p.left, r: (st.rescues || {})[x.u] || 0 }));
    const best = Math.max(0, ...sk.concat(zb).map(x => x.c));
    for (const x of sk.concat(zb)) x.mvp = best > 0 && x.c === best;
    const caughtN = list.filter(x => x.p.orig === 'H' && x.p.by && (x.p.out || x.p.role === 'S')).length;
    return { seekers: sk.concat(zb), hiders: hd, caught: caughtN, total: hd.length, dur: st.end ? Math.max(0, st.end.at - hideEnd(st)) : 0 };
  }
  const label = (st, role) => MODES[(st && st.set && st.set.mode) || 'classic'][role];

  const api = { MODES, DEF, LIM, COLORS, PING_COOLDOWN, dist, dest, okPoint, newRoom, ids, join, settings, setCenter, setFixed, takeHost,
    start, hideEnd, endAt, phase, zone, revealK, nextReveal, hiders, freeHiders, seekers, doCatch, rescue, ping, manualPing, finish, leave, reset, summary, label, cleanName };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.HuntLogic = api;
})(typeof window !== 'undefined' ? window : globalThis);
