/* _shot-aviso.mjs — screenshot avatar-iso harness in the KO'd 'hurt' pose */
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
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--mute-audio'] });
const pg = await b.newPage();
await pg.setViewport({ width: 900, height: 900 });
pg.on('pageerror', e => console.log('PAGEERROR', e.message));
await pg.goto('http://127.0.0.1:8890/test/avatar-iso.html', { waitUntil: 'domcontentloaded', timeout: 30000 });
await pg.waitForFunction('window.__avatar', { timeout: 30000 });
// KO'd-on-the-mat framing: hurt pose, camera low and pulled back like the outro
await pg.evaluate(() => window.__set({ pose: 'down', t: 1, view: [0, .7, 2.6], look: [0, .45, 0], space: 'wide' }));
await new Promise(r => setTimeout(r, 900));
await pg.screenshot({ path: '/tmp/aviso-down.png' });
await b.close();
srv?.kill();
console.log('shot → /tmp/aviso-down.png');
