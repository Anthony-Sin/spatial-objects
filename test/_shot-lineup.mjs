import puppeteer from 'puppeteer-core';
const browser = await puppeteer.launch({
  executablePath: '/usr/bin/chromium', headless: true,
  args: ['--no-sandbox', '--mute-audio', '--enable-unsafe-swiftshader'],
  defaultViewport: { width: 1280, height: 800 },
});
const page = await browser.newPage();
page.on('console', m => console.log('[con]', m.text().slice(0, 200)));
await page.goto('http://127.0.0.1:34149/lineup.html', { waitUntil: 'networkidle0', timeout: 30000 });
await new Promise(r => setTimeout(r, 2500));
await page.screenshot({ path: '/tmp/lineup-now.png' });
console.log('done');
await browser.close();
