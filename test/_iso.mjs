import puppeteer from 'puppeteer-core';

const url = process.argv[2] || 'http://127.0.0.1:34149/test/avatar-iso.html';
const browser = await puppeteer.launch({
  executablePath: '/usr/bin/chromium',
  headless: true,
  args: ['--no-sandbox', '--use-angle=vulkan', '--enable-features=Vulkan',
    '--ignore-gpu-blocklist', '--enable-gpu-rasterization',
    '--window-size=1100,850', '--mute-audio'],
  defaultViewport: { width: 1100, height: 850 },
});
const page = await browser.newPage();
page.on('pageerror', e => console.log('pageerror:', String(e)));
page.on('console', m => { if (m.type() === 'error') console.log('console:', m.text()); });
await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForFunction('!!window.__avatar', { timeout: 60000 });
await new Promise(r => setTimeout(r, 900));

const SH = [[0,1.15],[.55,.78],[.8,.5],[1,.32],[1.12,.18],
  [.36,-.12],[.4,-.4],[.42,-.6],[.44,-.74],
  [0,-.2],[0,-.48],[0,-.7],[0,-.86],
  [-.34,-.12],[-.38,-.36],[-.4,-.55],[-.42,-.68],
  [-.6,-.05],[-.66,-.26],[-.7,-.42],[-.72,-.52]];
const mk = (side, px, py, kind = 'fist', span = .075, nExt = 0) => {
  const lm = SH.map(([x, y]) => ({ x: px + x * span, y: py + y * span, z: 0 }));
  return { side, kind, palm: { x: lm[9].x, y: lm[9].y },
    wrist: { x: lm[0].x, y: lm[0].y },
    lm, nExt, nExtAll: nExt, pinch: false, pinchD: .8 };
};

const VIEWS = {
  outro:  { view: [.55, 1.0, 1.45], look: [-.15, .84, -.25] },
  front:  { view: [0, .95, 1.75],   look: [0, .85, 0] },
  quarter:{ view: [-.95, .95, 1.25], look: [0, .82, 0] },
  side:   { view: [1.75, .95, 0],   look: [0, .82, 0] },
  back:   { view: [0, .95, -1.75],  look: [0, .85, 0] },
};

const CASES = process.argv[3]
  ? JSON.parse(process.argv[3])
  : [
    // outro-angle sweep: each end pose, hands off
    ['v-outro', { pose: 'victory', t: 2, ...VIEWS.outro }],
    ['b-outro', { pose: 'block', t: 1, ...VIEWS.outro }],
    ['h-outro', { pose: 'hurt', t: .45, ...VIEWS.outro }],
    ['c-outro', { pose: 'celebrate', t: .3, ...VIEWS.outro }],
    ['p-outro', { pose: 'point', t: 1, ...VIEWS.outro }],
    ['w-outro', { pose: 'wave', t: .3, ...VIEWS.outro }],
    // orbits on victory to catch seam/clip issues from all sides
    ['v-front', { pose: 'victory', t: 2, ...VIEWS.front }],
    ['v-quart', { pose: 'victory', t: 2, ...VIEWS.quarter }],
    ['v-side',  { pose: 'victory', t: 2, ...VIEWS.side }],
    ['v-back',  { pose: 'victory', t: 2, ...VIEWS.back }],
    // tracked hands — wide space, all the hand shapes
    ['f-guard', { pose: 'block', t: 1, space: 'wide', ...VIEWS.outro,
      hands: [mk('left', .38, .5), mk('right', .62, .5)] }],
    ['f-palms', { pose: 'celebrate', t: .3, space: 'wide', ...VIEWS.outro,
      hands: [mk('left', .35, .32, 'palm', .075, 5), mk('right', .65, .32, 'palm', .075, 5)] }],
    ['f-deep',  { pose: 'block', t: 1, space: 'wide', ...VIEWS.outro,
      hands: [mk('left', .42, .55, 'fist', .18), mk('right', .58, .55, 'fist', .18)] }],
    ['f-low',   { pose: 'block', t: 1, space: 'wide', ...VIEWS.outro,
      hands: [mk('left', .4, .66), mk('right', .6, .66)] }],
    ['f-one',   { pose: 'victory', t: 2, space: 'wide', ...VIEWS.outro,
      hands: [mk('right', .66, .38)] }],
    ['f-wide',  { pose: 'celebrate', t: .3, space: 'wide', ...VIEWS.outro,
      hands: [mk('left', .12, .4), mk('right', .88, .4)] }],
    // close space (intro framing) from the front
    ['i-guard', { pose: 'block', t: 1, space: 'close', ...VIEWS.front,
      hands: [mk('left', .38, .45), mk('right', .62, .45)] }],
    ['i-none',  { pose: 'block', t: 1, space: 'close', ...VIEWS.front }],
    // side view with tracked hands — checks arm/anchor in profile
    ['f-side',  { pose: 'victory', t: 2, space: 'wide', ...VIEWS.side,
      hands: [mk('left', .38, .5), mk('right', .62, .5)] }],
  ];

for (const [name, c] of CASES) {
  await page.evaluate(cfg => window.__set(cfg), c);
  await new Promise(r => setTimeout(r, 700));
  await page.screenshot({ path: `/tmp/iso-${name}.png` });
}
await browser.close();
console.log('done', CASES.length, 'shots');
