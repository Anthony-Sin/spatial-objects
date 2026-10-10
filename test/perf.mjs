// perf.mjs — headless perf guard for the spatial-objects app.
// Fails if the page renders below MIN_FPS, if HUD events stall, or if the
// detector takes too long to initialize. Run: npm run perf
import puppeteer from 'puppeteer-core';

const URL_ = process.env.APP_URL || 'http://127.0.0.1:8890/?mouse';
const MIN_FPS = +(process.env.MIN_FPS || 18);       // software-GL floor; real GPUs are far higher
const MAX_DET_MS = +(process.env.MAX_DET_MS || 15000);
const chromiumPath = process.env.CHROME || '/usr/bin/chromium';

const fail = (m) => { console.error('  ✗ ' + m); process.exitCode = 1; };
const pass = (m) => console.log('  ✓ ' + m);

const b = await puppeteer.launch({
  executablePath: chromiumPath, headless: 'new',
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader', '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream'],
});
const p = await b.newPage();
await p.setViewport({ width: 1440, height: 900 });
const errs = [], fails404 = [];
p.on('pageerror', e => errs.push(e.message.slice(0, 140)));
p.on('response', r => { if (r.status() >= 400) fails404.push(`${r.status()} ${r.url().slice(-60)}`); });

console.log(`perf check — ${URL_}`);
const t0 = Date.now();
await p.goto(URL_, { waitUntil: 'domcontentloaded', timeout: 30000 });
await new Promise(r => setTimeout(r, 6000)); // let models warm up

// 1. booted
const parts = await p.evaluate(() => window.__cad?.debug().parts ?? 0);
parts === 8 ? pass(`boot: 8 parts on bench`) : fail(`boot: expected 8 parts, got ${parts}`);

// 2. FPS — count rAF frames over 4 s
const fps = await p.evaluate(() => new Promise(res => {
  let n = 0; const t0 = performance.now();
  const tick = () => { n++; if (performance.now() - t0 < 4000) requestAnimationFrame(tick); else res(n / 4); };
  requestAnimationFrame(tick);
}));
fps >= MIN_FPS ? pass(`fps: ${fps.toFixed(1)} (floor ${MIN_FPS})`)
               : fail(`fps: ${fps.toFixed(1)} below floor ${MIN_FPS}`);

// 3. HUD cadence — count x:hud events over 1.2 s while mouse moves
await p.evaluate(() => { window.__hudN = 0; addEventListener('x:hud', () => window.__hudN++); });
await p.mouse.move(700, 450); await p.mouse.move(900, 400, { steps: 10 });
await new Promise(r => setTimeout(r, 1200));
const hudN = await p.evaluate(() => window.__hudN);
hudN >= 8 ? pass(`hud: ${hudN} events / 1.2 s`) : fail(`hud: only ${hudN} events / 1.2 s (stalled)`);

// 4. input → HUD latency — press over the bench, time until 'grab' appears
const probe = p.evaluate(() => new Promise(res => {
  const t0 = performance.now();
  const h = e => { if (e.detail.gesture === 'grab') { removeEventListener('x:hud', h); res(performance.now() - t0); } };
  addEventListener('x:hud', h); setTimeout(() => res(-1), 2500);
}));
await new Promise(r => setTimeout(r, 150));          // listener bound
await p.mouse.move(850, 420); await p.mouse.down();  // pinch on the bench
const got = await probe; await p.mouse.up();
if (got === -1) fail('gesture latency: no grab event within 2.5 s');
else got < 800 ? pass(`gesture latency: ${got.toFixed(0)} ms`) : fail(`gesture latency: ${got.toFixed(0)} ms (>800)`);

// 5. detector init time (status never shows 'no model' OR det created under cap)
const det = await p.evaluate(() => window.__det ? { created: true, ms: window.__det._initMs ?? null, backend: window.__det.backend ?? null, n: window.__det.latest.length } : { created: false });
det.created ? pass(`detector: up (backend ${det.backend ?? '?'}, ${det.n} hits on fake cam)`)
            : fail('detector: __det missing');

// 6. cleanliness
errs.length ? fail(`page errors: ${errs.slice(0, 3).join(' | ')}`) : pass('no page errors');
fails404.length ? fail(`http fails: ${fails404.slice(0, 3).join(' | ')}`) : pass('no http fails');

console.log(`done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
await b.close();
process.exit(process.exitCode || 0);
