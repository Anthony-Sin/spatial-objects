# Mock 14 — DUSK YARD (rooftop bout at sundown)

An outdoor ring on a city rooftop: purple-orange sky, a skyline of
roof slabs, a sagging string of bare bulbs, embers riding the
heat. Mood: warm dusk, street-level stakes.

## Layer stack (back → front)

- **far** — `.sky` gradient `#2c1e42→#5a3560→#b06048→#33203e` +
  low sun glow `radial(24% 10% @ 38% 44%)`; `.roofs` skyline =
  8 differently-sized `linear-gradient` slabs `#1c1226`; `.fest`
  sagging string light (7 `radial` bulb dots on a rotated wire,
  `drop-shadow` halo, `festTwinkle` 4s); 2 crowd rows `#160f1e`.
- **mid** — posts `#2e2233` + terracotta pads `#8a5a4a`; canvas
  `#b3a28a→#8a7a62` weathered + grain.
- **light** — sundown key `radial(50% 30% @ 50% 46%,
  rgba(255,190,110,.20))` + violet floor shadow.
- **fx** — mist (warm rust haze `rgba(220,160,120,.12)`, 40s); 2 `.ember`
  layers rising `emberRise` 22s/30s — orange specks off the ring.
- **near** — ropes terracotta `#e88a5a`/cream `#f0d8b0`/plum
  `#5a4668`; vignette `.68`.

## Selection spotlight
Tinted warm amber (`--sgold:#ffd98a`).

## Palette
`#33203e`/`#2c1e42` dusk · `#b06048` horizon · `#ffd98a` bulbs ·
`#b3a28a` canvas · `#f6e4ce` text.

## Export notes
Skyline slabs = one strip of irregular rectangles — bake as a
single silhouette sprite. String light = 7 orb sprites on a
catenary line. Embers reuse the mote field, orange + upward.
Skin tones: protoBoxer `palette` override (see mock 06).
