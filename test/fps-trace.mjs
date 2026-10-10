// fps-trace.mjs — measure steady-state fps AFTER full warmup + find hitch sources.
import puppeteer from 'puppeteer-core';

const browser = await puppeteer.launch({
  executablePath: '/usr/bin/chromium',
  headless: 'new',
  args: ['--use-angle=vulkan', '--enable-features=Vulkan', '--ignore-gpu-blocklist',
         '--enable-gpu-rasterization', '--window-size=1600,900',
         '--user-data-dir=/tmp/probe-' + Date.now()],
});
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 900 });
const errors = [];
page.on('pageerror', e => errors.push(String(e)));

await page.evaluateOnNewDocument(() => {
  window.__lt = [];
  new PerformanceObserver(l => {
    for (const e of l.getEntries()) window.__lt.push(+(e.duration).toFixed(1));
  }).observe({ entryTypes: ['longtask'] });
});

await page.goto('http://127.0.0.1:8890/boxing.html?vid=test-input.mp4', { waitUntil: 'domcontentloaded' });

// wait until video actually advances = media pipeline alive, then settle 30s
await page.waitForFunction(() => {
  const v = document.querySelector('video');
  return v && v.currentTime > 1;
}, { timeout: 120000, polling: 500 });
console.log('video alive at', new Date().toISOString().slice(17, 23));
await new Promise(r => setTimeout(r, 30000));

const stats = await page.evaluate(async () => {
  const v = document.querySelector('video');
  const b = window.__boxing || {};
  const vt0 = v.currentTime;
  const t0 = performance.now();
  const frames = [];
  let last = t0;
  await new Promise(done => {
    const tick = (t) => { frames.push(t - last); last = t;
      if (t - t0 < 20000) requestAnimationFrame(tick); else done(); };
    requestAnimationFrame(tick);
  });
  frames.sort((a, b) => a - b);
  const sum = frames.reduce((a, c) => a + c, 0);
  const wall = performance.now() - t0;
  return {
    fps: +(1000 * frames.length / sum).toFixed(1),
    wallS: +(wall / 1000).toFixed(1),
    videoAdvanced: +(v.currentTime - vt0).toFixed(1),
    p50: +frames[Math.floor(frames.length * .5)].toFixed(1),
    p90: +frames[Math.floor(frames.length * .9)].toFixed(1),
    p99: +frames[Math.floor(frames.length * .99)].toFixed(1),
    worst: +frames[frames.length - 1].toFixed(1),
    over33: frames.filter(f => f > 33).length,
    over50: frames.filter(f => f > 50).length,
    n: frames.length,
    longtasks: window.__lt.slice(-40),
    ltTotal: window.__lt.length,
    phase: b.state?.phase,
    handDelegate: b.hands?.delegate, faceDelegate: b.face?.delegate,
  };
});
console.log(JSON.stringify({ ...stats, errors }, null, 1));
await browser.close();
