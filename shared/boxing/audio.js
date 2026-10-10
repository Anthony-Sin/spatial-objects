/* shared/boxing/audio.js — fully procedural Web Audio SFX for the boxing game.
   No audio files, no network, no deps — every sound is oscillators + a
   shared noise buffer run through filters. Cute-arcade / Punch-Out!! flavor:
   slightly exaggerated FM-ish dings, snappy whooshes, chunky thwacks.

     const audio = new BoxingAudio();
     window.addEventListener('pointerdown', () => audio.unlock(), { once:true });
     each frame after fight.step():
       for (const e of fight.state.events) audio.handleEvent(e, fight.state);
       audio.update(dt, fight.state);   // crowd bed + gassed breathing

   NODE-SAFE: nothing touches window/AudioContext at module top level; the
   context is created lazily inside unlock() (first user gesture — autoplay
   policy). unlock(ctx) accepts an injected context for tests/headless use.

   EVENT_SFX maps every fight.js event string → a named synth preset, kept
   pure/exported so unit tests can assert coverage without a DOM. */

export const EVENT_SFX = {
  'round-start': 'bell',
  'player-punch': 'whoosh',     // airier if lastBlow.result === 'miss'
  'player-miss': 'whoosh',
  'npc-punch': 'whoosh',
  'player-hit': 'thwack',       // player glove connects on PIP
  'npc-hit': 'thwack',          // same blow — layered a hair late for chunk
  'npc-blocked': 'thud',        // player punch eats PIP's gloves
  'player-blocked': 'thud',     // guard absorbs PIP's swing
  'player-dodged': 'dodge',     // clean head-movement whoosh
  'player-hit-taken': 'hurt',   // heavy low thud + little "oof" chirp
  'ko': 'ko',                   // buzzer + slow-mo pitch drop + crowd swell
  'win': 'win',
  'lose': 'lose',
};

// punch kind → whoosh character: jab is snappy/thin, hook/uppercut lower+heavier
const WHOOSH = {
  jab:      { f0: 1400, f1: 480, dur: .13, peak: .34 },
  cross:    { f0: 1100, f1: 380, dur: .15, peak: .38 },
  hook:     { f0:  750, f1: 260, dur: .19, peak: .44 },
  uppercut: { f0:  650, f1: 210, dur: .22, peak: .48 },
  upper:    { f0:  650, f1: 210, dur: .22, peak: .48 },   // npc naming
};
const WIN_ARP = [523.25, 659.25, 783.99, 1046.5];          // C5 E5 G5 C6
const LOSE_ARP = [392, 311.13, 261.63, 196];               // G4 Eb4 C4 G3

export class BoxingAudio {
  constructor() {
    this.ctx = null;          // created by unlock() only
    this.master = null;
    this.volume = .8;
    this._muted = false;
    this._buf = null;         // shared 1s white-noise buffer
    this._crowd = null;       // {src, filter, gain, lfo} murmur bed
    this._crowdLevel = 0;     // swell target, decays in update()
    this._breathT = 0;        // timer for the gassed-stamina panting cue
  }

  get muted() { return this._muted; }
  set muted(m) {
    this._muted = !!m;
    if (this.ctx) this._set(this.master.gain, this._muted ? 0 : this.volume);
    if (this._muted) this._crowdOff();
  }

  setVolume(v) {
    this.volume = Math.min(1, Math.max(0, +v || 0));
    if (this.ctx && !this._muted) this._set(this.master.gain, this.volume);
  }

  unlock(ac) {   // call from a user gesture; ac injectable for tests
    if (this.ctx) return this.ctx;
    const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!ac && !AC) return null;                 // headless: stay silent
    const ctx = this.ctx = ac || new AC();
    ctx.resume?.();
    const g = this.master = ctx.createGain();
    g.gain.value = this._muted ? 0 : this.volume;
    const bus = ctx.createDynamicsCompressor?.(); // soft-clip safety on hits
    if (bus) { g.connect(bus); bus.connect(ctx.destination); }
    else g.connect(ctx.destination);
    const n = ctx.sampleRate | 0;
    const buf = this._buf = ctx.createBuffer(1, n, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    return ctx;
  }

  /* ---------- event plumbing ---------- */

  handleEvent(evt, state) {
    const name = typeof evt === 'string' ? evt : evt?.type;
    const sfx = EVENT_SFX[name];
    if (!sfx) return false;
    const b = state?.lastBlow || {};
    switch (name) {
      case 'player-punch':
        return this.play('whoosh', { kind: b.kind || 'cross', miss: b.result === 'miss' });
      case 'npc-punch':
        return this.play('whoosh', { kind: b.kind || 'hook' });
      case 'player-miss':
        return this.play('whoosh', { kind: b.kind || 'jab', miss: true });
      case 'player-hit':
        return this.play('thwack', { kind: b.kind, dmg: b.dmg });
      case 'npc-hit':   // same blow as player-hit — late layer makes it chunky
        return this.play('thwack', { kind: b.kind, dmg: b.dmg, delay: .012, peak: .6 });
      case 'npc-blocked': case 'player-blocked':
        return this.play('thud', { dmg: b.dmg });
      case 'player-hit-taken':
        this._crowdLevel = Math.min(1, this._crowdLevel + .4);
        return this.play('hurt', { dmg: b.dmg });
      case 'player-dodged':
        return this.play('dodge');
      case 'round-start':
        return this.play('bell', { times: 3 });
      case 'ko':
        this._crowdLevel = 1;
        return this.play('ko');
      case 'win': case 'lose':
        return this.play(name);
    }
    return false;
  }

  play(name, opts = {}) {   // → true if anything was scheduled
    if (!this.ctx || this._muted) return false;
    const fn = {
      bell: this._bell, whoosh: this._whoosh, thwack: this._thwack,
      thud: this._thud, dodge: this._dodge, hurt: this._hurt,
      ko: this._ko, win: this._arp, lose: this._arp,
    }[name];
    if (!fn) return false;
    fn.call(this, { delay: 0, ...opts, _lose: name === 'lose' });
    return true;
  }

  /* ---------- per-frame beds ---------- */

  update(dt, fight) {
    if (!this.ctx || this._muted) return;
    const fighting = fight?.phase === 'fighting';
    if (fighting && !this._crowd) this._crowdOn();
    if (!fighting && this._crowd) this._crowdOff();
    this._crowdLevel = Math.max(0, this._crowdLevel - .45 * dt);   // swell decays
    if (this._crowd) {  // subtle murmur — cute arcade, not stadium
      const g = .05 + .3 * this._crowdLevel;
      this._crowd.gain.gain.setTargetAtTime(g, this._now(), .12);
    }
    // gassed fighter → audible heavy breathing under ~30% stamina
    if (fighting && fight?.player && fight.player.stamina < .3) {
      this._breathT -= dt;
      if (this._breathT <= 0) {
        const s = fight.player.stamina;
        this._breathT = .45 + .6 * (s / .3);       // pant faster when emptier
        this._noise({ f0: 400, f1: 900, dur: .16, peak: .05, q: 1.2, type: 'bandpass' });
      }
    }
  }

  /* ---------- sfx presets ---------- */

  _bell(o) {   // FM ding ×3 — "round start" casino-boxing bell
    for (let i = 0; i < (o.times || 1); i++) this._fm({
      f: 1568, ratio: 1.4, idx: 2.5, dur: .9, peak: .3, delay: o.delay + i * .42,
    });
  }

  _whoosh(o) {   // filtered noise burst; kind pitches it, miss = airier
    const w = WHOOSH[o.kind] || WHOOSH.cross;
    const p = o.miss ? .5 : 1;
    this._noise({
      f0: w.f0 * (o.miss ? 1.3 : 1), f1: w.f1, q: 1.1,
      dur: w.dur * (o.miss ? 1.15 : 1), peak: w.peak * p, delay: o.delay,
    });
  }

  _thwack(o) {   // landed punch: low sine thud + noise snap; heavy kinds hit lower
    const heavy = { hook: .5, uppercut: 1, upper: 1 }[o.kind] || 0;
    const p = (o.peak ?? 1) * (1 + .12 * Math.min(1, (o.dmg || 10) / 16));
    this._tone({ type: 'sine', f0: 190 - 40 * heavy, f1: 55, dur: .13 + .06 * heavy, peak: .5 * p, delay: o.delay });
    this._noise({ f0: 2400, f1: 900, dur: .05, peak: .4 * p, delay: o.delay });
    if (heavy > 0) this._tone({ type: 'sine', f0: 95, f1: 40, dur: .18, peak: .3 * p, delay: o.delay });
  }

  _thud(o) {   // blocked: dull glove-on-glove thump, no snap
    this._tone({ type: 'sine', f0: 150, f1: 65, dur: .09, peak: .32, delay: o.delay });
    this._noise({ f0: 500, f1: 220, dur: .06, peak: .18, type: 'lowpass', delay: o.delay });
  }

  _dodge(o) {   // airy slip whoosh — faster, thinner, brighter tail
    this._noise({ f0: 900, f1: 2600, dur: .22, peak: .26, q: 2, type: 'bandpass', delay: o.delay });
  }

  _hurt(o) {   // player eats it: heavy low thud + a little FM "oof" bark
    const p = 1 + .3 * Math.min(1, (o.dmg || 10) / 17);
    this._tone({ type: 'sine', f0: 110, f1: 45, dur: .22, peak: .5 * p, delay: o.delay });
    this._noise({ f0: 700, f1: 200, dur: .1, peak: .3, type: 'lowpass', delay: o.delay });
    this._fm({ f: 220, f1: 130, ratio: 2.4, idx: 3, dur: .12, peak: .16, delay: o.delay + .02 });
  }

  _ko(o) {   // buzzer + slow-mo pitch drop; crowd swell rides _crowdLevel
    this._tone({ type: 'square', f0: 155, f1: 120, dur: .55, peak: .14, delay: o.delay });
    this._tone({ type: 'square', f0: 78, f1: 60, dur: .55, peak: .12, delay: o.delay });
    this._noise({ f0: 300, f1: 140, dur: .55, peak: .1, type: 'lowpass', delay: o.delay });
    this._fm({ f: 880, f1: 140, ratio: 1.02, idx: 1.6, dur: 1.1, peak: .22, delay: o.delay + .55 });
  }

  _arp(o) {   // win/lose jingles — bouncy 4-note FM arps (lose slides the last)
    const notes = o._lose ? LOSE_ARP : WIN_ARP;
    notes.forEach((f, i) => this._fm({
      f, f1: o._lose && i === notes.length - 1 ? f * .7 : f,
      ratio: o._lose ? 1 : 2, idx: o._lose ? 1.4 : 2.2,
      dur: o._lose ? .5 : .32, peak: .2, delay: o.delay + i * (o._lose ? .24 : .13),
    }));
  }

  /* ---------- crowd bed ---------- */

  _crowdOn() {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this._buf; src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass'; f.frequency.value = 420; f.Q.value = .8;
    const g = ctx.createGain(); g.gain.value = .0001;
    const lfo = ctx.createOscillator(); lfo.frequency.value = .17;  // slow murmur wobble
    const lg = ctx.createGain(); lg.gain.value = 90;
    lfo.connect(lg); lg.connect(f.frequency);
    src.connect(f); f.connect(g); g.connect(this.master);
    src.start(); lfo.start();
    g.gain.setTargetAtTime?.(.05, this._now(), .3);
    this._crowd = { src, gain: g, lfo };
  }

  _crowdOff() {
    const c = this._crowd; if (!c) return;
    this._crowd = null;
    try { c.src.stop(); c.lfo.stop(); } catch { /* already stopped */ }
  }

  /* ---------- synth helpers ---------- */

  _now() { return this.ctx.currentTime; }
  _set(p, v, t) { p.setValueAtTime ? p.setValueAtTime(v, t ?? this._now()) : p.value = v; }

  _env(o) {   // percussive gain: fast attack, exponential decay to silence
    const g = this.ctx.createGain(), t = this._now() + (o.delay || 0), a = o.a ?? .006;
    this._set(g.gain, .0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(.0001, o.peak), t + a);
    g.gain.exponentialRampToValueAtTime(.0001, t + Math.max(a + .01, o.dur));
    g.connect(this.master);
    return { g, t };
  }

  _tone(o) {   // plain oscillator with an optional pitch drop — thuds, buzzers
    const ctx = this.ctx, { g, t } = this._env(o);
    const osc = ctx.createOscillator();
    osc.type = o.type || 'sine';
    osc.frequency.setValueAtTime(Math.max(1, o.f0), t);
    if (o.f1 && o.f1 !== o.f0)
      osc.frequency.exponentialRampToValueAtTime(Math.max(1, o.f1), t + o.dur);
    osc.connect(g);
    osc.start(t); osc.stop(t + o.dur + .05);
  }

  _fm(o) {   // 2-op FM "bell/pluck" voice — the cute-arcade flavor
    const ctx = this.ctx, { g, t } = this._env(o);
    const car = ctx.createOscillator(), mod = ctx.createOscillator(), mg = ctx.createGain();
    car.frequency.setValueAtTime(o.f, t);
    if (o.f1 && o.f1 !== o.f)
      car.frequency.exponentialRampToValueAtTime(Math.max(1, o.f1), t + o.dur);
    mod.frequency.setValueAtTime(o.f * (o.ratio ?? 1.4), t);
    mg.gain.setValueAtTime(o.f * (o.idx ?? 2), t);
    mg.gain.exponentialRampToValueAtTime(1, t + o.dur);   // brightness decays
    mod.connect(mg); mg.connect(car.frequency);
    car.connect(g);
    mod.start(t); car.start(t);
    mod.stop(t + o.dur + .05); car.stop(t + o.dur + .05);
  }

  _noise(o) {   // filtered noise burst — whooshes, snaps, breaths
    const ctx = this.ctx, { g, t } = this._env(o);
    const src = ctx.createBufferSource();
    src.buffer = this._buf; src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = o.type || 'bandpass';
    f.frequency.setValueAtTime(Math.max(20, o.f0), t);
    if (o.f1 && o.f1 !== o.f0)
      f.frequency.exponentialRampToValueAtTime(Math.max(20, o.f1), t + o.dur);
    if (o.q != null) f.Q.setValueAtTime(o.q, t);
    src.connect(f); f.connect(g);
    src.start(t); src.stop(t + o.dur + .05);
  }
}
