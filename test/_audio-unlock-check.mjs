/* audio unlock verification — boots boxing.html?notrack=1 + index.html,
   instruments AudioContext/createGain/createOscillator, asserts:
     1. a keypress DURING boot is captured → its ctx adopted by BoxingAudio
        (exactly ONE AudioContext exists total, state running)
     2. countdown/fight events actually schedule voices (oscs > 0) with no
        further gesture — the old code stayed silent until a late gesture
     3. menu: first click → crowd bed running on the adopted ctx */
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = '/home/ANT/unclockable-knighthacks-2026/spatial-objects';
const results = [];
const check = (name, ok, info = '') => {
  results.push([name, ok]);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${info ? '  — ' + info : ''}`);
};

const alive = await fetch('http://127.0.0.1:8890/').then(() => true).catch(() => false);
let srv = null;
if (!alive) {
  srv = spawn('node', ['server.mjs'], { cwd: ROOT, env: { ...process.env, PORT: '8890' }, stdio: 'ignore' });
  await new Promise(r => setTimeout(r, 1200));
}

const b = await puppeteer.launch({ executablePath: '/usr/bin/chromium', headless: 'new',
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--mute-audio'] });
    // real autoplay policy stays ON — a ctx built outside a gesture would
    // report 'suspended' and fail the 'running' assertions below

/* instrument before any page script runs */
const hook = () => {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC || AC.prototype.__hooked) return;
  window.__ctxs = []; window.__gains = []; window.__oscs = [];
  const og = AC.prototype.createGain, oo = AC.prototype.createOscillator;
  AC.prototype.createGain = function () { const g = og.call(this); window.__gains.push({ ctx: this, g }); return g; };
  AC.prototype.createOscillator = function () { const o = oo.call(this); window.__oscs.push(o); return o; };
  const Orig = AC;
  window.AudioContext = function (...a) { const c = new Orig(...a); window.__ctxs.push(c); return c; };
  window.AudioContext.prototype = Orig.prototype;
  AC.prototype.__hooked = true;
};

/* ---------- fight page: gesture DURING boot must count ---------- */
{
  const pg = await b.newPage();
  await pg.setViewport({ width: 1280, height: 800 });
  await pg.evaluateOnNewDocument(hook);
  const errs = [];
  pg.on('pageerror', e => errs.push(e.message));
  await pg.goto('http://127.0.0.1:8890/boxing.html?notrack=1', { waitUntil: 'domcontentloaded' });
  // spam a key every 150ms until the game exists — at least one lands mid-boot
  for (let i = 0; i < 30; i++) {
    if (await pg.evaluate(() => !!(window.__boxing && window.__boxing.fight)).catch(() => false)) break;
    await pg.keyboard.press('x');
    await new Promise(r => setTimeout(r, 150));
  }
  await pg.waitForFunction('window.__boxing && window.__boxing.fight', { timeout: 30000 });
  await new Promise(r => setTimeout(r, 800));          // let the audio init run
  const st = await pg.evaluate(() => ({
    ctxs: window.__ctxs.length,
    states: window.__ctxs.map(c => c.state),
    gains: window.__gains.length,
    oscs: window.__oscs.length,
    hint: document.querySelector('[data-callout]')?.textContent || '',
  }));
  check('exactly one AudioContext for the whole page', st.ctxs === 1, JSON.stringify(st));
  check('adopted ctx is running', st.states[0] === 'running', st.states.join(','));
  check('BoxingAudio master gain built on it (≥1 gain)', st.gains >= 1, `gains=${st.gains}`);

  // countdown/round-start events schedule voices with NO further gesture
  await pg.waitForFunction(() => window.__oscs.length > 0, { timeout: 15000 }).catch(() => {});
  const oscs = await pg.evaluate(() => window.__oscs.length);
  check('fight SFX schedule voices after early unlock (oscs > 0)', oscs > 0, `oscs=${oscs}`);
  check('no page errors', errs.length === 0, errs.slice(0, 2).join(' | ') || 'clean');
  await pg.close();
}

/* ---------- fight page: a LATE first gesture resumes the parked ctx ---------- */
{
  const pg = await b.newPage();
  await pg.evaluateOnNewDocument(hook);
  await pg.goto('http://127.0.0.1:8890/boxing.html?notrack=1', { waitUntil: 'domcontentloaded' });
  await pg.waitForFunction('window.__boxing && window.__boxing.fight', { timeout: 30000 });
  await new Promise(r => setTimeout(r, 800));
  const pre = await pg.evaluate(() => ({ ctxs: window.__ctxs.length,
    state: window.__ctxs[0]?.state }));
  await pg.keyboard.press('x');
  await new Promise(r => setTimeout(r, 400));
  const post = await pg.evaluate(() => ({ ctxs: window.__ctxs.length,
    state: window.__ctxs[0]?.state, gains: window.__gains.length }));
  check('exactly one ctx, grabbed eagerly at boot', pre.ctxs === 1
    && (pre.state === 'suspended' || pre.state === 'running'), JSON.stringify(pre));
  check('first gesture resumes it (still 1 ctx, running)', post.ctxs === 1 && post.state === 'running',
    JSON.stringify(post));
  await pg.close();
}

/* ---------- menu: first click unlocks bed + the looping tune ---------- */
{
  const pg = await b.newPage();
  await pg.evaluateOnNewDocument(hook);
  const errs = [];
  pg.on('pageerror', e => errs.push(e.message));
  await pg.goto('http://127.0.0.1:8890/index.html', { waitUntil: 'domcontentloaded' });
  await new Promise(r => setTimeout(r, 600));
  await pg.mouse.click(640, 400);                       // first gesture on the menu
  await new Promise(r => setTimeout(r, 900));           // module import + unlock + beds
  const st = await pg.evaluate(() => ({
    ctxs: window.__ctxs.length, state: window.__ctxs[0]?.state,
    oscs: window.__oscs.length, gains: window.__gains.length,
  }));
  check('menu: one ctx, running after first click', st.ctxs === 1 && st.state === 'running', JSON.stringify(st));
  check('menu: crowd bed + tune voices wired (≥3 gains)', st.gains >= 3, `gains=${st.gains}`);
  /* the tune loops — voices must keep accumulating without further input */
  const o1 = await pg.evaluate(() => window.__oscs.length);
  await new Promise(r => setTimeout(r, 1100));          // ~5 16th-steps at 132bpm
  const o2 = await pg.evaluate(() => window.__oscs.length);
  check('menu: tune scheduler keeps scheduling (loop alive)', o2 > o1 + 4, `oscs ${o1}→${o2}`);
  check('menu: no page errors', errs.length === 0, errs.slice(0, 2).join(' | ') || 'clean');
  await pg.close();
}

/* ---------- lineup: tune carries over + per-rival select blips ---------- */
{
  const pg = await b.newPage();
  await pg.evaluateOnNewDocument(hook);
  const errs = [];
  pg.on('pageerror', e => errs.push(e.message));
  await pg.goto('http://127.0.0.1:8890/lineup.html', { waitUntil: 'domcontentloaded' });
  await new Promise(r => setTimeout(r, 900));
  await pg.mouse.click(640, 500);                       // first gesture → unlock
  await new Promise(r => setTimeout(r, 900));
  const st = await pg.evaluate(() => ({
    ctxs: window.__ctxs.length, state: window.__ctxs[0]?.state,
    oscs: window.__oscs.length }));
  check('lineup: ctx running after first gesture', st.state === 'running', JSON.stringify(st));
  const l1 = await pg.evaluate(() => window.__oscs.length);
  await new Promise(r => setTimeout(r, 1100));
  const l2 = await pg.evaluate(() => window.__oscs.length);
  check('lineup: the tune loop is alive here too', l2 > l1 + 4, `oscs ${l1}→${l2}`);
  /* chip click → per-rival FM blip (2 oscs: carrier+mod); key nav → another */
  const b1 = await pg.evaluate(() => window.__oscs.length);
  await pg.click('.chip[data-idx="1"]').catch(() => {});
  await new Promise(r => setTimeout(r, 300));
  const b2 = await pg.evaluate(() => window.__oscs.length);
  await pg.keyboard.press('ArrowLeft');
  await new Promise(r => setTimeout(r, 300));
  const b3 = await pg.evaluate(() => window.__oscs.length);
  check('lineup: chip select fires a rival blip', b2 > b1, `oscs ${b1}→${b2}`);
  check('lineup: arrow-key select fires a rival blip', b3 > b2, `oscs ${b2}→${b3}`);
  check('lineup: no page errors', errs.length === 0, errs.slice(0, 2).join(' | ') || 'clean');
  await pg.close();
}

await b.close();
srv?.kill();
const failed = results.filter(r => !r[1]);
console.log(failed.length ? `${failed.length} check(s) FAILED` : 'ALL CHECKS PASSED');
process.exit(failed.length ? 1 : 0);
