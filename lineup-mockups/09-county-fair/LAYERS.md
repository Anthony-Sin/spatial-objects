# Mock 09 — COUNTY FAIR (outdoor fairground booth, c.1900 noon)

Bright daylight bout at the county fair: scalloped canvas awning
overhead, pennant strings, hay bales, far tents and a slow Ferris
wheel on the horizon. Mood: sunny, open-air, dusty-golden.

## Layer stack (back → front)

- **far** — noon sky `#a8d8e8→#cfe6ec→#f7ead0→#d9b060`; 4 distant
  tent tops (`conic-gradient` wedges, `#e9d6ac`/`#d8c193`);
  Ferris wheel (rim border + 6-spoke `conic-gradient`, masked to a
  ring, `wheelSpin` 60s) at left 5%.
- **mid** — scalloped awning valance: red/cream stripes over
  radial-dot scallops (`#d64533`/`#fff3dd`), drop-shadow, sway
  ±0.7°; pennant string (12 clip-path triangles, rotated −1.5°);
  3 hay bales (`repeating-linear-gradient` straw, rounded) at the
  corners.
- **light** — noon sun `radial(46% 34% @ 18% -2%, rgba(255,226,140,
  .55))` + warm dirt bounce from below.
- **fx** — two pollen/seed planes, `pollenDrift`/`pollenDrift2`
  24s/34s opposing diagonals.
- **near** — dirt band `rgba(217,176,96,.5)` @82% + seam lines +
  soft sunny vignette `rgba(120,80,30,.30)` — lightest vignette
  of the set.

## Motion cues
wheel spin 60s, awning sway 7s, pennant flutter ±6° 3.6s,
pollen drift.

## Palette
`#a8d8e8` sky · `#fdf0d0`/`#d64533` canvas · `#f2b630`/`#5da9e9`
pennants · `#d9b060` hay/dirt · `#2B2118` text (daylight = ink).

## Export notes
Awning scallops = radial-gradient dots — bake as a trim strip with
alpha edge. Wheel = single ring sprite, slow rotate. This is the
only LIGHT theme of wave 2: text/pill colors stay default ink.
Skin-tone variants: protoBoxer `palette` override — see mock 06.
