/* mitts/orb.js — adapter: wraps the classic boxglove.js round mitt
   in the mitt-gallery signature draw(ctx, pos, o). */
import { drawBoxGlove } from '../boxglove.js';

export const ID = 'orb';
export const NAME = 'The Orb';

export function draw(ctx, pos, o = {}) {
  if (!pos) return;
  drawBoxGlove(ctx, null, { ...o, manual: pos });
}
