import puppeteer from 'puppeteer-core';
const b = await puppeteer.launch({ executablePath: '/usr/bin/chromium', headless: 'new', args: [
  '--no-sandbox', '--use-fake-ui-for-media-stream',
  '--use-gl=angle', '--use-angle=gl-egl',
  '--window-size=1280,800', '--autoplay-policy=no-user-gesture-required'] });
const p = await b.newPage();
await p.setViewport({ width: 1280, height: 720 });
const errs = [];
p.on('pageerror', e => errs.push(String(e).slice(0, 200)));
p.on('console', m => { const t = m.text(); if (/error|fail|fatal/i.test(t)) errs.push(t.slice(0,200)); });
await p.goto('http://127.0.0.1:8890/boxing.html', { waitUntil: 'domcontentloaded', timeout: 30000 });
try { await p.waitForFunction(() => window.__boxing?.game, { timeout: 60000, polling: 500 }); }
catch { console.log('NO-GAME'); }
// let the trackers warm up and stats settle
await new Promise(r => setTimeout(r, 12000));
const out = await p.evaluate(async () => {
  const B = window.__boxing;
  const st = B.hands?.stats || {};
  // measure result→paint delay: stamp a counter on each ingest, read at rAF
  let lastResultAge = -1;
  const H = B.hands;
  return {
    delegate: H?.delegate,
    faceDelegate: B.face?.delegate,
    video: [document.querySelector('video')?.videoWidth, document.querySelector('video')?.videoHeight],
    track: document.querySelector('video')?.srcObject?.getVideoTracks?.()[0]?.getSettings?.(),
    stats: st,
    status: document.querySelector('[data-peep]')?.textContent,
    hands: H?.state?.hands?.length,
    gpu: (() => { const gl = document.createElement('canvas').getContext('webgl2');
      const e = gl?.getExtension('WEBGL_debug_renderer_info');
      return e ? gl.getParameter(e.UNMASKED_RENDERER_WEBGL) : '?'; })(),
  };
});
console.log(JSON.stringify(out, null, 1));
console.log('errors', errs.slice(0, 8));
await b.close();
