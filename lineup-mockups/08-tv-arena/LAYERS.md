# Mock 08 — TV ARENA (1950s golden-age broadcast bout)

Wednesday-night-fights era: one hard key light over the ring,
broadcast camera boom sweeping in, press row with gooseneck lamps,
flashbulbs popping in the dark. Mood: cool, electric, high-stakes.

## Layer stack (back → front)

- **far** — arena bowl: navy gradient (`#0d1020→#1a2036→#10141f`)
  + seat-row scanlines (3px/26px, alpha .028) + two balcony
  ledge lines via stacked `box-shadow`.
- **mid** — key-light cone `conic-gradient(from -16deg @ 50% 0%)`
  `rgba(207,224,255,.20)`, `blur(10px)`, lamp orb at apex; camera
  boom (arm + box camera + red tally `#ff4538`) sweeping from the
  right; press-row desk band + 8 lamp dots `#ffe9b0`.
- **light** — cool wash `radial(48% 34% @ 50% 36%,
  rgba(207,224,255,.16))` + warm crowd spill at the floor line.
- **fx** — cigarette haze sheet (`blur(5px)`, `hazeDrift` 40s
  alternate); 6 `.flash` flashbulbs, `flashPop` 13s, each staggered
  by `--d`.
- **near** — arena-floor warm spill + `radial(115% 95%)` vignette
  `.80` — the strongest darkness of the set.

## Motion cues
cone shimmer (skew ±1.2° 8s), boom sweep ±2.4° 16s, tally blink
2.2s, flashbulb pops, haze drift.

## Palette
`#141826` bowl · `#cfe0ff` key · `#ffcf8a` crowd/lamp warm ·
`#ff4538` tally · `#e8ecf4` text · `rgba(5,7,14,.8)` vignette.

## Export notes
The cone is the hero: bake as a soft-edged cone sprite pinned to
top-center; shimmer = ±1° rotation. Boom = one silhouette sprite on
a slow rotate. Flashes = spawn-able particles, opacity 0→1→0 in
~0.5s at random seats. Skin-tone variants: protoBoxer `palette`
override — see mock 06 notes.
