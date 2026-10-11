// Prove the pick-gate hole: a stored pick WITHOUT 'proto:' prefix or pointing
// at a PROP candidate bypasses the KO lock / prop filter entirely.
import puppeteer from 'puppeteer-core';
const browser = await puppeteer.launch({
  executablePath: '/usr/bin/chromium', headless: true,
  args: ['--no-sandbox', '--mute-audio', '--enable-unsafe-swiftshader'],
  defaultViewport: { width: 900, height: 700 },
});
const page = await browser.newPage();
for (const pick of ['bean', 'punching-bag', 'boxing-ring', 'proto:bean']) {
  await page.evaluateOnNewDocument((p) => {
    localStorage.clear();
    localStorage.setItem('boxing:npc', p);          // locked: no KOs on record
  }, pick);
  await page.goto('http://127.0.0.1:34149/boxing.html?notrack',
    { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForFunction('!!window.__boxing?.game', { timeout: 40000 })
    .catch(() => null);
  const r = await page.evaluate(() => {
    const n = window.__boxing?.game?.npc;
    return n ? { id: n.id, variant: n.variant, kind: n.kind, name: n.name } : null;
  });
  console.log(`pick '${pick}'  → rival:`, JSON.stringify(r));
}
await browser.close();
