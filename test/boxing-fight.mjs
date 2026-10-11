/* test/boxing-fight.mjs — drive shared/boxing/fight.js with scripted inputs.
   No deps: `node test/boxing-fight.mjs`. Prints PASS/FAIL lines, exits
   non-zero on any failure. */
import { Fight, TUNING } from '../shared/boxing/fight.js';

const DT = 1 / 60;
const IDLE = { punches: [], guard: { left: 0, right: 0 }, sway: 0, distance: 1.0 };
const inp = (o = {}) => ({
  punches: o.punches || [],
  guard: { left: 0, right: 0, ...(o.guard || {}) },
  sway: o.sway || 0,
  duck: o.duck || 0,
  dodge: o.dodge || 0,
  distance: o.distance ?? 1.0,
});

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '   <-- ' + extra}`);
  cond ? pass++ : fail++;
};

// step until pred(state) or secs elapse; every emitted event lands in seen[]
const until = (f, pred, secs, mk, seen = []) => {
  for (let i = 0, n = Math.ceil(secs / DT); i < n; i++) {
    f.step(DT, mk ? mk(f, i) : IDLE);
    for (const e of f.state.events) seen.push(e);
    if (pred(f.state)) return true;
  }
  return pred(f.state);
};
const toFighting = (f, seen = []) => until(f, s => s.phase === 'fighting', TUNING.introT + TUNING.countT + 1, null, seen);

/* 0 — intro → round-start → fighting */
{
  const f = new Fight({ seed: 7 });
  check('intro phase at construction', f.state.phase === 'intro', f.state.phase);
  const seen = [];
  check('intro resolves to fighting', toFighting(f, seen), f.state.phase);
  check('round-start emitted, round=1', seen.includes('round-start') && f.state.round === 1,
    `round=${f.state.round}`);
}

/* 0b — 3-2-1 countdown sits between the intro and the bell */
{
  const f = new Fight({ seed: 7 });
  until(f, s => s.phase !== 'intro', TUNING.introT + 1);
  check('intro hands off to a countdown', f.state.phase === 'countdown', f.state.phase);
  const seen = [], nums = [];
  const hp0 = f.state.npc.hp;
  until(f, s => s.phase === 'fighting', TUNING.countT + .5,
    g => { if (g.state.countdown && nums.at(-1) !== g.state.countdown) nums.push(g.state.countdown);
      return inp({ punches: [{ kind: 'cross', side: 'right', power: 1 }], distance: 1 }); }, seen);
  check('countdown ticks 3,2,1 then the bell', nums.join() === '3,2,1'
    && seen.filter(e => e === 'countdown').length === 3 && seen.at(-1) === 'round-start', `${nums} | ${seen}`);
  check('nothing lands during the countdown', f.state.npc.hp === hp0 && !seen.includes('player-hit'));
  f.startNow();
  check('startNow mid-fight is a no-op', f.state.phase === 'fighting');
}

/* 0c — tutorial hooks: parked AI, scripted swings, practice can't KO */
{
  const f = new Fight({ seed: 7, ai: false, practice: true });
  toFighting(f);
  const seen = [];
  until(f, () => false, 5, null, seen);
  check('ai:false → PIP never swings on its own', !seen.includes('npc-punch') && f.state.npc.action === 'idle',
    `${f.state.npc.action} ${seen}`);
  check('throwPunch starts a telegraphed windup', f.throwPunch('hook', 'right', 1.2)
    && f.state.npc.telegraph?.kind === 'hook' && f.state.npc.telegraph.side === 'right');
  check('throwPunch refuses while PIP is busy', f.throwPunch('jab') === false);
  until(f, s => s.events.includes('player-hit-taken'), 3);
  f.state.player.hp = 3;
  f._pk = { kind: 'upper', side: 'left' }; f._impact(inp());
  check('practice: player is never KO\'d', f.state.phase === 'fighting' && f.state.player.hp > 0, f.state.phase);
  const t0 = f.state.timeLeft;
  until(f, () => false, 1);
  check('practice: clock does not run', f.state.timeLeft === t0);
}

/* 1 — scripted punch in range → npc.hp drops + 'player-hit' */
{
  const f = new Fight({ seed: 7 });
  toFighting(f);
  f.state.npc.action = 'press'; f.state.npc.actionT = 0;   // no-slip window
  const hp0 = f.state.npc.hp;
  f.step(DT, inp({ punches: [{ kind: 'cross', side: 'right', power: 1 }], distance: 1.0 }));
  const drop = hp0 - f.state.npc.hp;
  check('player punch lands → npc.hp drops', drop > 0, `drop=${drop}`);
  check("'player-hit' + 'npc-hit' emitted",
    f.state.events.includes('player-hit') && f.state.events.includes('npc-hit'),
    f.state.events.join(','));
  check('cross @power 1 deals TUNING.dmg.cross', Math.abs(drop - TUNING.dmg.cross) < .01, `drop=${drop}`);
  check('npc staggers into hurt', f.state.npc.action === 'hurt', f.state.npc.action);
}
{
  const f = new Fight({ seed: 7 });
  toFighting(f);
  f.state.npc.action = 'press';
  const hp0 = f.state.npc.hp;
  f.step(DT, inp({ punches: [{ kind: 'jab', side: 'left', power: .15 }], distance: 1.35 }));
  check('a visible mid-range jab connects', f.state.npc.hp < hp0);
}

/* 2 — npc windup → punch lands on idle player */
const captureKind = () => {   // remembers the last telegraphed swing kind/side
  let k = { kind: null, side: null };
  return { get: () => k, feed: f => { const t = f.state.npc.telegraph; if (t) k = t; } };
};
{
  const f = new Fight({ seed: 7 });
  toFighting(f);
  const seen = [], cap = captureKind();
  const wound = until(f, s => s.npc.action === 'windup', 8, g => { cap.feed(g); return IDLE; }, seen);
  check('npc reaches a telegraphed windup', wound, `action=${f.state.npc.action}`);
  check('telegraph exposes {kind,t01} 0..1',
    f.state.npc.telegraph && f.state.npc.telegraph.t01 >= 0 && f.state.npc.telegraph.t01 <= 1,
    JSON.stringify(f.state.npc.telegraph));
  const hp0 = f.state.player.hp;
  until(f, s => s.player.hp < s.player.maxHp || s.events.includes('player-dodged'), 3,
    g => { cap.feed(g); return IDLE; }, seen);
  const kind = cap.get().kind;
  const took = hp0 - f.state.player.hp;
  check("'npc-punch' then 'player-hit-taken' on idle player",
    seen.includes('npc-punch') && seen.includes('player-hit-taken'), seen.join(','));
  check('full damage for the thrown kind', took === TUNING.npcDmg[kind],
    `kind=${kind} took=${took}`);
}

/* 3 — same attack, guard raised on the matching (mirrored) side → half damage */
{
  const f = new Fight({ seed: 7 });
  toFighting(f);
  const seen = [], cap = captureKind();
  // once a telegraph appears, raise + HOLD the mirrored guard through the swing
  let gside = null;
  const mk = g => {
    cap.feed(g);
    const t = g.state.npc.telegraph;
    if (t) gside = t.side === 'left' ? 'right' : 'left';
    return inp({ guard: gside ? { [gside]: 1 } : {} });
  };
  until(f, s => s.events.includes('player-blocked') || s.events.includes('player-hit-taken')
    || s.events.includes('player-dodged'), 10, mk, seen);
  const kind = cap.get().kind;
  const hp0 = 100, took = hp0 - f.state.player.hp;
  check("guarded swing → 'player-blocked' (not hit-taken/dodged)",
    seen.includes('player-blocked') && !seen.includes('player-hit-taken') && !seen.includes('player-dodged'),
    seen.join(','));
  check('blocked damage = half of full', Math.abs(took - TUNING.npcDmg[kind] * TUNING.blockMul) < .01,
    `kind=${kind} took=${took}`);
}

/* 4 — same attack, sway committed ON the telegraph → zero damage + 'player-dodged' */
const resolvedSwing = s => s.events.includes('player-dodged') || s.events.includes('player-hit-taken')
  || s.events.includes('player-blocked');
{
  const f = new Fight({ seed: 7 });
  toFighting(f);
  const seen = [];
  // lean once the telegraph is half charged — a real read, not a parked lean
  const mk = g => inp({ sway: g.state.npc.telegraph?.t01 > .5 || g.state.npc.action === 'punch' ? 1 : 0 });
  const resolved = until(f, resolvedSwing, 12, mk, seen);
  check('sway on the telegraph resolves an npc attack', resolved, seen.join(','));
  check("'player-dodged', zero damage, no hit-taken",
    seen.includes('player-dodged') && !seen.includes('player-hit-taken')
      && f.state.player.hp === f.state.player.maxHp,
    `hp=${f.state.player.hp} events=${seen.join(',')}`);
  check('a fresh lean commits a dodge move', seen.includes('player-dodge'), seen.join(','));
  until(f, s => s.npc.action !== 'punch', 1);
  check('dodged swing leaves PIP off-balance (whiff)', ['whiff', 'stunned'].includes(f.state.npc.action),
    f.state.npc.action);
}

/* 4b — a lean PARKED through the whole windup gets tagged: PIP aims at your head */
{
  const f = new Fight({ seed: 7 });
  toFighting(f);
  const seen = [];
  until(f, resolvedSwing, 12, () => inp({ sway: 1 }), seen);
  check('held lean through the telegraph → hit-taken', seen.includes('player-hit-taken')
    && !seen.includes('player-dodged'), seen.join(','));
}

/* 4c — perfect dodge: commit inside perfectWin of impact → stun + flurry */
{
  const f = new Fight({ seed: 7 });
  toFighting(f);
  const seen = [];
  // key-dodge on the last ~.1s before impact (end of windup)
  const mk = g => inp({ dodge: g.state.npc.action === 'windup' && g.state.npc.telegraph.t01 > .93 ? 1 : 0 });
  until(f, resolvedSwing, 12, mk, seen);
  check("late key-dodge → 'perfect-dodge'", seen.includes('perfect-dodge') && f.state.player.perfects === 1,
    seen.join(','));
  until(f, s => s.npc.action !== 'punch', 1);
  check('perfect dodge leaves PIP stunned', f.state.npc.action === 'stunned', f.state.npc.action);
  const hp0 = f.state.npc.hp;
  f.state.player.counterT = 0;               // isolate the flurry bonus
  f.step(DT, inp({ punches: [{ kind: 'jab', side: 'left', power: 1 }] }));
  check('flurry hit: bonus damage, PIP stays stunned (no i-frames)',
    Math.abs(hp0 - f.state.npc.hp - TUNING.dmg.jab * TUNING.counterDamage) < .01
      && f.state.npc.action === 'stunned', `dmg=${hp0 - f.state.npc.hp} action=${f.state.npc.action}`);
  const hp1 = f.state.npc.hp;
  f.step(DT, inp({ punches: [{ kind: 'cross', side: 'right', power: 1 }] }));
  check('second flurry hit lands back-to-back', f.state.npc.hp < hp1, `hp=${f.state.npc.hp}`);
  let t = 0;
  while (f.state.npc.action === 'stunned' && t < 3) { f.step(DT, IDLE); t += DT; }
  check('flurry hits shave the stun', t < TUNING.perfectStun - 2 * TUNING.stunHitCost + .1, `left=${t.toFixed(2)}`);
}

/* 4d — dodging too EARLY (window expires before impact) still gets tagged */
{
  const f = new Fight({ seed: 7 });
  toFighting(f);
  const seen = [];
  let fired = false;
  const mk = g => {
    const go = !fired && g.state.npc.action === 'windup';
    if (go) fired = true;
    return inp({ dodge: go ? -1 : 0 });
  };
  until(f, resolvedSwing, 12, mk, seen);
  check('key-dodge at windup start expires → hit-taken', seen.includes('player-dodge')
    && seen.includes('player-hit-taken'), seen.join(','));
}

/* 4e — dodge can't be spammed; ducking into an uppercut hurts more */
{
  const f = new Fight({ seed: 7 });
  toFighting(f);
  f.step(DT, inp({ dodge: 1 }));
  check('key dodge starts a slip', f.state.player.dodge.dir === 'right' && f.state.player.status === 'dodging');
  for (let i = 0; i < Math.ceil(TUNING.dodgeWin / DT) + 1; i++) f.step(DT, inp({ distance: 4 }));
  check('slip ends into a cooldown', f.state.player.dodge.dir === null && f.state.player.dodge.cd > 0);
  f.step(DT, inp({ dodge: -1, distance: 4 }));
  check('dodge during cooldown is ignored', f.state.player.dodge.dir === null);

  const g = new Fight({ seed: 7 });
  toFighting(g);
  g._pk = { kind: 'upper', side: 'right' };
  g.state.player.dodge.dir = 'duck'; g.state.player.dodge.t = .1;
  g._impact(inp({ guard: { left: 1, right: 1 } }));
  check('ducking INTO an uppercut: guard ignored, extra damage',
    g.state.lastBlow.result === 'hit' && g.state.lastBlow.reason === 'ducked-into'
      && Math.abs(100 - g.state.player.hp - TUNING.npcDmg.upper * TUNING.duckUpperMul) < .01,
    JSON.stringify(g.state.lastBlow));
  const h = new Fight({ seed: 7 });
  toFighting(h);
  h._pk = { kind: 'hook', side: 'left' };
  h.state.player.dodge.dir = 'duck'; h.state.player.dodge.t = .4;
  h._impact(inp());
  check('ducking a hook is a clean dodge', h.state.lastBlow.result === 'dodged', JSON.stringify(h.state.lastBlow));
}

/* 4f — PIP chains combos on an idle target */
{
  let maxChain = 0;
  for (const seed of [1, 3, 7, 11]) {
    const f = new Fight({ seed });
    toFighting(f);
    for (let i = 0; i < 20 * 60 && f.state.phase === 'fighting'; i++) {
      f.step(DT, IDLE);
      maxChain = Math.max(maxChain, f.state.npc.telegraph?.combo || 0);
    }
  }
  check('PIP throws multi-punch combos', maxChain >= 1, `maxChain=${maxChain}`);
}

/* 5 — hammer npc.hp → 'npcdown' → 'win' */
{
  const f = new Fight({ seed: 7 });
  const seen = [];
  toFighting(f, seen);
  const punch = { kind: 'cross', side: 'right', power: 1 };
  const mk = g => {   // respect the stagger i-frames; top stamina (tested separately)
    g.state.player.stamina = 1;
    const hittable = !['hurt', 'down'].includes(g.state.npc.action);
    return inp({ punches: hittable ? [punch] : [] });
  };
  const downed = until(f, s => s.phase === 'npcdown', 30, mk, seen);
  check("hammering → 'ko' event + npcdown phase", downed && seen.includes('ko'),
    `phase=${f.state.phase} hp=${f.state.npc.hp}`);
  check('npc action is down', f.state.npc.action === 'down', f.state.npc.action);
  const won = until(f, s => s.phase === 'win', 4, null, seen);
  check("down resolves to 'win' phase + event", won && seen.includes('win'), f.state.phase);
  check('ko score awarded', f.state.player.score >= TUNING.score.ko, `score=${f.state.player.score}`);
}

/* 6 — npcDir() always valid + stamina gates spam */
{
  const f = new Fight({ seed: 3 });
  const DIRS = new Set(['press', 'circle', 'retreat', 'hold']);
  let bad = 0, seenDirs = new Set();
  for (let i = 0; i < Math.ceil((TUNING.introT + 10) / DT); i++) {
    const d = f.npcDir();
    if (!DIRS.has(d)) bad++;
    seenDirs.add(d);
    f.step(DT, inp({ distance: 1.5 + Math.sin(i / 40), sway: Math.sin(i / 25) * .3 }));
  }
  check('npcDir() returns a valid directive every step', bad === 0, `bad=${bad}`);
  check('npc actually moves (≥2 distinct directives)', seenDirs.size >= 2, [...seenDirs].join(','));

  const g = new Fight({ seed: 7 });
  toFighting(g);
  g.state.npc.action = 'press'; g.state.npc.actionT = 0;
  g.state.player.stamina = .05;                  // below the .16 cross cost
  g.step(DT, inp({ punches: [{ kind: 'cross', side: 'right', power: 1 }] }));
  check("exhausted punch → 'player-miss' reason 'exhausted'",
    g.state.events.includes('player-miss') && g.state.lastBlow?.reason === 'exhausted',
    JSON.stringify(g.state.lastBlow));
  check('stamina never negative', g.state.player.stamina >= 0, g.state.player.stamina);
  const sBefore = g.state.player.stamina = 1;
  g.step(DT, inp({ punches: [{ kind: 'jab', side: 'left', power: .8 }] }));
  check('successful punch spends stamina',
    g.state.player.stamina < sBefore, g.state.player.stamina);
}

/* 7 — determinism: same seed + same inputs → identical outcome */
{
  const script = i => inp({
    distance: 1.2 + Math.sin(i / 30) * .6, sway: Math.sin(i / 21) * .4,
    guard: { left: i % 90 < 20 ? .8 : 0 },
    punches: i % 45 === 0 ? [{ kind: 'jab', side: 'left', power: .8 }] : [],
  });
  const runIt = () => {
    const f = new Fight({ seed: 42 });
    for (let i = 0; i < 900; i++) f.step(DT, script(i));
    const s = f.state;
    return [s.phase, s.round, s.npc.hp, s.player.hp, s.npc.action, s.player.score].join('|');
  };
  check('seeded run is reproducible', runIt() === runIt(), runIt());
}

/* 8 — regen is real: slower after punching and after taking a hit */
{
  const idleRegen = () => {
    const f = new Fight({ seed: 7 });
    toFighting(f);
    f.state.player.stamina = .5;
    for (let i = 0; i < 30; i++) f.step(DT, IDLE);      // .5s doing nothing
    return f.state.player.stamina - .5;
  };
  const punchedRegen = () => {
    const f = new Fight({ seed: 7 });
    toFighting(f);
    f.state.npc.action = 'press'; f.state.npc.actionT = 0;
    f.state.player.stamina = .5;
    f.step(DT, inp({ punches: [{ kind: 'jab', side: 'left', power: .8 }] }));
    for (let i = 0; i < 29; i++) f.step(DT, IDLE);      // .5s total, punch first
    return f.state.player.stamina - .5;
  };
  const idle = idleRegen(), punched = punchedRegen();
  check('regen slower while punching/recovering', punched < idle - .02,
    `idle=${idle.toFixed(3)} punched=${punched.toFixed(3)}`);

  // after taking a real hit, regen stays slow for ~hurtRegenT
  const f = new Fight({ seed: 7 });
  toFighting(f);
  until(f, s => s.events.includes('player-hit-taken'), 10);
  f.state.player.stamina = .5;
  const s0 = f.state.player.stamina;
  for (let i = 0; i < 30; i++) f.step(DT, inp({ distance: 3 })); // out of range, no new hits
  const hurtRegen = f.state.player.stamina - s0;
  check('regen slower after being hit', hurtRegen < idle - .02,
    `idle=${idle.toFixed(3)} hurt=${hurtRegen.toFixed(3)}`);
}

/* 9 — gassed state: flag flips, punches weaker + slower, guard sluggish */
{
  const f = new Fight({ seed: 7 });
  toFighting(f);
  check('gassed flag starts false', f.state.player.gassed === false);
  f.state.player.stamina = TUNING.gassedT - .1;
  f.step(DT, IDLE);
  check('gassed flag flips below gassedT', f.state.player.gassed === true,
    `stam=${f.state.player.stamina}`);

  // weak punch while gassed: affordable (≥cross cost) but below gassedT
  f.state.npc.action = 'press'; f.state.npc.actionT = 0;
  f.state.player.stamina = TUNING.stamCost.cross + .02;  // .18 — under gassedT .3
  f.step(DT, IDLE);                                     // settle the gassed flag
  const hp0 = f.state.npc.hp;
  f.step(DT, inp({ punches: [{ kind: 'cross', side: 'right', power: 1 }] }));
  const weak = hp0 - f.state.npc.hp;
  const expect = TUNING.dmg.cross * (TUNING.powFloor + (1 - TUNING.powFloor) * TUNING.gasPower);
  check('gassed punch lands weak', weak > 0 && Math.abs(weak - expect) < .01,
    `weak=${weak.toFixed(2)} expect=${expect.toFixed(2)}`);

  // slower: 'punching' status persists longer when gassed than fresh
  const punchWindow = (gas) => {
    const g = new Fight({ seed: 7 });
    toFighting(g);
    g.state.npc.action = 'press'; g.state.npc.actionT = 0;
    g.state.player.stamina = gas ? TUNING.gassedT - .05 : 1;
    g.step(DT, IDLE);                                   // settle gassed flag
    g.step(DT, inp({ punches: [{ kind: 'jab', side: 'left', power: .8 }] }));
    let t = 0;
    while (g.state.player.status === 'punching' && t < 3) { g.step(DT, IDLE); t += DT; }
    return t;
  };
  check('gassed punch recovers slower', punchWindow(true) > punchWindow(false) * 1.2,
    `gassed=${punchWindow(true).toFixed(2)} fresh=${punchWindow(false).toFixed(2)}`);

  // sluggish guard: gassed player can't block even with guard fully up
  const g = new Fight({ seed: 7 });
  toFighting(g);
  const seen = [], cap = captureKind();
  let gside = null;
  const mk = h => {
    cap.feed(h);
    const t = h.state.npc.telegraph;
    if (t) gside = t.side === 'left' ? 'right' : 'left';
    h.state.player.stamina = .05;                       // pinned below gassedT
    return inp({ guard: gside ? { [gside]: 1 } : {} });
  };
  until(g, s => s.events.includes('player-blocked') || s.events.includes('player-hit-taken'), 12, mk, seen);
  check('gassed guard cannot block → hit-taken', seen.includes('player-hit-taken') && !seen.includes('player-blocked'),
    seen.join(','));
}

/* 10 — NPC fatigue is reachable during a combo burst */
{
  const f = new Fight({ seed: 7, playerHp: 1e6 });
  toFighting(f);
  let min = 1, sawGassed = false;
  for (let i = 0; i < 30 * 60; i++) {   // idle (unkillable) player at close range
    f.step(DT, IDLE);
    min = Math.min(min, f.state.npc.stamina);
    if (f.state.npc.gassed) sawGassed = true;
  }
  check('npc stamina drops below gassedT under sustained attack',
    min < TUNING.gassedT && sawGassed, `min=${min.toFixed(3)} gassed=${sawGassed}`);
}

/* 10b — the 3-punch flurry is a stamina-gated SPECIAL behind ~3 normals */
{
  const f = new Fight({ seed: 11, playerHp: 1e6 });
  toFighting(f);
  let last = '', seq = [], maxCombo = 0, sawNormalChain = false;
  for (let i = 0; i < 120 * 60 && f.state.phase === 'fighting'; i++) {
    const n = f.state.npc, t = n.telegraph;
    // guard the telegraphed side so swings 'block' → flurries can still chain
    f.step(DT, t ? inp({ distance: .9, guard: t.side === 'left' ? { right: 1 } : { left: 1 } })
               : inp({ distance: .9 }));
    if (n.action === 'windup' && last !== 'windup') {
      if (n.telegraph.combo === 0) seq.push(f._wantCombo ? 'S' : 'n');
      else if (!f._wantCombo) sawNormalChain = true;
      maxCombo = Math.max(maxCombo, n.telegraph.combo);
    }
    last = n.action;
  }
  const firstS = seq.indexOf('S');
  check('~three normal attacks lead before the first special',
    firstS === TUNING.specialEvery, `firstS=${firstS} seq=${seq.join('')}`);
  check('every special is preceded by at least specialEvery normals',
    seq.reduce((ok, c, i) => ok && (c !== 'S' || seq.slice(Math.max(0, i - TUNING.specialEvery), i).every(x => x === 'n')), true),
    seq.join(''));
  check('the special still chains to the third punch', maxCombo >= TUNING.comboMax - 1,
    `maxCombo=${maxCombo}`);
  check('normal attacks never chain', !sawNormalChain, seq.join(''));

  // the gate: counter ready but stamina under the floor → stays normal
  const g = new Fight({ seed: 5 });
  toFighting(g);
  g._normals = TUNING.specialEvery;
  g.state.npc.stamina = TUNING.specialStam - .05;
  g._windup();
  check('stamina below the floor keeps the next attack normal',
    g._wantCombo === false && g._normals === TUNING.specialEvery + 1,
    `want=${g._wantCombo} normals=${g._normals}`);

  // the cost: counter + floor met → special flags and burns specialCost up front
  const h = new Fight({ seed: 5 });
  toFighting(h);
  h._normals = TUNING.specialEvery;
  h.state.npc.stamina = .9;
  h._windup();
  check('the special resets the count and burns stamina up front',
    h._wantCombo === true && h._normals === 0
      && h.state.npc.stamina <= .9 - TUNING.specialCost + .001,
    `want=${h._wantCombo} normals=${h._normals} stam=${h.state.npc.stamina.toFixed(3)}`);
}

/* 10c — per-variant specials: sumo's SUMO SLAM, bean's BEAN BARRAGE */
{
  // SUMO SLAM — sumo throws one huge telegraphed uppercut that chips guard
  const f = new Fight({ seed: 5, npcVariant: 'sumo' });
  toFighting(f);
  f._normals = TUNING.specialEvery;
  f.state.npc.stamina = .9;
  const stam0 = f.state.npc.stamina;
  f._windup();
  check('sumo: gate met → SUMO SLAM telegraph (upper, slow windup)',
    (f._wantSlam === true || f._wantSledge === true) && f.state.npc.telegraph?.kind === 'upper'
      && f.state.npc.telegraph.special === 'SUMO SLAM',
    `telegraph=${JSON.stringify(f.state.npc.telegraph)}`);
  check('sumo: slam burns its own stamina cost',
    f.state.npc.stamina <= stam0 - .29, `stam=${f.state.npc.stamina.toFixed(2)}`);
  const seen0 = [];
  until(f, s => s.events.length > 0 || s.npc.action !== 'windup', 3, null, seen0);
  // damage: base upper × sumo dmg stat × slam mult; guard only chips it
  const g = new Fight({ seed: 5, npcVariant: 'sumo' });
  toFighting(g);
  g._wantSlam = true; g._wantSledge = true; g._pk = { kind: 'upper', side: 'left' };
  const hp0 = g.state.player.hp;
  g._impact(inp({ guard: { right: 1 } }));           // fully guarded still hurts
  const chipDmg = 17 * 1.25 * 1.6 * .7;
  check('sumo: SUMO SLAM cracks the guard — chip damage through a block',
    Math.abs(hp0 - g.state.player.hp - chipDmg) < .5 && g.state.lastBlow.special === 'SUMO SLAM',
    `took=${hp0 - g.state.player.hp} expect≈${chipDmg.toFixed(1)}`);
  const h = new Fight({ seed: 5, npcVariant: 'sumo' });
  toFighting(h);
  h._wantSlam = true; h._wantSledge = true; h._pk = { kind: 'upper', side: 'left' };
  const hp1 = h.state.player.hp;
  h._impact(inp());                                   // unguarded — full slam
  check('sumo: unguarded SUMO SLAM hits for ~1.6× a tuned upper',
    Math.abs(hp1 - h.state.player.hp - 17 * 1.25 * 1.6) < .5,
    `took=${hp1 - h.state.player.hp}`);

  // BEAN BARRAGE — bean chains exactly two fast swings, not three
  const b = new Fight({ seed: 5, npcVariant: 'bean' });
  toFighting(b);
  b._normals = TUNING.specialEvery;
  b.state.npc.stamina = .9;
  b._windup();
  check('bean: gate met → BEAN BARRAGE flurry flagged',
    b._wantCombo === true && b._chainMax === 2
      && b.state.npc.telegraph.special === 'BEAN BARRAGE',
    `want=${b._wantCombo} max=${b._chainMax} tele=${JSON.stringify(b.state.npc.telegraph)}`);
  // one landed first swing may chain exactly ONE follow-up (chain < 1)
  b._swing = 'blocked'; b._chain = 0;
  b._afterSwing(inp({ distance: .9 }));
  check('bean: landed swing chains the second barrage jab',
    b.state.npc.action === 'windup' && b._chain === 1,
    `action=${b.state.npc.action} chain=${b._chain}`);
  b.state.npc.action = 'punch'; b._swing = 'blocked';
  b._afterSwing(inp({ distance: .9 }));
  check('bean: the 1-2 ends — no third punch',
    b.state.npc.action !== 'windup', `action=${b.state.npc.action}`);

  // 'npc-special' announces the gated windup; GLB ids fall back to bubble's flurry
  const ev = new Fight({ seed: 5 });
  toFighting(ev);
  ev._normals = TUNING.specialEvery; ev.state.npc.stamina = .9;
  ev._windup();
  check("'npc-special' event fires when a special telegraphs",
    ev.state.events.includes('npc-special'), ev.state.events.join(','));
  const glb = new Fight({ seed: 5, npcVariant: 'some-glb-import' });
  check('unknown variant falls back to the bubble flurry', glb._special.key === 'flurry');
}

/* 11 — defending opens a counter; consecutive clean hits build a chain */
{
  const f = new Fight({ seed: 7 });
  toFighting(f);
  f._pk = { kind: 'jab', side: 'left' };
  f._impact(inp({ guard: { right: 1 } }));
  check('a blocked attack opens a counter window', f.state.player.counterT > 0);
  f.state.npc.action = 'press';
  const hp0 = f.state.npc.hp;
  f.step(DT, inp({ punches: [{ kind: 'jab', side: 'left', power: 1 }] }));
  check('counter punch deals bonus damage and emits cue',
    Math.abs(hp0 - f.state.npc.hp - TUNING.dmg.jab * TUNING.counterDamage) < .01
      && f.state.events.includes('counter'), `damage=${hp0 - f.state.npc.hp}`);
  f.state.npc.action = 'press';
  f.step(DT, inp({ punches: [{ kind: 'cross', side: 'right', power: 1 }] }));
  check('consecutive hits build the combo', f.state.player.combo === 2 && f.state.player.bestCombo === 2);
  for (let i = 0; i < Math.ceil(TUNING.comboWindow / DT) + 2; i++) f.step(DT, inp({ distance: 4 }));
  check('combo expires when pressure drops', f.state.player.combo === 0);
}

/* 12 — NaN / garbage inputs can't bypass checks */
{
  const f = new Fight({ seed: 7 });
  toFighting(f);
  f.state.npc.action = 'press'; f.state.npc.actionT = 0;
  const hp0 = f.state.npc.hp;
  f.step(DT, { punches: [{ kind: 'cross', side: 'right', power: 1 }], distance: NaN });
  check('NaN distance → no hit, player-miss',
    f.state.npc.hp === hp0 && f.state.events.includes('player-miss')
      && f.state.lastBlow?.reason === 'range',
    `hp=${f.state.npc.hp} blow=${JSON.stringify(f.state.lastBlow)}`);
  f.step(DT, { punches: [{ kind: 'cross', power: 1 }], distance: 'far' });
  check("string distance → no hit", f.state.npc.hp === hp0, f.state.npc.hp);

  // NaN sway/guard are treated as 0 — a swing lands clean, no phantom dodge
  const seen = [];
  until(f, s => s.events.includes('player-hit-taken') || s.events.includes('player-dodged'), 12,
    () => ({ sway: NaN, guard: { left: NaN, right: undefined }, distance: 1.0, punches: [] }), seen);
  check('NaN sway/guard → no dodge/block, hit lands',
    seen.includes('player-hit-taken') && !seen.includes('player-dodged'), seen.join(','));
}

/* 13 — the corner break: halftime patch-up + a fresh round, never a full heal */
{
  const f = new Fight({ seed: 7 });
  toFighting(f);
  f.state.player.hp = 20; f.state.player.stamina = .1;
  check('corner() patches to cornerHeal of max, never full',
    f.corner() === true
      && f.state.player.hp === 100 * TUNING.cornerHeal
      && f.state.player.hp < f.state.player.maxHp,
    `hp=${f.state.player.hp}`);
  check('corner() → next round countdown (round 2)',
    f.state.phase === 'countdown' && f.state.round === 2,
    `${f.state.phase} r${f.state.round}`);
  check('corner() restores the stamina floor', f.state.player.stamina >= TUNING.cornerStam,
    `stam=${f.state.player.stamina}`);
  check("corner emits 'corner'", f.state.events.includes('corner'), f.state.events.join(','));
  const seen = [];
  check('the next bell rings the fight back in',
    toFighting(f, seen) && seen.includes('round-start'), f.state.phase);

  // a healthier fighter keeps their hp — the corner only raises the floor
  const f2 = new Fight({ seed: 7 });
  toFighting(f2);
  f2.state.player.hp = 80;
  f2.corner();
  check('hp above the floor stays put', f2.state.player.hp === 80, `hp=${f2.state.player.hp}`);

  // the last round can't halftime into a fourth — it just replays itself
  f.state.round = TUNING.rounds; f.state.player.hp = 10;
  f.corner();
  check('final-round corner replays the last round, not a round 4',
    f.state.round === TUNING.rounds && f.state.phase === 'countdown', `r=${f.state.round}`);

  // no corner for the dead or the down, and never before the bell
  const f3 = new Fight({ seed: 7 });
  check('corner() refuses before the first bell', f3.corner() === false, f3.state.phase);
  toFighting(f3);
  f3.state.player.hp = 0;
  check('corner() refuses a downed fighter', f3.corner() === false, f3.state.phase);
}

/* 14 — beat the count: a player KO opens the get-up QTE — tag `riseTargets`
   rings before riseT runs out and you stand back up at riseHp, miss and the
   verdict lands like before. */
{
  const drop = (f) => {   // a real landed swing onto 1hp → the canvas
    f.state.player.hp = 1;
    f.state.npc.action = 'punch'; f.state.npc.actionT = 0;
    f._pk = { kind: 'jab', side: 'left' };
    f._impact(inp({ distance: .8 }));
  };
  const f = new Fight({ seed: 7 });
  toFighting(f);
  drop(f);
  check('player KO → playerdown + get-up QTE armed',
    f.state.phase === 'playerdown' && f.state.rise.active
      && f.state.rise.need === TUNING.riseTargets && f.state.rise.got === 0,
    `phase=${f.state.phase} rise=${JSON.stringify(f.state.rise)}`);
  check("'ko' + 'rise' events fire together",
    f.state.events.includes('ko') && f.state.events.includes('rise'), f.state.events.join(','));
  check('ring sits in reach — inside the overlay bounds',
    f.state.rise.x >= .1 && f.state.rise.x <= .9 && f.state.rise.y >= .2 && f.state.rise.y <= .8
      && f.state.rise.r > 0, JSON.stringify(f.state.rise));

  // wild punches don't tag — and a punch with no position never can
  f.step(DT, inp({ punches: [{ kind: 'jab', side: 'left', power: 1, x: 0, y: 0 }] }));
  check('off-ring punch → rise-miss, still down',
    f.state.events.includes('rise-miss') && f.state.phase === 'playerdown' && f.state.rise.got === 0,
    `${f.state.events}`);
  f.step(DT, inp({ punches: [{ kind: 'jab', side: 'left', power: 1 }] }));
  check('positionless punch can never tag a ring',
    f.state.rise.got === 0 && f.state.phase === 'playerdown', `got=${f.state.rise.got}`);

  // tag every ring as it pops — the palm lands where the ring is
  let hits = 0, revived = false;
  for (let i = 0; i < TUNING.riseTargets * 4 && f.state.phase === 'playerdown'; i++) {
    f.step(DT, inp({ punches: [{ kind: 'jab', side: 'left', power: 1,
      x: f.state.rise.x, y: f.state.rise.y }] }));
    if (f.state.events.includes('rise-hit')) hits++;
    if (f.state.events.includes('revive')) revived = true;
  }
  check(`${TUNING.riseTargets} rings tagged → revive + back to fighting`,
    revived && hits === TUNING.riseTargets && f.state.phase === 'fighting',
    `hits=${hits} phase=${f.state.phase}`);
  check('revive stands you up at riseHp of max',
    f.state.player.hp === Math.round(f.state.player.maxHp * TUNING.riseHp)
      && f.state.player.hp > 0 && !f.state.rise.active,
    `hp=${f.state.player.hp} rise=${JSON.stringify(f.state.rise)}`);
  check('PIP backs off while you rise', f.state.npc.action === 'idle', f.state.npc.action);

  // second knockdown — the count re-arms; stay down and the verdict lands
  drop(f);
  const seen = [];
  check('second KO re-arms the QTE',
    f.state.phase === 'playerdown' && f.state.rise.active && f.state.rise.got === 0,
    `phase=${f.state.phase} got=${f.state.rise.got}`);
  until(f, s => f._phaseT >= TUNING.downT + .5, TUNING.riseT, null, seen);
  check('the count outlasts the npc down timer (no early lose)',
    f.state.phase === 'playerdown', `phase=${f.state.phase} t=${f._phaseT.toFixed(2)}`);
  const lost = until(f, s => s.phase === 'lose', TUNING.riseT + 1, null, seen);
  check('letting the count run out → lose phase + event',
    lost && f.state.phase === 'lose' && seen.includes('lose') && !f.state.rise.active,
    `phase=${f.state.phase}`);

  // an untagged ring fades on its own timer → the next one pops
  const f2 = new Fight({ seed: 8 });
  toFighting(f2);
  drop(f2);
  const seen2 = [];
  until(f2, s => s.events.includes('rise-fade'), TUNING.riseEachT + .5, null, seen2);
  check('untagged ring fades → next pops (still down)',
    seen2.includes('rise-fade') && f2.state.phase === 'playerdown' && f2.state.rise.got === 0,
    `events=${seen2.filter(e => e.startsWith('rise'))}`);
  f2.reset();
  check('reset() clears the QTE and returns to intro',
    !f2.state.rise.active && f2.state.phase === 'intro', f2.state.phase);

  // a glove TOUCHING the ring counts too — a depth-punch that never emits
  // can't strand you on the canvas while your mitt is on the circle
  const f3 = new Fight({ seed: 9 });
  toFighting(f3);
  drop(f3);
  const touchAt = () => ({ x: f3.state.rise.x, y: f3.state.rise.y });
  f3.step(DT, { ...inp(), riseTouch: [touchAt()] });
  check('palm parked under a fresh pop does NOT auto-tag (must re-touch)',
    f3.state.rise.got === 0 && f3.state.phase === 'playerdown', `got=${f3.state.rise.got}`);
  f3.step(DT, { ...inp(), riseTouch: [] });              // lift off
  f3.step(DT, { ...inp(), riseTouch: [touchAt()] });     // press on
  check('leave + press the glove onto the ring → rise-hit tag',
    f3.state.rise.got === 1 && f3.state.events.includes('rise-hit'),
    `got=${f3.state.rise.got} ev=${f3.state.events}`);
  f3.step(DT, { ...inp(), riseTouch: [touchAt()] });     // new pop, still parked
  check('a parked palm can\'t chain-tag the next pop either',
    f3.state.rise.got === 1 && f3.state.phase === 'playerdown', `got=${f3.state.rise.got}`);
  f3.step(DT, { ...inp(), riseTouch: [{ x: .02, y: .02 }] });
  f3.step(DT, { ...inp(), riseTouch: [{ x: .02, y: .02 }] });
  check('a glove outside the ring touches nothing',
    f3.state.rise.got === 1 && f3.state.phase === 'playerdown', `got=${f3.state.rise.got}`);
  let tRevived = false;
  for (let i = 0; i < 24 && f3.state.phase === 'playerdown'; i++) {
    f3.step(DT, { ...inp(), riseTouch: [] });            // lift
    f3.step(DT, { ...inp(), riseTouch: [touchAt()] });   // press
    if (f3.state.events.includes('revive')) tRevived = true;
  }
  check('touch-tags finish the count → revive at riseHp',
    tRevived && f3.state.phase === 'fighting'
      && f3.state.player.hp === Math.round(f3.state.player.maxHp * TUNING.riseHp),
    `phase=${f3.state.phase} hp=${f3.state.player.hp}`);
  f3.state.phase = 'playerdown'; f3.state.rise.active = true;
  f3.state.rise.got = 0; f3._phaseT = 0; f3._riseNext();
  let hostileOk = true;
  try {   // garbage riseTouch must degrade to no-tag, never throw
    f3.step(DT, { ...inp(), riseTouch: 'x' });
    f3.step(DT, { ...inp(), riseTouch: [null, 5, { x: 'z' },
      new Proxy({}, { get: () => { throw 1; } })] });
  } catch { hostileOk = false; }
  check('malformed riseTouch inputs degrade to no-tag, never throw', hostileOk, '');

  // every knockdown the count climbs: more rings, tighter ring, shorter fuse —
  // and it resets with the bout
  const f4 = new Fight({ seed: 12 });
  toFighting(f4);
  drop(f4);
  check('first knockdown is the base lay — riseTargets rings, depth 1',
    f4.state.rise.need === Math.round(TUNING.riseTargets)
      && f4.state.rise.depth === 1
      && f4._eachFor === Math.max(.8, TUNING.riseEachT)
      && f4.state.rise.r === TUNING.riseR,
    `need=${f4.state.rise.need} depth=${f4.state.rise.depth} each=${f4._eachFor} r=${f4.state.rise.r}`);
  for (let i = 0; i < 24 && f4.state.phase === 'playerdown'; i++) {   // touch out of it
    f4.step(DT, { ...inp(), riseTouch: [] });
    f4.step(DT, { ...inp(), riseTouch: [{ x: f4.state.rise.x, y: f4.state.rise.y }] });
  }
  drop(f4);   // down again
  check('second knockdown needs +riseStepN rings, shorter fuse, smaller ring',
    f4.state.rise.need === Math.round(TUNING.riseTargets + TUNING.riseStepN)
      && f4.state.rise.depth === 2
      && f4._eachFor < TUNING.riseEachT
      && f4.state.rise.r < TUNING.riseR,
    `need=${f4.state.rise.need} depth=${f4.state.rise.depth} each=${f4._eachFor} r=${f4.state.rise.r}`);
  const fadeEach = f4._eachFor, fadeR = f4.state.rise.r;
  until(f4, s => s.events.includes('rise-fade'), fadeEach + .5);
  check('a faded ring keeps THIS count\'s radius and fuse (escalation is per-down)',
    f4.state.rise.r === fadeR, `r=${f4.state.rise.r} want=${fadeR}`);
  for (let i = 0; i < 40 && f4.state.phase === 'playerdown'; i++) {   // climb out again
    f4.step(DT, { ...inp(), riseTouch: [] });
    f4.step(DT, { ...inp(), riseTouch: [{ x: f4.state.rise.x, y: f4.state.rise.y }] });
  }
  drop(f4);   // a third down climbs again
  check('third knockdown climbs again',
    f4.state.rise.need === Math.round(TUNING.riseTargets + 2 * TUNING.riseStepN)
      && f4.state.rise.depth === 3,
    `need=${f4.state.rise.need} depth=${f4.state.rise.depth}`);
  f4.reset(); toFighting(f4); drop(f4);
  check('reset() drops the escalation — back to the base lay',
    f4.state.rise.need === Math.round(TUNING.riseTargets) && f4.state.rise.depth === 1,
    `need=${f4.state.rise.need}`);

  // practice spars never arm it — the mat stays a trampoline
  const pf = new Fight({ seed: 7, ai: false, practice: true });
  toFighting(pf);
  drop(pf);
  check('practice mode: no KO, no QTE',
    pf.state.phase === 'fighting' && !pf.state.rise.active, pf.state.phase);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
