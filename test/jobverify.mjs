import puppeteer from 'puppeteer-core';
const b = await puppeteer.launch({ executablePath: '/usr/bin/chromium', headless: 'new',
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--mute-audio'],
});
const pg = await b.newPage();
await pg.setViewport({ width: 1280, height: 800 });
pg.on('console', m => { if (m.type() === 'error') console.log('PAGEERR', m.text()); });
pg.on('pageerror', e => console.log('PAGEERR', e.message));
await pg.goto('http://127.0.0.1:8890/job.html', { waitUntil: 'domcontentloaded', timeout: 30000 });
await pg.waitForFunction('window.__job && window.__job.grabbables.length > 3', { timeout: 30000 });
await new Promise(r => setTimeout(r, 2500));

// project the hardhat's world position to screen space and pinch it dead-on.
const grabbed = await pg.evaluate(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const lm = (cx, cy) => {   // crude open-hand landmark cloud around (cx,cy)
    const P = [];
    for (let i = 0; i < 21; i++) P.push({ x: cx + (i % 5 - 2) * .02, y: cy + Math.floor(i / 5) * .03, z: 0 });
    return P;
  };
  const set = (x, y) => window.__forceHands = {
    hands: [{ side: 'left', kind: 'pinch', lm: lm(x, y), pinchAt: { x, y },
      palm: { x, y }, wrist: { x, y: y + .12 }, indexTip: { x, y }, nExt: 0, nExtAll: 0 }],
    pinch: { x, y }, point: null, orbit: null, zoom: null, spread: null,
  };
  const { THREE, grabbables, cam } = window.__job;
  const hat = grabbables.find(o => o.userData.tag === 'hardhat');
  if (!hat) return 'no-hat';
  // aim slightly around the hat's projected bbox center in case of overlap
  const v = new THREE.Box3().setFromObject(hat).getCenter(new THREE.Vector3());
  const tries = [[0, 0], [.02, 0], [-.02, 0], [0, .03], [.02, .03], [-.02, .03], [.04, .02]];
  for (const [ox, oy] of tries) {
    const p = v.clone().project(cam);
    const nx = (p.x + 1) / 2 + ox, ny = (1 - p.y) / 2 + oy;
    set(nx, ny); await sleep(140);
    if (window.__job.grabbed?.userData.tag === 'hardhat') break;
  }
  return window.__job.grabbed?.userData.tag || null;
});
console.log('grabbed:', grabbed);

// drag upward — don fallback triggers when hat y > -0.62
const done = await pg.evaluate(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  for (let y = .5; y > .05; y -= .05) {
    const p = { x: .72, y };
    window.__forceHands.hands[0].pinchAt = p;
    window.__forceHands.pinch = p;
    await sleep(120);
  }
  await sleep(2200);
  return { hatY: window.__job.grabbed?.position.y, score: document.querySelector('[data-score]')?.textContent,
    job: document.querySelector('[data-job]')?.textContent };
});
console.log(JSON.stringify(done));
await pg.evaluate(() => window.__forceHands = null);
await new Promise(r => setTimeout(r, 400));
await pg.screenshot({ path: '/tmp/job_don.png' });
await b.close();
