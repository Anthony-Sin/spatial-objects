/* shared/boxing/mitts/lace.js — 'Old School' mitt renderer.
   One solid vintage boxing mitt: a fat round lobe, a big cream front panel
   laced with X-crossed ties down the center (tiny bow up top), a darker
   thumb tucked on the inner side, and a plain paper cuff. Fixed
   silhouette, no fingers, ever.
     draw(ctx, pos, o)
       pos = {x, y, size, ang}  mitt center in canvas px, ang 0 = upright
       o   = {side, reach, squash, dim, kind} */

export const ID = 'lace';
export const NAME = 'Old School';

const RED = '#e0341f', RED_D = '#b3261a', PAPER = '#fff8ec',
  INK = '#2b2118', SHINE = 'rgba(255,248,236,.8)';
const KAPPA = .5523;

// plump rounded-rect path — real circular corners via bezier kappa
const rpath = (c, x, y, w, h, r) => {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  const k = r * KAPPA;
  c.moveTo(x + r, y);
  c.lineTo(x + w - r, y);
  c.bezierCurveTo(x + w - r + k, y, x + w, y + r - k, x + w, y + r);
  c.lineTo(x + w, y + h - r);
  c.bezierCurveTo(x + w, y + h - r + k, x + w - r + k, y + h, x + w - r, y + h);
  c.lineTo(x + r, y + h);
  c.bezierCurveTo(x + r - k, y + h, x, y + h - r + k, x, y + h - r);
  c.lineTo(x, y + r);
  c.bezierCurveTo(x, y + r - k, x + r - k, y, x + r, y);
  c.closePath();
};

export function draw(ctx, pos, o = {}) {
  if (!ctx || !pos) return;
  const reach = Math.max(0, Math.min(2.4, o.reach ?? 1));
  const s = Math.max(8, pos.size || 0) * (.55 + .45 * Math.min(reach, 1.8));
  const sq = Math.max(0, Math.min(1, o.squash ?? 0));
  const R = s * .88;
  const th = o.side === 'right' ? -1 : 1;          // thumb rides the inner edge
  const ink = Math.max(2.5, s * .055);
  // flavor lean: hooks roll the knuckles in, uppercuts tip them up
  const lean = o.kind === 'hook' ? -th * .14 : o.kind === 'uppercut' ? th * .06 : 0;

  ctx.save();
  ctx.translate(pos.x, pos.y);
  ctx.rotate((pos.ang || 0) + lean);
  ctx.globalAlpha = Math.max(0, Math.min(1, o.dim ?? 1));

  // punch smear: stretch along the thrust line, pinch the width
  ctx.translate(0, -R * .26 * sq);
  ctx.scale(1 - sq * .15, 1 + sq * .28);

  // ---- cuff: plain wide paper band behind the lobe ----
  ctx.beginPath();
  rpath(ctx, -R * .68, R * .58, R * 1.36, R * .74, R * .3);
  ctx.fillStyle = PAPER; ctx.fill();
  ctx.lineWidth = ink; ctx.strokeStyle = INK; ctx.stroke();

  // ---- thumb: darker, plump, tucked on the inner edge ----
  ctx.beginPath();
  ctx.arc(th * R * .86, -R * .18, R * .5, 0, 7);
  ctx.fillStyle = RED_D; ctx.fill();
  ctx.lineWidth = Math.max(2, s * .045); ctx.strokeStyle = INK; ctx.stroke();

  // ---- lobe: one fat round pad ----
  ctx.beginPath();
  ctx.arc(0, -R * .4, R, 0, 7);
  ctx.fillStyle = RED; ctx.fill();
  ctx.lineWidth = ink; ctx.strokeStyle = INK; ctx.stroke();

  // wrist shading — darker rim along the lobe's lower third
  ctx.beginPath();
  ctx.arc(0, -R * .4, R * .82, Math.PI * .18, Math.PI * .82);
  ctx.lineWidth = R * .2; ctx.strokeStyle = RED_D; ctx.stroke();

  // ---- signature: big cream lace panel, X-crossed ties down the middle ----
  ctx.beginPath();
  rpath(ctx, -R * .4, -R * 1.24, R * .8, R * 1.52, R * .36);
  ctx.fillStyle = PAPER; ctx.fill();
  ctx.lineWidth = Math.max(1.8, s * .035); ctx.strokeStyle = INK; ctx.stroke();

  const ex = R * .24, ey = -R * 1.0, dy = R * .29;   // eyelet x, first row, pitch
  ctx.strokeStyle = RED; ctx.lineCap = 'round';
  ctx.lineWidth = Math.max(2, s * .042);
  ctx.beginPath();
  for (let i = 0; i < 4; i++) {                       // four X crosses
    ctx.moveTo(-ex, ey + i * dy); ctx.lineTo(ex, ey + (i + 1) * dy);
    ctx.moveTo(ex, ey + i * dy); ctx.lineTo(-ex, ey + (i + 1) * dy);
  }
  // little tied bow curling off the top row
  ctx.moveTo(-ex * .6, ey - R * .02);
  ctx.quadraticCurveTo(-R * .3, ey - R * .22, -R * .4, ey - R * .06);
  ctx.moveTo(ex * .6, ey - R * .02);
  ctx.quadraticCurveTo(R * .3, ey - R * .22, R * .4, ey - R * .06);
  ctx.stroke();
  // eyelets stamp over the lace ends — five rows of ink dots
  ctx.fillStyle = INK;
  for (let i = 0; i < 5; i++)
    for (const sx of [-1, 1]) {
      ctx.beginPath();
      ctx.arc(sx * ex, ey + i * dy, R * .05, 0, 7);
      ctx.fill();
    }

  // sheen — soft crescent on the upper-outer knuckle + a paper glint
  ctx.beginPath();
  const a0 = th > 0 ? Math.PI * 1.05 : Math.PI * 1.35;
  ctx.arc(-th * R * .5, -R * .72, R * .3, a0, a0 + Math.PI * .55);
  ctx.lineWidth = Math.max(2.5, s * .05); ctx.strokeStyle = SHINE; ctx.stroke();
  ctx.beginPath();
  ctx.arc(-th * R * .64, -R * .48, R * .05, 0, 7);
  ctx.fillStyle = SHINE; ctx.fill();

  ctx.restore();
}
