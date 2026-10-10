/* shared/boxing/boxglove.js — the boxing mitt overlay.

   A single chunky BLOCKY boxing glove — Kenney-style: rounded-rect mitt
   with a flat-ish knuckle face, thumb bump, wide laced cuff, ink outline.
   NO fingers, ever: the hand's 21 landmarks are used ONLY for position,
   angle and size (span = depth → bigger = closer). The mitt itself is a
   fixed silhouette so tracking jitter can't distort it.

   drawBoxGlove(ctx, P, opts)
     P    — either 21 {x,y} canvas-pixel landmarks, or null/short
            (then opts.manual must carry the pose)
     opts — { side:'left'|'right', kind, reach (1=rest, >1=thrust),
              squash (0..1 punch smear), dim (0..1 lost-tracking fade),
              manual:{x,y,size,ang} }
*/
const RED = '#e0341f', RED_D = '#b3261a', INK = '#2b2118',
  CUFF = '#fff8ec', LACE = '#e0341f', SHINE = 'rgba(255,248,236,.75)';

const palmPos = (P) => {
  const ring = [0, 5, 9, 13, 17];
  let x = 0, y = 0;
  for (const i of ring) { x += P[i].x; y += P[i].y; }
  x /= ring.length; y /= ring.length;
  return { x, y,
    size: Math.max(18, Math.hypot(P[0].x - P[9].x, P[0].y - P[9].y)),
    ang: Math.atan2(P[9].y - P[0].y, P[9].x - P[0].x) };
};

export function drawBoxGlove(ctx, P, opts = {}) {
  const pos = (P && P.length >= 21) ? palmPos(P) : opts.manual;
  if (!pos) return;
  const { x, y, ang } = pos;
  const reach = Math.max(0, Math.min(2.4, opts.reach ?? 1));
  const size = pos.size * (0.55 + 0.45 * Math.min(reach, 1.8));   // thrust grows the mitt
  const dim = opts.dim ?? 1;
  const sq = opts.squash ?? 0;                 // 0..1 stretch along the punch
  const w = size * 1.9, h = size * 1.55;       // chunky blocky lobe

  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(ang + Math.PI / 2);               // lm0→lm9 is wrist→knuckle; mitt faces forward
  ctx.globalAlpha = dim;

  // punch squash: lobe stretches along the thrust, cuffs stay put
  ctx.translate(0, -h * .18 * sq);
  ctx.scale(1 - sq * .18, 1 + sq * .34);

  const r = Math.min(w, h) * .42;              // big-but-squared corner radius (blocky)
  const thumbSide = opts.side === 'right' ? -1 : 1;

  // --- cuff (drawn first, sits behind the lobe) ---
  const cuffW = w * .62, cuffH = size * .62;
  ctx.beginPath();
  ctx.roundRect(-cuffW / 2, h * .34, cuffW, cuffH, cuffW * .3);
  ctx.fillStyle = CUFF; ctx.fill();
  ctx.lineWidth = Math.max(2.5, size * .055); ctx.strokeStyle = INK; ctx.stroke();
  // lace ticks across the cuff
  ctx.lineWidth = Math.max(1.6, size * .035);
  for (const lx of [-.22, 0, .22]) {
    ctx.beginPath();
    ctx.moveTo(lx * cuffW * 1.9, h * .42); ctx.lineTo(lx * cuffW * 1.9, h * .42 + cuffH * .62);
    ctx.strokeStyle = LACE; ctx.stroke();
  }

  // --- thumb bump (behind the lobe, on the inner side) ---
  ctx.beginPath();
  ctx.ellipse(thumbSide * w * .42, -h * .02, w * .24, h * .3, thumbSide * .5, 0, 7);
  ctx.fillStyle = RED_D; ctx.fill();
  ctx.lineWidth = Math.max(2.5, size * .05); ctx.strokeStyle = INK; ctx.stroke();

  // --- main mitt lobe ---
  ctx.beginPath();
  ctx.roundRect(-w / 2, -h * .92, w, h * 1.28, r);
  ctx.fillStyle = RED; ctx.fill();
  ctx.lineWidth = Math.max(3, size * .06); ctx.strokeStyle = INK; ctx.stroke();

  // knuckle face — a slightly darker flat panel up top (blocky planes)
  ctx.beginPath();
  ctx.roundRect(-w * .38, -h * .82, w * .76, h * .3, r * .5);
  ctx.fillStyle = RED_D; ctx.fill();
  ctx.lineWidth = Math.max(1.8, size * .03); ctx.stroke();

  // sheen arc on the knuckle face
  ctx.beginPath();
  ctx.arc(-w * .12, -h * .66, w * .16, Math.PI * 1.05, Math.PI * 1.65);
  ctx.strokeStyle = SHINE; ctx.lineWidth = Math.max(2, size * .045);
  ctx.lineCap = 'round'; ctx.stroke();

  ctx.restore();
}
