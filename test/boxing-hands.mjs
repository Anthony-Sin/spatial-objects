import { Hands } from '../shared/hands.js';

const open = [
  [.5,.85],[.4,.76],[.34,.67],[.3,.6],[.25,.55],
  [.43,.6],[.42,.45],[.41,.34],[.4,.23],
  [.5,.57],[.5,.4],[.5,.29],[.5,.18],
  [.57,.6],[.58,.43],[.59,.34],[.6,.23],
  [.65,.65],[.68,.51],[.7,.43],[.72,.35],
].map(([x,y]) => ({ x,y,z:0 }));
const hand = new Hands();
const handed = [[{ categoryName: 'Right' }]];
const check = (ok, name) => { if (!ok) throw new Error(name); console.log('PASS', name); };

// a detection must persist CONFIRM_FRAMES results before it registers —
// single-frame phantom detections (MediaPipe pop-outs) never reach state
hand._ingest([open], handed);
check(hand.state.hands.length === 0, 'first-frame detection held at the phantom gate');
hand._ingest([open], handed);
check(hand.state.hands[0]?.kind === 'palm', 'open fingers register as a palm sign');
check(hand.state.hands[0]?.side === 'right', 'raw camera Right label maps to right selfie glove');
const x0 = hand.state.hands[0].lm[8].x;
hand._ingest([open.map(p => ({ ...p, x: p.x + .05 }))], handed);
const moved = hand.state.hands[0];
check(moved.lm.every(p => Number.isFinite(p.x) && Number.isFinite(p.y)),
  'tracked landmarks stay finite across frames');
check(moved.lm[8].x < x0, 'tracked hand follows movement in selfie view');

const fist = open.map(p => ({ ...p }));
for (const [tip, mcp] of [[8,5],[12,9],[16,13],[20,17]]) {
  fist[tip].x = fist[mcp].x; fist[tip].y = fist[mcp].y + .02;
}
hand._ingest([fist], handed);
check(hand.state.hands[0].kind === 'fist', 'curled fingers register as a fist');

// a brief dropout coasts on the last measured pose (the mitt must not blink
// out mid-punch) — only a long absence actually loses the hand
hand._ingest([], []);
check(hand.state.hands.length === 1, 'missed frame coasts on the stale pose');
for (let i = 0; i < 6; i++) hand._ingest([], []);
check(hand.state.hands.length === 0, 'long dropout finally loses the hand');
hand._ingest([fist], handed);
check(hand.state.hands.length === 0, 'dead track re-verifies before showing');
hand._ingest([fist], handed);
check(hand.state.hands[0]?.kind === 'fist', 're-verified hand shows again');

// a flickering detection never earns verification — claims must be consecutive
const ghost = new Hands();
const flicker = open.map(p => ({ ...p, x: p.x + .3 }));
for (let i = 0; i < 6; i++)
  ghost._ingest(i % 2 ? [] : [flicker], i % 2 ? [] : handed);
check(ghost.state.hands.length === 0, 'every-other-frame phantom never confirms');

// a verified track keeps its claim on a fast punch (>CLAIM_D per result) —
// only unverified tracks are held to the tight claim radius
const jab = fist.map(p => ({ ...p, x: p.x + .4 }));
hand._ingest([jab], handed);
check(hand.state.hands[0]?.kind === 'fist', 'fast punch keeps its verified track');

// a dead phantom's spot stays hot: a track that dies unverified leaves a
// ghost, and the next detection born there runs the longer streak —
// a phantom re-fires at the same spot, a real hand does not
const spook = new Hands();
const spot = open.map(p => ({ ...p, x: p.x - .2 }));
spook._ingest([spot], handed);                 // 1 claim — dies unverified
for (let i = 0; i < 8; i++) spook._ingest([], []);   // past TRACK_MISS → dead, ghosted
for (let i = 0; i < 2; i++) spook._ingest([spot], handed);  // < CONFIRM_GHOST
check(spook.state.hands.length === 0, 'dead-spot re-fire runs the longer streak');
spook._ingest([spot], handed);                          // 3rd consecutive → verified
check(spook.state.hands.length === 1, 'persistent detection eventually confirms at a hot spot');

// jitter-in-a-box: a phantom re-locks a different nearby spot every result —
// small bounding box, high per-claim jump — while a real still hand sits
// within ±.01. The jit hand verifies at 2 but gets suppressed once the
// pattern shows (claim 5); the still hand stays visible throughout.
const jit = new Hands();
const jx = dx => spot.map(p => ({ ...p, x: p.x + dx }));
for (let i = 0; i < 7; i++)
  jit._ingest([jx(i % 2 ? .06 : -.03)], handed);
check(jit.state.hands.length === 0, 'jittering phantom suppressed once the pattern shows');
