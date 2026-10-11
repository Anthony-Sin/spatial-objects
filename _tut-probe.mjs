/* probe the C-section tutorial flake: instrument Tutorial._pass/_finish to
   catch a pass landing after the endcard snapshot. Reuses the real DRIVER. */
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
    '--use-fake-device-for-media-stream', '--enable-unsafe-swiftshader', '--mute-audio'],
})).newPage();
pg.on('pageerror', e => console.log('PAGEERR', String(e)));
await pg.setViewport({ width: 1280, height: 800 });
await pg.goto('http://127.0.0.1:8890/boxing.html?notrack=1&practice=1', { waitUntil: 'domcontentloaded' });
await pg.waitForFunction('window.__boxing && window.__boxing.fight', { timeout: 30000 });
await pg.evaluate(DRIVER);
/* the tutorial only engages under practice/tutorial mode — ?practice=1 gives us
   B.tutor without NPC interference */
await pg.waitForFunction('window.__boxing.tutor', { timeout: 8000 }).catch(() => {});

const log = await pg.evaluate(async () => {
  const Q = window.__qe, B = window.__boxing, T = B.tutor;
  if (!T) return { err: 'no tutor on ?practice=1' };
  const L = [];
  const op = T._pass.bind(T), of = T._finish.bind(T);
  T._pass = now => { L.push(`pass ${T.step?.id} i=${T.i} done=${T.done} t=${now.toFixed(2)}`); return op(now); };
  T._finish = () => { L.push(`FINISH i=${T.i} passed=${T.passed.length}`); return of(); };

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  let side = 0;
  const settle = async () => {
    Q.face(Q.NEUTRAL);
    for (let i = 0; i < 90 && Math.abs(B.tracker.sway) > .12; i++) Q.step(1);
  };
  const t0 = performance.now();
  for (let i = 0; i < 1200 && !(T && T.done); i++) {
    const st = B.state;
    if (st.phase !== 'fighting') { await sleep(120); Q.step(6); continue; }
    const s = T.step;
    if (!s || T.niceUntil) { await sleep(160); Q.step(4); continue; }
    const tg = st.npc.telegraph, a = st.npc.action;
    B.moveKeys.guard = s.id === 'block';
    if (s.id === 'punch') {
      if (Q.dist() > 1.4) Q.step(6, { step: 1 }); else Q.punch(side++ % 2 ? 'right' : 'left');
    } else if (s.id === 'block') {
      if (a === 'windup' || a === 'punch') Q.step(4, { guard: true });
      else { Q.step(4); await sleep(100); }
    } else if (s.id === 'slip') {
      if (tg && tg.t01 >= .45) Q.face(Q.FACE(.12, .45));
      else if (a !== 'windup' && a !== 'punch') await settle();
      Q.step(2); await sleep(40);
    } else if (s.id === 'duck') {
      if (tg && tg.t01 >= .5) Q.step(2, { duck: 1 });
      else { Q.step(4); await sleep(50); }
    } else if (s.id === 'move') {
      Q.step(40, { step: 1 }); await sleep(30);
    } else if (s.id === 'perfect') {
      if (a === 'stunned') { await settle(); if (Q.dist() > 1.4) Q.step(6, { step: 1 }); else Q.punch(side++ % 2 ? 'right' : 'left'); }
      else if (a === 'punch' && st.npc.actionT < .08) { Q.face(Q.FACE(.12, .45)); Q.step(1, { dodge: 1 }); }
      else if (tg && tg.t01 >= .9) Q.face(Q.FACE(.12, .45));
      else if (a === 'whiff' || (a === 'idle' && !tg)) await settle();
      Q.step(2); await sleep(35);
    } else { Q.step(4); await sleep(60); }
    if (performance.now() - t0 > 50000) break;
  }
  await sleep(300);
  return { L, passed: T.passed.slice(), done: T.done, i: T.i,
    title: document.querySelector('[data-endtitle]').textContent,
    sub: document.querySelector('[data-endsub]').textContent };
});
console.log(JSON.stringify(log, null, 1));
await pg.close(); srv?.kill();
process.exit(0);
