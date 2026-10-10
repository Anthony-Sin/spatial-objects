/* shared/boxing/mitts/quilt.js — 'Quilter' mitt renderer.

   A classic boxing-glove silhouette with a quilted lobe: criss-cross
   diagonal stitch dashes clipped inside the padded dome, a plump thumb
   bulge on the inner side, and a cream cuff done up with red X laces.
   One solid silhouette — NO fingers, ever.

   draw(ctx, pos, o)
     pos — {x, y, size, ang} mitt center in canvas px; ang radians,
           0 = upright, whole mitt rotates about (x,y)
     o   — { side:'left'|'right' (thumb sits on the inner edge),
            reach (1 = rest, >1 = thrust → mitt grows),
            squash 0..1 (punch smear: stretch along ang, squash width),
            dim 0..1 (lost-tracking fade → globalAlpha), kind }
*/
const RED = '#e0341f', RED_D = '#b3261a', INK = '#2b2118',
  PAPER = '#fff8ec', LACE = '#e0341f', STITCH = 'rgba(255,248,236,.6)',
  SHINE = 'rgba(255,248,236,.7)';

export const ID = 'quilt';
export const NAME = 'Quilter';

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
  const inkW = Math.max(3, size * .055);

  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(ang);
  ctx.globalAlpha = dim;

  // punch smear: stretch along the thrust axis, squash the width
  ctx.translate(0, -R * .3 * sq);
  ctx.scale(1 - sq * .16, 1 + sq * .3);

  // --- cream cuff band with red X lacing ---
  const cuffW = R * 1.2, cuffH = size * .55, cuffY = R * .58;
  ctx.beginPath();
  ctx.roundRect(-cuffW / 2, cuffY, cuffW, cuffH, cuffW * .3);
  ctx.fillStyle = PAPER; ctx.fill();
  ctx.lineWidth = Math.max(2.5, size * .05); ctx.strokeStyle = INK; ctx.stroke();
  // laces: a row of X stitches between two faint eyelet lines
  const lacePad = cuffH * .22, laceHalf = cuffW * .1;
  ctx.lineCap = 'round';
  ctx.strokeStyle = 'rgba(43,33,24,.3)'; ctx.lineWidth = Math.max(1.2, size * .022);
  ctx.beginPath();
  ctx.moveTo(-cuffW * .42, cuffY + lacePad);
  ctx.lineTo(cuffW * .42, cuffY + lacePad);
  ctx.moveTo(-cuffW * .42, cuffY + cuffH - lacePad);
  ctx.lineTo(cuffW * .42, cuffY + cuffH - lacePad);
  ctx.stroke();
  ctx.strokeStyle = LACE; ctx.lineWidth = Math.max(1.8, size * .04);
  for (const lx of [-.28, 0, .28]) {
    ctx.beginPath();
    ctx.moveTo(lx * cuffW - laceHalf, cuffY + lacePad);
    ctx.lineTo(lx * cuffW + laceHalf, cuffY + cuffH - lacePad);
    ctx.moveTo(lx * cuffW + laceHalf, cuffY + lacePad);
    ctx.lineTo(lx * cuffW - laceHalf, cuffY + cuffH - lacePad);
    ctx.stroke();
  }

  // --- plump thumb bulge hugging the inner edge ---
  ctx.beginPath();
  ctx.ellipse(thumbSide * R * .78, -R * .08, R * .34, R * .46,
    thumbSide * .25, 0, 7);
  ctx.fillStyle = RED_D; ctx.fill();
  ctx.lineWidth = Math.max(2.5, size * .045); ctx.strokeStyle = INK; ctx.stroke();

  // --- main lobe: classic glove dome, a touch taller than wide ---
  ctx.beginPath();
  ctx.ellipse(0, cy, R, R * 1.04, 0, 0, 7);
  ctx.fillStyle = RED; ctx.fill();
  ctx.lineWidth = inkW; ctx.strokeStyle = INK; ctx.stroke();

  // --- signature: quilted criss-cross stitches, clipped to the lobe ---
  ctx.save();
  ctx.beginPath();
  ctx.ellipse(0, cy, R * .96, R, 0, 0, 7);
  ctx.clip();
  ctx.strokeStyle = STITCH;
  ctx.lineWidth = Math.max(1.5, size * .028);
  ctx.setLineDash([size * .08, size * .07]);
  const step = R * .5, span = R * 2.4;
  ctx.beginPath();
  for (let i = -3; i <= 3; i++) {          // slope +1 family
    ctx.moveTo(i * step - span, cy - span);
    ctx.lineTo(i * step + span, cy + span);
  }
  for (let i = -3; i <= 3; i++) {          // slope -1 family
    ctx.moveTo(i * step - span, cy + span);
    ctx.lineTo(i * step + span, cy - span);
  }
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.restore();

  // panel seam ring around the lobe base
  ctx.beginPath();
  ctx.ellipse(0, cy, R * .66, R * .68, 0, Math.PI * .15, Math.PI * .85);
  ctx.strokeStyle = RED_D; ctx.lineWidth = Math.max(1.6, size * .03);
  ctx.stroke();

  // sheen arc across the upper knuckle
  ctx.beginPath();
  ctx.ellipse(-R * .15, cy - R * .15, R * .5, R * .42, 0,
    Math.PI * 1.1, Math.PI * 1.6);
  ctx.strokeStyle = SHINE; ctx.lineWidth = Math.max(2.5, size * .05);
  ctx.lineCap = 'round'; ctx.stroke();

  ctx.restore();
}
