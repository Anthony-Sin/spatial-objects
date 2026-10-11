/* _peep-backdrop.mjs — grab a clean fight-scene plate (peep hidden) for the
   webcam-overlay mockups to sit on. Writes peep-mockups/_plate.png. */
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
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
await pg.setViewport({ width: 1280, height: 800 });
pg.on('pageerror', e => console.log('PAGEERROR', e.message));
await pg.goto('http://127.0.0.1:8890/boxing.html?notrack=1', { waitUntil: 'domcontentloaded', timeout: 30000 });
await pg.waitForFunction('window.__boxing && window.__boxing.fight', { timeout: 30000 });
await pg.waitForFunction(() => window.__boxing.state.phase === 'fighting', { timeout: 45000 }).catch(() => {});
await pg.evaluate(() => {
  const B = window.__boxing;
  for (let i = 0; i < 90; i++) B.game.step(1 / 60, { hands: [] }, null);
  B.fight.state.npc.hp = 62;
  for (let i = 0; i < 10; i++) B.game.step(1 / 60, { hands: [] }, null);
  document.querySelector('.peep')?.setAttribute('hidden', '');   // plate only — mockups supply the peep
});
await new Promise(r => setTimeout(r, 400));
await pg.screenshot({ path: join(ROOT, 'peep-mockups', '_plate.png') });
await b.close();
srv?.kill();
console.log('plate → peep-mockups/_plate.png');
