// test/boxing-proto.mjs — node-only smoke test for shared/boxing/protoBoxer.js.
// The module takes THREE as a parameter, so we stub just enough of the
// namespace (Group/Mesh/geometries/materials) to prove it builds, poses,
// ticks, and disposes without WebGL. Run: node test/boxing-proto.mjs
import { VARIANTS, VARIANT_INFO, buildBoxer } from '../shared/boxing/protoBoxer.js';

let failed = 0;
const ok = (cond, msg) => { if (cond) console.log('  ok', msg); else { failed++; console.error('FAIL', msg); } };

// ---- minimal THREE stub ----
class V3 {
  constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
  set(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; return this; }
}
class Obj3D {
  constructor() {
    this.children = []; this.parent = null;
    this.position = new V3(); this.rotation = new V3(); this.scale = new V3(1, 1, 1);
    this.userData = {}; this.visible = true; this.name = '';
  }
  add(...cs) { for (const c of cs) { c.parent = this; this.children.push(c); } return this; }
  traverse(fn) { fn(this); for (const c of this.children) (c.traverse || (x => x)).call(c, fn); }
  clear() { for (const c of this.children) c.parent = null; this.children.length = 0; }
}
class Group extends Obj3D { constructor() { super(); this.type = 'Group'; } }
class Mesh extends Obj3D {
  constructor(g, m) { super(); this.type = 'Mesh'; this.geometry = g; this.material = m; }
}
class Geo { constructor(...a) { this.args = a; this.disposed = false; } dispose() { this.disposed = true; } }
class SphereGeometry extends Geo {}
class BoxGeometry extends Geo {}
class CapsuleGeometry extends Geo {}
class CylinderGeometry extends Geo {}
class TorusGeometry extends Geo {}
class Mat {
  constructor(o = {}) { Object.assign(this, o); this.disposed = false; }
  dispose() { this.disposed = true; }
}
const THREE = {
  Group, Mesh,
  SphereGeometry, BoxGeometry, CapsuleGeometry, CylinderGeometry, TorusGeometry,
  MeshToonMaterial: Mat, MeshBasicMaterial: Mat,
  BackSide: 1, FrontSide: 0, DoubleSide: 2,
};

// ---- VARIANTS ----
ok(Array.isArray(VARIANTS) && VARIANTS.length >= 3, `VARIANTS >= 3 (${VARIANTS})`);
ok(VARIANTS.includes('bubble') && VARIANTS.includes('blocky') && VARIANTS.includes('bean'),
  'VARIANTS includes bubble/blocky/bean');
ok(VARIANT_INFO && VARIANTS.every(v => VARIANT_INFO[v]?.label), 'VARIANT_INFO labels every variant');

// ---- build every variant ----
const POSES = ['idle', 'windup', 'jab', 'cross', 'hook', 'block', 'hurt', 'down', 'celebrate'];
const boxes = {};
for (const v of VARIANTS) {
  const b = buildBoxer(THREE, { variant: v });
  boxes[v] = b;
  ok(b.group instanceof Group && typeof b.pose === 'function'
    && typeof b.tick === 'function' && typeof b.dispose === 'function', `${v}: API shape`);
  for (const p of ['head', 'torso', 'gloveL', 'gloveR', 'squash', 'root',
    'eyeL', 'eyeR', 'browL', 'browR', 'mouth', 'armL', 'armR', 'footL', 'footR'])
    if (!b.parts[p]) { failed++; console.error(`FAIL ${v}: missing part ${p}`); }
  ok(b.parts.head && b.parts.torso && b.parts.gloveL && b.parts.gloveR, `${v}: core parts present`);
  ok(b.parts.head.position.y > .7 && b.parts.head.position.y < 1.15,
    `${v}: big head near top (y=${b.parts.head.position.y.toFixed(2)})`);
  ok(b.parts.footL.position.y < .15 && Math.abs(b.parts.root.position.y) < .01,
    `${v}: feet at ground / root unpolluted`);
  let meshes = 0, shells = 0;
  b.group.traverse(m => {
    if (m.type === 'Mesh') meshes++;
    if (m.material && m.material.side === 1) shells++;
  });
  ok(meshes > 20, `${v}: built ${meshes} meshes`);
  ok(shells >= 8, `${v}: ink outline shells present (${shells})`);
}

// ---- poses all run + animate ----
const b = boxes.bubble;
const restZ = b.parts.gloveL.position.z, restRootRx = b.parts.root.rotation.x;
for (const p of POSES)
  for (let k = 0; k <= 1.001; k += .2) { b.pose(p, k); b.tick(1 / 60); }
ok(true, 'all 9 poses sweep 0..1 without throwing');

b.pose('jab', .5);
for (let i = 0; i < 40; i++) b.tick(1 / 60);
ok(b.parts.gloveL.position.z > restZ + .15,
  `jab extends gloveL (+${(b.parts.gloveL.position.z - restZ).toFixed(2)} z)`);

b.snap('down', 1);                               // snap = instant pose apply
ok(b.parts.root.rotation.x < -1.2, `down tips body backward (rx=${b.parts.root.rotation.x.toFixed(2)})`);
for (let i = 0; i < 30; i++) b.tick(1 / 60);

// a consumer that pins down t01 at 1 (like npc.js) still gets a fall ramp
const c = buildBoxer(THREE, { variant: 'bean' });
c.pose('idle', 0); c.tick(1 / 60);
const rots = [];
for (let i = 0; i < 30; i++) { c.pose('down', 1); c.tick(1 / 60); rots.push(c.parts.root.rotation.x); }
ok(rots[1] > -.8 && rots[29] < -1.3, 'pinned down t01 still ramps the fall');
// cyclic poses accept t01 > 1 without freezing
c.pose('celebrate', 2.75);
const gy = [c.parts.gloveL.position.y];
c.tick(1 / 30); gy.push(c.parts.gloveL.position.y);
c.pose('celebrate', 3.05); c.tick(1 / 30); gy.push(c.parts.gloveL.position.y);
ok(Math.abs(gy[2] - gy[0]) > .01, 'celebrate loops on raw t01 > 1');

// ---- expression modes ----
const eyeChild = (e, mode) => e.children.find(c => c.userData.mode === mode);
b.pose('hurt', .5);
ok(eyeChild(b.parts.eyeL, 'x').visible && !eyeChild(b.parts.eyeL, 'open').visible,
  'hurt → X eyes');
b.pose('down', .8);
ok(eyeChild(b.parts.eyeR, 'spiral').visible, 'down → spiral eyes');
b.pose('celebrate', .5);
ok(eyeChild(b.parts.eyeL, 'happy').visible, 'celebrate → happy eyes');
b.pose('idle', 0);
ok(eyeChild(b.parts.eyeL, 'open').visible && !eyeChild(b.parts.eyeL, 'x').visible,
  'idle → open eyes again');
const mouthChild = mode => b.parts.mouth.children.find(c => c.userData.mode === mode);
b.pose('windup', 1);
ok(mouthChild('flat').visible, 'windup → gritted flat mouth');

// ---- breathing actually moves things between identical poses ----
b.pose('idle', 0);
const y0 = b.parts.torso.scale.y;
b.tick(.4);
ok(Math.abs(b.parts.torso.scale.y - y0) > .002, 'tick adds breathing motion');

// ---- determinism ----
const run = () => {
  const x = buildBoxer(THREE, { variant: 'bean' });
  const seq = [];
  for (const [p, k] of [['jab', .5], ['hurt', .3], ['celebrate', .7], ['idle', .2]]) {
    x.pose(p, k); x.tick(.016); x.tick(.033);
    seq.push(x.parts.gloveL.position.z + x.parts.root.rotation.x + x.parts.head.position.y);
  }
  return seq;
};
const s1 = run(), s2 = run();
ok(s1.every((v, i) => Math.abs(v - s2[i]) < 1e-12), 'deterministic given same (dt,pose,t01)');

// ---- palette override ----
const custom = buildBoxer(THREE, { variant: 'blocky', palette: { glove: 0x123456 } });
ok(custom.parts.gloveL.children[0].material.color === 0x123456, 'palette override reaches gloves');

// ---- fallbacks ----
let threw = false;
try { buildBoxer(THREE, { variant: 'nope' }).pose('bogus', .5); } catch (e) { threw = true; }
ok(!threw, 'unknown variant + unknown pose fall back gracefully');

// ---- dispose ----
const d = buildBoxer(THREE);
let disposedGeos = 0;
d.group.traverse(m => { if (m.geometry) m.geometry.__seen = true; });
d.dispose();
d.group.traverse(m => { if (m.geometry?.disposed) disposedGeos++; });
ok(disposedGeos > 0, `dispose() frees geometry (${disposedGeos} geos)`);

console.log(failed ? `\n${failed} FAILURE(S)` : '\nboxing-proto: all green');
process.exit(failed ? 1 : 0);
