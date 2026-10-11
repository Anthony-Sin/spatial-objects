import puppeteer from 'puppeteer-core';

const browser = await puppeteer.launch({
  executablePath: '/usr/bin/chromium', headless: 'new',
  args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 960 });

// seed an earned record so all three rivals render unlocked in the mocks
await page.goto('http://127.0.0.1:34149/index.html', { waitUntil: 'domcontentloaded' });
await page.evaluate(() => {
  localStorage.setItem('boxing:ko', JSON.stringify({ n: 2, sum: 3 }));
  localStorage.setItem('boxing:npc', 'proto:bubble');
});

const mocks = ['01-fight-poster', '02-ringside', '03-old-gym', '04-corkboard', '05-arcade-vs'];
for (const m of mocks) {
  await page.goto(`http://127.0.0.1:34149/lineup-mockups/${m}/`, { waitUntil: 'networkidle0', timeout: 30000 });
  await new Promise(r => setTimeout(r, 3000));
  await page.screenshot({ path: `/tmp/mock-${m}.png` });
  console.log('shot', m);
}

await page.goto('http://127.0.0.1:34149/lineup-mockups/', { waitUntil: 'networkidle0', timeout: 60000 });
await new Promise(r => setTimeout(r, 5000));   // 5 iframe thumbs need a beat
await page.screenshot({ path: '/tmp/mock-gallery.png' });
console.log('shot gallery');
await browser.close();
