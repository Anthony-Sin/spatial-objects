/* test/boxing-tutorial.mjs — the ~40s tutorial, driven headless against the
   real Fight + RingSim. `node test/boxing-tutorial.mjs` */
import { Fight, TUNING } from '../shared/boxing/fight.js';
import { RingSim } from '../shared/boxing/ring.js';
import { Tutorial, STEPS, TOTAL } from '../shared/boxing/tutorial.js';

const DT = 1 / 60;
let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '   <-- ' + extra}`);
  cond ? pass++ : fail++;
};

// one tutorial run; brain(state, tutor) → fight inputs for this frame
function run(brain) {
  const fight = new Fight({ seed: 3, ai: false, practice: true });
  const sim = new RingSim({ seed: 3 });
  let finished = null;
  const tutor = new Tutorial({ fight, sim, onDone: p => { finished = p; } });
  fight.startNow();                                  // tutorial skips the walk-on
  let t = 0, fightStart = null, punchCd = 0;
  const out = { events: [], state: fight.state };
  while (!tutor.done && t < 60) {
    const st = fight.state;
    if (st.phase === 'fighting' && fightStart === null) fightStart = t;
    const inp = brain(st, tutor, () => (punchCd <= 0 ? (punchCd = .25, true) : false));
    punchCd -= DT;
    sim.step(DT, { npcDir: fight.npcDir(), npcStunned: st.npc.action === 'stunned',
      playerStep: inp.step || 0 });
    fight.step(DT, { ...inp, distance: sim.distance() });
    out.events = st.events.slice();
    tutor.update(out, t);
    t += DT;
  }
  return { finished, secs: fightStart === null ? Infinity : t - fightStart, tutor };
}

/* a player who does what it's told — holds the guard / lean through impact */
let seen = null;
const good = run((st, tutor, canPunch) => {
  const id = tutor.step?.id, tg = st.npc.telegraph;
  if (tg) seen = tg; else if (st.npc.action !== 'punch') seen = null;
  const inp = { punches: [], guard: { left: 0, right: 0 }, sway: 0, dodge: 0 };
  if (id === 'punch' && canPunch()) inp.punches = [{ kind: 'jab', side: 'left', power: 1 }];
  if (id === 'block' && seen) inp.guard[seen.side === 'left' ? 'right' : 'left'] = 1;
  if (id === 'slip' && seen && (!tg || tg.t01 > .7)) inp.sway = 1;
  // scripted hook — duck the head under it once the telegraph is underway
  if (id === 'duck' && seen && (!tg || tg.t01 > .5)) inp.duck = 1;
  // head-driven footwork — press in until the lesson credits it
  if (id === 'move') inp.step = 1;
  if (id === 'perfect') {
    if (tg && tg.t01 > .93) inp.dodge = 1;
    if (st.npc.action === 'stunned' && canPunch()) inp.punches = [{ kind: 'cross', side: 'right', power: 1 }];
  }
  return inp;
});
check('good player passes every step', good.finished?.join() === STEPS.map(s => s.id).join(),
  JSON.stringify(good.finished));
check(`good run finishes well under ${TOTAL}s`, good.secs < TOTAL - 5, `${good.secs.toFixed(1)}s`);

/* a player who does nothing — the time boxes still carry it to the end */
const idle = run(() => ({ punches: [], guard: { left: 0, right: 0 }, sway: 0 }));
check('idle player: tutorial still ends', idle.tutor.done && Array.isArray(idle.finished));
check(`idle player: never longer than ${TOTAL}s`, idle.secs <= TOTAL + .1, `${idle.secs.toFixed(1)}s`);
check('step time boxes fit the cap', STEPS.reduce((a, s) => a + s.max, 0) <= TOTAL);
check('practice: idle player was never KO\'d', idle.tutor.fight.state.phase === 'fighting');
check('tutorial PIP actually swings (scripted)', idle.tutor.fight.state.player.hp < 100);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
