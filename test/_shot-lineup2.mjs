import puppeteer from 'puppeteer-core';
const browser = await puppeteer.launch({
  executablePath: '/usr/bin/chromium', headless: true,
  args: ['--no-sandbox', '--mute-audio', '--enable-unsafe-swiftshader'],
  defaultViewport: { width: 1280, height: 800 },
});
const page = await browser.newPage();
// KO in round 1 → avg KO = 1 → both bean(≤3) and sumo(≤2) unlock
await page.evaluateOnNewDocument(() => {
  localStorage.setItem('boxing:ko', JSON.stringify({ n: 1, sum: 1 }));
  localStorage.setItem('boxing:wins', '1');
  localStorage.setItem('boxing:best', '3500');
});
await page.goto('http://127.0.0.1:34149/lineup.html', { waitUntil: 'networkidle0', timeout: 30000 });
await new Promise(r => setTimeout(r, 3000));
await page.screenshot({ path: '/tmp/lineup-unlocked.png' });
// click bean cell
const cells = await page.$$('.cell');
console.log('cells:', cells.length);
if (cells[2]) { await cells[2].click(); await new Promise(r => setTimeout(r, 400)); }
await page.screenshot({ path: '/tmp/lineup-bean-picked.png' });
const pick = await page.evaluate(() => localStorage.getItem('boxing:npc'));
console.log('stored pick:', pick);
await browser.close();
