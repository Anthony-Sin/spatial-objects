/* shared/boxing/mitts/knuckle.js — 'Knuckler', the heavy-hitter mitt.

   One solid boxing MITT on a plain 2D canvas: fat padded lobe, thumb
   bulge on the INNER edge (left mitt → right edge, right mitt → left
   edge), wide paper cuff — plus this design's signature: a flat darker
   knuckle panel stitched into the top of the lobe. Fixed silhouette,
   NO fingers ever — tracking only moves / rotates / scales it.

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
  CUFF = '#fff8ec', LACE = '#e0341f', SHINE = 'rgba(255,248,236,.8)',
  THREAD = 'rgba(255,248,236,.75)';
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;

export const ID = 'knuckle';
export const NAME = 'Knuckler';

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

  // ---- wide cuff band (drawn first, sits behind the lobe) ----
  const cuffW = R * 1.32, cuffH = size * .64, cuffY = R * .5;
  ctx.beginPath();
  ctx.roundRect(-cuffW / 2, cuffY, cuffW, cuffH, cuffH * .38);
  ctx.fillStyle = CUFF; ctx.fill();
  ctx.lineWidth = Math.max(2.5, size * .05); ctx.strokeStyle = INK; ctx.stroke();
  // lace ticks across the cuff
  ctx.lineWidth = Math.max(1.5, size * .032); ctx.strokeStyle = LACE;
  for (const lx of [-.26, 0, .26]) {
    ctx.beginPath();
    ctx.moveTo(lx * cuffW, cuffY + cuffH * .2);
    ctx.lineTo(lx * cuffW, cuffY + cuffH * .8);
    ctx.stroke();
  }

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

  // ---- signature: flat stitched knuckle panel near the lobe top ----
  const pw = R * 1.26, ph = R * .52, py = -R * .74;
  ctx.beginPath();
  ctx.roundRect(-pw / 2, py - ph / 2, pw, ph, R * .18);
  ctx.fillStyle = RED_D; ctx.fill();
  ctx.lineWidth = Math.max(2, size * .038); ctx.strokeStyle = INK; ctx.stroke();
  // seam stitching: dashed inset ring + segment ticks
  ctx.beginPath();
  ctx.roundRect(-pw / 2 + R * .1, py - ph / 2 + R * .1,
    pw - R * .2, ph - R * .2, R * .1);
  ctx.setLineDash([R * .11, R * .09]);
  ctx.lineWidth = Math.max(1.3, size * .024); ctx.strokeStyle = THREAD;
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.beginPath();
  for (const tx of [-.18, .18]) {
    ctx.moveTo(tx * pw, py - ph * .24);
    ctx.lineTo(tx * pw, py + ph * .24);
  }
  ctx.lineWidth = Math.max(1.2, size * .022); ctx.strokeStyle = THREAD;
  ctx.stroke();

  // ---- sheen: gloss arc over the lobe's upper-left, kissing the panel ----
  ctx.beginPath();
  ctx.arc(-R * .34, -R * .55, R * .52, Math.PI * 1.12, Math.PI * 1.58);
  ctx.lineCap = 'round'; ctx.strokeStyle = SHINE;
  ctx.lineWidth = Math.max(2.5, size * .05); ctx.stroke();

  ctx.restore();
}
