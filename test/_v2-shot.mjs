import puppeteer from 'puppeteer-core';
const browser = await puppeteer.launch({
  executablePath: '/usr/bin/chromium', headless: true,
  args: ['--no-sandbox','--use-angle=vulkan','--enable-features=Vulkan',
    '--ignore-gpu-blocklist','--enable-gpu-rasterization','--mute-audio'],
  defaultViewport: { width: 1280, height: 800 },
});
const page = await browser.newPage();
page.on('pageerror', e => console.log('pageerror:', String(e)));
page.on('console', m => console.log('console:', m.text()));
await page.goto('http://127.0.0.1:8791/iso-mockups/03-diorama/v2.html', { waitUntil: 'domcontentloaded' });
await page.waitForFunction('!!window.__iso', { timeout: 20000 });
await new Promise(r => setTimeout(r, 1200));
await page.screenshot({ path: '/tmp/v2-all.png' });
for (const i of [0, 2]) {           // bubble + bean closeups
  await page.evaluate(`__iso.focus(${i})`);
  await new Promise(r => setTimeout(r, 600));
  await page.screenshot({ path: `/tmp/v2-focus${i}.png` });
}
await browser.close();
console.log('done');
