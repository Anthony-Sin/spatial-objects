# Mock 07 — BIG TOP (1890s traveling carnival boxing booth)

Canvas tent at dusk: "beat the champ, win a dollar." Festoon bulbs,
pennant bunting, striped corner posts, sawdust ring floor.
Mood: festive, dusk-purple, midway electricity.

## Layer stack (back → front)

- **far** — tent roof = `repeating-conic-gradient(from 0deg @ 50% -38%)`
  red `#b23b32`/cream `#f2d8a8` stripes converging at the peak +
  dusk body `#453050→#2e2140`; edge vignette pseudo.
- **mid** — 12 pennant flags (`clip-path:polygon` triangles,
  alternating red/cream/blue on a line at top 9%); 8 festoon bulbs
  (`.fb` glowing orbs at sagging heights 16–22%); striped
  booth posts L/R (`repeating-linear-gradient` red/cream 34px).
- **light** — festoon wash `radial(60% 42% @ 50% 30%,
  rgba(255,206,110,.22))` + floor-weighted dusk falloff.
- **fx** — sawdust motes drifting (`dustDrift` 30s diagonal);
  firefly field (3 radial-dot planes, `firefly` 7s opacity).
- **near** — sawdust floor `linear-gradient` band `#5a4a30` @78% +
  plank seams + `radial(115% 95%)` tent-edge vignette `.66`.

## Motion cues
pennant flutter ±4–6° 3.6–4.4s staggered, bulb twinkle 3.4s
staggered via `--d`, dust drift, firefly pulse.

## Palette
`#3a2c44`/`#2e2140` dusk · `#b23b32` canvas red · `#e8b74a` festoon
gold · `#5a4a30` sawdust · `#fdf0d0` text.

## Export notes
Conic stripes → sprite: bake as a single repeating wedge texture
anchored at top-center. Festoon string = individual orb sprites on
a catenary; twinkle = per-bulb opacity offset. Skin-tone variants:
protoBoxer `palette` override — see mock 06 notes.
