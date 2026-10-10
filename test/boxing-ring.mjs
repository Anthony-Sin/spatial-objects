/* test/boxing-ring.mjs — scripted assertions for shared/boxing/ring.js.
   Run: node test/boxing-ring.mjs   (no deps, no server)
   Prints PASS/FAIL lines; exits non-zero on any failure.

   Sway and dodge leave the feet in place. `playerStep` permits short
   forward/backward movement inside the corner leash.
*/
import { RingSim, TUNING } from '../shared/boxing/ring.js';

const DT = 1 / 60;
let passes = 0, fails = 0;
const check = (name, cond, info = '') => {
  if (cond) { passes++; console.log(`PASS ${name}`); }
  else { fails++; console.log(`FAIL ${name}${info ? '  — ' + info : ''}`); }
};

// displacement of the player's feet from spawn (corner zone)
const playerDisp = sim => Math.hypot(sim.player.pos.x - sim._home.x,
                                     sim.player.pos.z - sim._home.z);

// Legal = finite positions, inside ropes, not overlapping (>0.9·Σradii),
// and player feet inside the corner-zone leash.
function legality(sim) {
  for (const [n, f] of [['player', sim.player], ['npc', sim.npc]]) {
    if (!Number.isFinite(f.pos.x) || !Number.isFinite(f.pos.z)) return `${n} non-finite pos`;
    const r = Math.hypot(f.pos.x, f.pos.z), lim = sim.t.radius - f.radius;
    if (r > lim + 1e-9) return `${n} out of bounds r=${r.toFixed(3)} > ${lim.toFixed(3)}`;
  }
  const min = (sim.player.radius + sim.npc.radius) * 0.9;
  const d = sim.distance();
  if (d < min - 1e-9) return `overlap d=${d.toFixed(3)} < ${min.toFixed(3)}`;
  const pd = playerDisp(sim);
  if (pd > sim.t.playerLeash + 1e-9) return `player left corner zone disp=${pd.toFixed(3)}`;
  return null;
}

// Step the sim `secs` at fixed dt. inputFn(t,i)->input; onStep(sim,t,i) may
// return a failure string to abort early. Returns null if all legal.
function run(sim, secs, inputFn, onStep) {
  const n = Math.round(secs / DT);
  for (let i = 0; i < n; i++) {
    const t = i * DT;
    sim.step(DT, inputFn(t, i));
    const bad = legality(sim);
    if (bad) return `t=${t.toFixed(2)}s: ${bad}`;
    if (onStep) { const r = onStep(sim, t, i); if (r) return r; }
  }
  return null;
}

const wrap = a => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };

/* 1 — npcDir 'press' closes distance to punch range and holds it ---------- */
{
  const sim = new RingSim();
  const d0 = sim.distance();
  let minD = Infinity, rebound = 0, lateMax = 0, maxPD = 0;
  const err = run(sim, 4, () => ({ npcDir: 'press' }), (s, t) => {
    const d = s.distance();
    rebound = Math.max(rebound, d - minD);   // growth over the running minimum
    minD = Math.min(minD, d);
    maxPD = Math.max(maxPD, playerDisp(s));
    if (t > 2.5) lateMax = Math.max(lateMax, d);
  });
  const dEnd = sim.distance();
  check('press: legal every step', !err, err);
  check('press: closes to punch range',
    dEnd <= TUNING.punchRange + 0.25 && dEnd < d0 - 0.6,
    `d0=${d0.toFixed(2)} dEnd=${dEnd.toFixed(2)}`);
  check('press: monotonic-ish approach (rebound <= 0.4)', rebound <= 0.4,
    `rebound=${rebound.toFixed(2)}`);
  check('press: holds range late (<= punch+0.35)', lateMax > 0 && lateMax <= TUNING.punchRange + 0.35,
    `lateMax=${lateMax.toFixed(2)}`);
  check('press: player stays planted', maxPD <= 0.1, `maxDisp=${maxPD.toFixed(3)}`);
}

/* 2 — 'retreat' backs off toward the edge; nobody leaves the ring --------- */
{
  const sim = new RingSim();
  const d0 = sim.distance();
  let maxD = 0, maxNpcR = 0;
  const err = run(sim, 3.5, () => ({ npcDir: 'retreat' }), s => {
    maxD = Math.max(maxD, s.distance());
    maxNpcR = Math.max(maxNpcR, Math.hypot(s.npc.pos.x, s.npc.pos.z));
  });
  const lim = sim.t.radius - sim.npc.radius;
  check('retreat: legal every step', !err, err);
  check('retreat: gap grows', maxD >= d0 + 0.4, `d0=${d0.toFixed(2)} maxD=${maxD.toFixed(2)}`);
  check('retreat: npc reaches the ropes', maxNpcR >= lim * 0.85,
    `maxNpcR=${maxNpcR.toFixed(2)} lim=${lim.toFixed(2)}`);
}

/* 3 — no overlap under pressure; player never bulldozed ------------------- */
{
  // punchRange smaller than Σradii → the npc's press goal sits INSIDE the
  // player: a sustained bulldozing probe. Player must stay leashed and the
  // npc must absorb the separation.
  const sim = new RingSim({ punchRange: 0.5 });
  let minD = Infinity, maxPD = 0;
  const err = run(sim, 10, () => ({ npcDir: 'press' }), s => {
    minD = Math.min(minD, s.distance());
    maxPD = Math.max(maxPD, playerDisp(s));
  });
  const need = (sim.player.radius + sim.npc.radius) * 0.9;
  check('bulldoze: legal every step', !err, err);
  check('bulldoze (press 10s): player disp <= 0.1', maxPD <= 0.1,
    `maxDisp=${maxPD.toFixed(3)}`);
  check('bulldoze: npc absorbs separation (min dist >= 0.9*Σradii)',
    minD >= need - 1e-9, `minD=${minD.toFixed(3)} need=${need.toFixed(3)}`);
}

/* 4 — sway does NOT move the player's feet ------------------------------- */
{
  let maxPD = 0;
  const sim = new RingSim();
  const err = run(sim, 3, () => ({ npcDir: 'hold', sway: 1 }), s => {
    maxPD = Math.max(maxPD, playerDisp(s));
  });
  check('sway=+1 3s: legal every step', !err, err);
  check('sway=+1 3s: feet planted (disp <= 0.02)', maxPD <= 0.02,
    `maxDisp=${maxPD.toFixed(4)}`);

  maxPD = 0;
  const sim2 = new RingSim();
  const err2 = run(sim2, 3, () => ({ npcDir: 'hold', sway: -1 }), s => {
    maxPD = Math.max(maxPD, playerDisp(s));
  });
  check('sway=-1 3s: legal every step', !err2, err2);
  check('sway=-1 3s: feet planted (disp <= 0.02)', maxPD <= 0.02,
    `maxDisp=${maxPD.toFixed(4)}`);

  // idle: zero input → literally no motion
  const sim3 = new RingSim();
  run(sim3, 3, () => ({ npcDir: 'hold' }));
  check('idle 3s: zero motion', playerDisp(sim3) <= 0.001,
    `disp=${playerDisp(sim3).toFixed(4)}`);
}

/* 4b — depth footwork enters range and returns to neutral --------------- */
{
  const sim = new RingSim();
  const home = sim.player.pos.z;
  const forward = run(sim, 1.5, () => ({ npcDir: 'hold', playerStep: 1 }));
  check('step in: legal every frame', !forward, forward);
  check('step in moves the player toward the opponent', sim.player.pos.z < home - .45,
    `z=${sim.player.pos.z.toFixed(2)} home=${home}`);
  const back = run(sim, 1.5, () => ({ npcDir: 'hold', playerStep: -1 }));
  check('step back: legal every frame', !back, back);
  check('step back opens space', sim.player.pos.z > home + .12,
    `z=${sim.player.pos.z.toFixed(2)} home=${home}`);
  run(sim, 1.5, () => ({ npcDir: 'hold', playerStep: 0 }));
  check('neutral posture returns to corner mark', Math.abs(sim.player.pos.z - home) < .06);
}

/* 5 — 'circle' actually orbits: bearing accumulates + direction flips ----- */
{
  const sim = new RingSim({ seed: 42 });
  const bearing = s => Math.atan2(s.npc.pos.x - s.player.pos.x, s.npc.pos.z - s.player.pos.z);
  let prev = bearing(sim), acc = 0, prevSign = 0, flips = 0;
  let dMin = Infinity, dMax = 0, maxPD = 0;
  const err = run(sim, 12, () => ({ npcDir: 'circle' }), (s, t) => {
    const b = bearing(s), dd = wrap(b - prev); prev = b;
    acc += Math.abs(dd);
    if (Math.abs(dd) > 1e-4) {
      const sg = Math.sign(dd);
      if (prevSign && sg !== prevSign) flips++;
      prevSign = sg;
    }
    maxPD = Math.max(maxPD, playerDisp(s));
    if (t > 0.6) { dMin = Math.min(dMin, s.distance()); dMax = Math.max(dMax, s.distance()); }
  });
  check('circle: legal every step', !err, err);
  check('circle: bearing accumulates (>= 2 rad)', acc >= 2.0, `acc=${acc.toFixed(2)} rad`);
  check('circle: direction flips happen', flips >= 1, `flips=${flips}`);
  check('circle: holds mid band [0.8, 2.3]',
    dMin >= 0.8 && dMax <= 2.3, `dMin=${dMin.toFixed(2)} dMax=${dMax.toFixed(2)}`);
  check('circle: player stays planted', maxPD <= 0.1, `maxDisp=${maxPD.toFixed(3)}`);
}

/* 6 — A1: playerDodge inputs accepted, feet never hop ---------------------- */
{
  let maxPD = 0, hops = 0;
  const sim = new RingSim();
  const err = run(sim, 3, (t, i) => ({
    npcDir: 'hold',
    playerDodge: i % 20 === 0 ? (hops++ % 2 ? -1 : 1) : 0,  // alternating hops
    sway: Math.sin(t * 4),                              // weave on top
  }), s => { maxPD = Math.max(maxPD, playerDisp(s)); });
  check('dodge spam 3s: legal every step', !err, err);
  check('dodge spam: feet planted (disp <= 0.02)', maxPD <= 0.02,
    `maxDisp=${maxPD.toFixed(4)} hopsFed=${hops}`);

  // dodge inputs while being pressed: still planted, npc still closes
  const sim2 = new RingSim();
  maxPD = 0;
  const err2 = run(sim2, 5, (t, i) => ({
    npcDir: 'press', playerDodge: i % 25 === 0 ? 1 : 0,
  }), s => { maxPD = Math.max(maxPD, playerDisp(s)); });
  check('dodge+press: legal every step', !err2, err2);
  check('dodge+press: feet planted (disp <= 0.1)', maxPD <= 0.1,
    `maxDisp=${maxPD.toFixed(3)}`);
  check('dodge+press: npc still reached punch range',
    sim2.distance() <= TUNING.punchRange + 0.3, `d=${sim2.distance().toFixed(2)}`);
}

/* 7 — 1000 random-input steps: no NaN, in bounds, no overlap, planted ----- */
{
  const sim = new RingSim({ seed: 99 });
  let a = 12345;
  const rnd = () => (a = (a * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const dirs = ['press', 'circle', 'retreat', 'hold'];
  let bad = null, maxPD = 0;
  for (let i = 0; i < 1000; i++) {
    sim.step(DT, {
      sway: rnd() * 2 - 1,
      playerDodge: rnd() < 0.03 ? (rnd() < 0.5 ? -1 : 1) : 0,
      npcDir: dirs[(i / 90 | 0) % 4],
      npcStunned: rnd() < 0.08,
    });
    maxPD = Math.max(maxPD, playerDisp(sim));
    bad = legality(sim);
    if (bad) { bad = `step ${i}: ${bad}`; break; }
  }
  check('1000 random steps: finite / in-bounds / no overlap / planted', !bad, bad);
  check('1000 random steps: player disp <= 0.1', maxPD <= 0.1, `maxDisp=${maxPD.toFixed(3)}`);
}

/* 8 — settle: after a shove, the player re-centers in the corner zone ----- */
{
  const sim = new RingSim({ punchRange: 0.5 });       // bulldoze, then release
  let pressDisp = 0;
  run(sim, 4, () => ({ npcDir: 'press' }), s => {
    pressDisp = Math.max(pressDisp, playerDisp(s));
  });
  const err = run(sim, 2, () => ({ npcDir: 'retreat' }));
  const settled = playerDisp(sim);
  check('settle: legal every step', !err, err);
  check('settle: player returns toward spawn after shove',
    settled <= Math.max(pressDisp, 0.02) + 1e-9,
    `pressDisp=${pressDisp.toFixed(3)} settled=${settled.toFixed(3)}`);
}

/* 9 — determinism: same seed + same inputs → identical trajectory --------- */
{
  const a = new RingSim({ seed: 7 }), b = new RingSim({ seed: 7 });
  const dirs = ['press', 'circle', 'retreat', 'hold'];
  let diff = 0;
  for (let i = 0; i < 480; i++) {
    const inp = { sway: Math.sin(i / 40), playerDodge: i % 97 === 0 ? 1 : 0, npcDir: dirs[(i / 120 | 0) % 4] };
    a.step(DT, inp); b.step(DT, inp);
    diff = Math.max(diff,
      Math.abs(a.player.pos.x - b.player.pos.x),
      Math.abs(a.npc.pos.x - b.npc.pos.x));
  }
  check('deterministic given seed + inputs', diff === 0, `maxDiff=${diff}`);
}

console.log(`\n${passes} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
