# Mock 13 — TITLE NIGHT (championship bout)

The belt's on the line: crossing gold and white beams, hanging
banners, confetti already falling, phone lights in the bowl.
Mood: glamorous, biggest-room energy.

## Layer stack (back → front)

- **far** — arena `#161c36→#0e1224`; 3 `.banner` hangings
  (clip-path notched pennants, medallion dots `#f0d68a`); 2 crowd
  rows `#0c0f1c`; 5 `.phone` lights (`#e8f2ff` slivers,
  `phoneBob` staggered).
- **mid** — 4 `.beam`s: gold pair + cool-white pair sweeping
  (`beamSweep` skew ±4°, staggered 3s); posts `#3a3050` + gold
  pads `#c8a03a`; canvas `#e4d9be→#c2b494` + gold logo ring.
- **light** — gold key `radial(56% 40% @ 50% 32%,
  rgba(240,214,138,.22))` + floor spill.
- **fx** — mist + sweat; 9 `.conf` confetti squares
  (`confFall` 9s, `translateY(-4vh→106vh)` + 560° tumble,
  `--c` gold/cream/wine/sky, `--d` staggered); 3 `.flash`
  flashbulbs (`flashPop` 11s).
- **near** — ropes gold `#c8a03a`/cream `#f4ecda`/wine `#7a2e3e`;
  vignette `.70`.

## Selection spotlight
Default gold — matches the title-night beams.

## Palette
`#10152a` navy · `#c8a03a`/`#f0d68a` gold · `#7a2e3e` wine ·
`#5DA9E9` accent · `#f4ecda` text.

## Export notes
Confetti = 9 looping sprites at staggered offsets — the cheapest
"alive" layer; increase density for post-fight. Beams sweep via
skew, not rotation (conic anchor stays put). Skin tones:
protoBoxer `palette` override (see mock 06).
