/* shared/boxing/fists.js — webcam hands → boxing inputs. Pure JS, no THREE/DOM.

     const fists = new FistTracker();
     each frame: fists.update(hands.state, face.state, dt)   // dt in seconds
       fists.punches   drain each frame → [{kind, side, power:0..1, t}]
                       kind ∈ 'jab'(left) 'cross'(right) 'hook' 'uppercut'
       fists.guard     {left:0..1, right:0..1}  glove-up-ness per side
       fists.sway      -1..1 head lean vs calibrated center (+ = screen right)
       fists.duck      0..1 head drop below the neutral nose height
     fists.calibrate() call on a neutral pose ('C' key): re-zeros sway/duck and
                       snaps span baselines so current hand size = reach 1
     fists.debug()     {span, reach, guard, sway, baseline, state}

   DEPTH MODEL — "hand grows bigger = closer to screen":
     span     = hypot(lm[9]−lm[0])  wrist → middle-mcp, normalized units
     baseline = slow EMA of span, updated ONLY while the hand is calm
     reach    = span / baseline     (~1 at rest, grows as fist nears camera)
   A punch THROWS when smoothed d(reach)/dt crosses FIRE_VEL while the hand
   is fist-ish, and EMITS once the thrust dies (apex/retract, or MAX_THROW_T
   hold-out) — power ∝ peak reach. Direction = dominant channel of the
   throw's net motion in hand-size units: lateral → 'hook', upward →
   'uppercut', else 'jab'/'cross' by side. The fist stays spent until
   reachVel dips below RESET_VEL — the retract re-arms it, so combos work.

   Robustness: handsState is re-read fresh every update (no identity
   caching — window.__forceHands-style injection is fine); a missing hand
   decays its side gracefully and cancels a half-thrown punch.
*/
export const TUNING = {
  // depth model
  BASELINE_RATE: 1.2,   // /s — baseline span EMA while the hand is calm
  REACH_CAP: 1.8,       // reach that maps to power 1
  POWER_FLOOR: .15,     // any emitted punch reports at least this much
  // smoothing
  VEL_SMOOTH: 30,       // /s — EMA on d(reach)/dt
  PALM_SMOOTH: 20,      // /s — EMA on palm velocity
  CALM_RV: .55,         // reach/s — |reachVel| under ⇒ calm ⇒ baseline adapts
  CALM_PV: .45,         // norm/s — palm speed ceiling for "calm"
  // punch state machine
  FIRE_VEL: 1.2,        // reach/s — thrust speed that starts a throw
  FIRE_FRAMES: 2,       // consecutive hot frames required — a 1-frame
                        // landmark spike can never fire a phantom punch
  EMIT_VEL: .12,        // reach/s — thrust stalls near apex ⇒ emit NOW
                        // (was -.05: waited for actual retraction — punches
                        // felt ~250ms late)
  RESET_VEL: .25,       // reach/s — must drop below to re-arm (the retract)
  MAX_THROW_T: .24,     // s — hand held out this long ⇒ emit anyway
  PUNCH_MAX: 16,        // safety cap if a consumer forgets to drain
  // dropouts
  MISS_GRACE: 5,        // frames a hand may vanish before the throw cancels
  RESNAP_MISS: 45,      // frames gone ⇒ re-snap baseline on return
  MIN_SPAN: .02,        // degenerate landmark cloud ⇒ treat as missing
  // guard
  GUARD_RATE: 14,       // /s — guard smoothing
  GUARD_FALL: 4,        // /s — guard decay while the hand is missing
  GUARD_Y_FULL: .36, GUARD_Y_ZERO: .58,       // no-face height band (norm y)
  GUARD_NOSE_LO: .18, GUARD_NOSE_RANGE: .2,   // face-anchored band below nose
  GUARD_REACH_LO: .85, GUARD_REACH_HI: 1.02,  // closeness band on reach
  // sway / face
  FACE_SMOOTH: 15,      // /s — nose EMA (was 8: the 4-layer sway chain put
                        // ~400ms between a real head lean and the dodge)
  SWAY_SMOOTH: 15,      // /s — sway EMA
  SWAY_RANGE: .13,      // nose-x units of lean that map to ±1
  DUCK_LO: .035,        // nose-y drop ignored (posture drift / nodding)
  DUCK_RANGE: .09,      // further nose-y drop that maps to duck 1
  DT_MAX: .1,           // s — clamp dt (tab-switch spikes)
};

const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const ema = (cur, tgt, rate, dt) => cur + (tgt - cur) * (1 - Math.exp(-rate * dt));
const SIDES = ['left', 'right'];
const NO_FACE = {};                              // shared — faceState may be null

export class FistTracker {
  constructor(opts = {}) {
    this.T = { ...TUNING, ...opts };        // per-instance tuning overrides
    this.punches = [];
    this.guard = { left: 0, right: 0 };
    this.reach = { left: 1, right: 1 };     // live view — overlay reads this instead of debug()
    this.sway = 0;
    this.duck = 0;
    this._pick = { left: null, right: null };   // one pick pass instead of find() per side
    this._t = 0;
    this._s = { left: this._blank(), right: this._blank() };
    this._nose = { x: .5, y: .5 };          // smoothed nose (guard band + sway)
    this._cx = .5;                          // calibrated sway center
    this._cy = null;                        // neutral nose height — first face sighting
    this._faceSize = 0;
  }

  _blank() {
    return {
      seen: false, miss: 0,
      baseline: 0, lastSpan: 0, reach: 1, prevReach: 1, reachVel: 0,
      vx: 0, vy: 0, px: 0, py: 0, prevSpan: 0, sampT: 0, stale: 0,
      state: 'idle', hot: 0, peak: 1, tThrow: 0, acc: { t: 0, x: 0, y: 0 },
      guard: 0,
    };
  }

  // selfie view is x-mirrored: screen-left = player's left. Fall back to
  // palm position when MediaPipe drops the handedness label.
  _sideOf(h) {
    if (h.side === 'left' || h.side === 'right') return h.side;
    return (h.palm && h.palm.x < .5) ? 'left' : 'right';
  }

  _usable(h) {
    // shape gate — runs BEFORE _sideOf in the find predicate so malformed
    // entries (null, primitives, missing parts) can never crash a frame or
    // block a valid hand sitting later in the same array. Only lm[0]/lm[9]
    // are checked: they're the only landmarks the depth model reads.
    const lm = h && h.lm;
    return !!(lm && lm.length >= 10
      && h.palm && Number.isFinite(h.palm.x) && Number.isFinite(h.palm.y)
      && Number.isFinite(lm[0]?.x) && Number.isFinite(lm[0]?.y)
      && Number.isFinite(lm[9]?.x) && Number.isFinite(lm[9]?.y));
  }

  update(handsState, faceState, dt) {
    const T = this.T;
    if (!(dt > 0)) dt = 1 / 60;
    if (dt > T.DT_MAX) dt = T.DT_MAX;
    this._t += dt;

    // ---- face: sway + the anchor for the guard height band --------------
    const f = faceState || NO_FACE;
    const faceFound = !!(f.found && f.nose
      && Number.isFinite(f.nose.x) && Number.isFinite(f.nose.y));
    if (faceFound) {
      this._nose.x = ema(this._nose.x, f.nose.x, T.FACE_SMOOTH, dt);
      this._nose.y = ema(this._nose.y, f.nose.y, T.FACE_SMOOTH, dt);
      if (f.size > 0) this._faceSize = this._faceSize
        ? ema(this._faceSize, f.size, T.FACE_SMOOTH, dt) : f.size;
      const lean = clamp((this._nose.x - this._cx) / T.SWAY_RANGE, -1, 1);
      this.sway = ema(this.sway, lean, T.SWAY_SMOOTH, dt);
      if (this._cy === null) this._cy = f.nose.y;
      const drop = clamp((this._nose.y - this._cy - T.DUCK_LO) / T.DUCK_RANGE, 0, 1);
      this.duck = ema(this.duck, drop, T.SWAY_SMOOTH, dt);
    } else {
      this.sway = ema(this.sway, 0, T.SWAY_SMOOTH * .5, dt);
      this.duck = ema(this.duck, 0, T.SWAY_SMOOTH * .5, dt);
    }

    // ---- hands ------------------------------------------------------------
    const hands = Array.isArray(handsState?.hands) ? handsState.hands : [];
    const pick = this._pick; pick.left = pick.right = null;
    for (let i = 0, n = hands.length; i < n; i++) {
      const h = hands[i];
      if (!this._usable(h)) continue;
      const s = this._sideOf(h);
      if (pick[s] === null) pick[s] = h;    // first usable per side — same as find()
    }
    for (const side of SIDES) {
      const S = this._s[side];
      const h = pick[side];
      if (!h) { this._missed(S, dt); this.guard[side] = S.guard; this.reach[side] = S.reach; continue; }

      const reacq = S.miss > 0;               // gap → snap, don't spike
      S.miss = 0;
      const lm = h.lm;
      const span = Math.hypot(lm[9].x - lm[0].x, lm[9].y - lm[0].y);
      if (!(span > T.MIN_SPAN)) { this._missed(S, dt); this.guard[side] = S.guard; this.reach[side] = S.reach; continue; }
      /* fresh = a new tracking result just landed. Results arrive ~30Hz while
         update() runs per render frame (40-60fps) — identical numbers mean
         the last result is still current. Velocity must derive off the
         sample interval, not dt: repeat frames would inject 0s and halve
         the measured punch speed, and per-frame deltas on a fresh sample
         would inflate it by the render/result rate ratio. */
      const fresh = span !== S.prevSpan || h.palm.x !== S.px || h.palm.y !== S.py;
      if (fresh) S.stale = 0;
      else if (++S.stale > 30) {            // frozen stream = effectively lost
        this._missed(S, dt); this.guard[side] = S.guard; this.reach[side] = S.reach; continue;
      }
      S.lastSpan = span;

      if (!S.seen || !(S.baseline > 0)) {     // first sight → rest size = now
        S.baseline = span; S.prevReach = 1; S.reachVel = 0;
        S.vx = S.vy = 0; S.px = h.palm.x; S.py = h.palm.y;
        S.prevSpan = span; S.sampT = this._t;
        S.state = 'idle'; S.seen = true;
      }
      const reach = span / S.baseline;
      S.reach = reach; this.reach[side] = reach;
      if (reacq) { S.prevReach = reach; S.reachVel = 0; S.vx = S.vy = 0;
        S.px = h.palm.x; S.py = h.palm.y; S.prevSpan = span; S.sampT = this._t; }

      if (fresh && !reacq) {
        const dtS = Math.min(.2, Math.max(.005, this._t - S.sampT));
        S.sampT = this._t;
        S.reachVel = ema(S.reachVel, (reach - S.prevReach) / dtS, T.VEL_SMOOTH, dtS);
        S.vx = ema(S.vx, (h.palm.x - S.px) / dtS, T.PALM_SMOOTH, dtS);
        S.vy = ema(S.vy, (h.palm.y - S.py) / dtS, T.PALM_SMOOTH, dtS);
        S.prevReach = reach; S.prevSpan = span; S.px = h.palm.x; S.py = h.palm.y;
      }

      // baseline span chases the hand only while calm & not mid-throw — a
      // punch grows span fast, so freezing during motion keeps reach honest
      const calm = S.state === 'idle' && Math.abs(S.reachVel) < T.CALM_RV
        && Math.abs(S.vx) < T.CALM_PV && Math.abs(S.vy) < T.CALM_PV;
      if (calm) S.baseline = ema(S.baseline, span, T.BASELINE_RATE, dt);

      // ---- punch state machine: idle → throw → recover → idle
      const fistish = h.kind === 'fist'
        || (h.kind !== 'pinch' && typeof h.nExt === 'number' && h.nExt <= 2);
      // debounce: thrust speed must persist FIRE_FRAMES frames before the
      // throw engages — a single-frame span spike (real MediaPipe pop-outs)
      // heats up once then collapses below threshold, so it can't emit
      // count only fresh results — one spiked sample can't double-count via
      // held velocity on repeat frames
      if (fresh) S.hot = (fistish && S.reachVel > T.FIRE_VEL) ? S.hot + 1 : 0;
      if (S.state === 'idle' && S.hot >= T.FIRE_FRAMES) {
        S.state = 'throw'; S.peak = reach; S.tThrow = 0;
        S.acc.t = S.acc.x = S.acc.y = 0;
      }
      if (S.state === 'throw') {
        S.tThrow += dt;
        if (reach > S.peak) S.peak = reach;
        // net throw motion in hand-size units → the 3 channels compare fair:
        // thrust = reach gained, x/y = palm travel ÷ span
        const inv = 1 / Math.max(span, T.MIN_SPAN);
        S.acc.t += S.reachVel * dt;
        S.acc.x += S.vx * inv * dt;
        S.acc.y += S.vy * inv * dt;
        if (S.reachVel < T.EMIT_VEL || S.tThrow > T.MAX_THROW_T) {
          this._emit(side, S);
          S.state = 'recover';              // must retract to re-arm
        }
      } else if (S.state === 'recover' && S.reachVel < T.RESET_VEL) {
        S.state = 'idle';
      }

      // ---- guard: raised into the face band AND held close ---------------
      const high = faceFound
        ? clamp((this._nose.y + T.GUARD_NOSE_LO - h.palm.y) / T.GUARD_NOSE_RANGE, 0, 1)
        : clamp((T.GUARD_Y_ZERO - h.palm.y) / (T.GUARD_Y_ZERO - T.GUARD_Y_FULL), 0, 1);
      const close = clamp((reach - T.GUARD_REACH_LO) / (T.GUARD_REACH_HI - T.GUARD_REACH_LO), 0, 1);
      S.guard = ema(S.guard, high * close, T.GUARD_RATE, dt);
      this.guard[side] = S.guard;
    }
    return this;
  }

  _emit(side, S) {
    const T = this.T;
    const thrust = Math.max(S.acc.t, 0), lat = Math.abs(S.acc.x), up = -S.acc.y;
    const kind = lat > thrust && lat > up ? 'hook'
      : up > thrust && up >= lat ? 'uppercut'
      : side === 'left' ? 'jab' : 'cross';
    const power = Math.max(T.POWER_FLOOR,
      clamp((S.peak - 1) / (T.REACH_CAP - 1), 0, 1));
    this.punches.push({ kind, side, power, t: +this._t.toFixed(3) });
    if (this.punches.length > T.PUNCH_MAX) this.punches.shift();
  }

  _missed(S, dt) {
    const T = this.T;
    S.miss++;
    S.reachVel = ema(S.reachVel, 0, T.VEL_SMOOTH, dt);
    S.vx = ema(S.vx, 0, T.PALM_SMOOTH, dt);
    S.vy = ema(S.vy, 0, T.PALM_SMOOTH, dt);
    S.guard = Math.max(0, S.guard - T.GUARD_FALL * dt);
    S.hot = 0;
    if (S.miss > T.MISS_GRACE && S.state !== 'idle') S.state = 'idle'; // drop silently
    if (S.miss > T.RESNAP_MISS) S.seen = false;   // long gone ⇒ re-snap on return
  }

  calibrate() {
    // neutral pose snapshot: sway re-centers, current span becomes rest size
    this._cx = this._nose.x;
    if (this._cy !== null) this._cy = this._nose.y;   // no face yet → keep auto-pick
    this.sway = 0; this.duck = 0;
    for (const side of SIDES) {
      const S = this._s[side];
      if (S.seen && S.lastSpan > this.T.MIN_SPAN) {
        S.baseline = S.lastSpan; S.prevReach = 1; S.reach = 1; S.reachVel = 0;
        S.state = 'idle';                   // cancel any half-thrown punch
      }
    }
  }

  debug() {
    const r = (o) => ({ left: o.left, right: o.right });
    return {
      span: r({ left: this._s.left.lastSpan, right: this._s.right.lastSpan }),
      reach: r({ left: this._s.left.reach, right: this._s.right.reach }),
      guard: { ...this.guard },
      sway: this.sway,
      duck: this.duck,
      baseline: r({ left: this._s.left.baseline, right: this._s.right.baseline }),
      state: r({ left: this._s.left.state, right: this._s.right.state }),
    };
  }
}

if (typeof window !== 'undefined') window.FistTracker = FistTracker;
