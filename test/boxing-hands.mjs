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

hand._ingest([open], handed);
check(hand.state.hands[0].kind === 'palm', 'open fingers register as a palm sign');
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
