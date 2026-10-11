# Broadcast Corner — CAM 2

vibe: paper broadcast lower-third

tagline: the peep is a ringside camera feed, and tracking health is its signal.

what changes:
- The round window becomes a **hard-edged camera window** between two chunky
  paper/ink bands: a tally rail on top (REC dot, `CAM 2 · CORNER`, ON AIR lamp)
  and a broadcast lower-third beneath (coral colour spine, fighter name +
  record, burned-in timecode in the window corner).
- The status tag is replaced by a **signal read**: five rising bars where a
  broadcast puts audio — 5 green = locked, 2 amber = drifting to the frame
  edge, 0 red = lost — plus a one-line ticker (`TRACKING LOCKED` /
  `NEAR FRAME EDGE` / `SIGNAL LOST` / `MOUSE MODE`).
- Head position is shown as **camera framing**: thirds guides, corner safe-frame
  ticks, and an AF box that rides the nose and flips amber with a pulsing amber
  wash on whichever side you're drifting off.
- Tracking loss is a **broadcast cutaway failure**: the feed desaturates,
  scanlines and a rolling tear bar appear, a coral `SIGNAL LOST / STEP BACK INTO
  FRAME` slug slams across the window, and the tally rail + lamp + spine blink
  red together.
- Mouse mode is no longer hidden — the window shows **paper colour bars** with a
  `NO CAM` slate and the lamp goes dead grey, so "no camera" is a state of the
  same object rather than a missing object.

why it's better:
- Healthy tracking is readable without reading: green bars + green lamp in the
  periphery. You only ever look at the peep when the colour changes.
- Loss is unmissable at the edge of vision — three synchronised red signals
  (rail, lamp, spine) plus a full-width slug and motion, not a 8.5px word.
- The amber frame-edge state is new information the current peep has no way of
  saying; "you are about to leave frame" is the failure that actually happens
  mid-fight, and it now has a warning stage before loss.
- Fighter name/record gives the peep a reason to be a solid block instead of a
  floating rounded rectangle — it belongs to the broadcast, so it reads as HUD
  rather than as a stray browser widget.

risks:
- More chrome than the old peep: the rail + lower-third add ~63px of height
  (total ~232px tall at 248px wide) for status that is nominally always green.
- "CAM 2 / 3–1–0 · 2KO" is fiction; if the game never gives the player a record
  it is set dressing that a sharp player will notice is static.

port: CSS-only plus five small DOM nodes. `.peep` loses its border/radius/
overflow and becomes a plain pointer-events:none stack of `.rail` + `.win`
(the old border + overflow live here) + `.l3`; `.peep .tag` is replaced by the
`.l3` markup (spine, name, `.meter` of five `<i>`, ticker span), and the window
gains static `.thirds`, `.ticks`, `.scan`, `.roll`, `.slug`, `.bars`,
`.offslate` and an `.af` div. The existing `status.textContent = 'face · …'`
calls become a one-line `setPeep(state)` that writes `data-state` on `.peep`
plus the ticker/lamp text and the meter classes — every visual change after
that is pure CSS. `noseDot()` keeps drawing exactly what it draws today (same
mesh dots + coral nose); it only gains two cheap lines: write
`af.style.transform = translate(nose.x*w, nose.y*h)` and set
`peep.dataset.edge = (nose.x < .18 || nose.x > .82 || nose.y < .15 || nose.y > .85) ? '1' : '0'`
— transform writes only, no layout reads, and the mouse-mode branch stops
hiding the peep (`peep.hidden = false` with `data-state="mouse"`). The ≤1050px
query keeps the rail, spine and meter and drops the name row, timecode and slug
subtitle (shown in the mockup's chrome rail).
