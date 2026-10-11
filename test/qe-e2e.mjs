#!/usr/bin/env node
/* test/qe-e2e.mjs — w7 extended e2e coverage for boxing.html (QE round 2+5).

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
     E  tracking-loss overlay: gloves clear on dropout, return on recovery
        (post-A7 contract — dropped hands leave the canvas, no dimmed ghost).
     F  dropout edges — partial drop clears only the missing glove; a drop
        mid-swing cancels past MISS_GRACE, emits ≤1 inside grace; re-entry
        snaps to the hand (no cross-screen glide).
     G  rapid reset spam ×20 + resets mid-telegraph / mid-down-count /
        between countdown ticks — clean phases, no leaked scene children.
     H  corrupt localStorage ('boxing:npc' junk/huge/bogus + bad stats keys)
        — boxing + lineup boot clean with fallback fighter.
     I  hidden-tab mid-fight — Debugger.pause rAF stall can't poison dt,
        fight clock doesn't jump, visibilitychange listener survives flips.
     J  npc.js torture live — makeRig dt extremes + unknown-pose fallback,
        telegraph sprite sans glove parts, idempotent dispose, NaN damage,
        css gloveColor, null update ctx.
     K  multi-round — round-start each round, clock resets, late KO → win.
     L  corrupt 'boxing:ko' primitives (5 / "x" / {n:"a"} / {n:1e308}) +
        a valid control — REAL KOs via real-time rAF-driven punches so the
        hud() drain runs recordKo → stat increments sanely, no rAF crash,
        endcard shows. (wave-3 fix regression-verify)
     M  waitForHands hold — controls.waitForHands injected for EVERY caller
        (rAF loop included) via a game.step wrap: intro + countdown freeze,
        'FINDING YOUR HANDS' hint on the countdown slot, release resumes.
     N  endcard same-tick re-arm — reset()+skipIntro() in ONE evaluate while
        the card is up → card clears + 'ended' unlatches on the fresh-bout
        countdown frame, and the new bout re-latches its OWN verdict.
     O  corrupt 'boxing:volume'/'sound'/'best'/'wins' — clean boot, master
        gain finite at default after unlock, endcard BEST + stored stats sane.
     P  npc.js manifest normalization + residual torture — injected-manifest
        candidates ('oops'/null/primitive entries), frozen ctx.npc, kick
        replacement, dispose mid-telegraph, dt extremes at action boundaries.
     Q  cornerHold halftime — real-damage trip (forced hook eats hp to ≤1/3),
        card on + round-2 countdown + 55% patch, FULL freeze digest across
        ~1.6s (hp/positions/events/phase all static while the timer bar
        drains), Enter skip resumes the same bout, used-latch blocks refire,
        boundary cases (hp 34 never fires, hp 33.4 fires, hp→0 KO never
        corners), reset mid-card clears the card with no stuck hold,
        fresh-bout re-arm refires, coachgo button + 8s auto-expire both
        release into a live round, win path never corners.
     R  coachAdvice abort/fallback — fetch stub hangs /api/coach; the
        AbortController timeout must fire ≈COACH.apiMs, the canned tip must
        still land inside the 8s hold, the card must still close on time,
        the stale-tip guard must discard advice that resolves after a
        reset, and the second bout's corner must still fetch (no wedged
        controller state).
     S  roster sweep — every localStorage['boxing:npc'] pick shape through a
        REAL bout boot: proto aliases, koAvg-gated bean/sumo (open + locked
        boundaries), PROP smuggles, unknown ids — each must spawn finite,
        telegraph a real swing, eat real glove damage, and fall back to
        bubble when locked/prop/bogus. KO legs on bean+sumo.
     T  score/combo math — ai-parked lab: exact per-hit score =
        round(dmg*5*(1+min(5,combo-1)*.15)), combo chains 1→4 then expires
        past comboWindow, counterT from a perfect dodge multiplies the next
        hit (counter flag + 'counter' event) then expires, a whiff and an
        npc-block score nothing and leave the chain alone, a taken hit
        zeroes combo+counterT, KO lands +500 — then 3 RT swings prove the
        rAF drain never double-counts score or combo.
     U  GLB failure cascade — 404 / non-GLB bytes / video bytes / directory /
        null / number / object / empty / traversal paths all resolve to a
        proto fighter (finite transforms, dies on command, dispose ×2
        idempotent); a REAL bag glb stays 'glb'; and a monkeypatched
        empty-Box3 husk (the wave-5 scale=-0/pos=+Infinity bug) must refuse
        into proto instead of teleporting an invisible fighter.

   NOTE on event draining: fight.state.events is single-consumer — whoever
   calls game.step gets that frame's events. Manual step bursts are used for
   determinism, but terminal events ('ko'→npcdown→'win'/'lose') are left for
   the page's own rAF loop so the HUD endcard path runs for real.

   Writes .teamwork/qe/b5-e2e.json. Non-zero exit on any failed check.
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
    /* normalized-region alpha probe — lit pixels in a box of the #hands
       overlay (fractions of canvas W/H). Lets tests ask "is the LEFT glove
       drawn but the RIGHT one gone" instead of only whole-canvas counts. */
    box(fx, fy, w = .1, h = .12) {
      const cv = document.querySelector('#hands');
      const x2 = cv.getContext('2d');
      const W = Math.max(1, Math.round(w * cv.width)), H = Math.max(1, Math.round(h * cv.height));
      const X = Math.max(0, Math.min(cv.width - 1, Math.round((fx - w / 2) * cv.width)));
      const Y = Math.max(0, Math.min(cv.height - 1, Math.round((fy - h / 2) * cv.height)));
      const d = x2.getImageData(X, Y, Math.min(W, cv.width - X), Math.min(H, cv.height - Y)).data;
      let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 30) n++;
      return n;
    },
    /* count an event since a mark across BOTH drains — my steps collect into
       got, the page rAF collects into __boxing.log */
    count(ev, m = 0, ml = 0) {
      return this.got.slice(m).filter(e => e === ev).length
        + (window.__boxing.log || []).slice(ml).filter(e => e === ev).length;
    },
    /* one scripted punch (~0.7s): fast span ramp → hot reachVel, hold to
       emit, retract to re-arm — same shape boxing-page.mjs uses */
    punch(side = 'left', cy = .55) {
      for (const s of [.04, .055, .07, .09, .11]) { this.hands(HS([hand(side, .38, cy, s)])); this.step(6); }
      this.hands(HS([hand(side, .38, cy, .11)])); this.step(22);
      this.hands(EMPTY); this.step(10);
    },
    /* same punch but paced by REAL time, no manual steps — the page's own
       rAF loop resolves the swing. Needed when the test cares about what
       rAF drains: 'ko'/'win'/'lose' events only reach hud() (→ recordKo /
       showEnd / localStorage writes) when the rAF step emptied them.
       Stage dwell is generous (120ms) — on a loaded box rAF can run at
       ~15fps and a fast ramp would give the tracker <2 samples/stage. */
    async punchRT(side = 'left', cy = .55) {
      const sleep = ms => new Promise(r => setTimeout(r, ms));
      for (const s of [.04, .055, .07, .09, .11]) { this.hands(HS([hand(side, .38, cy, s)])); await sleep(120); }
      this.hands(HS([hand(side, .38, cy, .11)])); await sleep(340);
      this.hands(EMPTY); await sleep(160);
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
const artifact = { tool: 'qe-e2e', startedAt: new Date().toISOString(), base, gate: null, checks: results, probes: [], fatal: null };
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

  /* coach-fault instrumentation (section R) — installed before ANY page
     script so every navigation gets the hooks fresh. The /api/coach fetch
     can be flipped into a never-resolving hang that honours AbortSignal;
     every AbortController is journaled so abort/leak state is inspectable.
     Inert while __qeCoach.hang is false (the default on each fresh doc). */
  await pg.evaluateOnNewDocument(() => {
    const qc = window.__qeCoach = { hang: false, calls: [], acs: [] };
    const AC = window.AbortController;
    window.AbortController = class extends AC {
      constructor() { super(); qc.acs.push(this); }
    };
    const of = window.fetch.bind(window);
    window.fetch = (u, o = {}) => {
      const url = String(u && u.url || u);
      if (qc.hang && /(^|\/)api\/coach(\?|$)/.test(url)) {
        const rec = { url, t0: performance.now(), aborted: false, settled: false, ms: null };
        qc.calls.push(rec);
        return new Promise((res, rej) => {
          const sig = o.signal;
          const fail = () => {
            if (rec.settled) return;
            rec.settled = true; rec.aborted = true;
            rec.ms = performance.now() - rec.t0;
            rej(new DOMException('The operation was aborted.', 'AbortError'));
          };
          if (!sig) return;                      // un-abortable hang — wedged
          if (sig.aborted) return fail();
          sig.addEventListener('abort', fail);
        });
      }
      return of(u, o);
    };
  });

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
        if (Q.dist() > 1.5) { Q.step(8, { step: 1 }); continue; }
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
          Q.step(1, { step: Q.dist() > 1.4 ? 1 : 0 });
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
        if (d > 1.5) { Q.step(8, { step: 1 }); continue; }
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
        if (Q.dist() > 1.5) { Q.step(8, { step: 1 }); continue; }
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
        if (Q.dist() > 1.5) { Q.step(8, { step: 1 }); continue; }
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
        if (Q.dist() > 1.5) { Q.step(8, { step: 1 }); continue; }
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
        Q.step(1, { step: Q.dist() > 1.4 ? 1 : 0 });
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
        if (Q.dist() > 1.4) { Q.step(6, { step: 1 }); continue; }
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
          if (Q.dist() > 1.4) Q.step(6, { step: 1 }); else Q.punch(side++ % 2 ? 'right' : 'left');
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
        } else if (s.id === 'duck') {
          /* scripted hook — head drop under it once the telegraph is underway.
             controls.duck rides the SPACE-key path (fightIn.duck); the edge
             commits a 'duck' dodge and a held duck still dodges since the
             aim latched before the drop */
          if (tg && tg.t01 >= .5) Q.step(2, { duck: 1 });
          else { Q.step(4); await sleep(50); }
        } else if (s.id === 'move') {
          /* head-driven footwork — one synchronous push so the page's own
             rAF frames (controls.step=0) can't drift the anchor home mid-step */
          Q.step(40, { step: 1 }); await sleep(30);
        } else if (s.id === 'perfect') {
          /* scripted hook — dodge must START inside the .24s perfect window:
             lean as the swing launches AND commit the slip via controls.dodge
             (the A/D key path) on the release frame; then punch the reel */
          if (a === 'stunned') { await settle(); if (Q.dist() > 1.4) Q.step(6, { step: 1 }); else Q.punch(side++ % 2 ? 'right' : 'left'); }
          else if (a === 'punch' && st.npc.actionT < .08) { Q.face(Q.FACE(.12, .45)); Q.step(1, { dodge: 1 }); }
          else if (tg && tg.t01 >= .9) Q.face(Q.FACE(.12, .45));
          else if (a === 'whiff' || (a === 'idle' && !tg)) await settle();
          Q.step(2); await sleep(35);
        } else { Q.step(4); await sleep(60); }
        if (performance.now() - t0 > 50000) break;    // past the TOTAL failsafe (40s + slack)
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

    /* a PARTIAL run must not hear 'YOU'RE READY!' — pass one lesson, then
       age the run out through the TOTAL failsafe (same _finish → onDone →
       endcard path the real timeouts take) and read what the card says */
    const b3p = await boot(pg, `${base}/boxing.html?notrack=1&practice=1`);
    const part = await pg.evaluate(async () => {
      const Q = window.__qe, B = window.__boxing, T = B.tutor;
      const sleep = ms => new Promise(r => setTimeout(r, ms));
      const t0 = performance.now();
      let side = 0;
      while (T.step?.id === 'punch' && !T.done && performance.now() - t0 < 20000) {
        if (B.state.phase === 'fighting' && !T.niceUntil)
          if (Q.dist() > 1.4) Q.step(6, { step: 1 }); else Q.punch(side++ % 2 ? 'right' : 'left');
        await sleep(150);
      }
      T.t0 -= 99;                                     // run the clock out
      await sleep(400);
      return { done: T.done, passed: T.passed.slice(),
        endOn: document.querySelector('[data-end]').classList.contains('on'),
        title: document.querySelector('[data-endtitle]').textContent,
        sub: document.querySelector('[data-endsub]').textContent,
        replay: document.querySelector('[data-replay]').textContent };
    });
    check("C: partial run gets a corner quip — never 'YOU'RE READY!'",
      part.done && part.endOn && part.passed.length === 1 && part.passed[0] === 'punch'
        && !/READY/i.test(part.title || '') && /1 \/ \d+/.test(part.sub || '')
        && /Fight anyway/.test(part.replay || ''),
      JSON.stringify(part));
    check('C: zero page errors on the partial run', b3p.errs.length === 0,
      b3p.errs.slice(0, 3).join(' | '));
    b3p.detach();
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
      ['forceHands = bare array', `(Q=>[Q.hand('left',.3,.6,.05)])(window.__qe)`, false],   // no {hands:[…]} wrapper → malformed, not drawable
      ['one hand', `(Q=>Q.HS([Q.hand('left',.3,.6,.05)]))(window.__qe)`, true],
      ['five hands', `(Q=>Q.HS(['left','right','left','right','left'].map((s,i)=>Q.hand(s,.2+i*.15,.6,.05))))(window.__qe)`, true],
      ['bogus side', `(Q=>Q.HS([{...Q.hand('middle',.3,.6,.05)}]))(window.__qe)`, false],
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
    /* tracking drops for good → the GLOVE pixels leave with the hands
       (post-A7 contract: no guard-pose holdover, no ghost gloves frozen
       mid-drop). Whole-canvas alpha is the wrong ruler — telegraph chevrons
       and impact FX legitimately paint with zero tracked hands (fight-cue
       timing is NPC luck), so measure inside ±24px boxes at the two glove
       spots and first drain any active telegraph. */
    const spotProbe = `(() => {
      const cv = document.querySelector('#hands');
      const x2 = cv.getContext('2d');
      const box = (fx, fy) => {
        const cx = Math.round(fx * cv.width), cy = Math.round(fy * cv.height);
        const d = x2.getImageData(Math.max(0, cx - 24), Math.max(0, cy - 24), 48, 48).data;
        let n = 0;
        for (let i = 3; i < d.length; i += 4) if (d[i] > 30) n++;
        return n;
      };
      return { l: box(.3, .6), r: box(.7, .6) };
    })()`;
    /* real gloves at known spots first — pxOn proves the boxes had mitts.
       Bounded retry: on a saturated box the fist-EMA needs a few extra
       frames to settle into the probe boxes — retrying the READ keeps the
       assertion identical (gloves must still appear), just paint-tolerant.
       And park the NPC brain first (same _npc park F uses): a live PIP can
       land a hit mid-probe → the wave-4 hitFx ink-burst fills BOTH boxes →
       a false "ghost gloves" fail. Pixel probes need a quiet canvas. */
    await pg.evaluate(() => { window.__boxing.fight._npc = () => {}; });
    await pg.evaluate(`window.__forceHands = ((Q)=>Q.HS([Q.hand('left',.3,.6,.05),Q.hand('right',.7,.6,.05)]))(window.__qe)`);
    let pxOn = { l: 0, r: 0 };
    for (let i = 0; i < 10 && (pxOn.l < 60 || pxOn.r < 60); i++) {
      await pg.evaluate(() => window.__qe.step(10));
      await delay(220);
      pxOn = await pg.evaluate(spotProbe);
    }
    await pg.evaluate(() => { window.__forceHands = { hands: [] }; });
    await pg.evaluate(() => {
      const Q = window.__qe, B = window.__boxing;
      for (let i = 0; i < 300 && B.state.npc?.telegraph; i++) Q.step(10);
      Q.step(90);
    });
    await delay(900);
    const pxLost = await pg.evaluate(spotProbe);
    /* and recovery: a tracked hand after the dropout must draw again */
    await pg.evaluate(`window.__forceHands = ((Q)=>Q.HS([Q.hand('left',.3,.6,.05),Q.hand('right',.7,.6,.05)]))(window.__qe)`);
    await pg.evaluate(() => window.__qe.step(12));
    await delay(320);
    const pxBack = await pg.evaluate(gloveProbe);
    const bad = edgeRes.filter(r => r.tracked && r.px.total < 150);
    check('E: malformed __forceHands — zero pageerrors', errs.length === 0,
      errs.slice(0, 3).join(' | ') || `${edgeRes.length}/${cases.length} inputs ran clean`);
    check('E: tracked hands always draw gloves',
      bad.length === 0,
      bad.length ? JSON.stringify(bad.map(b => [b.nm, b.px.total])) : `tracked min total=${Math.min(...edgeRes.filter(r => r.tracked).map(r => r.px.total))}`);
    check('E: tracking loss leaves no ghost gloves (glove spots clear)',
      pxOn.l >= 60 && pxOn.r >= 60 && pxLost.l < 60 && pxLost.r < 60,
      JSON.stringify({ pxOn, pxLost }));
    check('E: gloves return when tracking recovers',
      pxBack.total >= 150, JSON.stringify({ pxBack }));
    detach();
  }

  /* ================= F. dropout edges (post-A7 contract) =================
     the canvas clears for missing hands — but what about PARTIAL drops,
     drops mid-swing, and where the glove re-appears? */
  {
    const { errs, detach } = await boot(pg, `${base}/boxing.html?notrack=1`);
    await pg.evaluate(() => {
      const Q = window.__qe, B = window.__boxing;
      for (let i = 0; i < 40 && B.state.phase !== 'fighting'; i++) Q.step(10);
      /* park the NPC brain for the overlay-pixel probes: no telegraphs, no
         incoming punches — nothing else on the canvas but the mitts. Same
         _npc park boxing-page.mjs uses. */
      B.fight._npc = () => {};
    });

    /* F1 — partial dropout: right hand vanishes, left stays. The dropped
       glove must leave the canvas while the tracked one stays drawn. */
    const p1 = await pg.evaluate(() => new Promise(res => {
      const Q = window.__qe;
      Q.hands(Q.HS([Q.hand('left', .3, .55, .05), Q.hand('right', .7, .55, .05)]));
      Q.step(12);
      setTimeout(() => {
        const both = { l: Q.box(.3, .55), r: Q.box(.7, .55) };
        Q.hands(Q.HS([Q.hand('left', .3, .55, .05)]));
        Q.step(30);
        setTimeout(() => res({ both, l: Q.box(.3, .55), r: Q.box(.7, .55) }), 450);
      }, 450);
    }));
    check('F1: partial dropout — dropped glove clears, tracked glove stays',
      p1.both.l > 60 && p1.both.r > 60 && p1.l > 60 && p1.r < 30,
      JSON.stringify(p1));
    const p1b = await pg.evaluate(() => new Promise(res => {
      const Q = window.__qe;
      Q.hands(Q.HS([Q.hand('left', .3, .55, .05), Q.hand('right', .7, .55, .05)]));
      Q.step(12);
      setTimeout(() => res({ l: Q.box(.3, .55), r: Q.box(.7, .55) }), 450);
    }));
    check('F1: returning glove redraws beside the surviving one',
      p1b.l > 60 && p1b.r > 60, JSON.stringify(p1b));

    /* F2 — dropout MID-SWING: a throw in flight whose hand vanishes must
       cancel (MISS_GRACE), never emit on stale data past the grace window. */
    const p2 = await pg.evaluate(() => {
      const Q = window.__qe, B = window.__boxing;
      for (const s of [.04, .055, .07]) { Q.hands(Q.HS([Q.hand('left', .38, .55, s)])); Q.step(6); }
      const mid = B.tracker.debug().state.left;      // should be mid-'throw'
      const m = Q.got.length, ml = B.log.length;
      Q.hands(Q.EMPTY); Q.step(60);                   // > MISS_GRACE (5)
      return { mid, stateAfter: B.tracker.debug().state.left,
        newPunches: Q.count('player-punch', m, ml) + Q.count('player-hit', m, ml) };
    });
    check('F2: dropout mid-swing cancels the throw (no stale emit)',
      p2.newPunches === 0 && p2.stateAfter === 'idle',
      JSON.stringify(p2));
    /* …but a drop INSIDE the grace window resolves the throw once on return —
       the measured peak is real data, the stall emits it, then it re-arms. */
    const p2b = await pg.evaluate(() => {
      const Q = window.__qe, B = window.__boxing;
      for (const s of [.04, .055, .07]) { Q.hands(Q.HS([Q.hand('left', .38, .55, s)])); Q.step(6); }
      const mid = B.tracker.debug().state.left;
      const m = Q.got.length, ml = B.log.length;
      Q.hands(Q.EMPTY); Q.step(3);                     // inside grace
      Q.hands(Q.HS([Q.hand('left', .38, .55, .075)])); Q.step(30);
      return { mid, emitted: Q.count('player-punch', m, ml),
        state: B.tracker.debug().state.left };
    });
    check('F2: in-grace re-entry emits the swing at most once, then re-arms',
      p2b.emitted <= 1 && p2b.state !== 'throw',
      JSON.stringify(p2b));

    /* F3 — re-entry position: drop for a while, come back on the far side of
       the screen. The glove must SNAP to the hand — never glide a mitt across
       mid-canvas on the way over. */
    const p3 = await pg.evaluate(() => new Promise(res => {
      const Q = window.__qe;
      Q.hands(Q.HS([Q.hand('left', .15, .5, .05)]));
      Q.step(12);
      setTimeout(() => {
        const before = Q.box(.15, .5);
        Q.hands(Q.EMPTY); Q.step(60);
        setTimeout(() => {
          const cleared = Q.box(.15, .5);
          Q.hands(Q.HS([Q.hand('left', .85, .5, .05)]));
          Q.step(8);
          setTimeout(() => res({ before, cleared,
            mid: Q.box(.5, .52, .14, .16), spot: Q.box(.85, .5, .12, .14) }), 350);
        }, 500);
      }, 400);
    }));
    check('F3: glove re-entry snaps to the hand — no cross-screen glide',
      p3.before > 60 && p3.cleared < 30 && p3.spot > 40 && p3.mid < 25,
      JSON.stringify(p3));
    check('F: zero page errors through dropout edges',
      errs.length === 0, errs.slice(0, 3).join(' | '));
    detach();
  }

  /* ================= G. rapid reset spam ============================== */
  {
    const { errs, detach } = await boot(pg, `${base}/boxing.html?notrack=1`);
    const g = await pg.evaluate(() => {
      const Q = window.__qe, B = window.__boxing, out = {};
      for (let i = 0; i < 40 && B.state.phase !== 'fighting'; i++) Q.step(10);
      delete B.fight._npc;                                 // real AI for windup/KO probes

      /* 20 back-to-back resets — rebuild spam (proto rematch rebuilds the
         boxer) must not leak scene children or corrupt the next bout */
      for (let i = 0; i < 20; i++) B.game.reset();
      out.children = B.npc.group.children.length;          // impl.group + tel sprite
      const m = Q.got.length, ml = B.log.length;
      B.game.skipIntro();
      for (let i = 0; i < 60 && B.state.phase !== 'fighting'; i++) Q.step(10);
      out.afterSpam = { phase: B.state.phase, round: B.state.round,
        events: B.state.events.length, punches: B.tracker.punches.length,
        roundStarts: Q.count('round-start', m, ml),
        endOn: document.querySelector('[data-end]').classList.contains('on') };

      /* reset mid-telegraph: a windup must die with the bout, not release a
         phantom swing into the fresh one */
      let tel = null;
      for (let i = 0; i < 2400 && !tel; i++) {
        Q.step(1, { step: Q.dist() > 1.4 ? 1 : 0 });
        if (B.state.phase !== 'fighting') break;
        tel = B.state.npc.telegraph;
      }
      out.sawWindup = !!tel;
      if (tel) {
        B.game.reset();
        out.afterTelReset = { phase: B.state.phase, tel: B.state.npc.telegraph,
          act: B.state.npc.action };
        B.game.skipIntro();
        for (let i = 0; i < 60 && B.state.phase !== 'fighting'; i++) Q.step(10);
        out.telPhase2 = B.state.phase;
      }
      return out;
    });
    check('G: reset spam ×20 — no leaked scene children, clean fresh bout',
      g.children <= 3 && g.afterSpam.phase === 'fighting' && g.afterSpam.round === 1
        && g.afterSpam.events === 0 && g.afterSpam.punches === 0
        && g.afterSpam.roundStarts === 1 && !g.afterSpam.endOn,
      JSON.stringify(g));
    check('G: reset mid-telegraph kills the windup cleanly',
      !g.sawWindup || (g.afterTelReset.phase === 'intro'
        && g.afterTelReset.tel === null && g.afterTelReset.act === 'idle'
        && g.telPhase2 === 'fighting'),
      JSON.stringify({ saw: g.sawWindup, after: g.afterTelReset, p2: g.telPhase2 }));

    /* reset during the down/KO count and between countdown ticks */
    const g2 = await pg.evaluate(() => {
      const Q = window.__qe, B = window.__boxing, out = {};
      B.state.player.hp = 12;
      for (let i = 0; i < 3600 && B.state.phase === 'fighting'; i++)
        Q.step(1, { step: Q.dist() > 1.4 ? 1 : 0 });
      out.downPhase = B.state.phase;                       // playerdown expected
      B.game.reset();                                      // reset mid-count
      out.afterDownReset = { phase: B.state.phase, php: B.state.player.hp };
      B.game.skipIntro();
      /* and once more between countdown ticks */
      let sawCd = false;
      for (let i = 0; i < 30; i++) {
        Q.step(10);
        if (B.state.phase === 'countdown') { sawCd = true; B.game.reset(); break; }
      }
      out.sawCountdown = sawCd;
      B.game.skipIntro();
      for (let i = 0; i < 60 && B.state.phase !== 'fighting'; i++) Q.step(10);
      out.final = { phase: B.state.phase, round: B.state.round,
        countOn: document.querySelector('[data-count]').classList.contains('on'),
        endOn: document.querySelector('[data-end]').classList.contains('on') };
      /* post-spam bout still works: land a real hit */
      let sw = 0;
      while (sw++ < 10 && B.state.npc.hp >= B.state.npc.maxHp && B.state.phase === 'fighting') {
        if (Q.dist() > 1.5) { Q.step(8, { step: 1 }); continue; }
        Q.punch(sw % 2 ? 'right' : 'left');
      }
      out.hitAgain = B.state.npc.hp < B.state.npc.maxHp;
      return out;
    });
    check('G: reset during down-count + mid-countdown — phases stay sane',
      g2.downPhase === 'playerdown' && g2.afterDownReset.phase === 'intro'
        && g2.afterDownReset.php === 100 && g2.final.phase === 'fighting'
        && !g2.final.countOn && !g2.final.endOn,
      JSON.stringify(g2));
    check('G: post-spam bout lands a real hit', g2.hitAgain, `hit=${g2.hitAgain}`);
    check('G: zero page errors through reset spam',
      errs.length === 0, errs.slice(0, 3).join(' | '));
    detach();
  }

  /* ================= H. localStorage corruption ======================= */
  {
    /* corrupt boxing:npc picks — every one must fall back to a real fighter */
    const npcPicks = ['{}', '"proto:bogus"', '\u0000\u0000junk\ufffd', 'x'.repeat(200000)];
    const pickRes = [];
    for (const pick of npcPicks) {
      await pg.evaluate(v => localStorage.setItem('boxing:npc', v), pick);
      const b = await boot(pg, `${base}/boxing.html?notrack=1`,
        { wait: 'window.__boxing && window.__boxing.fight' });
      const r = await pg.evaluate(() => ({ v: window.__boxing.npc?.variant,
        kind: window.__boxing.npc?.kind, name: window.__boxing.state.npc.name }));
      pickRes.push({ pick: pick.slice(0, 18) + (pick.length > 18 ? '…' : ''), r, errs: b.errs.length });
      b.detach();
    }
    const picksOk = pickRes.every(p => p.errs === 0 && p.r.v === 'bubble');
    check('H: corrupt boxing:npc values all fall back to BUBBLE, zero errors',
      picksOk, JSON.stringify(pickRes));

    /* corrupt stats/settings keys — read at boot (sound/volume) and at
       bout-end (ko/best/wins); boot + reach 'fighting' must not throw */
    await pg.evaluate(() => {
      localStorage.setItem('boxing:ko', '{bad');
      localStorage.setItem('boxing:best', '[]');
      localStorage.setItem('boxing:wins', '"x"');
      localStorage.setItem('boxing:sound', 'loud');
      localStorage.setItem('boxing:volume', 'abc');
    });
    const hb = await boot(pg, `${base}/boxing.html?notrack=1`);
    const hfig = await pg.evaluate(() => {
      const Q = window.__qe;
      for (let i = 0; i < 40 && window.__boxing.state.phase !== 'fighting'; i++) Q.step(10);
      return { phase: window.__boxing.state.phase };
    });
    check('H: corrupt stats/settings keys — boots + reaches fighting clean',
      hfig.phase === 'fighting' && hb.errs.length === 0,
      JSON.stringify({ phase: hfig.phase, errs: hb.errs.slice(0, 2) }));
    hb.detach();

    /* same corruption facing the lineup page */
    const lb = await boot(pg, `${base}/lineup.html`,
      { wait: 'document.querySelectorAll(".cell").length >= 3', driver: false, settleMs: 2500 });
    const lres = await pg.evaluate(() => ({
      cells: document.querySelectorAll('.cell').length,
      pick: document.querySelector('[data-pick]')?.textContent }));
    check('H: lineup renders with corrupt stats/pick storage',
      lres.cells >= 3 && !!lres.pick && lb.errs.length === 0,
      JSON.stringify({ lres, errs: lb.errs.slice(0, 2) }));
    lb.detach();
    await pg.evaluate(() => {   // leave storage clean for later sections
      for (const k of ['boxing:npc', 'boxing:ko', 'boxing:best', 'boxing:wins',
        'boxing:sound', 'boxing:volume']) localStorage.removeItem(k);
    });
  }

  /* ================= I. hidden-tab mid-fight ==========================
     Page.setWebLifecycleState 'hidden' is unimplemented in this Chromium —
     use Debugger.pause/resume for a REAL rAF stall (the dt-spike path), and
     a JS visibility override for the page's visibilitychange listener. */
  {
    const { errs, detach } = await boot(pg, `${base}/boxing.html?notrack=1`);
    const cdp = await pg.createCDPSession();
    const pre = await pg.evaluate(() => {
      const Q = window.__qe, B = window.__boxing;
      for (let i = 0; i < 40 && B.state.phase !== 'fighting'; i++) Q.step(10);
      B.fight._npc = () => {};                       // pure clock — nobody swings
      window.__rafN = 0;
      const f = () => { window.__rafN++; requestAnimationFrame(f); };
      requestAnimationFrame(f);
      return { tl: B.state.timeLeft, phase: B.state.phase };
    });
    await delay(600);
    await cdp.send('Debugger.enable');
    await cdp.send('Debugger.pause');
    await delay(3500);                               // the "hidden tab" window
    await cdp.send('Debugger.resume');
    const n1 = await pg.evaluate(() => window.__rafN).catch(() => -1);
    await delay(1400);
    const post = await pg.evaluate(() => ({
      tl: window.__boxing.state.timeLeft, phase: window.__boxing.state.phase,
      raf: window.__rafN,
      npcY: window.__boxing.npc.group.position.y }));
    check('I: rAF stalled during the freeze and resumed after',
      n1 >= 0 && post.raf > n1 + 3, JSON.stringify({ n1, raf: post.raf }));
    check('I: 3.5s stall did not drain the fight clock (dt clamped)',
      pre.phase === 'fighting' && post.phase === 'fighting'
        && (pre.tl - post.tl) > 0 && (pre.tl - post.tl) < 2.3,
      JSON.stringify({ before: pre.tl, after: post.tl, phase: post.phase }));
    check('I: npc transform stayed finite through the stall',
      Number.isFinite(post.npcY), `npcY=${post.npcY}`);

    /* the visibilitychange listener path (video track toggling) must not
       throw when the state flips either way */
    const vis = await pg.evaluate(() => {
      const out = {};
      try {
        Object.defineProperty(document, 'hidden', { get: () => true, configurable: true });
        Object.defineProperty(document, 'visibilityState', { get: () => 'hidden', configurable: true });
        document.dispatchEvent(new Event('visibilitychange'));
        Object.defineProperty(document, 'hidden', { get: () => false, configurable: true });
        Object.defineProperty(document, 'visibilityState', { get: () => 'visible', configurable: true });
        document.dispatchEvent(new Event('visibilitychange'));
        out.ok = true;
      } catch (e) { out.ok = false; out.err = String(e); }
      return out;
    });
    check('I: visibilitychange listener survives hidden↔visible flips',
      vis.ok === true, JSON.stringify(vis));
    check('I: zero page errors through the hidden-tab drill',
      errs.length === 0, errs.slice(0, 3).join(' | '));
    detach();
  }

  /* ================= J. npc.js torture (live impls) =================== */
  {
    const { errs, detach } = await boot(pg, `${base}/boxing.html?notrack=1`);
    const tort = await pg.evaluate(async () => {
      const B = window.__boxing, T = B.THREE, out = {};
      const { createNpc } = await import('./shared/boxing/npc.js');
      /* a real GLB over HTTP → kind:'glb' → the makeRig squash rig — the
         Infinity-dt / unknown-pose paths a proto impl covers for itself */
      const bag = await createNpc(T, { manifest: { candidates: [
        { id: 'qe-bag', type: 'glb', name: 'QE BAG',
          path: 'vendor/models/glb/boxing/punching-bag.glb', scale: 1 }] },
        id: 'qe-bag' });
      out.glbKind = bag.kind;
      const rig = bag.group.children[0];                     // makeRig's group
      for (const dt of [Infinity, -1, NaN, 1e9]) bag.update(dt, { pos: { x: 0, z: 0 } });
      bag.update(.016, { pos: { x: 0, z: 0 }, npc: { action: 'idle' } });
      out.rigFinite = Number.isFinite(rig.position.y) && Number.isFinite(rig.rotation.x);
      /* unknown pose → idle fallback (was: froze on the previous pose) */
      bag.update(.016, { pos: { x: 0, z: 0 }, npc: { action: 'down', actionT: 1 } });
      for (let i = 0; i < 40; i++) bag.update(.05, { pos: { x: 0, z: 0 }, npc: { action: 'bogusAction' } });
      out.poseFallbackRx = rig.rotation.x;                   // ≈0 idle, ≈-1.35 if frozen on 'down'
      /* malformed strike ctx + telegraph with missing parts → fallback spot */
      bag.update(.016, { pos: { x: 0, z: 0 }, strike: { reach: 'x', y: NaN },
        npc: { action: 'windup', actionT: .1, telegraph: { kind: 'jab', side: 'middle', t01: NaN } } });
      const sprite = bag.group.children.find(o => o.isSprite);
      out.telShown = !!(sprite && sprite.visible);
      out.telFinite = sprite ? Number.isFinite(sprite.position.y + sprite.scale.x) : null;
      bag.update(.016, { pos: { x: 0, z: 0 }, strike: { reach: .9, y: NaN },   // reach ok, y NaN
        npc: { action: 'punch', actionT: .2 } });
      out.strikeFinite = Number.isFinite(rig.rotation.x + rig.position.y);
      bag.update(.016, { pos: { x: 0, z: 0 }, npc: { action: 'idle' } });
      bag.dispose(); bag.dispose();                          // idempotent
      out.glbGone = bag.group.parent === null;
      /* proto impl on the live npc — same torture through the real adapter */
      out.gc = B.npc.gloveColor;
      for (const dt of [Infinity, -1, NaN, 1e9]) B.npc.update(dt, { pos: { x: 0, z: 0 } });
      B.npc.update(.016, { pos: { x: 0, z: 0 }, npc: { action: 'idle' } });
      out.protoFinite = Number.isFinite(B.npc.group.position.y);
      /* finite reach + NaN strike.y used to flow into the pose strike ctx */
      B.npc.update(.016, { pos: { x: 0, z: 0 }, strike: { reach: .9, y: NaN },
        npc: { action: 'punch', actionT: .2 } });
      out.strikeFinite = Number.isFinite(B.npc.group.rotation.y
        + B.npc.group.position.x + B.npc.group.position.y);
      B.npc.update(.016, { pos: { x: 0, z: 0 }, npc: { action: 'idle' } });
      B.npc.setDamage(NaN); B.npc.setDamage(-2); B.npc.setDamage(.6);
      let badMats = 0;
      B.npc.group.traverse(o => {
        if (o.isMesh && o.material && !Array.isArray(o.material) && o.material.color)
          for (const c of [o.material.color.r, o.material.color.g, o.material.color.b])
            if (!Number.isFinite(c)) badMats++;
      });
      out.badMats = badMats;
      B.npc.resetDamage();
      B.npc.update(.016, { pos: { x: 0, z: 0 }, npc: {} });   // empty fight ctx → idle
      out.updateNullCtx = (() => { try { B.npc.update(.016, null); return true; } catch { return false; } })();
      return out;
    });
    check('J: glb rig survives dt torture + unknown-pose fallback',
      tort.glbKind === 'glb' && tort.rigFinite && Math.abs(tort.poseFallbackRx) < .3,
      JSON.stringify({ kind: tort.glbKind, finite: tort.rigFinite, rx: tort.poseFallbackRx }));
    check('J: telegraph sprite falls back when glove parts are missing',
      tort.telShown && tort.telFinite,
      JSON.stringify({ shown: tort.telShown, finite: tort.telFinite }));
    check('J: dispose() is idempotent + update(null ctx) does not throw',
      tort.glbGone === true && tort.updateNullCtx === true,
      JSON.stringify({ gone: tort.glbGone, nullCtx: tort.updateNullCtx }));
    check('J: live npc — gloveColor css, dt torture, NaN setDamage safe',
      /^#[0-9a-f]{6}$/.test(tort.gc) && tort.protoFinite && tort.strikeFinite
        && tort.badMats === 0,
      JSON.stringify({ gc: tort.gc, finite: tort.protoFinite,
        strike: tort.strikeFinite, badMats: tort.badMats }));
    check('J: zero page errors through npc torture',
      errs.length === 0, errs.slice(0, 3).join(' | '));
    detach();
  }

  /* ================= K. multi-round / multi-KO ======================= */
  {
    const { errs, detach } = await boot(pg, `${base}/boxing.html?notrack=1`);
    const mr = await pg.evaluate(() => {
      const Q = window.__qe, B = window.__boxing, out = {};
      for (let i = 0; i < 40 && B.state.phase !== 'fighting'; i++) Q.step(10);
      const rs0 = Q.count('round-start');
      /* ride round 1 → round 2: shorten the clock, sit through the countdown */
      B.state.timeLeft = .05; B.state.npc.hp = B.state.npc.maxHp;
      for (let i = 0; i < 60 && B.state.phase === 'fighting'; i++) Q.step(10);
      out.between = { phase: B.state.phase, round: B.state.round };
      for (let i = 0; i < 60 && B.state.phase === 'countdown'; i++) Q.step(10);
      out.r2 = { phase: B.state.phase, round: B.state.round, tl: B.state.timeLeft,
        rs: Q.count('round-start') - rs0 };
      /* KO in round 2 still ends the bout properly */
      B.state.npc.hp = 6;
      let sw = 0;
      while (sw++ < 14 && B.state.phase === 'fighting') {
        if (Q.dist() > 1.5) { Q.step(8, { step: 1 }); continue; }
        Q.punch(sw % 2 ? 'right' : 'left');
      }
      out.koPhase = B.state.phase;
      out.sawKo = Q.saw('ko');
      return out;
    });
    check('K: round transition — countdown then round 2, bell + clock reset',
      mr.between.phase === 'countdown' && mr.r2.phase === 'fighting'
        && mr.r2.round === 2 && mr.r2.tl > 60 && mr.r2.rs === 1,
      JSON.stringify(mr));
    check('K: KO in round 2 → npcdown', mr.sawKo && mr.koPhase === 'npcdown',
      JSON.stringify({ ko: mr.sawKo, phase: mr.koPhase }));
    let win2 = { phase: 'timeout' };
    try {
      await pg.waitForFunction(() => window.__boxing.state.phase === 'win', { timeout: 30000 });
      win2 = await pg.evaluate(() => ({ phase: window.__boxing.state.phase }));
    } catch { }
    check('K: round-2 KO resolves to win', win2.phase === 'win', JSON.stringify(win2));
    check('K: zero page errors through multi-round',
      errs.length === 0, errs.slice(0, 3).join(' | '));
    detach();
  }

  /* ================= L. corrupt boxing:ko → real KO =====================
     recordKo reads user-editable JSON live at KO time — the wave-3 fix
     shape-checks it ('5' / '"x"' / '{n:"a"}' / '{n:1e308}' used to crash
     `ko.n +=` inside the rAF events loop). These KOs MUST resolve on the
     page's own rAF loop: hud() is the only caller of recordKo/showEnd, and
     it only sees events the rAF step drained — hence punchRT + parked AI
     (deterministic KO on schedule, real hit detection all the way). */
  {
    const { errs, detach } = await boot(pg, `${base}/boxing.html?notrack=1`);
    await pg.evaluate(() => localStorage.removeItem('boxing:npc'));
    /* one KO per corrupt shape + a valid control proving increments survive */
    const KO_CASES = [
      ['primitive 5', '5', { n: 1, sum: 1 }],
      ['"x"', '"x"', { n: 1, sum: 1 }],
      ['{n:"a"}', '{"n":"a"}', { n: 1, sum: 1 }],
      ['{n:1e308}', '{"n":1e308}', { n: 1, sum: 1 }],
      ['valid {n:2,sum:5}', '{"n":2,"sum":5}', { n: 3, sum: 6 }],
    ];
    const koRes = [];
    for (const [nm, raw, want] of KO_CASES) {
      let rec, pre;
      try {
        pre = await pg.evaluate(async (v) => {
          const Q = window.__qe, B = window.__boxing;
          localStorage.setItem('boxing:ko', v);
          for (let i = 0; i < 80 && B.state.phase !== 'fighting'; i++) { B.game.skipIntro(); Q.step(10); }
          if (B.state.phase !== 'fighting') return { fail: 'no-fight', phase: B.state.phase };
          /* park PIP's brain AND its feet: 'hold' means stand ground, and
             the corner-parked player can't close distance — so teleport the
             NPC to punch range along its current bearing. The hit itself is
             100% real: landmarks → tracker → fight range check → _ko. */
          B.fight._npc = () => {};
          B.state.npc.hp = 4;
          const P = B.sim.player.pos, N = B.sim.npc.pos;
          const d = Math.hypot(N.x - P.x, N.z - P.z) || 1;
          N.x = P.x + (N.x - P.x) / d * .95; N.z = P.z + (N.z - P.z) / d * .95;
          const ml = (B.log || []).length;
          for (let s = 0; s < 6 && B.state.phase === 'fighting'
            && !B.log.slice(ml).includes('ko'); s++)
            await Q.punchRT(s % 2 ? 'right' : 'left');   // rAF lands it → hud drains 'ko'
          return { phase: B.state.phase, dist: Q.dist(),
            koSeen: B.log.slice(ml).includes('ko'),
            ev: B.log.slice(ml).filter(e => /^player-/.test(e)).slice(-5) };
        }, raw);
        if (pre.fail) { rec = { fail: pre.fail }; }
        else {
          try {
            await pg.waitForFunction(() => window.__boxing.state.phase === 'win',
              { timeout: 20000 });
            await delay(400);                       // a few hud frames → showEnd paints
          } catch { }
          rec = await pg.evaluate(() => ({
            phase: window.__boxing.state.phase,
            ko: JSON.parse(localStorage.getItem('boxing:ko') || 'null'),
            endOn: document.querySelector('[data-end]').classList.contains('on'),
            title: document.querySelector('[data-endtitle]').textContent }));
        }
      } catch (e) { rec = { fail: String(e).slice(0, 80) }; }
      koRes.push({ nm, pre, want, rec });
      /* fresh bout for the next value — same-tick reset+skipIntro (the N
         section asserts the re-arm semantics; here it's just the reset) */
      await pg.evaluate(() => { const B = window.__boxing; B.game.reset(); B.game.skipIntro(); });
      await delay(500);                               // rAF hud frame must see countdown → re-arm
    }
    for (const r of koRes) {
      const ko = r.rec?.ko;
      check(`L: boxing:ko = ${r.nm} → real KO records sanely + endcard shows`,
        !!ko && ko.n === r.want.n && ko.sum === r.want.sum
          && Number.isFinite(ko.n) && Number.isFinite(ko.sum)
          && r.rec.phase === 'win' && r.rec.endOn && /YOU WIN/i.test(r.rec.title || ''),
        JSON.stringify(r).slice(0, 220));
    }
    check('L: zero page errors across 5 corrupt-stat KOs',
      errs.length === 0, errs.slice(0, 3).join(' | '));
    detach();
  }

  /* ================= M. waitForHands — hold the bell ===================
     controls.waitForHands is the page's "landmarker still booting" hold —
     the rAF loop computes it from handStatus/trackWaitT0 (never true under
     ?notrack, so we can't ride the real formula). Inject it the way the
     loop does: wrap game.step so EVERY caller — rAF included — presents
     controls.waitForHands=true. That drives the REAL hud path: the
     countdown slot shows 'FINDING YOUR HANDS' while the clock holds. */
  {
    const { errs, detach } = await boot(pg, `${base}/boxing.html?notrack=1`);
    /* leg 1 — hold while still in the fresh-bout phases right after boot
       (intro runs ~6s wall): the bell must not ring while held */
    const m1 = await pg.evaluate(`(() => new Promise(res => {
      const B = window.__boxing, out = { phase0: B.state.phase };
      const orig = B.game.step; let waits = 0;
      B.game.step = (dt, hs, fs, c) => {
        const o = orig.call(B.game, dt, hs, fs, { ...(c || {}), waitForHands: true });
        if (o?.entranceWaiting) waits++;
        return o;
      };
      setTimeout(() => {
        out.held = { phase: B.state.phase, waits,
          cdOn: document.querySelector('[data-countdown]').classList.contains('on'),
          cdRound: document.querySelector('[data-cdround]').textContent,
          cdN: document.querySelector('[data-cdn]').textContent };
        B.game.step = orig;
        res(out);
      }, 1600);
    }))()`);
    check('M: intro/countdown held under waitForHands — no phase advance',
      (m1.phase0 === 'intro' || m1.phase0 === 'countdown') && m1.held.phase === m1.phase0
        && m1.held.waits > 3,
      JSON.stringify(m1));
    check("M: countdown slot shows 'FINDING YOUR HANDS' while held",
      m1.held.cdOn && /FINDING YOUR HANDS/.test(m1.held.cdRound || '')
        && m1.held.cdN === '…',
      JSON.stringify(m1.held));

    /* leg 2 — hold DURING the countdown: the numbers must freeze, not tick */
    const m2 = await pg.evaluate(`(() => new Promise(res => {
      const Q = window.__qe, B = window.__boxing, out = {};
      B.game.skipIntro();
      for (let i = 0; i < 80 && B.state.phase !== 'countdown'; i++) Q.step(10);
      for (let i = 0; i < 30 && B.state.countdown === 0; i++) Q.step(2);
      out.cd0 = { phase: B.state.phase, cd: B.state.countdown };
      const orig = B.game.step; let waits = 0;
      B.game.step = (dt, hs, fs, c) => {
        const o = orig.call(B.game, dt, hs, fs, { ...(c || {}), waitForHands: true });
        if (o?.entranceWaiting) waits++;
        return o;
      };
      setTimeout(() => {
        out.held = { phase: B.state.phase, cd: B.state.countdown, waits,
          cdOn: document.querySelector('[data-countdown]').classList.contains('on'),
          cdRound: document.querySelector('[data-cdround]').textContent,
          cdN: document.querySelector('[data-cdn]').textContent };
        B.game.step = orig;
        res(out);
      }, 1500);
    }))()`);
    check('M: countdown number frozen under the hold (dt=0 to fight.step)',
      m2.cd0.phase === 'countdown' && m2.held.phase === 'countdown'
        && m2.held.cd === m2.cd0.cd && m2.cd0.cd > 0 && m2.held.waits > 3,
      JSON.stringify(m2));

    /* release → the bell resumes, round 1 rings, hint swaps back */
    let m3 = { phase: 'timeout' };
    try {
      await pg.waitForFunction(() => window.__boxing.state.phase === 'fighting',
        { timeout: 15000 });
      await delay(300);
      m3 = await pg.evaluate(() => ({
        phase: window.__boxing.state.phase,
        rs: (window.__boxing.log || []).includes('round-start'),
        cdRound: document.querySelector('[data-cdround]').textContent,
        cdOn: document.querySelector('[data-countdown]').classList.contains('on') }));
    } catch { }
    check('M: releasing waitForHands resumes → ROUND 1 bell + fighting',
      m3.phase === 'fighting' && m3.rs === true && !m3.cdOn,
      JSON.stringify(m3));
    check('M: zero page errors through waitForHands injection',
      errs.length === 0, errs.slice(0, 3).join(' | '));
    detach();
  }

  /* ================= N. endcard same-tick re-arm ======================
     The wave-3 fix re-arms `ended` on a fresh-bout phase (intro OR
     countdown@round1) — a same-tick reset()+skipIntro() never renders an
     'intro' frame, so before the fix the card stayed latched and the next
     verdict was swallowed. Verdicts here also go through the rAF drain. */
  {
    const { errs, detach } = await boot(pg, `${base}/boxing.html?notrack=1`);
    const driveKo = `(() => {
      const Q = window.__qe, B = window.__boxing;
      return (async () => {
        for (let i = 0; i < 80 && B.state.phase !== 'fighting'; i++) { B.game.skipIntro(); Q.step(10); }
        if (B.state.phase !== 'fighting') return { fail: 'no-fight', phase: B.state.phase };
        /* parked AI + parked feet: 'hold' stands ground and the player can't
           close distance — teleport PIP to punch range on its own bearing.
           The punch itself is the real landmark→tracker→fight hit path. */
        B.fight._npc = () => {};
        B.state.npc.hp = 4;
        const P = B.sim.player.pos, N = B.sim.npc.pos;
        const d = Math.hypot(N.x - P.x, N.z - P.z) || 1;
        N.x = P.x + (N.x - P.x) / d * .95; N.z = P.z + (N.z - P.z) / d * .95;
        const ml = (B.log || []).length;
        for (let s = 0; s < 6 && B.state.phase === 'fighting'
          && !B.log.slice(ml).includes('ko'); s++)
          await Q.punchRT(s % 2 ? 'right' : 'left');
        return { phase: B.state.phase, koSeen: B.log.slice(ml).includes('ko'),
          ev: B.log.slice(ml).filter(e => /^player-/.test(e)).slice(-5) };
      })();
    })()`;
    const n0 = await pg.evaluate(driveKo);
    let n1 = { phase: 'timeout' };
    try {
      await pg.waitForFunction(() => window.__boxing.state.phase === 'win', { timeout: 20000 });
      await delay(500);
      n1 = await pg.evaluate(() => ({
        phase: window.__boxing.state.phase,
        endOn: document.querySelector('[data-end]').classList.contains('on'),
        ended: document.body.classList.contains('ended') }));
    } catch { }
    check('N: first bout resolves win + endcard latched',
      n1.phase === 'win' && n1.endOn && n1.ended, JSON.stringify({ n0, n1 }));

    /* the regression input: reset()+skipIntro() in ONE evaluate while the
       card is up — hud never sees 'intro', must still re-arm on countdown */
    const n2 = await pg.evaluate(() => {
      const B = window.__boxing;
      B.game.reset(); B.game.skipIntro();
      return { phase: B.state.phase };
    });
    await delay(900);                                  // let rAF hud frames run
    const n3 = await pg.evaluate(() => ({
      phase: window.__boxing.state.phase, round: window.__boxing.state.round,
      endOn: document.querySelector('[data-end]').classList.contains('on'),
      ended: document.body.classList.contains('ended') }));
    check('N: same-tick reset+skipIntro → card + ended cleared on re-arm',
      !n3.endOn && !n3.ended && n3.round === 1
        && (n3.phase === 'countdown' || n3.phase === 'fighting' || n3.phase === 'intro'),
      JSON.stringify({ n2, n3 }));

    /* and the fresh bout must latch its OWN verdict — not stay swallowed */
    const n4 = await pg.evaluate(driveKo);
    let n5 = { phase: 'timeout' };
    try {
      await pg.waitForFunction(() => window.__boxing.state.phase === 'win', { timeout: 20000 });
      await delay(500);
      n5 = await pg.evaluate(() => ({
        phase: window.__boxing.state.phase,
        endOn: document.querySelector('[data-end]').classList.contains('on'),
        ended: document.body.classList.contains('ended'),
        title: document.querySelector('[data-endtitle]').textContent }));
    } catch { }
    check('N: fresh bout re-latches its own verdict — YOU WIN card again',
      n5.phase === 'win' && n5.endOn && n5.ended && /YOU WIN/i.test(n5.title || ''),
      JSON.stringify({ n4, n5 }));
    check('N: zero page errors through same-tick re-arm',
      errs.length === 0, errs.slice(0, 3).join(' | '));
    detach();
  }

  /* ============== O. corrupt volume/sound/best/wins ===================
     boxing:volume 'abc' → Number()=NaN — the wave-3 guard skips setVolume
     so the default .8 survives; 'loud' ≠ '0' → unmuted. 'best'/'wins' go
     through num() → non-finite falls to 0 → sane writes. The audio object
     is page-closure: capture every GainNode via evaluateOnNewDocument —
     gains[0] is BoxingAudio's master (first createGain in unlock()). */
  {
    await pg.evaluateOnNewDocument(() => {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC || AC.prototype.__qeGainWrap) return;
      const og = AC.prototype.createGain;
      AC.prototype.createGain = function () {
        const g = og.call(this);
        (window.__qeGains ||= []).push(g);
        return g;
      };
      AC.prototype.__qeGainWrap = true;
    });
    await pg.evaluate(() => {
      localStorage.setItem('boxing:volume', 'abc');      // NaN → must be rejected
      localStorage.setItem('boxing:sound', 'loud');      // !=='0' → unmuted
      localStorage.setItem('boxing:best', '"oops"');     // → num → 0 → best=score
      localStorage.setItem('boxing:wins', '"x"');        // → num → 0 → wins=1
    });
    const { errs, detach } = await boot(pg, `${base}/boxing.html?notrack=1`);
    check('O: boots clean under corrupt audio/stats storage',
      errs.length === 0, errs.slice(0, 3).join(' | '));
    await pg.keyboard.press('x');                        // gesture → audio.unlock()
    await delay(600);
    const aud = await pg.evaluate(() => ({
      n: (window.__qeGains || []).length,
      v: window.__qeGains?.[0]?.gain?.value }));
    check('O: master gain finite at the .8 default (NaN volume rejected)',
      aud.n >= 1 && Number.isFinite(aud.v) && Math.abs(aud.v - .8) < .01,
      JSON.stringify(aud));

    /* real KO → win → recordEnd stores sane numbers, endcard BEST reads */
    const o1 = await pg.evaluate(`(() => {
      const Q = window.__qe, B = window.__boxing;
      return (async () => {
        for (let i = 0; i < 80 && B.state.phase !== 'fighting'; i++) { B.game.skipIntro(); Q.step(10); }
        if (B.state.phase !== 'fighting') return { fail: 'no-fight', phase: B.state.phase };
        B.fight._npc = () => {};
        B.state.npc.hp = 4;
        const P = B.sim.player.pos, N = B.sim.npc.pos;
        const d = Math.hypot(N.x - P.x, N.z - P.z) || 1;
        N.x = P.x + (N.x - P.x) / d * .95; N.z = P.z + (N.z - P.z) / d * .95;
        const ml = (B.log || []).length;
        for (let s = 0; s < 6 && B.state.phase === 'fighting'
          && !B.log.slice(ml).includes('ko'); s++)
          await Q.punchRT(s % 2 ? 'right' : 'left');
        return { phase: B.state.phase, koSeen: B.log.slice(ml).includes('ko'),
          ev: B.log.slice(ml).filter(e => /^player-/.test(e)).slice(-5) };
      })();
    })()`);
    let o2 = { phase: 'timeout' };
    try {
      await pg.waitForFunction(() => window.__boxing.state.phase === 'win', { timeout: 20000 });
      await delay(500);
      o2 = await pg.evaluate(() => ({
        phase: window.__boxing.state.phase,
        sub: document.querySelector('[data-endsub]').textContent,
        best: JSON.parse(localStorage.getItem('boxing:best') || 'null'),
        wins: JSON.parse(localStorage.getItem('boxing:wins') || 'null'),
        score: window.__boxing.state.player.score }));
    } catch { }
    check('O: win with corrupt stats → endcard BEST sane + stored values finite',
      o2.phase === 'win' && /BEST [\d,]+/.test(o2.sub || '')
        && o2.best === o2.score && o2.wins === 1 && Number.isFinite(o2.best),
      JSON.stringify({ o1, o2 }));
    check('O: zero page errors through corrupt-audio bout',
      errs.length === 0, errs.slice(0, 3).join(' | '));
    detach();
    await pg.evaluate(() => {                            // leave storage clean for P
      for (const k of ['boxing:volume', 'boxing:sound', 'boxing:best', 'boxing:wins',
        'boxing:ko', 'boxing:npc']) localStorage.removeItem(k);
    });
  }

  /* ============ P. npc.js manifest + residual torture (live) ==========
     Injected manifests are verbatim — wave-4 normalized them like the
     fetched path. Then the residual hunts: frozen ctx.npc (the old
     _seenKind stash write), api.kick replaced by a primitive, dispose
     mid-telegraph, dt extremes at every action boundary. */
  {
    const { errs, detach } = await boot(pg, `${base}/boxing.html?notrack=1`);
    const tort = await pg.evaluate(async () => {
      const B = window.__boxing, T = B.THREE;
      const out = { mani: [] };
      const { createNpc } = await import('./shared/boxing/npc.js');
      const pFin = n => Number.isFinite(n.group.position.x + n.group.position.y
        + n.group.position.z + n.group.rotation.x + n.group.rotation.y);
      const BAG = 'vendor/models/glb/boxing/punching-bag.glb';
      for (const [nm, man, id] of [
        ['candidates:"oops"', { candidates: 'oops' }, 'x'],
        ['candidates:{}', { candidates: { a: 1 } }, 'x'],
        ['candidates:null', { candidates: null }, 'x'],
        ['manifest:7', 7, 'x'],
        ['entries:[null,5,"x"]', { candidates: [null, undefined, 5, 'x'] }, 'x'],
        ['glb-entry-no-path', { candidates: [{ id: 'g', type: 'glb' }] }, 'g'],
        ['prop-only-pick', { candidates: [
          { id: 'bg', type: 'glb', notes: 'PROP dressing', path: BAG, scale: 45 }] }, 'bg'],
        ['valid-glb-control', { candidates: [
          { id: 'bg', type: 'glb', name: 'BAG', path: BAG, scale: 45 }] }, 'bg'],
      ]) {
        try {
          const m = await createNpc(T, { manifest: man, id });
          out.mani.push([nm, m.kind, m.id]);
          m.dispose();
        } catch (e) { out.mani.push([nm, 'THROW', String(e).slice(0, 70)]); }
      }
      /* frozen ctx.npc — the telegraph stash used to write onto it */
      out.frozen = (() => { try {
        B.npc.update(.016, { pos: { x: 0, z: 0 }, npc: Object.freeze(
          { action: 'windup', actionT: .2, telegraph: { kind: 'hook', side: 'left', t01: .5 } }) });
        B.npc.update(.016, { pos: { x: 0, z: 0 }, npc: Object.freeze({ action: 'punch', actionT: .3 }) });
        B.npc.update(.016, { pos: { x: 0, z: 0 }, npc: Object.freeze({ action: 'idle' }) });
        return pFin(B.npc); } catch (e) { return String(e).slice(0, 70); } })();
      /* api.kick REPLACED by a primitive — k[a]=0 on a string threw strict */
      out.kick = (() => { try {
        B.npc.kick = 42;
        B.npc.update(.016, { pos: { x: 0, z: 0 } });
        const reseated = typeof B.npc.kick === 'object';
        B.npc.resetDamage();
        return reseated && pFin(B.npc); } catch (e) { return String(e).slice(0, 70); } })();
      /* dispose MID-TELEGRAPH — then keep driving it: dead means dead */
      const d = await createNpc(T, { manifest: { candidates: [] }, id: 'proto:bubble' });
      d.update(.016, { pos: { x: 0, z: 0 }, npc: { action: 'windup', actionT: .3,
        telegraph: { kind: 'upper', side: 'right', t01: .7 } } });
      out.disp = (() => { try {
        d.dispose(); d.dispose();
        d.update(.016, { pos: { x: 1, z: 1 }, npc: { action: 'punch', actionT: .5 } });
        d.pose('jab', .5); d.setDamage(.9); d.resetDamage();
        return d.group.parent === null && pFin(d); } catch (e) { return String(e).slice(0, 70); } })();
      /* dt torture AT the action boundaries — every pose × extreme dt ×
         boundary actionT, on a fresh throwaway instance */
      const d2 = await createNpc(T, { manifest: { candidates: [] }, id: 'proto:bubble' });
      out.dt = (() => { try {
        for (const a of ['idle', 'windup', 'punch', 'block', 'hurt', 'down',
          'celebrate', 'stunned', 'whiff', 'bogus'])
          for (const dt of [0, -1, NaN, Infinity, 1e9])
            for (const at of [0, .45, 1e9, NaN])
              d2.update(dt, { pos: { x: 0, z: 0 }, npc: { action: a, actionT: at,
                telegraph: a === 'windup' ? { kind: 'jab', side: 'left', t01: NaN } : null } });
        return pFin(d2); } catch (e) { return String(e).slice(0, 70); } })();
      d2.dispose();
      return out;
    });
    const maniBad = tort.mani.filter(m => m[1] === 'THROW'
      || (m[0] === 'valid-glb-control' ? m[1] !== 'glb' : m[1] !== 'proto'));
    check('P: injected-manifest shapes resolve to a fighter — never throw',
      maniBad.length === 0 && tort.mani.length === 8,
      JSON.stringify(tort.mani));
    check('P: frozen ctx.npc through telegraph→punch stays clean',
      tort.frozen === true, JSON.stringify({ frozen: tort.frozen }));
    check('P: api.kick replaced by primitive → re-seated, no throw',
      tort.kick === true, JSON.stringify({ kick: tort.kick }));
    check('P: dispose mid-telegraph → dead api is a true no-op',
      tort.disp === true, JSON.stringify({ disp: tort.disp }));
    check('P: dt torture at action boundaries keeps transforms finite',
      tort.dt === true, JSON.stringify({ dt: tort.dt }));
    /* the 'glb-entry-no-path' candidate fetches './undefined' → ONE 404
       console entry — that IS the fallback path working, not a defect.
       Everything else must be silent. */
    const pErrs = errs.filter(e => !/Failed to load resource.*404/.test(e));
    const p404 = errs.length - pErrs.length;
    check('P: zero page errors through npc residual torture (1 expected GLB 404)',
      pErrs.length === 0 && p404 === 1,
      `unexpected=${JSON.stringify(pErrs.slice(0, 3))} glb404s=${p404}`);
    detach();
  }

  /* ================= Q. cornerHold halftime ===============================
     ?notrack keeps e2e deterministic while ?coach=1 force-arms the corner.
     Everything below is the page's own loop doing the work: scripted
     gloves/forced swings change hp, then real rAF frames run cornerTick. */
  {
    const { errs, detach } = await boot(pg, `${base}/boxing.html?notrack=1&coach=1`);
    check('Q: boots clean in ?notrack=1&coach=1', errs.length === 0, errs.slice(0, 2).join(' | '));
    const COACH_SEL = `document.querySelector('[data-coach]')`;
    const cardOn = `${COACH_SEL}.classList.contains('on')`;
    const snapJs = `(() => { const B = window.__boxing, st = B.state, N = B.sim.npc.pos;
      return { phase: st.phase, php: st.player.hp, nhp: st.npc.hp, score: st.player.score,
        combo: st.player.combo, round: st.round, tl: st.timeLeft, cd: st.countdown,
        act: st.npc.action, actT: st.npc.actionT, nx: N.x, nz: N.z,
        gy: B.npc.group.position.y, stam: st.player.stamina,
        logN: B.log.length, evN: st.events.length }; })()`;
    const toFighting = `(() => { const Q = window.__qe, B = window.__boxing;
      Q.hands(Q.EMPTY);                                // no stale fists from other sections
      for (let i = 0; i < 40 && B.state.phase !== 'fighting'; i++) Q.step(10);
      const P = B.sim.player.pos, N = B.sim.npc.pos;
      const d = Math.hypot(N.x - P.x, N.z - P.z) || 1;   // park PIP in range
      N.x = P.x + (N.x - P.x) / d * 1.0; N.z = P.z + (N.z - P.z) / d * 1.0;
      return B.state.phase; })()`;

    /* ---- leg 1: real damage (a forced hook) trips the corner ------------- */
    await pg.evaluate(toFighting);
    const trip = await pg.evaluate(() => {
      const Q = window.__qe, B = window.__boxing, st = B.state;
      B.state.player.hp = 42;                       // one hook short of the rope
      let ok = false;
      for (let i = 0; i < 240 && !ok; i++) { ok = B.fight.throwPunch('hook', 'left'); if (!ok) Q.step(3); }
      const m = Q.mark();
      for (let i = 0; i < 400 && !Q.saw('player-hit-taken', m) && st.phase === 'fighting'; i++) Q.step(1);
      return { thrown: ok, hit: Q.saw('player-hit-taken', m), hp: st.player.hp, phase: st.phase };
    });
    check('Q: real hook lands hp 42 → ≤1/3 inside a live bout',
      trip.thrown && trip.hit && trip.hp <= 34 && trip.phase === 'fighting', JSON.stringify(trip));
    let cardUp = false;
    try {
      await pg.waitForFunction(cardOn, { timeout: 12000 });
      cardUp = true;
    } catch { }
    const trig = await pg.evaluate(snapJs);
    check('Q: corner card rises at the damage trip', cardUp, `cardOn=${cardUp}`);
    check('Q: corner deals round-2 countdown patched to cornerHeal (never full)',
      trig.phase === 'countdown' && trig.round === 2
        && Math.abs(trig.php - 55) < .05 && trig.php < 100 && trig.stam >= .69,
      JSON.stringify(trig));

    /* ---- leg 2: freeze digest — the bout is stone while the card is up --- */
    const f1 = await pg.evaluate(snapJs);
    await delay(1600);
    const f2 = await pg.evaluate(snapJs);
    const froze = ['phase', 'php', 'nhp', 'score', 'combo', 'round', 'tl', 'cd',
      'act', 'actT', 'nx', 'nz', 'gy', 'logN', 'evN'].every(k => f1[k] === f2[k]);
    check('Q: cornerHold freezes the WHOLE bout — digest identical across 1.6s',
      froze && f1.phase === 'countdown', JSON.stringify({ a: f1, b: f2 }));
    /* the card's own clock is the only thing allowed to move */
    const bar1 = await pg.evaluate(() => document.querySelector('[data-coachtime]').style.transform);
    await delay(700);
    const bar2 = await pg.evaluate(() => document.querySelector('[data-coachtime]').style.transform);
    check('Q: coach timer bar drains while the fight is frozen',
      bar1 !== bar2 && /scaleX/.test(bar1 + bar2), JSON.stringify({ bar1, bar2 }));
    const rd = await pg.evaluate(() => document.querySelector('[data-coachrd]').textContent);
    check('Q: coach card headlines the next round', /ROUND 2/.test(rd), rd);

    /* ---- leg 3: Enter waves the card off; the SAME bout resumes ---------- */
    await pg.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    let skipped = false;
    try { await pg.waitForFunction(`!(${cardOn})`, { timeout: 4000 }); skipped = true; } catch { }
    let resumed = null;
    try {
      await pg.waitForFunction(`window.__boxing.state.phase === 'fighting'`, { timeout: 15000 });
      resumed = await pg.evaluate(snapJs);
    } catch { }
    check('Q: Enter skips the card → same bout resumes into round 2',
      skipped && resumed?.phase === 'fighting' && resumed.round === 2 && Math.abs(resumed.php - 55) < .05,
      JSON.stringify({ skipped, resumed }));

    /* ---- leg 4: the used latch — a second trip in the same bout can't fire */
    const refire = await pg.evaluate(() => {
      const B = window.__boxing;
      B.fight.opts.ai = false;                 // quiet the lab — no stray KOs
      B.state.player.hp = 25;
      return new Promise(r => setTimeout(() => r({
        on: document.querySelector('[data-coach]').classList.contains('on'),
        phase: B.state.phase }), 2300));
    });
    check('Q: used corner cannot refire in the same bout',
      !refire.on && refire.phase === 'fighting', JSON.stringify(refire));

    /* ---- leg 5: fresh bout re-arms — then reset MID-CARD ------------------
       the re-arm is a rAF-sighting mechanism: cornerTick clears `used` when it
       SEES intro or a round-1 countdown. Synchronous step bursts can burn
       through both inside one JS turn, so give the page real frames here. */
    const rearm = await pg.evaluate(() => {
      const B = window.__boxing;
      B.fight.opts.ai = true;
      B.game.reset(); B.game.skipIntro();
      return B.state.phase;
    });
    await delay(450);
    await pg.evaluate(toFighting);
    await pg.evaluate(() => { window.__boxing.state.player.hp = 30; });
    let refired = false;
    try { await pg.waitForFunction(cardOn, { timeout: 12000 }); refired = true; } catch { }
    check('Q: fresh bout re-arms — corner fires again at ≤1/3', refired, `phase=${rearm} cardOn=${refired}`);
    /* reset while the card is up: the card must die with the bout */
    const midReset = await pg.evaluate(() => {
      window.__boxing.game.reset();
      return window.__boxing.state.phase;
    });
    let cleared = false;
    try { await pg.waitForFunction(`!(${cardOn})`, { timeout: 4000 }); cleared = true; } catch { }
    const afterReset = await pg.evaluate(() => {
      const B = window.__boxing;
      B.game.skipIntro();
      for (let i = 0; i < 40 && B.state.phase !== 'fighting'; i++) window.__qe.step(10);
      const P = B.sim.player.pos, N = B.sim.npc.pos;
      const d = Math.hypot(N.x - P.x, N.z - P.z) || 1;
      N.x = P.x + (N.x - P.x) / d; N.z = P.z + (N.z - P.z) / d;
      return { phase: B.state.phase, php: B.state.player.hp, round: B.state.round };
    });
    check('Q: reset mid-card clears the card AND leaves no stuck hold',
      midReset === 'intro' && cleared && afterReset.phase === 'fighting' && afterReset.php === 100,
      JSON.stringify({ midReset, cleared, afterReset }));

    /* ---- leg 6: boundary semantics — 34 safe, 33.3 (≤1/3) trips — hp=100/3
       would sit ONE ULP over the floor ((100/3)/100 ≠ 1/3 in IEEE754), which
       is why the old 33.4 could never trip: it was strictly above -------- */
    await pg.evaluate(() => { const B = window.__boxing; B.fight.opts.ai = false; B.state.player.hp = 34; });
    const safe = await pg.evaluate(() => new Promise(r => setTimeout(() => r(
      document.querySelector('[data-coach]').classList.contains('on')), 1500)));
    check('Q: hp 34 (>1/3) never trips the corner', safe === false, `cardOn=${safe}`);
    await pg.evaluate(() => { window.__boxing.state.player.hp = 33.3; });
    let tripped = false;
    try { await pg.waitForFunction(cardOn, { timeout: 8000 }); tripped = true; } catch { }
    check('Q: hp ≤1/3 trips on the boundary itself', tripped, `cardOn=${tripped}`);
    await pg.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' })));
    try { await pg.waitForFunction(`!(${cardOn})`, { timeout: 4000 }); } catch { }
    /* KO straight through the rope: hp 10 − hook 12 → dead. The corner must
       NOT latch a card over a 'playerdown' — ordering is ko → down, full stop */
    /* reset to a FRESH bout first — the 33.4 trip above burned this bout's
       corner; only an unspent corner makes the KO-ordering test honest. The
       real-frame gap lets cornerTick sight the new bout and re-arm. */
    await pg.evaluate(() => { const B = window.__boxing; B.game.reset(); B.game.skipIntro(); });
    await delay(450);
    const edge = await pg.evaluate(() => {
      const Q = window.__qe, B = window.__boxing, st = B.state;
      for (let i = 0; i < 40 && st.phase !== 'fighting'; i++) Q.step(10);
      const P = B.sim.player.pos, N = B.sim.npc.pos;
      const d = Math.hypot(N.x - P.x, N.z - P.z) || 1;
      N.x = P.x + (N.x - P.x) / d; N.z = P.z + (N.z - P.z) / d;
      B.state.player.hp = 10;
      let ok = false;
      const m = Q.mark();
      for (let i = 0; i < 240 && !ok; i++) { ok = B.fight.throwPunch('hook', 'left'); if (!ok) Q.step(3); }
      for (let i = 0; i < 400 && st.phase === 'fighting'; i++) Q.step(1);
      const downPhase = st.phase;                    // 'playerdown' — or a corner stole it
      const seenCard = document.querySelector('[data-coach]').classList.contains('on');
      for (let i = 0; i < 700 && st.phase === 'playerdown'; i++) Q.step(1);   // ride the count out
      const ev = Q.got.slice(m);
      return { ok, downPhase, phase1: st.phase, seenCard,
        ev: ev.filter(e => /down|win|lose|corner|ko|rise$/.test(e)).slice(-8) };
    });
    await delay(400);
    const edgeCard = await pg.evaluate(cardOn);
    check("Q: KO through the rope → 'playerdown'→'lose', no corner card, sane order",
      edge.ok && edge.downPhase === 'playerdown' && !edge.seenCard && !edgeCard
        && edge.phase1 === 'lose' && edge.ev.includes('ko') && edge.ev.includes('lose')
        && !edge.ev.includes('corner'),
      JSON.stringify(edge));

    /* ---- leg 7: 'Gloves up' button + auto-expire both release the bout ---- */
    await pg.evaluate(() => { const B = window.__boxing; B.game.reset(); B.game.skipIntro(); });
    await delay(450);
    await pg.evaluate(toFighting);
    await pg.evaluate(() => { window.__boxing.state.player.hp = 28; });
    let btnCard = false;
    try { await pg.waitForFunction(cardOn, { timeout: 12000 }); btnCard = true; } catch { }
    if (btnCard) {
      await pg.click('[data-coachgo]');
      try { await pg.waitForFunction(`!(${cardOn})`, { timeout: 4000 }); } catch { }
    }
    const btnBack = await pg.evaluate(() => { const B = window.__boxing, Q = window.__qe;
      for (let i = 0; i < 40 && B.state.phase !== 'fighting'; i++) Q.step(10);
      return B.state.phase; });
    check("Q: 'Gloves up' button releases the card into a live round",
      btnCard && btnBack === 'fighting', JSON.stringify({ btnCard, btnBack }));

    await pg.evaluate(() => { const B = window.__boxing; B.game.reset(); B.game.skipIntro(); });
    await delay(450);
    await pg.evaluate(toFighting);
    await pg.evaluate(() => { window.__boxing.state.player.hp = 28; });
    const tA = await pg.evaluate(() => performance.now());
    let autoCard = false;
    try { await pg.waitForFunction(cardOn, { timeout: 12000 }); autoCard = true; } catch { }
    let autoOff = false, holdMs = 0;
    try {
      await pg.waitForFunction(`!(${cardOn})`, { timeout: 14000 });
      autoOff = true;
      holdMs = (await pg.evaluate(() => performance.now())) - tA;
    } catch { }
    const autoBack = await pg.evaluate(() => { const B = window.__boxing, Q = window.__qe;
      for (let i = 0; i < 40 && B.state.phase !== 'fighting'; i++) Q.step(10);
      return { phase: B.state.phase, round: B.state.round }; });
    check('Q: unsent card expires inside the hold window and play resumes',
      autoCard && autoOff && holdMs > 6000 && holdMs < 12000 && autoBack.phase === 'fighting',
      JSON.stringify({ autoCard, autoOff, holdMs: Math.round(holdMs), autoBack }));

    /* ---- leg 8: win path never corners ---------------------------------- */
    await pg.evaluate(() => { const B = window.__boxing; B.game.reset(); B.game.skipIntro(); });
    await delay(450);                                  // re-arm sighting frame
    const winLeg = await pg.evaluate(() => {
      const Q = window.__qe, B = window.__boxing, st = B.state;
      for (let i = 0; i < 40 && st.phase !== 'fighting'; i++) Q.step(10);
      B.fight.opts.ai = false;
      const P = B.sim.player.pos, N = B.sim.npc.pos;
      const d = Math.hypot(N.x - P.x, N.z - P.z) || 1;
      N.x = P.x + (N.x - P.x) / d; N.z = P.z + (N.z - P.z) / d;
      st.player.hp = 5; st.npc.hp = 3; st.player.stamina = 1;
      let ko = false;
      for (let s = 0; s < 6 && st.phase === 'fighting'; s++) {
        if (st.npc.action === 'hurt') { Q.step(24); continue; }
        Q.punch('left');
      }
      ko = st.phase === 'npcdown';
      const cardDuringDown = document.querySelector('[data-coach]').classList.contains('on');
      for (let i = 0; i < 400 && st.phase === 'npcdown'; i++) Q.step(1);
      return { ko, cardDuringDown, phase: st.phase,
        cardNow: document.querySelector('[data-coach]').classList.contains('on') };
    });
    check("Q: winning the bout never corners — 'npcdown'→'win' clean",
      winLeg.ko && winLeg.phase === 'win' && !winLeg.cardDuringDown && !winLeg.cardNow,
      JSON.stringify(winLeg));

    /* ---- probe (non-gating): the 'corner' engine event is dead ---------- */
    const deadEv = await pg.evaluate(() => ({
      inLog: (window.__boxing.log || []).includes('corner'),
      inGot: (window.__qe.got || []).includes('corner') }));
    artifact.probes.push({ name: 'corner-event-drain', ...deadEv,
      note: "fight.corner() _emits 'corner' from cornerTick (outside any step) — the "
        + "next fight.step wipes state.events before the drain: the event can never "
        + "reach hud()/audio. boxing.html FEED['corner'] is dead code." });
    if (!deadEv.inLog && !deadEv.inGot)
      log("probe: 'corner' event never reaches any drain (dead event — reported)");
    /* /api/coach + /api/coach-voice answer 501 on the dev server (no
       TensorMux/ElevenLabs keys) — that's the offline path working, logged
       as a console resource error. Filter 5xx resource noise, keep the rest. */
    const qErrs = errs.filter(e => !/Failed to load resource.*50\d/.test(e));
    check('Q: zero page errors across the whole cornerHold section',
      qErrs.length === 0, `unexpected=${JSON.stringify(qErrs.slice(0, 3))} api5xx=${errs.length - qErrs.length}`);
    detach();

    /* ---- Q-neg: ?coach=0 silences the corner entirely -------------------- */
    const neg = await boot(pg, `${base}/boxing.html?notrack=1&coach=0`);
    const negRes = await pg.evaluate(async () => {
      const Q = window.__qe, B = window.__boxing, st = B.state;
      for (let i = 0; i < 40 && st.phase !== 'fighting'; i++) Q.step(10);
      st.player.hp = 30;
      await new Promise(r => setTimeout(r, 1800));
      return { on: document.querySelector('[data-coach]').classList.contains('on'),
        phase: st.phase, hp: st.player.hp };
    });
    check('Q: ?coach=0 — no card even on the ropes', !negRes.on && negRes.hp <= 30,
      JSON.stringify(negRes));
    check('Q: ?coach=0 boot stays error-free', neg.errs.length === 0, neg.errs.slice(0, 2).join(' | '));
    neg.detach();
  }

  /* ================= R. coachAdvice abort/fallback =========================
     __qeCoach.hang wedges /api/coach mid-flight; the AbortController's own
     apiMs timer is the only way home — exactly the production failure mode
     of a dead TensorMux upstream. */
  {
    const { errs, detach } = await boot(pg, `${base}/boxing.html?notrack=1&coach=1`);
    await pg.evaluate(() => {
      const Q = window.__qe, B = window.__boxing;
      for (let i = 0; i < 40 && B.state.phase !== 'fighting'; i++) Q.step(10);
    });
    const CARD = `[data-coach]`;
    const hangOn = await pg.evaluate(() => {
      const B = window.__boxing;
      window.__qeCoach.hang = true;
      B.fight.opts.ai = false;
      B.state.player.hp = 30;
      return true;
    });
    let cardOn = false, cardAt = 0;
    try {
      await pg.waitForFunction(`document.querySelector('${CARD}').classList.contains('on')`, { timeout: 12000 });
      cardOn = true; cardAt = await pg.evaluate(() => performance.now());
    } catch { }
    check('R: corner card still rises with a wedged coach fetch', hangOn && cardOn, `cardOn=${cardOn}`);

    /* the abort lands ≈apiMs after the fetch; the canned tip lands inside it */
    let tipAt = 0, tip = '';
    try {
      await pg.waitForFunction(`(() => {
        const t = document.querySelector('[data-coachtip]').textContent;
        return t && !/shouting over the crowd/.test(t); })()`, { timeout: 12000 });
      tipAt = await pg.evaluate(() => performance.now());
      tip = await pg.evaluate(() => document.querySelector('[data-coachtip]').textContent);
    } catch { }
    const canned = /Hands up|Stop trading|Breathe\.|Cover the side/.test(tip);
    check('R: hanging fetch aborts ≈apiMs and the canned corner tip lands inside the hold',
      tipAt > 0 && tipAt - cardAt > 3000 && tipAt - cardAt < 7800 && canned,
      JSON.stringify({ tipDelayMs: Math.round(tipAt - cardAt), tip: tip.slice(0, 60) }));

    /* wait for the fetch journal: controller fired + promise settled + ~5s */
    const jrnl = await pg.evaluate(() => {
      const c = window.__qeCoach;
      const call = c.calls[0];
      return { nCalls: c.calls.length, aborted: !!call?.aborted, settled: !!call?.settled,
        ms: call?.ms,
        acAborted: c.acs.length ? c.acs[c.acs.length - 1].signal.aborted : null };
    });
    check('R: AbortController fired the abort — one call, settled, ≈apiMs',
      jrnl.nCalls === 1 && jrnl.aborted && jrnl.settled && jrnl.ms > 3000 && jrnl.ms < 7500,
      JSON.stringify({ ...jrnl, ms: Math.round(jrnl.ms || 0) }));

    /* card still bounded by the hold even with the fetch dying mid-way */
    let offAt = 0;
    try {
      await pg.waitForFunction(`!document.querySelector('${CARD}').classList.contains('on')`, { timeout: 12000 });
      offAt = await pg.evaluate(() => performance.now());
    } catch { }
    const rBack = await pg.evaluate(() => { const B = window.__boxing, Q = window.__qe;
      for (let i = 0; i < 40 && B.state.phase !== 'fighting'; i++) Q.step(10);
      return { phase: B.state.phase, php: Math.round(B.state.player.hp) }; });
    check('R: card closes inside the hold and play resumes patched',
      offAt > 0 && offAt - cardAt < 11000 && rBack.phase === 'fighting' && rBack.php === 55,
      JSON.stringify({ holdMs: Math.round(offAt - cardAt), ...rBack }));

    /* reset WHILE a coach fetch is still in the air — the late tip must be
       discarded by the corner.t0 staleness guard, not painted onto a fresh
       bout's card that isn't even up. The real-frame gap lets cornerTick
       sight the re-arm phases before the manual steps burn through them. */
    await pg.evaluate(() => {
      const B = window.__boxing;
      B.game.reset(); B.game.skipIntro();
    });
    await delay(450);
    await pg.evaluate(() => {
      const B = window.__boxing;
      for (let i = 0; i < 40 && B.state.phase !== 'fighting'; i++) window.__qe.step(10);
      B.state.player.hp = 30;                        // second fetch takes off…
    });
    let card2 = false, card2At = 0;
    try {
      await pg.waitForFunction(`document.querySelector('${CARD}').classList.contains('on')`, { timeout: 12000 });
      card2 = true; card2At = await pg.evaluate(() => performance.now());
    } catch { }
    await pg.evaluate(() => { window.__boxing.game.reset(); });   // kill mid-flight
    await delay(6200);                                            // past apiMs — the abort fires
    const stale = await pg.evaluate(() => {
      const c = window.__qeCoach, call = c.calls[1];
      return { nCalls: c.calls.length, call2: call ? { aborted: call.aborted, ms: Math.round(call.ms || 0) } : null,
        tip: document.querySelector('[data-coachtip]').textContent.slice(0, 60),
        cardOn: document.querySelector('[data-coach]').classList.contains('on'),
        phase: window.__boxing.state.phase };
    });
    check('R: reset mid-fetch — abort still lands, stale tip discarded by the guard',
      card2 && stale.nCalls === 2 && stale.call2?.aborted && stale.call2.ms > 3000
        && !stale.cardOn && !/Hands up|Stop trading|Breathe\.|Cover the side/.test(stale.tip),
      JSON.stringify({ card2, ...stale }));
    artifact.probes.push({ name: 'coach-abort-journal', calls: jrnl.nCalls + 1,
      firstCallMs: Math.round(jrnl.ms || 0), tipDelayMs: Math.round(tipAt - cardAt),
      holdMs: Math.round(offAt - cardAt), staleSecond: stale.call2 });
    const rErrs = errs.filter(e => !/Failed to load resource.*50\d/.test(e));
    check('R: zero page errors through the wedged-coach cascade',
      rErrs.length === 0, `unexpected=${JSON.stringify(rErrs.slice(0, 3))} api5xx=${errs.length - rErrs.length}`);
    detach();
  }

  /* ================= S. roster sweep ======================================
     Every pick shape the lineup can store, driven through a REAL bout boot —
     spawn, finite transform, a real telegraphed swing, real glove damage,
     and the gating rules the lineup itself enforces. */
  {
    const picks = [
      // [pick, ko-record, wantVariant, why]
      ['proto:bubble', null, 'bubble', 'house pick'],
      ['bubble', null, 'bubble', 'bare alias resolves the same fighter'],
      ['proto:bean', { n: 2, sum: 5 }, 'bean', 'earned — koAvg 2.5 ≤ 3'],
      ['bean', { n: 1, sum: 3 }, 'bean', 'boundary — koAvg 3 ≤ 3'],
      ['proto:bean', { n: 1, sum: 4 }, 'bubble', 'locked — koAvg 4 > 3'],
      ['proto:bean', null, 'bubble', 'locked — no ko record at all'],
      ['proto:sumo', { n: 2, sum: 4 }, 'sumo', 'earned — koAvg 2 ≤ 2'],
      ['proto:sumo', { n: 2, sum: 5 }, 'bubble', 'locked — koAvg 2.5 > 2'],
      ['boxing-gloves', null, 'bubble', 'PROP set dressing, not a fighter'],
      ['punching-bag', null, 'bubble', 'PROP set dressing, not a fighter'],
      ['totally-bogus', null, 'bubble', 'stale/unknown id'],
    ];
    const sweepErrs = [], rows = [];
    for (const [pick, ko, want, why] of picks) {
      await pg.evaluate(([p, k]) => {
        if (k === null) localStorage.removeItem('boxing:ko');
        else localStorage.setItem('boxing:ko', JSON.stringify(k));
        localStorage.setItem('boxing:npc', p);
      }, [pick, ko]);
      const b = await boot(pg, `${base}/boxing.html?notrack=1`, { settleMs: 500 });
      const row = await pg.evaluate(() => {
        const Q = window.__qe, B = window.__boxing, st = B.state;
        for (let i = 0; i < 40 && st.phase !== 'fighting'; i++) Q.step(10);
        const fin = o => !!o && [o.position.x, o.position.y, o.position.z,
          o.scale.x, o.scale.y, o.scale.z].every(Number.isFinite);
        const P = B.sim.player.pos, N = B.sim.npc.pos;
        const d = Math.hypot(N.x - P.x, N.z - P.z) || 1;
        N.x = P.x + (N.x - P.x) / d * 1.0; N.z = P.z + (N.z - P.z) / d * 1.0;
        B.fight.opts.ai = false;
        /* scripted swing — a REAL telegraph the engine resolves end to end */
        let thrown = false, tel = null, resolved = false;
        for (let i = 0; i < 120 && !thrown; i++) { thrown = B.fight.throwPunch('jab', 'left'); if (!thrown) Q.step(3); }
        for (let i = 0; i < 240; i++) {
          Q.step(1);
          if (st.npc.telegraph) tel = st.npc.telegraph;
          if (st.phase !== 'fighting') break;
          if (st.npc.action === 'whiff' || st.npc.action === 'idle' && tel && i > 40) { resolved = true; break; }
          if (st.npc.action === 'celebrate') { resolved = true; break; }
        }
        /* real glove damage — the tracking pipeline, not a hack */
        const hp0 = st.npc.hp;
        let swings = 0;
        while (swings++ < 8 && st.npc.hp >= hp0 && st.phase === 'fighting') {
          st.player.stamina = 1;
          if (st.npc.action === 'hurt') { Q.step(24); continue; }
          Q.punch(swings % 2 ? 'right' : 'left');
        }
        return { kind: B.npc.kind, v: B.npc.variant, name: st.npc.name,
          phase: st.phase, fin: fin(B.npc.group) && fin(B.npc.group.children[0]),
          thrown, tel: !!tel, resolved, hit: st.npc.hp < hp0,
          hp: Math.round(st.npc.hp), hp0: Math.round(hp0),
          eyeY: Number.isFinite(B.npc.eyeY) ? +B.npc.eyeY.toFixed(2) : B.npc.eyeY };
      });
      rows.push({ pick, want, why, ...row });
      check(`S: '${pick}' → ${want} (${why}) — spawns, telegraphs, eats damage`,
        row.v === want && row.kind === 'proto' && row.phase === 'fighting'
          && row.fin && row.thrown && row.tel && row.hit,
        JSON.stringify(row));
      sweepErrs.push(...b.errs); b.detach();
    }
    /* KO legs — every earned variant must still go down for the count */
    for (const [pick, ko, want] of [['proto:bean', { n: 1, sum: 2 }, 'bean'],
      ['proto:sumo', { n: 1, sum: 2 }, 'sumo'], ['proto:bubble', null, 'bubble']]) {
      await pg.evaluate(([p, k]) => {
        if (k === null) localStorage.removeItem('boxing:ko');
        else localStorage.setItem('boxing:ko', JSON.stringify(k));
        localStorage.setItem('boxing:npc', p);
      }, [pick, ko]);
      const b = await boot(pg, `${base}/boxing.html?notrack=1`, { settleMs: 500 });
      const kd = await pg.evaluate(() => {
        const Q = window.__qe, B = window.__boxing, st = B.state;
        for (let i = 0; i < 40 && st.phase !== 'fighting'; i++) Q.step(10);
        B.fight.opts.ai = false;
        const P = B.sim.player.pos, N = B.sim.npc.pos;
        const d = Math.hypot(N.x - P.x, N.z - P.z) || 1;
        N.x = P.x + (N.x - P.x) / d; N.z = P.z + (N.z - P.z) / d;
        st.npc.hp = 2;
        for (let s = 0; s < 6 && st.phase === 'fighting'; s++) {
          st.player.stamina = 1;
          if (st.npc.action === 'hurt') { Q.step(24); continue; }
          Q.punch(s % 2 ? 'right' : 'left');
        }
        return { v: B.npc.variant, name: st.npc.name, phase: st.phase, ko: Q.saw('ko') };
      });
      check(`S: ${want} goes down for the count — KO + npcdown`,
        kd.v === want && kd.phase === 'npcdown' && kd.ko, JSON.stringify(kd));
      sweepErrs.push(...b.errs); b.detach();
    }
    await pg.evaluate(() => { localStorage.removeItem('boxing:npc'); localStorage.removeItem('boxing:ko'); });
    check('S: zero page errors across the whole roster sweep',
      sweepErrs.length === 0, sweepErrs.slice(0, 3).join(' | '));
  }

  /* ================= T. score / combo math ================================
     ai-parked lab: throwPunch still telegraphs real swings and scripted
     gloves land real hits, but PIP makes no decisions of its own. Every
     assertion compares against the engine's own lastBlow record. */
  {
    const { errs, detach } = await boot(pg, `${base}/boxing.html?notrack=1`);
    const lab = await pg.evaluate(() => {
      const Q = window.__qe, B = window.__boxing, st = B.state;
      for (let i = 0; i < 40 && st.phase !== 'fighting'; i++) Q.step(10);
      B.fight.opts.ai = false;
      const T = B.fight._T;
      const inRange = () => {
        const P = B.sim.player.pos, N = B.sim.npc.pos;
        const d = Math.hypot(N.x - P.x, N.z - P.z) || 1;
        N.x = P.x + (N.x - P.x) / d; N.z = P.z + (N.z - P.z) / d;
      };
      inRange();
      const expectScore = lb => Math.round(lb.dmg * T.score.hitMul
        * (1 + Math.min(5, lb.combo - 1) * .15));
      /* one scripted glove → a landed hit (retry the whiffs the lab can't
         control: range/iframe slips). Returns the engine's own ledger. */
      const swing = (side = 'left') => {
        for (let t = 0; t < 6; t++) {
          inRange();
          st.player.stamina = 1;
          if (st.npc.action === 'hurt') { Q.step(24); continue; }
          const s0 = st.player.score, m = Q.mark();
          Q.punch(side);
          const lb = Q.lastBlow;
          if (lb?.who === 'player' && lb.result === 'hit')
            return { ok: true, lb: { kind: lb.kind, dmg: lb.dmg, counter: !!lb.counter,
              combo: lb.combo }, s0, s1: st.player.score,
              ev: Q.got.slice(m), combo: st.player.combo, counterT: st.player.counterT };
        }
        return { ok: false, lb: Q.lastBlow };
      };
      const out = { hits: [] };

      /* -- chain: four clean hits inside comboWindow → combo 1,2,3,4 ------- */
      for (let i = 0; i < 4; i++) {
        const h = swing(i % 2 ? 'right' : 'left');
        if (!h.ok) { out.broken = true; break; }
        const want = expectScore(h.lb);
        out.hits.push({ i, combo: h.lb.combo, delta: h.s1 - h.s0, want,
          counter: h.lb.counter, ev: h.ev.filter(e => e === 'player-hit' || e === 'npc-hit').length });
      }
      out.chainOk = out.hits.length === 4
        && out.hits.every((h, i) => h.combo === i + 1 && h.delta === h.want
          && !h.counter && h.ev === 2)
        && st.player.bestCombo >= 4;

      /* -- expiry: 2s of silence drops the chain ---------------------------- */
      Q.step(140);
      const after = swing('left');
      out.expOk = after.ok && after.lb.combo === 1 && after.combo === 1
        && after.s1 - after.s0 === expectScore(after.lb);

      /* -- counter window: perfect-dodge a forced jab → 1.6s reply window --- */
      let dodged = null;
      for (let i = 0; i < 120 && !B.fight.throwPunch('jab', 'left'); i++) Q.step(3);
      for (let i = 0; i < 120 && st.npc.action !== 'punch'; i++) Q.step(1);
      const dm = Q.mark();
      Q.step(1, { dodge: 1 });                        // edge — committed slip
      for (let i = 0; i < 90 && !Q.saw('perfect-dodge', dm) && st.phase === 'fighting'; i++) Q.step(1);
      dodged = { perfect: Q.saw('perfect-dodge', dm), counterT: st.player.counterT,
        score: st.player.score };
      const cHit = swing('right');
      out.counterOk = dodged.perfect && dodged.counterT > 1 && cHit.ok
        && cHit.lb.counter === true && cHit.ev.includes('counter')
        && cHit.s1 - cHit.s0 === expectScore(cHit.lb);
      /* expired window: same setup but 2s of silence before the reply */
      Q.step(140);
      const exp2 = swing('left');
      out.counterExpOk = exp2.ok && exp2.lb.counter === false
        && exp2.s1 - exp2.s0 === expectScore(exp2.lb);

      /* -- non-scoring outcomes: whiff + npc-block + a taken hit ------------- */
      const far = (() => {
        const s0 = st.player.score, c0 = st.player.combo, m = Q.mark();
        const N = B.sim.npc.pos; N.x += 6;             // way out of reach
        Q.punch('left'); inRange();
        const lb = Q.lastBlow;
        return { delta: st.player.score - s0, combo: st.player.combo, was: c0,
          miss: lb?.result === 'miss', sawMiss: Q.saw('player-miss', m) };
      })();
      out.whiffOk = far.miss && far.sawMiss && far.delta === 0 && far.combo === far.was;
      const blk = (() => {
        inRange();
        /* blockT is .7s — a scripted glove can emit late when the punch FSM
           is still unwinding from the whiff leg, letting 'block' tick out
           before impact. Pin the block window open for the probe swing. */
        const bT = T.blockT; T.blockT = 9;
        st.npc.action = 'block'; st.npc.actionT = 0;   // eats it on the gloves
        st.player.stamina = 1;               // a gassed glove whiffs 'exhausted' — the probe needs a live punch
        B.fight._comboT = Math.max(B.fight._comboT, 9);   // the ~1s scripted swing can
        // outlive a nearly-dead combo window — a TIMER lapse zeroing p.combo is
        // chain decay, not the block touching the chain. Hold the window open.
        const s0 = st.player.score, c0 = st.player.combo, m = Q.mark();
        Q.punch('left');
        T.blockT = bT;
        const lb = Q.lastBlow;
        st.npc.action = 'idle';
        return { delta: st.player.score - s0, combo: st.player.combo, was: c0,
          blocked: lb?.result === 'blocked', saw: Q.saw('npc-blocked', m),
          res: lb?.result, why: lb?.reason };
      })();
      out.blockOk = blk.blocked && blk.saw && blk.delta === 0 && blk.combo === blk.was;
      out.blk = blk;
      const taken = (() => {                          // a landed swing wipes the chain
        swing('left'); swing('right');                // build combo ≥1
        const c0 = st.player.combo;
        let ok2 = false;
        for (let i = 0; i < 120 && !B.fight.throwPunch('hook', 'right'); i++) Q.step(3);
        const s0 = st.player.score, m = Q.mark();
        for (let i = 0; i < 400 && !Q.saw('player-hit-taken', m) && st.phase === 'fighting'; i++) Q.step(1);
        return { c0, combo: st.player.combo, counterT: st.player.counterT,
          hp: st.player.hp, saw: Q.saw('player-hit-taken', m) };
      })();
      out.takenOk = taken.saw && taken.c0 >= 1 && taken.combo === 0 && taken.counterT === 0;

      /* -- KO bonus --------------------------------------------------------- */
      const koLeg = (() => {
        inRange();
        st.npc.hp = 2; st.player.stamina = 1;
        if (st.npc.action === 'hurt') Q.step(24);
        const s0 = st.player.score;
        for (let s = 0; s < 6 && st.phase === 'fighting'; s++) Q.punch('left');
        return { delta: st.player.score - s0, phase: st.phase, ko: Q.saw('ko') };
      })();
      out.koDelta = koLeg.delta - 0;
      out.koOk = koLeg.ko && koLeg.phase === 'npcdown' && koLeg.delta >= T.score.ko;
      out.score = st.player.score;
      return out;
    });
    check('T: combo chain builds 1→4, per-hit score matches the damage table',
      lab.chainOk === true, JSON.stringify(lab.hits));
    check('T: combo expires past comboWindow — next hit is combo 1 again',
      lab.expOk === true, JSON.stringify({ exp: lab.expOk }));
    check('T: perfect-dodge counter — flag + counter event + 1.35× damage scored',
      lab.counterOk === true, JSON.stringify({ dodged: lab.dodged }));
    check('T: counter window expires — later hit is plain again',
      lab.counterExpOk === true, JSON.stringify({ exp: lab.counterExpOk }));
    check('T: a whiffed glove scores nothing and leaves the chain alone',
      lab.whiffOk === true, JSON.stringify({ whiff: lab.whiffOk }));
    check('T: npc-blocked eats the blow — no score, chain untouched',
      lab.blockOk === true, JSON.stringify({ block: lab.blockOk, blk: lab.blk }));
    check('T: eating a hit zeroes combo AND counterT',
      lab.takenOk === true, JSON.stringify({ taken: lab.takenOk }));
    check("T: KO lands the +score.ko bonus on top of the hit",
      lab.koOk === true, JSON.stringify({ delta: lab.koDelta, score: lab.score }));

    /* -- multi-drain: rAF-paced swings — the drain can never double-count ---
       state.lastBlow is a per-frame transient (nulled at the top of every
       fight.step), so rAF-resolved hits can't be re-read after the fact —
       hp deltas ARE the ledger: with the combo window dead, score must be
       exactly round(dmg·5) and combo must read 1. */
    await pg.evaluate(() => { const B = window.__boxing; B.game.reset(); B.game.skipIntro();
      for (let i = 0; i < 40 && B.state.phase !== 'fighting'; i++) window.__qe.step(10);
      B.fight.opts.ai = false;
      const P = B.sim.player.pos, N = B.sim.npc.pos;
      const d = Math.hypot(N.x - P.x, N.z - P.z) || 1;
      N.x = P.x + (N.x - P.x) / d; N.z = P.z + (N.z - P.z) / d; });
    const rtLegs = [];
    for (let l = 0; l < 3; l++) {
      await delay(2100);                                 // combo window dies in RT
      const pre = await pg.evaluate(() => {
        window.__boxing.state.player.stamina = 1;        // never an 'exhausted' whiff
        return { s: window.__boxing.state.player.score, h: window.__boxing.state.npc.hp,
          logN: window.__boxing.log.length, gotN: window.__qe.got.length };
      });
      await pg.evaluate(side => window.__qe.punchRT(side), l % 2 ? 'right' : 'left');
      const post = await pg.evaluate(() => {
        const B = window.__boxing, st = B.state;
        return { s: st.player.score, h: st.npc.hp, combo: st.player.combo };
      });
      const ev = await pg.evaluate(pre2 => {
        const B = window.__boxing, Q = window.__qe;
        return { pHit: B.log.slice(pre2.logN).filter(e => e === 'player-hit').length
          + Q.got.slice(pre2.gotN).filter(e => e === 'player-hit').length,
          nHit: B.log.slice(pre2.logN).filter(e => e === 'npc-hit').length
          + Q.got.slice(pre2.gotN).filter(e => e === 'npc-hit').length };
      }, pre);
      rtLegs.push({ dScore: post.s - pre.s, dHp: pre.h - post.h,
        combo: post.combo, ev });
    }
    const rtOk = rtLegs.every(l => l.ev.pHit === 1 && l.ev.nHit === 1
      && l.dHp > 0 && l.combo === 1 && l.dScore === Math.round(l.dHp * 5));
    check('T: real-time drain — exactly one player-hit per swing, score never doubles',
      rtOk && rtLegs.length === 3, JSON.stringify(rtLegs));
    check('T: zero page errors through the score/combo lab',
      errs.length === 0, errs.slice(0, 3).join(' | '));
    detach();
  }

  /* ================= U. GLB failure cascade ===============================
     Every shape of broken GLB reference must resolve to a fighter — never a
     throw, never an invisible husk. Includes a Box3 monkeypatch that replays
     the wave-5 empty-geometry bug (scale −0, position +Infinity) end to end. */
  {
    const { errs, detach } = await boot(pg, `${base}/boxing.html?notrack=1`);
    const glb = await pg.evaluate(async () => {
      const B = window.__boxing, THREE = B.THREE;
      const { createNpc } = await import('./shared/boxing/npc.js');
      const fin = o => !!o && [o.position.x, o.position.y, o.position.z,
        o.scale.x, o.scale.y, o.scale.z].every(Number.isFinite);
      const drive = n => {                          // windup → down → dispose ×2
        n.update(1 / 60, { pos: { x: 0, z: 0 }, npc: { action: 'windup', actionT: .2,
          telegraph: { kind: 'jab', side: 'left', t01: .6 } } });
        n.update(1 / 60, { pos: { x: 0, z: 0 }, npc: { action: 'down', actionT: .3 } });
        const ok = fin(n.group) && fin(n.group.children[0]);
        n.dispose(); n.dispose();                   // idempotent — dead api is a no-op
        n.update(1 / 60, { pos: { x: 1, z: 1 }, npc: { action: 'punch', actionT: .2 } });
        return ok && !n.group.parent && fin(n.group);
      };
      const rows = [
        ['404-path', 'vendor/models/glb/boxing/ghost-missing.glb'],
        ['js-bytes', 'shared/boxing/npc.js'],
        ['video-bytes', 'test-input.mp4'],
        ['dir-path', 'shared/boxing/'],
        ['null-path', null], ['num-path', 12345], ['obj-path', { a: 1 }],
        ['empty-path', ''], ['dotdot', '../../../etc/passwd'],
      ];
      const out = [];
      for (const [id, path] of rows) {
        const rec = { id };
        try {
          const n = await createNpc(THREE, { manifest: { candidates: [
            { id, type: 'glb', path, scale: 1 }] }, id });
          rec.kind = n.kind; rec.v = n.variant;
          rec.ok = n.kind === 'proto' && drive(n);
        } catch (e) { rec.threw = String(e && e.message || e).slice(0, 80); }
        out.push(rec);
      }
      /* control: a real GLB must still come through as 'glb' */
      try {
        const n = await createNpc(THREE, { manifest: { candidates: [
          { id: 'bag', type: 'glb', path: 'vendor/models/glb/boxing/punching-bag.glb',
            scale: 45 }] }, id: 'bag' });
        out.push({ id: 'real-bag', kind: n.kind, ok: n.kind === 'glb' && drive(n) });
      } catch (e) { out.push({ id: 'real-bag', threw: String(e).slice(0, 80) }); }
      /* the wave-5 husk: a GLB that parses but carries NO renderable geometry
         measured an empty Box3 → scale.setScalar(-0) + position.y += +Infinity
         → invisible fighter teleported off the ring. Replay the exact failure
         with a Box3 that always reports empty — the adapter must refuse the
         husk and fall back to proto, not ship a ghost. */
      let husk = { id: 'empty-husk' };
      try {
        const orig = THREE.Box3.prototype.setFromObject;
        THREE.Box3.prototype.setFromObject = function () { this.makeEmpty(); return this; };
        try {
          const n = await createNpc(THREE, { manifest: { candidates: [
            { id: 'husk', type: 'glb',
              path: 'vendor/models/glb/boxing/punching-bag.glb', scale: 45 }] }, id: 'husk' });
          THREE.Box3.prototype.setFromObject = orig;
          husk = { id: 'empty-husk', kind: n.kind, ok: n.kind === 'proto' && drive(n) };
        } finally { THREE.Box3.prototype.setFromObject = orig; }
      } catch (e) { husk = { id: 'empty-husk', threw: String(e).slice(0, 80) }; }
      out.push(husk);
      return out;
    });
    const uBad = glb.filter(r => r.threw || r.ok !== true);
    check('U: every broken GLB path falls back to a working proto fighter',
      uBad.length === 0 && glb.length === 11, JSON.stringify(uBad.length ? uBad : glb.map(r => r.id + ':' + r.kind)));
    /* broken fetches log real 404s in the console — count them as expected,
       not as leaks; anything else is a defect */
    const uErrs = errs.filter(e => !/Failed to load resource.*(404|403)/.test(e));
    check('U: zero unexpected page errors across the GLB failure cascade',
      uErrs.length === 0, `unexpected=${JSON.stringify(uErrs.slice(0, 3))} benign404s=${errs.length - uErrs.length}`);
    artifact.probes.push({ name: 'glb-cascade', rows: glb });
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
writeFileSync(join(OUT_DIR, 'b5-e2e.json'), JSON.stringify(artifact, null, 1));
console.log('---- qe-e2e summary ----');
console.log(`${results.length - failed.length}/${results.length} checks passed · json → ${join(OUT_DIR, 'b5-e2e.json')}`);
console.log(failed.length ? `${failed.length} check(s) FAILED` : 'ALL CHECKS PASSED');
process.exit(failed.length ? 1 : 0);
