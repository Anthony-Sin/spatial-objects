/* shared/glove.js — the cartoon glove renderer.
   drawGlove(ctx, P, opts) paints a full mitten-style glove from 21 landmarks:

     P = 21 {x,y} points in CANVAS pixels (caller handles mirroring/rects)
     opts: { kind, side, pinchAt {x,y}|null, tool }

   Design: 4 chunky rounded fingers + fat thumb capsule over a smooth
   blob palm (quadratic-smoothed metacarpal ring), banded cuff at the
   wrist with a gesture-colored rim stripe, pinch ring, role tag,
   floating tool glyph. Reads like a work glove, not a skeleton.
*/
const FINGERS = [[1, 2, 3, 4], [5, 6, 7, 8], [9, 10, 11, 12], [13, 14, 15, 16], [17, 18, 19, 20]];
const PAPER = 'rgba(255,252,244,.97)', INK = '#241c12',
  ACC = '#d85c3a', GRN = '#4f8f6b', DIM = '#8a7f6c';
const KIND_COL = { pinch: ACC, palm: GRN, point: INK, fist: INK, other: DIM };
const KIND_TXT = { pinch: 'GRAB', palm: 'ORBIT', point: 'POINT', fist: 'FIST', other: 'READY' };

const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const away = (p, c, k) => ({ x: p.x + (p.x - c.x) * k, y: p.y + (p.y - c.y) * k });

/* ctx.roundRect is Chrome 99+/FF 112+/Safari 16+ — on an older engine the
   bare call is a TypeError that kills the caller's whole render tick, so
   fall back to the arcTo version (visually identical). */
const rr = (ctx, x, y, w, h, r) => {
  if (ctx.roundRect) { ctx.roundRect(x, y, w, h, r); return; }
  const q = Math.min(Math.abs(r), Math.abs(w) / 2, Math.abs(h) / 2);
  ctx.moveTo(x + q, y);
  ctx.arcTo(x + w, y, x + w, y + h, q);
  ctx.arcTo(x + w, y + h, x, y + h, q);
  ctx.arcTo(x, y + h, x, y, q);
  ctx.arcTo(x, y, x + w, y, q);
  ctx.closePath();
};

function blobPalm(ctx, P, size, col) {
  // smooth closed curve through the metacarpal ring. Knuckles puff only a
  // touch (keeps the top edge flat — no scallops between finger bases);
  // the heel of the palm puffs more so it reads round and cartoony.
  // Fill only — the caller strokes each pass so the two passes layer into
  // one clean silhouette (ink under paper = outline at the boundary only).
  const ring = [0, 1, 5, 9, 13, 17];
  const c = { x: ring.reduce((s, i) => s + P[i].x, 0) / ring.length,
              y: ring.reduce((s, i) => s + P[i].y, 0) / ring.length };
  const puff = { 0: .3, 1: .12, 5: .07, 9: .07, 13: .07, 17: .16 };
  const R = ring.map(i => away(P[i], c, puff[i]));
  ctx.beginPath();
  ctx.moveTo(mid(R[R.length - 1], R[0]).x, mid(R[R.length - 1], R[0]).y);
  for (let i = 0; i < R.length; i++) {
    const m = mid(R[i], R[(i + 1) % R.length]);
    ctx.quadraticCurveTo(R[i].x, R[i].y, m.x, m.y);
  }
  ctx.closePath();
  ctx.fillStyle = col; ctx.fill();
}

function tag(ctx, txt, x, y, col) {
  ctx.font = '600 9.5px system-ui';
  const w = ctx.measureText(txt).width + 16;
  ctx.fillStyle = PAPER; ctx.strokeStyle = col; ctx.lineWidth = 1.2;
  ctx.beginPath(); rr(ctx, x - w / 2, y - 10, w, 19, 9); ctx.fill(); ctx.stroke();
  ctx.fillStyle = col; ctx.textAlign = 'center'; ctx.fillText(txt, x, y + 3.5); ctx.textAlign = 'left';
}

function toolGlyph(ctx, tx, ty, r, tool) {
  ctx.beginPath(); ctx.arc(tx, ty, r, 0, 7);
  ctx.fillStyle = PAPER; ctx.fill();
  ctx.strokeStyle = tool === 'drill' ? ACC : INK; ctx.lineWidth = 1.6; ctx.stroke();
  ctx.strokeStyle = ctx.fillStyle = tool === 'drill' ? ACC : INK;
  ctx.lineWidth = 1.8;
  const s = r * .55;
  ctx.beginPath();
  if (tool === 'box') ctx.rect(tx - s, ty - s, s * 2, s * 2);
  else if (tool === 'cyl') {
    ctx.ellipse(tx, ty - s * .7, s, s * .35, 0, 0, 7); ctx.moveTo(tx + s, ty - s * .7);
    ctx.lineTo(tx + s, ty + s * .7); ctx.moveTo(tx - s, ty - s * .7); ctx.lineTo(tx - s, ty + s * .7);
    ctx.moveTo(tx + s, ty + s * .7); ctx.ellipse(tx, ty + s * .7, s, s * .35, 0, 0, Math.PI);
  }
  else if (tool === 'sphere') ctx.arc(tx, ty, s, 0, 7);
  else if (tool === 'cone') { ctx.moveTo(tx, ty - s * 1.2); ctx.lineTo(tx + s, ty + s * .8); ctx.lineTo(tx - s, ty + s * .8); ctx.closePath(); }
  else if (tool === 'drill') { ctx.arc(tx, ty, s, 0, 7); ctx.moveTo(tx, ty); ctx.arc(tx, ty, s * .45, 0, 7); }
  else { ctx.moveTo(tx - s, ty); ctx.lineTo(tx + s, ty); ctx.moveTo(tx, ty - s); ctx.lineTo(tx, ty + s); ctx.moveTo(tx + s, ty); ctx.arc(tx, ty, s * .7, 0, 7); }
  ctx.stroke();
}

/* main entry — one hand per call. ctx state is fully save/restored: callers
   draw HUD text and more gloves after this, and a leaked font/lineCap used
   to bleed into their output. */
export function drawGlove(ctx, P, opts = {}) {
  if (!ctx) return;
  if (!P || P.length < 21) { console.warn('glove: short landmarks', P?.length); return; }
  // NaN/∞ landmarks silently no-op every canvas call anyway — bail early
  // instead of burning a frame's worth of dead path work
  for (let i = 0; i < 21; i++)
    if (!P[i] || !Number.isFinite(P[i].x) || !Number.isFinite(P[i].y)) return;
  ctx.save();
  try {
  // hand close to the camera spans half the frame — cap the glove so it
  // reads as an overlay, not a billboard. Landmarks rescale toward the
  // palm center so proportions survive.
  const raw = Math.hypot(P[0].x - P[9].x, P[0].y - P[9].y);
  const MAX = Math.max(90, ctx.canvas.width * .09);
  if (raw > MAX) {
    const ring = [0, 1, 5, 9, 13, 17];
    const c = { x: ring.reduce((s, i) => s + P[i].x, 0) / ring.length,
                y: ring.reduce((s, i) => s + P[i].y, 0) / ring.length };
    const k = MAX / raw;
    P = P.map(p => ({ x: c.x + (p.x - c.x) * k, y: c.y + (p.y - c.y) * k }));
  }
  const size = Math.max(18, Math.hypot(P[0].x - P[9].x, P[0].y - P[9].y));
  const fw = size * .24;
  const col = KIND_COL[opts.kind] || INK;
  const ang = Math.atan2(P[9].y - P[0].y, P[9].x - P[0].x);

  // One solid glove: the INK pass paints fingers + palm as a single ink
  // silhouette; the PAPER pass paints the same shapes slightly smaller on
  // top. Interior strokes get covered — ink survives only at the outer
  // boundary, so the hand reads as one filled glove, not fingers + hole.
  for (const pass of [{ c: INK, w: fw + 5 }, { c: PAPER, w: fw }]) {
    ctx.strokeStyle = ctx.fillStyle = pass.c;
    ctx.lineWidth = pass.w;
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    for (const ch of FINGERS) {
      ctx.beginPath(); ctx.moveTo(P[ch[0]].x, P[ch[0]].y);
      for (const j of ch.slice(1)) ctx.lineTo(P[j].x, P[j].y);
      ctx.stroke();
    }
    blobPalm(ctx, P, size, pass.c);
  }

  // cuff band + colored rim
  ctx.save(); ctx.translate(P[0].x, P[0].y); ctx.rotate(ang);
  ctx.beginPath(); rr(ctx, -fw * 1.7, -fw * 1.05, fw * 1.6, fw * 2.1, fw * .45);
  ctx.fillStyle = PAPER; ctx.fill(); ctx.strokeStyle = INK; ctx.lineWidth = 2; ctx.stroke();
  ctx.beginPath(); ctx.moveTo(-fw * .35, -fw * 1.0); ctx.lineTo(-fw * .35, fw * 1.0);
  ctx.strokeStyle = col; ctx.lineWidth = 2.2; ctx.stroke();
  ctx.restore();

  // pinch ring
  if (opts.kind === 'pinch' && opts.pinchAt) {
    ctx.beginPath();
    ctx.arc(opts.pinchAt.x, opts.pinchAt.y, 8 + Math.sin(performance.now() / 130) * 2, 0, 7);
    ctx.strokeStyle = ACC; ctx.lineWidth = 2.5; ctx.stroke();
  }
  // tool glyph above the fingertips
  if (opts.tool) {
    const top = P.reduce((m, p) => p.y < m.y ? p : m, P[0]);
    toolGlyph(ctx, top.x + fw * 1.2, top.y - fw * 1.4, fw * .8, opts.tool);
  }
  // role tag under the wrist
  const st = opts.side ? opts.side[0].toUpperCase() + ' · ' : '';
  tag(ctx, st + (KIND_TXT[opts.kind] || 'READY'), P[0].x, P[0].y + fw * 2.6, col);
  } finally { ctx.restore(); }
}
