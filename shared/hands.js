/* shared/hands.js — webcam hand tracking via MediaPipe HandLandmarker.

   const hands = await Hands.create(videoEl, vendorUrl);
   hands.state → {
     ok,                    // tracker live
     hands: [Hand],         // 0–2 hands, newest-first
     pinch,                 // primary pinch {x,y,px,py} | null  (screen px)
     orbit,                 // open-palm drag {x,y,dx,dy} | null
     zoom,                  // two-pinch spread {d,dd,cx,cy} | null
     spread,                // two open palms moving {d,dd,cx,cy} | null
   }
   Landmark coords are normalized 0–1 with x mirrored (selfie view) so the
   cursor matches what the user sees; .px/.py variants are screen pixels
   against the element the tracker was bound to.

   Gestures:
     pinch   — thumb tip ~ index tip            → grab / tap / select
     palm    — all four fingers extended        → orbit when moving
     zoom    — BOTH hands pinching, spread apart→ dolly
     spread  — BOTH palms open, moving apart    → explode / assemble
     point   — only index extended              → hover cursor
     fist    — none extended                    → hold modifier
*/
import { FilesetResolver, HandLandmarker }
  from '../vendor/mediapipe/vision_bundle.mjs';

const EXTENDED = (lm, tip, pip, mcp) => {
  // finger tip farther from wrist than pip → extended (palm-relative)
  const w = lm[0];
  const d = (a) => Math.hypot(a.x - w.x, a.y - w.y);
  return d(lm[tip]) > d(lm[pip]) * 1.12;
};

class Hands {
  static async create(video, vendorUrl) {
    const h = new Hands();
    const fileset = await FilesetResolver.forVisionTasks(`${vendorUrl}/wasm`);
    const opts = (delegate) => ({
      baseOptions: { modelAssetPath: `${vendorUrl}/hand_landmarker.task`, delegate },
      runningMode: 'VIDEO', numHands: 2, minHandDetectionConfidence: .4,
      minHandPresenceConfidence: .35, minTrackingConfidence: .3,
    });
    // GPU first; some machines/drivers fail silently there — CPU is the floor
    try { h.landmarker = await HandLandmarker.createFromOptions(fileset, opts('GPU')); h.delegate = 'gpu'; }
    catch {
      try { h.landmarker = await HandLandmarker.createFromOptions(fileset, opts('CPU')); h.delegate = 'cpu'; }
      catch (e) { throw e; }
    }
    h.video = video;
    h.state = { ok: true, hands: [], pinch: null, orbit: null, zoom: null, spread: null };
    h._prev = new Map();
    h._loop = h._loop.bind(h);
    h._running = true;
    video.addEventListener('loadeddata', () => h._loop());
    if (video.readyState >= 2) h._loop();
    return h;
  }

  stop() { this._running = false; }

  _loop() {
    if (!this._running) return;
    requestAnimationFrame(() => this._loop());
    const v = this.video;
    if (v.readyState < 2 || v.currentTime === this._lastT) return;
    this._lastT = v.currentTime;
    let res;
    try { res = this.landmarker.detectForVideo(v, performance.now()); }
    catch { return; }
    this._ingest(res.landmarks || [], res.handedness || []);
  }

  _ingest(frames, handed = []) {
    const S = this.state;
    const prev = S.hands;
    S.hands = frames.map((lm, i) => {
      // selfie view: MediaPipe's 'Left' is the user's RIGHT hand — flip it
      const label = handed[i]?.[0]?.categoryName;
      const side = label ? (label === 'Left' ? 'right' : 'left') : null;
      // mirror x so it matches the selfie-view the user sees
      const px = (n) => 1 - lm[n].x, py = (n) => lm[n].y;
      const thumb = { x: px(4), y: py(4) }, index = { x: px(8), y: py(8) };
      const pinchD = Math.hypot(thumb.x - index.x, thumb.y - index.y);
      const ext = [
        EXTENDED(lm, 8, 6, 5),   // index
        EXTENDED(lm, 12, 10, 9), // middle
        EXTENDED(lm, 16, 14, 13),// ring
        EXTENDED(lm, 20, 18, 17),// pinky
      ];
      const nExt = ext.filter(Boolean).length;
      // thumb "extended" ≈ tip is farther from pinky mcp than the mcp is
      const thumbExt = Math.hypot(lm[4].x - lm[17].x, lm[4].y - lm[17].y)
                     > Math.hypot(lm[2].x - lm[17].x, lm[2].y - lm[17].y) * 1.08;
      const nExtAll = nExt + (thumbExt ? 1 : 0);   // 0–5 incl. thumb — pose→tool count
      const palm = { x: px(9), y: py(9) };             // middle mcp ~ palm center
      const wrist = { x: px(0), y: py(0) };
      // pinch hysteresis (borrowed from spatial demos like minority-report-
      // gesture-graph): enter tight, exit loose — moving fingers mid-drag
      // can't flick the gesture off and drop what you're holding
      const wasP = prev[i]?.kind === 'pinch';
      const pinching = wasP ? pinchD < .085 : (pinchD < .055 && nExt <= 2);
      const kind =
        pinching ? 'pinch' :
        nExt >= 4 ? 'palm' :
        nExt === 0 ? 'fist' :
        ext[0] && nExt === 1 ? 'point' : 'other';
      const cur = { i, kind, lm, side, palm, wrist, indexTip: index,
                    pinchAt: { x: (thumb.x + index.x) / 2, y: (thumb.y + index.y) / 2 },
                    pinchD, nExt, nExtAll };
      // velocity of palm for orbit/spread gestures
      const p = prev[i];
      cur.vx = p ? cur.palm.x - p.palm.x : 0;
      cur.vy = p ? cur.palm.y - p.palm.y : 0;
      return cur;
    });

    const pinches = S.hands.filter(h => h.kind === 'pinch');
    const palms = S.hands.filter(h => h.kind === 'palm');

    S.pinch = pinches.length === 1 ? { ...pinches[0].pinchAt } : null;
    S.point = S.hands.find(h => h.kind === 'point')?.indexTip ?? null;

    S.orbit = palms.length === 1
      ? { x: palms[0].palm.x, y: palms[0].palm.y, dx: palms[0].vx, dy: palms[0].vy }
      : null;

    const spreadOf = (arr) => {
      if (arr.length < 2) return null;
      const a = arr[0].palm ?? arr[0].pinchAt, b = arr[1].palm ?? arr[1].pinchAt;
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      const k = arr[0].kind === 'pinch' ? 'z' : 's';
      const pd = this._prev[k];
      this._prev[k] = d;
      return { d, dd: pd == null ? 0 : d - pd, cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 };
    };
    S.zoom = pinches.length === 2 ? spreadOf(pinches.map(p => ({ ...p, palm: p.pinchAt }))) : null;
    S.spread = palms.length === 2 ? spreadOf(palms) : null;
    if (pinches.length !== 2) this._prev.z = null;
    if (palms.length !== 2) this._prev.s = null;
  }
}

window.Hands = Hands;
export default Hands;
