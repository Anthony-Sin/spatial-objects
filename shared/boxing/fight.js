/* shared/boxing/fight.js — fight brain + state machine. Pure JS, no THREE/DOM —
   runs in plain node so tests can drive it with scripted inputs.

     const f = new Fight({ seed: 7 });
     f.step(dt, { punches, guard, sway, duck, dodge, distance });   // every frame
     f.state.phase / f.state.events / f.npcDir()

   inputs:
     punches  [{kind:'jab'|'cross'|'hook'|'uppercut', side, power:0..1}] — drained
     guard    {left:0..1, right:0..1}
     sway     -1..1 head lean; a FRESH lean past dodgeT starts a slip
     duck     0..1 head drop; a fresh duck past dodgeT starts a duck
     dodge    -1|0|1 explicit slip trigger (keyboard)
     distance world-units gap between fighters (from RingSim)

   DODGING is a move, not a pose: a slip/duck grants dodgeWin of i-frames,
   then a dodgeCd reset (spam = exposed). PIP aims at a lean/duck you are
   already HOLDING when it winds up, so you have to move on the telegraph.
   Starting the dodge within perfectWin of impact = PERFECT: PIP reels
   ('stunned') and every glove you land shaves the stun — a free flurry.
   Ducking into an uppercut eats duckUpperMul damage. A dodged swing
   leaves PIP 'whiff' (off-balance, open). Landed swings may chain combos.

   NPC personality: PIP is a showboat. Loop = circle for an angle → press in →
   telegraphed windup → swing → recover, with taunts when it's feeling cocky,
   blocks when rattled, retreats when hurt, and it gets faster + craftier as
   its hp drops (rage).

   Events are plain strings from the contract vocabulary. Resolution details
   for juice (damage numbers, miss reasons, swing side) ride on state.lastBlow:
     {who:'player'|'npc', kind, side?, dmg?, result:'hit'|'miss'|'blocked'|'dodged'|'whiff', reason?}

   Blocking is MIRRORED: npc telegraph.side names the NPC's glove, which sits
   on the player's opposite screen side — a 'left' telegraph is blocked by
   guard.right (and dodged by any committed sway).

   Stamina is a real loop: regen stalls while punching/recovering and briefly
   after being tagged. Below TUNING.gassedT a fighter is 'gassed' (exposed on
   player/npc — weaker + slower punches, sluggish guard); gassed PIP backs
   off to breathe. All feel knobs live in TUNING.
*/
export const TUNING = {
  introT: 11.0,         // give the player time to find the camera and perform signs
  downT: 2.4,           // a KO'd fighter stays down this long → win/lose
  rounds: 3,            // judges' decision after this many rounds
  roundHeal: .12,       // fraction of maxHp restored between rounds

  reach: 1.35,          // forgiving contact plane for a planted first-person boxer
  reachPow: .2,         // power 0..1 stretches reach by up to this fraction
  attackAt: 1.0,        // npc only starts a windup inside this gap
  npcReach: 1.35,       // a committed npc swing still connects out to here
  guardT: .6,           // guard >= this on the matching side = block
  dodgeT: .6,           // |sway| >= this at impact = clean dodge
  blockMul: .5,         // blocked npc hits deal this fraction of damage

  dmg:      { jab: 7, cross: 11, hook: 13, uppercut: 16 },  // player base damage
  powFloor: .55,        // dmg scale = powFloor + (1-powFloor)*power
  npcDmg:   { jab: 6, hook: 12, upper: 17 },                // npc damage by kind
  windup:   { jab: .44, hook: .56, upper: .68 },             // telegraph seconds —
                                                          // readable anticipation;
                                                          // the SWING stays .22 so
                                                          // releases still feel fast
  punchDur: .26,        // npc swing length — long enough to SEE the glove come in
  hitAt: .5,            // impact lands this far (t01) through the swing

  dodgeWin: .5,         // a committed slip/duck keeps you out of the way this long
  dodgeCd: .22,         // then a short reset before the next one — spam = exposed
  perfectWin: .24,      // dodge started within this of impact = PERFECT
  perfectStun: 1.4,     // PIP reels this long after a perfect dodge — free flurry
  stunHitCost: .17,     // each flurry hit shaves this off the remaining stun
  duckUpperMul: 1.35,   // ducking INTO an uppercut eats extra damage
  comboChance: .4,      // chance a landed/blocked swing chains another
  comboRage: .35,       // extra chain chance at full rage
  comboWindup: .32,     // follow-up telegraph — shorter, the real dodge test
  comboMax: 3,          // longest chain (swings) PIP will throw

  stamCost: { jab: .10, cross: .16, hook: .18, uppercut: .22 },
  stamRegen: .28,       // player stamina per second
  exhaustMul: .35,      // an exhausted whiff still burns cost*this
  npcCost: .2,          // npc stamina per swing (follow-ups .6×) — combos genuinely drain it
  npcRegen: .15,        // slow enough that burst fatigue is reachable, fast enough
                        // that PIP isn't gassed (and passive) for the whole fight

  gassedT: .3,          // below this stamina a fighter is 'gassed' (state flag)
  gassedHyst: .15,      // stay gassed until stamina climbs back past gassedT+this
  gasPower: .5,         // gassed player punches land at this power fraction
  gasRecover: 1.6,      // gassed player punches stretch the punch/recover window
  gasGuard: .4,         // effective guard is capped here while gassed
  gasWindup: 1.4,       // a gassed npc telegraphs slower (edge case)
  regenBusy: .3,        // regen multiplier while punching / mid-swing / staggered
  regenHurt: .3,        // regen multiplier in the hurtRegenT window after a hit
  hurtRegenT: .6,       // seconds after taking a hit that regen stays slow

  hurtT: .4,            // player flinch time after eating a hit
  npcHurtT: .32,        // npc stagger — also its i-frames (no juggling)
  recoverT: .3,         // npc idle after a landed swing
  whiffT: .62,          // a dodged/whiffed swing leaves PIP open — counter window
  blockT: .7,
  idleMin: .1, idleVar: .18,
  circleMin: .3, circleVar: .4,
  retreatMin: .45, retreatVar: .35,
  pressMax: 1.7,        // give up pressing if it can't close the gap
  celebrateT: .9,       // taunt length — PIP is punishable while showboating
  celebrateCd: 4,       // min seconds between taunts

  rageSpeed: .35,       // windup/decision haste as npc hp → 0
  slipBase: .04,        // npc slip chance vs punches while circling/retreating
  slipRage: .3,         // extra slip chance at full rage
  retreatOnHurt: .12,   // stay in trading range more often
  comboWindow: 1.8,    // consecutive clean hits build a score chain
  counterWindow: 1.0,  // a block or slip opens a short reply window
  counterDamage: 1.35,
  tiltDecay: .7,        // tilt (recent player hits) fades per second
  score: { hitMul: 5, block: 15, dodge: 30, perfect: 80, ko: 500, decision: 300 },
};

// deterministic PRNG — no Math.random anywhere in this file
const mulberry32 = (s) => () => {
  s |= 0; s = s + 0x6D2B79F5 | 0;
  let t = Math.imul(s ^ s >>> 15, 1 | s);
  t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
  return ((t ^ t >>> 14) >>> 0) / 4294967296;
};

// garbage-in guards — trackers can emit NaN/undefined on lost frames
const num = (v, d = 0) => Number.isFinite(+v) ? +v : d;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export class Fight {
  constructor(opts = {}) {
    this.opts = { playerHp: 100, npcHp: 100, npcName: 'PIP', roundLen: 90, seed: 1, ...opts };
    this.state = {
      phase: 'intro', round: 0, timeLeft: this.opts.roundLen,
      player: { hp: 0, maxHp: 0, stamina: 1, score: 0, combo: 0, bestCombo: 0,
        counterT: 0, status: 'idle', hurtT: 0, gassed: false,
        dodge: { dir: null, t: 9, cd: 0 }, perfects: 0 },   // dir: 'left'|'right'|'duck'|null
      npc: { hp: 0, maxHp: 0, stamina: 1, name: '', action: 'idle', actionT: 0, telegraph: null, gassed: false },
      events: [],       // strings, cleared at the top of every step
      lastBlow: null,   // resolution details for the most recent punch
    };
    this.reset();
  }

  reset() {
    const o = this.opts, s = this.state;
    this._rng = mulberry32((o.seed | 0) || 1);
    this._phaseT = 0;                 // generic timer for intro/down phases
    this._actFor = .35;               // duration of the current npc action
    this._windupFor = 0;
    this._impacted = true;
    this._landed = false;
    this._pk = { kind: 'jab', side: 'left' };  // pending swing
    this._punchT = 0;                 // player 'punching' status timer
    this._regenSlowT = 0;             // post-hit window where player regen stays slow
    this._tilt = 0;                   // recent player hits — rattles PIP
    this._celebrateCd = 0;
    this._prevSway = 0; this._prevDuck = 0;   // dodge edge detection
    this._aim = 0;                    // what PIP aimed at: -1|1 held lean, 'duck', 0
    this._chain = 0;                  // swings thrown in the current combo
    this._swing = null;               // how the live swing resolved: hit|blocked|dodged|perfect|whiff
    s.phase = 'intro'; s.round = 0; s.timeLeft = o.roundLen;
    s.events.length = 0; s.lastBlow = null;
    this._comboT = 0;
    Object.assign(s.player, { hp: o.playerHp, maxHp: o.playerHp, stamina: 1, score: 0,
      combo: 0, bestCombo: 0, counterT: 0, status: 'idle', hurtT: 0, gassed: false,
      dodge: { dir: null, t: 9, cd: 0 }, perfects: 0 });
    Object.assign(s.npc, { hp: o.npcHp, maxHp: o.npcHp, stamina: 1, name: o.npcName, action: 'idle', actionT: 0, telegraph: null, gassed: false });
  }

  step(dt, inputs = {}) {
    const s = this.state, p = s.player, T = TUNING;
    dt = Math.min(Math.max(+dt || 0, 0), .1);
    s.events.length = 0; s.lastBlow = null;
    const inp = this._inp || (this._inp = {   // persistent — same fields re-set each step
      punches: [], guard: { left: 0, right: 0 }, sway: 0, duck: 0, dodge: 0, distance: Infinity });
    if (Array.isArray(inputs.punches)) inp.punches = inputs.punches;
    else inp.punches.length = 0;
    inp.guard.left = clamp(num(inputs.guard?.left, 0), 0, 1);
    inp.guard.right = clamp(num(inputs.guard?.right, 0), 0, 1);
    inp.sway = clamp(num(inputs.sway, 0), -1, 1);
    inp.duck = clamp(num(inputs.duck, 0), 0, 1);
    inp.dodge = Math.sign(num(inputs.dodge, 0));
    inp.distance = Number.isFinite(+inputs.distance) ? Math.max(0, +inputs.distance) : Infinity;

    // dodge move clock: active window → cooldown → ready
    const dg = p.dodge;
    dg.t += dt;
    if (dg.dir && dg.t >= T.dodgeWin) { dg.dir = null; dg.cd = T.dodgeCd; }
    else if (!dg.dir && dg.cd > 0) dg.cd = Math.max(0, dg.cd - dt);
    if (s.phase === 'fighting') {
      // a FRESH lean / duck past dodgeT (or a key) commits a dodge
      const swEdge = Math.abs(inp.sway) >= T.dodgeT && Math.abs(this._prevSway) < T.dodgeT;
      const dkEdge = inp.duck >= T.dodgeT && this._prevDuck < T.dodgeT;
      if (inp.dodge) this._startDodge(inp.dodge < 0 ? 'left' : 'right');
      else if (dkEdge) this._startDodge('duck');
      else if (swEdge) this._startDodge(inp.sway < 0 ? 'left' : 'right');
    }
    this._prevSway = inp.sway; this._prevDuck = inp.duck;

    // meters and flinch timers tick in every phase. Regen is REAL: it crawls
    // while you're punching/recovering and for hurtRegenT after taking a hit,
    // and PIP's regen stalls mid-swing so combos genuinely gas it out.
    const regenMul = Math.min(this._punchT > 0 ? T.regenBusy : 1,
      this._regenSlowT > 0 ? T.regenHurt : 1);
    p.stamina = Math.min(1, p.stamina + T.stamRegen * regenMul * dt);
    const a = s.npc.action;
    const nBusy = a === 'windup' || a === 'punch' || a === 'hurt';
    s.npc.stamina = Math.min(1, s.npc.stamina + T.npcRegen * (nBusy ? T.regenBusy : 1) * dt);
    if (this._regenSlowT > 0) this._regenSlowT = Math.max(0, this._regenSlowT - dt);
    if (p.hurtT > 0) p.hurtT = Math.max(0, p.hurtT - dt);
    if (this._punchT > 0) this._punchT = Math.max(0, this._punchT - dt);
    if (this._celebrateCd > 0) this._celebrateCd -= dt;
    if (p.counterT > 0) p.counterT = Math.max(0, p.counterT - dt);
    if (this._comboT > 0) this._comboT = Math.max(0, this._comboT - dt);
    if (this._comboT === 0) p.combo = 0;
    this._tilt = Math.max(0, this._tilt - T.tiltDecay * dt);

    switch (s.phase) {
      case 'intro':
        this._phaseT += dt;
        if (this._phaseT >= T.introT) this._startRound();
        break;
      case 'fighting':
        // counters resolve first — a glove in PIP's face cancels its windup
        for (const pn of inp.punches) {
          if (s.phase !== 'fighting') break;
          if (pn && typeof pn === 'object') this._playerPunch(pn, inp);
        }
        if (s.phase !== 'fighting') break;
        this._npc(dt, inp);
        if (s.phase !== 'fighting') break;
        s.timeLeft = Math.max(0, s.timeLeft - dt);
        if (s.timeLeft <= 0) this._roundEnd();
        break;
      case 'playerdown': case 'npcdown':
        this._phaseT += dt;
        if (this._phaseT >= T.downT) this._verdict();
        break;
      // 'win' / 'lose' are terminal — nothing else ticks
    }

    p.status = p.hp <= 0 ? 'down'
      : p.hurtT > 0 ? 'hurt'
      : p.dodge.dir ? 'dodging'
      : this._punchT > 0 ? 'punching'
      : Math.max(inp.guard.left, inp.guard.right) >= T.guardT ? 'blocking'
      : 'idle';
    // fatigue flags with hysteresis — enter below gassedT, exit above
    // gassedT+gassedHyst, so the HUD lamp and PIP's disengage don't flicker
    p.gassed = p.gassed ? p.stamina < T.gassedT + T.gassedHyst : p.stamina < T.gassedT;
    s.npc.gassed = s.npc.gassed ? s.npc.stamina < T.gassedT + T.gassedHyst : s.npc.stamina < T.gassedT;
    return s;
  }

  npcDir() {  // drives RingSim — feet planted while swinging, blocking, taunting
    const a = this.state.npc.action;
    return a === 'press' ? 'press' : a === 'circle' ? 'circle' : a === 'retreat' ? 'retreat' : 'hold';
  }

  startNow() {
    if (this.state.phase === 'intro') this._startRound();
  }

  /* ---------- internals ---------- */

  _emit(e) { this.state.events.push(e); }
  _startDodge(dir) {   // ignored mid-dodge or during the reset — no spamming
    const dg = this.state.player.dodge;
    if (dg.dir || dg.cd > 0 || this.state.player.hp <= 0) return;
    dg.dir = dir; dg.t = 0;
    this._emit('player-dodge');
  }
  _rage() { const n = this.state.npc; return n.maxHp > 0 ? 1 - n.hp / n.maxHp : 0; }
  _idle() { return (TUNING.idleMin + this._rng() * TUNING.idleVar) * (1 - .4 * this._rage()); }
  _circle() { return TUNING.circleMin + this._rng() * TUNING.circleVar; }
  _retreat() { return TUNING.retreatMin + this._rng() * TUNING.retreatVar; }
  _setAct(a, dur) {
    const n = this.state.npc;
    n.action = a; n.actionT = 0; this._actFor = dur;
    if (a !== 'windup') n.telegraph = null;
  }

  _startRound() {
    const s = this.state;
    s.round++; s.timeLeft = this.opts.roundLen;
    s.phase = 'fighting'; this._phaseT = 0;
    this._setAct('idle', .35);
    this._emit('round-start');
  }

  _roundEnd() {
    const s = this.state, T = TUNING;
    if (s.round < T.rounds) {
      for (const f of [s.player, s.npc]) f.hp = Math.min(f.maxHp, f.hp + f.maxHp * T.roundHeal);
      this._startRound();
    } else {
      // judges' decision — higher hp fraction takes it, ties go to the player
      const win = s.player.hp / s.player.maxHp >= s.npc.hp / s.npc.maxHp;
      s.npc.telegraph = null;
      if (win) { s.player.score += T.score.decision; s.npc.action = 'down'; }
      else { s.npc.action = 'celebrate'; s.npc.actionT = 0; }
      s.phase = win ? 'win' : 'lose';
      this._emit(win ? 'win' : 'lose');
    }
  }

  _verdict() {  // bell after a down phase
    const s = this.state, win = s.phase === 'npcdown';
    s.phase = win ? 'win' : 'lose';
    if (!win) s.npc.action = 'celebrate';
    this._emit(win ? 'win' : 'lose');
  }

  _ko(who) {
    const s = this.state;
    s.npc.telegraph = null; this._phaseT = 0;
    this._emit('ko');
    if (who === 'npc') {
      s.player.score += TUNING.score.ko;
      s.npc.action = 'down'; s.npc.actionT = 0;
      s.phase = 'npcdown';
    } else {
      s.npc.action = 'celebrate'; s.npc.actionT = 0;   // PIP showboats over you
      s.phase = 'playerdown';
    }
  }

  /* ---------- player offense ---------- */

  _playerPunch(pn, inp) {
    const s = this.state, T = TUNING, p = s.player, n = s.npc;
    this._emit('player-punch');
    const kind = T.dmg[pn.kind] ? pn.kind : 'jab';
    const cost = T.stamCost[kind];
    const gassed = p.gassed;
    this._punchT = .22 * (gassed ? T.gasRecover : 1);   // gassed arms recover slower
    if (p.stamina < cost) {   // fully gassed out — the punch dies on the way
      p.stamina = Math.max(0, p.stamina - cost * T.exhaustMul);
      return this._whiff(pn, 'exhausted');
    }
    p.stamina -= cost;
    const power = clamp(num(pn.power, 0), 0, 1) * (gassed ? T.gasPower : 1);
    if (inp.distance > T.reach * (1 + T.reachPow * power))
      return this._whiff(pn, 'range');
    if (n.action === 'down' || n.action === 'hurt')
      return this._whiff(pn, 'iframes');                       // stagger i-frames — no juggling
    if (n.action === 'block') {
      this._emit('npc-blocked');
      s.lastBlow = { who: 'player', kind, result: 'blocked' };
      n.actionT += .1;                                          // eats it on the gloves, pinned a touch
      return;
    }
    const evasive = n.action === 'circle' || n.action === 'retreat';
    if (evasive && this._rng() < T.slipBase + T.slipRage * this._rage())
      return this._whiff(pn, 'slipped');
    // a perfect-dodged swing is still finishing — PIP is already reeling
    if (n.action === 'punch' && this._swing === 'perfect') this._stun();
    const flurry = n.action === 'stunned';
    // clean hit — interrupts whatever PIP was doing, windups included
    const counter = p.counterT > 0;
    const dmg = T.dmg[kind] * (T.powFloor + (1 - T.powFloor) * power)
      * (counter || flurry ? T.counterDamage : 1);
    p.counterT = 0;
    p.combo = this._comboT > 0 ? p.combo + 1 : 1;
    p.bestCombo = Math.max(p.bestCombo, p.combo);
    this._comboT = T.comboWindow;
    n.hp = Math.max(0, n.hp - dmg);
    p.score += Math.round(dmg * T.score.hitMul * (1 + Math.min(5, p.combo - 1) * .15));
    this._tilt += 1;
    s.lastBlow = { who: 'player', kind, dmg, result: 'hit', counter, combo: p.combo, flurry };
    if (counter) this._emit('counter');
    this._emit('player-hit'); this._emit('npc-hit');
    if (n.hp <= 0) return this._ko('npc');
    if (flurry) {   // no i-frames while reeling — every glove shaves the stun
      this._actFor = Math.max(n.actionT + .08, this._actFor - T.stunHitCost);
      return;
    }
    n.action = 'hurt'; n.actionT = 0; n.telegraph = null;
    this._chain = 0;
  }

  _whiff(pn, reason) {
    const s = this.state;
    this._emit('player-miss');
    s.lastBlow = { who: 'player', kind: pn.kind, result: 'miss', reason };
    // PIP loves watching you miss — occasional taunt (only from mobile states)
    if (reason !== 'exhausted' && this._celebrateCd <= 0 && this._rng() < .18
        && ['idle', 'circle', 'press', 'retreat'].includes(s.npc.action)) {
      this._celebrateCd = TUNING.celebrateCd;
      this._setAct('celebrate', TUNING.celebrateT);
    }
  }

  /* ---------- npc brain ---------- */

  _npc(dt, inp) {
    const s = this.state, T = TUNING, n = s.npc;
    n.actionT += dt;
    switch (n.action) {
      case 'idle': case 'circle':
        if (n.actionT >= this._actFor) this._choose(inp);
        break;
      case 'retreat':
        if (n.actionT >= this._actFor) this._setAct('idle', this._idle());
        break;
      case 'press':
        if (n.gassed) this._setAct('retreat', this._retreat());   // gassed — fade out
        else if (inp.distance <= T.attackAt) this._windup();
        else if (n.actionT >= T.pressMax) this._setAct('circle', this._circle());
        break;
      case 'block':
        if (n.actionT >= T.blockT) this._setAct('idle', this._idle());
        break;
      case 'hurt':
        if (n.actionT >= T.npcHurtT) {
          if (this._rng() < T.retreatOnHurt + this._tilt * .08) this._setAct('retreat', this._retreat());
          else this._setAct('idle', this._idle());
        }
        break;
      case 'celebrate':
        if (n.actionT >= T.celebrateT) this._setAct('idle', this._idle());
        break;
      case 'whiff': case 'stunned':   // off-balance / reeling — wide open
        if (n.actionT >= this._actFor) this._setAct('idle', this._idle());
        break;
      case 'windup':
        n.telegraph.t01 = Math.min(1, n.actionT / this._windupFor);
        if (n.telegraph.t01 >= 1) {   // committed — the swing comes out
          this._pk = { kind: n.telegraph.kind, side: n.telegraph.side };
          n.telegraph = null;
          n.action = 'punch'; n.actionT = 0;
          this._impacted = false;
          this._emit('npc-punch');
        }
        break;
      case 'punch':
        if (!this._impacted && n.actionT >= T.punchDur * T.hitAt) {
          this._impacted = true;
          this._impact(inp);
        }
        if (n.action === 'punch' && n.actionT >= T.punchDur) this._afterSwing(inp);
        break;
      // 'down' — out cold, nothing to decide
    }
  }

  _stun() {
    const n = this.state.npc;
    this._chain = 0; this._swing = null;
    this._setAct('stunned', TUNING.perfectStun);
    n.stamina = Math.max(0, n.stamina - .1);
  }

  // what the swing did decides PIP's next beat: reel, stumble, chain, or reset
  _afterSwing(inp) {
    const T = TUNING, n = this.state.npc;
    const res = this._swing; this._swing = null;
    if (res === 'perfect') return this._stun();
    if (res !== 'hit' && res !== 'blocked') {   // dodged / swung at air
      this._chain = 0;
      return this._setAct('whiff', T.whiffT);   // off-balance — counter window
    }
    if (this._chain < T.comboMax - 1 && !n.gassed && inp.distance <= T.npcReach
        && this._rng() < T.comboChance + T.comboRage * this._rage())
      return this._windup(true);
    this._chain = 0;
    if (res === 'hit') this._taunt(.4);        // showboats over a clean shot
    if (n.action === 'punch') this._setAct('idle', T.recoverT);
  }

  _windup(combo = false) {
    const T = TUNING, n = this.state.npc, rage = this._rage(), inp = this._inp;
    const prev = this._pk.kind, r = this._rng();
    // PIP reads a HELD duck and digs an uppercut; combos follow real patterns
    const ducking = inp && inp.duck >= T.dodgeT;
    let kind = ducking && this._rng() < .7 ? 'upper'
      : combo ? (prev === 'jab' ? (r < .55 ? 'jab' : 'hook')
        : prev === 'hook' ? (r < .6 ? 'upper' : 'hook') : 'jab')
      : r < .5 - .1 * rage ? 'jab' : r < .8 ? 'hook' : 'upper';
    // combos alternate hands (hook→hook switches sides, the classic double)
    const side = combo && kind === 'hook' && prev === 'hook'
      ? (this._pk.side === 'left' ? 'right' : 'left')
      : kind === 'jab' ? (this._rng() < .8 ? 'left' : 'right')
      : kind === 'upper' ? (this._rng() < .7 ? 'right' : 'left')
      : (this._rng() < .5 ? 'left' : 'right');
    // aim where the head IS — holding a lean/duck through the telegraph gets you tagged
    this._aim = inp && Math.abs(inp.sway) >= T.dodgeT ? Math.sign(inp.sway)
      : ducking ? 'duck' : 0;
    this._chain = combo ? this._chain + 1 : 0;
    n.stamina = Math.max(0, n.stamina - T.npcCost * (combo ? .6 : 1));
    this._windupFor = (combo ? T.comboWindup : T.windup[kind]) * (1 - T.rageSpeed * rage)
      * (n.gassed ? T.gasWindup : 1);   // tired arms telegraph slower
    this._pk = { kind, side };
    n.action = 'windup'; n.actionT = 0;
    n.telegraph = { kind, side, t01: 0, combo: this._chain };   // side = PIP's glove (mirrored on screen)
  }

  // did the player get out of the way? → 'left'|'right'|'duck'|null (+ perfect)
  _dodgeAt(inp) {
    const T = TUNING, dg = this.state.player.dodge;
    if (dg.dir) return { dir: dg.dir, perfect: dg.t <= T.perfectWin };
    if (Math.abs(inp.sway) >= T.dodgeT && Math.sign(inp.sway) !== this._aim)
      return { dir: inp.sway < 0 ? 'left' : 'right', perfect: false };
    if (inp.duck >= T.dodgeT && this._aim !== 'duck') return { dir: 'duck', perfect: false };
    return null;
  }

  _impact(inp) {
    const s = this.state, T = TUNING, p = s.player;
    const { kind, side } = this._pk;
    this._landed = false;
    this._swing = 'whiff';
    s.lastBlow = { who: 'npc', kind, side, result: 'whiff' };
    if (inp.distance > T.npcReach) return;                    // swung at air
    const dz = this._dodgeAt(inp);
    const duckedInto = dz?.dir === 'duck' && kind === 'upper';   // ducked INTO the uppercut
    if (dz && !duckedInto) {                                  // clean dodge
      p.score += dz.perfect ? T.score.perfect : T.score.dodge;
      p.counterT = T.counterWindow * (dz.perfect ? 1.6 : 1);
      s.lastBlow.result = 'dodged'; s.lastBlow.dodge = dz.dir; s.lastBlow.perfect = dz.perfect;
      this._swing = dz.perfect ? 'perfect' : 'dodged';
      this._emit('player-dodged');
      if (dz.perfect) { p.perfects++; this._emit('perfect-dodge'); }
      return;
    }
    // mirrored block — PIP's 'left' glove comes at the player's right side.
    // a gassed guard is sluggish: effective guard caps at gasGuard < guardT.
    const gCap = p.gassed ? T.gasGuard : 1;
    const g = duckedInto ? 0 : Math.min(side === 'left' ? inp.guard.right : inp.guard.left, gCap);
    const dmg = T.npcDmg[kind] * (duckedInto ? T.duckUpperMul : 1);
    this._landed = true;
    this._regenSlowT = T.hurtRegenT;        // getting tagged stalls your regen
    if (g >= T.guardT) {
      p.hp = Math.max(0, p.hp - dmg * T.blockMul);
      p.hurtT = T.hurtT * .5;
      p.score += T.score.block;
      p.counterT = T.counterWindow;
      s.lastBlow.result = 'blocked'; s.lastBlow.dmg = dmg * T.blockMul;
      this._swing = 'blocked';
      this._emit('player-blocked');
    } else {
      p.combo = 0; this._comboT = 0; p.counterT = 0;
      p.hp = Math.max(0, p.hp - dmg);
      p.hurtT = T.hurtT * (duckedInto ? 1.5 : 1);
      s.lastBlow.result = 'hit'; s.lastBlow.dmg = dmg;
      if (duckedInto) s.lastBlow.reason = 'ducked-into';
      this._swing = 'hit';
      this._emit('player-hit-taken');
    }
    if (p.hp <= 0) this._ko('player');
  }

  _taunt(chance) {  // showboat tax — celebrates its own work, fully punishable
    if (this._celebrateCd > 0 || this.state.player.hp <= 0) return;
    if (this._rng() < chance) {
      this._celebrateCd = TUNING.celebrateCd;
      this._setAct('celebrate', TUNING.celebrateT);
    }
  }

  _choose(inp) {
    const T = TUNING, n = this.state.npc, p = this.state.player;
    const rage = this._rage();
    const inRange = inp.distance <= T.attackAt;
    const gassed = n.gassed;   // tired PIP stops swinging, fades to recover
    const cocky = n.hp > p.hp * 1.15;
    const W = {
      windup: inRange && !gassed ? .55 + .3 * rage : 0,
      press: inRange || gassed ? 0 : .75 + .2 * rage,
      circle: gassed ? .55 : .12,
      retreat: gassed ? .3 : .04 + this._tilt * .07,
      block: inRange ? .08 + .16 * rage : .04,
      celebrate: cocky && this._celebrateCd <= 0 ? .1 : 0,    // the showboat tax
    };
    let sum = 0; for (const k in W) sum += W[k];
    let r = this._rng() * (sum || 1);
    for (const k in W) {
      r -= W[k];
      if (r > 0) continue;
      if (k === 'windup') return this._windup();
      if (k === 'retreat') return this._setAct('retreat', this._retreat());
      if (k === 'circle') return this._setAct('circle', this._circle());
      if (k === 'block') return this._setAct('block', T.blockT);
      if (k === 'celebrate') { this._celebrateCd = T.celebrateCd; return this._setAct('celebrate', T.celebrateT); }
      return this._setAct('press', 0);
    }
    this._setAct('press', 0);
  }
}
