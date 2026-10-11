# Mock 15 — PRISON YARD (floodlight bout)

A yard bout under a guard-tower beam: the crowd is behind the
chain-link, the light is hard and white, shadows run long.
Mood: stark, tense, monochrome-cold — the heaviest of the set.

## Layer stack (back → front)

- **far** — wall `#1a2028→#10141a`; `.tower` guard silhouette
  (cab + 2 legs + catwalk, all `linear-gradient` slabs) with a
  flood orb `#f0f4fa` `box-shadow` halo; 2 crowd rows `#0a0d12`;
  `.fence` chain-link mesh (2 `repeating-linear-gradient` diamond
  fields ±45°, alpha .14) across the crowd band.
- **mid** — `.flood` angled white cone `conic-gradient(from -15deg
  @ 78% 0%)` `blur(7px)` `floodBuzz` 5s + `.floodEdge` harder
  inner cone `blur(2px)`; posts `#22262e` + steel pads `#3d434e`;
  canvas `#9aa0a8→#6e747c` + `.shadow` — a long skewed
  `linear-gradient` hard shadow across the deck.
- **light** — cold pool `radial(50% 36% @ 60% 34%,
  rgba(235,242,255,.18))`, off-center to match the tower.
- **fx** — mist + sweat specks `rgba(210,225,245,.5)`.
- **near** — ropes steel `#8a9098`/silver `#c8ccd2`/dark `#565c66`;
  vignette `.82` — heaviest falloff in the set.

## Selection spotlight
Tinted white (`--sgold:#eef3fa`) — reads as the tower light
finding you.

## Palette
`#12161c` night · `#ebf2ff` flood · `#96a5b9` fence · `#9aa0a8`
canvas · `#dde4ea` text.

## Export notes
Fence = a single diamond-mesh tile; keep it over the crowd only.
The canvas shadow is a skewed gradient — port as one quad.
Flood buzz is a subtle 2-frame dip — don't overdo it. Skin tones:
protoBoxer `palette` override (see mock 06).
