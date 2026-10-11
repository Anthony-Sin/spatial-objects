# Mock 16 — BANDAGE BOARD (medical-tent lineup, corkboard's cousin)

Same "pinned-up rivals" idea as mock 04, but the board is gauze
and tape: blood-type rubber stamps, castoff speckle, an EKG trace
still ticking across the top. Mood: paper-bright, post-fight
clinic.

## Layer stack (back → front)

- **far** — gauze weave: two 1px crosshatch grain layers +
  a 45° bias layer over `#f2e8d2→#e6d8ba` bandage cream.
- **mid** — `.ekg` SVG polyline heartbeat trace (`#c33f33`, 3px,
  flatline→spike rhythm repeated); 3 `.stamp` blood-type rounds —
  `A−`, `O+`, `AB+`, double-ringed `rgba(160,40,32,.55)`, rotated
  −11°/8°/−6°; 4 `.tape` gauze strips at the corners
  (alternating 4px weave bands, rotated ±30–38°).
- **light** — soft paper light `radial(70% 50% @ 50% 34%,
  rgba(255,252,240,.5))`.
- **fx** — `.speck` blood castoff: 3 sparse dot fields
  `rgba(150,35,28,.28–.40)` at different tile sizes + a denser
  cluster patch lower-left.
- **near** — warm vignette `rgba(120,80,50,.30)` — paper-grade.

## Selection spotlight
Tinted clinical red (`--sgold:#c33f33`, pale-cream cone) — the
picked rival reads as "next patient up."

## Palette
`#f0e6d0` gauze · `#c33f33`/`#a02820` blood red · `#33261a` ink ·
tape `#dccdb0`/`#c8b998`.

## Export notes
The EKG is an inline SVG polyline — keep it vector at any size.
Stamps want slight rotation + a double ring to read as inked, not
drawn. Light theme: page text stays default `--ink`. Skin tones:
protoBoxer `palette` override (see mock 06).
