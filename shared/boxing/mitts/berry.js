/* shared/boxing/mitts/berry.js — 'Berry Punch' mitt renderer.

   A fat juicy berry of a glove: big round purple lobe, a plump thumb
   bulge tucked on the inner side, a wide cream cuff cinched by two red
   lace ticks, a wee leaf sprout on the crown and a glossy sheen
   streak — sweet enough to juice. One solid silhouette — NO fingers,
   ever — so tracking jitter can't deform it.

   draw(ctx, pos, o)
     pos — {x, y, size, ang} mitt center in canvas px; ang radians,
           0 = upright, whole mitt rotates about (x,y)
     o   — { side:'left'|'right' (thumb sits on the inner edge),
            reach (1 = rest, >1 = thrust → mitt grows),
            squash 0..1 (punch smear: stretch along ang, squash width),
            dim 0..1 (lost-tracking fade → globalAlpha), kind }
*/
const BERRY = '#b565d8', BERRY_D = '#9450b8', INK = '#2b2118',
  PAPER = '#fff8ec', LACE = '#e0341f', LEAF = '#4fb06d',
  SHINE = 'rgba(255,248,236,.85)', GLOSS = 'rgba(255,248,236,.45)',
  DOT = 'rgba(148,80,184,.4)';

export const ID = 'berry';
export const NAME = 'Berry Punch';

export function draw(ctx, pos, o = {}) {
  if (!pos) return;
  const { x, y, ang = 0 } = pos;
  const reach = Math.max(0, Math.min(2.4, o.reach ?? 1));
  const size = pos.size * (0.55 + 0.45 * Math.min(reach, 1.8));  // thrust grows the mitt
  const dim = Math.max(0, Math.min(1, o.dim ?? 1));
  const sq = Math.max(0, Math.min(1, o.squash ?? 0));            // 0..1 punch smear
  const R = size * .9;                       // big juicy lobe
  const cy = -R * .3;                        // lobe center y
  const thumbSide = o.side === 'right' ? -1 : 1;                 // inner edge
  const inkW = Math.max(3.5, size * .06);

  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(ang);
  ctx.globalAlpha = dim;
  ctx.lineJoin = ctx.lineCap = 'round';

  // punch smear: stretch along the thrust axis, squash the width
  ctx.translate(0, -R * .28 * sq);
  ctx.scale(1 - sq * .15, 1 + sq * .3);

  // --- wide cream cuff cinched by two red lace ticks ---
  const cuffW = R * 1.24, cuffH = size * .5, cuffY = R * .6;
  ctx.beginPath();
  ctx.roundRect(-cuffW / 2, cuffY, cuffW, cuffH, cuffH * .4);
  ctx.fillStyle = PAPER; ctx.fill();
  ctx.lineWidth = inkW * .85; ctx.strokeStyle = INK; ctx.stroke();
  // faint eyelet rail, then two red lace ticks — all the tying it needs
  ctx.beginPath();
  ctx.moveTo(-cuffW * .4, cuffY + cuffH * .5);
  ctx.lineTo(cuffW * .4, cuffY + cuffH * .5);
  ctx.strokeStyle = 'rgba(43,33,24,.3)';
  ctx.lineWidth = Math.max(1.2, size * .022); ctx.stroke();
  ctx.strokeStyle = LACE; ctx.lineWidth = Math.max(2.2, size * .055);
  for (const lx of [-cuffW * .18, cuffW * .18]) {
    ctx.beginPath();
    ctx.moveTo(lx - cuffH * .1, cuffY + cuffH * .78);
    ctx.lineTo(lx + cuffH * .1, cuffY + cuffH * .22);
    ctx.stroke();
  }

  // --- plump thumb bulge hugging the inner edge (tucked under the lobe) ---
  ctx.beginPath();
  ctx.ellipse(thumbSide * R * .78, -R * .04, R * .34, R * .44,
    thumbSide * .2, 0, 7);
  ctx.fillStyle = BERRY_D; ctx.fill();
  ctx.lineWidth = inkW * .8; ctx.strokeStyle = INK; ctx.stroke();

  // --- the big round berry lobe ---
  ctx.beginPath();
  ctx.ellipse(0, cy, R, R * 1.02, 0, 0, 7);
  ctx.fillStyle = BERRY; ctx.fill();
  ctx.lineWidth = inkW; ctx.strokeStyle = INK; ctx.stroke();

  // juicy insides, clipped to the lobe: soft bottom shade + drupelet dots
  ctx.save();
  ctx.beginPath(); ctx.ellipse(0, cy, R * .96, R * .98, 0, 0, 7); ctx.clip();
  ctx.beginPath();
  ctx.ellipse(0, cy, R * .8, R * .82, 0, Math.PI * .3, Math.PI * .7);
  ctx.strokeStyle = 'rgba(148,80,184,.5)'; ctx.lineWidth = R * .24; ctx.stroke();
  ctx.fillStyle = DOT;
  for (const [dx, dy, dr] of [[-.28, .5, .07], [.02, .6, .055], [.3, .44, .065]]) {
    ctx.beginPath(); ctx.arc(dx * R, cy + dy * R, dr * R, 0, 7); ctx.fill();
  }
  ctx.restore();

  // signature sprout: a wee stem + leaf off the crown — it IS a berry
  ctx.beginPath();
  ctx.moveTo(R * .03, -R * 1.2);
  ctx.quadraticCurveTo(R * .12, -R * 1.33, R * .24, -R * 1.36);
  ctx.strokeStyle = INK; ctx.lineWidth = Math.max(1.6, size * .032); ctx.stroke();
  ctx.beginPath();
  ctx.ellipse(R * .32, -R * 1.33, R * .16, R * .07, -.45, 0, 7);
  ctx.fillStyle = LEAF; ctx.fill();
  ctx.lineWidth = Math.max(1.4, size * .028); ctx.strokeStyle = INK; ctx.stroke();

  // glossy sheen: a long juice streak up the knuckle + a spark dot
  ctx.beginPath();
  ctx.ellipse(-R * .32, cy - R * .45, R * .16, R * .44, .5, 0, 7);
  ctx.fillStyle = GLOSS; ctx.fill();
  ctx.beginPath();
  ctx.ellipse(-R * .32, cy - R * .45, R * .07, R * .34, .5, 0, 7);
  ctx.fillStyle = SHINE; ctx.fill();
  ctx.beginPath();
  ctx.arc(R * .3, cy - R * .78, R * .07, 0, 7);
  ctx.fillStyle = SHINE; ctx.fill();

  ctx.restore();
}
