/* mitts/classic.js — 'Old Faithful': the original work-glove silhouette,
   painted boxing-glove red. The same blob-palm + knuckle-bump mitten the
   hand tracker always drew (fingers merged into one solid silhouette —
   bumpy knuckle edge, no skeleton), recolored to leather red with a cream
   laced cuff.

   When real landmarks ride in via o.lm (21 px pts) the mitt articulates
   with the hand exactly like the old renderer; without them it draws a
   closed-fist blob at pos (gallery/bots). */
const FINGERS = [[1, 2, 3, 4], [5, 6, 7, 8], [9, 10, 11, 12], [13, 14, 15, 16], [17, 18, 19, 20]];
const RED = '#e0341f', RED_D = '#b3261a', INK = '#2b2118',
  CUFF = '#fff8ec', LACE = '#e0341f', SHINE = 'rgba(255,248,236,.8)';

/* closed-fist 21-pt cloud — same mitten shape the mouse fallback uses,
   unit scale (span lm0→lm9 = 1.35) */
const FIST = [[0, 1.15], [.55, .78], [.8, .5], [1.0, .32], [1.12, .18],
  [.36, -.12], [.4, -.4], [.42, -.6], [.44, -.74],
  [0, -.2], [0, -.48], [0, -.7], [0, -.86],
  [-.34, -.12], [-.38, -.36], [-.4, -.55], [-.42, -.68],
  [-.6, -.05], [-.66, -.26], [-.7, -.42], [-.72, -.52]];

const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const away = (p, c, k) => ({ x: p.x + (p.x - c.x) * k, y: p.y + (p.y - c.y) * k });

function blobPalm(ctx, P, col) {
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

export const ID = 'classic';
export const NAME = 'Old Faithful';

export function draw(ctx, pos, o = {}) {
  if (!pos) return;
  const reach = Math.max(0, Math.min(2.4, o.reach ?? 1));
  const size = pos.size * (0.55 + 0.45 * Math.min(reach, 1.8));
  const dim = o.dim ?? 1;
  const sq = o.squash ?? 0;

  /* landmarks: real ones when handed in, else the fist cloud at pos.
     Everything is re-anchored on pos.x/y so manual poses still work. */
  let P;
  if (o.lm && o.lm.length >= 21) P = o.lm;
  else P = FIST.map(([x, y]) => ({ x: pos.x + x * size, y: pos.y + y * size }));

  // rescale the hand around its palm center so the mitt matches pos.size
  const ring = [0, 1, 5, 9, 13, 17];
  const c = { x: ring.reduce((s, i) => s + P[i].x, 0) / ring.length,
              y: ring.reduce((s, i) => s + P[i].y, 0) / ring.length };
  const span = Math.hypot(P[0].x - P[9].x, P[0].y - P[9].y) || 1;
  const k = (size * 1.35) / span;
  P = P.map(p => ({ x: pos.x + (p.x - c.x) * k, y: pos.y + (p.y - c.y) * k }));

  const fw = size * .24;
  const ang = Math.atan2(P[9].y - P[0].y, P[9].x - P[0].x);

  ctx.save();
  ctx.globalAlpha = dim;
  ctx.translate(pos.x, pos.y);
  ctx.rotate(pos.ang * .35);               // mild tilt — lm already carries angle
  ctx.translate(-pos.x, -pos.y);
  if (sq > 0) {                            // punch smear along the thrust
    ctx.translate(0, -size * .3 * sq);
    ctx.scale(1 - sq * .14, 1 + sq * .28);
  }

  // one solid glove: INK pass silhouettes fingers + palm as one shape;
  // RED pass paints it slightly smaller — ink survives only at the edge
  for (const pass of [{ c: INK, w: fw + 5 }, { c: RED, w: fw }]) {
    ctx.strokeStyle = ctx.fillStyle = pass.c;
    ctx.lineWidth = pass.w;
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    for (const ch of FINGERS) {
      ctx.beginPath(); ctx.moveTo(P[ch[0]].x, P[ch[0]].y);
      for (const j of ch.slice(1)) ctx.lineTo(P[j].x, P[j].y);
      ctx.stroke();
    }
    blobPalm(ctx, P, pass.c);
  }

  // cuff band + red lace ticks (worn like the old rim stripe)
  ctx.save(); ctx.translate(P[0].x, P[0].y); ctx.rotate(ang);
  ctx.beginPath(); ctx.roundRect(-fw * 1.7, -fw * 1.05, fw * 1.6, fw * 2.1, fw * .45);
  ctx.fillStyle = CUFF; ctx.fill(); ctx.strokeStyle = INK; ctx.lineWidth = 2; ctx.stroke();
  ctx.lineWidth = 2;
  for (const lx of [-.28, 0, .28]) {
    ctx.beginPath(); ctx.moveTo(-fw * 1.55 + lx * fw, -fw * .8);
    ctx.lineTo(-fw * 1.55 + lx * fw, fw * .8);
    ctx.strokeStyle = LACE; ctx.stroke();
  }
  ctx.restore();

  // sheen arc across the knuckle bumps
  ctx.beginPath();
  ctx.arc(P[9].x - fw * .4, P[9].y - fw * .6, fw * 1.1, Math.PI * 1.05, Math.PI * 1.6);
  ctx.strokeStyle = SHINE; ctx.lineWidth = Math.max(2, fw * .22); ctx.lineCap = 'round'; ctx.stroke();
  ctx.restore();
}
