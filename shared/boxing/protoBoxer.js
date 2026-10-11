/* shared/boxing/protoBoxer.js — the procedural cute NPC boxer.

   Animal Crossing meets Little Mac: a ~1.3-unit chibi fighter built ONLY
   from Three.js primitives + flat/toon materials, with ink outlines via
   the inverted-hull trick (a slightly larger back-face shell per part).
   No skeleton, no assets, no DOM, no top-level 'three' import — pass the
   THREE namespace in, so this file imports safely under plain node.

     import * as THREE from 'three';
     const pip = buildBoxer(THREE, { variant: 'bubble' });
     scene.add(pip.group);                      // feet at y=0, faces +Z
     // per frame:  pip.pose(action, actionT01, strike?);  pip.tick(dt, state);
     // poses: idle windup jab cross hook upper block hurt down celebrate
     //        stunned whiff   (+ mirrored *L variants)
     // strike = {reach, y}: punch poses aim the glove at this body-space
     //          z / height (the camera lens) instead of the default extension
     // pip.setDamage(0..1): black eye → bump → bandage → swollen shut

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
/* koAvg = unlock gate: your AVERAGE knockout round must be this early or
   earlier (needs ≥1 KO on record). No koAvg → always open. stats are 1–5
   pips shown on the fighter card; special = the signature move the rival
   busts out mid-fight (implemented in fight.js). */
export const VARIANT_INFO = {
  bubble: { label: 'BUBBLE', desc: 'sprout crown · springy stance',
    stats: { atk: 3, def: 3, spd: 4 },
    special: { name: 'TRIPLE TAP', desc: '3 hits, one stamina' } },
  blocky: { label: 'BLOCKY', desc: 'flat top · compact guard', koAvg: 3,
    unlock: 'KO a rival',
    stats: { atk: 5, def: 4, spd: 2 },
    special: { name: 'SLEDGE', desc: 'guard-cracking haymaker' } },
  bean:   { label: 'BEAN',   desc: 'the champ · iron hide', koAvg: 2,
    unlock: 'avg KO by round 2',
    stats: { atk: 5, def: 4, spd: 2 },
    special: { name: 'BEAN BARRAGE', desc: "the champ's heavy 1-2" } },
};

// each variant keeps its own flavor inside the house palette
const VPAL = {
  bubble: { skin: 0xffc99a, skinShade: 0xdfaa82, skinLight: 0xffd0a5,
    glove: HOUSE.coral, gloveDeep: 0xc63e38, gloveShine: 0xff947b,
    shorts: HOUSE.sun, trim: HOUSE.paper, cheek: 0xff9b7a, leaf: HOUSE.leaf,
    guardTeeth: HOUSE.sky, band: 0xc63e38, gold: 0xf2b630 },
  blocky: { skin: 0xe9b78f, skinShade: 0xc99170, skinLight: 0xefbf99,
    glove: HOUSE.sky, gloveDeep: 0x337eae, gloveShine: 0x9ad1fa,
    shorts: HOUSE.leaf, trim: HOUSE.paper, cheek: 0xff9b7a, leaf: HOUSE.ink,
    guardTeeth: HOUSE.coral, band: 0x337eae, gold: 0xf2b630 },
  bean: { skin: 0xeab27f, skinShade: 0xc78f5f, skinLight: 0xf4c491,
    glove: HOUSE.berry, gloveDeep: 0x843aa4, gloveShine: 0xd9a5ed,
    shorts: 0x33415e, trim: HOUSE.paper, cheek: 0xff9b7a, leaf: 0x3f9157,
    guardTeeth: HOUSE.sun, band: 0x843aa4, gold: 0xf2b630 },
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
    shx: .30, shy: .66, armR: .05, armLen: .18, gloveR: .2,
    guard: { l: [-.27, .70, .27], r: [.28, .68, .23] },
    hipX: .13, hipY: .30, legR: .05, legLen: .12, foot: [.14, .055, .045],
  },
  blocky: {
    headY: .99,
    face: { ex: .13, ey: .03, ez: .243, by: .135, my: -.125, bx: .195, byy: -.06 },
    shx: .33, shy: .66, armR: .06, armLen: .17, gloveR: .195,
    guard: { l: [-.30, .70, .26], r: [.31, .68, .22] },
    hipX: .15, hipY: .33, legR: .055, legLen: .11, foot: [.15, .05, .05],
  },
  bean: {   // THE CHAMP — biggest frame of the roster: tall, wide, heavy
    headY: 1.06,
    face: { ex: .105, ey: .02, ez: .235, by: .12, my: -.115, bx: .17, byy: -.06 },
    shx: .37, shy: .66, armR: .09, armLen: .18, gloveR: .225,
    guard: { l: [-.32, .68, .28], r: [.33, .66, .24] },
    hipX: .15, hipY: .30, legR: .055, legLen: .11, foot: [.15, .052, .05],
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
  const shineMat = basic(0xffffff);

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
    // only silhouette parts cast — an earring's shadow can't mark a soft
    // blob at 512², but every caster is a draw call in the shadow pass
    if (!geo.boundingSphere) geo.computeBoundingSphere?.();
    m.castShadow = (geo.boundingSphere?.radius ?? 1) > .055;
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
    piv.userData.rad = r;
    return mark(name, put(squash, piv));
  }

  // ---- face (built in head space; modes toggled via .visible) ----
  const eyes = [], pupils = [], openEyes = [], wounds = [];
  let mouth = null, dmg = 0;                     // dmg: hp fraction lost (setDamage)

  function buildEye(side, F) {
    const e = grp(side * F.ex, F.ey, F.ez);
    const open = grp();
    const white = new THREE.Mesh(SPH(.075, 14, 10), basic(P.paper));
    white.scale.set(1, 1.18, .5);
    const pupil = new THREE.Mesh(SPH(.04, 12, 9), inkFlat);
    pupil.scale.set(1, 1.12, .6);
    pupil.position.set(0, -.004, .052);
    // catchlights ride the pupil — the single biggest "alive" cue on a toon face
    const shine = new THREE.Mesh(SPH(.013, 8, 6), shineMat);
    shine.position.set(side * -.012 + .006, .016, .03);
    const shine2 = new THREE.Mesh(SPH(.006, 6, 5), shineMat);
    shine2.position.set(side * .012 - .004, -.013, .03);
    pupil.add(shine, shine2);
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
    // gritted mouthguard — bared, clenched, the "here it comes" face
    const grit = grp();
    const lip = new THREE.Mesh(BOX(.15, .062, .02), inkFlat);
    const guard = new THREE.Mesh(BOX(.128, .04, .014), toon(P.guardTeeth));
    guard.position.z = .011;
    const gap = new THREE.Mesh(BOX(.128, .006, .016), inkFlat);
    gap.position.z = .013;
    grit.add(lip, guard, gap);
    for (const x of [-.032, 0, .032]) {
      const tooth = new THREE.Mesh(BOX(.004, .04, .016), inkFlat);
      tooth.position.set(x, 0, .013);
      grit.add(tooth);
    }
    grit.userData.mode = 'grit'; grit.visible = false;
    m.add(smile, grin, o, flat, grit);
    m.userData.mode = 'smile';
    return m;
  }

  function setMouth(mode) {
    mouth.userData.mode = mode;
    for (const c of mouth.children) c.visible = c.userData.mode === mode;
  }

  function buildFace(headNode, F, player) {
    mark('eyeL', put(headNode, buildEye(-1, F)));
    mark('eyeR', put(headNode, buildEye(1, F)));
    for (const s of [-1, 1]) {
      /* playerLook: the entrance camera pushes in close — shorter brows set
         lower+back with yawed tips hug the skull curve instead of floating as
         slabs off the forehead */
      const b = new THREE.Mesh(BOX(player ? .098 : .13, .036, .03), inkFlat);
      b.position.set(s * (player ? F.ex - .01 : F.ex), player ? F.by - .008 : F.by,
        F.ez + (player ? -.012 : .015));
      if (player) b.rotation.y = s * .42;
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

    /* progressive damage — wounds that make every landed glove READ:
       stage 1 shiner around the left eye, 2 lump on the crown,
       3 cross bandage on the cheek, 4 right eye swells half shut */
    const shiner = new THREE.Mesh(TOR(.074, .026), toon(0x5a2f7d, { transparent: true, opacity: .85 }));
    shiner.scale.set(1, 1.12, .4);
    shiner.position.set(-F.ex, F.ey - .006, F.ez + .004);
    const lump = inked(SPH(.06, 12, 9), P.skinShade, { hull: .04 });
    lump.scale.set(1, .7, 1);
    lump.position.set(.09, .27, .09);
    const bandage = grp(F.bx + .01, F.byy + .02, F.ez + .016);
    for (const r of [.6, -.6]) {
      const strip = new THREE.Mesh(BOX(.09, .028, .008), toon(0xf4e1c1));
      strip.rotation.z = r;
      bandage.add(strip);
    }
    for (const nd of [shiner, lump, bandage]) { nd.visible = false; put(headNode, nd); }
    wounds.push(shiner, lump, bandage);
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
    // white star badge on the striking face — reads as a GLOVE at a glance
    // and gives the incoming fist a bright target to track
    const stripe = grp(-side * R * .05, -R * .2, R * .99);
    for (const r of [0, Math.PI / 2, Math.PI / 4, -Math.PI / 4]) {
      const ray = new THREE.Mesh(BOX(r % (Math.PI / 2) ? R * .2 : R * .3, R * .08, R * .04), toon(P.trim));
      ray.rotation.z = r; stripe.add(ray);
    }
    // criss-cross laces on the palm side of the cuff
    const laces = grp(0, -R * .62, -R * .72);
    for (const r of [.55, -.55]) for (const z of [-.06, .06]) {
      const l = new THREE.Mesh(BOX(R * .55, R * .07, R * .07), inkFlat);
      l.rotation.y = r; l.position.z = z * R * 2;
      laces.add(l);
    }
    g.add(main, thumb, pad, cuffBand, cuff, stripe, laces);
    return g;
  }

  function dressShorts(shorts, sideX, frontZ, waistY) {
    for (const s of [-1, 1]) {
      const stripe = new THREE.Mesh(BOX(.025, .10, .012), toon(P.trim));
      stripe.position.set(s * sideX, -.025, frontZ);
      shorts.add(stripe);
    }
    // title-belt buckle — a gold plate with a jewel; this is a CHAMP you're fighting
    const plate = inked(CYL(.085, .085, .02, 16), P.gold, { hull: .08 });
    plate.rotation.x = Math.PI / 2; plate.scale.set(1.25, 1, .9);
    plate.position.set(0, waistY, frontZ + .03);
    shorts.add(plate);
    const rim = new THREE.Mesh(TOR(.06, .009), toon(0xfff0b0));
    rim.position.set(0, waistY, frontZ + .043); rim.scale.set(1.25, .9, 1);
    shorts.add(rim);
    const jewel = new THREE.Mesh(SPH(.026, 10, 8), toon(P.glove));
    jewel.scale.set(1, 1, .5);
    jewel.position.set(0, waistY, frontZ + .045);
    shorts.add(jewel);
  }

  // rival headband — knotted at the back, two tails that whip with motion
  const tails = [];
  function headband(head, r, y, square = false) {
    const band = square ? inked(BOX(.565, .06, .5), P.band, { hull: .03 })
      : inked(TOR(r, .03), P.band, { hull: .03 });
    if (!square) band.rotation.x = Math.PI / 2;
    band.position.y = y;
    head.add(band);
    const knot = inked(SPH(.04, 10, 8), P.band, { hull: .03 });
    knot.position.set(0, y, -r); head.add(knot);
    for (const s of [-1, 1]) {
      const piv = grp(s * .02, y, -r - .02);
      const tail = inked(BOX(.05, .02, .17), P.band, { hull: .04 });
      tail.position.z = -.08;
      piv.add(tail); piv.rotation.set(-.5, s * .35, 0);
      piv.userData.s = s;
      head.add(piv); tails.push(piv);
    }
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
      buildFace(head, C.face, playerLook);
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
      buildFace(head, C.face, playerLook);
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
      // THE CHAMP — a bean that bulked up for the title: broad barrel torso,
      // boulder shoulders, carved pecs + abs, planted base, a permanent
      // scowl and the prize-fighter mustache. Still unmistakably a bean.
      for (const s of [-1, 1]) {
        const f = inked(SPH(.095, 12, 9), P.gloveDeep);
        f.scale.set(1.2, .6, 1.45);
        f.position.set(s * C.foot[0], C.foot[1], C.foot[2]);
        mark(s < 0 ? 'footL' : 'footR', put(squash, f));
      }
      limb('legL', -C.hipX, C.hipY, C.legR, C.legLen, P.skin);
      limb('legR', C.hipX, C.hipY, C.legR, C.legLen, P.skin);

      const shorts = grp(0, .31, 0);
      const sh = inked(SPH(.315, 18, 12), P.shorts);
      sh.scale.set(1.05, .62, .98);
      const waist = inked(TOR(.255, .034), P.trim);
      waist.rotation.x = Math.PI / 2; waist.position.y = .115;
      shorts.add(sh, waist);
      dressShorts(shorts, .225, .27, .115);        // the champ's belt plate
      mark('shorts', put(squash, shorts));

      const torso = grp(0, .60, 0);
      const body = inked(CAP(.27, .30), P.skin);
      body.scale.set(1.14, 1, .9);                 // wide barrel chest
      torso.add(body);
      for (const s of [-1, 1]) {                   // boulder delts + pecs
        const delt = inked(SPH(.095, 12, 9), P.skin);
        delt.position.set(s * .32, .16, .02);
        torso.add(delt);
        const pec = new THREE.Mesh(SPH(.105, 14, 10), toon(P.skinLight));
        pec.scale.set(.95, .55, .32);
        pec.position.set(s * .11, .15, .235);
        torso.add(pec);
      }
      for (const [ax, ay] of [[-.05, 0], [.05, 0], [-.05, -.1], [.05, -.1]]) {
        const ab = new THREE.Mesh(SPH(.028, 8, 6), toon(P.skinShade));
        ab.scale.set(1, .5, .28);
        ab.position.set(ax, ay, .26);
        torso.add(ab);
      }
      mark('torso', put(squash, torso));

      const head = grp(0, C.headY, 0);             // head cap melts into bean
      const cap = inked(SPH(.27, 22, 16), P.skin);
      cap.scale.set(1.02, .95, 1);
      head.add(cap);
      for (const s of [-1, 1]) {
        const ear = inked(SPH(.046, 12, 9), P.skinShade, { hull: .035 });
        ear.position.set(s * .27, -.045, .015);
        head.add(ear);
      }
      buildFace(head, C.face, playerLook);
      // prize-fighter mustache under the nose — dark, heavy, walrus-set
      const stache = grp(0, C.face.my + .035, C.face.ez + .05);
      for (const s of [-1, 1]) {
        const w = new THREE.Mesh(BOX(.088, .03, .02), inkFlat);
        w.rotation.z = s * .3; w.position.x = s * .037;
        stache.add(w);
      }
      head.add(stache);
      // the champ glowers at rest — write the scowl INTO the rest targets
      // so the pose blender keeps it between expressions
      parts.browL.rotation.z = rest.browL.r[2] = -.16;
      parts.browR.rotation.z = rest.browR.r[2] = .16;
      parts.browL.scale.y = rest.browL.s[1] = 1.6;
      parts.browR.scale.y = rest.browR.s[1] = 1.6;
      const tuft = grp(0, .26, 0);                 // crown sprout — still a bean
      const stem = inked(CYL(.016, .022, .08), P.leaf);
      stem.rotation.z = .2; stem.position.y = .02;
      for (const s of [-1, 0, 1]) {
        const lf = inked(SPH(.042, 10, 8), P.leaf);
        lf.scale.set(1.5, .4, .8);
        lf.position.set(s * .05, .065 + (s === 0 ? .022 : 0), 0);
        lf.rotation.z = s ? s * -.45 : 0;
        tuft.add(lf);
      }
      tuft.add(stem);
      mark('tuft', put(head, tuft));
      mark('head', put(squash, head));
    },
  };

  BUILDERS[variant]();
  if (!playerLook) {                     // square head → square band; tails fly on all
    // sits ABOVE the brows — the brows are PIP's tell and must stay readable
    const HB = { bubble: [.226, .205], blocky: [.25, .205], bean: [.195, .185] }[variant];
    headband(parts.head, HB[0], HB[1], variant === 'blocky');
  }
  // dizzy stars — orbit the crown while reeling / out cold (animated in tick,
  // deliberately NOT mark()ed so the pose blender never fights the orbit)
  const stars = put(parts.head, grp(0, .36, 0));
  for (let i = 0; i < 3; i++) {
    const st = grp(Math.cos(i * TAU / 3) * .26, 0, Math.sin(i * TAU / 3) * .26);
    for (const r of [0, Math.PI / 2, Math.PI / 4, -Math.PI / 4]) {
      const ray = inked(BOX(r % (Math.PI / 2) ? .055 : .09, .026, .026), HOUSE.sun, { hull: .12 });
      ray.rotation.z = r; st.add(ray);
    }
    stars.add(st);
  }
  stars.visible = false;
  // sweat beads — drip off the temples when gassed
  const sweat = [];
  for (const s of [-1, 1]) {
    const d = new THREE.Mesh(SPH(.024, 10, 8), toon(0xbfe6ff, { transparent: true, opacity: .9 }));
    d.scale.set(.8, 1.3, .8);
    d.userData.home = [s * .27, .08, .1];
    d.visible = false;
    put(parts.head, d); sweat.push(d);
  }
  if (playerLook) {
    // A ring-ready headband makes the entrance boxer readable beside the
    // opponent, even though both share the same compact procedural rig.
    const band = inked(TOR(variant === 'blocky' ? .285 : .275, .027), P.trim, { hull: .025 });
    band.rotation.x = Math.PI / 2;
    band.position.y = variant === 'blocky' ? .13 : .105;
    parts.head.add(band);
    const knot = inked(SPH(.043, 10, 8), P.gloveDeep, { hull: .025 });
    knot.scale.set(1.4, .6, .6);
    // knot ties at the BACK like a real band — front-right read as a wound
    knot.position.set(0, .11, -.29);
    parts.head.add(knot);
  }
  // your boxer gets meatier stub arms — they're the same rubber-hose bones,
  // just built thicker so a stretched reach still reads as an arm, not a wire
  limb('armL', -C.shx, C.shy, playerLook ? C.armR * 1.55 : C.armR, C.armLen, P.skin);
  limb('armR', C.shx, C.shy, playerLook ? C.armR * 1.55 : C.armR, C.armLen, P.skin);
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
  // live strike aim from pose(…, {kind, reach, y}) — null = classic extension
  let SK = null, SZ = null, SY = null;
  // t.X.p/.s are persistent arrays — write in place, never t.X.p = […]
  const P3 = (v, x, y, z) => { v[0] = x; v[1] = y; v[2] = z; };
  const other = g => g === 'gloveL' ? 'gloveR' : 'gloveL';
  const angryBrows = (t, a) => { t.browL.r[2] = -a; t.browR.r[2] = a; };

  // g = punching glove part, sx = its screen side (+1 = gloveR side)
  function windupSide(t, k, f, g, sx) {
    const e = ss(0, 1, k), r = R[g].p;
    if (SK === 'hook') {                         // cocked WIDE and high — it comes from the side
      P3(t[g].p, r[0] + .24 * sx * e, r[1] + .1 * e, r[2] - .14 * e);
      t[g].r[1] = sx * .9 * e;
      t.torso.r[1] = .6 * sx * e; t.head.r[1] = -.18 * sx * e;
    } else if (SK === 'upper') {                 // sinks low — it comes from below
      P3(t[g].p, r[0] + .06 * sx * e, r[1] - .28 * e, r[2] - .04 * e);
      t[g].r[0] = -.6 * e;
      t.torso.r[1] = .3 * sx * e; t.torso.r[0] = .22 * e;
      t.root.p[1] -= .07 * e; t.root.r[2] = .12 * sx * e;
    } else {                                     // jab / straight — pulled back on the line
      P3(t[g].p, r[0] + .1 * sx * e, r[1] + .05 * e, r[2] - .26 * e);
      t[g].r[0] = .5 * e;
      t.torso.r[1] = .42 * sx * e; t.head.r[1] = -.14 * sx * e;
    }
    P3(t[g].s, 1 + .2 * e, 1 + .2 * e, 1 + .2 * e);   // cocked glove swells
    t[other(g)].p[2] -= .07 * e;
    P3(t.squash.s, 1 + .05 * e, 1 - .07 * e, 1 + .05 * e);
    t.root.p[1] -= .02 * e;
    angryBrows(t, .5 * e);                       // angry V
    t.browL.p[1] -= .018 * e; t.browR.p[1] -= .018 * e;
    f.mouth = 'grit';
  }
  function straight(t, k, f, g, sx, zEnd, smear, twist) {
    const e = attack(k), r = R[g].p;
    P3(t[g].p, lerp(r[0], .05 * sx, e), lerp(r[1], SY ?? .74, e), lerp(r[2], SZ ?? zEnd, e));
    P3(t[g].s, 1 - .12 * e, 1 - .12 * e, 1 + smear * e);   // motion smear
    t[g].r[0] = -.32 * e;
    t.torso.r[1] = -twist * sx * e; t.head.r[1] = (twist > .5 ? .12 : .08) * sx * e;
    if (twist > .5) t.root.p[2] += .05 * e;
    P3(t.squash.s, 1 - .02 * e, 1 + .025 * e, 1 + .055 * e);
    t[other(g)].p[2] -= (twist > .5 ? .1 : .07) * e;
    angryBrows(t, .33 * e);
    f.mouth = 'grit';
  }
  function hookSide(t, k, f, g, sx) {
    const e = attack(k), r = R[g].p, arc = Math.sin(e * Math.PI);
    P3(t[g].p,
      lerp(r[0], -.05 * sx, e) + arc * (SZ ? .34 : .2) * sx,   // swing wide then across
      lerp(r[1], SY ?? .76, e),
      lerp(r[2], SZ ?? .36, e) + arc * .07);
    t[g].r[1] = -1.25 * sx * e;
    P3(t[g].s, 1 + .22 * e, 1 - .08 * e, 1 - .08 * e);
    t.torso.r[1] = -.62 * sx * e; t.head.r[1] = .16 * sx * e;
    P3(t.squash.s, 1 + .04 * e, 1 - .02 * e, 1 - .02 * e);
    angryBrows(t, .38 * e);
    f.mouth = 'grit';
  }
  function upperSide(t, k, f, g, sx) {
    const e = attack(k), r = R[g].p;
    // scoop: starts at the hip and drives UP the centre line into the chin
    P3(t[g].p, lerp(r[0], .04 * sx, e), lerp(r[1] - .26, SY ?? .95, e), lerp(r[2], SZ ?? .6, e));
    t[g].r[0] = lerp(-.6, -1.1, e);
    P3(t[g].s, 1 - .1 * e, 1 + .35 * e, 1 - .1 * e);       // vertical smear
    t.torso.r[1] = -.4 * sx * e; t.torso.r[0] = lerp(.22, -.12, e);
    t.root.p[1] += .05 * e; t.head.r[0] = -.12 * e;
    P3(t.squash.s, 1 - .04 * e, 1 + .07 * e, 1 - .03 * e); // rises onto the toes
    t[other(g)].p[2] -= .08 * e;
    angryBrows(t, .42 * e);
    f.mouth = 'grit';
  }
  const POSES = {
    idle(t, k, f) {
      const w = Math.sin(k * TAU);
      const weave = variant === 'bean' ? .026 : variant === 'blocky' ? .018 : .04;
      t.root.r[2] = w * weave;
      t.head.r[2] = Math.sin(k * TAU + .7) * (variant === 'bean' ? .032 : .04);
      t.root.p[1] += variant === 'bubble' ? Math.abs(w) * .025 : 0;
      t.gloveL.p[1] += w * (variant === 'blocky' ? .012 : .03);
      t.gloveR.p[1] += Math.sin(k * TAU + 1.3) * (variant === 'blocky' ? .012 : .03);
      if (variant === 'blocky') {
        t.gloveL.p[0] += .035; t.gloveR.p[0] -= .035; // compact guard
      }
      t.torso.r[0] = .04;
      f.mouth = 'smile';
    },
    /* windups are KIND-SPECIFIC tells (strike.kind): jab pulls straight back,
       hook cocks the glove wide and high, uppercut sinks the shoulder and
       drops the glove to the hip. Learn the shapes, not just the '!'. */
    windup(t, k, f) { windupSide(t, k, f, 'gloveR', 1); },   // telegraphed right-hand load
    windupL(t, k, f) { windupSide(t, k, f, 'gloveL', -1); }, // gloveL-side mirror
    jab(t, k, f) { straight(t, k, f, 'gloveL', -1, .68, .4, .42); },       // left snap out +Z
    jabL(t, k, f) { straight(t, k, f, 'gloveR', 1, .68, .4, .42); },       // gloveR mirror of jab
    cross(t, k, f) { straight(t, k, f, 'gloveR', 1, .72, .45, .52); },     // right power shot
    crossL(t, k, f) { straight(t, k, f, 'gloveL', -1, .72, .45, .52); },   // gloveL mirror of cross
    hook(t, k, f) { hookSide(t, k, f, 'gloveL', -1); },     // left arm whips in an arc
    hookL(t, k, f) { hookSide(t, k, f, 'gloveR', 1); },     // gloveR mirror of hook
    upper(t, k, f) { upperSide(t, k, f, 'gloveR', 1); },    // gloveR scoops up from the hip
    upperL(t, k, f) { upperSide(t, k, f, 'gloveL', -1); },
    stunned(t, k, f) {                           // reeling: arms dropped, head lolling, wide open
      const w = Math.sin(k * 5.2), w2 = Math.sin(k * 3.1 + 1);
      t.root.r[2] = w * .16; t.root.r[0] = -.08 + w2 * .05;
      t.root.p[0] += w * .05;
      t.head.r[2] = -w * .22; t.head.r[0] = -.18 + w2 * .08;
      P3(t.gloveL.p, R.gloveL.p[0] - .08, R.gloveL.p[1] - .3 + w * .03, R.gloveL.p[2] - .06);
      P3(t.gloveR.p, R.gloveR.p[0] + .08, R.gloveR.p[1] - .3 - w * .03, R.gloveR.p[2] - .06);
      P3(t.squash.s, 1 + .04, 1 - .05, 1 + .04);
      t.browL.r[2] = .45; t.browR.r[2] = -.45;
      t.browL.p[1] += .025; t.browR.p[1] += .025;
      f.eye = 'spiral'; f.mouth = 'o';
    },
    whiff(t, k, f) {                             // overextended stumble after a miss
      const e = attack(Math.min(1, k * 1.3));
      t.root.r[0] = .2 * e; t.root.p[2] += .1 * e;
      t.root.r[2] = .12 * e * Math.sin(k * 7);
      t.torso.r[1] = .3 * e;
      P3(t.gloveL.p, R.gloveL.p[0] + .1 * e, R.gloveL.p[1] - .1 * e, R.gloveL.p[2] + .25 * e);
      P3(t.gloveR.p, R.gloveR.p[0] + .12 * e, R.gloveR.p[1] - .18 * e, R.gloveR.p[2] - .05 * e);
      t.head.r[0] = .15 * e;
      t.browL.r[2] = .35 * e; t.browR.r[2] = -.35 * e;
      t.browL.p[1] += .03 * e; t.browR.p[1] += .03 * e;
      f.mouth = 'o';
    },
    block(t, k, f) {                             // mitts up over the face
      const b = ss(0, .4, k);
      P3(t.gloveL.p, lerp(R.gloveL.p[0], -.13, b), lerp(R.gloveL.p[1], .88, b), lerp(R.gloveL.p[2], .34, b));
      P3(t.gloveR.p, lerp(R.gloveR.p[0], .13, b), lerp(R.gloveR.p[1], .88, b), lerp(R.gloveR.p[2], .34, b));
      t.gloveL.r[1] = -.3 * b; t.gloveR.r[1] = .3 * b;
      t.head.p[1] -= .04 * b; t.head.r[0] = .18 * b;
      t.torso.r[0] = .14 * b;
      P3(t.squash.s, 1 + .05 * b, 1 - .06 * b, 1 + .05 * b);
      t.root.p[1] -= .03 * b;
      t.browL.r[2] = -.15 * b; t.browR.r[2] = .15 * b;
      f.mouth = 'flat';
    },
    hurt(t, k, f) {                              // recoiled, wobbly, X eyes
      const e = attack(k);
      t.head.r[0] = -.55 * e; t.head.p[1] += .03 * e;
      t.root.r[0] = -.14 * e; t.root.p[2] -= .07 * e;
      t.root.r[2] = Math.sin(k * 9.4) * .08 * (1 - k);
      P3(t.gloveL.p, R.gloveL.p[0] - .16 * e, R.gloveL.p[1] - .15 * e, R.gloveL.p[2] - .14 * e);
      P3(t.gloveR.p, R.gloveR.p[0] + .18 * e, R.gloveR.p[1] - .12 * e, R.gloveR.p[2] - .16 * e);
      P3(t.squash.s, 1 + .12 * e, 1 - .14 * e, 1 + .08 * e);
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
      P3(t.squash.s, 1 + .06 * e, 1 - .07 * e, 1 + .04 * e);
      t.head.r[2] = .09 * e;                     // small head lag after impact
      P3(t.gloveL.p, lerp(R.gloveL.p[0], -.42, fo), lerp(R.gloveL.p[1], .48, fo), lerp(R.gloveL.p[2], .08, fo));
      P3(t.gloveR.p, lerp(R.gloveR.p[0], .43, fo), lerp(R.gloveR.p[1], .48, fo), lerp(R.gloveR.p[2], .08, fo));
      t.footL.p[1] = lerp(R.footL.p[1], .14, fo);
      t.footR.p[1] = lerp(R.footR.p[1], .12, fo);
      t.footL.r[2] = -.32 * fo; t.footR.r[2] = .28 * fo;
      f.eye = k > .3 ? 'spiral' : 'x';
      f.mouth = 'o';
    },
    celebrate(t, k, f) {                         // arms up, bouncing joy
      const c = Math.abs(Math.sin(k * TAU));
      t.root.p[1] += .14 * c;
      P3(t.squash.s, 1 - .04 * c, 1 + .08 * c, 1 - .04 * c);
      P3(t.gloveL.p, -.30, 1.14 + .05 * Math.sin(k * 12.5), .12);
      P3(t.gloveR.p, .30, 1.14 + .05 * Math.sin(k * 12.5 + 1.6), .12);
      t.gloveL.r[2] = .3; t.gloveR.r[2] = -.3;
      t.head.r[0] = -.18; t.head.r[2] = Math.sin(k * TAU) * .12;
      t.browL.p[1] += .03; t.browR.p[1] += .03;
      f.eye = 'happy';
      f.mouth = 'grin';
    },
    wave(t, k, f) {
      P3(t.gloveR.p, .42, 1.12 + Math.sin(k * 12) * .045, .17);
      t.gloveR.r[2] = -.35 + Math.sin(k * 12) * .35;
      t.gloveL.p[1] += .04;
      t.head.r[2] = -.12;
      f.eye = 'happy'; f.mouth = 'grin';
    },
    point(t, k, f) {
      P3(t.gloveR.p, .04, .77, .7);
      P3(t.gloveR.s, .9, .9, 1.16);
      t.gloveL.p[1] += .08;
      t.torso.r[1] = -.18;
      t.head.r[2] = -.07;
      f.mouth = 'grin';
    },
    victory(t, k, f) {
      const bob = Math.abs(Math.sin(k * 8)) * .04;
      P3(t.gloveL.p, -.39, 1.13 + bob, .16);
      P3(t.gloveR.p, .39, 1.13 + bob, .16);
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
  const CYCLIC = new Set(['idle', 'celebrate', 'wave', 'victory', 'stunned']);
  let downT = 0, effK = 0;
  function pose(name, t01 = 0, strike = null) {
    SK = strike?.kind ?? null;
    SZ = Number.isFinite(strike?.reach) ? strike.reach : null;
    SY = SZ !== null && Number.isFinite(strike?.y) ? strike.y : null;
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
    /* playerLook: the user's avatar never punches — cap glove reach at a
       distance the rubber arm can span without thinning into a wire (point
       aimed .75+ from the shoulder → a 3× noodle across the chest). The arm
       tip lands exactly on the anchor, so the clamped target keeps the drawn
       mitt attached. */
    if (playerLook) for (const side of [-1, 1]) {
      const p = T[side < 0 ? 'gloveL' : 'gloveR'].p;
      const dx = p[0] - side * C.shx, dy = p[1] - C.shy, dz = p[2];
      const d = Math.hypot(dx, dy, dz);
      if (d > .5) { const k2 = .5 / d;
        p[0] = side * C.shx + dx * k2; p[1] = C.shy + dy * k2; p[2] = dz * k2; }
    }
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
    /* rubber hose: a lens-bound strike stretches the arm way out, but the
       bone never thins past half width so it still reads as an arm.
       playerLook: solve against len+rad so the far cap lands exactly ON the
       glove anchor — the drawn mitt's cuff then sits on the arm tip instead
       of the tip poking ~40% past it out the side of the flat mitt */
    const s = clamp(d / (piv.userData.len + (playerLook ? piv.userData.rad : 0)),
      .55, 7), sh = Math.max(.5, 1 / Math.sqrt(s));
    const b = piv.userData.bone;
    b.scale.set(sh, s, sh);
    b.position.z = piv.userData.len * s * .5;
  }

  /* hand→glove spaces. 'close': the tight walk-on shot parks the mitts wide
     beside the cheeks. 'wide': the pulled-back outro shot keeps them inside
     the rubber arm's honest reach — past ~3× stretch the bone reads as a
     wire, not a limb, so the anchor is also reeled back toward the shoulder. */
  const HAND_SPACES = {
    close: { x: [.55, .9], bias: .2, y: [.28, 1.3], ym: 1.55, yb: .76,
      z: [.08, .32], zm: 1.2, zb: .16, reach: Infinity },
    /* 'wide' keeps z shallow: a glove far +Z from its shoulder makes the arm
       point straight at the lens — it foreshortens to a dot on screen and the
       mitt reads as floating off the body. Near the body plane the arm always
       visibly bridges shoulder → wrist. */
    wide:  { x: [.2, .55], bias: .12, y: [.5, 1.18], ym: 1.3, yb: .78,
      z: [.04, .12], zm: 1.2, zb: .08, reach: .46 },
  };

  function trackHands(handsState, space = 'close') {
    const S = HAND_SPACES[space] || HAND_SPACES.close;
    for (const h of handsState?.hands || []) {
      if (!h?.palm || (h.side !== 'left' && h.side !== 'right')) continue;
      const left = h.side === 'left';
      const gname = left ? 'gloveL' : 'gloveR';
      const glove = parts[gname];
      const arm = parts[left ? 'armL' : 'armR'];
      const span = h.lm?.[0] && h.lm?.[9]
        ? Math.hypot(h.lm[0].x - h.lm[9].x, h.lm[0].y - h.lm[9].y) : .1;
      // Keep each hand beside the face during the close camera shot, while
      // still following the player's horizontal and vertical motion.
      const rawX = (h.palm.x - .5) * 2 + (left ? -1 : 1) * S.bias;
      let x = left ? clamp(rawX, -S.x[1], -S.x[0]) : clamp(rawX, S.x[0], S.x[1]);
      let y = clamp(S.yb + (.5 - h.palm.y) * S.ym, S.y[0], S.y[1]);
      let z = clamp(S.zb + (span - .1) * S.zm, S.z[0], S.z[1]);
      if (S.reach < Infinity) {
        const dx = x - arm.position.x, dy = y - arm.position.y, dz = z - arm.position.z;
        const d = Math.hypot(dx, dy, dz);
        if (d > S.reach) { const k = S.reach / d; x = arm.position.x + dx * k; y = arm.position.y + dy * k; z = arm.position.z + dz * k; }
      }
      // pin the blend target too: called before tick() the pose engine stops
      // fighting the tracked hand, and a dropped hand falls back to the pose
      // on the next pose() call — no stale frozen glove
      const tg = T[gname];
      if (tg) { tg.p[0] = x; tg.p[1] = y; tg.p[2] = z; }
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
    for (let i = 0; i < openEyes.length; i++)
      openEyes[i].scale.y = bl * (i === 1 && dmg >= .78 ? .5 : 1);   // right eye swells shut
    // dizzy stars orbit while reeling / out cold
    const dizzy = cur === 'stunned' || (cur === 'down' && effK > .4);
    stars.visible = dizzy;
    if (dizzy) {
      stars.rotation.y = time * 4.2;
      for (let i = 0; i < stars.children.length; i++) {
        const st = stars.children[i];
        st.position.y = Math.sin(time * 6 + i * 2.1) * .03;
        st.rotation.y = -time * 4.2;              // keep each sparkle facing out
        st.rotation.z = time * 3 + i;
      }
    }
    // gassed → sweat beads slide off the temples on a loop
    const gas = !!state?.gassed && cur !== 'down';
    for (let i = 0; i < sweat.length; i++) {
      const d = sweat[i], h = d.userData.home;
      d.visible = gas;
      if (!gas) continue;
      const u = (time * .9 + i * .5) % 1;
      d.position.set(h[0] * (1 + u * .15), h[1] - u * .22, h[2]);
      d.material.opacity = .9 * (1 - u);
    }
    // headband tails trail the head motion with a lazy flutter
    for (const tl of tails) {
      const s = tl.userData.s;
      tl.rotation.x = -.5 + Math.sin(time * 6.5 + s) * .12 - (cur === 'stunned' ? .3 : 0);
      tl.rotation.y = s * (.35 + Math.sin(time * 4.3 + s * 2) * .1) - parts.head.rotation.y * .8;
    }
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

  // wounds accumulate (monotone) — 0..1 fraction of hp lost
  function setDamage(frac) {
    dmg = Math.max(dmg, clamp(+frac || 0, 0, 1));
    const [shiner, lump, bandage] = wounds;
    if (shiner) shiner.visible = dmg >= .3;
    if (lump) lump.visible = dmg >= .5;
    if (bandage) bandage.visible = dmg >= .65;
  }

  pose('idle', 0); applyNow();                    // start standing, guard up
  return { group, parts, pose, snap, tick, trackHands, setDamage, dispose, variant, height: 1.3,
    gloveColor: P.glove };
}
