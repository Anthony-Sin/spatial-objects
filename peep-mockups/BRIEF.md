# peep-mockups — brief

Design explorations for **one element only**: the webcam overlay ("the peep")
in `boxing.html` — the little live-camera box bottom-left. Nothing else about
the webcam changes: same camera, same trackers, same face-mesh data. This is a
*presentation* exercise.

## What exists today

```html
<div class="peep">
  <video data-cam muted playsinline></video>
  <canvas data-nose></canvas>
  <div class="tag" data-peep>face · —</div>
</div>
```

```css
.peep { position: fixed; left: 30px; bottom: 30px; z-index: 20; width: 238px;
  border: 2.5px solid var(--ink); border-radius: 16px; overflow: hidden;
  box-shadow: 0 6px 0 rgba(43,33,24,.45), 0 12px 30px rgba(0,0,0,.5); }
.peep video { width: 100%; display: block; transform: scaleX(-1); }
.peep .tag { position: absolute; left: 0; right: 0; bottom: 0; font-size: 8.5px;
  letter-spacing: .18em; text-transform: uppercase; color: var(--paper);
  background: rgba(43,33,24,.7); padding: 4px 8px; }
.peep canvas { position: absolute; inset: 0; width: 100%; height: 100%; }
.peep[hidden] { display: none !important; }
@media (max-width: 1050px) { .peep { left: 14px; bottom: 14px; width: 116px; } }
```

It is a plain rounded rectangle with a dark strip of status text across the
bottom. The `canvas[data-nose]` draws, every frame, a 478-point face-mesh dot
cloud (`rgba(210,235,255,.5)`, 1px dots) plus a 4px coral nose dot. The tag
text is one of: `face · locked`, `face · lost`, `mouse mode`, `loading`.

## What the peep is actually for

It is the player's **tracking confidence monitor**. Mid-fight the player needs
to know, without looking away from PIP, that (a) the camera can still see
them, (b) their head is in frame, (c) which way they are leaning — head dodges
are the whole input scheme. Secondarily it is a mirror: seeing yourself slip a
punch is the fun of the game.

So a better peep is not merely prettier. It should make **tracking health**
and **head position in frame** legible at a glance, and make **tracking loss**
impossible to miss — while taking up no more attention than it earns when
everything is fine.

## Deliverable (per mockup)

`peep-mockups/<NN-slug>/index.html` — one self-contained static page, no build
step, no network fonts beyond the Google Fonts link the other mockups use
(`Fredoka`, `Patrick Hand`, `Nunito`), no JS frameworks. Vanilla JS only.

The page must show the design **in situ**:

- `../_plate.png` as a full-bleed 1280×800 backdrop (a real frame of the
  fight, HUD and all, with the old peep removed). `background-size: cover`.
- Your peep rendered on top of it at its real anchor, at 1:1 scale, exactly as
  it would sit in the running game.
- `../_cam.jpg` stands in for the live `<video>` (use `<img>`, keep
  `transform: scaleX(-1)` — the feed is mirrored).
- A **live** `canvas[data-nose]` — animate a plausible drifting face-mesh dot
  cloud + nose dot with `requestAnimationFrame`, so the thing reads as alive
  in a screenshot-driven review. Keep it cheap.

### Show the states

The peep has to survive all of these. Demonstrate each one — either three
instances side by side, or one instance with a small state switcher in the
corner of the page (clearly marked as mockup chrome, not part of the design):

| state | tag text | meaning |
|---|---|---|
| locked | `face · locked` | tracking healthy, head in frame |
| lost | `face · lost` | camera sees nothing — the player must notice fast |
| mouse | `mouse mode` | no camera at all; today the peep is hidden outright |

Bonus if the design also expresses *head off-centre / near the frame edge*,
which currently nothing communicates.

## Constraints

- Palette: `--paper:#FFF8EC --paper2:#FDF3E3 --ink:#2B2118 --coral:#FF6B57
  --sun:#FFC53D --leaf:#4FB06D --sky:#5DA9E9 --berry:#B565D8`. The game's look
  is thick-ink cartoon paper — chunky 2.5px ink borders, hard offset shadows,
  rounded corners, Fredoka/Patrick Hand. Deviate only on purpose, and say so.
- Footprint: roughly today's 238px wide, bottom-left. You may change shape and
  size, but it must not collide with the bout card (bottom-centre, min 400px
  wide), the timer (top-left), the score (top-right) or the feed pills
  (right). It must not creep toward the centre where PIP is.
- It sits over a bright, busy 3D scene — it needs its own contrast, it cannot
  rely on the backdrop.
- Must work at the small breakpoint too (≤1050px → ~116px wide). Note in your
  write-up how it degrades; showing it is better.
- `pointer-events` must stay off anything the player could snag — the peep is
  not interactive.
- Cheap to run. The game is a realtime 3D fight; a peep that costs frames is a
  worse peep. No heavy filters/blurs per frame, no big per-frame layout reads.

## Also write `<NN-slug>/notes.md`

```
# <display name>
vibe: <2-4 words, e.g. "broadcast lower-third">
tagline: <one short line>
what changes: <2-4 bullets — the actual design moves>
why it's better: <2-3 bullets, tied to tracking legibility>
risks: <1-2 bullets — what this costs or could annoy>
port: <2-3 sentences: what it takes to land in boxing.html — which CSS rules
      change, whether noseDot() in boxing.html needs new drawing, whether any
      new DOM nodes are needed>
```

## Hard rules

- Touch **only** your own `peep-mockups/<NN-slug>/` directory. Do not edit
  `boxing.html`, the shared modules, other mockups, or anything else.
- Do not change webcam/tracking behaviour. This is visual design.
- Verify your page actually renders before you finish: serve the folder
  (`cd spatial-objects && PORT=8890 node server.mjs`, it may already be up)
  and screenshot with puppeteer-core at 1280×800 using
  `executablePath: '/usr/bin/chromium'`, args `['--no-sandbox', '--use-gl=angle',
  '--use-angle=swiftshader', '--enable-unsafe-swiftshader']`. Look at the PNG,
  fix what looks bad, repeat. Leave your scratch screenshot script out of the
  repo (write it to /tmp).
