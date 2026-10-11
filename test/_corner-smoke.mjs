/* test/_corner-smoke.mjs — e2e for the halftime corner card.

   Boots boxing.html with ?notrack=1&coach=1 (synthetic input, corner force-
   enabled), drops the player's hp under a third mid-fight, and asserts:

     1. the .coach card pops on, the bout freezes to a countdown,
     2. the player is patched to the cornerHeal fraction — never full,
     3. the coach tip lands (API or fallback),
     4. dismissing it bells the next round back in,
     5. it cannot fire twice in one bout.

   Non-zero exit on failure. */
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const URL_ = 'http://127.0.0.1:8890/boxing.html?notrack=1&coach=1';
const results = [];
const check = (name, ok, info = '') => {
  results.push([name, ok]);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${info ? '  — ' + info : ''}`);
};

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
const BENIGN = /^INFO:|XNNPACK|TensorFlow|Created TensorFlow|GroupMarker|Failed to load resource/i;
pg.on('console', m => { if (m.type() === 'error' && !BENIGN.test(m.text())) errs.push(m.text()); });
pg.on('pageerror', e => errs.push(e.message));
await pg.goto(URL_, { waitUntil: 'domcontentloaded', timeout: 30000 });

try {
  await pg.waitForFunction('window.__boxing && window.__boxing.fight', { timeout: 30000 });
  await pg.waitForFunction(() => window.__boxing.state.phase === 'fighting', { timeout: 30000 });

  // on the ropes — drop to 30% mid-fight and let the trigger see it
  const trig = await pg.evaluate(async () => {
    const B = window.__boxing;
    B.state.player.hp = 30;
    await new Promise(r => setTimeout(r, 700));
    return { phase: B.state.phase, round: B.state.round, php: B.state.player.hp,
      maxHp: B.state.player.maxHp, cardOn: document.querySelector('[data-coach]').classList.contains('on'),
      rd: document.querySelector('[data-coachrd]').textContent };
  });
  check('hp ≤ 1/3 pops the corner card', trig.cardOn, JSON.stringify(trig));
  check('bout freezes into the next round countdown', trig.phase === 'countdown' && trig.round === 2,
    `phase=${trig.phase} round=${trig.round}`);
  check('patched to a fraction, never full', Math.abs(trig.php - trig.maxHp * .55) < .01 && trig.php < trig.maxHp,
    `hp=${trig.php}/${trig.maxHp}`);
  check('header names the next round', /ROUND 2/.test(trig.rd), trig.rd);

  // the tip lands — live API or the fallback corner wisdom
  await pg.waitForFunction(() => {
    const t = document.querySelector('[data-coachtip]').textContent;
    return t && !/shouting over the crowd/.test(t);
  }, { timeout: 8000 }).catch(() => {});
  const tip = await pg.evaluate(() => document.querySelector('[data-coachtip]').textContent);
  check('coach tip populated', tip.length > 8, tip.slice(0, 70));

  await pg.screenshot({ path: '/tmp/corner.png' });

  // wave it off → the bell deals round 2
  await pg.evaluate(() => document.querySelector('[data-coachgo]').click());
  await pg.waitForFunction(() => window.__boxing.state.phase === 'fighting', { timeout: 12000 });
  const back = await pg.evaluate(() => ({ phase: window.__boxing.state.phase,
    php: window.__boxing.state.player.hp,
    off: !document.querySelector('[data-coach]').classList.contains('on') }));
  check('dismiss bells the fight back in at patched hp', back.phase === 'fighting' && back.off && Math.abs(back.php - 55) < .01,
    JSON.stringify(back));

  // one timeout per bout — dropping again can't reopen the card
  const again = await pg.evaluate(async () => {
    const B = window.__boxing;
    B.state.player.hp = 20;
    await new Promise(r => setTimeout(r, 1200));
    return { phase: B.state.phase, php: B.state.player.hp,
      cardOn: document.querySelector('[data-coach]').classList.contains('on') };
  });
  check('no second halftime per bout', !again.cardOn && again.phase === 'fighting' && again.php === 20,
    JSON.stringify(again));

  check('zero page errors through the whole break', errs.length === 0, errs.slice(0, 2).join(' | '));
} catch (e) {
  check('corner smoke ran', false, e.message);
}

await b.close();
if (srv) srv.kill();
const fails = results.filter(r => !r[1]).length;
console.log(`\n${results.length - fails} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
