/* shared/face.js — webcam nose tracking via MediaPipe FaceLandmarker.

   const face = await Face.create(videoEl, vendorUrl);
   face.state → {
     ok,           // tracker live
     found,        // a face is in frame this tick
     nose: {x,y},  // nose tip, normalized 0–1, x mirrored (selfie view)
     size,         // face bbox diagonal — rough depth (lean in = bigger)
     center: {x,y},// face bbox center
   }

   Nose position drives the pano camera: x → yaw, y → pitch,
   size → subtle dolly (lean in to zoom). All values smoothed here so
   consumers get jitter-free motion.
*/
import { FilesetResolver, FaceLandmarker }
  from '../vendor/mediapipe/vision_bundle.mjs';

const NOSE_TIP = 4;            // canonical mesh: 4 = nose tip front
const lerp = (a, b, t) => a + (b - a) * t;

class Face {
  static async create(video, vendorUrl) {
    const f = new Face();
    const fileset = await FilesetResolver.forVisionTasks(`${vendorUrl}/wasm`);
    const opts = (delegate) => ({
      baseOptions: { modelAssetPath: `${vendorUrl}/face_landmarker.task`, delegate },
      runningMode: 'VIDEO', numFaces: 1,
      minFaceDetectionConfidence: .35, minFacePresenceConfidence: .35,
      minTrackingConfidence: .25,
    });
    try { f.landmarker = await FaceLandmarker.createFromOptions(fileset, opts('GPU')); f.delegate = 'gpu'; }
    catch { f.landmarker = await FaceLandmarker.createFromOptions(fileset, opts('CPU')); f.delegate = 'cpu'; }
    f.video = video;
    f.state = { ok: true, found: false, nose: { x: .5, y: .5 }, size: 0, center: { x: .5, y: .5 } };
    f._running = true;
    f._loop = f._loop.bind(f);
    video.addEventListener('loadeddata', () => f._loop());
    if (video.readyState >= 2) f._loop();
    return f;
  }

  stop() { this._running = false; }

  _loop() {
    if (!this._running) return;
    const v = this.video;
    if (v.readyState >= 2 && v.currentTime !== this._t) {
      this._t = v.currentTime;
      const res = this.landmarker.detectForVideo(v, performance.now());
      const lm = res.faceLandmarks?.[0];
      const s = this.state;
      if (lm) {
        let x0 = 1, y0 = 1, x1 = 0, y1 = 0;
        for (const p of lm) {
          if (p.x < x0) x0 = p.x; if (p.x > x1) x1 = p.x;
          if (p.y < y0) y0 = p.y; if (p.y > y1) y1 = p.y;
        }
        const tx = 1 - lm[NOSE_TIP].x, ty = lm[NOSE_TIP].y;   // mirror x for selfie view
        const tsize = Math.hypot(x1 - x0, y1 - y0);
        const k = s.found ? .3 : .6;                          // heavier snap on re-acquire
        s.nose.x = lerp(s.nose.x, tx, k);
        s.nose.y = lerp(s.nose.y, ty, k);
        s.center.x = lerp(s.center.x, 1 - (x0 + x1) / 2, k);
        s.center.y = lerp(s.center.y, (y0 + y1) / 2, k);
        s.size = lerp(s.size || tsize, tsize, k);
        s.found = true;
        this._miss = 0;
      } else if (++this._miss > 25) {
        s.found = false;   // hold last pose ~25 frames — head-tilts lose the
                         // detector for a beat; don't drop the view over it
      }
    }
    requestAnimationFrame(() => this._loop());
  }
}

export { Face };
