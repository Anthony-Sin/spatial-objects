import puppeteer from 'puppeteer-core';
// Layout audit for job.html — fails on floating props or interpenetrating ones.
const b = await puppeteer.launch({ executablePath:'/usr/bin/chromium', headless:'new',
  args:['--no-sandbox','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader',
    '--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream'] });
const p = await b.newPage();
await p.goto('http://127.0.0.1:8890/job.html', { waitUntil:'domcontentloaded', timeout: 30000 });
await p.waitForFunction('window.__job && window.__job.grabbables.length > 5', { timeout: 30000 });
await new Promise(r => setTimeout(r, 2000));

const audit = await p.evaluate(() => {
  const { THREE, set } = window.__job;
  const FLOOR = -2.35, BENCH = -1.15, TOL = .05;
  const props = [];
  for (const o of set.children) {
    if (o.userData.room) continue;                       // walls / floor / door — the building
    if (o.userData.tag === 'workbench' || !o.visible || o.userData.parked) continue;
    let isMarker = false;
    o.traverse(m => { if (m.geometry && /TorusGeometry|RingGeometry/.test(m.geometry.type)) isMarker = true; });
    if (isMarker) continue;                              // seam / hole / stow / rivet rings
    props.push(o);
  }
  const boxes = props.map(o => {
    o.updateWorldMatrix(true, true);
    const b = new THREE.Box3().setFromObject(o);
    return { o, b, name: o.userData.tag || o.type + ':' + (o.children[0]?.name || '') };
  });
  // pipes group children are part of the set — treat pipes group as one prop
  const floats = [], overlaps = [];
  for (const { o, b, name } of boxes) {
    const isPipes = o.type === 'Group' && o.children.some(c => c.name?.toLowerCase().includes('pipe') || c.userData.tag === 'pipe');
    if (isPipes || o.userData.hang) continue;            // pipes rest on the stand; signs hang
    const bottom = b.min.y;
    const ok = Math.abs(bottom - FLOOR) < TOL || Math.abs(bottom - BENCH) < TOL;
    if (!ok) floats.push({ name, bottom: +bottom.toFixed(3) });
  }
  // pairwise overlap — ignore pairs resting on different surfaces, and the
  // workbench itself (props legitimately sit inside its bbox volume)
  const benchIdx = -1;
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
    if (i === benchIdx || j === benchIdx) continue;
    const A = boxes[i].b, B = boxes[j].b;
    const ix = Math.min(A.max.x, B.max.x) - Math.max(A.min.x, B.min.x);
    const iy = Math.min(A.max.y, B.max.y) - Math.max(A.min.y, B.min.y);
    const iz = Math.min(A.max.z, B.max.z) - Math.max(A.min.z, B.min.z);
    if (ix > .03 && iy > .03 && iz > .03)
      overlaps.push({ a: boxes[i].name, b: boxes[j].name, vol: +(ix * iy * iz).toFixed(3) });
  }
  return { props: boxes.length, floats, overlaps };
});
console.log(JSON.stringify(audit, null, 1));
await b.close();
process.exit(audit.floats.length || audit.overlaps.length ? 1 : 0);
