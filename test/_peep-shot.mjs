/* _peep-shot.mjs — screenshot every webcam-overlay mockup for review.
   Writes peep-mockups/<slug>/shot.png. Assumes a server on 8890. */
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const base = 'http://127.0.0.1:8890/peep-mockups/';
const alive = await fetch(base).then(() => true).catch(() => false);
let srv = null;
if (!alive) {
  srv = spawn('node', ['server.mjs'], { cwd: ROOT, env: { ...process.env, PORT: '8890' }, stdio: 'ignore' });
  await new Promise(r => setTimeout(r, 1200));
}
const slugs = readdirSync(join(ROOT, 'peep-mockups'), { withFileTypes: true })
  .filter(d => d.isDirectory() && /^\d\d-/.test(d.name)).map(d => d.name).sort();

const browser = await puppeteer.launch({
  executablePath: '/usr/bin/chromium', headless: 'new',
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader', '--mute-audio'],
  defaultViewport: { width: 1280, height: 800 },
});
for (const slug of slugs) {
  const page = await browser.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
  try {
    await page.goto(base + slug + '/', { waitUntil: 'networkidle0', timeout: 20000 });
    await new Promise(r => setTimeout(r, 1600));   // let the mesh/sway animations settle
    await page.screenshot({ path: join(ROOT, 'peep-mockups', slug, 'shot.png') });
    console.log(slug, errs.length ? 'OK but: ' + errs.join(' | ') : 'OK');
  } catch (e) { console.log(slug, 'FAIL', String(e), errs.join(' | ')); }
  await page.close();
}
await browser.close();
srv?.kill();
