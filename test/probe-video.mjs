import puppeteer from 'puppeteer-core';
const b = await puppeteer.launch({ executablePath: '/usr/bin/chromium', headless: 'new', args: [
  '--no-sandbox', '--use-gl=angle', '--use-angle=gl-egl',
  '--window-size=1280,800', '--autoplay-policy=no-user-gesture-required'] });
const p = await b.newPage();
await p.setViewport({ width: 1280, height: 720 });
const errs = [];
p.on('pageerror', e => errs.push(String(e).slice(0, 160)));
p.on('console', m => { const t = m.text(); if (/error|fail/i.test(t)) errs.push(t.slice(0,160)); });
await p.goto('http://127.0.0.1:8890/boxing.html?vid=/test-input.mp4', { waitUntil: 'domcontentloaded', timeout: 30000 });
try { await p.waitForFunction(() => window.__boxing?.game, { timeout: 120000, polling: 500 }); }
catch { console.log('NO-GAME'); }
const stats = await p.evaluate(async () => {
  const B = window.__boxing, out = { frames: 0 };
  const t0 = performance.now();
  await new Promise(res => { const f = () => { out.frames++; performance.now() - t0 < 15000 ? requestAnimationFrame(f) : res(); }; requestAnimationFrame(f); });
  out.fps = out.frames / ((performance.now() - t0) / 1000);
  out.handDelegate = B.hands?._delegate ?? B.hands?.delegate ?? '?';
  out.faceDelegate = B.face?._delegate ?? B.face?.delegate ?? '?';
  out.faceFound = !!B.face?.state?.found;
  out.faceSize = B.face?.state?.size;
  out.handsSeen = (B.hands?.state?.hands || []).length;
  out.videoT = document.querySelector('video')?.currentTime;
  out.videoPaused = document.querySelector('video')?.paused;
  const gl = document.createElement('canvas').getContext('webgl2');
  const ext = gl.getExtension('WEBGL_debug_renderer_info');
  out.gpu = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : '?';
  return out;
});
console.log(JSON.stringify(stats, null, 1));
console.log('errors:', errs.length, errs.slice(0, 5));
await b.close();
