/* shared/boxing/ring.js — ring auto-footwork / pathfinding sim.

   Pure-JS 2D steering sim on the ring's ground plane (x right / z down).
   No THREE, no DOM — runs in plain node. Sway and dodge move the camera;
   a separate depth step moves the player a short distance along the ring.

     const sim = new RingSim({ radius:2.6, npcSpeed:1.4, playerDrift:1.0 });
     sim.step(dt, { sway:-1..1, playerDodge:-1|0|1, playerStep:-1..1,
                    npcDir:'press'|'circle'|'retreat'|'hold',
                    npcStunned:false });                    // every frame
     sim.player / sim.npc → { pos:{x,z}, vel:{x,z}, radius, heading }
     sim.distance()    // center gap between fighters
     sim.angleToNpc()  // camera yaw: set camera.rotation.y to this and a
                       // three.js camera (forward −Z) at player.pos faces npc
     sim.reset()

   AXES / ANGLES: heading & angleToNpc are yaws in radians. A "+Z-facing"
   model (protoBoxer) with rotation.y = fighter.heading faces its opponent.
   angleToNpc() = heading + π (camera convention). Lateral +1 (sway/dodge)
   = camera-right while facing the npc — at spawn that is world +X.

   NPC "pathfinding": velocity steering (seek / orbit / flee) with smooth
   exponential accel, an orbit-lane slide that routes the npc around the
   player's body to its goal point, soft push-apart so fighters never
   overlap, and a hard clamp inside the ropes (ring radius − body radius).
   Deterministic: pass {seed:n} — the only randomness is orbit-flip timing.
*/

export const TUNING = {
  radius: 2.6,           // ring radius to the ropes (world units)
  bodyRadius: 0.34,      // fighter footprint radius (collision + rope clamp)
  npcSpeed: 1.35,        // unhurried footwork — re-engages without rushing
  playerDrift: 1.0,      // legacy option retained for callers
  accel: 5.5,            // velocity approach rate /s — smooth accel & decel
  stunDamp: 8.0,         // stunned npc velocity decay rate /s (deadened drift)
  punchRange: 0.9,       // 'press' preferred hold distance, center to center
  midRange: 1.5,         // 'circle' orbit radius
  arriveRadius: 0.5,     // seek-and-hold slowdown radius around a goal point
  avoidPad: 0.22,        // pad beyond punchRange where the route-around flow kicks in
  orbitSpeed: .75,       // tangential npc speed while circling
  laneAngle: .42,        // rad — PIP stays inside this cone in front of the
                         // player, so the first-person view never has to swing
  laneGain: 4,           // how hard a drift past the lane edge is pulled back
  orbitFlipMin: 2.0,     // seconds, min/max between circle direction flips
  orbitFlipMax: 4.2,
  // Small forward/back steps preserve the first-person corner framing.
  playerLeash: 0.72,     // max |pos − spawn| including collision pushes
  stepForward: 0.65,     // lean in to enter range
  stepBack: 0.25,        // lean out to create breathing room
  anchorGain: 10,        // approach rate toward the chosen step position
  anchorSpeed: 1.5,      // responsive but still bounded footwork
  playerPushShare: 0.08, // fraction of body separation the player absorbs
};

const clamp = (v, lo, hi) => v < lo ? lo : v > hi ? hi : v;
const lerp = (a, b, t) => a + (b - a) * t;

// mulberry32 — tiny seeded PRNG so orbit flips are deterministic per {seed}.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class RingSim {
  constructor(opts = {}) {
    this.t = { ...TUNING, ...opts };            // every TUNING key overridable
    /* garbage-in guard: overrides must be finite non-negative numbers, else
       the default stands — a NaN radius once made every position NaN, and a
       negative accel inverted the steering feedback into divergence. */
    for (const k in TUNING) {
      const v = this.t[k];
      if (!Number.isFinite(v) || v < 0) this.t[k] = TUNING[k];
    }
    this.t.playerPushShare = clamp(this.t.playerPushShare, 0, 1);
    // the ring must fit both bodies side by side, else separation is impossible
    this.t.radius = Math.max(this.t.radius, 2 * this.t.bodyRadius + .3);
    if (this.t.orbitFlipMax < this.t.orbitFlipMin) this.t.orbitFlipMax = this.t.orbitFlipMin;
    this._seed = (opts.seed ?? 1337) >>> 0;
    this.reset();
  }

  reset() {
    const { t } = this;
    // Spawn: player planted in its corner zone on +Z (camera side),
    // npc starts at mid range so the opening exchange arrives quickly.
    // _home stays inside the ropes even when `radius` is shrunk — a corner
    // mark outside the ring had the leash dragging the player out of bounds.
    this._home = { x: 0, z: Math.min(1.5, Math.max(0, (t.radius - t.bodyRadius) * .9)) };
    this.player = { pos: { x: this._home.x, z: this._home.z }, vel: { x: 0, z: 0 }, radius: t.bodyRadius, heading: Math.PI };
    this.npc    = { pos: { x: 0, z: -0.05 }, vel: { x: 0, z: 0 }, radius: t.bodyRadius, heading: 0 };
    this._rng = mulberry32(this._seed);
    this._orbit = 1;                                        // circle direction ±1
    this._flipT = lerp(t.orbitFlipMin, t.orbitFlipMax, this._rng());
    this._syncHeadings();
    return this;
  }

  step(dt, input = {}) {
    if (!(dt > 0)) return;                    // ignore 0 / negative / NaN dt
    dt = Math.min(dt, 0.1);                   // stability cap for huge hitches
    if (!input || typeof input !== 'object') input = {};   // step(dt, null) must not crash
    const t = this.t, P = this.player, N = this.npc;
    // Sway and dodge steer the head only. Depth controls footwork.
    const inp = this._inp || (this._inp = { dir: 'hold', stun: false, step: 0 });
    inp.dir = typeof input.npcDir === 'string' ? input.npcDir : 'hold';
    inp.stun = !!input.npcStunned;
    inp.step = Number.isFinite(+input.playerStep) ? clamp(+input.playerStep, -1, 1) : 0;

    // ---- shared geometry (recomputed post-collision via _syncHeadings) ----
    let dx = N.pos.x - P.pos.x, dz = N.pos.z - P.pos.z;
    let d = Math.hypot(dx, dz);
    if (d < 1e-6) { dx = 1; dz = 0; d = 1e-6; }
    const ux = dx / d, uz = dz / d;            // unit vector player → npc
    const sx = -uz, sz = ux;                   // unit "strafe right" (camera-right)

    // ================= NPC steering =================
    let nvx = 0, nvz = 0;
    if (!inp.stun) {
      switch (inp.dir) {
        case 'press': {
          // Goal point: punchRange off the player on the ring-center side —
          // npc ends up between the player and center-ish, cutting them off.
          const pr = Math.hypot(P.pos.x, P.pos.z);
          let gx, gz;
          if (pr > 0.4) { gx = P.pos.x - (P.pos.x / pr) * t.punchRange; gz = P.pos.z - (P.pos.z / pr) * t.punchRange; }
          else          { gx = P.pos.x - ux * t.punchRange;             gz = P.pos.z - uz * t.punchRange; }
          const tx = gx - N.pos.x, tz = gz - N.pos.z;
          const td = Math.hypot(tx, tz) || 1e-6;
          const spd = t.npcSpeed * Math.min(1, td / t.arriveRadius);   // arrive
          nvx = (tx / td) * spd; nvz = (tz / td) * spd;
          // Route around the player's body: while crowding and the goal is
          // still off, add tangential flow toward the goal side so the npc
          // slides around on an "orbit lane" instead of pushing through.
          const w = clamp((t.punchRange + t.avoidPad - d) / t.avoidPad, 0, 1);
          if (w > 0 && td > 0.12) {
            const s = (sx * tx + sz * tz) / td >= 0 ? 1 : -1;
            nvx += sx * s * t.npcSpeed * w;
            nvz += sz * s * t.npcSpeed * w;
          }
          break;
        }
        case 'circle': {
          // Orbit the player at midRange; flip direction on a seeded timer —
          // or early, when the orbit is carrying PIP out of the front lane.
          this._flipT -= dt;
          const lat = N.pos.x - P.pos.x;
          const atEdge = Math.abs(lat) > Math.max(.15, P.pos.z - N.pos.z) * Math.tan(t.laneAngle) * .8;
          if (atEdge && Math.sign(sx * this._orbit) === Math.sign(lat)) this._flipT = 0;
          if (this._flipT <= 0) {
            this._orbit *= -1;
            this._flipT = lerp(t.orbitFlipMin, t.orbitFlipMax, this._rng());
          }
          const vr = clamp((t.midRange - d) * 3, -1, 1) * t.npcSpeed * 0.6;
          nvx = ux * vr + sx * this._orbit * t.orbitSpeed;
          nvz = uz * vr + sz * this._orbit * t.orbitSpeed;
          break;
        }
        case 'retreat': {
          // Flee the player; when the ropes get close, slide along them
          // on whichever tangent keeps fleeing (no corner deadlock).
          const nr = Math.hypot(N.pos.x, N.pos.z) || 1e-6;
          const lim = t.radius - N.radius;
          const w = clamp((nr - (lim - 0.4)) / 0.4, 0, 1);             // near-ropes 0→1
          const px = -N.pos.z / nr, pz = N.pos.x / nr;                 // rope tangent
          const s = (px * ux + pz * uz) >= 0 ? 1 : -1;                 // fleeing side
          const sp = t.npcSpeed;
          nvx = ux * sp * (1 - 0.55 * w) + px * s * sp * 0.8 * w;
          nvz = uz * sp * (1 - 0.55 * w) + pz * s * sp * 0.8 * w;
          break;
        }
        default: break;                    // 'hold' / unknown: stand ground
      }
    }
    // front lane (player faces −Z from its corner): anything that drifts PIP
    // wide gets pulled back toward the centre line in front of you
    if (!inp.stun) {
      const lat = N.pos.x - P.pos.x;
      const over = Math.abs(lat) - Math.max(.15, P.pos.z - N.pos.z) * Math.tan(t.laneAngle);
      if (over > 0) nvx -= Math.sign(lat) * Math.min(t.npcSpeed, over * t.laneGain);
    }
    const nk = 1 - Math.exp(-(inp.stun ? t.stunDamp : t.accel) * dt);
    N.vel.x += (nvx - N.vel.x) * nk;
    N.vel.z += (nvz - N.vel.z) * nk;

    // ================= player: short depth step =================
    // Absolute step target returns to neutral as the boxer straightens up.
    // The x anchor keeps lateral dodges as head movement, so attacks remain
    // readable and the player cannot walk out of the camera's corner lane.
    {
      const ax = (this._home.x - P.pos.x) * t.anchorGain;
      const stepZ = inp.step >= 0 ? -inp.step * t.stepForward : -inp.step * t.stepBack;
      const az = (this._home.z + stepZ - P.pos.z) * t.anchorGain;
      const am = Math.hypot(ax, az);
      const sc = am > t.anchorSpeed ? t.anchorSpeed / am : 1;
      const pk = 1 - Math.exp(-t.accel * dt);
      P.vel.x += (ax * sc - P.vel.x) * pk;
      P.vel.z += (az * sc - P.vel.z) * pk;
    }

    // ================= integrate + resolve =================
    P.pos.x += P.vel.x * dt; P.pos.z += P.vel.z * dt;
    N.pos.x += N.vel.x * dt; N.pos.z += N.vel.z * dt;
    // Relax: asymmetric push-apart (npc yields most of the overlap)
    // → rope clamps → corner leash, iterated to converge; final
    // npc-only separation guarantees no residual overlap.
    // Helpers report whether they moved anything — converged early = loop done.
    for (let i = 0; i < 4; i++) {
      if (!(this._pushApart() | this._clamp(P) | this._clamp(N) | this._leashPlayer())) break;
    }
    this._pushNpcOff();
    this._clamp(N);
    this._syncHeadings();
  }

  distance() {
    return Math.hypot(this.npc.pos.x - this.player.pos.x,
                      this.npc.pos.z - this.player.pos.z);
  }

  angleToNpc() {
    // Camera-yaw convention: camera.rotation.y = angleToNpc() aims a -Z
    // three.js camera at the npc (= heading + π).
    const dx = this.npc.pos.x - this.player.pos.x;
    const dz = this.npc.pos.z - this.player.pos.z;
    return Math.atan2(-dx, -dz);
  }

  // Soft separation — the npc absorbs almost all of it; the player takes
  // only a small shove, then eases back toward its chosen step position.
  _pushApart() {
    const P = this.player, N = this.npc, min = P.radius + N.radius;
    let dx = N.pos.x - P.pos.x, dz = N.pos.z - P.pos.z;
    let d = Math.hypot(dx, dz);
    if (d >= min) return 0;
    if (d < 1e-6) { dx = 1; dz = 0; d = 1e-6; }
    const ov = min - d, ux = dx / d, uz = dz / d;
    const ps = ov * this.t.playerPushShare;
    P.pos.x -= ux * ps; P.pos.z -= uz * ps;
    N.pos.x += ux * (ov - ps); N.pos.z += uz * (ov - ps);
    return 1;
  }

  // Final separation pass: residual overlap is taken out of the npc alone.
  _pushNpcOff() {
    const P = this.player, N = this.npc, min = P.radius + N.radius;
    let dx = N.pos.x - P.pos.x, dz = N.pos.z - P.pos.z;
    let d = Math.hypot(dx, dz);
    if (d >= min) return;
    if (d < 1e-6) { dx = 1; dz = 0; d = 1e-6; }
    const ov = min - d;
    N.pos.x += (dx / d) * ov; N.pos.z += (dz / d) * ov;
  }

  // Corner-zone leash bounds forward and backward footwork. The cap is also
  // bounded by what keeps the player inside the ropes (|home| + lim ≤ ringLim
  // by triangle inequality) — a shrunken ring can't leash the player out.
  _leashPlayer() {
    const P = this.player;
    const ringLim = Math.max(0, this.t.radius - P.radius) || 0;
    const homeR = Math.hypot(this._home.x, this._home.z);
    const lim = Math.max(0, Math.min(Math.max(0, this.t.playerLeash) || 0, ringLim - homeR));
    const dx = P.pos.x - this._home.x, dz = P.pos.z - this._home.z;
    const r = Math.hypot(dx, dz);
    if (r > lim) {
      P.pos.x = this._home.x + (dx / r) * lim;
      P.pos.z = this._home.z + (dz / r) * lim;
      return 1;
    }
    return 0;
  }

  // Hard clamp inside the ropes (ring radius − body radius); bleeds the
  // outward velocity component so a clamped fighter doesn't keep pushing.
  _clamp(f) {
    const lim = Math.max(0, this.t.radius - f.radius) || 0;   // never negative/NaN
    const r = Math.hypot(f.pos.x, f.pos.z);
    if (r <= lim) return 0;
    const nx = f.pos.x / r, nz = f.pos.z / r;
    f.pos.x = nx * lim; f.pos.z = nz * lim;
    const vout = f.vel.x * nx + f.vel.z * nz;
    if (vout > 0) { f.vel.x -= vout * nx; f.vel.z -= vout * nz; }
    return 1;
  }

  // heading = yaw for a "+Z-facing" model to face its opponent.
  _syncHeadings() {
    let dx = this.npc.pos.x - this.player.pos.x, dz = this.npc.pos.z - this.player.pos.z;
    const d = Math.hypot(dx, dz) || 1e-6;
    this.player.heading = Math.atan2(dx / d, dz / d);
    this.npc.heading = Math.atan2(-dx / d, -dz / d);
  }
}
