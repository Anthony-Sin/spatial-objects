/* shared/boxing/mitts/stripe.js — 'Candy' mitt renderer.

   A peppermint candy-cane glove: bright red lobe wrapped in bold
   diagonal cream stripes that carry clean through the thumb and the
   striped cuff — one continuous sugar wrap — plus a dark ink outline
   and a sweet gloss sheen. One solid silhouette — NO fingers, ever —
   so tracking jitter can't deform it.

   draw(ctx, pos, o)
     pos — {x, y, size, ang} mitt center in canvas px; ang radians,
           0 = upright, whole mitt rotates about (x,y)
     o   — { side:'left'|'right' (thumb sits on the inner edge),
            reach (1 = rest, >1 = thrust → mitt grows),
            squash 0..1 (punch smear: stretch along ang, squash width),
            dim 0..1 (lost-tracking fade → globalAlpha), kind }
*/
const RED = '#e0341f', INK = '#2b2118', PAPER = '#fff8ec',
  SHINE = 'rgba(255,248,236,.85)';

export const ID = 'stripe';
export const NAME = 'Candy';

/* rotated field of fat diagonal bands across a big span — the caller
   clips it to a lobe / thumb / cuff shape, so every piece lines up
   like one continuous candy wrap */
function stripeField(ctx, tilt, pitch, w, span, color) {
  ctx.save();
  ctx.rotate(tilt);
  ctx.fillStyle = color;
  for (let i = -4; i <= 4; i++)                    // fixed band count
    ctx.fillRect(i * pitch - w / 2, -span, w, span * 2);
  ctx.restore();
}

export function draw(ctx, pos, o = {}) {
  if (!pos) return;
  const { x, y, ang = 0 } = pos;
  const reach = Math.max(0, Math.min(2.4, o.reach ?? 1));
  const size = pos.size * (0.55 + 0.45 * Math.min(reach, 1.8));  // thrust grows the mitt
  const dim = Math.max(0, Math.min(1, o.dim ?? 1));
  const sq = Math.max(0, Math.min(1, o.squash ?? 0));            // 0..1 punch smear
  const R = size * .88;
  const cy = -R * .35;                       // lobe center y
  const thumbSide = o.side === 'right' ? -1 : 1;                 // inner edge
  const inkW = Math.max(3.5, size * .06);
  const TILT = -.5, PITCH = R * .6, BAND = R * .32, SPAN = R * 2.4;

  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(ang);
  ctx.globalAlpha = dim;
  ctx.lineJoin = ctx.lineCap = 'round';

  // punch smear: stretch along the thrust axis, squash the width
  ctx.translate(0, -R * .28 * sq);
  ctx.scale(1 - sq * .15, 1 + sq * .3);

  // --- striped cuff: paper band wrapped in matching red diagonals ---
  const cuffW = R * 1.2, cuffH = size * .54, cuffY = R * .6;
  ctx.beginPath();
  ctx.roundRect(-cuffW / 2, cuffY, cuffW, cuffH, cuffH * .4);
  ctx.fillStyle = PAPER; ctx.fill();
  ctx.save(); ctx.clip();
  stripeField(ctx, TILT, PITCH, BAND, SPAN, RED);
  ctx.restore();
  ctx.lineWidth = inkW * .85; ctx.strokeStyle = INK; ctx.stroke();
  // faint stitch line along the cuff base
  ctx.beginPath();
  ctx.moveTo(-cuffW * .4, cuffY + cuffH * .78);
  ctx.lineTo(cuffW * .4, cuffY + cuffH * .78);
  ctx.strokeStyle = 'rgba(43,33,24,.3)';
  ctx.lineWidth = Math.max(1.2, size * .022); ctx.stroke();

  // --- plump thumb bulge on the inner edge — the wrap keeps going ---
  ctx.beginPath();
  ctx.ellipse(thumbSide * R * .78, -R * .06, R * .34, R * .45,
    thumbSide * .22, 0, 7);
  ctx.fillStyle = RED; ctx.fill();
  ctx.save(); ctx.clip();
  stripeField(ctx, TILT, PITCH, BAND, SPAN, PAPER);
  ctx.restore();
  ctx.lineWidth = inkW * .8; ctx.strokeStyle = INK; ctx.stroke();

  // --- the candy lobe: red dome wrapped in cream diagonals ---
  ctx.beginPath();
  ctx.ellipse(0, cy, R, R * 1.02, 0, 0, 7);
  ctx.fillStyle = RED; ctx.fill();
  ctx.save(); ctx.clip();
  stripeField(ctx, TILT, PITCH, BAND, SPAN, PAPER);
  // soft underside shade swept over the wrap
  ctx.beginPath();
  ctx.ellipse(0, cy, R * .8, R * .82, 0, Math.PI * .3, Math.PI * .7);
  ctx.strokeStyle = 'rgba(179,38,26,.45)'; ctx.lineWidth = R * .22; ctx.stroke();
  ctx.restore();
  ctx.beginPath();                       // ink edge goes on last
  ctx.ellipse(0, cy, R, R * 1.02, 0, 0, 7);
  ctx.lineWidth = inkW; ctx.strokeStyle = INK; ctx.stroke();

  // sweet gloss: bright arc over the knuckle + a spark dot
  ctx.beginPath();
  ctx.arc(-R * .05, cy - R * .05, R * .62, Math.PI * 1.12, Math.PI * 1.58);
  ctx.strokeStyle = SHINE;
  ctx.lineWidth = Math.max(2.5, size * .05); ctx.stroke();
  ctx.beginPath();
  ctx.arc(R * .3, cy - R * .75, R * .065, 0, 7);
  ctx.fillStyle = SHINE; ctx.fill();

  ctx.restore();
}
