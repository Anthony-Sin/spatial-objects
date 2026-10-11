// test/boxing-fists.mjs — node unit test for shared/boxing/fists.js. No deps.
//   node test/boxing-fists.mjs
// Scripted fake-landmark feeds (21-pt cloud around a center, scalable — same
// lm() pattern as test/jobverify.mjs). Every update() gets a FRESH state
// object so the tracker can't rely on identity across frames.
import { FistTracker, TUNING } from '../shared/boxing/fists.js';

let fails = 0;
const check = (name, cond, info = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${cond ? '' : '  → ' + info}`);
  if (!cond) fails++;
};

// ---- fake MediaPipe-shaped input -------------------------------------------
const lm = (cx, cy, s = 1) => Array.from({ length: 21 }, (_, i) =>
  ({ x: cx + (i % 5 - 2) * .02 * s, y: cy + Math.floor(i / 5) * .03 * s, z: 0 }));
const hand = (side, x, y, s = 1, kind = 'fist') => ({
  side, kind, lm: lm(x, y, s), palm: { x, y }, wrist: { x, y: y + .12 * s },
  indexTip: { x, y }, pinchAt: { x, y }, pinchD: .4,
  nExt: kind === 'fist' ? 0 : 4, nExtAll: kind === 'fist' ? 0 : 5 });
const hs = (...list) => ({ ok: true, hands: list.filter(Boolean),
  pinch: null, point: null, orbit: null, zoom: null, spread: null });
const fc = (x = .5, y = .4, found = true) =>
  ({ ok: true, found, nose: { x, y }, size: .32, center: { x, y } });
const DT = 1 / 60;
const drain = ft => ft.punches.splice(0, ft.punches.length);
// settle a fresh tracker: n calm frames so the baseline EMA locks in
const settle = (ft, h, f = fc(), n = 30) => { for (let i = 0; i < n; i++) ft.update(hs(h), f, DT); };

// ---- 1. calm hand → baseline settles, nothing fires --------------------------
{
  const ft = new FistTracker();
  settle(ft, hand('left', .4, .55, 1.6));
  const d = ft.debug();
  check('calm: baseline settles, reach≈1', Math.abs(d.reach.left - 1) < .08, `reach=${d.reach.left.toFixed(3)}`);
  check('calm: no punches', ft.punches.length === 0, `${ft.punches.length} events`);
  check('calm: mid-height hand → guard low', ft.guard.left < .5, ft.guard.left.toFixed(2));
}

// ---- 2. fast span growth on left → exactly one jab ---------------------------
{
  const ft = new FistTracker();
  settle(ft, hand('left', .4, .55, 1.6));
  drain(ft);
  const path = [1.7, 1.85, 2.0, 2.2, 2.4, 2.6, 2.75, 2.9,      // thrust out
                2.8, 2.6, 2.4, 2.2, 2.05, 2.0, 2.0, 2.0];      // retract home
  for (const s of path) ft.update(hs(hand('left', .4, .55, s)), fc(), DT);
  const ev = drain(ft);
  check('left thrust: exactly one punch', ev.length === 1, JSON.stringify(ev));
  check("left thrust → 'jab'", ev[0]?.kind === 'jab', ev[0]?.kind);
  check('jab side left', ev[0]?.side === 'left', ev[0]?.side);
  check('jab power>0', ev[0]?.power > 0, ev[0]?.power);
  check('jab power strong near cap', ev[0]?.power >= .9, ev[0]?.power);
  // the get-up QTE reads where the glove was when the punch let go
  check('punch carries palm spot (x,y in 0..1)',
    Number.isFinite(ev[0]?.x) && Number.isFinite(ev[0]?.y)
      && ev[0].x >= 0 && ev[0].x <= 1 && ev[0].y >= 0 && ev[0].y <= 1,
    `x=${ev[0]?.x} y=${ev[0]?.y}`);
}

// Closed hands in bright webcam footage are frequently tagged as a pinch.
// A curled finger count still represents a fist, and impact should land on
// the advancing hand before the apex/retraction frame.
{
  const ft = new FistTracker();
  settle(ft, hand('left', .4, .55, 1.6, 'fist'));
  const path = [1.7, 1.85, 2, 2.2, 2.4, 2.6, 2.75, 2.9];
  let landedAt = -1;
  for (let i = 0; i < path.length; i++) {
    const h = hand('left', .4, .55, path[i], 'fist');
    h.kind = 'pinch'; h.nExt = 0;
    ft.update(hs(h), fc(), DT);
    if (ft.punches.length && landedAt < 0) landedAt = i;
  }
  check('curled pinch is accepted as a boxing fist', ft.punches.length === 1);
  check('contact fires while fist advances', landedAt >= 0 && landedAt < path.length - 1,
    `index=${landedAt}`);
}

// ---- 3. right thrust → cross; lateral-dominant → hook; up-dominant → uppercut
{
  const ft = new FistTracker();
  settle(ft, hand('right', .6, .55, 1.6));
  drain(ft);
  for (const s of [1.8, 2.1, 2.4, 2.7, 2.5, 2.2, 2.0])        // thrust + retract
    ft.update(hs(hand('right', .6, .55, s)), fc(), DT);
  const ev = drain(ft);
  check("right thrust → exactly one 'cross'", ev.length === 1 && ev[0].kind === 'cross' && ev[0].side === 'right', JSON.stringify(ev));
}
{
  const ft = new FistTracker();
  settle(ft, hand('right', .6, .55, 1.6));
  drain(ft);
  const xs = [.63, .66, .69, .72, .75, .78, .80];              // big sideways sweep
  const ss = [1.66, 1.72, 1.78, 1.85, 1.92, 2.0, 2.06];        // slow span growth
  for (let i = 0; i < xs.length; i++) ft.update(hs(hand('right', xs[i], .55, ss[i])), fc(), DT);
  for (const s of [2.0, 1.9, 1.8]) ft.update(hs(hand('right', .80, .55, s)), fc(), DT);
  const ev = drain(ft);
  check("lateral-dominant thrust → 'hook'", ev.length === 1 && ev[0].kind === 'hook' && ev[0].side === 'right', JSON.stringify(ev));
}
{
  const ft = new FistTracker();
  settle(ft, hand('right', .6, .62, 1.6));
  drain(ft);
  const ys = [.58, .54, .50, .46, .42, .39, .37];              // rising fist
  const ss = [1.66, 1.72, 1.78, 1.85, 1.92, 2.0, 2.06];
  for (let i = 0; i < ys.length; i++) ft.update(hs(hand('right', .6, ys[i], ss[i])), fc(), DT);
  for (const s of [2.0, 1.9, 1.8]) ft.update(hs(hand('right', .6, .37, s)), fc(), DT);
  const ev = drain(ft);
  check("upward-dominant thrust → 'uppercut'", ev.length === 1 && ev[0].kind === 'uppercut' && ev[0].side === 'right', JSON.stringify(ev));
}

// ---- 4. both hands high + close → guard ≥ .6 ---------------------------------
{
  const ft = new FistTracker();
  const F = fc(.5, .38);
  for (let i = 0; i < 20; i++)
    ft.update(hs(hand('left', .3, .55, 1.6), hand('right', .7, .55, 1.6)), F, DT);
  check('hands at chest → guard low both',
    ft.guard.left < .45 && ft.guard.right < .45, `${ft.guard.left.toFixed(2)}/${ft.guard.right.toFixed(2)}`);
  for (let i = 0; i < 20; i++)
    ft.update(hs(hand('left', .3, .34, 1.6), hand('right', .7, .34, 1.6)), F, DT);
  check('hands up near face → guard ≥.6 both',
    ft.guard.left >= .6 && ft.guard.right >= .6, `${ft.guard.left.toFixed(2)}/${ft.guard.right.toFixed(2)}`);
  check('guard raise → no punch fired', ft.punches.length === 0, `${ft.punches.length}`);
}

// ---- 5. sway sign + calibrate() ----------------------------------------------
{
  const ft = new FistTracker();
  for (let i = 0; i < 10; i++) ft.update(hs(), fc(.5), DT);
  ft.calibrate();
  check('calibrate zeroes sway', ft.sway === 0, ft.sway);
  for (let i = 0; i < 12; i++) ft.update(hs(), fc(.62), DT);
  check('nose right of center → sway positive', ft.sway > .4, ft.sway.toFixed(2));
  for (let i = 0; i < 25; i++) ft.update(hs(), fc(.38), DT);
  check('nose left of center → sway negative', ft.sway < -.4, ft.sway.toFixed(2));
  ft.calibrate();
  check('re-calibrate re-zeros sway', ft.sway === 0, ft.sway);
  for (let i = 0; i < 20; i++) ft.update(hs(), fc(.38, .4), DT);
  check('neutral nose height → no duck', ft.duck < .05, ft.duck.toFixed(2));
  for (let i = 0; i < 20; i++) ft.update(hs(), fc(.38, .54), DT);
  check('nose drops well below neutral → duck', ft.duck > .7, ft.duck.toFixed(2));
  for (let i = 0; i < 30; i++) ft.update(hs(), fc(.38, .4), DT);
  check('head back up → duck releases', ft.duck < .1, ft.duck.toFixed(2));
  {   // sitting off-centre must NOT read as a lean; slow drift is absorbed, real leans are not
    const ac = new FistTracker();
    for (let i = 0; i < 30; i++) ac.update(hs(), fc(.62), DT);
    check('off-centre seat → no phantom lean', Math.abs(ac.sway) < .05, ac.sway.toFixed(2));
    for (let i = 0; i < 300; i++) ac.update(hs(), fc(.62 + .03 * i / 300), DT);   // 5s posture creep
    check('slow posture drift is absorbed', Math.abs(ac.sway) < .2, ac.sway.toFixed(2));
    for (let i = 0; i < 120; i++) ac.update(hs(), fc(.8), DT);                   // 2s held lean
    check('a real held lean is not eaten by auto-centre', ac.sway > .9, ac.sway.toFixed(2));
  }
  // calibrate also re-norms depth: settle, grow the hand, calibrate → reach 1
  settle(ft, hand('left', .4, .55, 1.6), fc(.38), 20);
  drain(ft);
  for (let i = 0; i < 6; i++) ft.update(hs(hand('left', .4, .55, 2.4)), fc(.38), DT);
  const r0 = ft.debug().reach.left;
  check('grown span → reach>1 before calibrate', r0 > 1.3, r0.toFixed(2));
  ft.calibrate();
  ft.update(hs(hand('left', .4, .55, 2.4)), fc(.38), DT);
  const r1 = ft.debug().reach.left;
  check('calibrate snaps baseline → reach≈1', Math.abs(r1 - 1) < .03, r1.toFixed(3));
}

// ---- 5b. chin tilt → pitch (step input — pose, not distance) -----------------
{
  /* canonical mid-sagittal mesh: lm[168] between the eyes, lm[1] nose tip,
     lm[152] chin. nose height inside the eye→chin band is a pose ratio —
     the same nod at any seat distance gives the same r. */
  const MESH = (chin, nose = .45, eye = .35, cx = .5) => {
    const lm = Array.from({ length: 478 }, () => ({ x: .5, y: .5, z: 0 }));
    lm[168] = { x: cx, y: eye, z: 0 }; lm[1] = { x: cx, y: nose, z: 0 };
    lm[152] = { x: cx, y: chin, z: 0 };
    return lm;
  };
  const fcP = (chin, opts = {}) => ({ ok: true, found: true,
    nose: { x: .5, y: opts.nose ?? .45 }, size: opts.size ?? .32,
    center: { x: .5, y: opts.center ?? .475 }, lm: MESH(chin, opts.nose ?? .45) });

  const ft = new FistTracker();
  for (let i = 0; i < 25; i++) ft.update(hs(), fcP(.60), DT);        // r = .40 neutral
  check('level chin → pitch ≈ 0', Math.abs(ft.pitch) < .08, ft.pitch.toFixed(3));
  for (let i = 0; i < 25; i++) ft.update(hs(), fcP(.50), DT);        // chin tucks up
  check('chin down → pitch positive (press in)', ft.pitch > .5, ft.pitch.toFixed(2));
  check('chin down is not a crouch — duck stays low', ft.duck < .25, ft.duck.toFixed(2));
  for (let i = 0; i < 30; i++) ft.update(hs(), fcP(.72), DT);        // chin stretches away
  check('chin up → pitch negative (back off)', ft.pitch < -.5, ft.pitch.toFixed(2));
  for (let i = 0; i < 40; i++) ft.update(hs(), fcP(.60), DT);
  check('level chin again → pitch ≈ 0', Math.abs(ft.pitch) < .1, ft.pitch.toFixed(2));
  // a pose held through calibrate becomes the new neutral
  for (let i = 0; i < 25; i++) ft.update(hs(), fcP(.50), DT);        // nod first…
  ft.calibrate();                                                  // …re-snap mid-nod
  check('calibrate zeroes pitch', ft.pitch === 0, ft.pitch);
  for (let i = 0; i < 25; i++) ft.update(hs(), fcP(.50), DT);        // still nodding
  check('nod held through calibrate → re-zeroed', Math.abs(ft.pitch) < .08, ft.pitch.toFixed(2));
  for (let i = 0; i < 30; i++) ft.update(hs(), fcP(.60), DT);        // back to level
  check('level chin after nod re-snap → reads as chin up', ft.pitch < -.5, ft.pitch.toFixed(2));
  // BlazeFace-shaped face (no lm) → pitch eases home, never NaN
  for (let i = 0; i < 25; i++) ft.update(hs(), fcP(.60), DT);        // pitch is clearly held ≠0
  const held = ft.pitch;
  for (let i = 0; i < 35; i++) ft.update(hs(), fc(.5, .45), DT);     // mesh gone
  check('no mesh → pitch decays to 0', held < -.5 && Math.abs(ft.pitch) < .1 && Number.isFinite(ft.pitch),
    `held=${held.toFixed(2)} now=${ft.pitch.toFixed(2)}`);
  // corrupt mesh frames never NaN the output
  const g = fcP(.6); g.lm[152] = { x: NaN, y: NaN }; g.lm[168] = null;
  for (let i = 0; i < 8; i++) ft.update(hs(), g, DT);
  check('corrupt mesh → pitch stays finite', Number.isFinite(ft.pitch), String(ft.pitch));
  const g2 = fcP(.6); g2.lm = 'x';
  for (let i = 0; i < 4; i++) ft.update(hs(), g2, DT);
  check('non-array lm → pitch stays finite', Number.isFinite(ft.pitch), String(ft.pitch));

  /* held-tilt regression: a modest chin-up (r .40→.35, inside the OLD
     |p|<CENTER_ZONE adapt band) used to get learned as neutral in seconds —
     the step decayed back to zero. Now only true dead-zone drift adapts. */
  const ht = new FistTracker();
  for (let i = 0; i < 25; i++) ht.update(hs(), fcP(.60), DT);          // neutral latch
  for (let i = 0; i < 150; i++) ht.update(hs(), fcP(.635), DT);        // hold a small tilt ~2.5s
  check('held modest chin-up → pitch holds, not eaten', ht.pitch < -.25, ht.pitch.toFixed(2));
  for (let i = 0; i < 60; i++) ht.update(hs(), fcP(.60), DT);          // level → releases
  check('level again → pitch releases', Math.abs(ht.pitch) < .1, ht.pitch.toFixed(2));
  /* slow tilt (ramp over ~2s) must still register — a deliberate retreat is
     rarely as snappy as a nod */
  const sl = new FistTracker();
  for (let i = 0; i < 25; i++) sl.update(hs(), fcP(.60), DT);
  for (let i = 0; i < 120; i++) sl.update(hs(), fcP(.60 + .14 * (i / 119)), DT);   // r .40 → .27
  check('slow chin-up ramp → pitch still goes negative', sl.pitch < -.5, sl.pitch.toFixed(2));
}

// ---- 6. hand disappears mid-thrust → clean decay -----------------------------
{
  const ft = new FistTracker();
  settle(ft, hand('left', .4, .55, 1.6));
  for (const s of [1.75, 1.95, 2.15]) ft.update(hs(hand('left', .4, .55, s)), fc(), DT);
  check('mid-thrust state entered', ft.debug().state.left === 'throw', ft.debug().state.left);
  for (let i = 0; i < 12; i++) ft.update(hs(), fc(), DT);       // hand vanishes
  const d = ft.debug();
  const finite = [d.span.left, d.reach.left, d.guard.left, d.sway].every(Number.isFinite);
  check('hand lost → debug stays finite (no NaN)', finite, JSON.stringify(d));
  check('hand lost → half-thrown punch cancelled', ft.punches.length === 0, `${ft.punches.length}`);
  check('hand lost → throw state cleared', ft.debug().state.left === 'idle', ft.debug().state.left);
  check('hand lost → guard decays', ft.guard.left < .05, ft.guard.left.toFixed(2));
  for (let i = 0; i < 10; i++) ft.update(hs(hand('left', .4, .55, 1.6)), fc(), DT);
  drain(ft);
  for (const s of [1.8, 2.1, 2.4, 2.7, 2.5, 2.2, 2.0])
    ft.update(hs(hand('left', .4, .55, s)), fc(), DT);
  const ev = drain(ft);
  check('hand returns → jab still fires', ev.length === 1 && ev[0].kind === 'jab', JSON.stringify(ev));
}

// ---- 7. combo: retract re-arms the fist --------------------------------------
{
  const ft = new FistTracker();
  settle(ft, hand('left', .4, .55, 1.6));
  drain(ft);
  const path = [1.85, 2.1, 2.4, 2.6, 2.4, 2.1, 1.9, 1.7,       // jab 1
                1.85, 2.1, 2.4, 2.6, 2.4, 2.1, 1.9, 1.7, 1.6];  // jab 2
  for (const s of path) ft.update(hs(hand('left', .4, .55, s)), fc(), DT);
  const ev = drain(ft);
  check('double jab → two events', ev.length === 2, `${ev.length} events`);
  check("both 'jab'", ev.every(e => e.kind === 'jab'), JSON.stringify(ev));
}

// ---- 8. robustness: degenerate inputs, tuning export, opts override ----------
{
  const ft = new FistTracker();
  let ok = true;
  try {
    ft.update(hs(hand('left', .4, .55, 1.6)), fc(), 0);         // dt = 0
    ft.update(hs(), null, undefined);                          // no face, no dt
    ft.update(null, null, .016);                               // no states at all
    ft.update({ hands: [{ side: 'left', kind: 'fist' }] }, fc(), .016); // hand w/o lm
  } catch (e) { ok = false; }
  check('degenerate inputs → no throw', ok);
  check('TUNING exported with thresholds', TUNING.FIRE_VEL > 0 && TUNING.REACH_CAP > 1);
  const stiff = new FistTracker({ FIRE_VEL: 99 });             // constructor opts
  settle(stiff, hand('left', .4, .55, 1.6));
  for (const s of [1.8, 2.1, 2.4, 2.7, 2.5, 2.2, 2.0])
    stiff.update(hs(hand('left', .4, .55, s)), fc(), DT);
  check('opts override tuning (FIRE_VEL=99 → no fire)', stiff.punches.length === 0);
}

// ---- 9. adversarial regressions (review-fists.md) ----------------------------
{
  // garbage hands shapes → never throw, never NaN
  const ft = new FistTracker();
  settle(ft, hand('left', .4, .55, 1.6));
  let ok = true, d;
  try {
    ft.update({ hands: {} }, fc(), DT);                        // non-array hands
    ft.update({ hands: 'x' }, fc(), DT);
    ft.update({ hands: 5 }, fc(), DT);
    ft.update({ hands: new Map() }, fc(), DT);
    ft.update({ hands: [null, hand('left', .4, .55, 1.6)] }, fc(), DT); // null entry
    ft.update({ hands: [42, 'x', undefined] }, fc(), DT);      // primitives
    const holey = hand('left', .4, .55, 1.6);
    holey.lm = new Array(21).fill(null);                       // lm all holes
    ft.update(hs(holey), fc(), DT);
    const holey2 = hand('left', .4, .55, 1.6);
    holey2.lm[9] = undefined;                                  // hole at lm[9]
    ft.update(hs(holey2), fc(), DT);
    const holey0 = hand('left', .4, .55, 1.6);
    holey0.lm[0] = null;                                       // hole at lm[0]
    ft.update(hs(holey0), fc(), DT);
    d = ft.debug();
  } catch (e) { ok = false; }
  check('garbage hands/lm shapes → no throw', ok);
  check('garbage frames → debug stays finite', d
    && [d.span.left, d.reach.left, d.guard.left, d.sway].every(Number.isFinite),
    JSON.stringify(d));
  // a null entry must not block the valid hand beside it
  drain(ft);
  for (const s of [1.8, 2.1, 2.4, 2.7, 2.5, 2.2, 2.0])
    ft.update({ hands: [null, hand('left', .4, .55, s)] }, fc(), DT);
  const ev0 = drain(ft);
  check('[null, validHand] → jab still fires', ev0.length === 1 && ev0[0].kind === 'jab', JSON.stringify(ev0));
}
{
  // 1-frame span spike → zero punches (real MediaPipe pop-out)
  const ft = new FistTracker();
  settle(ft, hand('left', .4, .55, 1.6));
  drain(ft);
  for (const s of [3.2, 1.6, 1.6, 1.6, 1.6])
    ft.update(hs(hand('left', .4, .55, s)), fc(), DT);
  check('1-frame span spike → no punch', ft.punches.length === 0, JSON.stringify(ft.punches));
}
{
  // ...but a 2-result throw is real and must still fire. Distinct values per
  // update = real tracking results; repeated numbers are the same result
  // held across render frames and must not count as new samples.
  const ft = new FistTracker();
  settle(ft, hand('left', .4, .55, 1.6));
  drain(ft);
  for (const s of [1.8, 2.2, 2.4, 1.6, 1.6, 1.6])
    ft.update(hs(hand('left', .4, .55, s)), fc(), DT);
  const ev = drain(ft);
  check('2-result throw → still fires', ev.length === 1 && ev[0].kind === 'jab', JSON.stringify(ev));
}
{
  // calibrate() must honor instance MIN_SPAN (was global TUNING)
  const tiny = new FistTracker({ MIN_SPAN: .001 });
  for (let i = 0; i < 20; i++) tiny.update(hs(hand('left', .4, .55, 1.6)), fc(), DT);
  for (let i = 0; i < 3; i++) tiny.update(hs(hand('left', .4, .55, .15)), fc(), DT); // span≈.013: >.001 opt, <.02 default
  tiny.calibrate();                                            // snaps baseline iff lastSpan > T.MIN_SPAN
  const b = tiny.debug().baseline.left;
  check('calibrate honors instance MIN_SPAN', Math.abs(b - .0128) < .002, `baseline=${b.toFixed(4)}`);
}

console.log(fails ? `\n${fails} FAIL` : '\nALL PASS');
process.exit(fails ? 1 : 0);
