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

   npc.update(dt, { pos:{x,z}, target:{x,z}, npc: fight.state.npc, strike })
   places the fighter, faces it at the player and maps fight action +
   telegraph onto poses: windup = kind-specific tell, down = flatten,
   punch kind jab|hook|upper → jab|hook|upper, stunned/whiff → reel/stumble.
   strike = {reach, y} (npc-local lens target from game.js): while set, the
   punching glove flies at the camera — and stays planted there through a
   landed-hit hold even after the fight state has moved on.
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
    stunned:   { rx: -.12, rz: .18, sy: .92, y: 0,  z: -.04 },
    whiff:     { rx: .24,  rz: -.1, sy: .97, y: 0,  z: .14 },
  };
  POSES.upper = POSES.cross;
  for (const k of ['windup', 'jab', 'cross', 'hook', 'upper']) POSES[k + 'L'] = POSES[k];
  const FIELDS = ['rx', 'rz', 'sy', 'y', 'z'];
  return {
    group: rig,
    parts: {},
    pose(n, t01 = 0) { if (POSES[n]) { name = n; Object.assign(tgt, POSES[n]); } },
    tick(dt) {
      t += dt;
      const k = Math.min(1, dt * 8);
      for (const f of FIELDS) cur[f] = lerp(cur[f], tgt[f], k);
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
  stunned:   ['dizzy', 'stun', 'hit', 'hurt'],
  whiff:     ['stumble', 'trip', 'hit', 'idle'],
};
CLIP_FOR.upper = ['uppercut', 'upper', ...CLIP_FOR.cross];
// mirrored proto poses reuse the same clips — GLB can't mirror, base is close enough
CLIP_FOR.windupL = CLIP_FOR.windup; CLIP_FOR.jabL = CLIP_FOR.jab;
CLIP_FOR.hookL = CLIP_FOR.hook;     CLIP_FOR.crossL = CLIP_FOR.cross;
CLIP_FOR.upperL = CLIP_FOR.upper;
const ONCE = new Set(['jab', 'cross', 'hook', 'upper', 'down', 'hurt', 'celebrate',
  'jabL', 'crossL', 'hookL', 'upperL', 'whiff']);
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

/* fight.state.npc → pose name + progress. Returns a shared object — single
   consumer per frame, so no allocation ever enters the render path. */
/* telegraph.side is the NPC's anatomical glove — the proto part names follow
   the SCREEN side (rig faces +Z: anatomical left = parts.gloveR), so 'left'
   telegraphs pose gloveR and 'right' telegraphs the mirrored *L poses. */
const PUNCH_POSE = {
  jab:   { left: 'jabL',  right: 'jab' },
  hook:  { left: 'hookL', right: 'hook' },
  upper: { left: 'upper', right: 'upperL' },
};
const ACT = { name: 'idle', t01: 0 };
const punchPose = npc => PUNCH_POSE[npc._seenKind]?.[npc._seenSide] || 'jab';
function mapAction(npc, striking) {
  const A = ACT;
  if (!npc) { A.name = 'idle'; A.t01 = 0; return A; }
  const t = Math.min(1, (npc.actionT || 0) / .45);
  // a glove still planted on the lens / sailing past it holds the punch pose
  if (striking && npc.action !== 'punch' && npc.action !== 'hurt' && npc.action !== 'down') {
    A.name = punchPose(npc); A.t01 = .5; return A;
  }
  switch (npc.action) {
    case 'windup':    A.name = npc.telegraph?.side === 'right' ? 'windupL' : 'windup';
      A.t01 = npc.telegraph?.t01 ?? t; break;
    case 'punch':     A.name = punchPose(npc); A.t01 = t; break;
    case 'block':     A.name = 'block';     A.t01 = t; break;
    case 'hurt':      A.name = 'hurt';      A.t01 = t; break;
    case 'down':      A.name = 'down';      A.t01 = Math.min(1, (npc.actionT || 0) / .6); break;
    case 'celebrate': A.name = 'celebrate'; A.t01 = t; break;
    case 'stunned':   A.name = 'stunned';   A.t01 = npc.actionT || 0; break;   // cyclic wobble
    case 'whiff':     A.name = 'whiff';     A.t01 = t; break;
    default:          A.name = 'idle';      A.t01 = 0;
  }
  return A;
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
  const mats = [], seen = new Set();
  group.traverse(o => {
    if (o.isMesh && o.material) {
      const ms = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of ms)
        // one entry per material — inked hulls all share inkHullMat and
        // would otherwise lerp ~20 duplicate entries every hit
        if (m.color && !seen.has(m)) { seen.add(m);
          mats.push({ m, c: m.color.clone(), head: /head|face|skin|hair/i.test(o.name || '') }); }
    }
  });
  let dmgCur = 0;
  // fighters with modelled wounds (protoBoxer) only need a light flush — the
  // shiner/lump/bandage carry the story; GLBs get the full bruise wash
  const wash = impl.setDamage ? .45 : 1;
  function setDamage(frac) {                      // frac 0..1 = hp fraction lost
    frac = Math.min(1, frac);
    if (frac <= dmgCur) return;                   // monotone — no-op when not worsening
    dmgCur = frac;                                // wounds persist between rounds
    impl.setDamage?.(dmgCur);
    for (const { m, c, head } of mats) {
      const amt = (head ? dmgCur * .6 : dmgCur * .38) * wash;
      m.color.copy(c).lerp(BRUISE, amt);
      if (m.emissive) m.emissive.copy(BRUISE).multiplyScalar(dmgCur * .12);
    }
  }

  /* telegraph marker — a '!' starburst that rides the cocked glove and
     pulses faster as the swing charges (Punch-Out!! arm-flash, but it also
     says WHICH glove). White texture tinted hot as t01 → 1. */
  let tel = null;
  const telV = new THREE.Vector3();
  let telT = 0;
  if (typeof document !== 'undefined') {
    const telTexCv = document.createElement('canvas');
    telTexCv.width = telTexCv.height = 96;
    const x = telTexCv.getContext('2d');
    x.translate(48, 48);
    x.beginPath();                        // jagged 10-point burst
    for (let i = 0; i < 20; i++) {
      const a = i * Math.PI / 10, r = i % 2 ? 20 : 42;
      x[i ? 'lineTo' : 'moveTo'](Math.cos(a) * r, Math.sin(a) * r);
    }
    x.closePath();
    x.fillStyle = '#fff'; x.fill();
    x.strokeStyle = 'rgba(43,33,24,.9)'; x.lineWidth = 5; x.stroke();
    x.fillStyle = '#2b2118';
    x.beginPath(); x.roundRect(-5.5, -22, 11, 30, 5); x.fill();
    x.beginPath(); x.arc(0, 16, 7, 0, Math.PI * 2); x.fill();
    tel = new THREE.Sprite(new THREE.SpriteMaterial({
      map: new THREE.CanvasTexture(telTexCv), transparent: true,
      depthWrite: false }));
    tel.visible = false; tel.renderOrder = 6;
    group.add(tel);
  }

  const STRIKE = { kind: null, reach: null, y: null };   // shared — no per-frame alloc
  const gc = impl.gloveColor ?? 0xe0341f;
  const api = {
    group, id, name, kind,
    eyeY, headY: bb.min.y + H * .8, height: H, bbox: bb,
    gloveColor: '#' + gc.toString(16).padStart(6, '0'),   // for the 2D smash overlay
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
      if (npc?.telegraph?.kind) {                                    // punch loses telegraph — stash it
        npc._seenKind = npc.telegraph.kind; npc._seenSide = npc.telegraph.side;
      }
      const striking = Number.isFinite(ctx.strike?.reach);
      const p = mapAction(npc, striking);
      STRIKE.kind = npc?.telegraph?.kind ?? npc?._seenKind ?? null;
      STRIKE.reach = striking ? ctx.strike.reach : null;
      STRIKE.y = striking ? ctx.strike.y : null;
      impl.pose(p.name, p.t01, STRIKE);
      impl.tick(dt, npc || {}, Math.hypot(ctx.vel?.x || 0, ctx.vel?.z || 0));
      // telegraph marker over the cocked glove — 'left'/'right' name PIP's
      // anatomical glove; the proto rig faces +Z so its left glove is gloveR
      // (the part names follow the screen side). Faster flicker near release.
      const tg = npc?.telegraph;
      if (tel && tg) {
        telT += dt;
        const u = tg.t01 || 0;
        const part = impl.parts?.[tg.side === 'left' ? 'gloveR' : 'gloveL'];
        if (part) { part.getWorldPosition(telV); group.worldToLocal(telV); }
        else telV.set(tg.side === 'left' ? .34 : -.34, api.headY + .18, .2);
        tel.position.set(telV.x, telV.y + .16, telV.z);
        tel.scale.setScalar(.3 + u * .14 + Math.sin(telT * (7 + u * 26)) * .045);
        tel.material.color.setRGB(1, 1 - u * .5, 1 - u * .75);   // heats to orange
        tel.material.opacity = .75 + .25 * Math.sin(telT * (7 + u * 26));
        tel.visible = true;
      } else if (tel) tel.visible = false;
    },
    pose(n, t01) { impl.pose(n, t01); },
    dispose() { impl.dispose?.(); group.parent?.remove(group); },
  };
  return api;
}
