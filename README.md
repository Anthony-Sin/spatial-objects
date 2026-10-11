# spatial objects — webcam → hand-tracked training sims

Hold an object up to your webcam. The scanner (YOLOv8, local) finds it, an AR
ghost of its primitive forms over the live feed, and it drops into a 3D CAD
bench you drive with your hands. On top of that sit three job-training rooms —
real 3D environments where a foreman, surgeon, or dispatcher calls out tasks
and scores your hands. Everything runs locally; no cloud, no keys — except
the boxing halftime corner card, which asks a remote coach model for one tip
per bout (`server.mjs` proxies `api.tensormux.com`, `TENSOR_KEY` env
overrides the demo key, and the bout falls back to canned advice offline).
Set `ELEVENLABS_KEY` (plus optional `ELEVENLABS_VOICE`) in the env or a
`spatial-objects/.env` and `POST /api/coach-voice` speaks the tip in a
gravelly corner voice (Clyde by default, `?voice=<id>` auditions others) —
unset, the corner simply stays quiet.

## Run

```bash
cd spatial-objects
PORT=8890 node server.mjs          # static server (default port 8791)
# open http://127.0.0.1:8890/      → the CAD bench (index.html)
# allow camera access when prompted
```

## The training rooms

| page | scenario | scoring |
|---|---|---|
| `index.html` | the bench — scan real objects, pinch to move/drill/explode parts | freeform CAD |
| `job.html` | **the bay** — foreman's shift: PPE, fit pipe, tack weld, drill, gears, lever, rivet, stow | shop points |
| `theatre.html` | **the theatre** — surgeon's view over the patient: scalpel corridor, bone set, sharps, O₂ | theatre points |
| `dock.html` | **the dock** — freight manifest: stack pallet, scan crates, hazmat drum, park forklift | dock points |
| `gallery.html` | landing page linking all four | — |

## Gestures (same everywhere)

| hand pose | action |
|---|---|
| pinch | precision grab — hold tools, place parts |
| point | aim — reticle locks onto a distant prop |
| fist | **force-pull** — aimed prop flies to your hand; hold to keep gripped |
| open palm | orbit / hover |
| head move | look around — nose-tracked, `C` re-centers |
| `1`–`9` | scene keys where applicable |

You can complete every room with a mouse if a webcam is unavailable: **left
drag** acts as the left hand, **right drag** as the right hand, and **Shift
drag** looks around. Press **C** to return to the current job's camera view.
The current object and destination are highlighted in the scene. The view
zooms toward small parts for precision jobs and widens for freight and other
large placements. Each shift ends with a score and a replay button.

Job props **spawn on demand** — a tool materializes only when its card calls
for it, and it is fully grabbable/pullable the moment it appears.

## Layout

```
index.html         the CAD bench (scan → materialize → manipulate)
job.html           industrial bay — 8-job shift, weld/fit/drill/stow
theatre.html       surgery — corridor carry, bone set, sharps, gas, clear field
dock.html          loading dock — pallet stack, manifest scan, hazmat, stow
gallery.html       links page
shared/hands.js    MediaPipe HandLandmarker → gesture state (2-hand)
shared/face.js     MediaPipe FaceLandmarker → nose-tracked view
shared/glove.js    cartoon-glove overlay renderer (size-capped)
shared/detect.js   YOLOv8n via onnxruntime-web, local model + labels
shared/cad.js      bench scene: parts, explode/levitate, CSG drill
shared/ui.js       boot(): webcam → trackers → AR overlay → cad.feed()
vendor/            three.js, mediapipe tasks-vision, onnxruntime-web, GLBs
tools/             yolov8n.onnx, model-labels.json
server.mjs         static file server (correct wasm/onnx MIME types)
test/              layout audit, force-pull, job-progression (headless)
```

Tests: `npm test` — layout floats/overlaps audit + force-pull + job
progression, all headless Chromium with a fake cam. `npm run perf` — FPS
floor + gesture latency guard.

Pinch uses hysteresis (tight enter, loose exit) so drags can't flick off.
Hand roles: LEFT = fit/place, RIGHT = wield tools, via MediaPipe handedness
(selfie-flipped). Brief nose-tracking loss holds the pose. Each new task frames
its work area; `C` recalibrates the current task view.
