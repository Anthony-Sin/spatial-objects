/* A small, tracker-independent map from hand signs to entrance poses. */
export function entranceSign(handsState) {
  const hands = handsState?.hands;
  let palm = 0, fist = 0, point = 0, victory = false;
  if (Array.isArray(hands)) for (const h of hands) {
    if (!h) continue;
    if (h.kind === 'palm') palm++;
    else if (h.kind === 'fist') fist++;
    else if (h.kind === 'point') point++;
    else if (h.kind === 'other' && h.nExt === 2) victory = true;
  }
  if (palm >= 2) return 'hype';
  if (fist >= 2) return 'ready';
  if (point) return 'point';
  if (victory) return 'victory';
  if (palm) return 'wave';
  return 'idle';
}
