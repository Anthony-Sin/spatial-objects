# 03 — fight card

vibe: die-cut collectible card

tagline: the peep becomes the player's own fighter card — and tracking health becomes its print condition.

what changes:
- The peep is re-cut as a die-cut trading card: white sticker bleed with hand-cut
  uneven corners, a 2.5px ink-bordered card inside, a −2.4° tilt and the HUD's
  hard offset shadow, so it reads as part of the same paper deck as the timer,
  the bout card and PIP's nameplate (it sits opposite PIP's plate, same family).
- The live camera is demoted from "the box" to the card's **portrait window** —
  ink-bordered, slightly cropped, multiply-tinted so the feed prints like card
  stock. Over it sits the face-mesh canvas and a crop guide (four corner
  brackets) marking where the head is supposed to sit in the print.
- The old bottom tag strip is promoted to a **condition chip** in a row of stat
  chips (`face · locked` / `rch 71"` / `wt 147`), with the card's condition word
  (`cond MINT` / `OFF-CTR` / `MISPRINT` / `PROOF`) set in Patrick Hand in the
  slug line, a Fredoka ring-name banner (`THE ROOKIE`) and a punched card-number
  badge `03 / of 12` in the corner slot. A holo foil ring shimmers slowly around
  the die-cut edge (one masked element, one 9s background-position keyframe).
- States are **print states**: locked = crisp, in register. drift = the banner
  flips coral→sun, the crop brackets go amber and a sun bar + caret lights the
  window edge the head is sliding off. lost = the card prints off register —
  coral and sky plate outlines slide out from under the card, the portrait
  window goes to blank halftone stock, the ring name splits into coral/cyan
  fringing and a `NO PRINT` overprint stamp lands in the window while the
  condition chip flashes `face · lost`. mouse = an unprinted **proof copy**:
  hatched window, cursor glyph, sky banner, `NO CAMERA · PROOF COPY` stamp —
  the peep stays on screen instead of vanishing.

why it's better:
- Tracking loss is now a *print failure*, not a text change: colour
  misregistration, an empty portrait and a stamp. It's legible in peripheral
  vision from the centre of the screen, which a 8.5px tag never was.
- Head position gets two channels at once — the crop brackets show the safe
  zone the mesh has to stay inside, and the banner (the biggest colour mass on
  the card) changes hue when you drift, so you can read "I'm sliding out of
  frame" without focusing on the peep at all.
- "Mouse mode" stops being an absence. The card is still dealt, just a proof
  copy, so the player understands the camera is off rather than broken.

risks:
- More chrome than the old rectangle: the live photo is ~205×136 vs 238-wide
  full-bleed, so the mirror-yourself pleasure shrinks a little. The crop guide
  and banner earn that back.
- Card-collectible framing is a strong authorial voice; if the rest of the game
  ever moves off paper HUD, this is the first thing that looks dated. The holo
  shimmer also needs to stay slow — it is deliberately 9s and low contrast so it
  never competes with PIP's tells.

port:
`.peep` keeps its fixed bottom-left anchor but loses `overflow:hidden`/`border`
(those move to an inner `.card`); the current `.peep .tag` rule is replaced by
`.chips/.chip.cond`, and the `<video>` rule just moves inside `.win` with the
same `scaleX(-1)`. New DOM inside `.peep`: a `.fc` die-cut wrapper, `.holo`,
two `.reg` plate ghosts, `.card > .slug/.win/.banner/.chips`, the `.crop`
brackets, two `.edge` markers, two `.stamp`s and the `.no` badge — all static
markup, nothing per-frame. `noseDot()` does not need to change its drawing at
all (same dot cloud, same coral nose dot, the canvas just lives in `.win`); the
only new JS is cheap: set `peep.dataset.s` to `locked|drift|lost|mouse` where
the tag text is set today, and compute `drift` from the nose x/y already in hand
(e.g. outside 0.3–0.7 of frame width) plus swapping the chip/condition strings.
