/* test/boxing-audio.mjs — node-safe checks for shared/boxing/audio.js.
   No deps: `node test/boxing-audio.mjs`. Prints PASS/FAIL lines, exits
   non-zero on any failure. The synth is proven with a stub AudioContext
   that records node/param calls — no real audio hardware involved. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { BoxingAudio, EVENT_SFX } from '../shared/boxing/audio.js';

const HERE = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '   <-- ' + extra}`);
  cond ? pass++ : fail++;
};

/* ---- stub Web Audio: nodes record their type; every param automatable ---- */
function fakeParam(v) {
  return {
    value: v,
    setValueAtTime(x) { this.value = x; },
    linearRampToValueAtTime(x) { this.value = x; },
    exponentialRampToValueAtTime(x) { this.value = x; },
    setTargetAtTime(x) { this.value = x; },
    cancelScheduledValues() {},
  };
}
function fakeCtx() {
  const made = [];
  const mk = type => {
    const n = {
      type,
      frequency: fakeParam(440), Q: fakeParam(1), gain: fakeParam(1),
      connect() {}, disconnect() {}, start() {}, stop() {},
    };
    made.push(n);
    return n;
  };
  return {
    made,
    currentTime: 0, sampleRate: 44100, state: 'running',
    destination: { type: 'destination' },
    resume() {},
    createOscillator: () => mk('osc'),
    createGain: () => mk('gain'),
    createBiquadFilter: () => mk('filter'),
    createDynamicsCompressor: () => mk('comp'),
    createBufferSource: () => mk('src'),
    createBuffer: (ch, len) => ({
      getChannelData: () => new Float32Array(len / ch | 0 || len),
    }),
  };
}

/* 0 — node-safe import + lazy context ---------------------------------- */
check('module imported with no window/AudioContext globals',
  globalThis.window === undefined && globalThis.AudioContext === undefined);
{
  const a = new BoxingAudio();
  check('fresh instance holds no AudioContext (lazy)', a.ctx === null);
  check('unlock() headless → null, no throw', a.unlock() === null);
  check('play() headless is a safe no-op', a.play('bell') === false);
  check('update() headless is a safe no-op',
    (() => { try { a.update(.016, { phase: 'fighting' }); return true; } catch { return false; } })());
}

/* 1 — EVENT_SFX covers every event fight.js can emit -------------------- */
{
  const src = readFileSync(join(HERE, '../shared/boxing/fight.js'), 'utf8');
  const emitted = new Set();
  for (const m of src.matchAll(/_emit\(([^)]*)\)/g))
    for (const s of m[1].matchAll(/'([^']+)'/g)) emitted.add(s[1]);
  check('fight.js emit-scan found ≥10 event strings', emitted.size >= 10,
    [...emitted].join(','));
  const missing = [...emitted].filter(e => !(e in EVENT_SFX));
  check('EVENT_SFX covers every emitted event', missing.length === 0, missing.join(','));
  const valid = new Set(['bell', 'whoosh', 'thwack', 'thud', 'dodge', 'hurt', 'ko', 'win', 'lose']);
  const bad = Object.entries(EVENT_SFX).filter(([, v]) => !valid.has(v));
  check('every EVENT_SFX value names a real sfx preset', bad.length === 0,
    JSON.stringify(bad));
}

/* 2 — stub ctx: play()/handleEvent() actually build nodes ---------------- */
{
  const ctx = fakeCtx();
  const a = new BoxingAudio();
  check('unlock(stub) adopts the injected ctx', a.unlock(ctx) === ctx && a.ctx === ctx);
  const n0 = ctx.made.length;
  check('unlock already wired master+comp+noise buffer', n0 >= 2, `made=${n0}`);

  const before = ctx.made.length;
  check("play('bell', {times:3}) schedules the 3×FM ding",
    a.play('bell', { times: 3 }) === true
    && ctx.made.filter(n => n.type === 'osc').length >= 6,
    `oscs=${ctx.made.filter(n => n.type === 'osc').length}`);
  check('bell created nodes', ctx.made.length > before);

  const b2 = ctx.made.length;
  check("handleEvent('player-hit') builds thwack nodes",
    a.handleEvent('player-hit', { lastBlow: { who: 'player', kind: 'hook', dmg: 13 } })
    && ctx.made.length > b2, `made=${ctx.made.length - b2}`);

  const b3 = ctx.made.length;
  check("handleEvent('round-start') → bell nodes", a.handleEvent('round-start', {})
    && ctx.made.length > b3);
  check('unknown event is ignored safely', a.handleEvent('bogus-evt', {}) === false);
  check('non-string event tolerated', a.handleEvent(null) === false
    && a.handleEvent({ type: 'ko' }, {}) === true);
}

/* 3 — every mapped event produces nodes (no dead presets) ---------------- */
{
  const ctx = fakeCtx();
  const a = new BoxingAudio(); a.unlock(ctx);
  let dead = [];
  for (const evt of Object.keys(EVENT_SFX)) {
    const before = ctx.made.length;
    a.handleEvent(evt, { lastBlow: { who: 'player', kind: 'jab', dmg: 7 } });
    if (ctx.made.length === before) dead.push(evt);
  }
  check('every EVENT_SFX event synthesizes ≥1 node', dead.length === 0, dead.join(','));
}

/* 4 — muted = silence ---------------------------------------------------- */
{
  const ctx = fakeCtx();
  const a = new BoxingAudio(); a.unlock(ctx);
  a.muted = true;
  const before = ctx.made.length;
  a.play('bell');
  a.handleEvent('ko', {});
  a.update(.016, { phase: 'fighting', player: { stamina: 0 } });
  check('muted → zero node creation', ctx.made.length === before,
    `leaked=${ctx.made.length - before}`);
  check('master gain forced to 0 while muted', a.master.gain.value === 0);
  a.muted = false;
  check('unmute restores master gain', a.master.gain.value === a.volume);
}

/* 5 — update(): crowd murmur bed + gassed breathing ----------------------- */
{
  const ctx = fakeCtx();
  const a = new BoxingAudio(); a.unlock(ctx);
  const fighting = { phase: 'fighting', player: { stamina: 1 } };
  a.update(.016, fighting);
  check('crowd bed starts during fighting phase', !!a._crowd
    && ctx.made.some(n => n.type === 'src'), `crowd=${!!a._crowd}`);
  a.update(.016, { phase: 'win', player: { stamina: 1 } });
  check('crowd bed stops off fighting', a._crowd === null);

  const b = ctx.made.filter(n => n.type === 'src').length;
  a.update(.016, fighting);                       // restarts bed
  a.update(.016, { phase: 'fighting', player: { stamina: .1 } });
  const srcs = ctx.made.filter(n => n.type === 'src').length;
  check('low stamina triggers breath noise puffs', srcs >= b + 2, `srcs=${srcs - b}`);
}

/* 6 — setVolume clamps ---------------------------------------------------- */
{
  const ctx = fakeCtx();
  const a = new BoxingAudio(); a.unlock(ctx);
  a.setVolume(2); check('setVolume clamps high', a.volume === 1);
  a.setVolume(-1); check('setVolume clamps low', a.volume === 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
