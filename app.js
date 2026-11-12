/* Man Hunt — the web app: Firebase sync, GPS, map and screens. Rules live in logic.js.
 *
 * Realtime Database layout (same rules as HO’s Casino, so nothing to change in the console):
 *   rooms/HZ<CODE>/table       {j: JSON(state), t}   the game; every phone changes it with a transaction
 *   rooms/HZ<CODE>/req/<uid>   {j: JSON({lat, lng, acc, at, d, r}), t}   each phone's own GPS position
 * The 6-letter code people see is CODE; "HZ" keeps these rooms apart from the casino's. */
(function () {
  'use strict';
  const L = window.HuntLogic, LF = window.L;
  const VERSION = '12.19.0', SDK = 'https://www.gstatic.com/firebasejs/' + VERSION + '/';
  const CODE_CH = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const SIM = /[?&]sim\b/.test(location.search);
  const FRESH = 45000;
  const $ = s => document.querySelector(s);
  function el(tag, cls, txt) { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; }
  const LS = {
    get(k) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : null; } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* no storage */ } },
  };
  function sess(k, v) { try { if (v === undefined) return sessionStorage.getItem(k); if (v === null) sessionStorage.removeItem(k); else sessionStorage.setItem(k, v); } catch (e) { return null; } return v; }
  let toastT = 0;
  function toast(t, bad) { const x = $('#toast'); x.textContent = t; x.className = 'toast' + (bad ? ' bad' : ''); x.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => { x.hidden = true; }, 3200); }
  function vib(p) { try { if (navigator.vibrate) navigator.vibrate(p); } catch (e) { /* ignore */ } }
  const mmss = ms => { const s = Math.max(0, Math.ceil(ms / 1000)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
  const meters = m => (m >= 1000 ? (m / 1000).toFixed(1) + ' km' : Math.round(m) + ' m');
  const secTxt = s => (s < 60 ? s + '초' : s % 60 ? `${Math.floor(s / 60)}분 ${s % 60}초` : s / 60 + '분');
  const ago = ms => (ms < 60000 ? '방금' : Math.floor(ms / 60000) + '분 전');

  /* ---------- state ---------- */
  let F = null, db = null, uid = null, offset = 0;
  let code = null, base = null, st = null, loaded = false, locs = {};
  let me = null, gpsErr = '', lastUp = 0, upAt = null, myDist = 0, distRound = -1, distLast = null;
  let busy = false, creating = false, lastLog = -1, logRound = -1, lastPingK = -1, lastZoneI = -1, lastScreen = '', outside = false, wake = null;
  const srvNow = () => Date.now() + offset;
  const amHost = () => !!st && st.host === uid;
  const mine = () => (st && uid ? st.players[uid] : null);
  const playerColor = u => L.COLORS[((st.players[u] || {}).c || 0) % L.COLORS.length];
  const nameOf = u => (st && st.players[u] ? st.players[u].n : '?');
  const locOf = u => (u === uid ? me : locs[u] || null);
  const fresh = p => !!p && srvNow() - (p.at || 0) < FRESH;

  /* ---------- firebase ---------- */
  async function connect() {
    const c = window.FIREBASE_CONFIG;
    if (!c || !c.apiKey || !c.databaseURL) throw new Error('config');
    const [appM, authM, dbM] = await Promise.all([import(SDK + 'firebase-app.js'), import(SDK + 'firebase-auth.js'), import(SDK + 'firebase-database.js')]);
    const app = appM.initializeApp(c);
    const auth = authM.getAuth(app);
    db = dbM.getDatabase(app);
    if (c.emulator) { authM.connectAuthEmulator(auth, c.emulator.auth, { disableWarnings: true }); dbM.connectDatabaseEmulator(db, c.emulator.dbHost, c.emulator.dbPort); }
    F = dbM;
    await auth.authStateReady();
    if (!auth.currentUser) await authM.signInAnonymously(auth);
    uid = auth.currentUser.uid;
    F.onValue(F.ref(db, '.info/serverTimeOffset'), s => { offset = Number(s.val()) || 0; });
  }
  const parse = s => { try { return JSON.parse(s); } catch (e) { return null; } };
  function subscribe() {
    F.onValue(F.ref(db, base + '/table'), s => { const v = s.val(); st = v && typeof v.j === 'string' ? parse(v.j) : null; if (st && st.app !== 'hunt') st = null; loaded = true; onState(); },
      e => fatal(/permission/i.test(String(e && e.message)) ? '데이터베이스 규칙이 막고 있어요' : '서버 연결이 끊겼어요'));
    F.onValue(F.ref(db, base + '/req'), s => {
      const next = {};
      s.forEach(ch => { const v = ch.val(); const d = v && typeof v.j === 'string' ? parse(v.j) : null; if (d && L.okPoint(d)) next[ch.key] = d; });
      locs = next; render();
    });
  }
  // change the room with a transaction; fn(state) returns the new state or an error message
  async function mutate(fn, quiet) {
    let err = null;
    try {
      const r = await F.runTransaction(F.ref(db, base + '/table'), cur => {
        err = null;
        const s0 = cur && typeof cur.j === 'string' ? parse(cur.j) : null;
        const out = fn(s0, srvNow());
        if (typeof out === 'string') { err = out; return undefined; }
        return { j: JSON.stringify(out), t: srvNow() };
      }, { applyLocally: true });
      if (!r.committed && err && !quiet) toast(err, true);
      return r.committed;
    } catch (e) { if (!quiet) toast('서버에 저장하지 못했어요. 인터넷을 확인해 주세요', true); return false; }
  }
  function act(name, ...args) {
    return mutate((s, now) => {
      if (!s) return '방을 찾을 수 없어요';
      const r = L[name](s, ...args.map(a => (a === NOW ? now : a)));
      return r === true ? s : r;
    }, name === 'ping' || name === 'finish');
  }
  const NOW = {};

  /* ---------- GPS ---------- */
  function onFix(lat, lng, acc) {
    const p = { lat, lng, acc: Math.round(acc || 0), at: srvNow() };
    const ph = st ? L.phase(st, srvNow()) : 'lobby';
    if (st && st.round !== distRound) { const saved = LS.get('mh_dist_' + code); distRound = st.round; myDist = saved && saved.r === st.round ? saved.d : 0; distLast = null; }
    if ((ph === 'hide' || ph === 'play') && p.acc < 35) {
      if (!distLast) distLast = p;
      else { const d = L.dist(distLast, p); if (d >= Math.max(6, p.acc * 0.5)) { myDist += d; distLast = p; LS.set('mh_dist_' + code, { r: st.round, d: myDist }); } }
    }
    const moved = !me || L.dist(me, p) > 4;
    me = p; gpsErr = '';
    upload(moved);
    render();
  }
  function startGps() {
    if (SIM) { const s = LS.get('mh_sim'); if (s) onFix(s.lat, s.lng, 5); return; }
    if (!navigator.geolocation) { gpsErr = '이 브라우저는 위치를 지원하지 않아요'; return; }
    navigator.geolocation.watchPosition(
      pos => onFix(pos.coords.latitude, pos.coords.longitude, pos.coords.accuracy),
      e => { gpsErr = e.code === 1 ? '위치 권한이 꺼져 있어요. 브라우저 설정에서 허용해 주세요' : '위치를 찾는 중이에요…'; render(); },
      { enableHighAccuracy: true, maximumAge: 2000, timeout: 20000 });
  }
  function simMove(lat, lng) { LS.set('mh_sim', { lat, lng }); onFix(lat, lng, 5); }
  function upload(force) {
    if (!me || !base || !uid || !st || !st.players[uid]) return;
    const t = Date.now();
    if (!force && t - lastUp < 15000) return;
    if (t - lastUp < 2000) { if (!upAt) upAt = setTimeout(() => { upAt = null; upload(true); }, 2000 - (t - lastUp)); return; }
    lastUp = t;
    const d = { lat: +me.lat.toFixed(6), lng: +me.lng.toFixed(6), acc: me.acc, at: srvNow(), d: Math.round(myDist), r: st.round || 0 };
    F.set(F.ref(db, base + '/req/' + uid), { j: JSON.stringify(d), t: F.serverTimestamp() }).catch(() => {});
  }
  async function keepAwake() {
    try { if ('wakeLock' in navigator && !wake && document.visibilityState === 'visible') { wake = await navigator.wakeLock.request('screen'); wake.addEventListener('release', () => { wake = null; }); } } catch (e) { /* not allowed */ }
  }

  /* ---------- screens ---------- */
  function show(id) {
    ['home', 'join', 'lobby', 'game', 'result'].forEach(x => { $('#' + x).hidden = x !== id; });
    if (id !== lastScreen) {
      lastScreen = id;
      if (id === 'game') { setTimeout(() => { gameMap().invalidateSize(); fitZone(); }, 50); keepAwake(); }
      if (id === 'lobby') setTimeout(() => { if (mini) mini.invalidateSize(); }, 50);
    }
  }
  function fatal(msg) { $('#boot').hidden = false; $('#boot').textContent = msg; }

  function render() {
    if (!code) return;
    if (!loaded) return;
    $('#boot').hidden = true;
    if (!st) { renderJoin('방을 찾을 수 없어요. 코드를 다시 확인해 주세요.', false); return; }
    const p = mine();
    if (!p) { renderJoin(st.phase === 'lobby' ? `${L.ids(st).length}명이 기다리고 있어요` : '지금 게임 중이에요. 끝나면 들어올 수 있어요', st.phase === 'lobby'); return; }
    if (p.left && st.phase === 'run') { renderJoin('게임에서 나왔어요. 끝나면 다시 들어올 수 있어요', false); return; }
    if (st.phase === 'lobby') renderLobby();
    else if (st.phase === 'run') renderGame();
    else renderResult();
  }
  function onState() {
    if (st && st.log) {
      if (lastLog < 0) { lastLog = st.log.length; logRound = st.round; }
      else {
        if (st.round !== logRound || lastLog > st.log.length) { lastLog = 0; logRound = st.round; }
        for (let k = lastLog; k < st.log.length; k++) logEvent(st.log[k]);
        lastLog = st.log.length;
      }
    }
    if (st && sess('mh_create') && st.players[uid]) sess('mh_create', null);
    if (!st && sess('mh_create') && !creating) {
      creating = true;
      const nm = sess('mh_create');
      mutate((s, now) => (s ? '이미 있는 코드예요' : L.newRoom(uid, nm, now))).then(ok => { sess('mh_create', null); if (!ok) { toast('방을 만들지 못했어요. 다시 해 주세요', true); location.hash = ''; } });
    }
    if (me) upload(true);
    render();
  }
  function logEvent(e) {
    const p = mine(); if (!p || !st) return;
    const SL = L.label(st, 'S'), HL = L.label(st, 'H');
    if (e.k === 'start') { lastPingK = 0; panelOpen = false; toast(p.role === 'S' ? `${SL}예요! 숨는 시간 동안 기다려요` : `숨으세요! ${secTxt(st.set.hide)} 뒤에 ${SL}가 출발해요`); vib(200); }
    else if (e.k === 'catch') {
      if (e.b === uid) { toast(st.set.mode === 'zombie' ? '잡혔어요! 이제 좀비예요 🧟 같이 쫓아요' : st.set.mode === 'cops' ? '잡혔어요! 감옥으로 가요 🔒' : '잡혔어요! 이제 관전해요', true); vib([300, 100, 300]); }
      else if (e.a === uid) { toast(`잡았다! 🎯 ${nameOf(e.b)}`); vib(150); }
      else toast(`${nameOf(e.a)} 님이 ${nameOf(e.b)} 님을 잡았어요`);
    } else if (e.k === 'rescue') { toast(`🔓 ${nameOf(e.a)} 님이 감옥을 열었어요! ${e.n}명 탈출`); vib(200); }
    else if (e.k === 'ping' && e.b === uid) { toast(`👀 ${SL}가 내 위치를 확인했어요`, true); vib(120); }
    else if (e.k === 'left' && e.a !== uid) toast(`${nameOf(e.a)} 님이 나갔어요`);
    else if (e.k === 'over') vib([200, 100, 200, 100, 400]);
    void HL;
  }

  /* home & join */
  function renderHome() {
    $('#boot').hidden = true;
    show('home');
    const n = $('#nameIn'); n.value = LS.get('mh_name') || '';
    $('#createBtn').onclick = () => {
      const nm = L.cleanName(n.value); if (!nm) { toast('닉네임을 입력해 주세요', true); n.focus(); return; }
      LS.set('mh_name', nm);
      const c = Array.from({ length: 6 }, () => CODE_CH[Math.floor(Math.random() * CODE_CH.length)]).join('');
      sess('mh_create', nm); location.hash = c;
    };
    const go = () => { const c = normCode($('#codeIn').value); if (!c) { toast('코드는 영문·숫자 6자예요', true); return; } const nm = L.cleanName(n.value); if (nm) LS.set('mh_name', nm); location.hash = c; };
    $('#joinBtn').onclick = go;
    $('#codeIn').onkeydown = e => { if (e.key === 'Enter') go(); };
  }
  function renderJoin(info, canJoin) {
    show('join');
    $('#joinCode').textContent = code;
    $('#joinInfo').textContent = info;
    const n = $('#joinName');
    if (!n.value) n.value = LS.get('mh_name') || '';
    n.hidden = !canJoin; $('#joinGo').hidden = !canJoin;
    n.previousElementSibling.hidden = !canJoin;
    $('#joinGo').onclick = () => {
      const nm = L.cleanName(n.value); if (!nm) { toast('닉네임을 입력해 주세요', true); return; }
      LS.set('mh_name', nm); act('join', uid, nm, NOW);
    };
    $('#joinHome').onclick = () => { location.hash = ''; };
  }

  /* lobby */
  let mini = null, miniCircle = null, miniMe = null;
  const SLIDERS = [
    { k: 'seekers', name: st => `SEEKERS · ${L.label(st, 'S')} 수`, min: 1, max: st => Math.max(1, Math.min(5, L.ids(st).length - 1)), step: 1, f: v => v + '명' },
    { k: 'dur', name: () => 'GAME DURATION · 게임 시간', min: 5, max: 60, step: 5, unit: 60, f: secTxt },
    { k: 'radius', name: () => 'START ZONE RADIUS · 자기장 반경', min: 100, max: 3000, step: 50, f: v => v + 'm' },
    { k: 'stages', name: () => 'ZONE SHRINKS · 자기장 줄어드는 횟수', min: 0, max: 5, step: 1, f: v => (v ? v + '번' : '안 줄어요'), note: '게임 시간 동안 고르게 줄어서 마지막엔 처음의 1/4 크기가 돼요' },
    { k: 'reveal', name: () => 'REVEAL INTERVAL · 위치 공개 간격', min: 1, max: 10, step: 1, unit: 60, f: secTxt, note: '이 간격마다 술래 편이 숨은 사람들 위치를 받아요' },
    { k: 'catchR', name: () => 'CATCH RADIUS · 잡기 거리', min: 5, max: 50, step: 5, f: v => v + 'm', note: '이 거리 안에 들어가면 잡기 버튼이 켜져요 (GPS 오차가 10m쯤 있어요)' },
    { k: 'hide', name: () => 'HIDE TIME · 숨는 시간', min: 1, max: 10, step: 1, unit: 60, f: secTxt },
  ];
  let lobbySig = '';
  function renderLobby() {
    show('lobby');
    const host = amHost(), list = L.ids(st), now = srvNow();
    const gps = $('#lobbyGps');
    gps.textContent = me ? `📍 ±${me.acc}m` : gpsErr ? '위치 꺼짐' : '위치 찾는 중';
    gps.className = 'gps ' + (me ? 'ok' : gpsErr ? 'bad' : '');
    if (gpsErr && !me) gps.title = gpsErr;
    $('#lobbyCode').textContent = code;
    $('#pCount').textContent = list.length + '명';
    $('#hostNote').textContent = host ? '내가 방장 · 설정을 바꿀 수 있어요' : `방장 ${nameOf(st.host)}`;
    const ul = $('#players'); ul.textContent = '';
    for (const u of list) {
      const p = st.players[u], li = el('li'), av = el('i', 'av');
      av.style.background = playerColor(u); av.style.color = playerColor(u);
      const nm = el('span', 'nm', p.n + (u === st.host ? ' 👑' : ''));
      if (u === uid) nm.append(el('span', 'me', ' (나)'));
      li.append(av, nm);
      const lo = locOf(u);
      li.append(el('span', 'sig' + (fresh(lo) ? ' ok' : ''), fresh(lo) ? '● GPS' : 'GPS 없음'));
      if (host) { const b = el('button', 'chip' + (p.fix ? ' on' : ''), p.fix ? `${L.label(st, 'S')} ✓` : `${L.label(st, 'S')} 지정`); b.onclick = () => act('setFixed', uid, u, !p.fix); li.append(b); }
      else if (p.fix) li.append(el('span', 'chip on', `${L.label(st, 'S')} 지정`));
      ul.append(li);
    }
    const hl = locs[st.host];
    $('#takeHost').hidden = host || !(now - (st.made || 0) > 120000 && (!hl || now - hl.at > 120000));
    $('#takeHost').onclick = () => act('takeHost', uid);
    $('#setNote').textContent = host ? '' : '방장만 바꿀 수 있어요';
    // settings: rebuild only when they change, so a slider being dragged is not replaced
    const sig = JSON.stringify([st.set, host, list.length]);
    if (sig !== lobbySig) {
      lobbySig = sig;
      const modes = $('#modes'); modes.textContent = '';
      for (const k of Object.keys(L.MODES)) {
        const m = L.MODES[k], b = el('button', 'mode' + (st.set.mode === k ? ' on' : ''));
        b.append(el('i', null, m.icon), el('b', null, m.name), el('small', null, m.desc));
        b.disabled = !host; b.onclick = () => act('settings', uid, { mode: k });
        modes.append(b);
      }
      const box = $('#sliders'); box.textContent = '';
      for (const d of SLIDERS) {
        const unit = d.unit || 1, max = typeof d.max === 'function' ? d.max(st) : d.max, raw = st.set[d.k];
        const wrap = el('div', 'sl'), top = el('div', 'top'), val = el('b', null, d.f(raw));
        top.append(el('span', null, d.name(st)), val);
        const r = el('input'); r.type = 'range'; r.min = d.min; r.max = max; r.step = d.step;
        r.value = Math.min(max, Math.max(d.min, Math.round(raw / unit)));
        r.disabled = !host; r.setAttribute('aria-label', d.name(st)); r.dataset.k = d.k;
        const fill = () => r.style.setProperty('--p', ((r.value - d.min) / Math.max(1, max - d.min) * 100) + '%');
        fill();
        r.oninput = () => { fill(); val.textContent = d.f(Number(r.value) * unit); };
        r.onchange = () => act('settings', uid, { [d.k]: Number(r.value) * unit });
        wrap.append(top, r);
        if (d.note) wrap.append(el('small', null, d.note));
        box.append(wrap);
      }
    }
    // zone preview
    if (!mini) {
      mini = LF.map('miniMap', { zoomControl: false, attributionControl: false });
      tiles(mini);
      mini.on('click', e => { if (amHost()) act('setCenter', uid, { lat: e.latlng.lat, lng: e.latlng.lng }); else toast('방장만 중심을 정할 수 있어요'); });
      $('#settingsBox').addEventListener('toggle', () => setTimeout(() => mini.invalidateSize(), 30));
    }
    const c = st.center || (locs[st.host] && { lat: locs[st.host].lat, lng: locs[st.host].lng }) || (host && me) || me;
    $('#centerNote').textContent = st.center ? (host ? '지도에서 정한 곳이 중심이에요. 다시 누르면 옮겨져요.' : '방장이 지도에서 정한 곳이 중심이에요.')
      : host ? '시작할 때 내 위치가 중심이 돼요. 지도를 눌러 다른 곳으로 정할 수도 있어요.' : '시작할 때 방장 위치가 중심이 돼요.';
    if (c) {
      if (!miniCircle) { miniCircle = LF.circle([c.lat, c.lng], { radius: st.set.radius, color: '#2ef59a', weight: 3, fillColor: '#2ef59a', fillOpacity: 0.08 }).addTo(mini); mini.fitBounds(zoneBounds(c, st.set.radius), { padding: [12, 12] }); }
      const moved = miniCircle.getLatLng().lat !== c.lat || miniCircle.getLatLng().lng !== c.lng || miniCircle.getRadius() !== st.set.radius;
      miniCircle.setLatLng([c.lat, c.lng]); miniCircle.setRadius(st.set.radius);
      if (moved) mini.fitBounds(zoneBounds(c, st.set.radius), { padding: [12, 12] });
    } else if (!mini._loaded) mini.setView([21.0285, 105.8542], 13);
    if (me) { if (!miniMe) miniMe = LF.marker([me.lat, me.lng], { icon: pinIcon('me', '나', '#2ef59a') }).addTo(mini); else miniMe.setLatLng([me.lat, me.lng]); }
    // start
    const sb = $('#startBtn');
    sb.disabled = !host || list.length < 2;
    sb.textContent = !host ? '방장이 시작하기를 기다리는 중…' : list.length < 2 ? '2명 이상 모이면 시작할 수 있어요' : `게임 시작 (${list.length}명)`;
    sb.onclick = () => act('start', uid, NOW, me ? { lat: me.lat, lng: me.lng } : null, undefined);
    $('#lobbyLeave').onclick = () => { if (confirm('방에서 나갈까요?')) act('leave', uid, NOW).then(() => { location.hash = ''; }); };
    const link = location.origin + location.pathname + '#' + code;
    const copy = async () => { try { await navigator.clipboard.writeText(link); toast('초대 링크를 복사했어요'); } catch (e) { prompt('이 링크를 복사해 보내 주세요', link); } };
    $('#copyBtn').onclick = copy; $('#lobbyCode').onclick = copy;
    $('#shareBtn').hidden = !navigator.share;
    $('#shareBtn').onclick = () => navigator.share({ title: 'Man Hunt', text: `Man Hunt 같이 하자! 참여 코드 ${code}`, url: link }).catch(() => {});
  }

  /* game map */
  let map = null, layers = null, markers = {}, fitRound = -1;
  // real map tiles, all without an API key: street map (OpenStreetMap; falls back to Esri's street map) or satellite (Esri)
  const STYLES = {
    map: { url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', o: { maxZoom: 20, maxNativeZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' } },
    osm: { url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}', o: { maxZoom: 20, maxNativeZoom: 19, attribution: 'Map &copy; Esri, OpenStreetMap' } },
    sat: { url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', o: { maxZoom: 20, maxNativeZoom: 19, attribution: 'Imagery &copy; Esri, Maxar, Earthstar Geographics' } },
  };
  let mapStyle = LS.get('mh_style') === 'sat' ? 'sat' : 'map', cartoBad = false;
  const baseMaps = [];
  function setBase(m) {
    const key = mapStyle === 'sat' ? 'sat' : cartoBad ? 'osm' : 'map', sdef = STYLES[key];
    if (m._base && m._base._key === key) return;
    if (m._base) m.removeLayer(m._base);
    const t = LF.tileLayer(sdef.url, sdef.o); t._key = key;
    let errs = 0, oks = 0;
    t.on('tileload', () => { oks++; });
    t.on('tileerror', () => { if (key === 'map' && ++errs >= 6 && !oks && !cartoBad) { cartoBad = true; baseMaps.forEach(setBase); } });
    m._base = t.addTo(m); t.bringToBack();
  }
  function tiles(m) { baseMaps.push(m); setBase(m); }
  function toggleStyle() {
    mapStyle = mapStyle === 'sat' ? 'map' : 'sat'; LS.set('mh_style', mapStyle);
    baseMaps.forEach(setBase); styleBtn();
    toast(mapStyle === 'sat' ? '🛰 위성 지도' : '🗺 일반 지도');
  }
  function styleBtn() { const b = $('#styleBtn'); if (!b) return; b.textContent = mapStyle === 'sat' ? '🗺' : '🛰'; b.setAttribute('aria-label', mapStyle === 'sat' ? '일반 지도로 보기' : '위성 지도로 보기'); }
  function gameMap() {
    if (map) return map;
    map = LF.map('map', { zoomControl: false, attributionControl: true });
    map.setView(me ? [me.lat, me.lng] : [21.0285, 105.8542], 16);
    tiles(map);
    $('#styleBtn').onclick = toggleStyle; styleBtn();
    layers = { shade: LF.polygon([], { stroke: false, fillColor: '#ff4d5e', fillOpacity: 0.2, interactive: false }).addTo(map),
      zone: LF.circle([0, 0], { radius: 1, color: '#2ef59a', weight: 3, fill: false, interactive: false }).addTo(map),
      next: LF.circle([0, 0], { radius: 1, color: '#ffffff', weight: 2, dashArray: '8 8', fill: false, interactive: false }).addTo(map),
      jail: LF.marker([0, 0], { icon: LF.divIcon({ className: '', html: '<div class="jail">🔒</div>', iconSize: [28, 28], iconAnchor: [14, 14] }), interactive: false }) };
    map.on('click', e => { if (SIM) simMove(e.latlng.lat, e.latlng.lng); });
    return map;
  }
  function pinIcon(kind, label, color, sub) {
    const html = `<div class="pin ${kind}" style="--c:${color}"><span>${esc(label)}</span><i></i>${sub ? `<em>${esc(sub)}</em>` : ''}</div>`;
    return LF.divIcon({ className: '', html, iconSize: [22, 22], iconAnchor: [11, 11] });
  }
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  function setMarker(key, pos, kind, label, color, sub) {
    const html = kind + '|' + label + '|' + color + '|' + (sub || '');
    let m = markers[key];
    if (!m) { m = markers[key] = LF.marker([pos.lat, pos.lng], { icon: pinIcon(kind, label, color, sub), keyboard: false }).addTo(map); m._h = html; }
    else { m.setLatLng([pos.lat, pos.lng]); if (m._h !== html) { m.setIcon(pinIcon(kind, label, color, sub)); m._h = html; } }
    if (kind === 'me') m.setZIndexOffset(1000);
  }
  function zoneBounds(c, r) { return LF.latLngBounds([L.dest(c, r, 180).lat, L.dest(c, r, 270).lng], [L.dest(c, r, 0).lat, L.dest(c, r, 90).lng]); }
  function circlePts(c, r) { const pts = []; for (let k = 0; k < 72; k++) { const p = L.dest(c, r, k * 5); pts.push([p.lat, p.lng]); } return pts; }
  function fitZone() {
    if (!map || !st || !st.center) return;
    if (fitRound === st.round) return;
    fitRound = st.round;
    map.fitBounds(zoneBounds(st.center, L.zone(st, srvNow()).r), { padding: [20, 20] });
  }
  // who this phone may see, and where
  function visible(now, z) {
    const p = mine(), out = [], allSee = st.phase !== 'run' || (p.out && st.set.mode !== 'cops') || p.left;
    const outside = q => !!q && L.dist(q, st.center) > z.r;
    for (const u of L.ids(st)) {
      const q = st.players[u]; if (q.left) continue;
      const lo = locOf(u);
      if (u === uid) { if (me) out.push({ u, pos: me, kind: 'me', label: '나' }); continue; }
      const jailed = st.set.mode === 'cops' && q.out;
      if (q.out && !jailed && !allSee) continue;
      if (allSee || q.role === p.role || jailed) { if (lo) out.push({ u, pos: lo, kind: (fresh(lo) ? '' : 'ghost') + (outside(lo) ? ' warn' : ''), label: q.n, sub: fresh(lo) ? '' : ago(now - lo.at) }); continue; }
      if (outside(lo) && fresh(lo) && L.phase(st, now) === 'play') { out.push({ u, pos: lo, kind: 'warn', label: q.n, sub: '자기장 밖' }); continue; }
      if (p.role === 'S' && q.role === 'H') {
        const a = st.pings && st.pings.locs && st.pings.locs[u], b = st.manual && st.manual[u];
        const pk = [a && { ...a, at: st.pings.at }, b].filter(Boolean).sort((x, y) => y.at - x.at)[0];
        if (pk) out.push({ u, pos: pk, kind: 'ping', label: q.n, sub: ago(now - pk.at) });
      }
    }
    return out;
  }
  function nearestFoe(now) {
    const p = mine(); if (!me || !p) return null;
    let best = null;
    for (const u of L.ids(st)) {
      const q = st.players[u];
      if (u === uid || q.left || q.out || q.role === p.role) continue;
      const lo = locs[u]; if (!fresh(lo)) continue;
      const d = L.dist(me, lo); if (!best || d < best.d) best = { u, d };
    }
    return best;
  }
  const jailR = () => Math.max(20, st.set.catchR * 2);
  function canCatch(u) {
    const lo = locs[u];
    return !!me && fresh(me) && fresh(lo) && L.dist(me, lo) <= st.set.catchR;
  }

  /* game screen */
  let panelOpen = false, panelSig = '', bottomSig = '';
  function renderGame() {
    show('game'); gameMap();
    const now = srvNow(), ph = L.phase(st, now), p = mine(), z = L.zone(st, now), SL = L.label(st, 'S'), HL = L.label(st, 'H');
    // HUD
    $('#hudLabel').textContent = ph === 'hide' ? 'HIDING TIME' : 'ACTIVE GAME';
    $('#hudTime').textContent = mmss((ph === 'hide' ? L.hideEnd(st) : L.endAt(st)) - now);
    $('#hud').classList.toggle('hurry', ph === 'play' && L.endAt(st) - now < 60000);
    $('#hudZone').textContent = `◆ ${Math.round(z.r)}m · ${z.i + 1}/${z.n + 1}`;
    $('#hudShrink').textContent = z.next && ph !== 'ending' ? `↘ ${mmss(z.next - now)}` : '';
    $('#hudReveal').textContent = ph === 'play' ? `((•)) ${mmss(L.nextReveal(st, now) - now)}` : ph === 'hide' ? `${SL} 출발까지 ${mmss(L.hideEnd(st) - now)}` : '';
    const jailed = st.set.mode === 'cops' && p.role === 'H' && p.out;
    const rc = $('#roleChip');
    rc.textContent = p.out && !jailed ? '탈락 · 관전' : jailed ? '감옥' : L.label(st, p.role);
    rc.className = 'rolechip ' + (p.out ? 'X' : p.role);
    const free = L.freeHiders(st).length, allH = L.hiders(st).length;
    $('#listBtn').textContent = `👥 ${HL} ${p.role === 'S' ? '(' + free + ')' : free + '/' + allH}`;
    $('#listBtn').onclick = () => { panelOpen = !panelOpen; panelSig = ''; renderGame(); };
    $('#panelClose').onclick = () => { panelOpen = false; renderGame(); };
    $('#meBtn').onclick = () => { if (me) map.setView([me.lat, me.lng], Math.max(map.getZoom(), 17)); else toast(gpsErr || '위치를 찾는 중이에요'); };
    $('#menuBtn').onclick = openMenu;
    // seekers wait while the others hide
    const wall = ph === 'hide' && p.role === 'S';
    $('#hideWall').hidden = !wall;
    if (wall) { $('#hideTime').textContent = mmss(L.hideEnd(st) - now); $('#hideMsg').textContent = `${HL}들이 숨고 있어요. 제자리에서 눈 감고 기다려요! 시간이 끝나면 지도가 열려요.`; }
    // zone
    const c = st.center, outNow = !!me && L.dist(me, c) > z.r;
    if (z.i !== lastZoneI) { if (lastZoneI >= 0 && z.i > lastZoneI) { toast(`자기장이 줄어들었어요 → ${Math.round(z.r)}m`); vib(250); } lastZoneI = z.i; }
    if (outNow && !outside && ph === 'play') vib([100, 80, 100]);
    outside = outNow;
    $('#zoneWarn').hidden = !(outNow && ph === 'play' && !(p.out && !jailed));
    layers.shade.setLatLngs([[[c.lat + 0.6, c.lng - 0.8], [c.lat + 0.6, c.lng + 0.8], [c.lat - 0.6, c.lng + 0.8], [c.lat - 0.6, c.lng - 0.8]], circlePts(c, z.r)]);
    layers.zone.setLatLng([c.lat, c.lng]); layers.zone.setRadius(z.r);
    if (z.nr) { layers.next.setLatLng([c.lat, c.lng]); layers.next.setRadius(z.nr); layers.next.setStyle({ opacity: 0.9 }); } else layers.next.setStyle({ opacity: 0 });
    if (st.set.mode === 'cops') { layers.jail.setLatLng([c.lat, c.lng]); if (!map.hasLayer(layers.jail)) layers.jail.addTo(map); } else if (map.hasLayer(layers.jail)) layers.jail.remove();
    fitZone();
    // markers
    const seen = {};
    for (const v of visible(now, z)) {
      const key = (v.kind === 'ping' ? 'p:' : 'l:') + v.u; seen[key] = 1;
      setMarker(key, v.pos, v.kind, v.label, v.kind === 'me' ? '#2ef59a' : playerColor(v.u), v.sub);
    }
    for (const k of Object.keys(markers)) if (!seen[k]) { markers[k].remove(); delete markers[k]; }
    // bottom bar
    const bottom = $('#bottom'), parts = [];
    if (!me) parts.push(['info far', '!', gpsErr || '위치를 찾는 중이에요… 위치 권한을 허용해 주세요']);
    else if (p.out && !jailed) parts.push(['info far', '👀', '잡혔어요 — 이제 모두의 위치가 보여요']);
    else if (jailed) parts.push(['info mid', meters(L.dist(me, c)), '감옥에 갇혔어요 🔒 다른 도둑이 감옥에 오면 풀려나요']);
    else if (p.role === 'H') {
      const f = nearestFoe(now);
      if (ph === 'hide') parts.push(['info far', mmss(L.hideEnd(st) - now), '숨는 시간! 멀리, 잘 숨어요']);
      else if (f) parts.push(['info ' + (f.d < 60 ? 'near' : f.d < 200 ? 'mid' : 'far'), meters(f.d), `가장 가까운 ${SL}`]);
      else parts.push(['info far', '?', `${SL} 신호가 없어요`]);
    } else parts.push(['info far', ph === 'play' ? mmss(L.nextReveal(st, now) - now) : '…', ph === 'play' ? '다음 위치 공개까지 · 가까이 가면 잡기 버튼이 빨개져요' : '숨는 시간이 끝나면 출발!']);
    const btns = [];
    if (ph === 'play' && p.role === 'H' && !p.out) {
      btns.push(['btn ghost', '잡혔어요', 'self']);
      if (st.set.mode === 'cops' && L.hiders(st).some(u => st.players[u].out)) btns.push([me && L.dist(me, c) <= jailR() ? 'btn neon' : 'btn', `🔓 감옥 구출 ${me ? meters(L.dist(me, c)) : ''}`, 'rescue', !(me && L.dist(me, c) <= jailR())]);
    }
    const bsig = JSON.stringify([parts, btns]);
    if (bsig !== bottomSig) {
      bottomSig = bsig; bottom.textContent = '';
      for (const [cls, big, txt] of parts) { const d = el('div', cls); d.append(el('b', null, big), el('span', null, txt)); bottom.append(d); }
      if (btns.length) {
        const row = el('div', 'row');
        for (const [cls, txt, what, dis] of btns) { const b = el('button', cls, txt); b.disabled = !!dis; b.onclick = () => (what === 'self' ? selfReport() : act('rescue', uid, NOW)); row.append(b); }
        bottom.append(row);
      }
    }
    renderPanel(now, ph);
  }
  function selfReport() {
    const f = nearestFoe(srvNow());
    const by = f ? f.u : L.seekers(st)[0];
    if (!by) return;
    if (!confirm(`${nameOf(by)} 님에게 잡혔다고 할까요?`)) return;
    act('doCatch', by, uid, NOW, true);
  }
  function renderPanel(now, ph) {
    const panel = $('#panel'); panel.hidden = !panelOpen;
    if (!panelOpen) return;
    const p = mine(), HL = L.label(st, 'H');
    const rows = L.ids(st).filter(u => st.players[u].orig === 'H' || st.players[u].role === 'H').filter(u => !st.players[u].left).map(u => {
      const q = st.players[u], gone = q.role !== 'H' || q.out;
      const pk = st.pings && st.pings.locs && st.pings.locs[u] ? st.pings.at : 0, mk = st.manual && st.manual[u] ? st.manual[u].at : 0, seenAt = Math.max(pk, mk);
      const status = q.role === 'S' ? '좀비가 됐어요' : q.out ? (st.set.mode === 'cops' ? '감옥 🔒' : '잡힘') : p.role === 'S' ? (seenAt ? `${ago(now - seenAt)} 공개` : '아직 공개 안 됨') : '도망 중';
      const hot = p.role === 'S' && !p.out && ph === 'play' && !gone && canCatch(u);
      const cool = Math.max(0, L.PING_COOLDOWN - (now - ((st.cool || {})[uid] || 0)));
      return { u, n: q.n, status, gone, hot, cool: p.role === 'S' && !gone && ph === 'play' ? Math.ceil(cool / 1000) : -1 };
    });
    $('#panelTitle').textContent = `${HL} (${rows.filter(r => !r.gone).length})`;
    const sig = JSON.stringify(rows);
    if (sig === panelSig) return;
    panelSig = sig;
    const body = $('#panelBody'); body.textContent = '';
    if (p.role === 'S') {
      const tools = el('div', 'tools'), fit = el('button', 'btn small', '📍 공개된 위치 모두 보기');
      fit.onclick = () => { const pts = Object.values((st.pings && st.pings.locs) || {}).concat(Object.values(st.manual || {})).map(x => [x.lat, x.lng]); if (me) pts.push([me.lat, me.lng]); if (pts.length) map.fitBounds(pts, { padding: [60, 60], maxZoom: 18 }); };
      tools.append(fit); body.append(tools);
    }
    for (const r of rows) {
      const row = el('div', 'tgt' + (r.hot ? ' hot' : '') + (r.gone ? ' out' : '')), av = el('i', 'av');
      av.style.background = playerColor(r.u);
      const nm = el('div', 'nm', r.n); nm.append(el('small', null, r.status));
      row.append(av, nm);
      if (p.role === 'S' && !p.out && !r.gone) {
        const pb = el('button', 'pingb', r.cool > 0 ? r.cool + 's' : '((•))'); pb.disabled = r.cool !== 0; pb.title = '지금 위치 확인 (1분에 한 번)';
        pb.onclick = () => { const lo = locs[r.u]; act('manualPing', uid, r.u, lo && fresh(lo) ? { lat: lo.lat, lng: lo.lng } : null, NOW); };
        const cb = el('button', 'catchb', 'CATCH'); cb.disabled = !r.hot;
        cb.onclick = () => act('doCatch', uid, r.u, NOW, false);
        row.append(pb, cb);
      } else if (r.gone) row.append(el('span', 'tag', st.players[r.u].role === 'S' ? '🧟' : st.set.mode === 'cops' ? '감옥' : 'Caught'));
      body.append(row);
    }
  }
  function openMenu() {
    const sh = $('#sheet'); sh.textContent = ''; $('#sheetBack').hidden = false;
    const m = L.MODES[st.set.mode], p = mine();
    sh.append(el('h2', null, `${m.icon} ${m.name}`), el('p', 'hint', m.desc));
    sh.append(el('h4', null, '내 역할'));
    const ul = el('ul');
    if (p.role === 'S') ['숨는 시간이 끝나면 출발해요.', `${secTxt(st.set.reveal)}마다 숨은 사람 위치가 지도에 떠요 (점선 동그라미).`, `((•)) 버튼으로 한 사람 위치를 바로 볼 수 있어요 (1분에 한 번).`, `${st.set.catchR}m 안으로 가까이 가면 CATCH 버튼이 빨개져요. 누르면 잡기!`].forEach(t => ul.append(el('li', null, t)));
    else ['숨는 시간 동안 멀리 숨어요.', `${secTxt(st.set.reveal)}마다 내 위치가 술래 편에게 공개돼요.`, '아래 거리 표시로 가장 가까운 술래 편이 얼마나 가까운지 알 수 있어요.', '자기장(초록 원) 밖에 나가면 내 위치가 계속 보여요!', 'GPS가 이상해서 잡혔는데 버튼이 안 켜졌다면 “잡혔어요”를 눌러요.'].forEach(t => ul.append(el('li', null, t)));
    if (st.set.mode === 'cops') ul.append(el('li', null, `감옥은 자기장 중심(🔒)이에요. 갇히지 않은 도둑이 ${jailR()}m 안에 가서 “감옥 구출”을 누르면 모두 풀려나요.`));
    sh.append(ul, el('h4', null, '꼭 알아 두기'));
    const ul2 = el('ul');
    ['게임 중에는 이 화면을 켜 두세요. 화면이 꺼지면 위치를 못 보내요.', wake ? '화면 꺼짐 방지: 켜짐 ✓' : '화면 꺼짐 방지를 쓸 수 없는 브라우저예요. 화면 자동 잠금 시간을 늘려 주세요.', '차도·위험한 곳은 피해서 놀아요!'].forEach(t => ul2.append(el('li', null, t)));
    sh.append(ul2);
    if (SIM) sh.append(el('p', 'hint', '연습 모드(?sim): 지도를 누르면 내 위치가 그곳으로 옮겨져요.'));
    const leave = el('button', 'btn ghost', '게임에서 나가기');
    leave.onclick = () => { if (confirm('게임에서 나갈까요? 이번 판에는 다시 못 들어와요.')) { closeMenu(); act('leave', uid, NOW).then(() => { location.hash = ''; }); } };
    const close = el('button', 'btn', '닫기'); close.onclick = closeMenu;
    sh.append(leave, close);
  }
  function closeMenu() { $('#sheetBack').hidden = true; }

  /* result */
  function renderResult() {
    show('result');
    const s = L.summary(st), win = st.end ? st.end.win : 'S', SL = L.label(st, 'S'), HL = L.label(st, 'H');
    $('#resIcon').textContent = win === 'S' ? (st.set.mode === 'zombie' ? '🧟' : '🎯') : '🏃';
    $('#resIcon').className = 'resicon ' + win;
    $('#resTitle').textContent = `${win === 'S' ? SL : HL} 승리!`;
    $('#resTitle').className = 'restitle ' + win;
    $('#resDur').textContent = mmss(s.dur);
    $('#resCaughtLbl').textContent = st.set.mode === 'zombie' ? '좀비가 된 사람' : st.set.mode === 'cops' ? '감옥에 있는 도둑' : '잡힌 사람';
    $('#resCaught').textContent = st.set.mode === 'cops' ? `${L.hiders(st).filter(u => st.players[u].out).length} / ${s.total}` : `${s.caught} / ${s.total}`;
    $('#resSLbl').textContent = SL.toUpperCase();
    $('#resHLbl').textContent = HL.toUpperCase();
    const sk = $('#resS'); sk.textContent = '';
    for (const x of s.seekers) {
      const d = el('div', 'st'), nm = el('span', 'nm', x.n + (st.players[x.u].orig === 'H' ? ' 🧟' : ''));
      d.append(nm); if (x.mvp) d.append(el('span', 'mvp', 'MVP'));
      d.append(el('span', 'v', `${x.c}명 잡음`)); sk.append(d);
    }
    const hd = $('#resH'); hd.textContent = '';
    for (const x of s.hiders) {
      const d = el('div', 'st'), q = st.players[x.u];
      const caught = x.caught && !(st.set.mode === 'cops' && !q.out);
      d.append(el('span', 'nm' + (caught || x.left ? ' x' : ''), x.n));
      if (caught) d.append(el('span', 'tag', st.set.mode === 'zombie' ? '좀비' : st.set.mode === 'cops' ? '감옥' : 'Caught'));
      else if (x.left) d.append(el('span', 'tag', '나감'));
      if (x.r) d.append(el('span', 'mvp', `구출 ${x.r}`));
      const lo = locOf(x.u), dist = x.u === uid ? myDist : lo && lo.r === st.round ? lo.d : null;
      d.append(el('span', 'v', dist != null ? meters(dist || 0) : '—'));
      hd.append(d);
    }
    const ab = $('#againBtn');
    ab.disabled = !amHost(); ab.textContent = amHost() ? '다시 하기 (로비로)' : '방장이 다시 시작하기를 기다리는 중…';
    ab.onclick = () => act('reset', uid);
  }

  /* ---------- loop & boot ---------- */
  function tick() {
    if (!st || !mine()) return;
    const now = srvNow(), ph = L.phase(st, now);
    if (st.phase === 'run' && !busy) {
      if (ph === 'ending') { busy = true; act('finish', NOW).finally(() => { busy = false; }); }
      else if (ph === 'play') {
        const k = L.revealK(st, now);
        if (k > ((st.pings && st.pings.k) || 0)) {
          busy = true;
          const snap = {};
          for (const u of L.freeHiders(st)) { const lo = locOf(u); if (lo && now - lo.at < 300000) snap[u] = { lat: lo.lat, lng: lo.lng, at: lo.at }; }
          act('ping', k, snap).finally(() => { busy = false; });
        }
      }
    }
    if (st.phase === 'run' && st.pings && st.pings.k !== lastPingK) {
      if (lastPingK >= 0 && st.pings.k > lastPingK && ph === 'play') {
        const p = mine();
        if (p.role === 'H' && !p.out) { toast(`👀 내 위치가 ${L.label(st, 'S')}에게 공개됐어요!`, true); vib([120, 60, 120]); }
        else if (p.role === 'S') toast(`📍 ${L.label(st, 'H')} 위치가 업데이트됐어요`);
      }
      lastPingK = st.pings.k;
    }
    upload(false);
    if (st.phase === 'run') renderGame(); else if (st.phase === 'lobby') renderLobby();
  }
  const normCode = s => { const c = String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); return /^[A-Z0-9]{6}$/.test(c) ? c : null; };
  async function boot() {
    window.addEventListener('hashchange', () => location.reload());
    $('#sheetBack').addEventListener('click', e => { if (e.target.id === 'sheetBack') closeMenu(); });
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { if (lastScreen === 'game') keepAwake(); if (me) upload(true); } });
    code = normCode(decodeURIComponent(location.hash.slice(1)));
    if (!code) { renderHome(); return; }
    base = 'rooms/HZ' + code;
    try { await connect(); } catch (e) { fatal(e && e.message === 'config' ? 'firebase-config.js 설정이 비어 있어요 (README 참고)' : /operation-not-allowed|admin-restricted/.test(String(e && (e.code || e.message))) ? 'Firebase 익명 로그인이 꺼져 있어요' : '서버에 연결할 수 없어요. 인터넷을 확인하고 새로고침해 주세요'); return; }
    subscribe();
    startGps();
    if (SIM && !me) setTimeout(() => { if (!me) simMove(21.0285 + (Math.random() - 0.5) * 0.004, 105.8542 + (Math.random() - 0.5) * 0.004); }, 1500);
    setInterval(tick, 500);
  }
  window.MH = { act: (...a) => act(...a), NOW, state: () => st, me: () => me, uid: () => uid, simMove };
  boot();
})();
