// Rule tests: node test/logic.test.js
const L = require('../logic.js');
let fails = 0;
const ok = (c, name) => { if (c) console.log('ok  ', name); else { console.log('FAIL', name); fails++; } };
const eq = (a, b, name) => ok(JSON.stringify(a) === JSON.stringify(b), `${name} (${JSON.stringify(a)})`);
const C = { lat: 21.0285, lng: 105.8542 };

// geometry
const p500 = L.dest(C, 500, 90);
ok(Math.abs(L.dist(C, p500) - 500) < 0.5, 'dest/dist round trip: 500 m east');
ok(Math.abs(L.dist({ lat: 0, lng: 0 }, { lat: 1, lng: 0 }) - 111195) < 50, '1° of latitude ≈ 111 km');

// room
let t = 1e12;
function room(n, mode) {
  const st = L.newRoom('u0', '민수', t);
  for (let k = 1; k < n; k++) L.join(st, 'u' + k, 'P' + k, t + k);
  if (mode) L.settings(st, 'u0', { mode });
  return st;
}
let st = room(1);
ok(L.join(st, 'u1', '   ', t) !== true, 'join needs a name');
ok(L.start(st, 'u0', t, C) !== true, 'cannot start alone');
L.join(st, 'u1', '지영', t);
ok(L.ids(st).length === 2 && st.players.u1.c !== st.players.u0.c, 'second player joins with another colour');
ok(L.settings(st, 'u1', { dur: 60 }) !== true, 'only the host changes settings');
L.settings(st, 'u0', { mode: 'constructor', dur: 99999, radius: 10, reveal: 30, hide: 5 });
eq([st.set.mode, st.set.dur, st.set.radius, st.set.reveal, st.set.hide], ['classic', 7200, 50, 30, 5], 'settings are validated and clamped');
ok(L.start(st, 'u0', t, null) !== true, 'start needs a centre');
L.setFixed(st, 'u0', 'u1', true);
ok(L.start(st, 'u0', t, C) === true && st.players.u1.role === 'S' && st.players.u0.role === 'H', 'fixed seeker gets the seeker role');
ok(L.join(st, 'u9', 'late', t) !== true, 'no joining mid-game');

// classic timeline, zone, reveals
st = room(4); L.settings(st, 'u0', { dur: 400, hide: 60, reveal: 60, radius: 800, stages: 3, seekers: 1 });
L.start(st, 'u0', t, C, () => 0);
eq(['u0', 'u1', 'u2', 'u3'].map(u => st.players[u].role).filter(r => r === 'S').length, 1, 'one seeker');
const S = L.ids(st).find(u => st.players[u].role === 'S'), Hs = L.ids(st).filter(u => u !== S);
eq([L.phase(st, t + 1000), L.phase(st, t + 61000), L.phase(st, t + 461000)], ['hide', 'play', 'ending'], 'hide → play → ending');
eq([L.zone(st, t).r, L.zone(st, t + 60000 + 100000).r, L.zone(st, t + 60000 + 400000 - 1).r], [800, 600, 200], 'zone shrinks to a quarter in 3 steps');
ok(L.zone(st, t + 60000 + 50000).next === t + 60000 + 100000, 'next shrink time');
eq([L.revealK(st, t + 30000), L.revealK(st, t + 125000)], [0, 1], 'reveal count');
ok(L.doCatch(st, S, Hs[0], t + 30000) !== true, 'no catching while hiding');
ok(L.doCatch(st, Hs[0], Hs[1], t + 70000) !== true, 'hiders cannot catch');
ok(L.ping(st, 1, { [Hs[0]]: C }) === true && L.ping(st, 1, {}) !== true && st.pings.locs[Hs[0]].lat === C.lat, 'reveal recorded once');
ok(L.manualPing(st, S, Hs[1], p500, t + 70000) === true && L.manualPing(st, S, Hs[2], p500, t + 80000) !== true, 'manual ping has a cooldown');
ok(L.doCatch(st, S, Hs[0], t + 70000) === true && st.players[Hs[0]].out && st.catches[S] === 1, 'classic: caught hider is out');
ok(L.doCatch(st, S, Hs[0], t + 71000) !== true, 'cannot catch twice');
ok(L.finish(st, t + 100000) !== true, 'not over before time');
L.finish(st, t + 461000);
ok(st.phase === 'over' && st.end.win === 'H', 'classic: hiders left at time up → hiders win');
const sum = L.summary(st);
ok(sum.caught === 1 && sum.total === 3 && sum.seekers[0].mvp, 'summary counts catches and MVP');
ok(L.reset(st, 'u0') === true && st.phase === 'lobby' && !st.players.u1.role, 'host resets to lobby');

st = room(2); L.settings(st, 'u0', { hide: 0 }); L.start(st, 'u0', t, C, () => 0);
const s2 = L.ids(st).find(u => st.players[u].role === 'S'), h2 = L.ids(st).find(u => st.players[u].role === 'H');
L.doCatch(st, s2, h2, t + 1000);
ok(st.phase === 'over' && st.end.win === 'S' && st.end.why === 'all', 'classic: everyone caught → seekers win at once');

// zombie
st = room(4, 'zombie'); L.settings(st, 'u0', { hide: 0, seekers: 1 }); L.start(st, 'u0', t, C, () => 0);
const z = L.ids(st).find(u => st.players[u].role === 'S'), zh = L.ids(st).filter(u => u !== z);
L.doCatch(st, z, zh[0], t + 1000);
ok(st.players[zh[0]].role === 'S' && !st.players[zh[0]].out, 'zombie: the caught one becomes a zombie');
ok(L.doCatch(st, zh[0], zh[1], t + 2000) === true, 'zombie: new zombies catch too');
L.doCatch(st, z, zh[2], t + 3000);
ok(st.phase === 'over' && st.end.win === 'S' && L.summary(st).caught === 3, 'zombie: no survivors → zombies win');

// cops and robbers
st = room(4, 'cops'); L.settings(st, 'u0', { hide: 0, seekers: 1 }); L.start(st, 'u0', t, C, () => 0);
const cop = L.ids(st).find(u => st.players[u].role === 'S'), rb = L.ids(st).filter(u => u !== cop);
L.doCatch(st, cop, rb[0], t + 1000); L.doCatch(st, cop, rb[1], t + 2000);
ok(st.players[rb[0]].out && st.players[rb[1]].out && st.phase === 'run', 'cops: caught robbers go to jail');
ok(L.rescue(st, rb[0], t + 3000) !== true, 'cops: a jailed robber cannot free the jail');
ok(L.rescue(st, rb[2], t + 3000) === true && !st.players[rb[0]].out && !st.players[rb[1]].out && st.rescues[rb[2]] === 2, 'cops: a free robber frees everyone');
for (const r of rb) L.doCatch(st, cop, r, t + 5000);
ok(st.phase === 'over' && st.end.win === 'S', 'cops: all robbers jailed → cops win');

// leaving
st = room(3); L.settings(st, 'u0', { hide: 0, seekers: 1 }); L.start(st, 'u0', t, C, () => 0);
const sk = L.ids(st).find(u => st.players[u].role === 'S');
L.leave(st, sk, t + 1000);
ok(st.phase === 'over' && st.end.win === 'H', 'the only seeker leaving ends the game');
st = room(3); L.leave(st, 'u0', t);
ok(!st.players.u0 && st.host === 'u1', 'host leaving the lobby hands the room on');

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
