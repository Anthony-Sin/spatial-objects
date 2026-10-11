/* corner-break sequence check: wipe+recenter → coach → ROUND pop → countdown → fight */
import puppeteer from 'puppeteer-core';
import { setTimeout as delay } from 'node:timers/promises';

const base = process.env.BASE || 'http://127.0.0.1:8791';
const DRIVER = `(() => {
  if (window.__qe) return true;
  const EMPTY = { hands: [], pinch: null, point: null, orbit: null, zoom: null, spread: null };
  const Q = window.__qe = {
    EMPTY, got: [],
    step(n = 1, ctrl = {}) {
      const B = window.__boxing; let out = null;
      for (let i = 0; i < n; i++) {
        out = B.game.step(1 / 60, window.__forceHands || EMPTY, window.__forceFace || null, { mittOk: true, ...ctrl });
        if (out?.events?.length) this.got.push(...out.events);
      }
      this.out = out; return out?.state;
    },
    hands(v) { window.__forceHands = v; },
  };
  return true;
})()`;

const browser = await puppeteer.launch({
  executablePath: '/usr/bin/chromium', headless: 'new',
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--mute-audio'],
});
const pg = await browser.newPage();
await pg.setViewport({ width: 1280, height: 800 });
const errs = [];
pg.on('console', m => { if (m.type() === 'error' && !/Failed to load resource.*(50\d|404)/.test(m.text())) errs.push(m.text()); });
pg.on('pageerror', e => errs.push('pageerror: ' + e.message));

const ok = (name, cond, info = '') => console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${info ? '  — ' + info : ''}`);
const cls = sel => `document.querySelector('${sel}').classList.contains('on')`;

await pg.goto(`${base}/boxing.html?notrack=1&coach=1`, { waitUntil: 'domcontentloaded' });
await pg.waitForFunction('window.__boxing && window.__boxing.fight', { timeout: 30000 });
await pg.evaluate(DRIVER);
await delay(400);

// get to fighting, drag both fighters off their marks
const pre = await pg.evaluate(() => {
  const Q = window.__qe, B = window.__boxing;
  for (let i = 0; i < 40 && B.state.phase !== 'fighting'; i++) Q.step(10);
  const P = B.sim.player.pos, N = B.sim.npc.pos;
  const d = Math.hypot(N.x - P.x, N.z - P.z) || 1;
  N.x = P.x + (N.x - P.x) / d * 1.0; N.z = P.z + (N.z - P.z) / d * 1.0;
  P.x += 0.6;                                              // shove the player off its mark
  B.state.player.hp = 20;
  return { phase: B.state.phase, px: P.x, pz: P.z, nx: N.x, nz: N.z };
});
ok('reaches fighting with fighters off their marks', pre.phase === 'fighting', JSON.stringify(pre));

// the WIPE must fall first — before any coach card
const t0 = Date.now();
const seen = { wipeOn: 0, resetAt: 0, coachOn: 0, coachOff: 0, rpopOn: 0, rpopOff: 0, cdOn: 0, fighting: 0 };
try { await pg.waitForFunction(cls('[data-wipe]'), { timeout: 10000 }); seen.wipeOn = Date.now() - t0; } catch {}
ok('black wipe falls at the trigger (before the card)', seen.wipeOn > 0 && seen.wipeOn < 3000, `wipeOn=${seen.wipeOn}ms`);
const early = await pg.evaluate(() => ({
  coach: document.querySelector('[data-coach]').classList.contains('on'),
  rpop: document.querySelector('[data-roundpop]').classList.contains('on') }));
ok('no coach card or round card during the blackout', !early.coach && !early.rpop, JSON.stringify(early));

// positions should already be back at marks by the time the card opens
try { await pg.waitForFunction(cls('[data-coach]'), { timeout: 5000 }); seen.coachOn = Date.now() - t0; } catch {}
const pos = await pg.evaluate(() => {
  const B = window.__boxing, P = B.sim.player.pos, N = B.sim.npc.pos;
  return { px: +P.x.toFixed(2), pz: +P.z.toFixed(2), nx: +N.x.toFixed(2), nz: +N.z.toFixed(2),
    phase: B.state.phase, round: B.state.round };
});
seen.resetAt = seen.coachOn;
ok('coach card opens over the RESET marks (round-2 positions, not mid-frame)',
  seen.coachOn > seen.wipeOn && Math.abs(pos.px) < .05 && Math.abs(pos.pz - 2.0) < .05
  && Math.abs(pos.nx) < .05 && Math.abs(pos.nz + .4) < .05
  && pos.phase === 'countdown' && pos.round === 2,
  `coachOn=${seen.coachOn}ms ${JSON.stringify(pos)}`);

// skip the card — ROUND pop, then countdown only after the pop is gone
await pg.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
try { await pg.waitForFunction(`!${cls('[data-coach]')}`, { timeout: 3000 }); seen.coachOff = Date.now() - t0; } catch {}
try { await pg.waitForFunction(cls('[data-roundpop]'), { timeout: 3000 }); seen.rpopOn = Date.now() - t0; } catch {}
const rpTxt = await pg.evaluate(() => document.querySelector('[data-rpround]').textContent);
ok('ROUND 2 card pops when the coach card folds', seen.rpopOn >= seen.coachOff && rpTxt === 'ROUND 2',
  `txt="${rpTxt}" onAt=${seen.rpopOn}ms`);
try { await pg.waitForFunction(`!${cls('[data-roundpop]')}`, { timeout: 3000 }); seen.rpopOff = Date.now() - t0; } catch {}
try {
  await pg.waitForFunction(
    `window.__boxing.state.phase === 'countdown' && window.__boxing.state.countdown > 0`,
    { timeout: 3000 });
  seen.cdOn = Date.now() - t0;
} catch {}
ok('countdown appears only after the pop is gone',
  seen.rpopOff > 0 && seen.cdOn >= seen.rpopOff,
  `popOff=${seen.rpopOff}ms cdOn=${seen.cdOn}ms`);
try { await pg.waitForFunction(`window.__boxing.state.phase === 'fighting'`, { timeout: 8000 }); seen.fighting = Date.now() - t0; } catch {}
const fin = await pg.evaluate(() => {
  const B = window.__boxing;
  return { phase: B.state.phase, round: B.state.round, php: B.state.player.hp,
    wipe: document.querySelector('[data-wipe]').classList.contains('on'),
    rpop: document.querySelector('[data-roundpop]').classList.contains('on'),
    coach: document.querySelector('[data-coach]').classList.contains('on'),
    cd: document.querySelector('[data-countdown]').classList.contains('on') };
});
ok('bout resumes into round 2 patched (≈55%), all props cleared',
  fin.phase === 'fighting' && fin.round === 2 && Math.abs(fin.php - 55) < 1
    && !fin.wipe && !fin.rpop && !fin.coach && !fin.cd, JSON.stringify(fin));
console.log('timeline(ms):', JSON.stringify(seen));
ok('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));

await browser.close();
process.exit(errs.length ? 1 : 0);
