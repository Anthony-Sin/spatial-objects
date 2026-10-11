/* shared/boxing/tutorial.js — the optional 30-second "learn the basics" run.

     const tutor = new Tutorial({ fight, sim, root, onDone });
     each frame (after game.step):  tutor.update(out, nowSeconds)

   Four beats, each auto-advancing on success OR when its time box runs out,
   so the whole thing can never take longer than TOTAL seconds:
     1 punch   — land two punches on a parked PIP
     2 block   — PIP throws slow jabs; gloves up on the cued side
     3 slip    — lean / A·D as the glove comes
     4 perfect — dodge LATE → PIP reels → punch it while it's dizzy
   Requires a Fight built with { ai:false, practice:true } — the tutorial
   throws every swing itself and nobody can be KO'd. root (a DOM element) is
   optional: without it the logic runs headless for tests.
*/
export const STEPS = [
  { id: 'punch', title: 'THROW A PUNCH', how: 'Thrust a fist at the camera — or click / right-click',
    max: 6.5, need: 2, ev: 'player-hit' },
  { id: 'block', title: 'GLOVES UP', how: 'Raise your gloves by your face as it swings — or hold F',
    max: 7.5, need: 1, ev: 'player-blocked', swing: 'jab', windup: 1.15 },
  { id: 'slip', title: 'SLIP IT', how: 'Lean left or right as the glove comes — or tap A / D',
    max: 7.5, need: 1, ev: 'player-dodged', swing: 'jab', windup: 1.1 },
  { id: 'perfect', title: 'DODGE LATE, THEN PUNISH', how: 'Wait for the last moment, slip — PIP gets dizzy — PUNCH!',
    max: 8, need: 1, ev: 'flurry', swing: 'hook', windup: 1.05 },
];
export const TOTAL = 30;                        // hard cap, seconds
const NICE_T = .7;                              // "✓ NICE" beat between steps
const SWING_GAP = .9;                           // breather between scripted swings
const SPAR_GAP = 1.0;                           // where PIP stands (centre to centre)

export class Tutorial {
  constructor(opts) {
    const { fight, sim, root = null, onDone = null } = opts || {};
    this.fight = fight; this.sim = sim; this.root = root; this.onDone = onDone;
    this.i = 0; this.count = 0; this.t0 = null; this.stepT0 = 0;
    this.niceUntil = 0; this.lastSwing = -9; this.side = 'left';
    this.done = false; this.passed = [];
    if (sim) this._spar();
    if (root) this._build();
  }

  get step() { return STEPS[this.i] || null; }

  // park PIP at sparring distance, straight ahead
  _spar() {
    const P = this.sim?.player?.pos, N = this.sim?.npc;
    if (!P || !N?.pos || !N.vel) return;   // malformed sim → no-op, not a throw
    N.pos.x = P.x; N.pos.z = P.z - SPAR_GAP; N.vel.x = N.vel.z = 0;
  }

  update(out, now) {
    if (this.done || !Number.isFinite(now)) return;   // a NaN clock once poisoned
                                                    // t0 → the TOTAL failsafe died
    const st = (out?.state && out.state.npc) ? out.state : this.fight?.state;
    if (!st || !st.npc) return;                       // malformed state → skip
    if (st.phase !== 'fighting') { this._render(st, now); return; }
    if (this.t0 === null) { this.t0 = now; this.stepT0 = now; }
    const s = this.step;
    // drifted out of range (player stepped / knockback)? walk PIP back in
    const gd = typeof this.sim?.distance === 'function' ? this.sim.distance() : NaN;
    if (Number.isFinite(gd) && Math.abs(gd - SPAR_GAP) > .35
        && !['windup', 'punch'].includes(st.npc.action)) this._spar();

    if (now >= this.niceUntil && this.niceUntil) { this.niceUntil = 0; this._next(now); }
    if (!this.niceUntil && this.step) {
      for (const e of Array.isArray(out?.events) ? out.events : []) {
        const hit = s.ev === 'flurry' ? e === 'player-hit' && st.lastBlow?.flurry : e === s.ev;
        if (hit && ++this.count >= s.need) { this._pass(now); break; }
      }
      // PIP's scripted swings (alternate sides so both guards get used)
      if (!this.niceUntil && s.swing && st.npc.action === 'idle' && now - this.lastSwing > SWING_GAP + s.windup
          && this.fight?.throwPunch?.(s.swing, this.side, s.windup)) {
        this.lastSwing = now;
        this.side = this.side === 'left' ? 'right' : 'left';
      }
      // time box — never stall; and the whole run never passes TOTAL
      if (!this.niceUntil && (now - this.stepT0 >= s.max || now - this.t0 >= TOTAL)) this._next(now);
    }
    if (this.t0 !== null && now - this.t0 >= TOTAL) this._finish();
    this._render(st, now);
  }

  _pass(now) { this.passed.push(this.step.id); this.niceUntil = now + NICE_T; }

  _next(now) {
    this.i++; this.count = 0; this.stepT0 = now; this.lastSwing = now - SWING_GAP;
    if (this.i >= STEPS.length) this._finish();
  }

  _finish() {
    if (this.done) return;
    this.done = true;
    this._render(this.fight?.state, 0);
    this.onDone?.(this.passed.slice());
  }

  /* ---------- DOM (optional) ---------- */

  _build() {
    const r = this.root;
    r.innerHTML = `
      <div class="tut-head"><span class="tut-k">TUTORIAL</span><span class="tut-n"></span>
        <div class="tut-pips">${STEPS.map(() => '<i></i>').join('')}</div></div>
      <div class="tut-title"></div><div class="tut-how"></div><div class="tut-cue"></div>
      <div class="tut-time"><i></i></div>`;
    // cache every element _render touches — no per-frame querySelector
    this._els = { n: r.querySelector('.tut-n'), t: r.querySelector('.tut-title'),
      h: r.querySelector('.tut-how'), c: r.querySelector('.tut-cue'),
      w: r.querySelector('.tut-time i') };
    this._pips = [...r.querySelectorAll('.tut-pips i')];
    this._last = {};
  }

  _set(k, el, v) { if (this._last[k] !== v) { this._last[k] = v; el.textContent = v; } }

  _render(st, now) {
    if (!this.root || !st || !st.npc) return;
    this.root.classList.toggle('on', !this.done && st.phase !== 'intro');
    if (this.done) return;
    const s = this.step || STEPS[STEPS.length - 1];
    const nice = this.niceUntil > 0;
    this._set('n', this._els.n, `${Math.min(this.i + 1, STEPS.length)} / ${STEPS.length}`);
    this._set('t', this._els.t, st.phase === 'countdown' ? 'GET READY' : nice ? '✓ NICE!' : s.title);
    this._set('h', this._els.h, st.phase === 'countdown' ? '30 seconds — the basics, then you fight' : nice ? '' : s.how);
    // live cue: which guard to raise / when to go
    const tg = st.npc.telegraph;
    // cues LEAD the impact by ~human reaction time so acting on "NOW" lands
    // inside the dodge window (slip) / the perfect window (perfect)
    const left = tg ? (1 - tg.t01) * (s.windup || 1) : 9;
    let cue = '';
    if (!nice && tg && s.id === 'block') cue = `GUARD ${tg.side === 'left' ? 'RIGHT ▶' : '◀ LEFT'}`;
    else if (!nice && tg && s.id === 'slip') cue = left < .45 ? 'NOW — SLIP!' : 'wait for it…';
    else if (!nice && tg && s.id === 'perfect') cue = left < .3 ? 'NOW!!' : left < .6 ? 'not yet…' : 'wait…';
    else if (!nice && s.id === 'perfect' && st.npc.action === 'stunned') cue = 'PUNCH! PUNCH!';
    this._set('c', this._els.c, cue);
    this.root.classList.toggle('nice', nice);
    const pk = this.i * 2 + (nice ? 1 : 0);              // one signature for all pips
    if (this._last.pips !== pk) {
      this._last.pips = pk;
      this._pips.forEach((p, k) => { p.className = k < this.i || (k === this.i && nice) ? 'ok' : k === this.i ? 'cur' : ''; });
    }
    const used = this.t0 === null ? 0 : Math.min(1, (now - this.t0) / TOTAL);
    const w = Math.round((1 - used) * 1000) / 1000;
    if (this._last.w !== w) { this._last.w = w; this._els.w.style.transform = `scaleX(${w})`; }
  }
}
