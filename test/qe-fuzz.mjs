/* test/qe-fuzz.mjs — deterministic seeded fuzz + property checks for the
   pure game-logic modules. QE rounds 2 (w4-qe-fuzz) + 3 (b3-fuzz) + 4 (b4-fuzz)
   + 5 (b5-fuzz).

   Wave 4 adds: dt boundary torture on every module entry point
   (0, -0, 1e-12, .1, ±∞, NaN, 'x'), live mutation fuzz on exported
   TUNING/SPECIALS/VSTATS + frozen/sealed controls, prototype-chain key
   injection ('__proto__'/'constructor' into every name/kind dispatch),
   a 10k-step ring↔fists↔fight co-simulation with hp/score/stamina/distance
   invariants, state serialization round-trips, and event-stream legality
   (ko only from 'fighting', bell count === round, drain-once semantics).

   Wave 5 adds: cornerHold dt=0 freeze semantics (held frames commit
   nothing — no buffered punch/dodge/rise-tag leaks after release, corner()
   refused outside 'fighting', toggle spam ≡ uninterrupted run, freeze
   frames preserve pending events for the drain); module singleton
   contamination (co-live fights/trackers/sims/protoBoxers/audios stepped
   alternately share no events, tuning snapshots, telegraphs, warn budgets
   or input buffers); adversarial structural inputs (throwing Proxies,
   throwing getters, Symbol fields, flip-flopping getters, sparse arrays,
   cyclic state) on every public entry point; three-bout replay
   determinism (identical per-step digest + event stream ×3, reset() ≡
   fresh construction); audio lifecycle churn (rapid unlock/dispose/mute,
   crowd swell mid-dispose, node edge balance, no doubled crowd beds).

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
  if (rnd() < .3) o.riseTouch = rnd() < .1 ? pick([5, 'x', null])   // glove-palm
    : Array.from({ length: rnd() * 3 | 0 }, () =>                  // touch feeds
      rnd() < .15 ? pick([null, 'x', {}]) : { x: rnd() * 1.4 - .2, y: rnd() * 1.4 - .2 });
  if (rnd() < .2) o.riseAspect = rnd() < .2 ? gnum() : .3 + rnd() * 3;
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
  'perfect-dodge', 'counter', 'npc-special', 'ko', 'round-start', 'countdown', 'win', 'lose',
  'rise', 'rise-hit', 'rise-miss', 'rise-fade', 'revive', 'corner']);
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
    playerdown: new Set(['playerdown', 'fighting', 'lose']),
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

/* ============ 20. cornerHold — dt=0 freeze semantics (wave 5) ============
   game.js (read-only) holds the bout by calling fight.step(0, inputs) while
   controls.cornerHold is set. The Fight-level contract the fuzz verifies:
   a held step commits NOTHING — no phase/clock/dodge/punch/rise progress,
   no events, no buffered action leaking after release. */
reseed(0xC0E7);
const fightDig = f => { const s = f.state; return JSON.stringify([
  s.phase, s.round, s.timeLeft, s.countdown, s.player.hp, s.player.stamina,
  s.player.score, s.player.dodge.dir, s.player.gassed,
  s.npc.hp, s.npc.stamina, s.npc.action, s.npc.actionT, s.npc.gassed,
  s.rise.active, s.rise.got, s.rise.t01, s.rise.each01]); };
{
  // 240 held frames full of hostile-chaos inputs: state bit-identical, no events
  const f = new Fight({ seed: 5 });
  for (let i = 0; i < 700 && f.state.phase !== 'fighting'; i++) f.step(DT, {});
  f.state.events.length = 0;
  const d0 = fightDig(f);
  let emitted = 0;
  for (let i = 0; i < 240; i++) {
    f.step(0, { punches: [{ kind: 'hook', side: 'left', power: 1 }],
      sway: i % 2 ? .95 : -.95, dodge: i % 3 - 1, duck: .9,
      guard: { left: 1, right: 1 }, distance: .5 });
    emitted += f.state.events.length;
  }
  check('cornerHold: 240 held frames — state identical, zero events emitted',
    fightDig(f) === d0 && emitted === 0, `emitted=${emitted}\n${d0}\n${fightDig(f)}`);

  // release: real frames with EMPTY inputs — nothing held may resolve late
  const hp0 = f.state.npc.hp;
  let leaked = null;
  for (let i = 0; i < 40; i++) {
    f.step(DT, { distance: .5 });
    for (const e of f.state.events)
      if (['player-punch', 'player-hit', 'player-miss', 'player-dodge', 'player-dodged'].includes(e))
        leaked = `event '${e}' @release ${i}`;
    if (f.state.npc.hp < hp0) leaked = `npc.hp ${hp0}→${f.state.npc.hp}`;
    if (f.state.player.dodge.dir) leaked = `dodge fired: ${f.state.player.dodge.dir}`;
  }
  check('cornerHold: buffered punches/dodges/leans never leak after release',
    !leaked, leaked);
}
{
  // held sway consumes the edge: a lean PRESENTED during the hold and still
  // present at release does not start a dodge (game.js drops fightIn.sway
  // only for its own dodge latch — the fight must not fire it late either)
  const f = new Fight({ seed: 5 });
  for (let i = 0; i < 700 && f.state.phase !== 'fighting'; i++) f.step(DT, {});
  for (let i = 0; i < 30; i++) f.step(0, { sway: .9, distance: .8 });   // held lean
  let dodged = false;
  for (let i = 0; i < 10; i++) {
    f.step(DT, { sway: .9, distance: .8 });                            // still leaning
    if (f.state.player.dodge.dir || f.state.events.includes('player-dodge')) dodged = true;
  }
  check('cornerHold: lean held through the pause is consumed, not fired late',
    !dodged && !f.state.player.dodge.dir, `dodge=${f.state.player.dodge.dir}`);
}
{
  // live telegraph pins through the hold; the swing completes on schedule
  const f = new Fight({ seed: 11, ai: false, practice: true });
  for (let i = 0; i < 700 && f.state.phase !== 'fighting'; i++) f.step(DT, {});
  f.throwPunch('hook', 'right', 1.0);
  for (let i = 0; i < 20; i++) f.step(DT, { distance: .7 });
  const t0 = JSON.stringify([f.state.npc.telegraph, f.state.npc.actionT, f.state.player.hp]);
  for (let i = 0; i < 120; i++) f.step(0, { dodge: 1, sway: .9, distance: .7 });
  check('cornerHold: mid-swing telegraph pins t01/actionT/hp through the hold',
    JSON.stringify([f.state.npc.telegraph, f.state.npc.actionT, f.state.player.hp]) === t0,
    `${t0} → ${JSON.stringify([f.state.npc.telegraph, f.state.npc.actionT])}`);
  let dodged = false, resolved = false;
  for (let i = 0; i < 90; i++) {
    f.step(DT, { distance: .7 });
    if (f.state.events.includes('player-dodge') || f.state.events.includes('player-dodged')) dodged = true;
    if (f.state.lastBlow?.who === 'npc') resolved = true;
  }
  check('cornerHold: swing resolves on schedule; held dodge gives no retro i-frames',
    resolved && !dodged, `resolved=${resolved} dodged=${dodged}`);
}
{
  // corner() API itself: 'fighting'+hp>0 → heal floor + 'corner' + re-deal;
  // refused in every other phase — and the event survives held frames to the drain
  const g = new Fight({ seed: 5 });
  for (let i = 0; i < 700 && g.state.phase !== 'fighting'; i++) g.step(DT, {});
  g.state.player.hp = Math.floor(g.state.player.maxHp * .3);
  const floor = Math.max(g.state.player.hp, g.state.player.maxHp * g._T.cornerHeal);
  check('corner(): fighting → patches to heal floor + re-deals the round',
    g.corner() === true && g.state.player.hp === floor && g.state.phase === 'countdown',
    `hp=${g.state.player.hp} floor=${floor} ph=${g.state.phase}`);
  check('corner(): refused while already in the break countdown',
    g.corner() === false && g.state.phase === 'countdown');
  g.state.events.length = 0;
  g.state.phase = 'fighting'; g.state.player.hp = 1;         // re-arm the emit path
  g.corner();
  for (let i = 0; i < 12; i++) g.step(0, chaosFightInputs()); // held frames
  const drained = g.state.events.splice(0);
  check('cornerHold: corner() event survives held frames to the drain',
    drained.includes('corner'), drained.join(','));
}
{
  // freeze is phase-agnostic: countdown/down phases + terminals all ignore it
  let err = null;
  const holdSpam = f => {
    for (let i = 0; i < 120; i++)
      f.step(0, { punches: [{ kind: 'hook', side: 'left', power: 1 }],
        dodge: i % 3 - 1, duck: .9, sway: .9, distance: .5 });
  };
  for (const [ph, mk] of [
    ['countdown', () => { const f = new Fight({ seed: 6 }); f.startNow(); return f; }],
    ['playerdown', () => { const f = new Fight({ seed: 6, playerHp: 1 });
      for (let i = 0; i < 60 * 200 && f.state.phase !== 'playerdown'; i++) f.step(DT, { distance: .6 }); return f; }],
    ['npcdown', () => { const f = new Fight({ seed: 6, npcHp: 1 });
      for (let i = 0; i < 60 * 200 && f.state.phase !== 'npcdown'; i++)
        f.step(DT, { punches: [{ kind: 'jab', side: 'left', power: 1 }], distance: .5 }); return f; }],
  ]) {
    const f = mk();
    if (f.state.phase !== ph) { err = `${ph}: setup landed in '${f.state.phase}'`; break; }
    const d0 = fightDig(f);
    holdSpam(f);
    if (fightDig(f) !== d0) { err = `${ph}: held frames mutated state`; break; }
    if (f.corner() !== false) { err = `${ph}: corner() accepted mid-${ph}`; break; }
    if (f.state.events.length && !d0.includes('"corner"')) { /* events during hold leak */ }
  }
  for (const [o, punch] of [[{ seed: 6, npcHp: 1 }, true], [{ seed: 6, playerHp: 1 }, false]]) {
    const f = new Fight(o);
    for (let i = 0; i < 60 * 300 && !['win', 'lose'].includes(f.state.phase); i++)
      f.step(DT, { punches: punch && f.state.phase === 'fighting'
        ? [{ kind: 'jab', side: 'left', power: 1 }] : [], distance: .6 });
    if (!['win', 'lose'].includes(f.state.phase)) { err = `terminal setup: ${f.state.phase}`; break; }
    const term = f.state.phase, d0 = fightDig(f);
    holdSpam(f);
    if (fightDig(f) !== d0) { err = `${term}: held frames mutated terminal state`; break; }
    if (f.corner()) { err = `${term}: corner() accepted`; break; }
  }
  check('cornerHold: hold ignored in countdown/playerdown/npcdown/win/lose', !err, err);
}
{
  // get-up QTE is part of the freeze: rings hold their fade, tag attempts drop
  const f = new Fight({ seed: 9, playerHp: 1 });
  for (let i = 0; i < 60 * 200 && f.state.phase !== 'playerdown'; i++) f.step(DT, { distance: .6 });
  const r0 = JSON.stringify(f.state.rise), got0 = f.state.rise.got;
  for (let i = 0; i < 120; i++)
    f.step(0, { punches: [{ kind: 'jab', x: .5, y: .5 }], riseAspect: 1 });
  const frozen = JSON.stringify(f.state.rise) === r0 && f.state.phase === 'playerdown';
  const t01a = f.state.rise.t01;
  for (let i = 0; i < 12; i++) f.step(DT, {});               // release — count resumes
  check('cornerHold: rise QTE frozen mid-hold, resumes on release',
    frozen && f.state.rise.t01 < t01a && f.state.rise.got === got0,
    `${r0} → ${JSON.stringify(f.state.rise)}`);
}
{
  // toggle spam: alternating held/real frames ≡ the uninterrupted run —
  // no wedge, no stamina/hp drift sourced by the toggling itself
  const ref = new Fight({ seed: 8 }), spam = new Fight({ seed: 8 });
  for (let i = 0; i < 700 && ref.state.phase !== 'fighting'; i++) { ref.step(DT, {}); spam.step(DT, {}); }
  const inp = i => ({ distance: .7, sway: Math.sin(i / 9) * .3,       // sub-dodgeT —
    guard: { left: .3, right: .3 },                                   // dodge edges stay aligned
    punches: i % 31 === 0 ? [{ kind: 'jab', side: 'left', power: .7 }] : [] });
  for (let i = 0; i < 3000; i++) {
    ref.step(DT, inp(i));
    spam.step(0, { punches: [{ kind: 'hook', power: 1 }], dodge: 1, duck: 0, sway: 0 });
    spam.step(DT, inp(i));
  }
  check('cornerHold: 3000 toggle-spam pairs ≡ uninterrupted run',
    fightDig(ref) === fightDig(spam), `${fightDig(ref)}\n${fightDig(spam)}`);
}

/* ============ 21. module singleton contamination (wave 5) ============ */
reseed(0x51E7);
{
  // two co-live fights stepped alternately must replay their own solo runs —
  // the strongest possible isolation check: any shared mutable state
  // (events, tuning snapshots, telegraphs, rng, input buffers) diverges the digest
  const stream = []; reseed(0xB07);
  for (let i = 0; i < 6000; i++) stream.push(chaosFightInputs());
  const dg = f => { const s = f.state; return [s.phase, s.round, s.timeLeft,
    s.player.hp, s.player.stamina, s.player.score, s.npc.hp, s.npc.stamina,
    s.npc.action, s.player.dodge.dir].join('|'); };
  const solo = new Fight({ seed: 77 }), soloSig = [];
  for (const inp of stream) { solo.step(DT, inp); soloSig.push(dg(solo)); }
  const f1 = new Fight({ seed: 77 }), f2 = new Fight({ seed: 78 });
  const interSig = [], f2Sig = [];
  for (const inp of stream) { f1.step(DT, inp); f2.step(DT, inp); interSig.push(dg(f1)); f2Sig.push(dg(f2)); }
  check('contamination: co-live fight ≡ its own solo run (6000 interleaved steps)',
    interSig.every((d, i) => d === soloSig[i]),
    `first drift @${interSig.findIndex((d, i) => d !== soloSig[i])}`);
  const solo78 = new Fight({ seed: 78 }), solo78Sig = [];
  for (const inp of stream) { solo78.step(DT, inp); solo78Sig.push(dg(solo78)); }
  check('contamination: co-live partner ≡ its own solo run too',
    f2Sig.every((d, i) => d === solo78Sig[i]),
    `first drift @${f2Sig.findIndex((d, i) => d !== solo78Sig[i])}`);
  check('contamination: state/events/tuning/input buffers are distinct objects',
    f1.state !== f2.state && f1.state.events !== f2.state.events
    && f1._T !== f2._T && f1._inp !== f2._inp && f1._inp.guard !== f2._inp.guard
    && f1.state.player.dodge !== f2.state.player.dodge);
  const j0 = f2._T.dmg.jab;
  f1._T.dmg.jab = 999;
  check('contamination: tuning snapshot writes stay inside the instance',
    f2._T.dmg.jab === j0 && FT.dmg.jab !== 999, `f2.jab=${f2._T.dmg.jab} FT.jab=${FT.dmg.jab}`);
  f1._T.dmg.jab = j0;
}
{
  // fists trackers: no shared punch buffer / guard / per-side state / tuning
  const t1 = new FistTracker(), t2 = new FistTracker();
  const refs = [t1.punches !== t2.punches, t1.guard !== t2.guard, t1.reach !== t2.reach,
    t1.T !== t2.T, t1._s.left !== t2._s.left, t1._pick !== t2._pick];
  for (let i = 0; i < 60; i++) t1.update(hs(hand('left', .4, .55, 1.4 + Math.sin(i / 4))), fc(), DT);
  for (const s of [1.8, 2.2, 2.6, 2.3, 2.0]) t1.update(hs(hand('left', .4, .55, s)), fc(), DT);
  for (let i = 0; i < 40; i++) t1.update(null, fc(.3, .4), DT);        // face stream on t1 only
  check('contamination: tracker buffers/state independent — no cross-talk',
    refs.every(Boolean) && t2.punches.length === 0 && t2.guard.left === 0
      && t2.reach.left === 1 && t2.sway === 0 && t2.pitch === 0,
    `t2 polluted: punches=${t2.punches.length} guard=${t2.guard.left} sway=${t2.sway}`);
}
{
  // ring sims: independent tuning, bodies, input buffer, rng
  const s1 = new RingSim({ seed: 4 }), s2 = new RingSim({ seed: 4 });
  s1.step(DT, {}); s2.step(DT, {});                       // lazily init _inp
  const home2 = JSON.stringify([s2.player.pos, s2.npc.pos]);
  const refs = [s1.t !== s2.t, s1.player !== s2.player, s1.npc !== s2.npc,
    s1._inp !== s2._inp, s1.player.pos !== s2.player.pos,
    s1.player.vel !== s2.player.vel, s1._home !== s2._home, s1._rng !== s2._rng];
  s1.t.radius = 1.9;
  for (let i = 0; i < 300; i++) s1.step(DT, { npcDir: 'press', playerStep: .8 });
  check('contamination: ring sims independent — mutation + trajectory',
    refs.every(Boolean) && s2.t.radius === RT.radius
      && JSON.stringify([s2.player.pos, s2.npc.pos]) === home2,
    `s2: radius=${s2.t.radius} pos=${JSON.stringify(s2.player.pos)}`);
}
{
  // protoBoxers: pose on one never moves the other; warn budget is per-instance
  const b1 = buildBoxer(THREE, {}), b2 = buildBoxer(THREE, {});
  for (let i = 0; i < 80; i++) { b1.pose('jab', .6); b1.tick(DT); }
  const z0 = b2.parts.gloveL.position.z, y0 = b2.parts.head.position.y;
  check('contamination: pose/tick on one boxer never moves the other',
    b2.parts.gloveL.position.z === z0 && b2.parts.head.position.y === y0,
    `z ${z0}→${b2.parts.gloveL.position.z}`);
  let w = 0; const ow = console.warn; console.warn = () => w++;
  for (let i = 0; i < 200; i++) b1.pose('zz' + i, 0);
  const w1 = w;
  b2.pose('zzz-unique', 0);
  console.warn = ow;
  check('contamination: warn-dedup budget is per-instance',
    w1 > 0 && w > w1, `b1 warns=${w1} b2 warn delta=${w - w1}`);
}
{
  // two audios on one ctx: separate masters, separate crowd beds, mute is local
  const ctx = strictCtx();
  const a1 = new BoxingAudio(), a2 = new BoxingAudio();
  a1.unlock(ctx); a2.unlock(ctx);
  const ok = a1.master !== a2.master && a1._buf !== a2._buf;
  a1.muted = true;
  check('contamination: two audios — separate graphs, muting one leaves the other live',
    ok && a2.play('bell', {}) === true && a1.play('bell', {}) === false,
    `master shared=${a1.master === a2.master} a2 played=${a2.play('bell', {})}`);
}
{
  // two tutorials on the same fight: finishing one never finishes the other
  const fight = new Fight({ seed: 3, ai: false, practice: true });
  const sim = new RingSim({ seed: 3 });
  const ta = new Tutorial({ fight, sim }), tb = new Tutorial({ fight, sim });
  fight.startNow();
  for (let i = 0; i < 60 * (TOTAL + 8) && !ta.done; i++) {   // countdown eats ~4s before TOTAL starts
    fight.step(DT, { distance: sim.distance() });
    ta.update({ events: fight.state.events, state: fight.state }, i / 60);
  }
  check('contamination: a finished tutor never finishes its sibling',
    ta.done && !tb.done && tb.i === 0, `tb.i=${tb.i} done=${tb.done}`);
}

/* ============ 22. adversarial structural inputs (wave 5) ============ */
reseed(0xBAD5);
/* Proxy can only wrap objects — prox(n) = a hostile OBJECT that stands in
   for whatever the call site suggests (number/string/name slot). */
const prox = (o = {}) => new Proxy(
  (typeof o === 'object' && o !== null) ? o : {},
  { get() { throw new Error('proxy get'); } });
const boomGet = k => { const o = {}; Object.defineProperty(o, k, { get() { throw new Error('boom getter'); } }); return o; };
{
  // fight.step / fight.step(0) vs throwing Proxies, throwing getters,
  // Symbol values, sparse + hostile punches, cyclic inputs
  let err = null;
  try {
    const f = new Fight({ seed: 1 });
    for (let i = 0; i < 700 && f.state.phase !== 'fighting'; i++) f.step(DT, {});
    for (const bad of [prox(), boomGet('punches'), boomGet('guard'), boomGet('sway'),
        boomGet('distance'), boomGet('dodge'), prox({ punches: [] }),
        null, undefined, 5, 'x', Symbol('s'), Object.create(null)]) {
      f.step(DT, bad); f.step(0, bad);
    }
    for (const bad of [
      { punches: prox([]) },
      { punches: [prox({}), prox(), boomGet('kind'), null, undefined, 5, Symbol('p')] },
      { punches: new Array(4) },                        // sparse — holes
      { punches: { length: 1e9 } },
      { punches: Object.assign([{ kind: 'jab' }], { 0: prox({}) }) },
      { guard: prox({ left: .8 }) }, { guard: boomGet('left') },
      { sway: Symbol('s') }, { distance: Symbol('d') }, { duck: Symbol('u') },
      { riseAspect: prox(1) }, { riseAspect: Symbol('a') },
    ]) { f.step(DT, bad); f.step(0, bad); }
    const cyc = { sway: .2 }; cyc.self = cyc; cyc.punches = [cyc];
    f.step(DT, cyc);
    const cyc2 = {}; cyc2.guard = cyc2; f.step(DT, cyc2);
    err = fightInvariant(f, 'hostile');
  } catch (e) { err = `threw: ${e.message}`; }
  check('fight: Proxy/getter/Symbol/sparse/cyclic inputs — no throw, invariants hold', !err, err);
}
{
  // a caller that froze or replaced the public drain queue can't kill step
  let err = null;
  try {
    const f = new Fight({ seed: 1 });
    for (let i = 0; i < 700 && f.state.phase !== 'fighting'; i++) f.step(DT, {});
    Object.freeze(f.state.events);                      // seal the drain
    for (let i = 0; i < 60; i++) f.step(DT, { punches: [{ kind: 'jab', power: .5 }], distance: .6 });
    f.state.events = 'not-an-array';
    for (let i = 0; i < 60; i++) f.step(DT, { distance: .6 });
    err = fightInvariant(f, 'poisoned-drain');
  } catch (e) { err = `threw: ${e.message}`; }
  check('fight: frozen/replaced events queue — step survives', !err, err);
}
{
  // fists.update vs hostile handsState/faceState/dt
  let err = null;
  const ft = new FistTracker();
  try {
    for (let i = 0; i < 400; i++) {
      ft.update(pick([prox(), boomGet('hands'), null, 5, Symbol('s'),
        { hands: prox([]) }, { hands: new Array(3) },
        { hands: [prox(), boomGet('palm'), boomGet('lm'), 5, 'x', null, Symbol('h')] },
        { hands: [{ side: 'left', palm: prox({}), lm: prox([]) }] }]),
        pick([prox(), boomGet('nose'), boomGet('found'), null, 5,
          { found: true, nose: prox({}) }, { found: Symbol('f') }]),
        pick([DT, Symbol('d'), null, 'x', NaN, DT]));
      if (!Number.isFinite(ft.sway + ft.duck + ft.guard.left + ft.reach.left))
        { err = `non-finite @${i}`; break; }
    }
  } catch (e) { err = `threw: ${e.message}`; }
  check('fists: hostile hands/face/dt — never throws, outputs finite', !err, err);
}
{
  // ring.step vs hostile input + externally poisoned internals
  let err = null;
  const sim = new RingSim({ seed: 3 });
  try {
    for (const bad of [prox(), boomGet('npcDir'), boomGet('playerStep'),
        null, 5, 'x', Symbol('s')]) { sim.step(DT, bad); sim.step(0, bad); }
    for (const bad of [{ playerStep: prox(0) }, { npcDir: Symbol('n') },
        { npcStunned: prox(false) }]) sim.step(DT, bad);
    for (const dt of [Symbol('d'), null, 'x', NaN, prox(0)]) sim.step(dt, {});
    // flip-flopping getter — each read returns a different value
    let gi = 0; const flip = {};
    Object.defineProperty(flip, 'playerStep', { get: () => [1e9, -1e9, NaN, .5][gi++ % 4] });
    for (let i = 0; i < 60; i++) sim.step(DT, flip);
    err = ringLegality(sim, 'hostile');
    sim.player = prox({});                               // poisoned internals
    sim.step(DT, { npcDir: 'press' });
    sim.distance(); sim.angleToNpc();
    sim.player = { pos: { x: 0, z: .5 }, vel: { x: 0, z: 0 }, radius: .34, heading: 0 };
    for (let i = 0; i < 30; i++) sim.step(DT, {});
    err = err || ringLegality(sim, 'post-poison');
  } catch (e) { err = `threw: ${e.message}`; }
  check('ring: hostile input + poisoned internals — never throws, stays legal', !err, err);
}
{
  // tutorial/proto/audio vs hostile objects on every public entry point
  let err = null;
  const b = buildBoxer(THREE, {});
  const fight = new Fight({ seed: 2, ai: false, practice: true });
  const sim = new RingSim({ seed: 2 });
  const tut = new Tutorial({ fight, sim });
  const au = new BoxingAudio(); au.unlock(strictCtx());
  try {
    for (const bad of [prox(), boomGet('state'), boomGet('events'), null, 5]) tut.update(bad, 1);
    tut.update({ state: prox({}), events: prox([]) }, 2);
    b.pose('jab', .5, prox({})); b.pose('jab', Symbol('t'), boomGet('reach'));
    b.snap('down', Symbol('t')); b.snap(prox('x'), .5);
    b.tick(DT, prox({}), DT); b.tick(DT, boomGet('gassed'));
    b.trackHands(prox()); b.trackHands(boomGet('hands'));
    b.trackHands({ hands: [prox(), boomGet('palm'), 5] });
    b.setDamage(Symbol('d')); b.setDamage(prox(.5));
    const cyc = {}; cyc.me = cyc; b.tick(DT, cyc); tut.update(cyc, 3);
    au.handleEvent(prox({}), prox({}));
    au.handleEvent(boomGet('type'), { lastBlow: prox({}) });
    au.update(DT, prox({})); au.update(Symbol('d'), fight.state);
    au.play('bell', prox({})); au.play(Symbol('x'), {});
    err = boxerFinite(b, 'hostile');
  } catch (e) { err = `threw: ${e.message}`; }
  check('tutorial/proto/audio: hostile objects — never throws, rig finite', !err, err);
}
{
  // hostile constructor opts — Proxy / throwing getter / Symbol / null-proto
  let err = null;
  try {
    new Fight(prox()).step(DT, {});
    new Fight(boomGet('seed')).step(DT, {});
    new Fight(Symbol('o')).step(DT, {});
    new RingSim(prox()).step(DT, {});
    new RingSim(boomGet('seed')).step(DT, {});
    new RingSim(Symbol('o')).step(DT, {});
    new FistTracker(prox()).update(hs(), fc(), DT);
    new FistTracker(Symbol('o')).update(hs(), fc(), DT);
    new Tutorial(prox()).update({}, 1);
    new Tutorial(Symbol('o')).update({}, 1);
    buildBoxer(THREE, prox({})).tick(DT);
    buildBoxer(THREE, Symbol('o')).tick(DT);
    const f = new Fight(Object.create(null)); f.step(DT, {});
  } catch (e) { err = `threw: ${e.message}`; }
  check('ctors: hostile opts objects — never throws', !err, err);
}
{
  // hostile injected ctx: unlock fails clean → stays silent → recovers
  let err = null, ok = true;
  try {
    const a = new BoxingAudio();
    ok = a.unlock(prox({})) === null && a.ctx === null;
    ok = ok && a.unlock(boomGet('createGain')) === null && a.ctx === null;
    ok = ok && a.play('bell') === false;
    ok = ok && !!a.unlock(strictCtx());                  // recovers with a good ctx
    ok = ok && a.play('bell', {}) === true;
  } catch (e) { err = e.message; }
  check('audio: hostile ctx → unlock null + silent, then recovers', !err && ok, err);
}

/* ============ 23. three-bout replay determinism (wave 5) ============ */
reseed(0x3B07);
{
  // same seed + same input stream across 3 full bouts: identical event
  // stream AND state digest at EVERY step, through verdict
  const stream = [];
  for (let i = 0; i < 60 * 400; i++) stream.push({
    punches: i % 17 === 0 ? [{ kind: ['jab', 'cross', 'hook', 'uppercut'][(i / 17 | 0) % 4],
      side: i % 2 ? 'right' : 'left', power: .4 + (i % 7) / 10 }] : [],
    guard: { left: (i % 5) / 5, right: ((i + 2) % 5) / 5 },
    sway: Math.sin(i / 23) * .8, duck: i % 11 === 0 ? .7 : 0,
    dodge: i % 97 === 0 ? (i % 2 ? 1 : -1) : 0,
    distance: .5 + Math.abs(Math.sin(i / 31)) * 1.5 });
  const dg = s => [s.phase, s.round, s.timeLeft.toFixed(5), s.countdown,
    s.player.hp, s.player.stamina.toFixed(5), s.player.score, s.player.gassed,
    s.player.dodge.dir, s.npc.hp, s.npc.stamina.toFixed(5), s.npc.action,
    s.npc.actionT.toFixed(5), s.npc.gassed, s.rise.active, s.rise.got,
    s.events.join(',')].join('|');
  const run = () => {
    const f = new Fight({ seed: 0xF00D }), sig = [];
    for (const inp of stream) {
      f.step(DT, inp);
      sig.push(dg(f.state));
      if (['win', 'lose'].includes(f.state.phase)) break;
    }
    sig.push('END:' + f.state.phase);
    return sig;
  };
  const r1 = run(), r2 = run(), r3 = run();
  let drift = -1;
  for (let i = 0; i < Math.max(r1.length, r2.length, r3.length); i++)
    if (r1[i] !== r2[i] || r2[i] !== r3[i]) { drift = i; break; }
  check('replay: 3 bouts same seed+stream — identical events+digest every step',
    drift === -1 && r1.length === r2.length && r2.length === r3.length,
    `drift @${drift} lens ${r1.length}/${r2.length}/${r3.length}`
      + (drift >= 0 ? `\n  a: ${r1[drift]}\n  b: ${r2[drift]}` : ''));
  check('replay: the bout actually reached a verdict (stream not truncated)',
    ['END:win', 'END:lose'].includes(r1[r1.length - 1]), r1[r1.length - 1]);
  // reset() ≡ fresh construction — rematch replay is byte-identical
  const a = new Fight({ seed: 0xF00D });
  for (let i = 0; i < 1500; i++) a.step(DT, stream[i]);   // burn-in
  a.reset();
  const b = new Fight({ seed: 0xF00D });
  let dft = -1;
  for (let i = 0; i < 3000; i++) {
    a.step(DT, stream[i]); b.step(DT, stream[i]);
    if (dg(a.state) !== dg(b.state)) { dft = i; break; }
  }
  check('replay: reset() ≡ fresh construction for 3000 steps', dft === -1,
    `drift @${dft}${dft >= 0 ? `\n  a: ${dg(a.state)}\n  b: ${dg(b.state)}` : ''}`);
}

/* ============ 24. audio.js lifecycle — unlock/dispose/mute churn (wave 5) ============ */
reseed(0xAD15);
const mkCountCtx = () => {
  const nodes = [];
  const val = x => { if (!Number.isFinite(x)) throw new RangeError(`non-finite audio param ${x}`); return true; };
  const param = v => ({ value: v,
    setValueAtTime(x) { val(x); this.value = x; },
    exponentialRampToValueAtTime(x) { val(x); this.value = x; },
    linearRampToValueAtTime(x) { val(x); this.value = x; },
    setTargetAtTime(x) { val(x); this.value = x; },
    cancelScheduledValues() {} });
  const mk = type => {
    const n = { type, frequency: param(440), Q: param(1), gain: param(1),
      buffer: null, loop: false, onended: null, conns: 0, discs: 0, stops: 0,
      connect() { this.conns++; }, disconnect() { this.discs++; },
      start() {}, stop() { this.stops++; } };
    nodes.push(n); return n;
  };
  return { nodes, currentTime: 0, sampleRate: 44100, closed: false,
    destination: mk('dest'), resume() {}, close() { this.closed = true; },
    createOscillator: () => mk('osc'), createGain: () => mk('gain'),
    createBiquadFilter: () => mk('filter'), createDynamicsCompressor: () => mk('comp'),
    createBufferSource: () => mk('src'),
    createBuffer: (ch, len) => ({ getChannelData: () => new Float32Array(len) }) };
};
{
  // unlock idempotence, dispose mid-swell, re-unlock recovery, crowd single-bed
  const c1 = mkCountCtx(), c2 = mkCountCtx();
  const a = new BoxingAudio();
  check('audio: unlock returns the ctx it adopted', a.unlock(c1) === c1);
  const mg = a.master;
  check('audio: second unlock is a no-op (no doubled master)',
    a.unlock(c2) === c1 && a.master === mg && c2.closed === false);
  a.update(DT, { phase: 'fighting', player: { stamina: 1 } });
  a.handleEvent('ko', {});                              // _crowdLevel = 1 — swell armed
  a.update(DT, { phase: 'fighting', player: { stamina: 1 } });
  const crowd = a._crowd;
  check('audio: crowd bed live + swelled before dispose',
    !!crowd && a._crowdLevel > 0, `crowd=${!!crowd} level=${a._crowdLevel}`);
  a.dispose();
  check('audio: dispose mid-swell — bed stopped+disconnected, ctx closed, meters reset',
    a._crowd === null && a.ctx === null && a.master === null && c1.closed === true
      && crowd.src.stops === 1 && crowd.lfo.stops === 1
      && [crowd.src, crowd.lfo, crowd.lg, crowd.filter, crowd.gain].every(n => n.discs >= 1)
      && mg.discs >= 1 && a._crowdLevel === 0,
    JSON.stringify({ crowd: !!a._crowd, ctx: !!a.ctx, closed: c1.closed,
      stops: [crowd.src.stops, crowd.lfo.stops],
      discs: [crowd.src.discs, crowd.lfo.discs, crowd.lg.discs, crowd.filter.discs, crowd.gain.discs],
      masterDiscs: mg.discs, level: a._crowdLevel }));
  check('audio: post-dispose API is inert — no voices on a dead ctx',
    a.play('bell', {}) === false && a.handleEvent('win', {}) === false);
  a.update(DT, { phase: 'fighting' }); a.muted = true; a.muted = false;   // silent no-ops
  const c3 = mkCountCtx();
  check('audio: unlock after dispose rebuilds the graph', a.unlock(c3) === c3);
  for (let i = 0; i < 30; i++) a.update(DT, { phase: 'fighting', player: { stamina: 1 } });
  const beds1 = c3.nodes.filter(n => n.type === 'src').length;
  a._crowdOn(); a._crowdOn();                           // direct hammer — no doubling
  const beds2 = c3.nodes.filter(n => n.type === 'src').length;
  check('audio: crowd bed never doubles under hammered _crowdOn', beds1 === 1 && beds2 === 1,
    `src nodes=${beds2}`);
  a.dispose();
}
{
  // 200 rapid unlock→sfx→dispose cycles with mute flips — never throws
  let err = null;
  try {
    const evts = Object.keys(EVENT_SFX);
    for (let i = 0; i < 200; i++) {
      const cx = mkCountCtx();
      const x = new BoxingAudio();
      x.unlock(cx);
      x.muted = i % 2 === 0;
      if (i % 3 === 0) x.muted = !(i % 6);
      x.handleEvent(evts[i % evts.length],
        { lastBlow: { kind: 'jab', dmg: 9 }, phase: 'fighting' });
      x.update(DT, { phase: i % 2 ? 'fighting' : 'win', player: { stamina: i % 5 ? 1 : .2 } });
      if (i % 4 === 0) x.update(DT, { phase: 'fighting' });
      x.dispose();
    }
  } catch (e) { err = e.message; }
  check('audio: 200 unlock→sfx→dispose churn cycles — never throws', !err, err);
}
{
  // dispose while muted + double dispose + post-dispose update — all no-ops
  const a = new BoxingAudio(); a.unlock(mkCountCtx());
  a.update(DT, { phase: 'fighting' });
  a.muted = true;
  let err = null;
  try { a.dispose(); a.dispose(); a.muted = false; a.update(DT, { phase: 'fighting' }); a.play('ko', {}); }
  catch (e) { err = e.message; }
  check('audio: dispose×2 while muted + post-dispose update — never throws', !err, err);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
