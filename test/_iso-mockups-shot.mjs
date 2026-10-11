import puppeteer from 'puppeteer-core';
const base = 'http://127.0.0.1:8791/iso-mockups/';
const themes = ['01-studio', '02-blueprint', '03-diorama', '04-terminal', '05-paper'];
const browser = await puppeteer.launch({
  executablePath: '/usr/bin/chromium', headless: true,
  args: ['--no-sandbox','--use-angle=vulkan','--enable-features=Vulkan',
    '--ignore-gpu-blocklist','--enable-gpu-rasterization','--mute-audio'],
  defaultViewport: { width: 1280, height: 800 },
});
for (const t of themes) {
  const page = await browser.newPage();
  let errs = [];
  page.on('pageerror', e => errs.push('pageerror: ' + e));
  page.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
  await page.goto(base + t + '/', { waitUntil: 'domcontentloaded' });
  try {
    await page.waitForFunction('!!window.__iso', { timeout: 20000 });
    await new Promise(r => setTimeout(r, 1400));
    await page.screenshot({ path: `iso-mockups/${t}/shot.png` });
    console.log(t, 'OK', errs.length ? errs.join(' | ') : '');
  } catch (e) { console.log(t, 'FAIL', String(e), errs.join(' | ')); }
  await page.close();
}
await browser.close();
