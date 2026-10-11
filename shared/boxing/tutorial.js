/* shared/boxing/tutorial.js — the optional 40-second "learn the basics" run.

     const tutor = new Tutorial({ fight, sim, root, onDone });
     each frame (after game.step):  tutor.update(out, nowSeconds)

   Six beats, each auto-advancing on success OR when its time box runs out,
   so the whole thing can never take longer than TOTAL seconds:
     1 punch   — land two punches on a parked PIP
     2 block   — PIP throws slow jabs; gloves up on the cued side
     3 slip    — lean / A·D as the glove comes
     4 duck    — drop your head under the hook / hold SPACE
     5 move    — lean in to press, lean back to give ground / W·S
     6 perfect — dodge LATE → PIP reels → punch it while it's dizzy
   'duck' passes only on a real duck dodge (a slip keeps defending but won't
   pass the lesson); 'move' passes on actual footwork — the player's z
   displacement from the step-entry mark, so PIP's re-park stays off for it.
   Requires a Fight built with { ai:false, practice:true } — the tutorial
   throws every swing itself and nobody can be KO'd. root (a DOM element) is
   optional: without it the logic runs headless for tests.
*/
export const STEPS = [
  { id: 'punch', title: 'THROW A PUNCH', how: 'Thrust a fist at the camera — or click either mouse button',
    max: 6, need: 2, ev: 'player-hit' },
  { id: 'block', title: 'GLOVES UP', how: 'Raise your gloves by your face as it swings — or hold F',
    max: 7, need: 1, ev: 'player-blocked', swing: 'jab', windup: 1.15 },
  { id: 'slip', title: 'SLIP IT', how: 'Lean left or right as the glove comes — or tap A / D',
    max: 7, need: 1, ev: 'player-dodged', swing: 'jab', windup: 1.1 },
  { id: 'duck', title: 'DUCK UNDER', how: 'Drop your head under the hook — or hold SPACE',
    max: 7, need: 1, ev: 'player-dodged', dodge: 'duck', swing: 'hook', windup: 1.05 },
  { id: 'move', title: 'MOVE WITH YOUR HEAD', how: 'Lean in to press, lean back to give ground — or W / S',
    max: 5.5, need: .28, move: true },
  { id: 'perfect', title: 'DODGE LATE, THEN PUNISH', how: 'Slip at the last moment — PIP reels — PUNCH!',
    max: 7, need: 1, ev: 'flurry', swing: 'hook', windup: 1.05 },
];
export const TOTAL = 40;                        // hard cap, seconds
const NICE_T = .7;                              // "✓ NICE" beat between steps
const SWING_GAP = .9;                           // breather between scripted swings
const SPAR_GAP = 1.1;                           // fallback gap — the sim's own
                                                // punchRange wins when readable

const sget = (o, k) => { try { return o?.[k] } catch { return undefined; } };

export class Tutorial {
  constructor(opts) {
    /* hostile opts (Proxy / throwing getters) once killed construction —
       every field read sits behind a safe getter */
    const fight = sget(opts, 'fight'), sim = sget(opts, 'sim'),
      root = sget(opts, 'root') ?? null, onDone = sget(opts, 'onDone') ?? null;
    this.fight = fight; this.sim = sim; this.root = root; this.onDone = onDone;
    this.i = 0; this.count = 0; this.t0 = null; this.stepT0 = 0;
    this.niceUntil = 0; this.lastSwing = -9; this.side = 'left';
    this._markZ = null;                         // player z at move-step entry
    this.done = false; this.passed = [];
    if (sim) this._spar();
    if (root) { try { this._build(); } catch { this.root = null; this._els = null; this._pips = []; } }
  }

  get step() { try { return STEPS[this.i] || null; } catch { return null; } }

  // sparring distance follows the rival's reach — a big frame parks farther out
  _gap() {
    const g = sget(sget(this.sim, 't'), 'punchRange');
    return Number.isFinite(g) && g > 0 ? g : SPAR_GAP;
  }

  // park PIP at sparring distance, straight ahead
  _spar() {
    try {
      const P = this.sim?.player?.pos, N = this.sim?.npc;
      if (!P || !N?.pos || !N.vel) return;   // malformed sim → no-op, not a throw
      N.pos.x = P.x; N.pos.z = P.z - this._gap(); N.vel.x = N.vel.z = 0;
    } catch { /* hostile sim — parking is best-effort */ }
  }

  update(out, now) {
    if (this.done || !Number.isFinite(now)) return;   // a NaN clock once poisoned
                                                    // t0 → the TOTAL failsafe died
    try { this._update(out, now); } catch { /* hostile out/state → skip frame */ }
  }

  _update(out, now) {
    const st = (out?.state && out.state.npc) ? out.state : this.fight?.state;
    if (!st || !st.npc) return;                       // malformed state → skip
    if (st.phase !== 'fighting') { this._render(st, now); return; }
    if (this.t0 === null) { this.t0 = now; this.stepT0 = now; }
    const s = this.step;
    /* a clock that jumps BACKWARDS (wall-clock adjust / restarted timer)
       once made every time box unreachable and stalled the run — elapsed
       values clamp at 0 so a regression delays, never wedges */
    const age = Math.max(0, now - this.t0);
    // drifted out of range (player stepped / knockback)? walk PIP back in —
    // except on 'move', where closing the gap IS the lesson
    const gd = typeof this.sim?.distance === 'function' ? this.sim.distance() : NaN;
    if (Number.isFinite(gd) && Math.abs(gd - this._gap()) > .35 && !s?.move
        && !['windup', 'punch'].includes(st.npc.action)) this._spar();

    if (now >= this.niceUntil && this.niceUntil) { this.niceUntil = 0; this._next(now); }
    if (!this.niceUntil && this.step) {
      for (const e of Array.isArray(out?.events) ? out.events : []) {
        const hit = s.ev === 'flurry'
          ? e === 'player-hit' && st.lastBlow?.flurry
          : s.dodge ? e === 'player-dodged' && st.lastBlow?.dodge === s.dodge
          : e === s.ev;
        if (hit && ++this.count >= s.need) { this._pass(now); break; }
      }
      /* 'move' has no event — real footwork is the tell: pass once the player
         has stepped far enough off the step-entry mark in either direction */
      if (!this.niceUntil && s.move) {
        const z = sget(sget(sget(this.sim, 'player'), 'pos'), 'z');
        if (this._markZ == null) this._markZ = z;
        if (Number.isFinite(z) && Number.isFinite(this._markZ)
            && Math.abs(z - this._markZ) >= s.need) this._pass(now);
      }
      // PIP's scripted swings (alternate sides so both guards get used)
      if (!this.niceUntil && s.swing && st.npc.action === 'idle' && now - this.lastSwing > SWING_GAP + s.windup
          && this.fight?.throwPunch?.(s.swing, this.side, s.windup)) {
        this.lastSwing = now;
        this.side = this.side === 'left' ? 'right' : 'left';
      }
      // time box — never stall; and the whole run never passes TOTAL
      const stepAge = Math.max(0, now - this.stepT0);
      if (!this.niceUntil && (stepAge >= s.max || age >= TOTAL)) this._next(now);
    }
    if (this.t0 !== null && age >= TOTAL) this._finish();
    this._render(st, now);
  }

  _pass(now) { this.passed.push(this.step.id); this.niceUntil = now + NICE_T; }

  _next(now) {
    this.i++; this.count = 0; this.stepT0 = now; this.lastSwing = now - SWING_GAP;
    this._markZ = null;
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
    this._pips = [...(r.querySelectorAll('.tut-pips i') || [])];
    this._last = {};
  }

  _set(k, el, v) {   // el may be null on a stub/partial root — never throw
    if (el && this._last[k] !== v) { this._last[k] = v; el.textContent = v; }
  }

  _render(st, now) {
    if (!this.root || !st || !st.npc) return;
    this.root.classList.toggle('on', !this.done && st.phase !== 'intro');
    if (this.done) return;
    // STEPS is exported and mutable — a caller emptying the array left
    // STEPS[-1] === undefined and s.title threw on the render path
    const s = this.step || STEPS[STEPS.length - 1] || { title: '', how: '' };
    const nice = this.niceUntil > 0;
    this._set('n', this._els.n, `${Math.min(this.i + 1, STEPS.length)} / ${STEPS.length}`);
    this._set('t', this._els.t, st.phase === 'countdown' ? 'GET READY' : nice ? '✓ NICE!' : s.title);
    this._set('h', this._els.h, st.phase === 'countdown' ? `${TOTAL} seconds — the basics, then you fight` : nice ? '' : s.how);
    // live cue: which guard to raise / when to go
    const tg = st.npc.telegraph;
    // cues LEAD the impact by ~human reaction time so acting on "NOW" lands
    // inside the dodge window (slip) / the perfect window (perfect)
    const left = tg ? (1 - tg.t01) * (s.windup || 1) : 9;
    let cue = '';
    if (!nice && tg && s.id === 'block') cue = `GUARD ${tg.side === 'left' ? 'RIGHT ▶' : '◀ LEFT'}`;
    else if (!nice && tg && s.id === 'slip') cue = left < .45 ? 'NOW — SLIP!' : 'wait for it…';
    else if (!nice && tg && s.id === 'duck') cue = left < .45 ? 'NOW — DUCK!' : 'wait for it…';
    else if (!nice && s.move) {
      const z = sget(sget(sget(this.sim, 'player'), 'pos'), 'z');
      const u = Number.isFinite(z) && Number.isFinite(this._markZ) && s.need > 0
        ? Math.abs(z - this._markZ) / s.need : 0;
      cue = u >= .15 ? `THAT'S THE MOVE — ${Math.min(99, Math.round(u * 100))}%` : 'STEP IN OR STEP BACK';
    }
    else if (!nice && tg && s.id === 'perfect') cue = left < .3 ? 'NOW!!' : left < .6 ? 'not yet…' : 'wait…';
    else if (!nice && s.id === 'perfect' && st.npc.action === 'stunned') cue = 'PUNCH! PUNCH!';
    this._set('c', this._els.c, cue);
    this.root.classList.toggle('nice', nice);
    const pk = this.i * 2 + (nice ? 1 : 0);              // one signature for all pips
    if (this._last.pips !== pk) {
      this._last.pips = pk;
      this._pips.forEach((p, k) => { p.className = k < this.i || (k === this.i && nice) ? 'ok' : k === this.i ? 'cur' : ''; });
    }
    const used = this.t0 === null ? 0 : Math.min(1, Math.max(0, now - this.t0) / TOTAL);
    const w = Math.round((1 - used) * 1000) / 1000;
    if (this._els.w && this._last.w !== w) { this._last.w = w; this._els.w.style.transform = `scaleX(${w})`; }
  }
}
