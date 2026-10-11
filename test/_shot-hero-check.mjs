import puppeteer from 'puppeteer-core';
const dirs = ['17-main-event', '18-paper-stage', '19-fight-bill', '20-arcade-select', '21-sticker-sheet'];
const browser = await puppeteer.launch({
  executablePath: '/usr/bin/chromium', headless: true,
  args: ['--no-sandbox', '--mute-audio', '--enable-unsafe-swiftshader'],
  defaultViewport: { width: 1280, height: 800 },
});
const page = await browser.newPage();
const errs = [];
page.on('console', m => { if (m.type() === 'error') errs.push(m.text().slice(0, 200)); });
page.on('pageerror', e => errs.push('PAGEERROR ' + String(e).slice(0, 300)));

for (const d of dirs) {
  errs.length = 0;
  await page.goto(`http://127.0.0.1:34149/lineup-mockups/${d}/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await new Promise(r => setTimeout(r, 5000));
  await page.screenshot({ path: `/home/ANT/unclockable-knighthacks-2026/spatial-objects/lineup-mockups/${d}/shot.png` });
  const state = await page.evaluate(() => window.__stage?.contenders.map(c =>
    `${c.variant}@(${c.x.toFixed(1)},${c.z.toFixed(1)})`).join(' ') || 'no-stage');
  console.log(d, '|', state, errs.length ? 'ERRORS: ' + errs.join(' | ') : '| clean');
}

// baked lineup.html — same contract as 17, plus QE .cell[data-idx] compat
errs.length = 0;
await page.goto('http://127.0.0.1:34149/lineup.html', { waitUntil: 'domcontentloaded', timeout: 30000 });
await new Promise(r => setTimeout(r, 5000));
await page.screenshot({ path: '/tmp/lineup-baked.png' });
await page.click('.cell[data-idx="1"]');
await new Promise(r => setTimeout(r, 1600));
const lname = await page.$eval('[data-hero-name]', e => e.textContent);
const lpick = await page.evaluate(() => localStorage.getItem('boxing:npc'));
const lstate = await page.evaluate(() => window.__stage?.contenders.map(c =>
  `${c.variant}@(${c.x.toFixed(2)},${c.z.toFixed(2)})`).join(' '));
console.log('lineup →', lname, '| npc:', lpick, '|', lstate, errs.length ? 'ERRORS: ' + errs.join(' | ') : '| clean');
await browser.close();
