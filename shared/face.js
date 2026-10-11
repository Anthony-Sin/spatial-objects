/* shared/face.js — webcam head tracker. Same tiny API, two engines:
     - worker path (preferred): a dedicated track-worker.js runs the detector
       off the main thread. BlazeFace first (nose + box is all we need),
       FaceLandmarker as its own fallback inside the worker.
     - inline path: FaceLandmarker on the main thread, only if workers die.
   .state {found, nose{x,y}, size, center{x,y}} stays self-view-mirrored.

   Cadence: BlazeFace is ~4ms → every camera frame (lowest sway latency);
   the landmarker fallback → every 2nd; inline (blocks the thread) → every
   3rd. Boot policy mirrors hands.js: worker first, inline covers a slow
   boot after 30s, a late worker 'ready' always adopts the pump.
*/
const BOOT_MS = 30000;
/* a glove passed in front of the camera occludes the face for a moment —
   'found' only concedes the face is gone after this much CONTINUOUS loss,
   so a punch flurry never makes the nose dot / head tracking blink out */
const LOST_MS = 3000;
const INFER_W = 640;      // downscale wider frames before inference — same cap as hands.js
const sleep = ms => new Promise(r => setTimeout(r, ms));

export class Face {
  constructor() {
    this.state = { found: false, nose: { x: .5, y: .5 }, size: 0, center: { x: .5, y: .5 } };
    this.delegate = 'none';
    this._worker = null; this._inFlight = false; this._okAt = -1;
    this.landmarker = null;                       // inline fallback only
    this._t = -1; this._tick = 0; this._rate = 2;
    this._vendorUrl = null; this._video = null; this._onNew = null;
    this._retryT = null;
  }
  static async create(video, vendorUrl = './vendor/mediapipe', opts = {}) {
    const f = new Face();
    f._vendorUrl = new URL(vendorUrl, location.href).href.replace(/\/$/, '');
    f._video = video;
    f._preferCpu = !!opts.preferCpu;
    const which = await Promise.race([f._spawn(), sleep(BOOT_MS).then(() => 'slow')]);
    if (which !== 'ok') await f._initLocal();   // 'fail' or 'slow' → cover the gap
    f._pump(video);
    return f;
  }
  _spawn() {
    const f = this;
    return new Promise(res => {
      let w;
      try { w = new Worker(new URL('./track-worker.js', import.meta.url)); }   // classic worker — ESM in via import()
      catch { return res('fail'); }
      w.onmessage = (e) => {
        const d = e.data || {};
        if (d.type === 'ready') {
          if (d.error) { try { w.terminate(); } catch {} res('fail'); }
          else { f._adopt(w, d.delegate); res('ok'); }
        }
        else if (d.type === 'result') { f._inFlight = false; f._ingest(d); f._onNew?.(); }
        else if (d.type === 'fatal') {
          try { w.terminate(); } catch {}
          if (f._worker === w) { f._worker = null; f.delegate = 'none'; }
          f._inFlight = false; f._initLocal().catch(() => {});
        }
      };
      w.onerror = () => {
        if (f._worker === w) { f._worker = null; f._inFlight = false; f._initLocal().catch(() => {}); }
        res('fail');
      };
      try { w.postMessage({ type: 'init', kind: 'face', vendorUrl: f._vendorUrl,
        preferCpu: f._preferCpu }); }
      catch { res('fail'); }
    });
  }
  _adopt(w, delegate) {
    this._worker = w;
    this.delegate = `${delegate}-worker`;
    this._rate = delegate.startsWith('det') ? 1 : 2;      // BlazeFace is cheap enough for 30Hz
    this.landmarker?.close?.(); this.landmarker = null;
    w.onerror = () => {                                  // mid-game death → inline + one respawn
      if (this._worker === w) { this._worker = null; this.delegate = 'none'; }
      this._inFlight = false;
      this._initLocal().catch(() => {});
      clearTimeout(this._retryT);
      this._retryT = setTimeout(() => { if (!this._worker) this._spawn(); }, 3000);
    };
  }
  async _initLocal() {
    if (this.landmarker) return;
    const { FilesetResolver, FaceLandmarker } = await import(`${this._vendorUrl}/vision_bundle.mjs`);
    const fileset = await FilesetResolver.forVisionTasks(`${this._vendorUrl}/wasm`);
    for (const delegate of ['GPU', 'CPU']) {
      try {
        const lm = await FaceLandmarker.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: `${this._vendorUrl}/face_landmarker.task`, delegate },
          runningMode: 'VIDEO', numFaces: 1,
          minFaceDetectionConfidence: .35, minFacePresenceConfidence: .35, minTrackingConfidence: .25 });
        if (this._worker) { try { lm.close(); } catch {} return; }  // worker adopted meanwhile
        this.landmarker = lm;
        this.delegate = delegate.toLowerCase();
        this._rate = 3;                                  // inline blocks the thread — third-rate
        return;
      } catch { /* try next delegate */ }
    }
    if (!this._worker) this.delegate = 'none';
  }
  /* One camera frame in flight, downscaled like hands.js — 'ideal' camera
     constraints don't guarantee 640×480, and VideoFrame ignores resize on
     video elements; createImageBitmap honours it. */
  _send(v) {
    this._inFlight = true;
    const vw = v.videoWidth || 0, vh = v.videoHeight || 0;
    const post = (frame) => {
      try { this._worker.postMessage({ type: 'frame', frame }, [frame]); }
      catch { frame.close?.(); this._inFlight = false; }
    };
    const bmp = (opts) => createImageBitmap(v, opts || {}).then(post).catch(() => {
      let f; try { f = new VideoFrame(v); } catch {}
      if (f) post(f); else this._inFlight = false;
    });
    if (vw > INFER_W) return void bmp({
      resizeWidth: INFER_W,
      resizeHeight: Math.max(2, Math.round(INFER_W * vh / vw / 2) * 2),
      resizeQuality: 'low' });
    let f;
    try { f = new VideoFrame(v); } catch { f = null; }
    if (f) return void post(f);
    bmp();
  }
  _pump(v) {
    const onNew = () => {   // a *new* frame exists — nothing gained by re-detecting the same one
      if (v.readyState >= 2 && v.currentTime !== this._t) {
        this._t = v.currentTime;
        if (++this._tick % this._rate) return true;
        if (this._worker) { if (!this._inFlight) this._send(v); }
        else if (this.landmarker) {
          try { this._ingest({ landmarks: this.landmarker.detectForVideo(v, performance.now()).faceLandmarks?.[0] }); } catch {}
        }
      }
      return true;
    };
    this._onNew = onNew;   // worker results re-dispatch here — no rVFC bubble
    if (v.requestVideoFrameCallback) {
      const again = () => v.requestVideoFrameCallback(() => { if (this._worker || this.landmarker) onNew(); again(); });
      again();
    } else {
      const again = () => { if (this._worker || this.landmarker) onNew(); requestAnimationFrame(again); };
      again();
    }
  }
  _ingest(d) {
    const s = this.state;
    let tx = 0, ty = 0, tsize = 0, cx = 0, cy = 0, ok = false;
    if (d.face) {                              // BlazeFace: nose keypoint + box
      tx = 1 - d.face.nose.x; ty = d.face.nose.y;
      tsize = Math.hypot(d.face.box.w, d.face.box.h);
      cx = 1 - (d.face.box.x + d.face.box.w / 2); cy = d.face.box.y + d.face.box.h / 2;
      ok = true;
    } else if (d.landmarks) {                  // FaceLandmarker: bbox over 478 pts
      const lm = d.landmarks;
      let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
      for (let i = 0, n = lm.length; i < n; i++) {
        const p = lm[i];
        if (p.x < x0) x0 = p.x; if (p.x > x1) x1 = p.x;
        if (p.y < y0) y0 = p.y; if (p.y > y1) y1 = p.y;
      }
      const nose = lm[1] || { x: (x0 + x1) / 2, y: (y0 + y1) / 2 };
      tx = 1 - nose.x; ty = nose.y;
      tsize = Math.hypot(x1 - x0, y1 - y0);
      cx = 1 - (x0 + x1) / 2; cy = (y0 + y1) / 2;
      ok = true;
    }
    if (ok) {
      this._okAt = performance.now(); s.found = true;
      const k = s.size ? .68 : 1;                       // snap first, then light EMA
      // (.45 made head motion visibly trail the camera; .68 converges in ~2
      // results ≈ 60ms at 30Hz while still damping single-frame jitter)
      s.nose.x += (tx - s.nose.x) * k; s.nose.y += (ty - s.nose.y) * k;
      s.center.x += (cx - s.center.x) * k; s.center.y += (cy - s.center.y) * k;
      s.size += (tsize - s.size) * (s.size ? .5 : 1);
    } else if (this._okAt < 0 || performance.now() - this._okAt > LOST_MS) s.found = false;
  }
  stop() {
    clearTimeout(this._retryT);
    try { this._worker?.postMessage({ type: 'close' }); } catch {}
    this._worker?.terminate(); this._worker = null;
    try { this.landmarker?.close?.(); } catch {} this.landmarker = null;
    this._okAt = -1;
    this.state.found = false;
  }
}
export default Face;
