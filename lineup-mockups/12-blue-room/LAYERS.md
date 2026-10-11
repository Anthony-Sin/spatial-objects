# Mock 12 — BLUE ROOM (underground club ring)

A basement ring under a cold neon wash: one hard blue cone, a
humming sign, thick smoke, the crowd pressed in close.
Mood: cold, humid, illicit.

## Layer stack (back → front)

- **far** — club wall `#0e1a28→#08111c`; 2 crowd rows `#050b12`
  bobbing; `.sign` — neon bar `#37b6c9` top-right, `signHum`
  flicker 5s.
- **mid** — single `.beam` cone `rgba(150,215,240,.20)` 6s
  breathe; posts `#16222e` + teal pads `#0f4a56`; canvas
  `#8fa6ad→#5d7076` (wet slate) + grain.
- **light** — cold key `radial(52% 40% @ 50% 32%,
  rgba(150,215,240,.20))` + cyan floor spill.
- **fx** — TWO mist sheets (`.mist` + `.m2`, 30s/52s opposing —
  the smokiest of the set); sweat specks `rgba(170,220,240,.5)`.
- **near** — ropes cyan `#37b6c9`/ice `#e8f2f4`/navy `#123a52`,
  front 3 + converging side 6; vignette `.78`.

## Selection spotlight
Tinted cyan (`--sgold:#37b6c9`, `--sglow`, `--scone` overridden on
`.cell.sel`).

## Palette
`#0a1420` base · `#37b6c9` neon · `#96d7f0` beam · slate canvas ·
`#d8ecf2` text.

## Export notes
The sign is one rounded bar + double box-shadow halo; port as a
small emissive sprite. Keep mist layers at different durations —
matching loops read as one fog bank. Skin tones: protoBoxer
`palette` override (see mock 06).
