/* Screenshot the intro + fight telegraphs for visual review. */
import puppeteer from 'puppeteer-core';

const browser = await puppeteer.launch({
  executablePath: '/usr/bin/chromium',
  headless: true,
  args: ['--no-sandbox', '--use-angle=vulkan', '--enable-features=Vulkan',
    '--ignore-gpu-blocklist', '--enable-gpu-rasterization',
    '--window-size=1280,720', '--mute-audio'],
  defaultViewport: { width: 1280, height: 720 },
});
const page = await browser.newPage();
await page.goto('http://localhost:8791/boxing.html?notrack&vid=test-input.mp4',
  { waitUntil: 'domcontentloaded' });
await page.waitForFunction('!!window.__boxing', { timeout: 60000 });
await new Promise(r => setTimeout(r, 4000));

const b = await page.evaluate(() => ({
  phase: window.__boxing?.game?.fight?.state?.phase,
  av: window.__boxing?.game?.playerAvatar?.group?.visible,
}));
console.log('booted:', JSON.stringify(b));

// freeze the entrance clock so each beat can be shot deterministically
const snap = async (name) => {
  await page.screenshot({ path: `/tmp/shot-${name}.png` });
  const s = await page.evaluate(() => window.__boxing?.game?.fight?.state?.phase);
  console.log(`shot ${name} — phase:${s}`);
};

await snap('a-solo');
// advance introU by monkeying with wall time isn't possible; instead let it run
// and sample at the right beats via __boxing state polling
await page.evaluate(() => { window.__t0 = performance.now(); });
await page.waitForFunction(
  `(() => { const b = window.__boxing?.game?.npc?.group?.visible; return b === true; })()`,
  { timeout: 30000 }).catch(() => console.log('npc never became visible'));
await snap('b-npc-enter');
await page.waitForFunction(
  `window.__boxing?.game?.fight?.state?.phase === 'fighting'`,
  { timeout: 30000 }).catch(() => console.log('never reached fighting'));
await snap('c-fight-start');

// catch a windup mid-telegraph
const got = await page.waitForFunction(
  `window.__boxing?.game?.fight?.state?.npc?.action === 'windup'`,
  { timeout: 40000 }).then(() => true).catch(() => false);
if (got) { await snap('d-telegraph'); }
const tel = await page.evaluate(() =>
  window.__boxing?.game?.fight?.state?.npc?.telegraph || null);
console.log('telegraph:', JSON.stringify(tel));
await browser.close();
