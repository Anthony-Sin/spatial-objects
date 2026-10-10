/* shared/boxing/protoBoxer.js — the procedural cute NPC boxer.

   Animal Crossing meets Little Mac: a ~1.3-unit chibi fighter built ONLY
   from Three.js primitives + flat/toon materials, with ink outlines via
   the inverted-hull trick (a slightly larger back-face shell per part).
   No skeleton, no assets, no DOM, no top-level 'three' import — pass the
   THREE namespace in, so this file imports safely under plain node.

     import * as THREE from 'three';
     const pip = buildBoxer(THREE, { variant: 'bubble' });
     scene.add(pip.group);                      // feet at y=0, faces +Z
     // per frame:  pip.pose(action, actionT01);  pip.tick(dt);
     // poses: idle windup jab cross hook block hurt down celebrate

   API (see .teamwork/CONTRACT.md):
     VARIANTS                                    → string ids, >=3 styles
     VARIANT_INFO                                → {id:{label,desc}} for lineup
     buildBoxer(THREE, {variant='bubble', palette={}})
       → { group,            // add to scene; you own its world transform
           parts,            // named nodes: head, torso, gloveL, gloveR, ...
           pose(name,t01),   // set target pose (blended by tick)
           snap(name,t01),   // pose + apply instantly (lineup thumbnails)
           tick(dt,state),   // breathing bounce + exp-blend toward target
           dispose(),
           variant, height }

   Animation is pure deterministic math (sin/lerp on named parts) — same
   (dt, pose, t01) stream always produces the same motion. pose() writes a
   target transform table; tick() eases each node toward it (gloves faster
   than body = punch snap), then adds breathing, blinks, pupil wander, stub
   arm/leg rubber-limbs aimed at the gloves/feet, and squash-and-stretch. */
const HOUSE = {
  paper: 0xfff8ec, paper2: 0xfdf3e3, ink: 0x2b2118,
  coral: 0xff6b57, sun: 0xffc53d, leaf: 0x4fb06d,
  sky: 0x5da9e9, berry: 0xb565d8,
};

export const VARIANTS = ['bubble', 'blocky', 'bean'];
export const VARIANT_INFO = {
  bubble: { label: 'BUBBLE', desc: 'sprout crown · springy stance' },
  blocky: { label: 'BLOCKY', desc: 'flat top · compact guard' },
  bean:   { label: 'BEAN',   desc: 'leaf cap · loose weave' },
};

// each variant keeps its own flavor inside the house palette
const VPAL = {
  bubble: { skin: 0xffc99a, skinShade: 0xdfaa82, skinLight: 0xffd0a5,
    glove: HOUSE.coral, gloveDeep: 0xc63e38, gloveShine: 0xff947b,
    shorts: HOUSE.sun, trim: HOUSE.paper, cheek: 0xff9b7a, leaf: HOUSE.leaf },
  blocky: { skin: 0xe9b78f, skinShade: 0xc99170, skinLight: 0xefbf99,
    glove: HOUSE.sky, gloveDeep: 0x337eae, gloveShine: 0x9ad1fa,
    shorts: HOUSE.leaf, trim: HOUSE.paper, cheek: 0xff9b7a, leaf: HOUSE.ink },
  bean: { skin: 0xf6c48c, skinShade: 0xd69a70, skinLight: 0xf9c997,
    glove: HOUSE.berry, gloveDeep: 0x843aa4, gloveShine: 0xd9a5ed,
    shorts: HOUSE.sky, trim: HOUSE.paper, cheek: 0xff9b7a, leaf: HOUSE.leaf },
};

// ---- tiny math kit (deterministic — no Math.random, no Date) ----
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const lerp = (a, b, t) => a + (b - a) * t;
const TAU = Math.PI * 2;
// smoothstep between edges
const ss = (a, b, t) => { const u = clamp((t - a) / (b - a), 0, 1); return u * u * (3 - 2 * u); };
// punch envelope: snap out (~.25), hold (~.47), ease back — one 0..1 phase
const attack = k => k <= 0 ? 0 : k < .25 ? Math.pow(k / .25, .55)
  : k < .72 ? 1 : 1 - Math.pow((k - .72) / .28, 1.4);
// classic easeOutBounce — KO bodies should hit the mat like a dropped plush
const bounce = t => {
  if (t < 1 / 2.75) return 7.5625 * t * t;
  if (t < 2 / 2.75) return 7.5625 * (t -= 1.5 / 2.75) * t + .75;
  if (t < 2.5 / 2.75) return 7.5625 * (t -= 2.25 / 2.75) * t + .9375;
  return 7.5625 * (t -= 2.625 / 2.75) * t + .984375;
};

// ---- per-variant build knobs ----
// face: ex/ey/ez eye offset in head space, by brow height, my mouth drop,
// bx/byy blush offset. guard: rest glove positions (body space, +Z = front).
const CFG = {
  bubble: {
    headY: .96,
    face: { ex: .115, ey: .05, ez: .262, by: .155, my: -.105, bx: .18, byy: -.05 },
    shx: .30, shy: .66, armR: .05, armLen: .18, gloveR: .17,
    guard: { l: [-.27, .70, .27], r: [.28, .68, .23] },
    hipX: .13, hipY: .30, legR: .05, legLen: .12, foot: [.14, .055, .045],
  },
  blocky: {
    headY: .99,
    face: { ex: .13, ey: .03, ez: .243, by: .135, my: -.125, bx: .195, byy: -.06 },
    shx: .33, shy: .66, armR: .06, armLen: .17, gloveR: .165,
    guard: { l: [-.30, .70, .26], r: [.31, .68, .22] },
    hipX: .15, hipY: .33, legR: .055, legLen: .11, foot: [.15, .05, .05],
  },
  bean: {
    headY: .95,
    face: { ex: .105, ey: .02, ez: .235, by: .125, my: -.10, bx: .165, byy: -.055 },
    shx: .295, shy: .60, armR: .05, armLen: .17, gloveR: .165,
    guard: { l: [-.26, .65, .28], r: [.27, .63, .24] },
    hipX: .11, hipY: .24, legR: .045, legLen: .10, foot: [.11, .048, .05],
  },
};

export function buildBoxer(THREE, { variant = 'bubble', palette = {}, playerLook = false } = {}) {
  if (!THREE || !THREE.Group || !THREE.Mesh)
    throw new Error('buildBoxer(THREE, opts): pass the THREE namespace in');
  if (!VARIANTS.includes(variant)) {
    if (typeof console !== 'undefined') console.warn('protoBoxer: unknown variant', variant, '— using bubble');
    variant = 'bubble';
  }
  const C = CFG[variant];
  const P = { ...VPAL[variant], ink: HOUSE.ink, paper: HOUSE.paper, ...palette };
  const Toon = THREE.MeshToonMaterial || THREE.MeshLambertMaterial || THREE.MeshBasicMaterial;
  const Basic = THREE.MeshBasicMaterial || Toon;
  const BACK = THREE.BackSide !== undefined ? THREE.BackSide : 1;

  const geos = new Set(), mats = new Set();
  const gm = g => (geos.add(g), g), mt = m => (mats.add(m), m);
  const toon = (c, o = {}) => mt(new Toon({ color: c, ...o }));
  const basic = (c, o = {}) => mt(new Basic({ color: c, ...o }));
  const inkHullMat = basic(P.ink, { side: BACK });
  const inkFlat = basic(P.ink);

  const SPH = (r, w = 20, h = 14) => gm(new THREE.SphereGeometry(r, w, h));
  const BOX = (x, y, z) => gm(new THREE.BoxGeometry(x, y, z));
  const CAP = (r, l) => gm(new THREE.CapsuleGeometry(r, l, 6, 14));
  const CYL = (rt, rb, h, s = 14) => gm(new THREE.CylinderGeometry(rt, rb, h, s));
  const TOR = (r, t, a = TAU) => gm(new THREE.TorusGeometry(r, t, 10, 24, a));

  const grp = (x = 0, y = 0, z = 0) => { const g = new THREE.Group(); g.position.set(x, y, z); return g; };
  const put = (par, ch) => (par.add(ch), ch);

  // a solid-color mesh wrapped in its own ink shell (inverted hull outline)
  function inked(geo, color, { hull = .055, material } = {}) {
    const m = new THREE.Mesh(geo, material || toon(color));
    if (hull) {
      const h = new THREE.Mesh(geo, inkHullMat);
      const k = 1 + hull;
      h.scale.set(k, k, k);
      m.add(h);
    }
    m.castShadow = true;
    return m;
  }

  // ---- rig skeleton: group → root(bounce/fall) → squash(stretch) → parts ----
  const group = new THREE.Group();
  group.name = 'protoBoxer:' + variant;
  const root = put(group, grp());
  const squash = put(root, grp());

  const parts = {}, rest = {};
  function mark(n, nd) {
    parts[n] = nd;
    if (nd && nd.position)
      rest[n] = {
        p: [nd.position.x, nd.position.y, nd.position.z],
        r: [nd.rotation.x, nd.rotation.y, nd.rotation.z],
        s: [nd.scale.x, nd.scale.y, nd.scale.z],
      };
    return nd;
  }
  mark('root', root); mark('squash', squash);

  // stub limb: shoulder/hip pivot whose bone capsule always aims (+Z local)
  // at its end effector — rubber-hose arms, no skeleton needed
  function limb(name, hx, hy, r, len, col) {
    const piv = grp(hx, hy, 0);
    piv.rotation.order = 'YXZ';                    // yaw outside pitch
    const bone = inked(CAP(r, len), col);
    bone.rotation.x = Math.PI / 2;                 // capsule axis Y → +Z
    bone.position.z = len / 2;
    piv.add(bone);
    piv.userData.bone = bone;
    piv.userData.len = len;
    return mark(name, put(squash, piv));
  }

  // ---- face (built in head space; modes toggled via .visible) ----
  const eyes = [], pupils = [], openEyes = [];
  let mouth = null;

  function buildEye(side, F) {
    const e = grp(side * F.ex, F.ey, F.ez);
    const open = grp();
    const white = new THREE.Mesh(SPH(.075, 14, 10), basic(P.paper));
    white.scale.set(1, 1.18, .5);
    const pupil = new THREE.Mesh(SPH(.032, 10, 8), inkFlat);
    pupil.position.set(0, -.004, .052);
    open.add(white, pupil);
    open.userData.mode = 'open';
    pupils.push(pupil); openEyes.push(open);

    const x = grp();
    for (const s of [-1, 1]) {
      const bar = new THREE.Mesh(BOX(.115, .026, .02), inkFlat);
      bar.rotation.z = s * .7;
      x.add(bar);
    }
    x.userData.mode = 'x'; x.visible = false;

    const spiral = grp();                          // dizzy swirl, two nested rings
    const s1 = new THREE.Mesh(TOR(.05, .011), inkFlat);
    const s2 = new THREE.Mesh(TOR(.022, .011), inkFlat);
    s2.position.z = .004;
    spiral.add(s1, s2);
    spiral.userData.mode = 'spiral'; spiral.visible = false;

    const happy = new THREE.Mesh(TOR(.052, .014, Math.PI), inkFlat); // '◠'
    happy.userData.mode = 'happy'; happy.visible = false;

    e.add(open, x, spiral, happy);
    e.userData.mode = 'open';
    eyes.push(e);
    return e;
  }

  function setEyes(mode) {
    for (const e of eyes) {
      e.userData.mode = mode;
      for (const c of e.children) c.visible = c.userData.mode === mode;
    }
  }

  function buildMouth(F) {
    const m = grp(0, F.my, F.ez + .012);
    const smile = new THREE.Mesh(TOR(.065, .013, Math.PI), inkFlat); // '◡'
    smile.rotation.z = Math.PI;
    smile.userData.mode = 'smile';
    const grin = new THREE.Mesh(TOR(.08, .017, Math.PI), inkFlat);
    grin.rotation.z = Math.PI; grin.scale.set(1.15, 1.15, 1);
    grin.userData.mode = 'grin'; grin.visible = false;
    const o = new THREE.Mesh(SPH(.042, 10, 8), inkFlat);
    o.scale.set(1, 1.15, .45);
    o.userData.mode = 'o'; o.visible = false;
    const flat = new THREE.Mesh(BOX(.11, .024, .02), inkFlat);
    flat.userData.mode = 'flat'; flat.visible = false;
    m.add(smile, grin, o, flat);
    m.userData.mode = 'smile';
    return m;
  }

  function setMouth(mode) {
    mouth.userData.mode = mode;
    for (const c of mouth.children) c.visible = c.userData.mode === mode;
  }

  function buildFace(headNode, F) {
    mark('eyeL', put(headNode, buildEye(-1, F)));
    mark('eyeR', put(headNode, buildEye(1, F)));
    for (const s of [-1, 1]) {
      const b = new THREE.Mesh(BOX(.12, .028, .03), inkFlat);
      b.position.set(s * F.ex, F.by, F.ez + .015);
      mark(s < 0 ? 'browL' : 'browR', put(headNode, b));
      const blush = new THREE.Mesh(SPH(.045, 10, 8), basic(P.cheek));
      blush.scale.set(1, .7, .4);
      blush.position.set(s * F.bx, F.byy, F.ez - .01);
      put(headNode, blush);
      for (let i = 0; i < 2; i++) {
        const freckle = new THREE.Mesh(SPH(.008, 8, 6), basic(P.ink));
        freckle.position.set(s * (F.bx - .018 + i * .021), F.byy - .007, F.ez + .014);
        put(headNode, freckle);
      }
    }
    const nose = new THREE.Mesh(SPH(.022, 10, 8), basic(P.cheek));
    nose.scale.set(.9, .65, .55);
    nose.position.set(0, F.my + .05, F.ez + .04);
    put(headNode, nose);
    mouth = buildMouth(F);
    mark('mouth', put(headNode, mouth));
  }

  // ---- boxing glove: padded knuckle panel, thumb and layered cuff ----
  function buildGlove(side) {
    const g = grp();
    const R = C.gloveR;
    const main = inked(SPH(R, 18, 12), P.glove);
    main.scale.set(1, .96, 1.04);
    const thumb = inked(SPH(R * .42, 12, 9), P.glove);
    thumb.position.set(-side * R * .6, -R * .32, R * .32);
    thumb.scale.set(.9, .85, 1.15);
    const pad = new THREE.Mesh(SPH(R * .64, 14, 10), toon(P.gloveShine));
    pad.scale.set(.9, .55, .16);
    pad.position.set(-side * R * .09, R * .17, R * .93);
    const cuffBand = inked(TOR(R * .68, R * .13), P.gloveDeep);
    cuffBand.position.z = -R * .68;
    const cuff = inked(TOR(R * .62, R * .2), P.trim);
    cuff.position.z = -R * .82;
    g.add(main, thumb, pad, cuffBand, cuff);
    return g;
  }

  function dressShorts(shorts, sideX, frontZ, waistY) {
    for (const s of [-1, 1]) {
      const stripe = new THREE.Mesh(BOX(.025, .10, .012), toon(P.trim));
      stripe.position.set(s * sideX, -.025, frontZ);
      shorts.add(stripe);
    }
    const badge = new THREE.Mesh(CYL(.046, .046, .014, 12), toon(P.trim));
    badge.rotation.x = Math.PI / 2;
    badge.position.set(0, waistY, frontZ + .025);
    shorts.add(badge);
    const center = new THREE.Mesh(CYL(.016, .016, .016, 10), basic(P.ink));
    center.rotation.x = Math.PI / 2;
    center.position.set(0, waistY, frontZ + .037);
    shorts.add(center);
  }

  // ---- the three bodies ----
  const BUILDERS = {
    bubble() {
      for (const s of [-1, 1]) {
        const f = inked(SPH(.095, 14, 10), P.gloveDeep);
        f.scale.set(1.15, .6, 1.4);
        f.position.set(s * C.foot[0], C.foot[1], C.foot[2]);
        mark(s < 0 ? 'footL' : 'footR', put(squash, f));
      }
      limb('legL', -C.hipX, C.hipY, C.legR, C.legLen, P.skin);
      limb('legR', C.hipX, C.hipY, C.legR, C.legLen, P.skin);

      const shorts = grp(0, .32, 0);
      const sh = inked(SPH(.30, 20, 14), P.shorts);
      sh.scale.set(1, .75, .95);
      const waist = inked(TOR(.245, .035), P.trim);
      waist.rotation.x = Math.PI / 2; waist.position.y = .1;
      shorts.add(sh, waist);
      dressShorts(shorts, .22, .25, .11);
      mark('shorts', put(squash, shorts));

      const torso = grp(0, .58, 0);
      const belly = inked(SPH(.29, 22, 16), P.skin);
      belly.scale.set(1, .96, .88);
      torso.add(belly);
      for (const s of [-1, 1]) {
        const shoulder = new THREE.Mesh(SPH(.075, 12, 10), toon(P.skinLight));
        shoulder.scale.set(.75, .42, .18);
        shoulder.position.set(s * .14, .115, .225);
        torso.add(shoulder);
      }
      const bellyLight = new THREE.Mesh(SPH(.11, 14, 10), toon(P.skinLight));
      bellyLight.scale.set(1, .34, .12);
      bellyLight.position.set(0, -.105, .247);
      torso.add(bellyLight);
      mark('torso', put(squash, torso));

      const head = grp(0, C.headY, 0);
      head.add(inked(SPH(.30, 24, 18), P.skin));
      for (const s of [-1, 1]) {
        const ear = inked(SPH(.055, 12, 9), P.skinShade, { hull: .035 });
        ear.position.set(s * .29, -.035, .025);
        head.add(ear);
      }
      buildFace(head, C.face);
      const tuft = grp(0, .28, 0);                 // little sprout on top
      const stem = inked(CYL(.014, .02, .09), P.leaf);
      stem.position.y = .03; stem.rotation.z = .15;
      const blade = inked(SPH(.05, 10, 8), P.leaf);
      blade.scale.set(1.6, .45, .9);
      blade.position.set(.06, .07, 0); blade.rotation.z = -.5;
      tuft.add(stem, blade);
      mark('tuft', put(head, tuft));
      mark('head', put(squash, head));
    },

    blocky() {
      for (const s of [-1, 1]) {
        const f = inked(BOX(.17, .10, .24), P.gloveDeep);
        f.position.set(s * C.foot[0], C.foot[1], C.foot[2]);
        mark(s < 0 ? 'footL' : 'footR', put(squash, f));
      }
      limb('legL', -C.hipX, C.hipY, C.legR, C.legLen, P.skin);
      limb('legR', C.hipX, C.hipY, C.legR, C.legLen, P.skin);

      const shorts = grp(0, .30, 0);
      shorts.add(inked(BOX(.56, .18, .38), P.shorts));
      const waist = inked(BOX(.57, .05, .39), P.trim);
      waist.position.y = .115;
      shorts.add(waist);
      dressShorts(shorts, .215, .198, .115);
      mark('shorts', put(squash, shorts));

      const torso = grp(0, .55, 0);
      torso.add(inked(BOX(.50, .34, .34), P.skin));
      const chest = new THREE.Mesh(BOX(.29, .045, .012), toon(P.skinLight));
      chest.position.set(0, .07, .176);
      torso.add(chest);
      mark('torso', put(squash, torso));

      const head = grp(0, C.headY, 0);
      head.add(inked(BOX(.54, .48, .48), P.skin));
      for (const s of [-1, 1]) {
        const ear = inked(BOX(.07, .12, .105), P.skinShade, { hull: .035 });
        ear.position.set(s * .295, -.035, .035);
        head.add(ear);
      }
      buildFace(head, C.face);
      const tuft = grp(0, .26, 0);                 // flat-top hair + fringe
      const top = inked(BOX(.56, .10, .50), P.leaf);
      top.position.y = .05;
      const fringe = inked(BOX(.56, .09, .08), P.leaf);
      fringe.position.set(0, -.015, .21);
      tuft.add(top, fringe);
      mark('tuft', put(head, tuft));
      mark('head', put(squash, head));
    },

    bean() {
      for (const s of [-1, 1]) {
        const f = inked(SPH(.08, 12, 9), P.gloveDeep);
        f.scale.set(1.2, .6, 1.45);
        f.position.set(s * C.foot[0], C.foot[1], C.foot[2]);
        mark(s < 0 ? 'footL' : 'footR', put(squash, f));
      }
      limb('legL', -C.hipX, C.hipY, C.legR, C.legLen, P.skin);
      limb('legR', C.hipX, C.hipY, C.legR, C.legLen, P.skin);

      const shorts = grp(0, .30, 0);
      const sh = inked(SPH(.295, 18, 12), P.shorts);
      sh.scale.set(1.02, .62, .98);
      const waist = inked(TOR(.24, .032), P.trim);
      waist.rotation.x = Math.PI / 2; waist.position.y = .11;
      shorts.add(sh, waist);
      dressShorts(shorts, .21, .25, .11);
      mark('shorts', put(squash, shorts));

      const torso = grp(0, .58, 0);
      const body = inked(CAP(.25, .27), P.skin);
      body.scale.z = .87;
      torso.add(body);
      const chest = new THREE.Mesh(SPH(.105, 14, 10), toon(P.skinLight));
      chest.scale.set(1, .32, .15);
      chest.position.set(0, .055, .224);
      torso.add(chest);
      mark('torso', put(squash, torso));

      const head = grp(0, C.headY, 0);             // head cap melts into bean
      const cap = inked(SPH(.27, 22, 16), P.skin);
      cap.scale.set(1, .95, 1);
      head.add(cap);
      for (const s of [-1, 1]) {
        const ear = inked(SPH(.046, 12, 9), P.skinShade, { hull: .035 });
        ear.position.set(s * .265, -.045, .015);
        head.add(ear);
      }
      buildFace(head, C.face);
      const tuft = grp(0, .26, 0);                 // stem + two leaf blobs
      const stem = inked(CYL(.016, .022, .08), P.leaf);
      stem.rotation.z = .2; stem.position.y = .02;
      for (const s of [-1, 1]) {
        const lf = inked(SPH(.042, 10, 8), P.leaf);
        lf.scale.set(1.5, .4, .8);
        lf.position.set(s * .05, .065, 0); lf.rotation.z = s * -.45;
        tuft.add(lf);
      }
      tuft.add(stem);
      mark('tuft', put(head, tuft));
      mark('head', put(squash, head));
    },
  };

  BUILDERS[variant]();
  if (playerLook) {
    // A ring-ready headband makes the entrance boxer readable beside the
    // opponent, even though both share the same compact procedural rig.
    const band = inked(TOR(variant === 'blocky' ? .285 : .275, .027), P.trim, { hull: .025 });
    band.rotation.x = Math.PI / 2;
    band.position.y = variant === 'blocky' ? .13 : .105;
    parts.head.add(band);
    const knot = inked(SPH(.043, 10, 8), P.gloveDeep, { hull: .025 });
    knot.scale.set(1.4, .6, .6);
    knot.position.set(.20, .11, .21);
    parts.head.add(knot);
  }
  limb('armL', -C.shx, C.shy, C.armR, C.armLen, P.skin);
  limb('armR', C.shx, C.shy, C.armR, C.armLen, P.skin);
  mark('gloveL', put(squash, (g => (g.position.set(...C.guard.l), g))(buildGlove(-1))));
  mark('gloveR', put(squash, (g => (g.position.set(...C.guard.r), g))(buildGlove(1))));
  if (playerLook) for (const side of ['gloveL', 'gloveR'])
    for (const mesh of parts[side].children) mesh.visible = false;

  // ---- pose engine: pose() fills a target table, tick() blends to it ----
  const T = {};
  let cur = 'idle', curK = 0, time = 0, eyeMode = 'open', mouthMode = 'smile';
  const flags = { eye: 'open', mouth: 'smile' };
  const warned = new Set();

  function resetTargets() {
    for (const n in rest) {
      const r = rest[n], t = T[n] || (T[n] = { p: [0, 0, 0], r: [0, 0, 0], s: [1, 1, 1] });
      for (let i = 0; i < 3; i++) { t.p[i] = r.p[i]; t.r[i] = r.r[i]; t.s[i] = r.s[i]; }
    }
  }

  /* POSES — each mutates the fresh-from-rest target table T.
     k = t01 phase. f = {eye, mouth} expression modes. R = rest table. */
  const R = rest;
  const POSES = {
    idle(t, k, f) {
      const w = Math.sin(k * TAU);
      const weave = variant === 'bean' ? .085 : variant === 'blocky' ? .018 : .04;
      t.root.r[2] = w * weave;
      t.head.r[2] = Math.sin(k * TAU + .7) * (variant === 'bean' ? .075 : .04);
      t.root.p[1] += variant === 'bubble' ? Math.abs(w) * .025 : 0;
      t.gloveL.p[1] += w * (variant === 'blocky' ? .012 : .03);
      t.gloveR.p[1] += Math.sin(k * TAU + 1.3) * (variant === 'blocky' ? .012 : .03);
      if (variant === 'blocky') {
        t.gloveL.p[0] += .035; t.gloveR.p[0] -= .035; // compact guard
      }
      t.torso.r[0] = .04;
      f.mouth = 'smile';
    },
    windup(t, k, f) {                            // telegraphed right-hand load
      const e = ss(0, 1, k);
      t.gloveR.p = [R.gloveR.p[0] + .12 * e, R.gloveR.p[1] + .05 * e, R.gloveR.p[2] - .26 * e];
      t.gloveR.s = [1 + .18 * e, 1 + .18 * e, 1 + .18 * e];   // cocked glove swells
      t.gloveR.r[0] = .5 * e;
      t.gloveL.p[2] -= .07 * e;
      t.torso.r[1] = .42 * e; t.head.r[1] = -.14 * e;
      t.squash.s = [1 + .05 * e, 1 - .07 * e, 1 + .05 * e];
      t.root.p[1] -= .02 * e;
      t.browL.r[2] = -.45 * e; t.browR.r[2] = .45 * e;      // angry V
      t.browL.p[1] -= .015 * e; t.browR.p[1] -= .015 * e;
      f.mouth = 'flat';
    },
    windupL(t, k, f) {                           // gloveL-side load — X/yaw mirror of windup
      const e = ss(0, 1, k);
      t.gloveL.p = [R.gloveL.p[0] - .12 * e, R.gloveL.p[1] + .05 * e, R.gloveL.p[2] - .26 * e];
      t.gloveL.s = [1 + .18 * e, 1 + .18 * e, 1 + .18 * e];
      t.gloveL.r[0] = .5 * e;
      t.gloveR.p[2] -= .07 * e;
      t.torso.r[1] = -.42 * e; t.head.r[1] = .14 * e;
      t.squash.s = [1 + .05 * e, 1 - .07 * e, 1 + .05 * e];
      t.root.p[1] -= .02 * e;
      t.browL.r[2] = -.45 * e; t.browR.r[2] = .45 * e;
      t.browL.p[1] -= .015 * e; t.browR.p[1] -= .015 * e;
      f.mouth = 'flat';
    },
    jab(t, k, f) {                               // left snap straight out +Z
      const e = attack(k);
      t.gloveL.p = [lerp(R.gloveL.p[0], -.05, e), lerp(R.gloveL.p[1], .74, e), lerp(R.gloveL.p[2], .68, e)];
      t.gloveL.s = [1 - .12 * e, 1 - .12 * e, 1 + .4 * e];  // motion smear
      t.gloveL.r[0] = -.3 * e;
      t.torso.r[1] = .42 * e; t.head.r[1] = -.08 * e;
      t.squash.s = [1 - .02 * e, 1 + .02 * e, 1 + .05 * e];
      t.gloveR.p[2] -= .07 * e;
      t.browL.r[2] = -.3 * e; t.browR.r[2] = .3 * e;
      f.mouth = 'flat';
    },
    cross(t, k, f) {                             // right power shot, big twist
      const e = attack(k);
      t.gloveR.p = [lerp(R.gloveR.p[0], .05, e), lerp(R.gloveR.p[1], .73, e), lerp(R.gloveR.p[2], .72, e)];
      t.gloveR.s = [1 - .12 * e, 1 - .12 * e, 1 + .45 * e];
      t.gloveR.r[0] = -.35 * e;
      t.torso.r[1] = -.52 * e; t.head.r[1] = .12 * e;
      t.root.p[2] += .05 * e;
      t.squash.s = [1 - .02 * e, 1 + .03 * e, 1 + .06 * e];
      t.gloveL.p[2] -= .1 * e;
      t.browL.r[2] = -.35 * e; t.browR.r[2] = .35 * e;
      f.mouth = 'o';
    },
    jabL(t, k, f) {                              // gloveR snap — X/yaw mirror of jab
      const e = attack(k);
      t.gloveR.p = [lerp(R.gloveR.p[0], .05, e), lerp(R.gloveR.p[1], .74, e), lerp(R.gloveR.p[2], .68, e)];
      t.gloveR.s = [1 - .12 * e, 1 - .12 * e, 1 + .4 * e];
      t.gloveR.r[0] = -.3 * e;
      t.torso.r[1] = -.42 * e; t.head.r[1] = .08 * e;
      t.squash.s = [1 - .02 * e, 1 + .02 * e, 1 + .05 * e];
      t.gloveL.p[2] -= .07 * e;
      t.browL.r[2] = -.3 * e; t.browR.r[2] = .3 * e;
      f.mouth = 'flat';
    },
    hookL(t, k, f) {                             // gloveR arm whips — mirror of hook
      const e = attack(k);
      const arc = Math.sin(e * Math.PI);
      t.gloveR.p = [
        lerp(R.gloveR.p[0], -.05, e) + arc * .20,
        lerp(R.gloveR.p[1], .76, e),
        lerp(R.gloveR.p[2], .36, e) + arc * .07,
      ];
      t.gloveR.r[1] = -1.25 * e;
      t.gloveR.s = [1 + .22 * e, 1 - .08 * e, 1 - .08 * e];
      t.torso.r[1] = -.58 * e; t.head.r[1] = .16 * e;
      t.squash.s = [1 + .04 * e, 1 - .02 * e, 1 - .02 * e];
      t.browL.r[2] = -.35 * e; t.browR.r[2] = .35 * e;
      f.mouth = 'o';
    },
    crossL(t, k, f) {                            // gloveL power shot — mirror of cross
      const e = attack(k);
      t.gloveL.p = [lerp(R.gloveL.p[0], -.05, e), lerp(R.gloveL.p[1], .73, e), lerp(R.gloveL.p[2], .72, e)];
      t.gloveL.s = [1 - .12 * e, 1 - .12 * e, 1 + .45 * e];
      t.gloveL.r[0] = -.35 * e;
      t.torso.r[1] = .52 * e; t.head.r[1] = -.12 * e;
      t.root.p[2] += .05 * e;
      t.squash.s = [1 - .02 * e, 1 + .03 * e, 1 + .06 * e];
      t.gloveR.p[2] -= .1 * e;
      t.browL.r[2] = -.35 * e; t.browR.r[2] = .35 * e;
      f.mouth = 'o';
    },
    hook(t, k, f) {                              // left arm whips in an arc
      const e = attack(k);
      const arc = Math.sin(e * Math.PI);
      t.gloveL.p = [
        lerp(R.gloveL.p[0], .05, e) - arc * .20,   // swing wide then across
        lerp(R.gloveL.p[1], .76, e),
        lerp(R.gloveL.p[2], .36, e) + arc * .07,
      ];
      t.gloveL.r[1] = 1.25 * e;
      t.gloveL.s = [1 + .22 * e, 1 - .08 * e, 1 - .08 * e];
      t.torso.r[1] = .58 * e; t.head.r[1] = -.16 * e;
      t.squash.s = [1 + .04 * e, 1 - .02 * e, 1 - .02 * e];
      t.browL.r[2] = -.35 * e; t.browR.r[2] = .35 * e;
      f.mouth = 'o';
    },
    block(t, k, f) {                             // mitts up over the face
      const b = ss(0, .4, k);
      t.gloveL.p = [lerp(R.gloveL.p[0], -.13, b), lerp(R.gloveL.p[1], .88, b), lerp(R.gloveL.p[2], .34, b)];
      t.gloveR.p = [lerp(R.gloveR.p[0], .13, b), lerp(R.gloveR.p[1], .88, b), lerp(R.gloveR.p[2], .34, b)];
      t.gloveL.r[1] = -.3 * b; t.gloveR.r[1] = .3 * b;
      t.head.p[1] -= .04 * b; t.head.r[0] = .18 * b;
      t.torso.r[0] = .14 * b;
      t.squash.s = [1 + .05 * b, 1 - .06 * b, 1 + .05 * b];
      t.root.p[1] -= .03 * b;
      t.browL.r[2] = -.15 * b; t.browR.r[2] = .15 * b;
      f.mouth = 'flat';
    },
    hurt(t, k, f) {                              // recoiled, wobbly, X eyes
      const e = attack(k);
      t.head.r[0] = -.55 * e; t.head.p[1] += .03 * e;
      t.root.r[0] = -.14 * e; t.root.p[2] -= .07 * e;
      t.root.r[2] = Math.sin(k * 9.4) * .08 * (1 - k);
      t.gloveL.p = [R.gloveL.p[0] - .16 * e, R.gloveL.p[1] - .15 * e, R.gloveL.p[2] - .14 * e];
      t.gloveR.p = [R.gloveR.p[0] + .18 * e, R.gloveR.p[1] - .12 * e, R.gloveR.p[2] - .16 * e];
      t.squash.s = [1 + .12 * e, 1 - .14 * e, 1 + .08 * e];
      t.browL.r[2] = .4 * e; t.browR.r[2] = -.4 * e;        // worried Λ
      t.browL.p[1] += .02 * e; t.browR.p[1] += .02 * e;
      f.eye = k > .1 && k < .85 ? 'x' : 'open';
      f.mouth = 'o';
    },
    down(t, k, f) {                              // KO: side fall, face to camera
      const fo = bounce(Math.min(k / .6, 1));
      const e = ss(.55, 1, k);
      t.root.r[2] = -1.32 * fo;
      t.root.r[0] = -.12 * fo;
      t.root.p[0] = -.30 * fo;                    // center the horizontal body
      t.root.p[1] = .18 * fo;                     // body clears the mat
      t.squash.s = [1 + .06 * e, 1 - .07 * e, 1 + .04 * e];
      t.head.r[2] = .09 * e;                     // small head lag after impact
      t.gloveL.p = [lerp(R.gloveL.p[0], -.42, fo), lerp(R.gloveL.p[1], .48, fo), lerp(R.gloveL.p[2], .08, fo)];
      t.gloveR.p = [lerp(R.gloveR.p[0], .43, fo), lerp(R.gloveR.p[1], .48, fo), lerp(R.gloveR.p[2], .08, fo)];
      t.footL.p[1] = lerp(R.footL.p[1], .14, fo);
      t.footR.p[1] = lerp(R.footR.p[1], .12, fo);
      t.footL.r[2] = -.32 * fo; t.footR.r[2] = .28 * fo;
      f.eye = k > .3 ? 'spiral' : 'x';
      f.mouth = 'o';
    },
    celebrate(t, k, f) {                         // arms up, bouncing joy
      const c = Math.abs(Math.sin(k * TAU));
      t.root.p[1] += .14 * c;
      t.squash.s = [1 - .04 * c, 1 + .08 * c, 1 - .04 * c];
      t.gloveL.p = [-.30, 1.14 + .05 * Math.sin(k * 12.5), .12];
      t.gloveR.p = [.30, 1.14 + .05 * Math.sin(k * 12.5 + 1.6), .12];
      t.gloveL.r[2] = .3; t.gloveR.r[2] = -.3;
      t.head.r[0] = -.18; t.head.r[2] = Math.sin(k * TAU) * .12;
      t.browL.p[1] += .03; t.browR.p[1] += .03;
      f.eye = 'happy';
      f.mouth = 'grin';
    },
    wave(t, k, f) {
      t.gloveR.p = [.42, 1.12 + Math.sin(k * 12) * .045, .17];
      t.gloveR.r[2] = -.35 + Math.sin(k * 12) * .35;
      t.gloveL.p[1] += .04;
      t.head.r[2] = -.12;
      f.eye = 'happy'; f.mouth = 'grin';
    },
    point(t, k, f) {
      t.gloveR.p = [.04, .77, .7];
      t.gloveR.s = [.9, .9, 1.16];
      t.gloveL.p[1] += .08;
      t.torso.r[1] = -.18;
      t.head.r[2] = -.07;
      f.mouth = 'grin';
    },
    victory(t, k, f) {
      const bob = Math.abs(Math.sin(k * 8)) * .04;
      t.gloveL.p = [-.39, 1.13 + bob, .16];
      t.gloveR.p = [.39, 1.13 + bob, .16];
      t.gloveL.r[2] = .18; t.gloveR.r[2] = -.18;
      t.head.r[2] = Math.sin(k * 5) * .08;
      f.eye = 'happy'; f.mouth = 'grin';
    },
  };

  // idle/celebrate are cyclic — they take raw (unclamped) t01 so a seconds-
  // accumulating actionT keeps them looping instead of freezing at k=1.
  // 'down' is a held state: if the caller pins t01 at 1 we still play the
  // plush-toy fall once via an internal ramp; partial t01 is respected
  // verbatim so the fall can also be scrubbed.
  const CYCLIC = new Set(['idle', 'celebrate', 'wave', 'victory']);
  let downT = 0, effK = 0;
  function pose(name, t01 = 0) {
    if (!POSES[name]) {
      if (!warned.has(name)) {
        warned.add(name);
        if (typeof console !== 'undefined') console.warn('protoBoxer: unknown pose', name, '— using idle');
      }
      name = 'idle';
    }
    cur = name; curK = clamp(t01 || 0, 0, 1);
    if (cur !== 'down') downT = 0;
    resetTargets();
    flags.eye = 'open'; flags.mouth = 'flat';
    const k = CYCLIC.has(cur) ? Math.max(0, t01 || 0)
      : cur === 'down' ? (curK >= 1 ? downT : Math.max(curK, downT))
      : curK;
    effK = k;
    POSES[cur](T, k, flags, R, C);
    if (flags.eye !== eyeMode) { eyeMode = flags.eye; setEyes(eyeMode); }
    if (flags.mouth !== mouthMode) { mouthMode = flags.mouth; setMouth(mouthMode); }
  }

  function applyNow() {
    for (const n in T) {
      const nd = parts[n], tg = T[n];
      if (!nd) continue;
      nd.position.set(tg.p[0], tg.p[1], tg.p[2]);
      nd.rotation.set(tg.r[0], tg.r[1], tg.r[2]);
      nd.scale.set(tg.s[0], tg.s[1], tg.s[2]);
    }
  }
  const snap = (name, t01) => {
    if (name === 'down' && (t01 === undefined || t01 >= 1)) downT = 1; // thumbnail = fallen
    pose(name, t01); applyNow();
  };

  // aim a rubber limb pivot (+Z local) from its own position at an effector
  function solveLimb(piv, eff) {
    const dx = eff.position.x - piv.position.x;
    const dy = eff.position.y - piv.position.y;
    const dz = eff.position.z - piv.position.z;
    const h = Math.hypot(dx, dz) || 1e-5;
    const d = Math.hypot(dx, dy, dz) || 1e-5;
    piv.rotation.x = -Math.atan2(dy, h);
    piv.rotation.y = Math.atan2(dx, dz);
    const s = clamp(d / piv.userData.len, .55, 3.2), sh = 1 / Math.sqrt(s);
    const b = piv.userData.bone;
    b.scale.set(sh, s, sh);
    b.position.z = piv.userData.len * s * .5;
  }

  function trackHands(handsState) {
    for (const h of handsState?.hands || []) {
      if (!h?.palm || (h.side !== 'left' && h.side !== 'right')) continue;
      const glove = parts[h.side === 'left' ? 'gloveL' : 'gloveR'];
      const arm = parts[h.side === 'left' ? 'armL' : 'armR'];
      const span = h.lm?.[0] && h.lm?.[9]
        ? Math.hypot(h.lm[0].x - h.lm[9].x, h.lm[0].y - h.lm[9].y) : .1;
      // Keep each hand beside the face during the close camera shot, while
      // still following the player's horizontal and vertical motion.
      const rawX = (h.palm.x - .5) * 2 + (h.side === 'left' ? -.2 : .2);
      const x = h.side === 'left' ? clamp(rawX, -.9, -.55) : clamp(rawX, .55, .9);
      const y = clamp(.76 + (.5 - h.palm.y) * 1.55, .28, 1.3);
      const z = clamp(.25 + (span - .1) * 1.6, .12, .58);
      glove.position.x = lerp(glove.position.x, x, .62);
      glove.position.y = lerp(glove.position.y, y, .62);
      glove.position.z = lerp(glove.position.z, z, .62);
      solveLimb(arm, glove);
    }
  }

  function tick(dt, state, moveSpeed = 0) {
    time += dt;
    if (cur === 'down' && downT < 1) downT = Math.min(1, downT + dt * 2.2);
    // exponential blend toward targets — gloves snappier than the body
    const aG = 1 - Math.exp(-dt * 22), aB = 1 - Math.exp(-dt * 12);
    const stride = cur === 'down' ? 0 : clamp(moveSpeed / 1.8, 0, 1);
    const gait = Math.sin(time * 12);
    for (const n in T) {
      const nd = parts[n], tg = T[n];
      if (!nd) continue;
      const a = n === 'gloveL' || n === 'gloveR' ? aG : aB;
      const foot = n === 'footL' ? 1 : n === 'footR' ? -1 : 0;
      const lift = foot ? Math.max(0, gait * foot) * .055 * stride : 0;
      const stepZ = foot * gait * .085 * stride;
      const rootBounce = n === 'root' ? Math.abs(gait) * .012 * stride : 0;
      nd.position.set(
        lerp(nd.position.x, tg.p[0], a), lerp(nd.position.y, tg.p[1] + lift + rootBounce, a),
        lerp(nd.position.z, tg.p[2] + stepZ, a));
      nd.rotation.set(
        lerp(nd.rotation.x, tg.r[0], a), lerp(nd.rotation.y, tg.r[1], a), lerp(nd.rotation.z, tg.r[2], a));
      nd.scale.set(
        lerp(nd.scale.x, tg.s[0], a), lerp(nd.scale.y, tg.s[1], a), lerp(nd.scale.z, tg.s[2], a));
    }
    // rubber limbs chase gloves + feet every frame
    solveLimb(parts.armL, parts.gloveL); solveLimb(parts.armR, parts.gloveR);
    if (parts.legL) solveLimb(parts.legL, parts.footL);
    if (parts.legR) solveLimb(parts.legR, parts.footR);

    // continuous life: breath, blink, pupil wander, tuft wiggle (additive,
    // applied after the blend so poses are never fought, just breathed on)
    const calm = cur === 'down' ? .35 : 1;
    const br = Math.sin(time * 2.4);
    parts.torso.scale.y += br * .012 * calm;
    parts.squash.scale.x += br * .004 * calm;
    parts.head.position.y += Math.sin(time * 2.4 + .6) * .008 * calm;
    parts.gloveL.position.y += Math.sin(time * 3.1) * .006 * calm;
    parts.gloveR.position.y += Math.sin(time * 3.1 + .9) * .006 * calm;
    const cyc = time % 3.7;
    const bl = eyeMode === 'open' && cyc < .14 ? 1 - .92 * Math.sin(Math.PI * cyc / .14) : 1;
    for (const o of openEyes) o.scale.y = bl;
    if (eyeMode === 'open')
      for (let i = 0; i < pupils.length; i++) {
        pupils[i].position.x = Math.sin(time * .8 + i * 1.9) * .012;
        pupils[i].position.y = -.004 + Math.cos(time * .6 + i) * .008;
      }
    if (parts.tuft) parts.tuft.rotation.z = Math.sin(time * 3.7) * .12 * (cur === 'celebrate' ? 2.5 : 1);

    if (state && typeof state === 'object') { state.pose = cur; state.k = effK; state.time = time; }
  }

  function dispose() {
    for (const g of geos) g.dispose && g.dispose();
    for (const m of mats) m.dispose && m.dispose();
    geos.clear(); mats.clear();
  }

  pose('idle', 0); applyNow();                    // start standing, guard up
  return { group, parts, pose, snap, tick, trackHands, dispose, variant, height: 1.3 };
}
