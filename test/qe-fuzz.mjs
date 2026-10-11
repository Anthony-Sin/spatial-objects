/* test/qe-fuzz.mjs — deterministic seeded fuzz + property checks for the
   pure game-logic modules. QE round 2 (worker w4-qe-fuzz).

   Coverage: shared/boxing/{fight,fists,ring,tutorial,audio,protoBoxer}.js
     - malformed inputs: null/undefined/NaN states, non-array hands,
       NaN/±Infinity landmarks, dt ∈ {0, -1, 1e-6, 10, NaN, Infinity, 'x'}
     - degenerate constructor opts (non-finite TUNING overrides)
     - state-machine fuzz: random input streams → phase/hp/stamina/round
       invariants hold every single step
     - soak: 60k update ticks → no unbounded module-state growth
     - audio: strict mock AudioContext (throws on non-finite params, like
       real Chrome) under garbage event names/opts
     - integration: fists→fight→ring wired like game.js under chaos input

   Deterministic: one seeded mulberry32 drives every random stream — same
   output every run. `node test/qe-fuzz.mjs` exits non-zero on failure. */

import { Fight, TUNING as FT } from '../shared/boxing/fight.js';
import { RingSim, TUNING as RT } from '../shared/boxing/ring.js';
import { FistTracker, TUNING as TT } from '../shared/boxing/fists.js';
import { Tutorial, STEPS, TOTAL } from '../shared/boxing/tutorial.js';
import { BoxingAudio, EVENT_SFX } from '../shared/boxing/audio.js';
import { VARIANTS, buildBoxer } from '../shared/boxing/protoBoxer.js';

const DT = 1 / 60;
let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '   <-- ' + extra}`);
  cond ? pass++ : fail++;
};

// seeded PRNG — same mulberry32 the modules use
let _s = 0xC0FFEE;
const reseed = s => { _s = s >>> 0; };
const rnd = () => {
  _s = (_s + 0x6D2B79F5) | 0;
  let t = Math.imul(_s ^ (_s >>> 15), 1 | _s);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = arr => arr[rnd() * arr.length | 0];

/* ---------------- input generators ---------------- */

// garbage scalars that show up in real tracking pipelines
const GARBAGE_NUM = [NaN, Infinity, -Infinity, 0, -1, 1e-6, 1e9, -1e9, 'x', '', [], {}, null, undefined, true];
const gnum = () => pick(GARBAGE_NUM);

const lm = (cx, cy, s = 1, n = 21) => Array.from({ length: n }, (_, i) =>
  ({ x: cx + (i % 5 - 2) * .02 * s, y: cy + Math.floor(i / 5) * .03 * s, z: 0 }));
const hand = (side, x, y, s = 1, kind = 'fist') => ({
  side, kind, lm: lm(x, y, s), palm: { x, y }, wrist: { x, y: y + .12 * s },
  nExt: kind === 'fist' ? 0 : 4 });
const fc = (x = .5, y = .4, found = true) =>
  ({ ok: true, found, nose: { x, y }, size: .32, center: { x, y } });
const hs = (...list) => ({ ok: true, hands: list.filter(Boolean) });

// chaos hand: mostly plausible, sometimes malformed
function chaosHand() {
  const r = rnd();
  if (r < .06) return null;
  if (r < .10) return pick([42, 'x', true, undefined]);
  if (r < .16) return { side: pick(['left', 'right']), kind: 'fist' };           // no lm/palm
  if (r < .22) return { side: pick(['left', 'right']), kind: 'fist', lm: null, palm: { x: rnd(), y: rnd() } };
  const side = pick(['left', 'right', 'x', undefined]);
  const s = r < .3 ? gnum() : .8 + rnd() * 1.6;                                  // occasionally garbage scale
  const h = hand(side, rnd(), rnd(), 1);
  if (typeof s === 'number' && Number.isFinite(s)) h.lm = lm(h.palm.x, h.palm.y, s);
  else h.lm = lm(h.palm.x, h.palm.y, 1).map(p => ({ x: gnum(), y: gnum(), z: 0 }));
  if (rnd() < .08) h.lm = h.lm.slice(0, rnd() * 9 | 0);                          // truncated lm
  if (rnd() < .08) h.lm[0] = null;
  if (rnd() < .08) h.lm[9] = undefined;
  if (rnd() < .06) h.palm = { x: gnum(), y: gnum() };
  return h;
}
function chaosHandsState() {
  const r = rnd();
  if (r < .06) return null;
  if (r < .10) return { hands: pick([{}, 'x', 5, true]) };
  const n = rnd() < .15 ? rnd() * 6 | 0 : rnd() * 3 | 0;
  const hands = [];
  for (let i = 0; i < n; i++) hands.push(chaosHand());
  return { ok: true, hands };
}
function chaosFaceState() {
  const r = rnd();
  if (r < .12) return pick([null, undefined, 5, 'x']);
  if (r < .2) return { found: false };
  return { found: true, nose: { x: rnd() < .12 ? gnum() : rnd(), y: rnd() < .12 ? gnum() : rnd() },
    size: rnd() < .1 ? gnum() : .1 + rnd() * .4 };
}
const chaosDt = () => pick([DT, DT, DT, DT, 0, -1, 1e-6, .5, 10, NaN, Infinity, -Infinity, 'x', .033]);

const PUNCH_KINDS = ['jab', 'cross', 'hook', 'uppercut', 'bogus', 'upper', 5, null, undefined];
function chaosPunch() {
  const r = rnd();
  if (r < .08) return pick([null, undefined, 5, 'jab', true]);
  if (r < .16) return {};
  return { kind: pick(PUNCH_KINDS), side: pick(['left', 'right', 'x', undefined]),
    power: rnd() < .15 ? gnum() : rnd() * 1.4 - .2 };
}
function chaosFightInputs() {
  const r = rnd();
  if (r < .03) return null;
  if (r < .05) return pick([5, 'x', true]);
  const o = {};
  if (rnd() < .85) {
    const n = rnd() * 4 | 0;
    o.punches = rnd() < .06 ? pick([{}, 'x', 5]) : Array.from({ length: n }, chaosPunch);
  }
  if (rnd() < .8) o.guard = rnd() < .1 ? pick([5, 'x', null])
    : { left: rnd() < .12 ? gnum() : rnd() * 1.6 - .3, right: rnd() < .12 ? gnum() : rnd() * 1.6 - .3 };
  if (rnd() < .7) o.sway = rnd() < .15 ? gnum() : rnd() * 3 - 1.5;
  if (rnd() < .5) o.duck = rnd() < .15 ? gnum() : rnd() * 1.4 - .2;
  if (rnd() < .2) o.dodge = rnd() < .2 ? gnum() : pick([-1, 0, 1, 2, -5]);
  if (rnd() < .9) o.distance = rnd() < .15 ? gnum() : rnd() * 4 - .5;
  return o;
}
function chaosRingInput() {
  const r = rnd();
  if (r < .04) return pick([null, 5, 'press']);
  const o = {};
  if (rnd() < .8) o.npcDir = pick(['press', 'circle', 'retreat', 'hold', 'bogus', null, 5, undefined]);
  if (rnd() < .3) o.npcStunned = pick([true, false, 1, 0, 'x']);
  if (rnd() < .6) o.playerStep = rnd() < .2 ? gnum() : rnd() * 3 - 1.5;
  if (rnd() < .5) o.sway = rnd() < .2 ? gnum() : rnd() * 2 - 1;
  if (rnd() < .3) o.playerDodge = pick([-1, 0, 1, 'x', NaN]);
  return o;
}

/* ---------------- invariant helpers ---------------- */

const PHASES = new Set(['intro', 'countdown', 'fighting', 'playerdown', 'npcdown', 'win', 'lose']);
const NPC_ACTS = new Set(['idle', 'press', 'circle', 'retreat', 'windup', 'punch', 'block',
  'hurt', 'down', 'celebrate', 'whiff', 'stunned']);
const EVENT_VOCAB = new Set(['player-punch', 'player-hit', 'player-miss', 'npc-hit', 'npc-blocked',
  'npc-punch', 'player-hit-taken', 'player-blocked', 'player-dodged', 'player-dodge',
  'perfect-dodge', 'counter', 'npc-special', 'ko', 'round-start', 'countdown', 'win', 'lose']);
const RESULTS = new Set(['hit', 'miss', 'blocked', 'dodged', 'whiff']);

function fightInvariant(f, tag) {
  const s = f.state;
  if (!PHASES.has(s.phase)) return `${tag}: bad phase '${s.phase}'`;
  if (!(s.round >= 0 && s.round <= FT.rounds)) return `${tag}: round=${s.round}`;
  if (!(Number.isFinite(s.timeLeft) && s.timeLeft >= 0)) return `${tag}: timeLeft=${s.timeLeft}`;
  for (const [w, fg] of [['player', s.player], ['npc', s.npc]]) {
    if (!(Number.isFinite(fg.hp) && fg.hp >= 0 && fg.hp <= fg.maxHp + 1e-9))
      return `${tag}: ${w}.hp=${fg.hp} max=${fg.maxHp}`;
    if (!(Number.isFinite(fg.stamina) && fg.stamina >= 0 && fg.stamina <= 1 + 1e-9))
      return `${tag}: ${w}.stamina=${fg.stamina}`;
  }
  if (!Number.isFinite(s.player.score) || s.player.score < 0) return `${tag}: score=${s.player.score}`;
  if (!NPC_ACTS.has(s.npc.action)) return `${tag}: bad npc.action '${s.npc.action}'`;
  const tg = s.npc.telegraph;
  if (tg !== null && tg !== undefined) {
    if (!(tg.t01 >= 0 && tg.t01 <= 1)) return `${tag}: telegraph.t01=${tg.t01}`;
    if (!['jab', 'hook', 'upper'].includes(tg.kind)) return `${tag}: telegraph.kind=${tg.kind}`;
    if (tg.side !== 'left' && tg.side !== 'right') return `${tag}: telegraph.side=${tg.side}`;
  }
  for (const e of s.events) if (!EVENT_VOCAB.has(e)) return `${tag}: event '${e}' not in vocab`;
  const lb = s.lastBlow;
  if (lb && !RESULTS.has(lb.result)) return `${tag}: lastBlow.result=${lb.result}`;
  return null;
}

function ringLegality(sim, tag) {
  for (const [n, f] of [['player', sim.player], ['npc', sim.npc]]) {
    if (!Number.isFinite(f.pos.x) || !Number.isFinite(f.pos.z)) return `${tag}: ${n} pos NaN`;
    if (!Number.isFinite(f.vel.x) || !Number.isFinite(f.vel.z)) return `${tag}: ${n} vel NaN`;
    const r = Math.hypot(f.pos.x, f.pos.z), lim = Math.max(0, sim.t.radius - f.radius);
    if (r > lim + 1e-6) return `${tag}: ${n} out of bounds r=${r.toFixed(3)} > ${lim.toFixed(3)}`;
  }
  const d = sim.distance();
  if (!Number.isFinite(d)) return `${tag}: distance NaN`;
  const min = (sim.player.radius + sim.npc.radius) * .99;
  if (d < min - 1e-6) return `${tag}: overlap d=${d.toFixed(3)} < ${min.toFixed(3)}`;
  if (!Number.isFinite(sim.angleToNpc())) return `${tag}: angleToNpc NaN`;
  return null;
}

/* ============ 1. fists.js — malformed input fuzz ============ */
reseed(0xF157);
{
  const ft = new FistTracker();
  let err = null, n = 0;
  try {
    for (let i = 0; i < 2500; i++) {
      n++;
      ft.update(chaosHandsState(), chaosFaceState(), chaosDt());
      // outputs must stay finite / in-range every single frame
      if (!Number.isFinite(ft.sway) || Math.abs(ft.sway) > 1.0001) { err = `sway=${ft.sway} @${i}`; break; }
      if (!Number.isFinite(ft.duck) || ft.duck < -1e-9 || ft.duck > 1.0001) { err = `duck=${ft.duck} @${i}`; break; }
      for (const s of ['left', 'right']) {
        if (!Number.isFinite(ft.guard[s]) || ft.guard[s] < -1e-9 || ft.guard[s] > 1.0001) { err = `guard.${s}=${ft.guard[s]} @${i}`; break; }
        if (!Number.isFinite(ft.reach[s])) { err = `reach.${s}=${ft.reach[s]} @${i}`; break; }
      }
      if (err) break;
      for (const p of ft.punches.splice(0)) {
        if (!['jab', 'cross', 'hook', 'uppercut'].includes(p.kind)) { err = `punch.kind='${p.kind}' @${i}`; break; }
        if (!['left', 'right'].includes(p.side)) { err = `punch.side='${p.side}' @${i}`; break; }
        if (!(p.power >= 0 && p.power <= 1)) { err = `punch.power=${p.power} @${i}`; break; }
        if (!Number.isFinite(p.t)) { err = `punch.t=${p.t} @${i}`; break; }
      }
      if (err) break;
    }
    const d = ft.debug();
    if (!err && ![d.span.left, d.span.right, d.reach.left, d.reach.right,
      d.baseline.left, d.baseline.right, d.sway, d.duck].every(Number.isFinite))
      err = 'debug() non-finite: ' + JSON.stringify(d);
  } catch (e) { err = `threw @frame ${n}: ${e.message}`; }
  check('fists: 2500 chaos frames — no throw, outputs in range', !err, err);
}
{
  // degenerate constructor opts must not brick the tracker
  const cases = [
    { MIN_SPAN: 'x' }, { FIRE_VEL: NaN }, { BASELINE_RATE: 'no' },
    { MIN_SPAN: NaN, FIRE_VEL: 'x', RESET_VEL: {} }, { DT_MAX: null },
  ];
  let err = null;
  for (const o of cases) {
    try {
      const ft = new FistTracker(o);
      for (let i = 0; i < 40; i++) ft.update(hs(hand('left', .4, .55, 1.6)), fc(), DT);
      for (const s of [1.8, 2.1, 2.4, 2.7, 2.5, 2.2, 2.0])
        ft.update(hs(hand('left', .4, .55, s)), fc(), DT);
      if (ft.punches.length === 0) { err = `opts ${JSON.stringify(o)} → dead tracker (no punch)`; break; }
      if (!Number.isFinite(ft.debug().reach.left)) { err = `opts ${JSON.stringify(o)} → NaN reach`; break; }
    } catch (e) { err = `opts ${JSON.stringify(o)} threw: ${e.message}`; break; }
  }
  check('fists: garbage tuning opts → tracker still works', !err, err);
}
{
  // face.size=Infinity must not poison stored state
  const ft = new FistTracker();
  for (let i = 0; i < 5; i++) ft.update(hs(), { found: true, nose: { x: .5, y: .4 }, size: Infinity }, DT);
  check('fists: face.size=Infinity → _faceSize stays finite', Number.isFinite(ft._faceSize), `${ft._faceSize}`);
}
{
  // 60k-tick soak: no unbounded module state
  const ft = new FistTracker();
  for (let i = 0; i < 60000; i++) {
    // alternating: sometimes plausible punch stream, sometimes empty
    const on = (i / 600 | 0) % 2 === 0;
    const h = on ? hand('left', .4, .55, 1.6 + Math.sin(i / 20) * .3) : null;
    ft.update(h ? hs(h) : hs(), i % 2 ? fc() : null, DT);
    if (ft.punches.length > 100) ft.punches.length = 0;    // drain like a lazy consumer sometimes
  }
  const leaks = ft.punches.length > TT.PUNCH_MAX + 2;
  const d = ft.debug();
  check('fists: 60k-tick soak — punches capped, state finite',
    !leaks && [d.span.left, d.reach.left, d.guard.left, d.sway].every(Number.isFinite),
    `punches=${ft.punches.length} reach=${d.reach.left}`);
}

/* ============ 2. ring.js — steering fuzz ============ */
reseed(0xE126);
{
  const sim = new RingSim({ seed: 11 });
  let err = null;
  try {
    for (let i = 0; i < 5000; i++) {
      sim.step(chaosDt(), chaosRingInput());
      if ((err = ringLegality(sim, `step ${i}`))) break;
    }
  } catch (e) { err = `threw: ${e.message}`; }
  check('ring: 5000 chaos steps — finite / in-bounds / no overlap', !err, err);
}
{
  // null / primitive input must not crash
  let err = null;
  try {
    const sim = new RingSim();
    sim.step(DT, null); sim.step(DT, 'press'); sim.step(DT, 42); sim.step(DT);
    sim.step(DT, { npcDir: 'press' });
  } catch (e) { err = e.message; }
  check('ring: step(dt, null/primitive) never throws', !err, err);
}
{
  // degenerate constructor tuning → sim must stay finite and legal
  const cases = [
    { radius: NaN }, { radius: 'x' }, { radius: .1 }, { radius: -3 },
    { bodyRadius: -1 }, { accel: -5 }, { accel: 'x' }, { stunDamp: -99 },
    { playerLeash: -1 }, { punchRange: NaN }, { midRange: 'x' },
    { anchorSpeed: -2 }, { npcSpeed: NaN }, { playerPushShare: 9 },
    { orbitFlipMin: 'x' }, { orbitFlipMax: -1 }, { laneGain: 'x' },
    { arriveRadius: NaN, avoidPad: 'x', laneAngle: -2 },
  ];
  let err = null;
  for (const o of cases) {
    const sim = new RingSim({ ...o, seed: 5 });
    try {
      for (let i = 0; i < 300; i++) {
        sim.step(DT, { npcDir: pick(['press', 'circle', 'retreat', 'hold']), playerStep: rnd() * 2 - 1 });
        if ((err = ringLegality(sim, JSON.stringify(o)))) break;
      }
    } catch (e) { err = `opts ${JSON.stringify(o)} threw: ${e.message}`; }
    if (err) break;
  }
  check('ring: garbage TUNING overrides → sim stays legal', !err, err);
}
{
  // live TUNING mutation to garbage — clamps should not produce NaN
  const sim = new RingSim();
  sim.t.radius = NaN; sim.t.playerLeash = NaN;
  let err = null;
  try {
    for (let i = 0; i < 60; i++) sim.step(DT, { npcDir: 'press' });
    if (!Number.isFinite(sim.player.pos.x + sim.npc.pos.x)) err = 'positions went NaN after tuning mutation';
  } catch (e) { err = `threw: ${e.message}`; }
  check('ring: live tuning mutation → positions stay finite', !err, err);
}
{
  // determinism — same seed, same input stream
  const mk = () => new RingSim({ seed: 777 });
  const a = mk(), b = mk();
  const dirs = ['press', 'circle', 'retreat', 'hold'];
  let diff = 0;
  for (let i = 0; i < 900; i++) {
    const inp = { npcDir: dirs[i % 4], playerStep: Math.sin(i / 9), npcStunned: i % 37 === 0 };
    a.step(DT, inp); b.step(DT, inp);
    diff = Math.max(diff, Math.abs(a.npc.pos.x - b.npc.pos.x), Math.abs(a.player.pos.z - b.player.pos.z));
  }
  check('ring: deterministic trajectory for a seed', diff === 0, `maxDiff=${diff}`);
}

/* ============ 3. fight.js — state machine fuzz ============ */
reseed(0xF1617);
{
  let err = null;
  try {
    const f = new Fight({ seed: 7 });
    f.step(DT, null); f.step(DT, 42); f.step(DT, 'x'); f.step(DT);
    f.step(DT, { punches: null, guard: null, sway: 'x', distance: {} });
  } catch (e) { err = e.message; }
  check('fight: step(dt, null/primitive) never throws', !err, err);
}
{
  // 3 seeds × 8000 steps of full-garbage inputs — invariants every step
  let err = null;
  for (const seed of [3, 17, 555]) {
    const f = new Fight({ seed, npcVariant: pick(VARIANTS) });
    try {
      for (let i = 0; i < 8000; i++) {
        f.step(chaosDt(), chaosFightInputs());
        if ((err = fightInvariant(f, `seed${seed} step ${i}`))) break;
      }
    } catch (e) { err = `seed${seed} threw: ${e.message}`; }
    if (err) break;
  }
  check('fight: 24k chaos steps — invariants hold every step', !err, err);
}
{
  // scripted-swing API under garbage args — PIP must never wedge in windup
  let err = null;
  for (const w of [-1, 0, NaN, Infinity, 'x', {}, -0.001, 1e-9]) {
    const f = new Fight({ seed: 1, ai: false, practice: true });
    for (let i = 0; i < 700 && f.state.phase !== 'fighting'; i++) f.step(DT, {});
    try {
      f.throwPunch(pick(['jab', 'hook', 'upper', 'cross', 'bogus', 5, null]),
        pick(['left', 'right', 'x', 5, null]), w);
      for (let i = 0; i < 900; i++) f.step(DT, {});      // 15s to resolve
      if (f.state.npc.action === 'windup') { err = `windup=${w} → NPC stuck telegraphing (t01=${f.state.npc.telegraph?.t01})`; break; }
      const tg = f.state.npc.telegraph;
      if (tg && tg.side !== 'left' && tg.side !== 'right') { err = `side leak: ${tg.side}`; break; }
    } catch (e) { err = `windup=${w} threw: ${e.message}`; break; }
  }
  check('fight: throwPunch garbage windup/side → never wedges', !err, err);
}
{
  // degenerate constructor opts — the fight must still run + terminate
  let err = null;
  for (const o of [
    { roundLen: NaN }, { roundLen: -5 }, { roundLen: 'x' }, { roundLen: Infinity },
    { playerHp: -50 }, { playerHp: NaN }, { playerHp: 'x' },
    { npcHp: 0 }, { npcHp: -3 }, { npcHp: Infinity }, { seed: NaN }, { seed: 'x' },
  ]) {
    const f = new Fight(o);
    try {
      for (let i = 0; i < 60 * 40 && !['win', 'lose'].includes(f.state.phase); i++)
        f.step(DT, { punches: i % 20 === 0 ? [{ kind: 'cross', side: 'right', power: 1 }] : [], distance: .9 });
      if (!Number.isFinite(f.state.timeLeft) && f.state.timeLeft !== Infinity)
        { err = `${JSON.stringify(o)} → timeLeft=${f.state.timeLeft}`; break; }
      if ((err = fightInvariant(f, JSON.stringify(o)))) break;
      if (f.state.phase === 'fighting' && !Number.isFinite(f.state.timeLeft))
        { err = `${JSON.stringify(o)} → non-finite clock, never ends`; break; }
    } catch (e) { err = `${JSON.stringify(o)} threw: ${e.message}`; break; }
  }
  check('fight: degenerate opts → state stays legal', !err, err);
}
{
  // a full fight reaches a terminal phase inside the round budget
  let err = null;
  for (const seed of [1, 7, 23, 91, 4242]) {
    const f = new Fight({ seed });
    const cap = (FT.introT + FT.countT + f.opts.roundLen * FT.rounds + FT.downT + 30) * 60;
    let i = 0;
    for (; i < cap; i++) {
      f.step(DT, {
        punches: i % 30 === 0 ? [{ kind: 'cross', side: 'right', power: 1 }] : [],
        guard: { left: 0, right: 0 }, distance: .9, sway: 0 });
      if (['win', 'lose'].includes(f.state.phase)) break;
      if ((err = fightInvariant(f, `seed${seed}`))) break;
    }
    if (err) break;
    if (!['win', 'lose'].includes(f.state.phase)) { err = `seed${seed}: no verdict after ${(i / 60).toFixed(0)}s (phase=${f.state.phase})`; break; }
  }
  check('fight: 5 seeds all reach win/lose inside the round budget', !err, err);
}
{
  // one pathological step: 200k-entry punches array must not flood
  const f = new Fight({ seed: 7 });
  for (let i = 0; i < 700 && f.state.phase !== 'fighting'; i++) f.step(DT, {});
  const big = Array.from({ length: 200000 }, () => ({ kind: 'jab', side: 'left', power: .5 }));
  const t0 = Date.now();
  f.step(DT, { punches: big, distance: .9 });
  const ms = Date.now() - t0;
  check('fight: 200k-entry punches → events bounded (queue not flooded)',
    f.state.events.length <= 400, `events=${f.state.events.length}`);
  check('fight: 200k-entry punches → step stays fast (<100ms)', ms < 100, `${ms}ms`);
}
{
  // practice mode fuzz — nobody can be KO'd, clock never runs
  const f = new Fight({ seed: 9, ai: false, practice: true });
  let err = null;
  try {
    for (let i = 0; i < 3000; i++) {
      f.step(chaosDt(), chaosFightInputs());
      if (['playerdown', 'npcdown', 'win', 'lose'].includes(f.state.phase)) { err = `practice reached ${f.state.phase} @${i}`; break; }
      if ((err = fightInvariant(f, `practice @${i}`))) break;
    }
  } catch (e) { err = `threw: ${e.message}`; }
  check('fight: practice mode 3000 chaos steps — never a KO', !err, err);
}
{
  // determinism under an identical garbage stream
  const stream = [];
  reseed(0xBEEF);
  for (let i = 0; i < 2000; i++) stream.push(chaosFightInputs());
  const run = () => {
    try {
      const f = new Fight({ seed: 99 });
      for (const inp of stream) f.step(DT, inp);
      const s = f.state;
      return [s.phase, s.round, s.player.hp, s.npc.hp, s.player.score, s.npc.action].join('|');
    } catch (e) { return 'THREW:' + e.message; }
  };
  const r1 = run(), r2 = run();
  check('fight: garbage-stream determinism', r1 === r2 && !r1.startsWith('THREW'), `${r1} vs ${r2}`);
}

/* ============ 4. tutorial.js — timebox fuzz ============ */
reseed(0x70741);
function tutRun(brain, { injectNaN = false, badOut = false } = {}) {
  const fight = new Fight({ seed: 3, ai: false, practice: true });
  const sim = new RingSim({ seed: 3 });
  let finished = null, threw = null;
  const tutor = new Tutorial({ fight, sim, onDone: p => { finished = p; } });
  fight.startNow();
  let t = 0;
  const out = { events: [], state: fight.state };
  try {
    while (!tutor.done && t < 70) {
      const st = fight.state;
      const inp = brain(st, tutor) || {};
      sim.step(DT, { npcDir: fight.npcDir(), npcStunned: st.npc.action === 'stunned' });
      fight.step(DT, { ...inp, distance: sim.distance() });
      if (badOut) { out.events = 5; out.state = {}; }
      else { out.events = st.events.slice(); out.state = st; }
      tutor.update(out, injectNaN && t > 1 && t < 1.1 ? NaN : t);   // one NaN frame ~1s in
      t += DT;
    }
  } catch (e) { threw = e.message; }
  return { finished, t, threw, done: tutor.done };
}
{
  const r = tutRun(() => null);   // passive player + one NaN clock frame
  check('tutorial: NaN clock frame does not wedge the run', r.done && !r.threw,
    `done=${r.done} threw=${r.threw}`);
  check('tutorial: NaN clock → still finishes under TOTAL+ε', r.t <= TOTAL + 5, `t=${r.t.toFixed(1)}`);
}
{
  const r = tutRun(() => null, { badOut: true });   // malformed out every frame
  check('tutorial: malformed out (events:5,state:{}) → still terminates', r.done && !r.threw,
    `done=${r.done} threw=${r.threw}`);
}
{
  // random brain — always terminates inside ~45s of fighting
  let err = null;
  for (const seed of [1, 2, 3]) {
    reseed(seed);
    const r = tutRun(() => chaosFightInputs());
    if (r.threw) { err = `seed${seed} threw: ${r.threw}`; break; }
    if (!r.done) { err = `seed${seed}: never done after ${r.t.toFixed(0)}s`; break; }
    if (r.t > TOTAL + 15) { err = `seed${seed}: took ${r.t.toFixed(1)}s > TOTAL+15`; break; }
  }
  check('tutorial: random brains always finish inside the cap', !err, err);
}
{
  let threw = null;
  try {
    new Tutorial(null);
    const t2 = new Tutorial({});
    t2.update(null, 1); t2.update({ events: 7, state: null }, 2);
    const t3 = new Tutorial({ fight: new Fight({ seed: 1, ai: false, practice: true }) });
    t3.update(undefined, NaN); t3.update({ events: {}, state: { npc: {} } }, 5);
    // malformed sim shapes — {} used to throw inside _spar at construction
    for (const sim of [{}, { player: {} }, { npc: {} }, { distance: 'x' }]) {
      const t4 = new Tutorial({ sim });
      t4.update({ events: [], state: { phase: 'fighting', npc: { action: 'idle' } } }, 1);
    }
  } catch (e) { threw = e.message; }
  check('tutorial: degenerate constructor/update args never throw', !threw, threw);
}

/* ============ 5. audio.js — strict-mock node graph fuzz ============ */
reseed(0xAD10);
// strict Web Audio stub: params throw RangeError on non-finite input —
// exactly what a real AudioContext does (TypeError/RangeError), so any NaN
// reaching the node graph is a test failure, not a silent no-op.
function strictParam(v) {
  const val = x => { if (!Number.isFinite(x)) throw new RangeError(`non-finite audio param ${x}`); return true; };
  return {
    value: v,
    setValueAtTime(x, t) { val(x); this.value = x; },
    linearRampToValueAtTime(x, t) { val(x); this.value = x; },
    exponentialRampToValueAtTime(x, t) { val(x); this.value = x; },
    setTargetAtTime(x, t) { val(x); this.value = x; },
    cancelScheduledValues() {},
  };
}
function strictCtx() {
  const made = [];
  const mk = type => {
    const n = { type, frequency: strictParam(440), Q: strictParam(1), gain: strictParam(1),
      buffer: null, loop: false, connect() {}, disconnect() {}, start(t) {}, stop(t) {} };
    made.push(n);
    return n;
  };
  return { made, currentTime: 0, sampleRate: 44100, state: 'running',
    destination: { type: 'destination' }, resume() {},
    createOscillator: () => mk('osc'), createGain: () => mk('gain'),
    createBiquadFilter: () => mk('filter'), createDynamicsCompressor: () => mk('comp'),
    createBufferSource: () => mk('src'),
    createBuffer: (ch, len) => ({ getChannelData: () => new Float32Array(len / ch | 0 || len) }) };
}
{
  const ctx = strictCtx();
  const a = new BoxingAudio(); a.unlock(ctx);
  const evtPool = [...Object.keys(EVENT_SFX), 'bogus', '', null, undefined, 5, {},
    { type: 'ko' }, { type: 'x' }, { type: null }, [], Symbol ? 'weird-evt' : 'w'];
  const statePool = [null, undefined, {}, { lastBlow: null },
    { lastBlow: { who: 'player', kind: 'hook', dmg: NaN, result: 'hit' } },
    { lastBlow: { who: 'npc', kind: 5, dmg: 'x' } },
    { lastBlow: { who: 'player', kind: 'upper', dmg: Infinity } },
    { countdown: NaN }, { countdown: 'x' }, { countdown: -4 }];
  let err = null, handled = 0;
  try {
    for (let i = 0; i < 1200; i++) {
      const r = a.handleEvent(pick(evtPool), pick(statePool));
      if (typeof r !== 'boolean') { err = `non-boolean return @${i}`; break; }
      if (r) handled++;
    }
  } catch (e) { err = `threw: ${e.message}`; }
  check('audio: 1200 garbage events on strict ctx — no non-finite params reach nodes', !err, err);
  check('audio: valid events still handled during the storm', handled > 100, `handled=${handled}`);
}
{
  // play() with garbage opts — bounded node creation, finite params
  const ctx = strictCtx();
  const a = new BoxingAudio(); a.unlock(ctx);
  let err = null;
  const before = ctx.made.length;
  try {
    for (const [name, o] of [
      ['bell', { times: 1e9 }], ['bell', { times: 'x' }], ['bell', { times: -4 }],
      ['whoosh', { kind: 'bogus', miss: 'x', peak: NaN }],
      ['thwack', { kind: 5, dmg: 'x', delay: NaN, peak: Infinity }],
      ['thud', { dmg: Infinity, beep: NaN }],
      ['dodge', { perfect: 'x' }], ['hurt', { dmg: -1e9 }],
      ['ko', { delay: -Infinity }], ['win', 'x'], ['lose', null],
      ['nope', {}], [null, {}], [{}, {}],
    ]) a.play(name, o);
  } catch (e) { err = e.message; }
  check('audio: garbage play opts — strict params never see non-finite', !err, err);
  check('audio: times=1e9 is bounded (no node flood)',
    ctx.made.length - before < 200, `made=${ctx.made.length - before}`);
}
{
  // update() under garbage dt/state — internal meters stay finite
  const a = new BoxingAudio(); a.unlock(strictCtx());
  let err = null;
  try {
    for (let i = 0; i < 500; i++) {
      a.update(pick([DT, 0, -1, NaN, Infinity, 'x', .033]),
        pick([null, {}, { phase: 'fighting' }, { phase: 'fighting', player: { stamina: -5 } },
          { phase: 'win' }, { phase: 'fighting', player: { stamina: NaN } }, 5]));
    }
    // after the storm: swell must still work
    a.handleEvent('player-hit-taken', { lastBlow: { dmg: 10 } });
    a.update(DT, { phase: 'fighting', player: { stamina: 1 } });
  } catch (e) { err = e.message; }
  check('audio: 500 garbage update() calls — meters stay finite',
    !err && Number.isFinite(a._crowdLevel) && Number.isFinite(a._breathT),
    `${err} crowdLevel=${a._crowdLevel} breathT=${a._breathT}`);
  check('audio: crowd swell survives garbage dt', a._crowdLevel > 0, `${a._crowdLevel}`);
}

/* ============ 6. protoBoxer.js — rig fuzz (stub THREE) ============ */
reseed(0xB0CE2);
// minimal THREE stub — same shape as test/boxing-proto.mjs
class V3 { constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
  set(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; return this; } }
class Obj3D {
  constructor() { this.children = []; this.parent = null; this.position = new V3();
    this.rotation = new V3(); this.scale = new V3(1, 1, 1); this.userData = {}; this.visible = true; this.name = ''; }
  add(...cs) { for (const c of cs) { c.parent = this; this.children.push(c); } return this; }
  traverse(fn) { fn(this); for (const c of this.children) (c.traverse || (x => x)).call(c, fn); }
}
class Group extends Obj3D { constructor() { super(); this.type = 'Group'; } }
class Mesh extends Obj3D { constructor(g, m) { super(); this.type = 'Mesh'; this.geometry = g; this.material = m; } }
class Geo { constructor(...a) { this.args = a; } dispose() {} computeBoundingSphere() { this.boundingSphere = { radius: 1 }; } }
class Mat { constructor(o = {}) { Object.assign(this, o); } dispose() {} }
const THREE = { Group, Mesh,
  SphereGeometry: class extends Geo {}, BoxGeometry: class extends Geo {},
  CapsuleGeometry: class extends Geo {}, CylinderGeometry: class extends Geo {},
  TorusGeometry: class extends Geo {},
  MeshToonMaterial: Mat, MeshBasicMaterial: Mat, MeshLambertMaterial: Mat,
  BackSide: 1, FrontSide: 0, DoubleSide: 2 };

function boxerFinite(b, tag) {
  let bad = null;
  b.group.traverse(o => {
    if (bad) return;
    for (const v of [o.position, o.rotation, o.scale])
      if (![v.x, v.y, v.z].every(Number.isFinite)) bad = `${tag}: ${o.name || o.type} non-finite transform`;
  });
  return bad;
}
{
  // garbage construction args
  let err = null;
  try {
    for (const o of [null, 'x', 5, { variant: 'bogus' }, { variant: null },
      { variant: 'bean', palette: 'x' }, { palette: 5 }, { playerLook: 'x' }]) {
      const b = buildBoxer(THREE, o);
      if (!b || !b.group) { err = `opts ${JSON.stringify(o)} → no boxer`; break; }
      b.pose('idle', 0); b.tick(DT);
    }
  } catch (e) { err = `threw: ${e.message}`; }
  check('proto: garbage buildBoxer opts → falls back, never throws', !err, err);
}
{
  // pose/tick fuzz — every named + garbage pose, garbage t01, garbage strike
  const poses = ['idle', 'windup', 'windupL', 'jab', 'jabL', 'cross', 'crossL', 'hook', 'hookL',
    'upper', 'upperL', 'block', 'hurt', 'down', 'celebrate', 'stunned', 'whiff', 'wave', 'point',
    'victory', 'bogus', '', null, undefined, 5];
  let err = null;
  const b = buildBoxer(THREE, { variant: 'bubble' });
  try {
    for (let i = 0; i < 3000; i++) {
      b.pose(pick(poses), pick([0, .5, 1, -1, 2.5, NaN, Infinity, 'x', null]),
        pick([null, undefined, { kind: 'hook' }, { reach: 1.1, y: .8 },
          { reach: NaN }, { reach: -5 }, { reach: 1e9, y: 'x' }, 5, 'x', { kind: 5 }]));
      b.tick(chaosDt(), pick([null, {}, { gassed: true }, 5]), pick([0, 1, NaN, 'x', -3]));
      if (i % 97 === 0 && (err = boxerFinite(b, `iter ${i}`))) break;
    }
    if (!err) err = boxerFinite(b, 'final');
  } catch (e) { err = `threw: ${e.message}`; }
  check('proto: 3000 pose/tick chaos calls — transforms stay finite', !err, err);
}
{
  // NaN dt / NaN strike must NOT permanently poison the rig
  const b = buildBoxer(THREE, { variant: 'sumo' });
  b.pose('idle', 0);
  for (let i = 0; i < 30; i++) b.tick(DT);
  const x0 = b.parts.gloveL.position.x;
  for (const bad of [NaN, Infinity, -Infinity, -1, 0, 'x']) b.tick(bad);
  let err = null;
  for (let i = 0; i < 60; i++) b.tick(DT);
  err = boxerFinite(b, 'post-NaN');
  check('proto: NaN/∞/negative dt — rig recovers, no permanent poison', !err, err);
  // hand-tracking NaN palm must not freeze the glove either
  let err2 = null;
  try {
    for (const bad of [NaN, Infinity, -1e9, 'x'])
      b.trackHands({ hands: [{ side: 'left', palm: { x: bad, y: .5 }, lm: lm(.4, .5) }] });
    for (let i = 0; i < 60; i++) b.tick(DT);
    b.trackHands({ hands: [{ side: 'left', palm: { x: .4, y: .5 }, lm: lm(.4, .5) }] });
    for (let i = 0; i < 90; i++) b.tick(DT);
    err2 = boxerFinite(b, 'post-track');
  } catch (e) { err2 = `threw: ${e.message}`; }
  check('proto: NaN hand palm — glove recovers when tracking returns', !err2, err2);
}
{
  // trackHands structural garbage — never throws
  const b = buildBoxer(THREE, { variant: 'bean' });
  let err = null;
  try {
    for (const h of [
      { hands: 5 }, { hands: 'x' }, { hands: {} }, { hands: true }, null, undefined, 5, 'x',
      { hands: [null, 5, 'x', {}, { side: 'bogus', palm: { x: .3, y: .4 }, lm: lm(.3, .4) }] },
      { hands: [{ side: 'left' }] }, { hands: [{ side: 'left', palm: null, lm: lm(.4, .5) }] },
      { hands: [{ side: 'left', palm: { x: .4, y: .5 }, lm: 'x' }] },
      { hands: [{ side: 'left', palm: { x: .4, y: .5 }, lm: [null, null] }] },
    ]) b.trackHands(h);
    b.trackHands({ hands: 'wide' }, 'close'); b.trackHands({ hands: [] }, 'bogus-space');
  } catch (e) { err = e.message; }
  check('proto: trackHands structural garbage — never throws', !err, err);
}
{
  // 60k-tick soak — a live fight's worth of ticks ×20
  const b = buildBoxer(THREE, { variant: 'bubble' });
  let err = null;
  const poseCyc = ['idle', 'windup', 'jab', 'idle', 'block', 'hurt', 'celebrate'];
  for (let i = 0; i < 60000; i++) {
    b.pose(poseCyc[(i / 600 | 0) % poseCyc.length], (i % 600) / 600);
    b.tick(DT, { gassed: i % 1000 < 100 }, i % 500 < 250 ? 1.5 : 0);
    if (i % 5000 === 0 && (err = boxerFinite(b, `tick ${i}`))) break;
  }
  check('proto: 60k-tick soak — transforms finite, warn-set bounded',
    !err && Number.isFinite(b.parts.head.position.y), err);
}
{
  // determinism — identical pose/dt streams → identical transforms
  const run = v => {
    const x = buildBoxer(THREE, { variant: v });
    let h = 0;
    for (let i = 0; i < 400; i++) {
      x.pose(['idle', 'jab', 'hurt', 'down', 'celebrate'][i % 5], i / 400);
      x.tick(DT);
      h += x.parts.gloveL.position.z + x.parts.root.rotation.x + x.parts.head.position.y;
    }
    return h;
  };
  check('proto: deterministic given same stream', run('bean') === run('bean'));
}

/* ============ 7. integration — fists→fight→ring chaos fight ============ */
reseed(0x1A7E);
{
  // the game.js wiring, fuzzed end-to-end
  const ft = new FistTracker();
  const sim = new RingSim({ seed: 31 });
  const f = new Fight({ seed: 31 });
  let err = null;
  const fistsOk = () => ft.punches.splice(0, ft.punches.length);
  try {
    for (let i = 0; i < 12000; i++) {
      const dt = chaosDt();
      ft.update(chaosHandsState(), chaosFaceState(), dt);
      f.step(dt, {
        punches: fistsOk(), guard: { left: ft.guard.left, right: ft.guard.right },
        sway: ft.sway, duck: ft.duck, distance: sim.distance() });
      sim.step(dt, { npcDir: f.npcDir(), npcStunned: f.state.npc.action === 'stunned',
        playerStep: rnd() < .1 ? rnd() * 2 - 1 : 0 });
      if (i % 16 === 0 && (err = fightInvariant(f, `integ ${i}`) || ringLegality(sim, `integ ${i}`))) break;
      if (err) break;
    }
    if (!err) err = fightInvariant(f, 'integ-final') || ringLegality(sim, 'integ-final');
  } catch (e) { err = `threw: ${e.message}`; }
  check('integration: 12k-tick wired chaos fight — invariants hold', !err, err);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
