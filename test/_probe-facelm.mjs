import puppeteer from 'puppeteer-core';
const b = await puppeteer.launch({ executablePath: '/usr/bin/chromium', headless: 'new', args: [
  '--no-sandbox', '--use-gl=angle', '--use-angle=gl-egl',
  '--window-size=1280,800', '--autoplay-policy=no-user-gesture-required'] });
const p = await b.newPage();
await p.goto('http://127.0.0.1:8890/boxing.html?vid=/test-input.mp4', { waitUntil: 'domcontentloaded', timeout: 30000 });
await p.waitForFunction(() => window.__boxing?.face?.state?.found, { timeout: 60000, polling: 500 });
const out = await p.evaluate(async () => new Promise(res => {
  const F = window.__boxing.face, inf = [];
  let prev = -1, n = 0;
  const iv = setInterval(() => {
    if (F.inferMs !== prev) { prev = F.inferMs; inf.push(F.inferMs); }
    if (++n > 400) { clearInterval(iv);
      const s = F.state;
      res({ delegate: F.delegate, lmCount: s.lm?.length, found: s.found,
        nose: { x: +s.nose.x.toFixed(3), y: +s.nose.y.toFixed(3) },
        inferAvg: +(inf.reduce((a, x) => a + x, 0) / inf.length).toFixed(2),
        inferMax: +Math.max(...inf).toFixed(2), samples: inf.length }); }
  }, 10);
}));
console.log(JSON.stringify(out, null, 1));
await b.close();
