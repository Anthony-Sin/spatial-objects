# Mock 10 — DOCK FIGHT (1890s bareknuckle wharf, rainy midnight)

Clandestine bout on the docks: warehouse brick, ship masts in fog,
two dock lamps, driving rain, wet plank deck. Mood: cold, tense,
pre-Queensberry outlaw.

## Layer stack (back → front)

- **far** — night sky `#0d1420` + brick band `#182230` (mortar =
  repeating 3px/15px + 2px/46px grids); 3 ship masts with yardarms
  (`linear-gradient` fade + crossbar pseudo, `blur(.6px)`).
- **mid** — crate stack silhouette left (4 box gradients,
  `drop-shadow`); stave barrel right (repeating bands, ellipse
  radius); 2 `.lamp` lanterns `#ffd98a→#ffb45e` with halo
  `box-shadow` + 2 wide `.glow` pools.
- **light** — twin lamp pools `radial(26% 20% @ 26%/76%)` +
  cold moon rim `rgba(150,190,235,.10)` from the harbor.
- **fx** — RAIN: 3 slanted streak layers (77°, alpha .30/.18/.28,
  tile 220/300/460px) `rainFall` .9s infinite; fog sheet
  (`blur(7px)`, `fogDrift` 36s); pooled lamp reflections on the
  deck (`::after`, `lampFlick` sync).
- **near** — wet plank deck `#0c1218` @72% + plank seams + sheen
  + `radial(118% 92%)` vignette `.82` — heaviest of the set.

## Motion cues
rain .9s loop (3 depths), fog drift 36s, lamp flick 4.6s with
deck reflections synced to the same keyframe.

## Palette
`#10181f`/`#0d1420` night · `#182230` brick · `#ffb45e`/`#ffd98a`
lamp · `rgba(160,190,230)` rain/fog · `#d8e4ee` text.

## Export notes
Rain = 3 tiling streak textures at different scales/speeds — the
cheapest good-looking rain; increase alpha for storm intensity.
Masts should sit behind the brick-band edge. Skin-tone variants:
protoBoxer `palette` override — see mock 06 notes.
