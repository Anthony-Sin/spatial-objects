# 04 — Tracker HUD

vibe: precise ink instrument

tagline: Stop showing the player a mirror; show them the tracking.

what changes:
- **The camera image is demoted.** No frame, no border, no rounded box — just a
  feathered, de-saturated 56px cutout of the head, masked with a radial
  gradient so it dissolves into the HUD instead of punching a window in it.
  The 478-pt mesh and the coral nose dot ride on top of the cutout, unchanged.
- **That cutout *is* the readout.** It sits inside a 120×90 framing field (the
  camera's 4:3 view) and translates to wherever the head actually is in frame:
  corner ticks, a centre crosshair stub, a dashed safe zone, and four edge bars
  that light amber on the side you are drifting toward. "Head near the edge"
  finally has a picture.
- **Two instruments in the reclaimed space.** `LOCK` — five ticks of tracking
  quality. `LEAN` — a centre-notched axis with a slug that slides with your
  yaw, i.e. a direct echo of the input the game reads for slips.
- **Loudness is a function of health.** Locked sits at 0.62 opacity in
  paper-hairline-over-ink-shadow, no colour at all. Drift goes to full opacity,
  amber, with a `RECENTER` chip. Lost scales the whole thing to 1.14, flips to
  coral, kills the crosshair and the safe zone, fades the face to 10%, runs a
  coral sweep line down the empty field and shouts **FACE LOST / STEP INTO
  FRAME** with a blinking tag. Mouse mode collapses to a single 118px pill.
- Footprint drops from 238×178 to **228×96** — it is roughly half the pixels,
  and it never gets taller than the bout card is tall.

why it's better:
- The three things the player needs mid-fight — *can it see me*, *am I in
  frame*, *which way am I leaning* — each get a dedicated, glanceable channel,
  instead of being inferred from a tiny video thumbnail.
- Head-off-centre is communicated *before* it becomes tracking loss. Today the
  peep goes from fine to `face · lost` with no warning; here the field warns in
  amber for the second or two while you can still fix it.
- Tracking loss escalates on three axes at once (size, colour, motion) in the
  player's peripheral vision, which is where the peep lives. You cannot look at
  PIP and miss it.
- When everything is fine it is near-invisible, so it costs no attention it
  hasn't earned — the explicit opposite of a decorative frame.

risks:
- It gives up the mirror. "Seeing yourself slip a punch" is genuinely fun and a
  50px desaturated ghost does not deliver it; if playtest says the mirror is
  the point, this is the wrong direction.
- Mostly-greyscale and mostly-hairline is the quietest thing on a loud cartoon
  screen. It needs the ink drop-shadow on every stroke to survive the bright
  ring floor (done here), and it will still read as the most "UI" element in
  the game — restraint can look unfinished next to the thick-ink cards.

port:
`.peep` becomes a 228px flex row (`.field` + `.readout`) instead of a bordered
box: drop the border/radius/box-shadow on `.peep` itself, move them onto
`.field`, and wrap the `<video>` in a `.head > .cut` pair so the mask and the
grayscale filter sit on static nodes while only `.head` gets a per-frame
`transform` (no filter re-raster, no layout reads). New DOM: `.field` with its
`.safe`, four `.cnr`, four `.edge`, `.sweep` and `.alert` children, plus
`.readout` with the five `.bars u`, the `.axis > .slug`, `.warn`, and a
`.mouse` pill; the existing `[data-nose]` canvas just moves inside `.cut` and
shrinks to 56×56. `noseDot()` needs no new drawing — same dot cloud, same coral
nose, just a smaller cached `ncW/ncH`; add ~6 lines in the loop that write
`head.style.transform` / `slug.style.transform` from `fs.nose.x/y` and the yaw
the dodge logic already computes, and set `data-state` / `data-q` / `data-ex` /
`data-ey` on `.peep` only when those discrete values change. Everything else
(escalation, colour, the sweep) is pure CSS off `data-state`, and `mouse mode`
stops hiding the peep outright — it shows the collapsed pill instead.
