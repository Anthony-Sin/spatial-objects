# Mock 11 — PRIME TIME (main-event arena, inside the ring)

Seconds before the bell: three warm spots converge on the ring,
the packed upper bowl keeps moving, sweat hangs in the beam.
Mood: hot, gold, electric — the classic big-fight feeling.

## Layer stack (back → front)

- **far** — arena bowl `#241a10→#171008`; two `.crowd` rows
  (12 radial head/shoulder silhouettes each, `#120b06`) in the
  upper band, `crowdBob` 2.6s / 2.1s opposing.
- **mid** — 3 `.beam` cones `conic-gradient rgba(255,196,100,.16)`,
  `blur(9px)`, `beamBreathe` staggered; corner `.post`s (L/R, dark
  `#4a3020` + `#8a3a2e` turnbuckle pads); `.canvas` deck
  `#d8cba8→#b8a87e` + 2px grain crosshatch + faint logo ellipse.
- **light** — key pool `radial(60% 42% @ 50% 34%, rgba(255,196,100,
  .24))` + canvas bounce.
- **fx** — `.mist` sweat haze (`blur(6px)`, `mistDrift` 40s);
  `.sweat` droplet specks rising `sweatRise` 30s.
- **near** — 3 front `.rope`s (coral `#FF6B57` / cream / sky
  `#5DA9E9`, `ropeHum` 1.4–2.3s staggered) + 6 side `.rsl`/`.rsr`
  ropes converging to the corners (`ropeHumT`, rotate preserved in
  the keyframe via `--ra`) + `radial(115% 92%)` vignette `.72`.

## Selection spotlight (all wave-3 mocks)
`.grid:has(.cell.sel)` dims non-selected cells (opacity .58 +
desaturate); `.cell.sel` gets a gold ring + 80px glow +
lift/scale; `::after` adds a top-center light cone
(`mix-blend-mode:screen`). Theme-tintable via `--sgold/--sglow/
--scone`.

## Palette
`#1a120c` dark · `#ffc464` key · `#FF6B57`/`#FFF3DD`/`#5DA9E9`
ropes · `#d8cba8` canvas · `#f4e4c0` text.

## Export notes
Side ropes = rotated full-width bars, transform-origin at the
frame edge — port as a 3-line sprite mirrored per side. Crowd =
one row of 12 head stamps, duplicate + offset for depth.
Skin tones: protoBoxer `palette` override (see mock 06).
