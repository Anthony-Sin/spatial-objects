/* shared/boxing/npc.js — NPC adapter.

   const npc = await createNpc(THREE, { scene, manifestUrl, manifest, id })
     → { group, id, name, kind:'glb'|'proto'|'emergency', variant,
         update(dt, ctx), pose(name,t01), dispose() }

   Selection: localStorage['boxing:npc'] picks the fighter.
     · id matching an assetManifest candidate (type 'glb') → GLTFLoader load,
       normalized to ~1.3 units, feet at y=0, driven by a procedural rig
       (lean/squash/tilt) since arbitrary GLBs have no boxing poses.
     · else a protoBoxer VARIANT id ('bubble'|'blocky'|'bean' or 'proto:<v>')
     · ANY GLB failure (bad fetch, parse error, missing loader) → protoBoxer
     · protoBoxer module itself missing → tiny built-in emergency boxer so
       the page still runs pre-merge. Default pick = 'bubble'.

   npc.update(dt, { pos:{x,z}, target:{x,z}, npc: fight.state.npc }) places
   the fighter, faces it at the player and maps fight action + telegraph
   onto poses: windup = lean back (brows are protoBoxer's job), down =
   flatten, punch kind jab|hook|upper → jab|hook|cross.
*/

const pickId = () => {
  // no stored pick → the house-made favorite
  try { return localStorage.getItem('boxing:npc') || 'proto:bubble'; }
  catch { return 'proto:bubble'; }
};

const fetchManifest = async (opts) => {
  if (opts.manifest) return opts.manifest;
  const url = opts.manifestUrl || './shared/boxing/assetManifest.json';
  try {
    const r = await fetch(url);
    if (!r.ok) return { candidates: [] };
    const j = await r.json();
    return { candidates: j.candidates || [] };
  } catch { return { candidates: [] }; }
};

const pretty = (s) => String(s || 'bubble').replace(/^proto:/, '')
  .replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

/* Procedural rig — wraps any inner object (GLB scene or primitives) with a
   protoBoxer-compatible pose()/tick()/dispose(). Blends transform targets:
   windup leans back + puffs up, punches lunge forward, block crouches,
   hurt tilts, down flattens onto the canvas, celebrate hops. */
function makeRig(THREE, inner) {
  const rig = new THREE.Group(); rig.add(inner);
  const cur = { rx: 0, rz: 0, sy: 1, y: 0, z: 0 }, tgt = { ...cur };
  let t = 0, name = 'idle';
  const POSES = {
    idle:      { rx: 0,    rz: 0,   sy: 1,   y: 0,  z: 0 },
    windup:    { rx: -.3,  rz: 0,   sy: 1.08,y: .02,z: -.06 },
    jab:       { rx: .2,   rz: 0,   sy: .96, y: 0,  z: .16 },
    cross:     { rx: .26,  rz: -.1, sy: .94, y: 0,  z: .22 },
    hook:      { rx: .12,  rz: .3,  sy: .97, y: 0,  z: .12 },
    block:     { rx: .08,  rz: 0,   sy: .86, y: 0,  z: -.05 },
    hurt:      { rx: -.16, rz: .3,  sy: .93, y: 0,  z: -.1 },
    down:      { rx: -1.35,rz: 0,   sy: .62, y: .06,z: -.25 },
    celebrate: { rx: 0,    rz: 0,   sy: 1.05,y: 0,  z: 0 },
  };
  return {
    group: rig,
    parts: {},
    pose(n, t01 = 0) { if (POSES[n]) { name = n; Object.assign(tgt, POSES[n]); } },
    tick(dt) {
      t += dt;
      const k = Math.min(1, dt * 8);
      for (const f of ['rx', 'rz', 'sy', 'y', 'z']) cur[f] = lerp(cur[f], tgt[f], k);
      const bounce = name === 'celebrate' ? Math.abs(Math.sin(t * 7)) * .16
        : name === 'down' ? 0 : Math.sin(t * 4.2) * .018;   // breathing
      rig.rotation.x = cur.rx; rig.rotation.z = cur.rz;
      rig.scale.y = cur.sy * (name === 'down' ? 1 : 1 + Math.sin(t * 4.2) * .012);
      rig.position.y = cur.y + bounce; rig.position.z = cur.z;
    },
    dispose() {
      inner.traverse?.(o => { o.geometry?.dispose?.(); o.material?.dispose?.(); });
    },
  };
}
const lerp = (a, b, t) => a + (b - a) * t;

/* clip keyword preferences per pose — first hit wins, falls back to idle-ish.
   Covers the kenney blocky set ('attack-melee-right', 'die', 'emote-yes'…)
   and generic names ('punch', 'hit', 'cheer'…). */
const CLIP_FOR = {
  jab:       ['attack-melee-left', 'jab', 'punch-left', 'attack'],
  cross:     ['attack-melee-right', 'cross', 'punch-right', 'attack'],
  hook:      ['attack-melee', 'hook', 'swing', 'attack'],
  down:      ['die', 'death', 'ko', 'down', 'defeat'],
  hurt:      ['hit', 'hurt', 'damage', 'stagger'],
  celebrate: ['emote-yes', 'cheer', 'win', 'victory', 'emote'],
  windup:    ['idle-attack', 'windup', 'block', 'guard'],
  block:     ['block', 'guard', 'idle'],
  idle:      ['idle', 'rest', 'breath', 'stand'],
};
const ONCE = new Set(['jab', 'cross', 'hook', 'down', 'hurt', 'celebrate']);
const pickClip = (clips, pose) => {
  for (const kw of CLIP_FOR[pose] || CLIP_FOR.idle) {
    const c = clips.find(c => c.name.toLowerCase().includes(kw));
    if (c) return c;
  }
  return clips.find(c => c.name.toLowerCase().includes('idle')) || clips[0];
};

async function tryGlb(THREE, cand) {
  const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
  const url = './' + String(cand.path).replace(/^\.?\//, '');
  const gltf = await new Promise((res, rej) =>
    new GLTFLoader().load(url, res, undefined, rej));
  const obj = gltf.scene || gltf.scenes?.[0];
  if (!obj) throw new Error('empty glb');
  if (cand.scale) obj.scale.setScalar(cand.scale);
  else {   // auto-fit to chibi height when the manifest doesn't pin a scale
    const b = new THREE.Box3().setFromObject(obj);
    const h = b.max.y - b.min.y || 1;
    obj.scale.setScalar(1.3 / h);
  }
  {   // manifest yOffset is the world lift that grounds the feet (scout-tuned);
    const b = new THREE.Box3().setFromObject(obj);   // absent → auto-rest on 0
    obj.position.y += cand.yOffset ?? -b.min.y;
  }
  obj.rotation.y = cand.yaw || cand.yawOffset || 0;
  obj.traverse(o => { if (o.isMesh) { o.castShadow = true; o.frustumCulled = false; } });

  const rig = makeRig(THREE, obj);
  const clips = gltf.animations || [];
  if (!clips.length) return rig;

  // baked clips on board — drive them with a mixer, rig squash rides on top
  const mixer = new THREE.AnimationMixer(obj);
  const actions = {};
  let curName = 'idle', cur = null;
  const act = (name) => {
    if (!actions[name]) {
      const c = pickClip(clips, name); if (!c) return null;
      actions[name] = mixer.clipAction(c);
      if (ONCE.has(name)) { actions[name].setLoop(THREE.LoopOnce); actions[name].clampWhenFinished = true; }
    }
    return actions[name];
  };
  const proto = { pose: rig.pose, tick: rig.tick };
  rig.pose = (name, t01) => {
    proto.pose(name, t01);
    if (name === curName) return;
    const nxt = act(name); if (!nxt) return;
    cur?.fadeOut(.14); nxt.reset().fadeIn(.14).play();
    cur = nxt; curName = name;
  };
  rig.tick = (dt, st) => { proto.tick(dt, st); mixer.update(dt); };
  act('idle'); cur = actions.idle; cur.play?.();
  return rig;
}

async function tryProto(THREE, variant) {
  const m = await import('./protoBoxer.js').catch(() => null);
  if (!m?.buildBoxer) return null;
  const v = (m.VARIANTS || []).includes(variant) ? variant : (m.VARIANTS?.[0] || 'bubble');
  try {
    const b = m.buildBoxer(THREE, { variant: v });
    b.group.traverse?.(o => { if (o.isMesh) o.castShadow = true; });
    return b;
  } catch { return null; }
}

/* last-resort chibi so the ring is never empty, even pre-merge */
function emergency(THREE) {
  const g = new THREE.Group();
  const flat = (c) => new THREE.MeshStandardMaterial({ color: c, roughness: .9 });
  const add = (geo, c, x, y, z, s = 1) => {
    const m = new THREE.Mesh(geo, flat(c)); m.position.set(x, y, z);
    m.scale.setScalar(s); m.castShadow = true; g.add(m); return m;
  };
  add(new THREE.SphereGeometry(.42, 18, 14), 0xffc53d, 0, .86, 0);          // head
  add(new THREE.SphereGeometry(.36, 18, 14), 0x4fb06d, 0, .4, 0);           // body
  add(new THREE.SphereGeometry(.05, 8, 8), 0x2b2118, -.15, .9, .38);        // eye L
  add(new THREE.SphereGeometry(.05, 8, 8), 0x2b2118, .15, .9, .38);         // eye R
  add(new THREE.SphereGeometry(.18, 14, 10), 0xe0341f, -.42, .62, .18);     // glove L
  add(new THREE.SphereGeometry(.18, 14, 10), 0xe0341f, .42, .62, .18);      // glove R
  add(new THREE.SphereGeometry(.1, 10, 8), 0x2b2118, -.16, .05, .02);       // foot L
  add(new THREE.SphereGeometry(.1, 10, 8), 0x2b2118, .16, .05, .02);        // foot R
  return makeRig(THREE, g);
}

/* fight.state.npc → pose name + progress */
function mapAction(npc) {
  if (!npc) return { name: 'idle', t01: 0 };
  const t = Math.min(1, (npc.actionT || 0) / .45);
  switch (npc.action) {
    case 'windup':    return { name: 'windup', t01: npc.telegraph?.t01 ?? t };
    case 'punch':     return { name: { hook: 'hook', upper: 'cross' }[npc._seenKind] || 'jab', t01: t };
    case 'block':     return { name: 'block', t01: t };
    case 'hurt':      return { name: 'hurt', t01: t };
    case 'down':      return { name: 'down', t01: Math.min(1, (npc.actionT || 0) / .6) };
    case 'celebrate': return { name: 'celebrate', t01: t };
    default:          return { name: 'idle', t01: 0 };
  }
}

export async function createNpc(THREE, opts = {}) {
  const group = new THREE.Group();
  if (opts.scene) opts.scene.add(group);
  const pick = opts.id ?? pickId();
  const manifest = await fetchManifest(opts);
  const cand = pick ? manifest.candidates.find(c => c.id === pick && c.type === 'glb') : null;

  let impl = null, kind = 'proto', id = pick || 'bubble', name = pretty(pick);
  if (cand) {
    impl = await tryGlb(THREE, cand).catch(() => null);   // ANY failure → protoBoxer
    if (impl) { kind = 'glb'; name = cand.name || pick; }
  }
  if (!impl) {
    const variant = pretty(pick).toLowerCase().replace(/ /g, '') || 'bubble';
    impl = await tryProto(THREE, variant);
    if (impl) { kind = 'proto'; id = impl.variant || variant; name = pretty(impl.variant || variant); }
  }
  if (!impl) { impl = emergency(THREE); kind = 'emergency'; id = 'emergency'; name = 'PIP'; }

  group.add(impl.group);
  const bb = new THREE.Box3().setFromObject(group);
  const H = Math.max(.3, bb.max.y - bb.min.y);
  const eyeY = bb.min.y + H * .86;                    // eye line ≈ top of head

  /* damage painted straight onto the fighter — every material lerps
     toward bruise-red as the stage climbs (no floating decals). Head
     materials get hit hardest; bodies stay closer to base. */
  const BRUISE = new THREE.Color(0x8c1f28);
  const mats = [];
  group.traverse(o => {
    if (o.isMesh && o.material) {
      const ms = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of ms) if (m.color) mats.push({ m, c: m.color.clone(), head: /head|face|skin|hair/i.test(o.name || '') });
    }
  });
  let dmgCur = 0;
  function setDamage(frac) {                      // frac 0..1 = hp fraction lost
    dmgCur = Math.max(dmgCur, Math.min(1, frac)); // wounds persist between rounds
    for (const { m, c, head } of mats) {
      const amt = head ? dmgCur * .6 : dmgCur * .38;
      m.color.copy(c).lerp(BRUISE, amt);
      if (m.emissive) m.emissive.copy(BRUISE).multiplyScalar(dmgCur * .12);
    }
  }

  const api = {
    group, id, name, kind,
    eyeY, headY: bb.min.y + H * .8, height: H, bbox: bb,
    kick: { x: 0, y: 0, z: 0 },           // visual knock flinch — decays, never sim state
    setDamage,
    get variant() { return impl.variant || id; },
    update(dt, ctx = {}) {
      const { pos, target, npc } = ctx;
      if (pos) {
        api.kick.x *= Math.exp(-dt * 7); api.kick.z *= Math.exp(-dt * 7);
        api.kick.y *= Math.exp(-dt * 9);                               // uppercut launch lands fast
        group.position.set(pos.x + api.kick.x, api.kick.y, pos.z + api.kick.z);
      }
      if (pos && target) group.rotation.y = Math.atan2(target.x - pos.x, target.z - pos.z);
      if (npc?.telegraph?.kind) npc._seenKind = npc.telegraph.kind;  // punch loses telegraph — stash it
      const p = mapAction(npc);
      impl.pose(p.name, p.t01);
      impl.tick(dt, npc || {});
    },
    pose(n, t01) { impl.pose(n, t01); },
    dispose() { impl.dispose?.(); group.parent?.remove(group); },
  };
  return api;
}
