/* shared/boxing/mitts/puff.js — 'Puffball' mitt renderer.

   A comically round bubble glove: one giant smooth sphere-lobe, an
   oversized cream cuff, a tiny thumb dot on the inner side, almost no
   seams, a thick chunky ink outline and a fat bubbly sheen. One solid
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
  PAPER = '#fff8ec', SHINE = 'rgba(255,248,236,.85)';

export const ID = 'puff';
export const NAME = 'Puffball';

export function draw(ctx, pos, o = {}) {
  if (!pos) return;
  const { x, y, ang = 0 } = pos;
  const reach = Math.max(0, Math.min(2.4, o.reach ?? 1));
  const size = pos.size * (0.55 + 0.45 * Math.min(reach, 1.8));  // thrust grows the mitt
  const dim = Math.max(0, Math.min(1, o.dim ?? 1));
  const sq = Math.max(0, Math.min(1, o.squash ?? 0));            // 0..1 punch smear
  const R = size * .92;                      // the mitt is basically one ball
  const thumbSide = o.side === 'right' ? -1 : 1;                 // inner edge
  const inkW = Math.max(4, size * .09);      // thick chunky outline

  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(ang);
  ctx.globalAlpha = dim;

  // punch smear: stretch along the thrust axis, squash the width
  ctx.translate(0, -R * .28 * sq);
  ctx.scale(1 - sq * .15, 1 + sq * .3);

  // --- oversized cream cuff: a fat pill tucked behind the ball ---
  const cuffW = R * 1.34, cuffH = size * .58, cuffY = R * .55;
  ctx.beginPath();
  ctx.roundRect(-cuffW / 2, cuffY, cuffW, cuffH, cuffH * .45);
  ctx.fillStyle = PAPER; ctx.fill();
  ctx.lineWidth = inkW * .8; ctx.strokeStyle = INK; ctx.stroke();
  // a single soft stitch line — Puffball keeps seams minimal
  ctx.beginPath();
  ctx.moveTo(-cuffW * .38, cuffY + cuffH * .32);
  ctx.lineTo(cuffW * .38, cuffY + cuffH * .32);
  ctx.strokeStyle = 'rgba(43,33,24,.35)';
  ctx.lineWidth = Math.max(1.5, size * .03);
  ctx.lineCap = 'round'; ctx.stroke();

  // --- tiny thumb circle on the inner edge ---
  ctx.beginPath();
  ctx.arc(thumbSide * R * .82, -R * .05, R * .3, 0, 7);
  ctx.fillStyle = RED_D; ctx.fill();
  ctx.lineWidth = inkW * .7; ctx.strokeStyle = INK; ctx.stroke();

  // --- the big bubble lobe ---
  ctx.beginPath();
  ctx.arc(0, -R * .35, R, 0, 7);
  ctx.fillStyle = RED; ctx.fill();
  ctx.lineWidth = inkW; ctx.strokeStyle = INK; ctx.stroke();

  // one tiny seam dash low on the lobe — that's all the stitching it gets
  ctx.beginPath();
  ctx.arc(0, -R * .35, R * .66, Math.PI * .34, Math.PI * .66);
  ctx.strokeStyle = RED_D; ctx.lineWidth = Math.max(1.6, size * .028);
  ctx.stroke();

  // fat bubbly sheen: soft blob upper-left + a little spark dot
  ctx.beginPath();
  ctx.ellipse(-R * .3, -R * .8, R * .3, R * .16, -.55, 0, 7);
  ctx.fillStyle = SHINE; ctx.fill();
  ctx.beginPath();
  ctx.arc(R * .14, -R * .97, R * .075, 0, 7);
  ctx.fillStyle = SHINE; ctx.fill();

  ctx.restore();
}
