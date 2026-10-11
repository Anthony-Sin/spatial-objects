/* verify rise-lab.html: no page errors, inject-punch tags, touch-tags work
   through the real hand state, a depth punch emits + can tag. */
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer-core';

const ROOT = new URL('.', import.meta.url).pathname;
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
const errors = [];
pg.on('pageerror', e => errors.push(String(e)));
await pg.setViewport({ width: 1280, height: 800 });
await pg.goto('http://127.0.0.1:8890/rise-lab.html?nocam=1', { waitUntil: 'domcontentloaded' });
await pg.waitForFunction(() => window.__lab?.fight?.state?.rise?.active, { timeout: 8000 });

const snap = () => pg.evaluate(() => {
  const L = window.__lab, s = L.fight.state;
  return { phase: s.phase, active: s.rise.active, got: s.rise.got, need: s.rise.need,
    punch: L.cnt.punch, tag: L.cnt.tag, miss: L.cnt.miss + L.cnt.nopos,
    up: L.cnt.up, out: L.cnt.out };
});

const s0 = await snap();
console.log('armed:', JSON.stringify(s0));

/* 1 — inject a punch dead-center on the ring → tag */
await pg.evaluate(() => { const r = window.__lab.fight.state.rise; window.__injectPunch(r.x, r.y); });
await new Promise(r => setTimeout(r, 300));
const s1 = await snap();
console.log('inject hit:', JSON.stringify(s1));

/* 2 — off-target inject → miss */
await pg.evaluate(() => window.__injectPunch(0.02, 0.02));
await new Promise(r => setTimeout(r, 300));
const s2 = await snap();
console.log('inject miss:', JSON.stringify(s2));

/* 3 — touch path: a STATIC fist (no span growth → no punch emit) held away,
   then moved onto the ring → entry-edge touch tag */
const touch = await pg.evaluate(async () => {
  const lmFist = (cx, cy, s) => {
    const SH = [[0,1.15],[.55,.78],[.8,.5],[1.0,.32],[1.12,.18],
      [.36,-.12],[.4,-.4],[.42,-.6],[.44,-.74],
      [0,-.2],[0,-.48],[0,-.7],[0,-.86],
      [-.34,-.12],[-.38,-.36],[-.4,-.55],[-.42,-.68],
      [-.6,-.05],[-.66,-.26],[-.7,-.42],[-.72,-.52]];
    return SH.map(([x, y]) => ({ x: cx + x * s, y: cy + y * s, z: 0 }));
  };
  const set = (side, cx, cy, s) => window.__forceHands = s
    ? { hands: [{ side, kind: 'fist', lm: lmFist(cx, cy, s), palm: { x: cx, y: cy },
        wrist: { x: cx, y: cy + s * 1.15 }, indexTip: { x: cx, y: cy - s * .7 },
        pinchAt: { x: cx, y: cy }, pinchD: .2, nExt: 0, nExtAll: 0 }],
        pinch: null, point: null, orbit: null, zoom: null, spread: null }
    : { hands: [], pinch: null, point: null, orbit: null, zoom: null, spread: null };
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const L = window.__lab, r0 = L.fight.state.rise;
  const p0 = L.cnt.punch, g0 = L.fight.state.rise.got;
  set('left', .05, .05, .07); await sleep(250);            // parked outside
  set('left', r0.x, r0.y, .07); await sleep(250);          // moved ONTO the ring —
                                                         // span unchanged → no
                                                         // punch, touch must tag
  const out = { got: L.fight.state.rise.got, punch: L.cnt.punch, p0, g0 };
  set(null); await sleep(150);
  return out;
});
console.log('touch path:', JSON.stringify(touch));

/* 4 — real depth punch AWAY from the ring → emits a punch + rise-miss (not tag) */
const punchAway = await pg.evaluate(async () => {
  const lmFist = (cx, cy, s) => {
    const SH = [[0,1.15],[.55,.78],[.8,.5],[1.0,.32],[1.12,.18],
      [.36,-.12],[.4,-.4],[.42,-.6],[.44,-.74],
      [0,-.2],[0,-.48],[0,-.7],[0,-.86],
      [-.34,-.12],[-.38,-.36],[-.4,-.55],[-.42,-.68],
      [-.6,-.05],[-.66,-.26],[-.7,-.42],[-.72,-.52]];
    return SH.map(([x, y]) => ({ x: cx + x * s, y: cy + y * s, z: 0 }));
  };
  const set = (side, cx, cy, s) => window.__forceHands = s
    ? { hands: [{ side, kind: 'fist', lm: lmFist(cx, cy, s), palm: { x: cx, y: cy },
        wrist: { x: cx, y: cy + s * 1.15 }, indexTip: { x: cx, y: cy - s * .7 },
        pinchAt: { x: cx, y: cy }, pinchD: .2, nExt: 0, nExtAll: 0 }],
        pinch: null, point: null, orbit: null, zoom: null, spread: null }
    : { hands: [], pinch: null, point: null, orbit: null, zoom: null, spread: null };
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const L = window.__lab, r = L.fight.state.rise;
  const p0 = L.cnt.punch, m0 = L.cnt.miss + L.cnt.nopos, g0 = L.fight.state.rise.got;
  const tx = r.x > .5 ? .1 : .9, ty = r.y > .5 ? .1 : .9;   // opposite corner —
                                                         // min norm dist ≥ .13 > r
  for (const s of [.04, .055, .07, .09, .11]) { set('left', tx, ty, s); await sleep(80); }
  await sleep(400);                                         // apex → emit
  set(null); await sleep(150);
  return { emitted: L.cnt.punch - p0, missed: (L.cnt.miss + L.cnt.nopos) - m0,
    got: L.fight.state.rise.got, g0 };
});
console.log('punch-away:', JSON.stringify(punchAway));

/* 5 — finish via touches → revive, then auto re-arm */
await pg.evaluate(async () => {
  const L = window.__lab, sleep = ms => new Promise(r => setTimeout(r, ms));
  const lmFist = (cx, cy, s) => Array.from({ length: 21 },
    (_, i) => ({ x: cx + (i % 5 - 2) * s * .3, y: cy + (i / 5 | 0 - 2) * s * .3, z: 0 }));
  const set = (cx, cy) => window.__forceHands =
    { hands: [{ side: 'left', kind: 'fist', lm: lmFist(cx, cy, .07), palm: { x: cx, y: cy },
        wrist: { x: cx, y: cy }, indexTip: { x: cx, y: cy }, pinchAt: { x: cx, y: cy },
        pinchD: .2, nExt: 0, nExtAll: 0 }],
      pinch: null, point: null, orbit: null, zoom: null, spread: null };
  for (let i = 0; i < 14 && L.fight.state.phase === 'playerdown'; i++) {
    set(.05, .05); await sleep(60);                          // out
    const r = L.fight.state.rise; set(r.x, r.y); await sleep(60); // on
  }
  window.__forceHands = { hands: [] };
});
await new Promise(r => setTimeout(r, 500));
const s5 = await snap();
console.log('after touches:', JSON.stringify(s5));
await pg.screenshot({ path: '/tmp/lab1.png' });
await new Promise(r => setTimeout(r, 1900));
const s6 = await snap();
console.log('re-armed:', JSON.stringify(s6));

console.log('pageerrors:', errors.length ? errors : 'none');
const ok = s0.active && s1.got === 1 && s2.miss === 1
  && touch.got === touch.g0 + 1 && touch.punch === touch.p0   // touch tagged, no punch
  && punchAway.emitted >= 1 && punchAway.missed >= 1 && punchAway.got === punchAway.g0
  && s5.up === 1 && s6.active && s6.phase === 'playerdown' && errors.length === 0;
console.log(ok ? 'LAB OK' : 'LAB FAIL');
srv?.kill(); await pg.browser().close();
process.exit(ok ? 0 : 1);
