/* shared/boxing/mitts/star.js — 'Champ', the champion mitt.

   One solid boxing MITT on a plain 2D canvas, classic silhouette: fat
   padded lobe, thumb bulge on the INNER edge (left mitt → right edge,
   right mitt → left edge), wide paper cuff. Signature: a bold sun-yellow
   star emblem dead center on a dark-red badge, gold-trim title-belt
   cuff. Fixed silhouette, NO fingers ever — tracking only moves it.

     draw(ctx, pos, o)
       pos = {x, y, size, ang}  canvas px; ang radians, 0 = upright
       o   = { side:'left'|'right'   thumb side (inner edge)
               reach                1 = rest, >1 = thrust → grows slightly
               squash 0..1          punch smear: stretch along ang
               dim 0..1             lost-tracking fade → globalAlpha
               kind }               gesture tag (unused)

   Pure ctx calls — no imports, no DOM, no THREE.
*/
const RED = '#e0341f', RED_D = '#b3261a', INK = '#2b2118',
  CUFF = '#fff8ec', SUN = '#ffc53d', SHINE = 'rgba(255,248,236,.8)';
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;

export const ID = 'star';
export const NAME = 'Champ';

/* 5-point star path, one point straight up */
function starPath(ctx, cx, cy, rO, rI) {
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const r = i % 2 ? rI : rO, a = -Math.PI / 2 + i * Math.PI / 5;
    const px = cx + Math.cos(a) * r, py = cy + Math.sin(a) * r;
    i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
  }
  ctx.closePath();
}

export function draw(ctx, pos, o = {}) {
  if (!pos || !(pos.size > 0)) return;
  const reach = clamp(o.reach ?? 1, 0, 2.4);
  const size = pos.size * (.55 + .45 * Math.min(reach, 1.8));  // thrust grows it
  const sq = clamp(o.squash ?? 0, 0, 1);
  const R = size * .85;                         // main lobe radius
  const thumbSide = o.side === 'right' ? -1 : 1;
  const inkW = Math.max(2.5, size * .055);

  ctx.save();
  ctx.translate(pos.x, pos.y);
  ctx.rotate(pos.ang || 0);                     // 0 = upright, faces viewer
  ctx.globalAlpha = clamp(o.dim ?? 1, 0, 1);
  ctx.translate(0, -R * .28 * sq);              // smear forward, cuff lags
  ctx.scale(1 - sq * .18, 1 + sq * .3);         // stretch along the punch
  ctx.lineJoin = 'round';

  // ---- wide cuff band with gold-trim title belt ----
  const cuffW = R * 1.32, cuffH = size * .64, cuffY = R * .5;
  ctx.beginPath();
  ctx.roundRect(-cuffW / 2, cuffY, cuffW, cuffH, cuffH * .38);
  ctx.fillStyle = CUFF; ctx.fill();
  ctx.lineWidth = Math.max(2.5, size * .05); ctx.strokeStyle = INK; ctx.stroke();
  // gold belt stripe across the cuff middle
  const bandH = cuffH * .42;
  ctx.beginPath();
  ctx.roundRect(-cuffW / 2 + R * .1, cuffY + (cuffH - bandH) / 2,
    cuffW - R * .2, bandH, bandH * .42);
  ctx.fillStyle = SUN; ctx.fill();
  ctx.lineWidth = Math.max(1.5, size * .03); ctx.strokeStyle = INK; ctx.stroke();
  // belt medallion
  ctx.beginPath();
  ctx.arc(0, cuffY + cuffH / 2, bandH * .36, 0, 7);
  ctx.fillStyle = SUN; ctx.fill();
  ctx.lineWidth = Math.max(1.5, size * .03); ctx.strokeStyle = INK; ctx.stroke();
  ctx.beginPath();
  ctx.arc(0, cuffY + cuffH / 2, bandH * .14, 0, 7);
  ctx.fillStyle = RED_D; ctx.fill();

  // ---- thumb bulge on the inner edge ----
  ctx.beginPath();
  ctx.arc(thumbSide * R * .82, R * .08, R * .46, 0, 7);
  ctx.fillStyle = RED_D; ctx.fill();
  ctx.lineWidth = Math.max(2.5, size * .05); ctx.strokeStyle = INK; ctx.stroke();

  // ---- main padded lobe: one big fat circle ----
  ctx.beginPath();
  ctx.arc(0, -R * .3, R, 0, 7);
  ctx.fillStyle = RED; ctx.fill();
  ctx.lineWidth = inkW; ctx.strokeStyle = INK; ctx.stroke();

  // padded seam arc across the lower lobe
  ctx.beginPath();
  ctx.arc(0, -R * .3, R * .8, Math.PI * .14, Math.PI * .86);
  ctx.lineWidth = Math.max(1.5, size * .03); ctx.strokeStyle = RED_D; ctx.stroke();

  // ---- signature: champion star emblem dead center ----
  ctx.beginPath();
  ctx.arc(0, -R * .3, R * .7, 0, 7);            // dark-red badge patch
  ctx.fillStyle = RED_D; ctx.fill();
  ctx.lineWidth = Math.max(2, size * .038); ctx.strokeStyle = INK; ctx.stroke();
  starPath(ctx, 0, -R * .3, R * .5, R * .21);   // bold sun star
  ctx.fillStyle = SUN; ctx.fill();
  ctx.lineWidth = Math.max(2, size * .04); ctx.strokeStyle = INK; ctx.stroke();

  // ---- sheen: gloss arc over the lobe's upper-left ----
  ctx.beginPath();
  ctx.arc(-R * .34, -R * .55, R * .52, Math.PI * 1.12, Math.PI * 1.58);
  ctx.lineCap = 'round'; ctx.strokeStyle = SHINE;
  ctx.lineWidth = Math.max(2.5, size * .05); ctx.stroke();

  ctx.restore();
}
