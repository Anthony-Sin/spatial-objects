# Mock 06 — SMOKE HALL (1920s smoker club)

Illegal-era boxing hall: hazy tungsten light, hanging bulbs, a chalk
odds board, bench-row crowd. Mood: warm, conspiratorial, low-ceilinged.

## Layer stack (back → front)

- **far** — wall: two-tone umber gradient (`#2e2014`/`#1c1209`) +
  pilaster stripes (`repeating-linear-gradient`, 140px bays).
- **mid** — chalk odds board (`#22392b` inset, chalk text =
  repeating 2px lines); bench-row heads (10 radial silhouettes,
  `#150d07`); 3 hanging tungsten bulbs on cords at 18/50/82%.
- **light** — key pool `radial-gradient(52% 40% @ 50% 34%,
  rgba(232,163,61,.30))` + hotspot; `lampPulse` opacity .92→1, 9s.
- **fx** — 3 smoke sheets (`blur(6px)` radial blobs, `drift` 34–58s
  alternate directions); dust motes = 2 radial-dot fields
  `moteUp` 38s rise.
- **near** — crowd-of-heads vignette + `radial(120% 95%)` dark
  edge falloff `.78`.

## Motion cues
bulb sway ±1.1° 7s (staggered), tungsten flick 5.5s steps(1),
smoke drift, mote rise, lamp pulse.

## Palette
`#241811` base · `#e8a33d` amber · `rgba(196,176,148,.10)` smoke ·
`#150d07` silhouette · card text `#2B2118` on `--paper`.

## Export notes
All layers are pure CSS in `.env` (fixed, `z-index:0`,
`pointer-events:none`). To port to canvas/sprite art: keep the
DOM order; far/mid/near are full-bleed, fx children are absolutely
positioned elements. Character skin-tone variants render via
protoBoxer `palette:{skin,skinShade,skinLight}` — thumbs are lit in
their own scene so they stay consistent under any backdrop.
