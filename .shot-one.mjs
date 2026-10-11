import puppeteer from 'puppeteer-core';
const url = process.argv[2], out = process.argv[3], wait = +(process.argv[4] || 3000);
const browser = await puppeteer.launch({
  executablePath: '/usr/bin/chromium', headless: 'new',
  args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 960 });
await page.goto('http://127.0.0.1:34149/index.html', { waitUntil: 'domcontentloaded' });
await page.evaluate(() => {
  localStorage.setItem('boxing:ko', JSON.stringify({ n: 2, sum: 3 }));
  localStorage.setItem('boxing:npc', 'proto:bubble');
});
await page.goto(url, { waitUntil: 'networkidle0', timeout: 30000 });
await new Promise(r => setTimeout(r, wait));
await page.screenshot({ path: out });
await browser.close();
console.log('shot', out);
