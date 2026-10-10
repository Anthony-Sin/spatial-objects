/* shared/boxing/mitts/block.js — 'Blockhead' mitt renderer.
   One solid boxing mitt: a chunky squared lobe with fat rounded corners —
   a big flat face panel floating on a darker edge band, a tiny thumb nub
   tucked on the inner side, and a wide paper cuff carrying a sun badge.
   Fixed silhouette, no fingers, ever.
     draw(ctx, pos, o)
       pos = {x, y, size, ang}  mitt center in canvas px, ang 0 = upright
       o   = {side, reach, squash, dim, kind} */

export const ID = 'block';
export const NAME = 'Blockhead';

const RED = '#e0341f', RED_D = '#b3261a', PAPER = '#fff8ec',
  INK = '#2b2118', SUN = '#ffc53d', SHINE = 'rgba(255,248,236,.8)';
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
  const R = s * .8;
  const th = o.side === 'right' ? -1 : 1;          // thumb rides the inner edge
  const ink = Math.max(2.5, s * .055);
  // flavor lean: hooks roll the knuckles in, uppercuts tip them up
  const lean = o.kind === 'hook' ? -th * .14 : o.kind === 'uppercut' ? th * .06 : 0;

  ctx.save();
  ctx.translate(pos.x, pos.y);
  ctx.rotate((pos.ang || 0) + lean);
  ctx.globalAlpha = Math.max(0, Math.min(1, o.dim ?? 1));

  // punch smear: stretch along the thrust line, pinch the width
  ctx.translate(0, -R * .28 * sq);
  ctx.scale(1 - sq * .15, 1 + sq * .3);

  // ---- cuff: wide paper band behind the lobe ----
  ctx.beginPath();
  rpath(ctx, -R * .88, R * .5, R * 1.76, R * .8, R * .32);
  ctx.fillStyle = PAPER; ctx.fill();
  ctx.lineWidth = ink; ctx.strokeStyle = INK; ctx.stroke();

  // signature: little tilted sun badge stitched on the cuff
  ctx.save();
  ctx.translate(0, R * .9); ctx.rotate(-.14);
  ctx.beginPath();
  rpath(ctx, -R * .17, -R * .17, R * .34, R * .34, R * .08);
  ctx.fillStyle = SUN; ctx.fill();
  ctx.lineWidth = Math.max(1.6, s * .028); ctx.strokeStyle = INK; ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(-R * .08, 0); ctx.lineTo(R * .08, 0);
  ctx.moveTo(0, -R * .08); ctx.lineTo(0, R * .08);
  ctx.lineWidth = Math.max(1.2, s * .018); ctx.strokeStyle = RED_D; ctx.stroke();
  ctx.restore();

  // ---- thumb: tiny nub on the inner edge; the lobe trims its inner line ----
  ctx.beginPath();
  ctx.arc(th * R * .98, -R * .02, R * .32, 0, 7);
  ctx.fillStyle = RED_D; ctx.fill();
  ctx.lineWidth = Math.max(2, s * .04); ctx.strokeStyle = INK; ctx.stroke();

  // ---- lobe: chunky slab — darker edge band, then the flat face panel ----
  ctx.beginPath();
  rpath(ctx, -R * 1.02, -R * 1.52, R * 2.04, R * 2.08, R * .72);
  ctx.fillStyle = RED_D; ctx.fill();
  ctx.lineWidth = ink; ctx.strokeStyle = INK; ctx.stroke();

  ctx.beginPath();
  rpath(ctx, -R * .74, -R * 1.3, R * 1.48, R * 1.58, R * .52);
  ctx.fillStyle = RED; ctx.fill();

  // gentle stitch smile low on the face panel
  ctx.beginPath();
  ctx.moveTo(-R * .55, -R * .16);
  ctx.quadraticCurveTo(0, R * .02, R * .55, -R * .16);
  ctx.lineWidth = Math.max(1.6, s * .026); ctx.strokeStyle = RED_D;
  ctx.lineCap = 'round'; ctx.stroke();

  // sheen — soft crescent on the upper-outer knuckle + a paper glint
  ctx.beginPath();
  const a0 = th > 0 ? Math.PI * 1.05 : Math.PI * 1.35;
  ctx.arc(-th * R * .38, -R * .92, R * .3, a0, a0 + Math.PI * .55);
  ctx.lineWidth = Math.max(2.5, s * .05); ctx.strokeStyle = SHINE; ctx.stroke();
  ctx.beginPath();
  ctx.arc(-th * R * .6, -R * .7, R * .055, 0, 7);
  ctx.fillStyle = SHINE; ctx.fill();

  ctx.restore();
}
