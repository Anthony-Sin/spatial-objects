/* does a link-click navigation carry user activation into boxing.html?
   lineup.html → real <a> click → boxing.html: if Chrome propagates sticky
   activation, the page's eagerly-created AudioContext reports 'running'
   and fight SFX schedule with ZERO gestures on the fight page itself. */
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';

const ROOT = '/home/ANT/unclockable-knighthacks-2026/spatial-objects';
const alive = await fetch('http://127.0.0.1:8890/').then(() => true).catch(() => false);
let srv = null;
if (!alive) {
  srv = spawn('node', ['server.mjs'], { cwd: ROOT, env: { ...process.env, PORT: '8890' }, stdio: 'ignore' });
  await new Promise(r => setTimeout(r, 1200));
}
const b = await puppeteer.launch({ executablePath: '/usr/bin/chromium', headless: 'new',
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--mute-audio'] });
const pg = await b.newPage();
await pg.evaluateOnNewDocument(() => {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC || AC.prototype.__hooked) return;
  window.__ctxs = []; window.__nodes = {};
  const Orig = AC;
  window.AudioContext = function (...a) { const c = new Orig(...a); window.__ctxs.push(c); return c; };
  window.AudioContext.prototype = Orig.prototype;
  for (const k of ['createGain', 'createOscillator', 'createBufferSource',
                   'createDynamicsCompressor', 'createBiquadFilter']) {
    const orig = Orig.prototype[k];
    if (orig) Orig.prototype[k] = function (...a) {
      window.__nodes[k] = (window.__nodes[k] || 0) + 1;
      return orig.apply(this, a);
    };
  }
  AC.prototype.__hooked = true;
});
await pg.goto('http://127.0.0.1:8890/lineup.html', { waitUntil: 'domcontentloaded' });
await new Promise(r => setTimeout(r, 800));
await Promise.all([
  pg.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }),
  pg.click('[data-enter]'),
]);
// wrap fight._emit once the game object exists
let wrapped = false;
let st = null;
for (let i = 0; i < 40; i++) {
  await new Promise(r => setTimeout(r, 500));
  st = await pg.evaluate(() => {
    const f = window.__boxing?.fight;
    if (f && !f.__emitWrapped) {
      const orig = f._emit?.bind?.(f);
      if (orig) {
        window.__evts = {};
        f._emit = (n, ...a) => { window.__evts[n] = (window.__evts[n] || 0) + 1; return orig(n, ...a); };
        f.__emitWrapped = true;
      }
    }
    return {
      ctxs: window.__ctxs.length, states: window.__ctxs.map(c => c.state),
      nodes: window.__nodes, evts: window.__evts || null,
      hasBeenActive: navigator.userActivation?.hasBeenActive,
      phase: window.__boxing?.state?.phase || '?',
    };
  });
  if ((st.nodes?.createOscillator || 0) > 0) break;
}
console.log('final:', JSON.stringify(st, null, 1));
await b.close();
srv?.kill();
