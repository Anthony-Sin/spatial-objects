import puppeteer from 'puppeteer-core';
const b = await puppeteer.launch({ executablePath: '/usr/bin/chromium', headless: 'new', args: [
  '--no-sandbox', '--use-fake-ui-for-media-stream',
  '--use-gl=angle', '--use-angle=gl-egl',
  '--window-size=1280,800', '--autoplay-policy=no-user-gesture-required'] });
const p = await b.newPage();
await p.setViewport({ width: 1280, height: 720 });
const errs = [];
p.on('pageerror', e => errs.push(String(e).slice(0, 160)));
p.on('console', m => { const t = m.text(); if (/error|fail|fatal/i.test(t)) errs.push(t.slice(0,160)); });
await p.goto('http://127.0.0.1:8890/boxing.html?vid=/test-input.mp4', { waitUntil: 'domcontentloaded', timeout: 30000 });
try { await p.waitForFunction(() => window.__boxing?.game, { timeout: 60000, polling: 500 }); }
catch { console.log('NO-GAME'); }
// collect per-result infer times over ~8s, tagged by hand count
const out = await p.evaluate(async () => new Promise(res => {
  const H = window.__boxing.hands;
  const inf = [], rt = [], counts = [];
  let prevLast = H?.stats?.lastResultAt || 0;
  const t0 = performance.now();
  const iv = setInterval(() => {
    const s = H?.stats || {};
    if (s.lastResultAt !== prevLast) {
      prevLast = s.lastResultAt;
      inf.push(s.inferMs); rt.push(s.roundTripMs);
      counts.push(H?.state?.hands?.length ?? -1);
    }
    if (performance.now() - t0 > 8000) {
      clearInterval(iv);
      const avg = a => a.length ? a.reduce((x,y)=>x+y,0)/a.length : 0;
      const p95 = a => { if (!a.length) return 0; const s=[...a].sort((x,y)=>x-y); return s[Math.floor(s.length*.95)]; };
      res({ n: inf.length, inferAvg: avg(inf), inferP95: p95(inf),
            rtAvg: avg(rt), rtP95: p95(rt),
            handsSeen: Math.max(...counts, 0), counts: counts.join('').slice(0, 200),
            stats: window.__boxing.hands?.stats,
            delegate: H?.delegate, faceDelegate: window.__boxing.face?.delegate });
    }
  }, 5);
}));
console.log(JSON.stringify(out, null, 1));
console.log('errors', errs.slice(0, 6));
await b.close();
