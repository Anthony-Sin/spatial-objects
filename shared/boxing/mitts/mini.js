/* shared/boxing/mitts/mini.js — 'Lil Scrapper' mitt renderer.

   The underdog glove: a compact little round lobe riding on a
   comically OVERSIZED cuff (nearly as big as the lobe itself), a
   tiny thumb nub on the inner side, a stitched hand-me-down patch
   and an extra-thick ink outline. One solid silhouette — NO fingers,
   ever — so tracking jitter can't deform it.

   draw(ctx, pos, o)
     pos — {x, y, size, ang} mitt center in canvas px; ang radians,
           0 = upright, whole mitt rotates about (x,y)
     o   — { side:'left'|'right' (thumb sits on the inner edge),
            reach (1 = rest, >1 = thrust → mitt grows),
            squash 0..1 (punch smear: stretch along ang, squash width),
            dim 0..1 (lost-tracking fade → globalAlpha), kind }
*/
const RED = '#e0341f', RED_D = '#b3261a', INK = '#2b2118',
  PAPER = '#fff8ec', SUN = '#ffc53d', SHINE = 'rgba(255,248,236,.85)';

export const ID = 'mini';
export const NAME = 'Lil Scrapper';

export function draw(ctx, pos, o = {}) {
  if (!pos) return;
  const { x, y, ang = 0 } = pos;
  const reach = Math.max(0, Math.min(2.4, o.reach ?? 1));
  const size = pos.size * (0.55 + 0.45 * Math.min(reach, 1.8));  // thrust grows the mitt
  const dim = Math.max(0, Math.min(1, o.dim ?? 1));
  const sq = Math.max(0, Math.min(1, o.squash ?? 0));            // 0..1 punch smear
  const R = size * .6;                       // compact little lobe
  const thumbSide = o.side === 'right' ? -1 : 1;                 // inner edge
  const inkW = Math.max(4.5, size * .11);    // extra-thick scrapper ink

  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(ang);
  ctx.globalAlpha = dim;
  ctx.lineJoin = ctx.lineCap = 'round';

  // punch smear: stretch along the thrust axis, squash the width
  ctx.translate(0, -R * .28 * sq);
  ctx.scale(1 - sq * .15, 1 + sq * .3);

  // --- comically oversized cuff: nearly as big as the lobe ---
  const cuffW = R * 1.55, cuffH = R * 1.25, cuffY = R * .5;
  ctx.beginPath();
  ctx.roundRect(-cuffW / 2, cuffY, cuffW, cuffH, cuffH * .3);
  ctx.fillStyle = PAPER; ctx.fill();
  ctx.lineWidth = inkW * .85; ctx.strokeStyle = INK; ctx.stroke();
  // lucky sun stripe across the giant cuff
  ctx.beginPath();
  ctx.roundRect(-cuffW / 2 + inkW * .6, cuffY + cuffH * .5,
                cuffW - inkW * 1.2, cuffH * .26, cuffH * .13);
  ctx.fillStyle = SUN; ctx.fill();
  ctx.lineWidth = Math.max(1.8, size * .035); ctx.strokeStyle = INK; ctx.stroke();

  // --- tiny thumb nub on the inner edge ---
  ctx.beginPath();
  ctx.arc(thumbSide * R * .82, -R * .05, R * .32, 0, 7);
  ctx.fillStyle = RED_D; ctx.fill();
  ctx.lineWidth = inkW * .7; ctx.strokeStyle = INK; ctx.stroke();

  // --- the compact lobe: small, dense, mean ---
  ctx.beginPath();
  ctx.arc(0, -R * .4, R, 0, 7);
  ctx.fillStyle = RED; ctx.fill();
  ctx.lineWidth = inkW; ctx.strokeStyle = INK; ctx.stroke();

  // signature: stitched hand-me-down patch low on the lobe
  ctx.save();
  ctx.translate(-R * .3, R * .05); ctx.rotate(-.22);
  const pw = R * .52, ph = R * .36;
  ctx.beginPath(); ctx.roundRect(-pw / 2, -ph / 2, pw, ph, ph * .35);
  ctx.fillStyle = PAPER; ctx.fill();
  ctx.lineWidth = Math.max(1.6, size * .03); ctx.strokeStyle = INK; ctx.stroke();
  ctx.beginPath();                                    // cross stitches
  ctx.moveTo(-pw * .24, -ph * .2); ctx.lineTo(pw * .24, ph * .2);
  ctx.moveTo(pw * .24, -ph * .2); ctx.lineTo(-pw * .24, ph * .2);
  ctx.stroke();
  ctx.restore();

  // scrappy sheen: short bright arc over the knuckle + a spark dot
  ctx.beginPath();
  ctx.arc(-R * .14, -R * .58, R * .46, Math.PI * 1.08, Math.PI * 1.6);
  ctx.strokeStyle = SHINE; ctx.lineWidth = Math.max(2.5, size * .05);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(R * .3, -R * .95, R * .07, 0, 7);
  ctx.fillStyle = SHINE; ctx.fill();

  ctx.restore();
}
