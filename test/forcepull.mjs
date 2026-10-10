import puppeteer from 'puppeteer-core';
const b = await puppeteer.launch({ executablePath:'/usr/bin/chromium', headless:'new',
  args:['--no-sandbox','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader',
    '--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream','--mute-audio'] });
const pg = await b.newPage();
await pg.setViewport({ width: 1280, height: 800 });
pg.on('pageerror', e => console.log('PAGEERR', e.message));
await pg.goto('http://127.0.0.1:8890/job.html', { waitUntil:'domcontentloaded', timeout: 30000 });
await pg.waitForFunction('window.__job && window.__job.grabbables.length > 5', { timeout: 30000 });
await new Promise(r => setTimeout(r, 2000));

const res = await pg.evaluate(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const lm = (cx, cy) => Array.from({length: 21}, (_, i) =>
    ({ x: cx + (i % 5 - 2) * .02, y: cy + Math.floor(i / 5) * .03, z: 0 }));
  const hand = (kind, x, y, side) => ({ side, kind, lm: lm(x, y),
    pinchAt: {x,y}, palm: {x,y}, wrist: {x, y: y+.12}, indexTip: {x,y}, nExt: kind==='point'?1:0, nExtAll: 0 });
  const set = (h) => window.__forceHands = { hands: [h], pinch: null, point: h?.kind==='point' ? {x:h.indexTip.x,y:h.indexTip.y} : null, orbit: null, zoom: null, spread: null };
  const tag = () => window.__job.aimed?.userData.tag || window.__job.powerObj?.userData.tag || null;
  const J = window.__job;

  // 1 — POINT at a prop until `aimed` lights (sweep grid until hit)
  let target = null;
  outer: for (let gy = .3; gy < .8; gy += .04)
    for (let gx = .3; gx < .9; gx += .04) {
      set(hand('point', gx, gy, 'right')); await sleep(60);
      if (J.aimed) { target = { x: gx, y: gy, tag: J.aimed.userData.tag }; break outer; }
    }
  if (!target) return { fail: 'no aim target found' };

  // 2 — snap FIST at the same spot → power grab; object should fly toward hand
  const before = J.aimed ? { ...J.aimed.position } : null;
  set(hand('fist', .5, .4, 'right')); await sleep(900);
  const pulled = J.powerObj?.userData.tag || null;
  const after = J.powerObj ? { x: J.powerObj.position.x, y: J.powerObj.position.y, z: J.powerObj.position.z } : null;

  // 3 — release (open hand) → powerObj clears
  window.__forceHands = { hands: [], pinch: null, point: null, orbit: null, zoom: null, spread: null };
  await sleep(300);
  const released = J.powerObj === null;
  return { aimed: target, pulled, moved: before && after ? Math.hypot(after.x-before.x, after.y-before.y, after.z-before.z).toFixed(2) : 0, released };
});
console.log(JSON.stringify(res));
await pg.screenshot({ path: '/tmp/pull.png' });
await b.close();
