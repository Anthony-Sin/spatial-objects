/* mitts/index.js — the mitt gallery registry.
   Each design: shared/boxing/mitts/<id>.js exporting {ID, NAME, draw}.
   draw(ctx, pos, o): pos={x,y,size,ang} px; o={side,reach,squash,dim,kind}. */
export const MITT_IDS = [
  'classic', 'orb', 'puff', 'quilt', 'berry', 'stripe',
  'knuckle', 'star', 'block', 'lace', 'mini', 'tiger',
];

export const pickId = () => localStorage['boxing:glove'] || 'classic';
export const savePick = (id) => { localStorage['boxing:glove'] = id; };

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
