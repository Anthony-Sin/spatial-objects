/* The single house glove used by the boxing overlay.
   The renderer exports {ID, NAME, draw}.
   draw(ctx, pos, o): pos={x,y,size,ang} px; o={side,reach,squash,dim,kind}. */
export const MITT_IDS = ['classic'];

export const pickId = () => 'classic';
export const savePick = () => {};

export async function loadMitt(id = pickId()) {
  try {
    const m = await import(`./${id}.js`);
    if (m?.draw) return m;
  } catch {}
  if (id !== 'classic') return loadMitt('classic');
  return null;
}

export async function loadAllMitts() {
  const out = [];
  for (const id of MITT_IDS) {
    try {
      const m = await import(`./${id}.js`);
      if (m?.draw) out.push(m);
    } catch {}                                     // missing file → skip, don't blank the grid
  }
  return out;
}
