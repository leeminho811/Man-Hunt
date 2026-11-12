// End-to-end test on the Firebase emulators: three "phones" with fake GPS play classic and cops & robbers.
//   npm install && npm run test:e2e   (Java needed for the emulators)
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import fs from 'fs';
import http from 'http';
import path from 'path';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SDK_DIR = process.env.FIREBASE_SDK_DIR || path.dirname(require.resolve('firebase/package.json'));
const SHOTS = process.env.SHOTS || path.join(ROOT, 'shots');
const NS = 'demo-hunt-default-rtdb', DBURL = 'http://127.0.0.1:9000';
const VERSION = /VERSION = '([\d.]+)'/.exec(fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8'))[1];
fs.mkdirSync(SHOTS, { recursive: true });
const TEST_CONFIG = `window.FIREBASE_CONFIG = ${JSON.stringify({
  apiKey: 'demo-key', authDomain: 'demo-hunt.firebaseapp.com', projectId: 'demo-hunt', databaseURL: `https://${NS}.firebaseio.com`, appId: '1:1:web:1',
  emulator: { auth: 'http://127.0.0.1:9099', dbHost: '127.0.0.1', dbPort: 9000 },
})};`;
const errors = [];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ok = (cond, msg) => { if (!cond) errors.push('FAIL ' + msg); else console.log('ok  ', msg); };
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css' };
const server = http.createServer((req, res) => {
  const p = path.join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  const f = p.endsWith('/') ? path.join(p, 'index.html') : p;
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const BASE = `http://localhost:${server.address().port}/`;
async function table(code) {
  const r = await fetch(`${DBURL}/rooms/HZ${code}/table.json?ns=${NS}`, { headers: { Authorization: 'Bearer owner' } });
  const v = await r.json(); return v && v.j ? JSON.parse(v.j) : null;
}
async function until(fn, ms = 15000, step = 250) { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) return null; await sleep(step); } }
// Hanoi, around Hoàn Kiếm lake
const C = { latitude: 21.0285, longitude: 105.8522 };
const off = (m, east) => ({ latitude: C.latitude + (east ? 0 : m / 111195), longitude: C.longitude + (east ? m / (111195 * Math.cos(C.latitude * Math.PI / 180)) : 0) });
async function phone(browser, label, geo) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, hasTouch: true, isMobile: true, geolocation: geo, permissions: ['geolocation'] });
  await ctx.route(/^https:\/\/www\.gstatic\.com\/firebasejs\//, r => {
    const u = new URL(r.request().url()), f = path.join(SDK_DIR, path.basename(u.pathname));
    return u.pathname.includes(`/${VERSION}/`) && fs.existsSync(f) ? r.fulfill({ path: f, contentType: 'application/javascript' }) : r.abort();
  });
  await ctx.route(/fonts\.(googleapis|gstatic)\.com|basemaps\.cartocdn\.com/, r => r.abort());
  await ctx.route('**/firebase-config.js', r => r.fulfill({ contentType: 'application/javascript', body: TEST_CONFIG }));
  const page = await ctx.newPage();
  page.setDefaultTimeout(6000);
  page.on('dialog', d => d.accept());
  page.on('console', m => { if (m.type() === 'error' && !/ERR_FAILED|net::/.test(m.text())) errors.push(`${label} console: ${m.text()}`); });
  page.on('pageerror', e => errors.push(`${label} pageerror: ${e}`));
  return { ctx, page, label };
}
const shot = (p, name) => p.page.screenshot({ path: path.join(SHOTS, name + '.png') });
const uidOf = p => p.page.evaluate(() => window.MH.uid());

const browser = await chromium.launch();
let A, B, Cc;
try {
  A = await phone(browser, 'A', off(0)); B = await phone(browser, 'B', off(300)); Cc = await phone(browser, 'C', off(-250, true));
  await A.page.goto(BASE);
  ok(await A.page.locator('#home .title').isVisible(), 'home screen');
  await shot(A, '01-home');
  await A.page.locator('#nameIn').fill('민수');
  await A.page.locator('#createBtn').click();
  await A.page.locator('#lobby:not([hidden])').waitFor({ timeout: 15000 });
  const code = await A.page.evaluate(() => location.hash.slice(1));
  ok(/^[A-Z2-9]{6}$/.test(code), 'room created with code ' + code);
  for (const [p, n] of [[B, '지영'], [Cc, '도우너']]) {
    await p.page.goto(BASE + '#' + code);
    await p.page.locator('#join:not([hidden])').waitFor({ timeout: 15000 });
    await p.page.locator('#joinName').fill(n);
    await p.page.locator('#joinGo').click();
    await p.page.locator('#lobby:not([hidden])').waitFor({ timeout: 10000 });
  }
  let t = await until(async () => { const x = await table(code); return x && Object.keys(x.players).length === 3 ? x : null; });
  ok(!!t, 'three players in the lobby');
  ok(await until(() => A.page.evaluate(() => document.querySelectorAll('#players .sig.ok').length === 3)), 'everyone’s GPS shows up in the lobby');
  const uA = await uidOf(A), uB = await uidOf(B), uC = await uidOf(Cc);
  // host picks B as the seeker and short timings for the test
  await A.page.locator('#players li', { hasText: '지영' }).locator('.chip').click();
  await A.page.evaluate(u => window.MH.act('settings', u, { dur: 40, hide: 4, reveal: 5, stages: 2, radius: 600, catchR: 15 }), uA);
  ok(await until(async () => { const x = await table(code); return x && x.players[uB].fix && x.set.dur === 40; }), 'host set a fixed seeker and the timings');
  ok(await B.page.locator('#sliders input[type=range]').first().isDisabled(), 'non-host cannot change settings');
  await sleep(500); await shot(A, '02-lobby');
  await A.page.evaluate(() => document.querySelector('#lobby').scrollTo(0, 9999)); await sleep(200); await shot(A, '03-lobby-settings');
  await A.page.locator('#startBtn').click();
  t = await until(async () => { const x = await table(code); return x && x.phase === 'run' ? x : null; });
  ok(t && t.players[uB].role === 'S' && t.players[uA].role === 'H' && t.players[uC].role === 'H', 'game started: B seeks, A and C hide');
  ok(await until(() => B.page.locator('#hideWall').isVisible()), 'seeker waits behind the hiding screen');
  await shot(B, '04-seeker-hiding'); await shot(A, '05-hider-hiding');
  await until(() => B.page.locator('#hideWall').isHidden(), 8000);
  // the first reveal arrives after 5 s of play
  ok(await until(() => B.page.evaluate(() => document.querySelectorAll('.pin.ping').length === 2), 9000), 'seeker sees both hiders after the reveal');
  ok(await A.page.locator('#bottom .info b').innerText().then(s => /m$/.test(s)), 'hider sees how far the nearest seeker is');
  await B.page.locator('#listBtn').click();
  ok(await B.page.locator('.tgt .catchb').first().isDisabled(), 'CATCH is off when far away');
  await sleep(300); await shot(B, '06-seeker-panel');
  await B.ctx.setGeolocation(off(5));
  const hot = await until(() => B.page.locator('.tgt.hot .catchb:not([disabled])').count(), 8000);
  ok(!!hot, 'CATCH lights up next to a hider');
  await sleep(200); await shot(B, '07-catch-ready');
  await B.page.locator('.tgt.hot .catchb').click();
  t = await until(async () => { const x = await table(code); return x && x.players[uA].out ? x : null; });
  ok(t && t.catches[uB] === 1, 'B caught A');
  ok(await until(() => A.page.locator('#roleChip').innerText().then(s => s.includes('탈락'))), 'A is out and watching');
  // C wanders out of the zone and gets flagged, then is caught
  await Cc.ctx.setGeolocation(off(-900, true));
  ok(await until(() => Cc.page.locator('#zoneWarn').isVisible(), 6000), 'leaving the zone shows a warning');
  await shot(Cc, '08-outside-zone');
  await B.ctx.setGeolocation(off(-905, true));
  await until(() => B.page.locator('.tgt.hot .catchb:not([disabled])').count(), 8000);
  await B.page.locator('.tgt.hot .catchb').click();
  t = await until(async () => { const x = await table(code); return x && x.phase === 'over' ? x : null; });
  ok(t && t.end.win === 'S', 'all hiders caught → seekers win');
  ok(await until(() => A.page.locator('#resTitle').innerText().then(s => s === '술래 승리!')), 'result screen: 술래 승리!');
  await sleep(300); await shot(A, '09-result');

  // cops and robbers: jail and rescue
  await A.page.locator('#againBtn').click();
  await A.page.locator('#lobby:not([hidden])').waitFor({ timeout: 10000 });
  await A.page.locator('.mode', { hasText: '경찰과 도둑' }).click();
  await A.page.evaluate(u => window.MH.act('settings', u, { hide: 2, dur: 60 }), uA);
  for (const [p, g] of [[A, off(200)], [B, off(150)], [Cc, off(-200, true)]]) await p.ctx.setGeolocation(g);
  await sleep(2500);
  await A.page.locator('#startBtn').click();
  t = await until(async () => { const x = await table(code); return x && x.phase === 'run' && x.set.mode === 'cops' ? x : null; });
  ok(!!t, 'cops & robbers started');
  const jail = t.center;
  await sleep(2500);
  await B.ctx.setGeolocation(off(200));
  await B.page.locator('#listBtn').click();
  await until(() => B.page.locator('.tgt.hot .catchb:not([disabled])').count(), 10000);
  await B.page.locator('.tgt.hot .catchb').click();
  ok(await until(async () => { const x = await table(code); return x && x.players[uA].out && x.phase === 'run'; }), 'cop caught robber A → jail');
  await shot(A, '10-jailed');
  await Cc.ctx.setGeolocation({ latitude: jail.lat, longitude: jail.lng });
  const rb = Cc.page.locator('#bottom .btn', { hasText: '감옥 구출' });
  ok(await until(() => rb.isEnabled().catch(() => false), 8000), 'rescue button turns on at the jail');
  await shot(Cc, '11-rescue');
  await rb.click();
  ok(await until(async () => { const x = await table(code); return x && !x.players[uA].out && x.rescues[uC] === 1; }), 'robber C freed A from jail');
} catch (e) { errors.push('threw ' + e.message.split('\n')[0]); for (const p of [A, B, Cc]) { try { await shot(p, 'zz-fail-' + p.label); } catch (x) {} } throw e;
} finally {
  await browser.close();
  server.close();
}
console.log(errors.length ? 'ERRORS:\n' + errors.slice(0, 30).join('\n') : '\nall e2e checks passed');
process.exit(errors.length ? 1 : 0);
