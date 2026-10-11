/* probe: run the real qe-e2e 'T' lab evaluate verbatim on the real page,
   with the real DRIVER injected — dump the blk leg's actual resolution. */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import puppeteer from 'puppeteer-core';

const ROOT = new URL('.', import.meta.url).pathname;
const src = readFileSync(ROOT + 'test/qe-e2e.mjs', 'utf8');
const DRIVER = src.slice(src.indexOf('const DRIVER = `') + 16, src.indexOf('`;', src.indexOf('const DRIVER = `')));

const alive = await fetch('http://127.0.0.1:8890/').then(() => true).catch(() => false);
let srv = null;
if (!alive) {
  srv = spawn('node', ['server.mjs'], { cwd: ROOT, env: { ...process.env, PORT: '8890' } });
  await new Promise(r => setTimeout(r, 900));
}
const pg = await (await puppeteer.launch({
  executablePath: '/usr/bin/chromium',
  args: ['--no-sandbox', '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    '--enable-unsafe-swiftshader', '--mute-audio'],
})).newPage();
pg.on('pageerror', e => console.log('PAGEERR', String(e)));
await pg.setViewport({ width: 1280, height: 800 });
await pg.goto('http://127.0.0.1:8890/boxing.html?notrack=1', { waitUntil: 'domcontentloaded' });
await pg.waitForFunction('window.__boxing && window.__boxing.fight', { timeout: 30000 });
await pg.evaluate(DRIVER);

const lab = await pg.evaluate(`(() => {
  const Q = window.__qe, B = window.__boxing, st = B.state;
  for (let i = 0; i < 40 && st.phase !== 'fighting'; i++) Q.step(10);
  B.fight.opts.ai = false;
  const T = B.fight._T;
  const inRange = () => {
    const P = B.sim.player.pos, N = B.sim.npc.pos;
    const d = Math.hypot(N.x - P.x, N.z - P.z) || 1;
    N.x = P.x + (N.x - P.x) / d; N.z = P.z + (N.z - P.z) / d;
  };
  inRange();
  const expectScore = lb => Math.round(lb.dmg * T.score.hitMul
    * (1 + Math.min(5, lb.combo - 1) * .15));
  const swing = (side = 'left') => {
    for (let t = 0; t < 6; t++) {
      inRange();
      if (st.npc.action === 'hurt') { Q.step(24); continue; }
      const s0 = st.player.score, m = Q.mark();
      Q.punch(side);
      const lb = Q.lastBlow;
      if (lb?.who === 'player' && lb.result === 'hit')
        return { ok: true, lb: { kind: lb.kind, dmg: lb.dmg, counter: !!lb.counter,
          combo: lb.combo }, s0, s1: st.player.score,
          ev: Q.got.slice(m), combo: st.player.combo, counterT: st.player.counterT };
    }
    return { ok: false, lb: Q.lastBlow };
  };
  const out = { hits: [] };

  for (let i = 0; i < 4; i++) {
    const h = swing(i % 2 ? 'right' : 'left');
    if (!h.ok) { out.broken = true; break; }
    const want = expectScore(h.lb);
    out.hits.push({ i, combo: h.lb.combo, delta: h.s1 - h.s0, want,
      counter: h.lb.counter, ev: h.ev.filter(e => e === 'player-hit' || e === 'npc-hit').length });
  }
  out.chainOk = out.hits.length === 4
    && out.hits.every((h, i) => h.combo === i + 1 && h.delta === h.want
      && !h.counter && h.ev === 2)
    && st.player.bestCombo >= 4;

  Q.step(140);
  const after = swing('left');
  out.expOk = after.ok && after.lb.combo === 1 && after.combo === 1
    && after.s1 - after.s0 === expectScore(after.lb);

  let dodged = null;
  for (let i = 0; i < 120 && !B.fight.throwPunch('jab', 'left'); i++) Q.step(3);
  for (let i = 0; i < 120 && st.npc.action !== 'punch'; i++) Q.step(1);
  const dm = Q.mark();
  Q.step(1, { dodge: 1 });
  for (let i = 0; i < 90 && !Q.saw('perfect-dodge', dm) && st.phase === 'fighting'; i++) Q.step(1);
  dodged = { perfect: Q.saw('perfect-dodge', dm), counterT: st.player.counterT,
    score: st.player.score };
  const cHit = swing('right');
  out.counterOk = dodged.perfect && dodged.counterT > 1 && cHit.ok
    && cHit.lb.counter === true && cHit.ev.includes('counter')
    && cHit.s1 - cHit.s0 === expectScore(cHit.lb);
  Q.step(140);
  const exp2 = swing('left');
  out.counterExpOk = exp2.ok && exp2.lb.counter === false
    && exp2.s1 - exp2.s0 === expectScore(exp2.lb);

  const far = (() => {
    const s0 = st.player.score, c0 = st.player.combo, m = Q.mark();
    const N = B.sim.npc.pos; N.x += 6;
    Q.punch('left'); inRange();
    const lb = Q.lastBlow;
    return { delta: st.player.score - s0, combo: st.player.combo, was: c0,
      miss: lb?.result === 'miss', sawMiss: Q.saw('player-miss', m) };
  })();
  out.whiffOk = far.miss && far.sawMiss && far.delta === 0 && far.combo === far.was;
  const blk = (() => {
    inRange();
    const bT = T.blockT; T.blockT = 9;
    st.npc.action = 'block'; st.npc.actionT = 0;
    st.player.stamina = 1;
    const s0 = st.player.score, c0 = st.player.combo, m = Q.mark();
    /* step-by-step trace: lastBlow + npc action sampled EVERY step */
    const trace = [];
    const SH = [[0,1.15],[.55,.78],[.8,.5],[1,.32],[1.12,.18],[.36,-.12],[.4,-.4],[.42,-.6],[.44,-.74],
      [0,-.2],[0,-.48],[0,-.7],[0,-.86],[-.34,-.12],[-.38,-.36],[-.4,-.55],[-.42,-.68],
      [-.6,-.05],[-.66,-.26],[-.7,-.42],[-.72,-.52]];
    const lmFist = (cx, cy, s) => SH.map(([x, y]) => ({ x: cx + x * s, y: cy + y * s, z: 0 }));
    const hand = (side, cx, cy, s) => ({ side, kind: 'fist', lm: lmFist(cx, cy, s),
      palm: { x: cx, y: cy }, wrist: { x: cx, y: cy + s * 1.15 },
      indexTip: { x: cx + s * .4, y: cy - s * .7 }, pinchAt: { x: cx + s * .6, y: cy - s * .4 },
      pinchD: .2, nExt: 0, nExtAll: 0 });
    const HS = h => ({ hands: h, pinch: null, point: null, orbit: null, zoom: null, spread: null });
    let i = 0;
    for (const s of [.04, .055, .07, .09, .11]) {
      Q.hands(HS([hand('left', .38, .55, s)]));
      for (let k = 0; k < 6; k++) {
        const o = Q.step(1);
        if (o?.lastBlow || st.npc.action !== 'block')
          trace.push({ i: i++, lb: o?.lastBlow?.result, act: st.npc.action, actT: +st.npc.actionT.toFixed(2), ph: st.phase });
      }
    }
    Q.hands(HS([hand('left', .38, .55, .11)]));
    for (let k = 0; k < 22; k++) {
      const o = Q.step(1);
      if (o?.lastBlow || st.npc.action !== 'block')
        trace.push({ i: i++, lb: o?.lastBlow?.result, act: st.npc.action, actT: +st.npc.actionT.toFixed(2), ph: st.phase });
    }
    Q.hands(Q.EMPTY); Q.step(10);
    T.blockT = bT;
    const lb = Q.lastBlow;
    st.npc.action = 'idle';
    return { delta: st.player.score - s0, combo: st.player.combo, was: c0,
      blocked: lb?.result === 'blocked', saw: Q.saw('npc-blocked', m),
      res: lb?.result, why: lb?.reason, trace: trace.slice(0, 12) };
  })();
  out.blockOk = blk.blocked && blk.saw && blk.delta === 0 && blk.combo === blk.was;
  out.blk = blk;
  out.npcHp = st.npc.hp; out.playerHp = st.player.hp;
  return out;
})()`);
console.log(JSON.stringify(lab, null, 1));
await pg.close(); srv?.kill();
process.exit(0);
