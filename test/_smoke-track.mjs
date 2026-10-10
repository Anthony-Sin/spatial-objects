import puppeteer from 'puppeteer-core';
const b = await puppeteer.launch({ executablePath: '/usr/bin/chromium', headless: 'new',
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--mute-audio'] });
const pg = await b.newPage();
await pg.setViewport({ width: 1280, height: 800 });
const errs = [];
pg.on('pageerror', e => errs.push('PAGEERR: ' + e.message));
pg.on('console', m => { if (m.type() === 'error' && !/^INFO:|XNNPACK|TensorFlow|Created TensorFlow|GroupMarker|swiftshader|Vulkan|WebGL.*deprecat/i.test(m.text())) errs.push('CONSOLE: ' + m.text().slice(0,200)); });
await pg.goto('http://127.0.0.1:8890/boxing.html', { waitUntil: 'domcontentloaded', timeout: 30000 });
await new Promise(r => setTimeout(r, 12000));  // let wasm+models load in workers, frames flow
const out = await pg.evaluate(() => new Promise(res => {
  let n = 0; const t0 = performance.now();
  const tick = () => { n++; if (performance.now() - t0 < 3000) requestAnimationFrame(tick); else res({
    fps: (n / 3).toFixed(1),
    tag: document.querySelector('[data-peep]')?.textContent,
    hands: window.__boxing?.tracker ? 'game-up' : 'no-game',
  }); };
  requestAnimationFrame(tick);
}));
const track = await pg.evaluate(async () => {
  // reach into module scope is impossible; check state via game tracker path
  return { hasBoxing: !!window.__boxing, keys: window.__boxing ? Object.keys(window.__boxing) : [] };
});
console.log(JSON.stringify({ out, track, errs: errs.slice(0, 8) }, null, 1));
await b.close();
