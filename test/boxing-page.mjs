/* test/boxing-page.mjs — puppeteer e2e for boxing.html.

   Serves the repo on :8890 itself if nothing is listening there yet
   (integrator may also pre-start `PORT=8890 node server.mjs`).

   Asserts:
     1. boxing.html loads with zero page errors
     2. window.__boxing debug handle exists (fight/sim/tracker)
     3. a scripted growing-hand punch through __forceHands emits a punch
     4. the NPC takes a hit (npc.hp < 100 or hit event in the log)
     5. sim.distance() shrinks while the NPC presses
   Screenshots to /tmp/boxing.png. Non-zero exit on any failure.
*/
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const URL_ = 'http://127.0.0.1:8890/boxing.html?notrack=1';   // skip camera/MediaPipe — __forceHands drives input
const results = [];
const check = (name, ok, info = '') => {
  results.push([name, ok]);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${info ? '  — ' + info : ''}`);
};

/* bring up a server if the port is dark */
const alive = await fetch('http://127.0.0.1:8890/').then(() => true).catch(() => false);
let srv = null;
if (!alive) {
  srv = spawn('node', ['server.mjs'], { cwd: ROOT, env: { ...process.env, PORT: '8890' },
    stdio: 'ignore' });
  await new Promise(r => setTimeout(r, 1200));
}

const b = await puppeteer.launch({ executablePath: '/usr/bin/chromium', headless: 'new',
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--mute-audio'] });
const pg = await b.newPage();
await pg.setViewport({ width: 1280, height: 800 });
const errs = [];
const BENIGN = /^INFO:|XNNPACK|TensorFlow|Created TensorFlow|GroupMarker/i;
pg.on('console', m => { if (m.type() === 'error' && !BENIGN.test(m.text())) errs.push(m.text()); });
pg.on('pageerror', e => errs.push(e.message));
await pg.goto(URL_, { waitUntil: 'domcontentloaded', timeout: 30000 });

let booted = true;
try {
  await pg.waitForFunction('window.__boxing && window.__boxing.fight', { timeout: 30000 });
} catch { booted = false; }
check('boxing.html boots; __boxing handle exists', booted);

if (booted) {
  await new Promise(r => setTimeout(r, 1500));
  const res = await pg.evaluate(async () => {
    const B = window.__boxing, sleep = ms => new Promise(r => setTimeout(r, ms));
    // same mitten-ish synthetic fist the page's mouse fallback uses
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
    const punch = async (side) => {
      // span swells (the throw), then the fist must STAY out ~350ms —
      // FistTracker emits at thrust apex / MAX_THROW_T, and a hand that
      // vanishes mid-throw cancels the punch instead of emitting it
      for (const s of [.04, .06, .085, .11]) { set(side, .35, .55, s); await sleep(70); }
      set(side, .35, .55, .11); await sleep(400);
      set(null); await sleep(120);
    };

    /* phase 1 — the page records sim.distance() every frame the NPC presses
       (its first press often lands before this evaluate even starts) */
    const press = { n: 0, d0: null, dMin: 99 };
    const t0 = performance.now();
    while (performance.now() - t0 < 14000) {
      const pl = B.pressLog || [];
      if (pl.length >= 5) {
        press.n = pl.length; press.d0 = pl[0];
        press.dMin = Math.min(...pl);
        if (press.dMin < press.d0 - .15 || pl.length > 40) break;
      }
      await sleep(120);
    }

    /* phase 2 — jab spam until the NPC feels it */
    let swung = 0;
    const hp0 = B.fight.state.npc.hp;
    const t1 = performance.now();
    while (performance.now() - t1 < 25000 &&
           B.fight.state.npc.hp >= hp0 &&
           !B.log.some(e => e === 'npc-hit' || e === 'player-hit')) {
      await punch(swung++ % 2 ? 'right' : 'left');
    }
    return {
      press, swung,
      sawPunch: B.log.includes('player-punch'),
      npcHit: B.log.some(e => e === 'npc-hit' || e === 'player-hit'),
      npcHp: B.fight.state.npc.hp, playerHp: B.fight.state.player.hp,
      phase: B.fight.state.phase, dist: B.sim.distance(),
      log: B.log.slice(-14), dbg: B.tracker.debug?.(),
    };
  });

  check('scripted growing-hand punch emits a punch event', res.sawPunch || res.npcHit,
    `swung ${res.swung}, log: ${res.log.join(',') || 'empty'}`);
  check('NPC takes a hit', res.npcHit || res.npcHp < 100, `npc.hp=${res.npcHp}`);
  check('sim.distance() shrinks while npc presses',
    res.press.n >= 5 && res.press.dMin < res.press.d0 - .1,
    `samples=${res.press.n} d0=${res.press.d0?.toFixed(2)} dMin=${res.press.dMin.toFixed(2)} phase=${res.phase}`);
}

check('zero page errors on load', errs.length === 0, errs.slice(0, 3).join(' | ') || 'clean');
await pg.screenshot({ path: '/tmp/boxing.png' });
await b.close();
srv?.kill();

const failed = results.filter(r => !r[1]);
console.log(failed.length ? `${failed.length} check(s) FAILED` : 'ALL CHECKS PASSED');
process.exit(failed.length ? 1 : 0);
