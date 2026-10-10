import puppeteer from 'puppeteer-core';
const b = await puppeteer.launch({ executablePath: '/usr/bin/chromium', headless: 'new', args: [
  '--no-sandbox', '--use-gl=angle', '--use-angle=gl-egl',
  '--autoplay-policy=no-user-gesture-required'] });
const p = await b.newPage();
await p.goto('http://127.0.0.1:8890/boxing.html?notrack=1', { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.__boxing?.game || document.readyState === 'complete', { timeout: 30000 });
const res = await p.evaluate(async () => {
  const out = {};
  const vend = new URL('./vendor/mediapipe', location.href).href.replace(/\/$/, '');
  for (const kind of ['hands', 'face']) {
    const w = new Worker(new URL('./shared/track-worker.js', location.href));
    const t0 = performance.now();
    out[kind] = await new Promise(r => {
      const to = setTimeout(() => r({ err: 'TIMEOUT', ms: performance.now() - t0 }), 90000);
      w.onmessage = e => { const d = e.data || {};
        if (d.type === 'ready') { clearTimeout(to); r({ ...d, ms: Math.round(performance.now() - t0) }); } };
      w.onerror = e => { clearTimeout(to); r({ err: e.message || 'onerror', ms: Math.round(performance.now() - t0) }); };
    });
    w.terminate();
  }
  return out;
});
console.log(JSON.stringify(res, null, 1));
await b.close();
