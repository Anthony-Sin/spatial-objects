/* shared/boxing/mitts/tiger.js — 'Tiger Paw' mitt renderer.

   A big cat paw of a glove: fat red lobe raked by three dark
   claw-stripe slashes, a chunky thumb bulge on the inner side, a
   plain paper cuff and a hard aggressive sheen. One solid
   silhouette — NO fingers, ever — so tracking jitter can't deform it.

   draw(ctx, pos, o)
     pos — {x, y, size, ang} mitt center in canvas px; ang radians,
           0 = upright, whole mitt rotates about (x,y)
     o   — { side:'left'|'right' (thumb sits on the inner edge),
            reach (1 = rest, >1 = thrust → mitt grows),
            squash 0..1 (punch smear: stretch along ang, squash width),
            dim 0..1 (lost-tracking fade → globalAlpha), kind }
*/
const RED = '#e0341f', RED_D = '#b3261a', INK = '#2b2118',
  PAPER = '#fff8ec', SHINE = 'rgba(255,248,236,.9)';

export const ID = 'tiger';
export const NAME = 'Tiger Paw';

/* one tapered claw gash: wide at the base, pointed at the tip, bowed */
function claw(ctx, bx, by, tx, ty, w) {
  const dx = tx - bx, dy = ty - by, L = Math.hypot(dx, dy) || 1;
  const px = -dy / L, py = dx / L;                       // unit perpendicular
  const cx = (bx + tx) / 2 + px * L * .18,               // bowed control point
        cy = (by + ty) / 2 + py * L * .18;
  ctx.beginPath();
  ctx.moveTo(bx + px * w, by + py * w);
  ctx.quadraticCurveTo(cx + px * w * .3, cy + py * w * .3, tx, ty);
  ctx.quadraticCurveTo(cx - px * w * .3, cy - py * w * .3, bx - px * w, by - py * w);
  ctx.closePath();
  ctx.fill();
}

export function draw(ctx, pos, o = {}) {
  if (!pos) return;
  const { x, y, ang = 0 } = pos;
  const reach = Math.max(0, Math.min(2.4, o.reach ?? 1));
  const size = pos.size * (0.55 + 0.45 * Math.min(reach, 1.8));  // thrust grows the mitt
  const dim = Math.max(0, Math.min(1, o.dim ?? 1));
  const sq = Math.max(0, Math.min(1, o.squash ?? 0));            // 0..1 punch smear
  const R = size * .85;                      // big paw lobe
  const thumbSide = o.side === 'right' ? -1 : 1;                 // inner edge
  const inkW = Math.max(3.5, size * .065);

  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(ang);
  ctx.globalAlpha = dim;
  ctx.lineJoin = ctx.lineCap = 'round';

  // punch smear: stretch along the thrust axis, squash the width
  ctx.translate(0, -R * .28 * sq);
  ctx.scale(1 - sq * .15, 1 + sq * .3);

  // --- plain paper cuff: wide, clean, no laces ---
  const cuffW = R * 1.12, cuffH = size * .6, cuffY = R * .55;
  ctx.beginPath();
  ctx.roundRect(-cuffW / 2, cuffY, cuffW, cuffH, cuffH * .4);
  ctx.fillStyle = PAPER; ctx.fill();
  ctx.lineWidth = inkW; ctx.strokeStyle = INK; ctx.stroke();

  // --- chunky paw thumb on the inner edge ---
  ctx.beginPath();
  ctx.arc(thumbSide * R * .82, -R * .05, R * .48, 0, 7);
  ctx.fillStyle = RED_D; ctx.fill();
  ctx.lineWidth = inkW * .8; ctx.strokeStyle = INK; ctx.stroke();

  // --- the big paw lobe ---
  ctx.beginPath();
  ctx.arc(0, -R * .35, R, 0, 7);
  ctx.fillStyle = RED; ctx.fill();
  ctx.lineWidth = inkW; ctx.strokeStyle = INK; ctx.stroke();

  // signature: three dark claw slashes raked across the lobe
  ctx.save();
  ctx.beginPath(); ctx.arc(0, -R * .35, R * .97, 0, 7); ctx.clip();
  ctx.fillStyle = INK;
  claw(ctx, -R * .6, -R * 1.0, R * .1, -R * .3, R * .09);
  claw(ctx, -R * .68, -R * .6, R * .3, R * .05, R * .1);
  claw(ctx, -R * .55, -R * .18, R * .15, R * .45, R * .085);
  // dark shading sweep along the bottom of the lobe
  ctx.beginPath();
  ctx.arc(0, -R * .35, R * .8, Math.PI * .3, Math.PI * .7);
  ctx.strokeStyle = 'rgba(179,38,26,.55)';
  ctx.lineWidth = R * .22; ctx.stroke();
  ctx.restore();

  // aggressive sheen: hard arc high on the lobe + a sharp glint fang
  ctx.beginPath();
  ctx.arc(-R * .08, -R * .5, R * .6, Math.PI * 1.05, Math.PI * 1.5);
  ctx.strokeStyle = SHINE; ctx.lineWidth = Math.max(3, size * .055);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(R * .3, -R * 1.12); ctx.lineTo(R * .56, -R * .8);
  ctx.lineWidth = Math.max(2, size * .035); ctx.stroke();

  ctx.restore();
}
