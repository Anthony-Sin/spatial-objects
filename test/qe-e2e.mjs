#!/usr/bin/env node
/* test/qe-e2e.mjs — w7 extended e2e coverage for boxing.html (QE round 2).

   Standalone: node test/qe-e2e.mjs [--url http://host:port]
   Prefers the live server on :8791, then :8890, else self-serves on :8890.

   Resource discipline (master prompt R2): advisory .teamwork/qe/.chromium.lock,
   waitForResources() gate (load1<10, MemAvailable>2500MB), niced chromium,
   ONE browser total for the whole suite.

   Coverage:
     A  countdown → fighting; punches land + damage events; telegraph → sway
        dodge → 'player-dodged'; sustained real fight → KO → npcdown → win +
        endcard; replay-reload restarts clean; in-page game.reset() has no
        stale state; scripted lose → lose endcard.
     B  ?practice=1 — frozen clock, nobody can be KO'd, tutorial coach on.
     C  tutorial drive — steps advance, run ends on 'YOU'RE READY!' card;
        ?tutorial=1 engages the same mode.
     D  lineup → boxing hand-off: localStorage['boxing:npc'] → chosen NPC
        spawns; locked/stale/prop picks can't be smuggled in.
     E  malformed __forceHands edges — no pageerror; gloves never leave the
        screen (A7: drift to neutral guard, dimmed).

   NOTE on event draining: fight.state.events is single-consumer — whoever
   calls game.step gets that frame's events. Manual step bursts are used for
   determinism, but terminal events ('ko'→npcdown→'win'/'lose') are left for
   the page's own rAF loop so the HUD endcard path runs for real.

   Writes .teamwork/qe/w7-e2e.json. Non-zero exit on any failed check.
*/
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { waitForResources } from './qe-resources.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, '..', '.teamwork', 'qe');
const LOCK = join(OUT_DIR, '.chromium.lock');
const CHROMIUM = '/usr/bin/chromium';
const ARG_URL = (() => { const i = process.argv.indexOf('--url'); return i > 0 ? process.argv[i + 1] : null; })();

const results = [];
const check = (name, ok, info = '') => {
  results.push({ name, ok, info });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${info ? '  — ' + info : ''}`);
};
const log = (...a) => console.log('[qe-e2e]', ...a);

/* ---------- serve ---------- */
const probe = async (u) => fetch(u).then(() => u.replace(/\/$/, '')).catch(() => null);
let base = ARG_URL ? ARG_URL.replace(/\/$/, '')
  : await probe('http://127.0.0.1:8791/') || await probe('http://127.0.0.1:8890/');
let srv = null;
if (!base) {
  srv = spawn('node', ['server.mjs'], { cwd: ROOT, env: { ...process.env, PORT: '8890' }, stdio: 'ignore' });
  await delay(1200);
  base = 'http://127.0.0.1:8890';
}
log(`server: ${base}`);

/* ---------- one-chromium advisory lock (same contract as qe-runner) ---------- */
async function acquireLock() {
  mkdirSync(OUT_DIR, { recursive: true });
  for (;;) {
    let stale = true;
    if (existsSync(LOCK)) {
      try {
        const { pid, ts } = JSON.parse(readFileSync(LOCK, 'utf8'));
        const alive = pid && (() => { try { process.kill(pid, 0); return true; } catch { return false; } })();
        if (alive && Date.now() - ts < 15 * 60 * 1000) stale = false;
      } catch { }
      if (stale) { try { unlinkSync(LOCK); } catch { } }
    }
    if (!stale) { log('another chromium run holds the lock — waiting 3s'); await delay(3000); continue; }
    try { writeFileSync(LOCK, JSON.stringify({ pid: process.pid, ts: Date.now() }), { flag: 'wx' }); return; }
    catch { await delay(250); }
  }
}
const releaseLock = () => { try { unlinkSync(LOCK); } catch { } };
const wrapper = join(tmpdir(), `qe-e2e-chromium-${process.pid}.sh`);

/* ---------- in-page driver ---------- */
const DRIVER = `(() => {
  if (window.__qe) return true;
  const SH = [[0,1.15],[.55,.78],[.8,.5],[1,.32],[1.12,.18],[.36,-.12],[.4,-.4],[.42,-.6],[.44,-.74],
    [0,-.2],[0,-.48],[0,-.7],[0,-.86],[-.34,-.12],[-.38,-.36],[-.4,-.55],[-.42,-.68],
    [-.6,-.05],[-.66,-.26],[-.7,-.42],[-.72,-.52]];
  const lmFist = (cx, cy, s) => SH.map(([x, y]) => ({ x: cx + x * s, y: cy + y * s, z: 0 }));
  const hand = (side, cx, cy, s) => ({ side, kind: 'fist', lm: lmFist(cx, cy, s),
    palm: { x: cx, y: cy }, wrist: { x: cx, y: cy + s * 1.15 },
    indexTip: { x: cx + s * .4, y: cy - s * .7 }, pinchAt: { x: cx + s * .6, y: cy - s * .4 },
    pinchD: .2, nExt: 0, nExtAll: 0 });
  const HS = hands => ({ hands, pinch: null, point: null, orbit: null, zoom: null, spread: null });
  const EMPTY = HS([]);
  /* manual:true — like the mouse-sway face, a synthetic face must never
     auto-centre: the first non-manual sighting latches the sway centre to
     the nose, and a "lean" face would read as neutral forever */
  const FACE = (x, y, size = .3) => ({ found: true, manual: true, nose: { x, y }, size });
  const NEUTRAL = FACE(.5, .45);
  const Q = window.__qe = {
    hand, HS, EMPTY, FACE, NEUTRAL, got: [], lastBlow: null,
    step(n = 1, ctrl = {}) {
      const B = window.__boxing; let out = null;
      for (let i = 0; i < n; i++) {
        out = B.game.step(1 / 60, window.__forceHands || EMPTY, window.__forceFace || null,
          { mittOk: true, ...ctrl });
        if (out?.events?.length) this.got.push(...out.events);
        if (out?.state?.lastBlow) this.lastBlow = out.state.lastBlow;
        if (out && B.tutor) try { B.tutor.update(out, performance.now() / 1000); } catch {}
      }
      this.out = out; return out?.state;
    },
    mark() { return this.got.length; },
    /* events land in Q.got when MY steps drain them, or in __boxing.log when
       the page rAF loop drained them — check both */
    saw(ev, since = 0) {
      return this.got.indexOf(ev, since) >= 0
        || (window.__boxing.log || []).slice(-300).includes(ev);
    },
    hands(v) { window.__forceHands = v; },
    face(v) { window.__forceFace = v; },
    /* one scripted punch (~0.7s): fast span ramp → hot reachVel, hold to
       emit, retract to re-arm — same shape boxing-page.mjs uses */
    punch(side = 'left', cy = .55) {
      for (const s of [.04, .055, .07, .09, .11]) { this.hands(HS([hand(side, .38, cy, s)])); this.step(6); }
      this.hands(HS([hand(side, .38, cy, .11)])); this.step(22);
      this.hands(EMPTY); this.step(10);
    },
    dist() { return window.__boxing.sim.distance(); },
  };
  return true;
})()`;

const BENIGN = /^INFO:|XNNPACK|TensorFlow|Created TensorFlow|GroupMarker/i;
/* open a page, collect console+page errors, wait on a JS predicate */
const boot = async (pg, url, { wait = 'window.__boxing && window.__boxing.fight', driver = true, settleMs = 400 } = {}) => {
  const errs = [];
  const onC = m => { if (m.type() === 'error' && !BENIGN.test(m.text())) errs.push('console: ' + m.text()); };
  const onE = e => errs.push('pageerror: ' + e.message);
  pg.on('console', onC); pg.on('pageerror', onE);
  await pg.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await pg.waitForFunction(wait, { timeout: 30000 });
  if (driver) await pg.evaluate(DRIVER);
  await delay(settleMs);
  return { errs, detach: () => { pg.off('console', onC); pg.off('pageerror', onE); } };
};

/* ---------- run ---------- */
const artifact = { tool: 'qe-e2e', startedAt: new Date().toISOString(), base, gate: null, checks: results, fatal: null };
let browser = null;
try {
  await acquireLock();
  log('gating launch on resources…');
  artifact.gate = await waitForResources({ timeoutMs: 120000, pollMs: 2000, log });
  writeFileSync(wrapper, `#!/bin/sh\nexec nice -n 10 ${CHROMIUM} "$@"\n`, { mode: 0o755 });
  browser = await puppeteer.launch({
    executablePath: wrapper, headless: 'new',
    args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
      '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--mute-audio'],
  });
  const pg = await browser.newPage();
  await pg.setViewport({ width: 1280, height: 800 });

  /* ================= A. real fight ======================================== */
  {
    const { errs, detach } = await boot(pg, `${base}/boxing.html?notrack=1`);
    check('A: boots clean in ?notrack=1', errs.length === 0, errs.slice(0, 2).join(' | '));

    /* countdown → fighting */
    const seq = await pg.evaluate(() => {
      const Q = window.__qe, phases = [];
      Q.step(30);
      phases.push(window.__boxing.state.phase);
      for (let i = 0; i < 40 && window.__boxing.state.phase !== 'fighting'; i++) Q.step(10);
      phases.push(window.__boxing.state.phase);
      return { phases, round: window.__boxing.state.round, ev: Q.got.slice() };
    });
    check('A: countdown → fighting transition',
      seq.phases.includes('countdown') && seq.phases.at(-1) === 'fighting',
      JSON.stringify(seq));
    check('A: round-start bell rang at round 1',
      seq.round === 1 && seq.ev.includes('round-start'), `round=${seq.round}`);

    /* punches land → damage events + hp drop (real AI — no _npc stub) */
    const dmg = await pg.evaluate(() => {
      const Q = window.__qe, B = window.__boxing, hp0 = B.state.npc.hp, m = Q.mark();
      let swings = 0;
      while (swings < 8 && B.state.npc.hp >= hp0 && B.state.phase === 'fighting') {
        if (Q.dist() > 1.28) { Q.step(8, { step: 1 }); continue; }
        Q.punch(swings++ % 2 ? 'right' : 'left');
      }
      return { swings, hp0, hp: B.state.npc.hp, lastBlow: Q.lastBlow, ev: Q.got.slice(m) };
    });
    check('A: player punches land — npc.hp drops + damage events',
      dmg.hp < dmg.hp0 && (dmg.ev.includes('player-hit') || dmg.ev.includes('npc-hit')),
      JSON.stringify(dmg));
    check("A: lastBlow.dmg recorded on the landed blow", dmg.lastBlow?.dmg > 0,
      `lastBlow=${JSON.stringify(dmg.lastBlow)}`);

    /* telegraph → head-sway dodge via __forceFace → 'player-dodged'.
       PIP latches its aim at WINDUP start; a lean applied after the telegraph
       shows is a fresh dodge the fight engine must honour — held through
       impact it also satisfies the |sway|>=dodgeT check on its own. */
    const dodge = await pg.evaluate(() => {
      const Q = window.__qe, B = window.__boxing;
      const tries = [];
      const settle = () => {                 // lean must decay before the next
        Q.face(Q.NEUTRAL);                   // windup or PIP reads a HELD pose
        for (let i = 0; i < 90 && Math.abs(B.tracker.sway) > .12; i++) Q.step(1);
      };
      for (let t = 0; t < 5 && B.state.player.hp > 25; t++) {
        settle();
        let tel = null;
        for (let i = 0; i < 2400 && !tel; i++) {
          Q.step(1, { step: Q.dist() > 1.05 ? 1 : 0 });
          if (B.state.phase !== 'fighting') return { res: 'phase-left', tries };
          tel = B.state.npc.telegraph;
        }
        if (!tel) return { res: 'no-telegraph', tries };
        const m = Q.mark();
        Q.face(Q.FACE(.12, .45));                 // hard lean — aim already latched
        let outcome = 'unresolved';
        for (let j = 0; j < 130; j++) {
          Q.step(1);
          if (B.state.phase !== 'fighting') { outcome = 'phase-left'; break; }
          if (Q.saw('player-dodged', m)) { outcome = 'dodged'; break; }
          if (Q.saw('player-hit-taken', m) || Q.saw('player-blocked', m)) { outcome = 'connected'; break; }
          const a = B.state.npc.action;
          if (a !== 'windup' && a !== 'punch') { outcome = 'resolved'; break; }
        }
        tries.push(`${tel.kind}/${tel.side}→${outcome}`);
        if (outcome === 'dodged') return { res: 'dodged', tries };
        Q.step(30);
      }
      return { res: 'never', tries, php: B.state.player.hp };
    });
    check("A: telegraph → sway dodge → 'player-dodged'",
      dodge.res === 'dodged', JSON.stringify(dodge));

    /* sustained real fight → KO → npcdown; verdict+endcard left to rAF */
    const ko = await pg.evaluate(() => {
      const Q = window.__qe, B = window.__boxing;
      let swings = 0, side = 0;
      while (swings < 48 && B.state.phase === 'fighting' && B.state.player.hp > 0) {
        const st = B.state, d = Q.dist();
        if (st.npc.action === 'hurt' || st.npc.action === 'down') { Q.step(18); continue; }
        if (d > 1.28) { Q.step(8, { step: 1 }); continue; }
        if (st.player.hp < 40 && (st.npc.action === 'windup' || st.npc.action === 'punch')) {
          Q.step(14, { guard: true }); continue;
        }
        Q.punch(side++ % 2 ? 'right' : 'left'); swings++;
      }
      return { swings, phase: B.state.phase, playerHp: B.state.player.hp,
        npcHp: B.state.npc.hp, ko: Q.saw('ko'), score: B.state.player.score };
    });
    check("A: sustained punching → KO ('ko' event + 'npcdown')",
      ko.ko && ko.phase === 'npcdown', JSON.stringify(ko));

    /* the page's own loop drives the verdict: npcdown → win + endcard */
    let winRes = { phase: 'timeout' };
    try {
      await pg.waitForFunction(() => window.__boxing.state.phase === 'win', { timeout: 30000 });
      await delay(700);                                     // a few rAF frames for hud/endcard
      winRes = await pg.evaluate(() => ({
        phase: window.__boxing.state.phase,
        win: (window.__boxing.log || []).includes('win'),
        endOn: document.querySelector('[data-end]').classList.contains('on'),
        title: document.querySelector('[data-endtitle]').textContent,
        score: window.__boxing.state.player.score }));
    } catch { }
    check("A: 'npcdown' resolves to 'win' + 'YOU WIN!' endcard",
      winRes.phase === 'win' && winRes.win && winRes.endOn && /YOU WIN/i.test(winRes.title || ''),
      JSON.stringify(winRes));

    /* restart path 1: real replay button → reload → fresh state */
    await Promise.all([
      pg.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }),
      pg.click('[data-replay]'),
    ]);
    await pg.waitForFunction('window.__boxing && window.__boxing.fight', { timeout: 30000 });
    await pg.evaluate(DRIVER);
    const fresh = await pg.evaluate(() => {
      const Q = window.__qe, B = window.__boxing;
      for (let i = 0; i < 40 && B.state.phase !== 'fighting'; i++) Q.step(10);
      const st = B.state;
      /* bruise lives in material colors — hash them pre-hit for the reset probe */
      window.__npcHash = () => {
        let h = 0;
        B.npc.group.traverse(o => {
          if (o.isMesh && o.material && !Array.isArray(o.material) && o.material.color)
            h += o.material.color.r * 1000 + o.material.color.g * 500 + o.material.color.b;
        });
        return Math.round(h);
      };
      /* fresh-state snapshot BEFORE any new punch — the fields below must
         show a clean round-1 bout, not the wreckage of the last one */
      const snap = { phase: st.phase, php: st.player.hp, pmax: st.player.maxHp,
        nhp: st.npc.hp, nmax: st.npc.maxHp, score: st.player.score, round: st.round,
        hash0: window.__npcHash(),
        endOn: document.querySelector('[data-end]').classList.contains('on'),
        ended: document.body.classList.contains('ended') };
      let swings = 0;
      while (swings++ < 10 && st.npc.hp >= st.npc.maxHp && B.state.phase === 'fighting') {
        if (Q.dist() > 1.28) { Q.step(8, { step: 1 }); continue; }
        Q.punch(swings % 2 ? 'right' : 'left');
      }
      return { ...snap, hitAgain: st.npc.hp < st.npc.maxHp, afterHp: st.npc.hp };
    });
    check('A: replay restart — fresh hp/score/round 1, no stale endcard',
      fresh.phase === 'fighting' && fresh.php === fresh.pmax && fresh.nhp === fresh.nmax
        && fresh.score === 0 && fresh.round === 1 && !fresh.endOn && !fresh.ended,
      JSON.stringify(fresh));
    check('A: post-restart fight still lands hits', fresh.hitAgain,
      `npc.hp=${fresh.afterHp}/${fresh.nmax}`);

    /* restart path 2: in-page game.reset() — nothing stale may ride along */
    const reset = await pg.evaluate((hash0) => {
      const Q = window.__qe, B = window.__boxing;
      const npcHash = window.__npcHash;
      let swings = 0;
      while (swings++ < 12 && B.state.npc.hp >= B.state.npc.maxHp * .8 && B.state.phase === 'fighting') {
        if (Q.dist() > 1.28) { Q.step(8, { step: 1 }); continue; }
        Q.punch(swings % 2 ? 'right' : 'left');
      }
      const before = { nhp: B.state.npc.hp, score: B.state.player.score,
        dmg: B.npc?.damageLevel ?? null, hash0, hashHit: npcHash() };
      B.game.reset();
      const st0 = B.state;
      const clean0 = { phase: st0.phase, php: st0.player.hp, nhp: st0.npc.hp,
        score: st0.player.score, combo: st0.player.combo, round: st0.round, events: st0.events.length,
        endOn: document.querySelector('[data-end]').classList.contains('on'),
        ended: document.body.classList.contains('ended'), dmg: B.npc?.damageLevel ?? null,
        hashAfter: npcHash() };
      B.game.skipIntro();
      for (let i = 0; i < 40 && B.state.phase !== 'fighting'; i++) Q.step(10);
      let sw2 = 0;
      while (sw2++ < 10 && B.state.npc.hp >= B.state.npc.maxHp && B.state.phase === 'fighting') {
        if (Q.dist() > 1.28) { Q.step(8, { step: 1 }); continue; }
        Q.punch(sw2 % 2 ? 'right' : 'left');
      }
      return { before, clean0, phase: B.state.phase, hitAgain: B.state.npc.hp < B.state.npc.maxHp,
        round2: B.state.round };
    }, fresh.hash0);
    check('A: in-page reset clears hp/score/combo/events/endcard',
      reset.clean0.php === 100 && reset.clean0.nhp === 100 && reset.clean0.score === 0
        && reset.clean0.combo === 0 && reset.clean0.events === 0
        && !reset.clean0.endOn && !reset.clean0.ended,
      JSON.stringify(reset));
    check('A: in-page reset clears the NPC damage wash',
      (reset.clean0.dmg === 0 && reset.clean0.dmg !== null)
        || Math.abs(reset.clean0.hashAfter - reset.before.hash0) < 2,
      JSON.stringify({ dmg: [reset.before.dmg, reset.clean0.dmg],
        hash: [reset.before.hash0, reset.before.hashHit, reset.clean0.hashAfter] }));
    check('A: post-reset bout is a real round-1 fight again',
      reset.phase === 'fighting' && reset.hitAgain && reset.round2 === 1,
      JSON.stringify({ phase: reset.phase, hit: reset.hitAgain, round: reset.round2 }));

    /* scripted lose: low hp, no defence — NPC must land the KO itself */
    const pd = await pg.evaluate(() => {
      const Q = window.__qe, B = window.__boxing;
      B.state.player.hp = 12;
      const m = Q.mark();
      for (let i = 0; i < 3600 && B.state.phase === 'fighting'; i++)
        Q.step(1, { step: Q.dist() > 1.1 ? 1 : 0 });
      return { phase: B.state.phase, ko: Q.saw('ko', m), php: B.state.player.hp };
    });
    check("A: defenceless player gets KO'd → 'playerdown'",
      pd.ko && pd.phase === 'playerdown', JSON.stringify(pd));
    let loseRes = { phase: 'timeout' };
    try {
      await pg.waitForFunction(() => window.__boxing.state.phase === 'lose', { timeout: 30000 });
      await delay(700);
      loseRes = await pg.evaluate(() => ({
        phase: window.__boxing.state.phase,
        lose: (window.__boxing.log || []).includes('lose'),
        endOn: document.querySelector('[data-end]').classList.contains('on'),
        loseCls: document.querySelector('[data-end]').classList.contains('lose'),
        title: document.querySelector('[data-endtitle]').textContent }));
    } catch { }
    check("A: 'playerdown' resolves to 'lose' + lose endcard",
      loseRes.phase === 'lose' && loseRes.lose && loseRes.endOn && loseRes.loseCls,
      JSON.stringify(loseRes));

    /* in-page reset WHILE an endcard is up must clear the end UI too —
       the hide happens on the next hud() pass, so give the rAF a beat */
    const r0 = await pg.evaluate(() => {
      const B = window.__boxing;
      const endOn0 = document.querySelector('[data-end]').classList.contains('on');
      B.game.reset();
      return { endOn0, phase: B.state.phase };
    });
    await delay(600);
    const resetAtEnd = await pg.evaluate(() => ({
      endOn: document.querySelector('[data-end]').classList.contains('on'),
      ended: document.body.classList.contains('ended'),
      phase: window.__boxing.state.phase }));
    resetAtEnd.endOn0 = r0.endOn0;
    check('A: game.reset() with endcard up clears endcard + ended flag',
      resetAtEnd.endOn0 && !resetAtEnd.endOn && !resetAtEnd.ended, JSON.stringify(resetAtEnd));
    check('A: zero page errors through the whole fight',
      errs.length === 0, errs.slice(0, 3).join(' | '));
    detach();
  }

  /* ================= B/C. practice + tutorial ============================= */
  {
    const { errs, detach } = await boot(pg, `${base}/boxing.html?notrack=1&practice=1`);
    const prac = await pg.evaluate(() => {
      const Q = window.__qe, B = window.__boxing;
      for (let i = 0; i < 40 && B.state.phase !== 'fighting'; i++) Q.step(10);
      const t0 = B.state.timeLeft;
      let swings = 0;
      for (let k = 0; k < 80 && B.state.phase === 'fighting'; k++) {
        if (Q.dist() > 1.1) { Q.step(6, { step: 1 }); continue; }
        Q.punch(swings++ % 2 ? 'right' : 'left');
      }
      return { practice: B.fight.opts.practice, ai: B.fight.ai,
        timeLeft0: t0, timeLeft: B.state.timeLeft, phase: B.state.phase,
        npcHp: B.state.npc.hp, ko: Q.saw('ko'),
        tutorOn: document.querySelector('[data-tutor]').classList.contains('on') };
    });
    check('B: practice flag — ai:false + practice:true on the fight',
      prac.practice === true && prac.ai === false,
      `practice=${prac.practice} ai=${prac.ai}`);
    check('B: practice — clock frozen while fighting',
      prac.timeLeft === prac.timeLeft0 && prac.timeLeft > 0,
      `timeLeft ${prac.timeLeft0} → ${prac.timeLeft}`);
    check('B: practice — NPC hp floors, never KO, stays fighting',
      prac.phase === 'fighting' && !prac.ko && prac.npcHp > 0,
      JSON.stringify({ hp: prac.npcHp, phase: prac.phase }));
    check('B: tutorial coach element is on', prac.tutorOn, `tutorOn=${prac.tutorOn}`);

    /* drive the tutorial honestly through B.tutor.step.id — every lesson is
       answered by the real input path: punches by landmark thrust, block by
       the guard key (moveKeys → controls.guard), slip/perfect by a timed
       head lean. IMPORTANT: the scripted-swing cadence (SWING_GAP, niceUntil
       beats, step time-boxes) is paced by WALL time, so this driver yields —
       a synchronous loop outruns real time and the swings never fire. */
    const tut = await pg.evaluate(async () => {
      const Q = window.__qe, B = window.__boxing, T = B.tutor;
      const sleep = ms => new Promise(r => setTimeout(r, ms));
      const stepsSeen = new Set();
      let side = 0;
      const settle = async () => {
        Q.face(Q.NEUTRAL);
        for (let i = 0; i < 90 && Math.abs(B.tracker.sway) > .12; i++) Q.step(1);
      };
      const t0 = performance.now();
      for (let i = 0; i < 1200 && !(T && T.done); i++) {
        const st = B.state;
        if (st.phase !== 'fighting') { await sleep(120); Q.step(6); continue; }
        const s = T.step;
        if (!s || T.niceUntil) { await sleep(160); Q.step(4); continue; }
        stepsSeen.add(s.id);
        const tg = st.npc.telegraph, a = st.npc.action;
        B.moveKeys.guard = s.id === 'block';          // real F-key path for rAF frames
        if (s.id === 'punch') {
          if (Q.dist() > 1.1) Q.step(6, { step: 1 }); else Q.punch(side++ % 2 ? 'right' : 'left');
        } else if (s.id === 'block') {
          /* scripted jab — gloves up through the whole telegraph + swing */
          if (a === 'windup' || a === 'punch') Q.step(4, { guard: true });
          else { Q.step(4); await sleep(100); }
        } else if (s.id === 'slip') {
          /* scripted jab — lean once the telegraph is underway (aim latched
             at windup start) and hold through impact */
          if (tg && tg.t01 >= .45) Q.face(Q.FACE(.12, .45));
          else if (a !== 'windup' && a !== 'punch') await settle();
          Q.step(2); await sleep(40);
        } else if (s.id === 'perfect') {
          /* scripted hook — dodge must START inside the .24s perfect window:
             lean as the swing launches AND commit the slip via controls.dodge
             (the A/D key path) on the release frame; then punch the reel */
          if (a === 'stunned') { await settle(); if (Q.dist() > 1.1) Q.step(6, { step: 1 }); else Q.punch(side++ % 2 ? 'right' : 'left'); }
          else if (a === 'punch' && st.npc.actionT < .08) { Q.face(Q.FACE(.12, .45)); Q.step(1, { dodge: 1 }); }
          else if (tg && tg.t01 >= .9) Q.face(Q.FACE(.12, .45));
          else if (a === 'whiff' || (a === 'idle' && !tg)) await settle();
          Q.step(2); await sleep(35);
        } else { Q.step(4); await sleep(60); }
        if (performance.now() - t0 > 34000) break;    // past the TOTAL failsafe
      }
      B.moveKeys.guard = false; Q.face(Q.NEUTRAL);
      await sleep(300);
      return { stepsSeen: [...stepsSeen], passed: T ? T.passed.slice() : [], done: T?.done, ti: T?.i,
        phase: B.state.phase,
        endOn: document.querySelector('[data-end]').classList.contains('on'),
        title: document.querySelector('[data-endtitle]').textContent,
        sub: document.querySelector('[data-endsub]').textContent,
        replay: document.querySelector('[data-replay]').textContent };
    });
    check('C: tutorial steps advance (≥2 stages seen)',
      tut.stepsSeen.length >= 2 || (tut.ti ?? 0) >= 2,
      JSON.stringify({ steps: tut.stepsSeen, ti: tut.ti, passed: tut.passed }));
    check("C: tutorial finishes on the 'YOU'RE READY!' card",
      tut.done && tut.endOn && /READY/i.test(tut.title || ''),
      JSON.stringify({ title: tut.title, sub: tut.sub, replay: tut.replay, passed: tut.passed }));
    check('C: practice never let anyone hit the canvas',
      tut.phase === 'fighting', `phase=${tut.phase}`);
    check('B/C: zero page errors in practice/tutorial mode',
      errs.length === 0, errs.slice(0, 3).join(' | '));
    detach();

    const b2 = await boot(pg, `${base}/boxing.html?notrack=1&tutorial=1`);
    const t1 = await pg.evaluate(() => {
      const Q = window.__qe;
      for (let i = 0; i < 30 && window.__boxing.state.phase !== 'fighting'; i++) Q.step(10);
      return { on: document.querySelector('[data-tutor]').classList.contains('on'),
        phase: window.__boxing.state.phase };
    });
    check('C: ?tutorial=1 engages the same coach mode',
      t1.on && t1.phase === 'fighting', JSON.stringify(t1));
    check('C: zero page errors on ?tutorial=1', b2.errs.length === 0, b2.errs.slice(0, 3).join(' | '));
    b2.detach();
  }

  /* ================= D. lineup → boxing hand-off ========================== */
  {
    const { errs, detach } = await boot(pg, `${base}/lineup.html`,
      { wait: 'document.querySelectorAll(".cell").length >= 3', driver: false, settleMs: 2500 });
    const pick0 = await pg.evaluate(() => {
      localStorage.removeItem('boxing:npc'); localStorage.removeItem('boxing:ko');
      document.querySelector('.cell[data-idx="0"]').click();
      return { pick: localStorage.getItem('boxing:npc') };
    });
    check('D: lineup click on unlocked bubble stores proto:bubble',
      pick0.pick === 'proto:bubble', JSON.stringify(pick0));

    const b3 = await boot(pg, `${base}/boxing.html?notrack=1`);
    const sp1 = await pg.evaluate(() => ({ v: window.__boxing.npc?.variant, id: window.__boxing.npc?.id,
      name: window.__boxing.state.npc.name, lbl: document.querySelector('[data-npclbl]').textContent }));
    check('D: pick proto:bubble → bubble spawns + HUD names it',
      sp1.v === 'bubble' && /BUBBLE/.test(sp1.name) && /BUBBLE/.test(sp1.lbl), JSON.stringify(sp1));

    await pg.evaluate(() => {
      localStorage.setItem('boxing:ko', JSON.stringify({ n: 1, sum: 2 }));
      localStorage.setItem('boxing:npc', 'proto:bean');
    });
    const b4 = await boot(pg, `${base}/boxing.html?notrack=1`);
    const sp2 = await pg.evaluate(() => ({ v: window.__boxing.npc?.variant, name: window.__boxing.state.npc.name }));
    check('D: earned proto:bean (ko avg ≤ 2) → bean spawns',
      sp2.v === 'bean' && /BEAN/.test(sp2.name), JSON.stringify(sp2));

    await pg.evaluate(() => {
      localStorage.removeItem('boxing:ko');
      localStorage.setItem('boxing:npc', 'proto:bean');
    });
    const b5 = await boot(pg, `${base}/boxing.html?notrack=1`);
    const sp3 = await pg.evaluate(() => ({ v: window.__boxing.npc?.variant, name: window.__boxing.state.npc.name }));
    check("D: smuggled locked pick can't enter — falls back to an open fighter",
      sp3.v === 'bubble', JSON.stringify(sp3));

    await pg.evaluate(() => localStorage.setItem('boxing:npc', 'boxing-ring'));
    const b6 = await boot(pg, `${base}/boxing.html?notrack=1`);
    const sp4 = await pg.evaluate(() => ({ v: window.__boxing.npc?.variant, kind: window.__boxing.npc?.kind }));
    check('D: stale PROP id falls back — no prop in the ring',
      sp4.v === 'bubble', JSON.stringify(sp4));
    await pg.evaluate(() => localStorage.removeItem('boxing:npc'));
    const allErrs = [...errs, ...b3.errs, ...b4.errs, ...b5.errs, ...b6.errs];
    check('D: zero page errors across the hand-off', allErrs.length === 0, allErrs.slice(0, 3).join(' | '));
    detach(); b3.detach(); b4.detach(); b5.detach(); b6.detach();
  }

  /* ================= E. malformed __forceHands ============================ */
  {
    const { errs, detach } = await boot(pg, `${base}/boxing.html?notrack=1`);
    await pg.evaluate(() => {
      const Q = window.__qe;
      for (let i = 0; i < 40 && window.__boxing.state.phase !== 'fighting'; i++) Q.step(10);
    });
    /* overlay alpha coverage — whole canvas (never disappear) + the guard
       points where lost gloves drift home (A7) */
    const gloveProbe = `(() => {
      const cv = document.querySelector('#hands');
      const x2 = cv.getContext('2d');
      const all = x2.getImageData(0, 0, cv.width, cv.height).data;
      let total = 0;
      for (let i = 3; i < all.length; i += 16) if (all[i] > 30) total++;
      let guard = 0;
      for (const [fx, fy] of [[.30, .76], [.70, .76]]) {
        const cx = Math.round(fx * cv.width), cy = Math.round(fy * cv.height);
        const d = x2.getImageData(Math.max(0, cx - 30), Math.max(0, cy - 30), 60, 60).data;
        for (let i = 3; i < d.length; i += 4) if (d[i] > 30) guard++;
      }
      return { total, guard };
    })()`;
    /* [name, source for the handsState-ish value, still-tracked?] */
    const cases = [
      ['empty object', `{}`, false],
      ['empty hands', `{hands:[]}`, false],
      ['null/garbage entries', `(Q=>Q.HS([null,undefined,7,'x',{}]))(window.__qe)`, false],
      ['NaN landmarks', `(Q=>Q.HS([{side:'left',kind:'fist',lm:Array.from({length:21},()=>({x:NaN,y:NaN,z:0})),palm:{x:NaN,y:NaN}}]))(window.__qe)`, false],
      ['partial NaN lm', `(Q=>{const h=Q.hand('left',.3,.6,.05);h.lm[9].x=NaN;return Q.HS([h])})(window.__qe)`, false],
      ['short lm', `(Q=>Q.HS([{side:'left',kind:'fist',lm:[{x:.3,y:.4}],palm:{x:.3,y:.4}}]))(window.__qe)`, false],
      ['string lm', `(Q=>Q.HS([{side:'left',kind:'fist',lm:'xxxxxxxxxxxxxxxxxxxxxxxxx',palm:{x:.3,y:.4}}]))(window.__qe)`, false],
      ['hands = number', `{hands:5}`, false],
      ['hands = object', `{hands:{a:1}}`, false],
      ['hands = string', `{hands:'abc'}`, false],
      ['forceHands = number', `42`, false],
      ['forceHands = string', `'just text'`, false],
      ['forceHands = bare array', `(Q=>[Q.hand('left',.3,.6,.05)])(window.__qe)`, true],
      ['one hand', `(Q=>Q.HS([Q.hand('left',.3,.6,.05)]))(window.__qe)`, true],
      ['five hands', `(Q=>Q.HS(['left','right','left','right','left'].map((s,i)=>Q.hand(s,.2+i*.15,.6,.05))))(window.__qe)`, true],
      ['bogus side', `(Q=>Q.HS([{...Q.hand('middle',.3,.6,.05)}]))(window.__qe)`, true],
    ];
    const edgeRes = [];
    for (const [nm, src, tracked] of cases) {
      await pg.evaluate(`window.__forceHands = (${src})`);
      await pg.evaluate(() => window.__qe.step(12));
      await delay(320);                       // a few rAF frames draw the overlay
      const px = await pg.evaluate(gloveProbe);
      edgeRes.push({ nm, tracked, px });
      if (errs.length) break;
    }
    /* tracking drops for good → gloves drift home dimmed, still drawn */
    await pg.evaluate(() => { window.__forceHands = { hands: [] }; window.__qe.step(90); });
    await delay(900);                         // past the .45s holdover
    const pxLost = await pg.evaluate(gloveProbe);
    const bad = edgeRes.filter(r => r.px.total < 150);
    const badGuard = edgeRes.filter(r => !r.tracked && r.px.guard < 60);
    check('E: malformed __forceHands — zero pageerrors', errs.length === 0,
      errs.slice(0, 3).join(' | ') || `${edgeRes.length}/${cases.length} inputs ran clean`);
    check('E: gloves never disappear — overlay has pixels for every input',
      bad.length === 0,
      bad.length ? JSON.stringify(bad.map(b => [b.nm, b.px.total])) : `min total=${Math.min(...edgeRes.map(r => r.px.total))}`);
    check('E: lost tracking drifts gloves to the neutral guard pose (A7)',
      badGuard.length === 0 && pxLost.guard > 100,
      JSON.stringify({ pxLost, weak: badGuard.map(b => [b.nm, b.px.guard]) }));
    detach();
  }
} catch (e) {
  artifact.fatal = String(e && e.stack || e);
  console.error('[qe-e2e] fatal:', artifact.fatal);
} finally {
  if (browser) { try { await Promise.race([browser.close(), delay(8000)]); } catch { try { browser.process()?.kill('SIGKILL'); } catch { } } }
  try { unlinkSync(wrapper); } catch { }
  releaseLock();
  srv?.kill();
}

const failed = results.filter(r => !r.ok);
artifact.durationMs = Date.now() - new Date(artifact.startedAt).getTime();
mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(join(OUT_DIR, 'w7-e2e.json'), JSON.stringify(artifact, null, 1));
console.log('---- qe-e2e summary ----');
console.log(`${results.length - failed.length}/${results.length} checks passed · json → ${join(OUT_DIR, 'w7-e2e.json')}`);
console.log(failed.length ? `${failed.length} check(s) FAILED` : 'ALL CHECKS PASSED');
process.exit(failed.length ? 1 : 0);
