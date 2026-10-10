// fps-probe.mjs — real-GPU boxing page fps measurement against the MP4 input.
// Usage: node test/fps-probe.mjs [url-suffix] [seconds]
import puppeteer from 'puppeteer-core';

const suffix = process.argv[2] || 'vid=test-input.mp4';
const seconds = +(process.argv[3] || 30);
const browser = await puppeteer.launch({
  executablePath: '/usr/bin/chromium',
  headless: 'new',
  args: [
    '--use-angle=vulkan',
    '--enable-features=Vulkan',
    '--ignore-gpu-blocklist',
    '--enable-gpu-rasterization',
    '--window-size=1600,900',
  ],
});
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 900 });
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

await page.goto(`http://127.0.0.1:8890/boxing.html?${suffix}`, { waitUntil: 'domcontentloaded' });
await new Promise(r => setTimeout(r, 20000)); // boot + tracker warmup under headless

const stats = await page.evaluate(async (secs) => {
  const v = document.querySelector('video');
  const t0 = performance.now();
  const frames = [];
  let last = t0, worst = 0, worstWin = 0, winStart = t0, winN = 0;
  await new Promise(done => {
    const tick = (t) => {
      const dt = t - last; last = t;
      frames.push(dt);
      if (dt > worst) worst = dt;
      winN++;
      if (t - winStart > 1000) { // worst 1s-window fps
        const f = 1000 * winN / (t - winStart);
        if (!worstWin || f < worstWin) worstWin = f;
        winStart = t; winN = 0;
      }
      if (t - t0 < secs * 1000) requestAnimationFrame(tick); else done();
    };
    requestAnimationFrame(tick);
  });
  frames.sort((a, b) => a - b);
  const sum = frames.reduce((a, b) => a + b, 0);
  const b = window.__boxing || {};
  return {
    fps: +(1000 * frames.length / sum).toFixed(1),
    p50: +frames[Math.floor(frames.length * .5)].toFixed(1),
    p95: +frames[Math.floor(frames.length * .95)].toFixed(1),
    worstMs: +worst.toFixed(1),
    worst1sFps: +worstWin.toFixed(1),
    phase: b.state?.phase,
    handDelegate: b.hands?.delegate,
    faceDelegate: b.face?.delegate,
    handsInFlight: b.hands?._inFlight,
    faceInFlight: b.face?._inFlight,
    drawCalls: b.ren?.info.render.calls,
    tris: b.ren?.info.render.triangles,
    weakGpu: b.weakGpu,
    video: v ? { w: v.videoWidth, h: v.videoHeight, t: +v.currentTime.toFixed(1), paused: v.paused } : null,
    gl: (() => {
      const c = document.createElement('canvas');
      const g = c.getContext('webgl2');
      const i = g?.getExtension('WEBGL_debug_renderer_info');
      return g ? g.getParameter(i ? i.UNMASKED_RENDERER_WEBGL : g.RENDERER) : null;
    })(),
  };
}, seconds);

console.log(JSON.stringify({ ...stats, errors }, null, 1));
await browser.close();
