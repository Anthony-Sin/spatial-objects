/* shared/boxing/boxglove.js — the boxing mitt overlay.

   One big ROUND boxing mitt — a puffball lobe like the old hand renderer's
   blob, but circular and fingerless: fat red circle, smaller thumb circle
   tucked on the inner side, wide laced cuff, ink outline, paper sheen.
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
  CUFF = '#fff8ec', LACE = '#e0341f', SHINE = 'rgba(255,248,236,.8)';

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
  const R = size * .92;                        // main lobe radius — big circle
  const thumbSide = opts.side === 'right' ? -1 : 1;
  const inkW = Math.max(3, size * .06);

  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(ang + Math.PI / 2);               // lm0→lm9 is wrist→knuckle; mitt faces forward
  ctx.globalAlpha = dim;

  // punch squash: lobe stretches along the thrust, cuff stays put
  ctx.translate(0, -R * .3 * sq);
  ctx.scale(1 - sq * .16, 1 + sq * .3);

  // --- cuff (drawn first, sits behind everything) ---
  const cuffW = R * 1.15, cuffH = size * .6;
  ctx.beginPath();
  ctx.roundRect(-cuffW / 2, R * .62, cuffW, cuffH, cuffW * .35);
  ctx.fillStyle = CUFF; ctx.fill();
  ctx.lineWidth = Math.max(2.5, size * .055); ctx.strokeStyle = INK; ctx.stroke();
  // lace ticks across the cuff
  ctx.lineWidth = Math.max(1.6, size * .035);
  for (const lx of [-.28, 0, .28]) {
    ctx.beginPath();
    ctx.moveTo(lx * cuffW, R * .72); ctx.lineTo(lx * cuffW, R * .72 + cuffH * .62);
    ctx.strokeStyle = LACE; ctx.stroke();
  }

  // --- thumb: smaller circle hugging the inner side ---
  ctx.beginPath();
  ctx.arc(thumbSide * R * .78, -R * .1, R * .46, 0, 7);
  ctx.fillStyle = RED_D; ctx.fill();
  ctx.lineWidth = Math.max(2.5, size * .05); ctx.strokeStyle = INK; ctx.stroke();

  // --- main mitt: one big fat circle ---
  ctx.beginPath();
  ctx.arc(0, -R * .35, R, 0, 7);
  ctx.fillStyle = RED; ctx.fill();
  ctx.lineWidth = inkW; ctx.strokeStyle = INK; ctx.stroke();

  // seam ring inside the lobe (glove panel line)
  ctx.beginPath();
  ctx.arc(0, -R * .35, R * .62, Math.PI * .15, Math.PI * .85);
  ctx.strokeStyle = RED_D; ctx.lineWidth = Math.max(1.8, size * .032); ctx.stroke();

  // sheen arc across the upper knuckle
  ctx.beginPath();
  ctx.arc(-R * .18, -R * .52, R * .5, Math.PI * 1.08, Math.PI * 1.62);
  ctx.strokeStyle = SHINE; ctx.lineWidth = Math.max(2.5, size * .05);
  ctx.lineCap = 'round'; ctx.stroke();

  ctx.restore();
}
