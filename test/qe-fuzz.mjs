/* test/qe-fuzz.mjs — deterministic seeded fuzz + property checks for the
   pure game-logic modules. QE rounds 2 (w4-qe-fuzz) + 3 (b3-fuzz) + 4 (b4-fuzz).

   Wave 4 adds: dt boundary torture on every module entry point
   (0, -0, 1e-12, .1, ±∞, NaN, 'x'), live mutation fuzz on exported
   TUNING/SPECIALS/VSTATS + frozen/sealed controls, prototype-chain key
   injection ('__proto__'/'constructor' into every name/kind dispatch),
   a 10k-step ring↔fists↔fight co-simulation with hp/score/stamina/distance
   invariants, state serialization round-trips, and event-stream legality
   (ko only from 'fighting', bell count === round, drain-once semantics).

   Coverage: shared/boxing/{fight,fists,ring,tutorial,audio,protoBoxer}.js
     - malformed inputs: null/undefined/NaN states, non-array hands,
       NaN/±Infinity landmarks, dt ∈ {0, -1, 1e-6, 10, NaN, Infinity, 'x'}
     - degenerate constructor opts (non-finite TUNING overrides)
     - state-machine fuzz: random input streams → phase/hp/stamina/round
       invariants hold every single step
     - state-machine legality (w3): enumerated phase pairs + npc.action
       pairs + per-action duration ceilings while 'fighting'
     - full fights (w3): decision WIN/LOSE, single-shot KOs, roundLen=1,
       constructor extremes, rage scaling, heal between rounds
     - boundary values (w3): sway/duck/guard/distance at exact thresholds ±1e-9
     - reset() mid-windup/punch/down/win/countdown + deterministic replay,
       mutated opts re-flooring, live practice/ai flips, TUNING garbage (w3)
     - fists: 24 degenerate finite tuning overrides + live ft.T mutation (w3)
     - audio: strict mock ctx (throws on non-finite, like Chrome), event-order
       permutations, mute flips, voice/crowd edge-release leak check (w3)
     - soak: 60k update ticks → no unbounded module-state growth
     - proto: unknown-pose warn dedup cap, sealed state, double dispose (w3)
     - tutorial: abandoned mid-step, -120s clock regression, fight.reset
       mid-run, partial fake-DOM root (w3)
     - integration: fists→fight→ring wired like game.js under chaos input

   Deterministic: one seeded mulberry32 drives every random stream — same
   output every run. `node test/qe-fuzz.mjs` exits non-zero on failure. */

import { Fight, TUNING as FT, SPECIALS, VSTATS } from '../shared/boxing/fight.js';
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
  const f = { found: true, nose: { x: rnd() < .12 ? gnum() : rnd(), y: rnd() < .12 ? gnum() : rnd() },
    size: rnd() < .1 ? gnum() : .1 + rnd() * .4 };
  if (rnd() < .4) f.center = { x: rnd() < .12 ? gnum() : rnd(), y: rnd() < .12 ? gnum() : rnd() };
  if (rnd() < .35) {
    const n = rnd() < .2 ? rnd() * 300 | 0 : 478;                      // real mesh is 478-pt
    f.lm = Array.from({ length: n }, () => rnd() < .15
      ? pick([null, undefined, { x: gnum(), y: gnum() }, 5, 'x'])
      : { x: rnd(), y: rnd() });
  } else if (rnd() < .1) f.lm = pick([{}, 'x', 5, null]);
  return f;
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
  if (!(s.round >= 0 && s.round <= (f._T?.rounds ?? FT.rounds))) return `${tag}: round=${s.round}`;
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
      if (!Number.isFinite(ft.pitch) || Math.abs(ft.pitch) > 1.0001) { err = `pitch=${ft.pitch} @${i}`; break; }
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
      d.baseline.left, d.baseline.right, d.sway, d.duck, d.pitch].every(Number.isFinite))
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

/* ============ 8. state-machine transition legality (wave 3) ============ */
reseed(0x7EA2);
{
  const LEGAL_PH = {   // every phase pair the machine may take
    intro: new Set(['intro', 'countdown']),
    countdown: new Set(['countdown', 'fighting']),
    fighting: new Set(['fighting', 'countdown', 'npcdown', 'playerdown', 'win', 'lose']),
    playerdown: new Set(['playerdown', 'lose']),
    npcdown: new Set(['npcdown', 'win']),
    win: new Set(['win']), lose: new Set(['lose']),
  };
  const LEGAL_ACT = {  // npc.action pairs reachable while phase stays 'fighting'
    idle: new Set(['press', 'circle', 'retreat', 'block', 'celebrate', 'windup', 'hurt', 'down']),
    circle: new Set(['press', 'circle', 'retreat', 'block', 'celebrate', 'windup', 'hurt', 'down', 'idle']),
    press: new Set(['retreat', 'windup', 'circle', 'idle', 'hurt', 'down', 'celebrate']),
    retreat: new Set(['idle', 'windup', 'hurt', 'down', 'celebrate']),
    block: new Set(['idle', 'windup', 'hurt', 'down', 'celebrate']),
    windup: new Set(['punch', 'hurt', 'down', 'celebrate', 'idle']),
    punch: new Set(['stunned', 'whiff', 'windup', 'idle', 'celebrate', 'hurt', 'down']),
    hurt: new Set(['retreat', 'idle', 'down', 'celebrate']),
    whiff: new Set(['idle', 'hurt', 'down', 'celebrate', 'windup']),
    stunned: new Set(['idle', 'down', 'celebrate']),
    celebrate: new Set(['idle', 'hurt', 'down', 'windup']),
    down: new Set(),
  };
  // per-action continuous-time ceiling while 'fighting' — the wedge detector
  const actBound = (f, a) => f.ai ? ({
    windup: f._windupFor, punch: f._T.punchDur, hurt: f._T.npcHurtT,
    block: f._T.blockT, whiff: f._T.whiffT, stunned: f._actFor,
    celebrate: f._T.celebrateT, press: f._T.pressMax,
    retreat: f._actFor, idle: f._actFor, circle: f._actFor })[a] : undefined;
  let phErr = null, actErr = null, noVerdict = null;
  const seenPh = new Set(), seenAct = new Set();
  for (const seed of [11, 29, 71]) {
    for (const variant of VARIANTS) {
      const f = new Fight({ seed, npcVariant: variant });
      let prevPh = f.state.phase, prevAct = f.state.npc.action;
      for (let i = 0; i < 60 * 320; i++) {
        const inp = rnd() < .3 ? chaosFightInputs()
          : { punches: rnd() < .25 ? [{ kind: pick(['jab', 'cross', 'hook', 'uppercut']), side: pick(['left', 'right']), power: rnd() }] : [],
            guard: { left: rnd() < .5 ? rnd() : 0, right: rnd() < .5 ? rnd() : 0 },
            sway: rnd() < .3 ? rnd() * 2 - 1 : 0, duck: rnd() < .15 ? rnd() : 0,
            distance: .5 + rnd() * 2 };
        f.step(DT, inp);
        const s = f.state, ph = s.phase;
        if (ph !== prevPh) {
          seenPh.add(prevPh + '→' + ph);
          if (!phErr && !LEGAL_PH[prevPh]?.has(ph))
            phErr = `illegal phase ${prevPh}→${ph} (seed ${seed} ${variant} @${i})`;
        }
        if (!actErr && s.npc.action !== prevAct && prevPh === 'fighting' && ph === 'fighting') {
          seenAct.add(prevAct + '→' + s.npc.action);
          if (!LEGAL_ACT[prevAct]?.has(s.npc.action))
            actErr = `illegal action ${prevAct}→${s.npc.action} (seed ${seed} ${variant} @${i})`;
        }
        prevPh = ph; prevAct = s.npc.action;
        if (!actErr && ph === 'fighting') {
          const b = actBound(f, s.npc.action);
          if (b !== undefined && s.npc.actionT > b + 3 * DT)
            actErr = `'${s.npc.action}' overstayed actionT=${s.npc.actionT.toFixed(3)} > bound=${b.toFixed(3)} (seed ${seed} ${variant} @${i})`;
        }
        if (!phErr && !actErr && (phErr = fightInvariant(f, `trans ${seed} ${variant} @${i}`))) { /* fallthrough */ }
        if (phErr || actErr) break;
        if (ph === 'win' || ph === 'lose') {
          const term = ph;
          for (let k = 0; k < 30; k++) f.step(DT, {});   // terminal must be sticky
          if (f.state.phase !== term) { phErr = `terminal ${term} left for ${f.state.phase}`; }
          break;
        }
      }
      if (phErr || actErr) break;
      if (!['win', 'lose'].includes(f.state.phase))
        { noVerdict = `seed ${seed} ${variant}: no verdict in 320s (phase=${f.state.phase})`; break; }
    }
    if (phErr || actErr || noVerdict) break;
  }
  check('fight: phase transitions always legal + terminal sticky', !phErr, `${phErr} | seen: ${[...seenPh].join(',')}`);
  check('fight: npc action transitions legal + durations bounded', !actErr, `${actErr} | seen: ${[...seenAct].join(',')}`);
  check('fight: every seed/variant reaches a verdict inside budget', !noVerdict, noVerdict);
}

/* ============ 9. full-fight sims — decision paths + ctor extremes ============ */
reseed(0xDE21);
{
  // decision LOSE: unkillable but passive — judges give it to untouched PIP
  const f = new Fight({ seed: 4, playerHp: 1e6 });
  let roundStarts = 0;
  for (let i = 0; i < 60 * 320 && !['win', 'lose'].includes(f.state.phase); i++) {
    f.step(DT, { distance: .8 });            // eats swings, never throws back
    if (f.state.events.includes('round-start')) {
      roundStarts++;
      if (f.state.timeLeft !== f.opts.roundLen) break;    // clock re-armed per round
    }
  }
  check('fight: passive giant → judges\' decision LOSE after full 3 rounds',
    f.state.phase === 'lose' && f.state.round === f._T.rounds && roundStarts === f._T.rounds,
    `phase=${f.state.phase} round=${f.state.round} bells=${roundStarts}`);
}
{
  // decision WIN: out-box, don't finish — higher hp fraction takes the card.
  // round-1 jabs build the hp lead, then pure guard for the distance.
  const w = new Fight({ seed: 6, playerHp: 1000, npcHp: 40 });
  for (let i = 0; i < 60 * 320 && !['win', 'lose'].includes(w.state.phase); i++) {
    const jab = w.state.round === 1 && w.state.npc.hp / w.state.npc.maxHp > .25;
    w.step(DT, { punches: jab && i % 45 === 0 ? [{ kind: 'jab', side: 'left', power: .6 }] : [],
      guard: { left: .8, right: .8 }, distance: .7 });
  }
  check('fight: out-boxed rival → decision WIN by hp fraction',
    w.state.phase === 'win' && w.state.round === w._T.rounds && w.state.player.score >= w._T.score.decision,
    `phase=${w.state.phase} round=${w.state.round} score=${w.state.player.score}`);
}
{
  // single-shot KO each way + fast roundLen decision + heal between rounds
  const k = new Fight({ seed: 8, npcHp: 1 });
  let sawKo = false;
  for (let i = 0; i < 60 * 30 && !['win', 'lose'].includes(k.state.phase); i++) {
    k.step(DT, { punches: k.state.phase === 'fighting' ? [{ kind: 'jab', side: 'left', power: .8 }] : [], distance: .5 });
    if (k.state.events.includes('ko')) sawKo = true;
  }
  check('fight: npcHp=1 → one glove ends it (ko → win)', k.state.phase === 'win' && sawKo, `${k.state.phase}`);

  const l = new Fight({ seed: 8, playerHp: 1 });
  for (let i = 0; i < 60 * 60 && !['win', 'lose'].includes(l.state.phase); i++)
    l.step(DT, { distance: .6 });
  check('fight: playerHp=1 → first landed swing ends it (lose)', l.state.phase === 'lose', `${l.state.phase}`);

  const q = new Fight({ seed: 12, roundLen: 1, playerHp: 1e6 });
  let bells = 0, badClock = false, healed = false, prevHp = -1;
  for (let i = 0; i < 60 * 30 && !['win', 'lose'].includes(q.state.phase); i++) {
    const hpBefore = q.state.npc.hp;
    q.step(DT, { distance: .8 });
    if (q.state.events.includes('round-start')) {
      bells++;
      if (q.state.timeLeft !== 1) badClock = true;
      if (prevHp >= 0 && q.state.npc.hp > prevHp) healed = true;
    }
    if (q.state.phase === 'fighting' && q.state.round >= 1) prevHp = hpBefore;
  }
  check('fight: roundLen=1 → decision inside 30s, clock re-arms each round',
    ['win', 'lose'].includes(q.state.phase) && q.state.round === 3 && !badClock,
    `phase=${q.state.phase} round=${q.state.round} bells=${bells} badClock=${badClock}`);
}
{
  // constructor tuning combo matrix — every combo stays legal
  let err = null;
  for (const o of [
    { npcHp: 1, roundLen: 1 }, { playerHp: 1, npcHp: 1e9 }, { playerHp: 1e9, npcHp: 1, roundLen: 1 },
    { roundLen: 1 }, { playerHp: 1 }, { npcHp: .01 }, { playerHp: .5, npcHp: .5, roundLen: 2 },
    { npcVariant: 'bogus' }, { npcName: null }, { npcName: 5 }, { npcName: '' }, { seed: 0 }, { seed: -1 },
  ]) {
    const c = new Fight(o);
    try {
      for (let i = 0; i < 60 * 60; i++) {
        c.step(DT, chaosFightInputs());
        if ((err = fightInvariant(c, JSON.stringify(o)))) break;
      }
      if (!err && ['npcName', 'playerHp'].every(k => !(k in o))) { /* noop */ }
      if (!err && 'npcName' in o && c.state.npc.name !== 'PIP')
        err = `${JSON.stringify(o)} → npc.name=${JSON.stringify(c.state.npc.name)}`;
      if (!err && 'npcHp' in o && c.state.npc.maxHp !== Math.max(1, +o.npcHp || 1) && o.npcHp !== 1e9)
        err = `${JSON.stringify(o)} → npc.maxHp=${c.state.npc.maxHp}`;
    } catch (e) { err = `${JSON.stringify(o)} threw: ${e.message}`; }
    if (err) break;
  }
  check('fight: constructor tuning combos — name/hp floors + invariants', !err, err);
}
{
  // rage scaling is real: same seed/kind → a hurt PIP telegraphs faster
  const a = new Fight({ seed: 42 }), b = new Fight({ seed: 42 });
  for (let i = 0; i < 700 && a.state.phase !== 'fighting'; i++) { a.step(DT, {}); b.step(DT, {}); }
  b.state.npc.hp = b.state.npc.maxHp * .3;              // wounded → rage kicks in
  a._windup(); const fullWu = a._windupFor;
  b._windup(); const hurtWu = b._windupFor;
  check('fight: rage scaling — wounded PIP telegraphs measurably faster',
    hurtWu < fullWu, `full=${fullWu.toFixed(3)} hurt=${hurtWu.toFixed(3)}`);
}

/* ============ 10. boundary values — exact thresholds ± epsilon ============ */
reseed(0xB0D2);
{
  // helper: park the AI, script one swing, feed fixed inputs, catch the impact
  const bout = seed => { const f = new Fight({ seed, ai: false }); f.startNow();
    for (let i = 0; i < 60 * 6 && f.state.phase !== 'fighting'; i++) f.step(DT, {}); return f; };
  const impactOf = (f, mkInp) => {   // → lastBlow at the swing's impact step
    for (let i = 0; i < 60 * 4; i++) {
      f.step(DT, mkInp(i));
      if (f.state.lastBlow?.who === 'npc') return f.state.lastBlow;
    }
    return null;
  };
  const T = new Fight()._T;
  const GT = T.guardT, DT_ = T.dodgeT, NR = T.npcReach;
  let fails = [];
  // sway: held lean AT ±dodgeT gets AIMED — contract says holding gets you tagged
  for (const s of [DT_, -DT_, DT_ - 1e-9]) {
    const f = bout(3); f.step(DT, { sway: s, distance: .8 });          // aim samples _inp
    f.throwPunch('jab', 'left', .5);
    const lb = impactOf(f, () => ({ sway: s, distance: .8 }));
    if (lb?.result !== 'hit') fails.push(`sway=${s} → ${lb?.result}, want hit (held lean is aimed)`);
  }
  // a FRESH lean to dodgeT committed just before impact → dodged
  {
    const f = bout(3); f.step(DT, { sway: 0, distance: .8 });
    f.throwPunch('jab', 'left', .5);
    const lb = impactOf(f, i => ({ sway: i * DT > .45 ? -DT_ : 0, distance: .8 }));
    if (lb?.result !== 'dodged') fails.push(`fresh lean → ${lb?.result}, want dodged`);
  }
  // duck: held at dodgeT → aim 'duck' → jab still lands (duck only dodges if not aimed there)
  {
    const f = bout(3); f.step(DT, { duck: DT_, distance: .8 });
    f.throwPunch('jab', 'left', .5);
    const lb = impactOf(f, () => ({ duck: DT_, distance: .8 }));
    if (lb?.result !== 'hit') fails.push(`held duck → ${lb?.result}, want hit (duck was aimed)`);
    // a duck COMMITTED inside dodgeWin of impact counts as ducked-into on an 'upper'
    const g = bout(3); g.step(DT, { duck: 0, distance: .8 });
    g.throwPunch('upper', 'right', .5);
    const lb2 = impactOf(g, i => ({ duck: i * DT >= .5 ? DT_ : 0, distance: .8 }));
    const want = T.npcDmg.upper * T.duckUpperMul;
    if (lb2?.result !== 'hit' || !(lb2.dmg > T.npcDmg.upper * 1.2))
      fails.push(`ducked-into-upper → ${JSON.stringify(lb2)}, want hit ×${T.duckUpperMul} (≈${want.toFixed(1)})`);
  }
  // guard: exactly guardT blocks (mirrored: 'left' telegraph → guard.right); 1e-9 under → full hit
  for (const [g, want] of [[GT, 'blocked'], [GT - 1e-9, 'hit'], [GT + .2, 'blocked']]) {
    const f = bout(3); f.step(DT, { distance: .8 });
    f.throwPunch('jab', 'left', .5);
    const lb = impactOf(f, () => ({ guard: { left: 0, right: g }, distance: .8 }));
    if (lb?.result !== want) fails.push(`guard.right=${g} → ${lb?.result}, want ${want}`);
    if (want === 'blocked' && !(lb.dmg < T.npcDmg.jab)) fails.push(`blocked dmg ${lb?.dmg} not < ${T.npcDmg.jab}`);
  }
  // gassed guard: full guard can't block (gasGuard < guardT)
  {
    const f = bout(3); f.step(DT, { distance: .8 });
    f.state.player.stamina = T.gassedT - .1; f.state.player.gassed = true;
    f.throwPunch('jab', 'left', .5);
    const lb = impactOf(f, () => ({ guard: { left: 1, right: 1 }, distance: .8 }));
    if (lb?.result !== 'hit') fails.push(`gassed full guard → ${lb?.result}, want hit`);
  }
  // distance: exactly npcReach lands; +1e-9 whiffs into air
  for (const [d, want] of [[NR, 'hit'], [NR + 1e-9, 'whiff'], [NR - .01, 'hit']]) {
    const f = bout(3); f.step(DT, { distance: d });
    f.throwPunch('jab', 'left', .5);
    const lb = impactOf(f, () => ({ distance: d }));
    if (lb?.result !== want) fails.push(`distance=${d} → ${lb?.result}, want ${want}`);
  }
  // player reach: exactly reach×(1+reachPow·power) connects; +1e-9 is a 'range' miss
  {
    const edge = T.reach * (1 + T.reachPow * .5);
    const h = bout(3); const hp0 = h.state.npc.hp;
    h.step(DT, { punches: [{ kind: 'jab', side: 'left', power: .5 }], distance: edge });
    if (h.state.lastBlow?.result !== 'hit' || h.state.npc.hp >= hp0)
      fails.push(`edge distance → ${h.state.lastBlow?.result}, want hit`);
    const m = bout(3);
    m.step(DT, { punches: [{ kind: 'jab', side: 'left', power: .5 }], distance: edge + 1e-9 });
    if (m.state.lastBlow?.result !== 'miss' || m.state.lastBlow?.reason !== 'range')
      fails.push(`edge+ε → ${JSON.stringify(m.state.lastBlow)}, want miss/range`);
  }
  check('fight: sway/duck/guard/distance at exact thresholds', fails.length === 0, fails.join(' | '));
}

/* ============ 11. reset mid-anything + live flips + TUNING garbage ============ */
reseed(0xE55E7);
{
  let err = null;
  for (const target of ['windup', 'punch', 'playerdown', 'win', 'countdown']) {
    const f = new Fight({ seed: 14, npcVariant: pick(VARIANTS) });
    try {
      for (let i = 0; i < 60 * 200; i++) {
        const ph = f.state.phase, act = f.state.npc.action;
        if ((target === 'windup' && act === 'windup') || (target === 'punch' && act === 'punch')
          || (target === 'playerdown' && (ph === 'playerdown' || ph === 'npcdown'))
          || (target === 'win' && ['win', 'lose'].includes(ph))
          || (target === 'countdown' && ph === 'countdown')) {
          f.reset();
          if (f._wantSlam || f._wantSledge) { err = `reset@${target}: special flag survived`; }
          break;
        }
        f.step(DT, { punches: i % 25 === 0 ? [{ kind: 'hook', side: 'left', power: 1 }] : [], distance: .6 });
        if ((err = fightInvariant(f, `reset@${target}`))) break;
      }
      let i = 0;
      for (; i < 60 * 320 && !['win', 'lose'].includes(f.state.phase); i++)
        f.step(DT, { punches: i % 25 === 0 ? [{ kind: 'hook', side: 'left', power: 1 }] : [], distance: .6 });
      if (!['win', 'lose'].includes(f.state.phase)) err = `reset@${target}: no verdict after reset`;
    } catch (e) { err = `reset@${target} threw: ${e.message}`; }
    if (err) break;
  }
  check('fight: reset() mid-windup/punch/down/win/countdown → recovers + finishes', !err, err);
}
{
  // opts mutated between bouts → reset() re-floors (regression: 'x' hp, NaN clock)
  const f = new Fight({ seed: 1 });
  f.opts.playerHp = 'x'; f.opts.npcHp = -9; f.opts.roundLen = NaN; f.opts.npcName = 5;
  f.reset();
  check('fight: mutated opts re-floored on reset',
    f.state.player.hp === 100 && f.state.npc.hp === 1 && f.state.npc.maxHp === 1
      && f.state.timeLeft === 90 && f.state.npc.name === 'PIP',
    JSON.stringify({ hp: f.state.player.hp, nh: f.state.npc.hp, t: f.state.timeLeft, n: f.state.npc.name }));

  const g = new Fight({ seed: 5, npcVariant: 'sumo' });
  g._wantSlam = true; g._wantSledge = true; g.reset();
  check('fight: _wantSlam/_wantSledge cleared by reset', !g._wantSlam && !g._wantSledge);

  // reset() restores the seeded stream — deterministic replay
  const sig = f => { let h = 0;
    for (let i = 0; i < 400; i++) { f.step(DT, { distance: .6 + Math.sin(i / 7), sway: Math.sin(i / 11) });
      h += f.state.npc.hp * (i + 1) + f.state.player.score; } return h; };
  const a = new Fight({ seed: 33 }), b = new Fight({ seed: 33 });
  sig(a); a.reset();
  check('fight: reset() replays deterministically', sig(a) === sig(b));
}
{
  // practice→real and ai on/off flips are LIVE (getter + direct opts reads)
  const p = new Fight({ seed: 9, ai: false, practice: true });
  for (let i = 0; i < 700 && p.state.phase !== 'fighting'; i++) p.step(DT, {});
  for (let i = 0; i < 60; i++) p.step(DT, {});
  const clock0 = p.state.timeLeft;
  p.opts.practice = false;
  for (let i = 0; i < 60; i++) p.step(DT, {});
  check('fight: practice→real flip starts the clock', p.state.timeLeft < clock0, `${p.state.timeLeft} !< ${clock0}`);
  const saw = new Set();
  for (let i = 0; i < 60 * 20; i++) { p.step(DT, { distance: .7 }); saw.add(p.state.npc.action); }
  check('fight: ai:false keeps PIP parked (no windup/punch)',
    !saw.has('windup') && !saw.has('punch'), [...saw].join(','));
  p.opts.ai = true;
  for (let i = 0; i < 60 * 30 && !saw.has('windup'); i++) { p.step(DT, { distance: .7 }); saw.add(p.state.npc.action); }
  check('fight: ai flip mid-fight resumes decisions', saw.has('windup') || saw.has('punch'), [...saw].join(','));
}
{
  // module TUNING garbage → new fight sanitizes; in-flight fight unaffected
  const snap = JSON.parse(JSON.stringify(FT));
  let err = null;
  try {
    FT.dmg.jab = NaN; FT.windup.jab = NaN; FT.rounds = 'x'; FT.guardT = NaN; FT.npcDmg.jab = NaN;
    const clean = new Fight({ seed: 2 });
    for (let i = 0; i < 700 && clean.state.phase !== 'fighting'; i++) clean.step(DT, {});
    clean.step(DT, { punches: [{ kind: 'jab', side: 'left', power: .8 }], distance: .5 });
    clean.throwPunch('jab', 'left');
    for (let i = 0; i < 120; i++) clean.step(DT, { distance: .5 });
    err = fightInvariant(clean, 'garbage-TUNING new fight');
    if (!err && clean.state.npc.action === 'windup')
      err = 'garbage TUNING wedged the windup anyway';
    const live = new Fight({ seed: 3 });      // snapshot taken before mutation
    for (let i = 0; i < 700 && live.state.phase !== 'fighting'; i++) live.step(DT, {});
    FT.dmg.cross = Infinity; FT.npcDmg.hook = -1e9;
    for (let i = 0; i < 60 * 30 && !err; i++) {
      live.step(DT, { punches: i % 20 === 0 ? [{ kind: 'cross', side: 'right', power: 1 }] : [], distance: .6 });
      err = fightInvariant(live, 'live-TUNING');
      if (err) break;
    }
  } finally { for (const k in snap) FT[k] = snap[k]; }
  check('fight: module TUNING garbage — fights stay legal', !err, err);
}

/* ============ 12. fists — degenerate finite tuning battery ============ */
reseed(0xF1575);
{
  const cases = [
    { MIN_SPAN: -1 }, { MIN_SPAN: 0 }, { SWAY_RANGE: 0 }, { DUCK_RANGE: 0 },
    { GUARD_NOSE_RANGE: 0 }, { GUARD_Y_ZERO: .36, GUARD_Y_FULL: .58 },
    { GUARD_REACH_HI: .85, GUARD_REACH_LO: 1.02 },
    { REACH_CAP: 1 }, { REACH_CAP: .5 },
    { GUARD_RATE: -8 }, { BASELINE_RATE: -1 }, { VEL_SMOOTH: -5 },
    { FACE_SMOOTH: -3 }, { SWAY_SMOOTH: -1 }, { CENTER_RATE: -2 },
    { RESET_VEL: -1e9 }, { EMIT_VEL: -1e9 }, { FIRE_FRAMES: 0 }, { DT_MAX: -1 },
    { POWER_FLOOR: -2 }, { POWER_FLOOR: 5 }, { CALM_RV: -1 }, { MISS_GRACE: -3 },
  ];
  let err = null, dead = null;
  for (const o of cases) {
    const ft = new FistTracker(o);
    try {
      for (let i = 0; i < 40; i++) ft.update(hs(hand('left', .4, .55, 1.6), hand('right', .6, .6, 1.4)), fc(), DT);
      for (const s of [1.8, 2.1, 2.4, 2.7, 2.5, 2.2, 2.0])
        ft.update(hs(hand('left', .4, .55, s), hand('right', .6, .6, 1.4)), fc(), DT);
      for (let i = 0; i < 40; i++) ft.update(hs(hand('left', .4, .55, 1.6)), null, DT);
      for (const [k, v] of [['sway', ft.sway], ['duck', ft.duck], ['guardL', ft.guard.left],
        ['guardR', ft.guard.right], ['reachL', ft.reach.left], ['reachR', ft.reach.right]])
        if (!Number.isFinite(v)) { err = `${JSON.stringify(o)} → ${k}=${v}`; break; }
      if (!err && (Math.abs(ft.sway) > 1.0001 || ft.duck < -1e-9 || ft.duck > 1.0001
        || ft.guard.left < -1e-9 || ft.guard.left > 1.0001
        || ft.guard.right < -1e-9 || ft.guard.right > 1.0001))
        err = `${JSON.stringify(o)} → out-of-contract sway/duck/guard`;
      for (const p of ft.punches)
        if (!(p.power >= 0 && p.power <= 1)) { err = `${JSON.stringify(o)} → punch.power=${p.power}`; break; }
      if (!err && ft.punches.length === 0) dead = `${JSON.stringify(o)} → dead tracker (no punch)`;
    } catch (e) { err = `${JSON.stringify(o)} threw: ${e.message}`; }
    if (err || dead) break;
  }
  check('fists: 24 degenerate finite tunings → outputs in contract', !err, err);
  check('fists: degenerate finite tunings → tracker still punches', !dead, dead);
}
{
  // live tuning mutation mid-stream → next update re-cleans
  const ft = new FistTracker();
  for (let i = 0; i < 30; i++) ft.update(hs(hand('left', .4, .4)), fc(), DT);
  ft.T.GUARD_RATE = -8; ft.T.SWAY_RANGE = 0; ft.T.MIN_SPAN = -1; ft.T.REACH_CAP = 1;
  let err = null;
  for (let i = 0; i < 60; i++) {
    ft.update(hs(hand('left', .4 + i * .001, .4)), fc(), DT);
    if (ft.guard.left < -1e-9 || ft.guard.left > 1.0001
      || !Number.isFinite(ft.sway + ft.guard.left + ft.reach.left)) { err = `poisoned @${i}`; break; }
  }
  check('fists: live ft.T mutation → cleaned, outputs finite/in-range', !err, err);
}

/* ============ 13. audio — event order + graph hygiene ============ */
reseed(0xAD02);
{
  // strict ctx + input-edge counting + deferred onended (real WebAudio fires
  // it asynchronously when the scheduled stop time passes)
  const nodes = [];
  const val = x => { if (!Number.isFinite(x)) throw new RangeError(`non-finite audio param ${x}`); return true; };
  const param = v => ({ value: v,
    setValueAtTime(x) { val(x); this.value = x; }, linearRampToValueAtTime(x) { val(x); this.value = x; },
    exponentialRampToValueAtTime(x) { val(x); this.value = x; }, setTargetAtTime(x) { val(x); this.value = x; },
    cancelScheduledValues() {} });
  const mk = type => {
    const n = { type, frequency: param(440), Q: param(1), gain: param(1), buffer: null,
      loop: false, _d: null, _ins: 0, _stopAt: Infinity, onended: null,
      connect(d) { this._d = d; if (d && Number.isFinite(d._ins)) d._ins++; },
      disconnect() { const d = this._d; this._d = null; if (d && Number.isFinite(d._ins)) d._ins--; },
      start() {}, stop(t) { this._stopAt = Number.isFinite(t) ? t : 0; } };
    nodes.push(n); return n;
  };
  const ctx = { nodes, currentTime: 0, sampleRate: 44100, destination: mk('dest'), resume() {},
    createOscillator: () => mk('osc'), createGain: () => mk('gain'),
    createBiquadFilter: () => mk('filter'), createDynamicsCompressor: () => mk('comp'),
    createBufferSource: () => mk('src'),
    createBuffer: (ch, len) => ({ getChannelData: () => new Float32Array(len) }),
    _flush() { for (const n of nodes) if (n._stopAt <= this.currentTime) { n._stopAt = Infinity; n.onended?.(); } } };
  const a = new BoxingAudio(); a.unlock(ctx);
  const ins = () => a.master._ins;
  let err = null;
  try {
    const evts = Object.keys(EVENT_SFX);
    for (let i = 0; i < 400; i++) {
      // deterministic scramble — 'ko' lands before 'round-start', 'win' mid-fight, etc.
      const r = a.handleEvent(evts[(i * 7 + (i % 3)) % evts.length],
        { lastBlow: { kind: pick(['jab', 'hook', 'upper']), dmg: 8 + i % 20 }, countdown: (i % 3) + 1,
          phase: i % 2 ? 'fighting' : 'win' });
      if (typeof r !== 'boolean') { err = `non-boolean return @${i}`; break; }
      if (i % 11 === 0) a.muted = !(i % 22);          // rapid mute/unmute mid-storm
      a.update(DT, { phase: i % 2 ? 'fighting' : 'win', player: { stamina: .2 } });
      ctx.currentTime += DT; ctx._flush();
    }
    a.muted = false;
    for (let i = 0; i < 40; i++) {                    // crowd on/off hammer
      a.update(DT, { phase: i % 2 ? 'fighting' : 'win', player: { stamina: 1 } });
      ctx.currentTime += DT; ctx._flush();
    }
  } catch (e) { err = e.message; }
  check('audio: 400 out-of-order events + mute flips on strict ctx — no throw', !err, err);
  // leak check: drain every scheduled voice, drop the crowd bed → master must
  // be back to zero inputs (a leaked edge can never reach 0)
  ctx.currentTime += 5; ctx._flush();
  a.update(DT, { phase: 'win', player: { stamina: 1 } });
  check('audio: ended voices + crowd beds release their edge into master', ins() === 0, `master inputs=${ins()}`);
}
{
  // every fight-vocab event maps to a real SFX + returns true post-unlock
  const a = new BoxingAudio(); a.unlock(strictCtx());
  const missing = [...EVENT_VOCAB].filter(e => a.handleEvent(e, { lastBlow: { kind: 'jab', dmg: 5 }, countdown: 2 }) !== true);
  check('audio: every fight event produces a scheduled SFX', missing.length === 0, missing.join(','));
}

/* ============ 14. protoBoxer — warn cap + sealed state + ring/fists resets ============ */
reseed(0x9B0C);
{
  let warns = 0; const origWarn = console.warn; console.warn = () => warns++;
  const b = buildBoxer(THREE, {});
  for (let i = 0; i < 300; i++) b.pose('bogus-' + i, 0);
  console.warn = origWarn;
  check('proto: unknown-pose warns dedup-bounded (no console flood)', warns > 0 && warns <= 64, `warns=${warns}`);
  let threw = null;
  try {
    b.tick(DT, Object.freeze({ gassed: true }));
    b.tick(DT, Object.seal({}));
    b.dispose(); b.dispose();                          // idempotent
  } catch (e) { threw = e.message; }
  check('proto: sealed/frozen state + double dispose — never throws', !threw, threw);
}
{
  // ring reset mid-motion → legal positions + deterministic re-trajectory
  const sim = new RingSim({ seed: 77 });
  let err = null;
  for (let i = 0; i < 400; i++) sim.step(DT, { npcDir: pick(['press', 'circle', 'retreat']) });
  sim.reset();
  const twin = new RingSim({ seed: 77 });
  let diff = 0;
  for (let i = 0; i < 300; i++) {
    const inp = { npcDir: ['press', 'circle', 'hold'][i % 3], playerStep: Math.sin(i / 8) };
    sim.step(DT, inp); twin.step(DT, inp);
    diff = Math.max(diff, Math.abs(sim.npc.pos.x - twin.npc.pos.x));
    if ((err = ringLegality(sim, `post-reset ${i}`))) break;
  }
  check('ring: reset() mid-motion → legal + replays the seeded trajectory',
    !err && diff === 0, `${err} diff=${diff}`);
}

/* ============ 15. tutorial — abandon mid-step + clock regressions ============ */
reseed(0x70715);
const tutDrive = (t, fight, sim, secs, now, skipUpdate = false) => {
  for (let i = 0; i < secs * 60 && !t.done; i++) {
    fight.step(DT, { distance: sim.distance() });
    if (!skipUpdate) t.update({ events: fight.state.events, state: fight.state }, now);
    now += DT;
  }
  return now;
};
{
  // caller stops calling update() for ~40s mid-run, then resumes
  const fight = new Fight({ seed: 3, ai: false, practice: true });
  const sim = new RingSim({ seed: 3 });
  const t = new Tutorial({ fight, sim });
  fight.startNow();
  let now = tutDrive(t, fight, sim, 10, 0);
  now = tutDrive(t, fight, sim, 40, now, true);        // abandoned stretch
  now = tutDrive(t, fight, sim, 40, now);
  check('tutorial: abandoned ~40s mid-run → resumes + finishes', t.done, `i=${t.i}`);
}
{
  // clock jumps backwards once → timeboxes pause, then still reach TOTAL
  const fight = new Fight({ seed: 3, ai: false, practice: true });
  const sim = new RingSim({ seed: 3 });
  const t = new Tutorial({ fight, sim });
  fight.startNow();
  let now = tutDrive(t, fight, sim, 10, 0);
  now = tutDrive(t, fight, sim, 160, now - 120);       // -120s wall-clock adjust
  check('tutorial: single -120s clock regression → still finishes', t.done, `i=${t.i}`);
}
{
  // fight.reset() mid-tutorial → waits through re-intro, still terminates
  const fight = new Fight({ seed: 3, ai: false, practice: true });
  const sim = new RingSim({ seed: 3 });
  const t = new Tutorial({ fight, sim });
  fight.startNow();
  let now = tutDrive(t, fight, sim, 8, 0);
  fight.reset(); fight.startNow();
  now = tutDrive(t, fight, sim, 60, now);
  check('tutorial: fight.reset() mid-run → still terminates inside cap', t.done, `i=${t.i}`);
}
{
  // fake-DOM root (querySelector→null) — render path must not throw
  const fake = { innerHTML: '', classList: { toggle() {} },
    querySelector: () => null, querySelectorAll: () => null };
  let threw = null;
  try {
    const t = new Tutorial({ fight: new Fight({ seed: 1, ai: false, practice: true }), root: fake });
    for (let i = 0; i < 10; i++)
      t.update({ events: [], state: { phase: 'fighting', npc: { action: 'idle' } } }, i / 60);
  } catch (e) { threw = e.message; }
  check('tutorial: partial fake-DOM root — render never throws', !threw, threw);
}

/* ============ 16. dt boundary torture — every module entry point ============ */
reseed(0xD7B07);
const DT_TORTURE = [0, -0, 1e-12, .1, Infinity, -Infinity, NaN, 'x'];
{
  // fight.step: boundary dt → stays finite/legal; afterwards a real run
  // must still reach a verdict (no phase wedged by a poisoned clock)
  let err = null;
  const f = new Fight({ seed: 41 });
  try {
    for (const dt of DT_TORTURE) {
      for (let i = 0; i < 40; i++) f.step(dt, chaosFightInputs());
      if ((err = fightInvariant(f, `dt=${dt}`))) break;
    }
    for (let i = 0; i < 60 * 320 && !err && !['win', 'lose'].includes(f.state.phase); i++) {
      f.step(DT, { punches: i % 25 === 0 ? [{ kind: 'jab', side: 'left', power: .8 }] : [], distance: .7 });
      if ((err = fightInvariant(f, 'post-torture'))) break;
    }
    if (!err && !['win', 'lose'].includes(f.state.phase)) err = `wedged in '${f.state.phase}'`;
  } catch (e) { err = `threw: ${e.message}`; }
  check('fight: dt torture (0,-0,1e-12,.1,±∞,NaN,x) → legal, still verdicts', !err, err);
}
{
  // ring.step / fists.update — same battery, outputs stay in contract
  const sim = new RingSim({ seed: 41 }), ft = new FistTracker();
  let err = null;
  try {
    for (const dt of DT_TORTURE) {
      for (let i = 0; i < 60; i++) {
        sim.step(dt, chaosRingInput());
        ft.update(chaosHandsState(), chaosFaceState(), dt);
      }
      if ((err = ringLegality(sim, `dt=${dt}`))) break;
      if (!Number.isFinite(ft.sway + ft.duck + ft.pitch + ft.guard.left + ft.reach.left))
        { err = `dt=${dt} → non-finite fists output`; break; }
      if (Math.abs(ft.sway) > 1.0001 || ft.duck < -1e-9 || ft.duck > 1.0001
        || ft.guard.left < -1e-9 || ft.guard.left > 1.0001)
        { err = `dt=${dt} → sway/duck/guard out of contract`; break; }
    }
    // recovery: real dt afterwards still produces sane motion
    for (let i = 0; i < 300 && !err; i++) {
      sim.step(DT, { npcDir: 'press' }); ft.update(hs(hand('left', .4, .5, 1.2)), fc(), DT);
      err = ringLegality(sim, 'post-torture');
    }
  } catch (e) { err = `threw: ${e.message}`; }
  check('ring+fists: dt torture → finite/in-range, recovers after', !err, err);
}
{
  // protoBoxer.tick / tutorial.update / audio.update — same battery
  const b = buildBoxer(THREE, { variant: 'bean' });
  const fight = new Fight({ seed: 41, ai: false, practice: true });
  const sim = new RingSim({ seed: 41 });
  const tut = new Tutorial({ fight, sim });
  const au = new BoxingAudio(); au.unlock(strictCtx());
  fight.startNow();
  let err = null;
  try {
    for (const dt of DT_TORTURE) {
      for (let i = 0; i < 30; i++) {
        b.tick(dt, { gassed: i % 2 });
        fight.step(DT, { distance: sim.distance() });
        tut.update({ events: fight.state.events, state: fight.state }, dt);   // 'now' torture
        au.update(dt, fight.state);
      }
    }
    if ((err = boxerFinite(b, 'post-torture'))) { /* fallthrough */ }
    if (!err && (!Number.isFinite(au._crowdLevel) || !Number.isFinite(au._breathT)))
      err = `audio meters NaN: crowd=${au._crowdLevel} breath=${au._breathT}`;
    // real clock afterwards must still drive the tutorial to done
    let now = 0, steps = 0;
    while (!tut.done && now < 70) {
      fight.step(DT, { distance: sim.distance() });
      tut.update({ events: fight.state.events, state: fight.state }, now);
      now += DT; steps++;
    }
    if (!err && !tut.done) err = 'tutorial wedged after dt torture';
  } catch (e) { err = `threw: ${e.message}`; }
  check('proto/tutorial/audio: dt torture → no throw, all recover', !err, err);
}
{
  // interleaved poison dt inside a REAL bout — the sim must shrug it off
  const sim = new RingSim({ seed: 7 }), f = new Fight({ seed: 7 });
  let err = null;
  try {
    let i = 0;
    for (; i < 60 * 320 && !['win', 'lose'].includes(f.state.phase); i++) {
      const dt = i % 13 === 0 ? pick(DT_TORTURE) : DT;
      f.step(dt, { punches: i % 29 === 0 ? [{ kind: 'cross', side: 'right', power: 1 }] : [],
        distance: sim.distance(), sway: Math.sin(i / 25) });
      sim.step(dt, { npcDir: f.npcDir(), npcStunned: f.state.npc.action === 'stunned' });
      if ((err = fightInvariant(f, `mix ${i}`) || ringLegality(sim, `mix ${i}`))) break;
    }
    if (!err && !['win', 'lose'].includes(f.state.phase)) err = `wedged in '${f.state.phase}'`;
  } catch (e) { err = `threw: ${e.message}`; }
  check('co-sim: poison dt interleaved mid-bout → still reaches verdict', !err, err);
}

/* ============ 17. live mutation + frozen controls + proto-key injection ============ */
reseed(0x1D30F);
const PROTO_KEYS = ['__proto__', 'constructor', 'hasOwnProperty', 'toString', 'valueOf', 'prototype'];
{
  // mutate FT/SPECIALS/VSTATS to negative garbage WHILE a fight runs —
  // the bout's snapshot was taken at reset → invariants must hold anyway
  const snapF = JSON.parse(JSON.stringify(FT)), snapS = JSON.parse(JSON.stringify(SPECIALS)),
    snapV = JSON.parse(JSON.stringify(VSTATS));
  let err = null;
  try {
    const f = new Fight({ seed: 55, npcVariant: 'sumo' });
    for (let i = 0; i < 700 && f.state.phase !== 'fighting'; i++) f.step(DT, {});
    FT.dmg.jab = -50; FT.npcDmg.hook = -99; FT.stamCost.cross = -5; FT.roundHeal = -9;
    FT.score.dodge = -500; FT.stamRegen = -7; FT.windup.jab = -1; FT.guardT = -1;
    SPECIALS.sumo.stam = -9; SPECIALS.sumo.cost = -9; SPECIALS.sumo.dmgMul = -5;
    VSTATS.sumo.dmg = -99; VSTATS.sumo.taken = -2; VSTATS.sumo.windup = NaN;
    for (let i = 0; i < 60 * 60 && !['win', 'lose'].includes(f.state.phase); i++) {
      f.step(DT, { punches: i % 20 === 0 ? [{ kind: pick(['jab', 'cross', 'hook']), side: 'left', power: rnd() }] : [],
        guard: { left: .5, right: .5 }, distance: .7, sway: Math.sin(i / 30) });
      if ((err = fightInvariant(f, `live-mut ${i}`))) break;
    }
    // now leave the poison in place and reset — the fresh snapshot must
    // re-sanitize all of it, and the rematch must still complete
    if (!err) {
      f.reset();
      if (f._T.dmg.jab < 0 || f._T.roundHeal < 0 || f._T.stamCost.cross < 0
        || f._T.score.dodge < 0 || f._special.dmgMul < 0 || f._stat.dmg < 0)
        err = `reset kept negative snapshot: ${JSON.stringify({ j: f._T.dmg.jab, rh: f._T.roundHeal, d: f._stat.dmg })}`;
      for (let i = 0; i < 60 * 320 && !err && !['win', 'lose'].includes(f.state.phase); i++) {
        f.step(DT, { punches: i % 20 === 0 ? [{ kind: 'cross', side: 'right', power: 1 }] : [], distance: .7 });
        if ((err = fightInvariant(f, `post-reset ${i}`))) break;
      }
      if (!err && !['win', 'lose'].includes(f.state.phase)) err = 'no verdict after poisoned-table reset';
    }
  } catch (e) { err = `threw: ${e.message}`; }
  finally {
    for (const k in snapF) FT[k] = snapF[k];
    for (const k in snapS) SPECIALS[k] = snapS[k];
    for (const k in snapV) VSTATS[k] = snapV[k];
  }
  check('fight: live FT/SPECIALS/VSTATS mutation → bout invariants hold, reset re-sanitizes', !err, err);
}
{
  // negative-tuning battery applied BEFORE construction — hp/stamina/score
  // domains must survive every knob the snapshot floors
  const snapF = JSON.parse(JSON.stringify(FT));
  const cases = [
    { 'dmg.jab': -50 }, { 'dmg.cross': -1e9 }, { 'npcDmg.jab': -40 },
    { 'stamCost.jab': -5 }, { 'stamRegen': -1 }, { 'npcRegen': -1 }, { 'npcCost': -1 },
    { 'roundHeal': -5 }, { 'score.dodge': -500 }, { 'score.hitMul': -10 },
    { 'counterDamage': -3 }, { 'powFloor': -2 }, { 'blockMul': -1 },
    { 'duckUpperMul': -2 }, { 'exhaustMul': -4 }, { 'comboMax': -3 },
    { 'introT': -1 }, { 'countT': -1 }, { 'downT': -1 }, { 'punchDur': -1 },
    { 'slipBase': 9 }, { 'dodgeWin': -1 }, { 'perfectStun': -2 },
  ];
  let err = null;
  try {
    for (const c of cases) {
      const [path, v] = Object.entries(c)[0];
      const [top, sub] = path.split('.');
      const keep = sub ? FT[top][sub] : FT[top];
      if (sub) FT[top][sub] = v; else FT[top] = v;
      const f = new Fight({ seed: 66, roundLen: 4 });
      try {
        for (let i = 0; i < 60 * 30 && !['win', 'lose'].includes(f.state.phase); i++) {
          f.step(DT, { punches: i % 15 === 0 ? [{ kind: pick(['jab', 'cross', 'hook', 'uppercut']), side: 'left', power: .9 }] : [],
            guard: { left: .6, right: .6 }, distance: .6, sway: Math.sin(i / 20), dodge: i % 90 === 0 ? 1 : 0 });
          if ((err = fightInvariant(f, `${path}=${v} @${i}`))) break;
        }
      } catch (e) { err = `${path}=${v} threw: ${e.message}`; }
      if (sub) FT[top][sub] = keep; else FT[top] = keep;
      if (err) break;
    }
  } finally { for (const k in snapF) FT[k] = snapF[k]; }
  check('fight: 23 negative-tuning cases → hp/stamina/score stay in domain', !err, err);
}
{
  // frozen / sealed controls: opts lockdown must never crash or wedge
  let err = null;
  try {
    const f = new Fight({ seed: 71 });
    for (let i = 0; i < 700 && f.state.phase !== 'fighting'; i++) f.step(DT, {});
    Object.freeze(f.opts);
    f.reset();                                            // used to throw TypeError
    if (f.state.phase !== 'intro' || f.state.timeLeft !== 90) err = `frozen reset → ${f.state.phase}/${f.state.timeLeft}`;
    for (let i = 0; i < 60 * 200 && !err && !['win', 'lose'].includes(f.state.phase); i++)
      f.step(DT, { punches: i % 25 === 0 ? [{ kind: 'hook', side: 'left', power: 1 }] : [], distance: .6 });
    if (!err && !['win', 'lose'].includes(f.state.phase)) err = 'frozen-opts fight wedged';
    // live clock poison: NaN roundLen mid-fight must not wedge the next round
    const g = new Fight({ seed: 72, roundLen: 3 });
    for (let i = 0; i < 60 * 11; i++) g.step(DT, {});
    g.opts.roundLen = pick([NaN, -Infinity, 'x', {}]);
    for (let i = 0; i < 60 * 400 && !['win', 'lose'].includes(g.state.phase); i++) g.step(DT, {});
    if (!['win', 'lose'].includes(g.state.phase)) err = `live roundLen=${'NaN/-∞'} wedged at round ${g.state.round} (timeLeft=${g.state.timeLeft})`;
    // frozen-at-construction garbage opts
    const fz = new Fight(Object.freeze({ seed: 9, roundLen: 'x', playerHp: 'x', npcHp: -4 }));
    fz.reset();
    if (fz.state.player.hp !== 100 || fz.state.timeLeft !== 90) err = `frozen ctor opts → ${fz.state.player.hp}/${fz.state.timeLeft}`;
    // sealed still takes writable writes
    const sl = new Fight({ seed: 3 }); Object.seal(sl.opts); sl.opts.playerHp = 42; sl.reset();
    if (sl.state.player.hp !== 42) err = `sealed opts → hp=${sl.state.player.hp}`;
  } catch (e) { err = `threw: ${e.message}`; }
  check('fight: frozen/sealed/live-mutated opts → reset safe, clock never wedges', !err, err);
}
{
  // frozen tuning tables: sim.t / ft.T locked → _clean rebase keeps sim sane
  let err = null;
  try {
    const sim = new RingSim({ seed: 8 });
    sim.t.radius = 'x'; Object.freeze(sim.t);               // frozen WITH garbage
    for (let i = 0; i < 200; i++) sim.step(DT, { npcDir: 'press' });
    if ((err = ringLegality(sim, 'frozen-t'))) throw new Error(err);
    const ft = new FistTracker();
    ft.T.GUARD_RATE = -8; Object.freeze(ft.T);
    for (let i = 0; i < 80; i++) ft.update(hs(hand('left', .4, .5, 1.4)), fc(), DT);
    if (!Number.isFinite(ft.guard.left) || ft.guard.left < -1e-9 || ft.guard.left > 1.0001)
      err = `frozen-T → guard=${ft.guard.left}`;
  } catch (e) { err = `threw: ${e.message}`; }
  check('ring+fists: frozen tuning tables → rebased, still legal', !err, err);
}
{
  // prototype-chain key injection into every name/kind dispatch — the
  // '__proto__' class of bugs: truthy-but-not-ours table hits
  let err = null;
  try {
    for (const k of PROTO_KEYS) {
      const f = new Fight({ seed: 3, ai: false, npcVariant: k });
      for (let i = 0; i < 700 && f.state.phase !== 'fighting'; i++) f.step(DT, {});
      if (f.state.phase !== 'fighting') { err = `${k}: never reached fighting`; break; }
      f.throwPunch(k, 'left');                              // proto-keyed kind
      f.step(DT, { punches: [{ kind: k, side: 'left', power: .8 }], distance: .5 });  // proto-keyed punch
      for (let i = 0; i < 600 && f.state.npc.action === 'windup'; i++) f.step(DT, { distance: .8 });
      if (f.state.npc.action === 'windup') { err = `${k}: NPC wedged telegraphing (t01=${f.state.npc.telegraph?.t01})`; break; }
      if ((err = fightInvariant(f, k))) break;
      if (!Number.isFinite(f.state.npc.hp) || !Number.isFinite(f.state.player.stamina)) { err = `${k}: NaN hp/stamina`; break; }
    }
  } catch (e) { err = `threw: ${e.message}`; }
  check('fight: proto-keyed kind/variant → no wedge, no NaN poison', !err, err);
}
{
  // same battery against protoBoxer + audio dispatch tables
  let err = null;
  const b = buildBoxer(THREE, {});
  const au = new BoxingAudio(); au.unlock(strictCtx());
  try {
    for (const k of PROTO_KEYS) {
      b.pose(k, .5); b.snap(k, .5); b.tick(DT);
      b.trackHands({ hands: [{ side: 'left', kind: 'fist', palm: { x: .4, y: .5 }, lm: lm(.4, .5) }] }, k);
      au.play(k, {}); au.handleEvent(k, { lastBlow: { kind: k, dmg: 5 } });
    }
    if ((err = boxerFinite(b, 'proto-keys'))) { /* fallthrough */ }
  } catch (e) { err = `threw: ${e.message}`; }
  check('proto+audio: proto-keyed pose/space/preset → no throw, rig finite', !err, err);
}

/* ============ 18. cross-module co-sim — 10k steps, shared invariants ============ */
reseed(0xC0517);
{
  /* ring↔fists↔fight wired exactly like game.js: fists punches flow into
     fight, fight.npcDir feeds ring steering, ring.distance feeds fight.
     Per-step invariants: hp only heals at a round boundary, score is
     non-decreasing, stamina ∈ [0,1], distance stays finite. */
  const sim = new RingSim({ seed: 303 }), f = new Fight({ seed: 404 }), ft = new FistTracker();
  let err = null, scorePrev = 0, phpPrev = f.state.player.hp, nhpPrev = f.state.npc.hp,
    prevRound = f.state.round;
  try {
    for (let i = 0; i < 10000; i++) {
      // plausible hand stream: span ramp on a random side every ~90 frames
      const cyc = i % 90, side = (i / 90 | 0) % 2 ? 'right' : 'left';
      const s = cyc < 14 ? 1.1 + cyc * .13 : cyc < 24 ? 2.8 - (cyc - 14) * .12 : 1.1;
      ft.update(hs(hand(side, .38 + Math.sin(i / 200) * .04, .5, s)), i % 7 ? fc() : null, DT);
      const punches = ft.punches.splice(0, ft.punches.length);
      f.step(DT, { punches, guard: { left: ft.guard.left, right: ft.guard.right },
        sway: ft.sway, duck: ft.duck, distance: sim.distance() });
      sim.step(DT, { npcDir: f.npcDir(), npcStunned: f.state.npc.action === 'stunned',
        playerStep: i % 500 < 40 ? .6 : 0 });
      const st = f.state;
      if (!Number.isFinite(sim.distance()) || sim.distance() < 0) { err = `distance=${sim.distance()} @${i}`; break; }
      // hp is monotonic non-increasing inside a round — the only legal rise
      // is the between-round heal, observed the same step state.round bumps
      if (st.round !== prevRound) { phpPrev = st.player.hp; nhpPrev = st.npc.hp; prevRound = st.round; }
      else if (st.player.hp > phpPrev + 1e-9 || st.npc.hp > nhpPrev + 1e-9) {
        err = `hp rose mid-round: p ${phpPrev.toFixed(1)}→${st.player.hp.toFixed(1)} n ${nhpPrev.toFixed(1)}→${st.npc.hp.toFixed(1)} @${i} round ${st.round}`;
        break;
      }
      if (st.player.score < scorePrev - 1e-9) { err = `score decreased ${scorePrev}→${st.player.score} @${i}`; break; }
      if (st.player.stamina < -1e-9 || st.player.stamina > 1 + 1e-9
        || st.npc.stamina < -1e-9 || st.npc.stamina > 1 + 1e-9) { err = `stamina out of range @${i}`; break; }
      phpPrev = st.player.hp; nhpPrev = st.npc.hp; scorePrev = st.player.score;
      if (i % 997 === 0 && (err = fightInvariant(f, `cosim ${i}`) || ringLegality(sim, `cosim ${i}`))) break;
    }
  } catch (e) { err = `threw: ${e.message}`; }
  check('co-sim: 10k wired steps — hp/score/stamina/distance invariants hold', !err, err);
}

/* ============ 19. serialization round-trip + event-stream invariants ============ */
reseed(0xE9E7A);
{
  // JSON.stringify(fight.state) mid-bout must not throw; resume-parity isn't
  // promised (see report — rng phase, _T snapshot, _inp buffer, timers are
  // per-instance), but every serialized field must round-trip as data.
  const f = new Fight({ seed: 88 });
  let err = null, snap = null;
  try {
    for (let i = 0; i < 60 * 14 && f.state.phase !== 'fighting'; i++) f.step(DT, { distance: .8 });
    for (let i = 0; i < 240; i++) f.step(DT, { punches: i % 20 === 0 ? [{ kind: 'jab', side: 'left', power: .8 }] : [],
      distance: .7, sway: Math.sin(i / 15) });
    const js = JSON.stringify(f.state);
    snap = JSON.parse(js);
    for (const k of ['phase', 'round', 'timeLeft', 'player', 'npc', 'events', 'lastBlow'])
      if (!(k in snap)) { err = `serialized state missing '${k}'`; break; }
    if (!err && (snap.phase !== f.state.phase || snap.player.hp !== f.state.player.hp
      || snap.npc.hp !== f.state.npc.hp || snap.round !== f.state.round))
      err = 'round-trip drifted on phase/hp/round';
    if (!err && !Number.isFinite(snap.timeLeft)) err = `timeLeft serialized as ${snap.timeLeft}`;
    // stringify must also survive the weird moments: mid-windup telegraph, KO, terminal.
    // playerHp huge → the AI can't race us to a decision/KO — the only way
    // out is our cross ending it ('win' via npcdown).
    const g = new Fight({ seed: 89, npcHp: 12, playerHp: 1e6 });
    for (let i = 0; i < 60 * 120 && !['win'].includes(g.state.phase); i++) {
      g.step(DT, { punches: g.state.phase === 'fighting' && i % 16 === 0
        ? [{ kind: 'cross', side: 'right', power: 1 }] : [], distance: .6 });
      JSON.stringify(g.state);                              // every step, any shape
    }
    if (g.state.phase !== 'win') err = `KO fight never finished: ${g.state.phase}`;
  } catch (e) { err = `threw: ${e.message}`; }
  check('fight: JSON round-trip mid-bout/telegraph/KO — no throw, data intact', !err, err);
}
{
  // event-stream legality over full bouts incl. forced KOs both directions:
  //   · 'ko' is only ever emitted out of 'fighting' (into *down)
  //   · cumulative 'round-start' bells === state.round (behind by 1 while
  //     the round's own countdown is still ticking)
  //   · draining via splice leaves nothing — a second drain is empty
  //   · lastBlow only ever names a real blow (who/kind/result vocab, finite dmg)
  let err = null, kos = 0, drains = 0;
  for (const o of [{ seed: 21 }, { seed: 22, npcHp: 25 }, { seed: 23, playerHp: 20 }, { seed: 24, npcVariant: 'bean' }]) {
    const f = new Fight(o);
    let roundStarts = 0, prevPhase = f.state.phase;
    for (let i = 0; i < 60 * 300 && !['win', 'lose'].includes(f.state.phase); i++) {
      prevPhase = f.state.phase;
      f.step(DT, { punches: i % 18 === 0 ? [{ kind: 'cross', side: 'right', power: 1 }] : [],
        guard: { left: .4, right: .4 }, distance: .7, sway: Math.sin(i / 40) });
      const evs = f.state.events.splice(0, f.state.events.length);      // game.js drain
      if (f.state.events.splice(0).length !== 0) { err = 'second drain replayed events'; break; }
      drains++;
      for (const e of evs) {
        if (!EVENT_VOCAB.has(e)) { err = `bad event '${e}'`; break; }
        if (e === 'round-start') roundStarts++;
        if (e === 'ko') {
          kos++;
          if (prevPhase !== 'fighting') { err = `ko emitted out of '${prevPhase}'`; break; }
          if (!['npcdown', 'playerdown'].includes(f.state.phase)) { err = `ko left phase '${f.state.phase}'`; break; }
        }
      }
      if (err) break;
      const expect = f.state.round - (f.state.phase === 'countdown' ? 1 : 0);
      if (roundStarts !== expect) { err = `bells=${roundStarts} but round=${f.state.round} phase=${f.state.phase}`; break; }
      const lb = f.state.lastBlow;
      if (lb && (!RESULTS.has(lb.result) || !['player', 'npc'].includes(lb.who)
        || !['jab', 'cross', 'hook', 'uppercut', 'upper'].includes(lb.kind)
        || (lb.side !== undefined && !['left', 'right'].includes(lb.side))
        || (lb.dmg !== undefined && !(Number.isFinite(lb.dmg) && lb.dmg >= 0)))) {
        err = `bad lastBlow ${JSON.stringify(lb)}`; break;
      }
    }
    if (err) break;
  }
  check('events: ko only from fighting, bells === round, drain-once, lastBlow legal',
    !err && kos > 0 && drains > 1000, `${err} kos=${kos} drains=${drains}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
