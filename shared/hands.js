/* shared/hands.js — webcam hand tracker. Public state shape unchanged
   (.state {hands, pinch, point, orbit, zoom, spread}); the only change is
   WHERE inference runs:
     - worker path (preferred): a dedicated track-worker.js hosts
       HandLandmarker off the main thread, so a 10–30ms detect can never
       eat a vsync on the render thread.
     - inline path: exact old behaviour, kept as the automatic fallback.
   Frames cross as transferred VideoFrames — zero copy, never queued
   (one in flight, stale frames are dropped, not buffered).

   Boot policy: the worker starts immediately; if it hasn't answered in 30s
   an inline landmarker covers the gap — and whenever the worker finally
   posts 'ready' it adopts the pump (closing the inline copy). Slow-booting
   machines therefore never sit on main-thread inference forever.
*/
const LERP = 1;            // display raw measured motion; extra EMA caused visible lag
const BOOT_MS = 30000;     // worker boot grace before inline covers the gap
const INFER_W = 640;       // frames wider than this are downscaled for inference
const INLINE_EVERY = 3;    // inline detects block the thread — third-rate only
const sleep = ms => new Promise(r => setTimeout(r, ms));

export class Hands {
  constructor() {
    this.state = { hands: [], pinch: null, point: null, orbit: null, zoom: null, spread: null };
    this.delegate = 'none';
    this._worker = null; this._inFlight = false;
    this.landmarker = null;                       // inline fallback only
    this._t = -1; this._prev = {}; this._tick = 0;
    this._vendorUrl = null; this._video = null; this._onNew = null;
    this._retryT = null;
    this.stats = { cameraHz: 0, trackHz: 0, roundTripMs: 0, inferMs: 0,
      lastResultAt: 0, frameWidth: 0, frameHeight: 0 };
    this._lastCameraAt = 0;
  }
  static async create(video, vendorUrl = './vendor/mediapipe', opts = {}) {
    const h = new Hands();
    h._vendorUrl = new URL(vendorUrl, location.href).href.replace(/\/$/, '');
    h._video = video;
    h._preferCpu = !!opts.preferCpu;
    const which = await Promise.race([h._spawn(), sleep(BOOT_MS).then(() => 'slow')]);
    // 'ok' → worker owns it. 'fail' → inline now. 'slow' → inline covers the
    // gap while the worker keeps booting; a late 'ready' still adopts.
    if (which !== 'ok') await h._initLocal();
    h._pump(video);
    return h;
  }
  /* Boot one worker. Resolves 'ok' once adopted, 'fail' on init error/death.
     A late 'ready' (after BOOT_MS race is lost) still adopts the pump. */
  _spawn() {
    const h = this;
    return new Promise(res => {
      let w;
      try { w = new Worker(new URL('./track-worker.js', import.meta.url)); }   // classic worker — ESM in via import()
      catch { return res('fail'); }
      w.onmessage = (e) => {
        const d = e.data || {};
        if (d.type === 'ready') {
          if (d.error) { try { w.terminate(); } catch {} res('fail'); }
          else { h._adopt(w, d.delegate); res('ok'); }
        }
        else if (d.type === 'result') {
          const now = performance.now(), st = h.stats;
          st.roundTripMs = h._sentAt ? now - h._sentAt : 0;
          st.inferMs = d.inferMs || 0;
          if (st.lastResultAt) st.trackHz = st.trackHz
            ? st.trackHz * .7 + (1000 / Math.max(1, now - st.lastResultAt)) * .3
            : 1000 / Math.max(1, now - st.lastResultAt);
          st.lastResultAt = now;
          h._inFlight = false; h._ingest(d.landmarks, d.handedness); h._onNew?.();
        }
        else if (d.type === 'fatal') {   // repeated detect errors — GPU ctx died
          try { w.terminate(); } catch {}
          if (h._worker === w) { h._worker = null; h.delegate = 'none'; }
          h._inFlight = false; h._initLocal().catch(() => {});
        }
      };
      w.onerror = () => {
        if (h._worker === w) { h._worker = null; h._inFlight = false; h._initLocal().catch(() => {}); }
        res('fail');
      };
      try { w.postMessage({ type: 'init', kind: 'hands', vendorUrl: h._vendorUrl,
        preferCpu: h._preferCpu }); }
      catch { res('fail'); }
    });
  }
  _adopt(w, delegate) {
    this._worker = w;
    this.delegate = `${delegate}-worker`;
    this.landmarker?.close?.(); this.landmarker = null;   // worker won — free the inline copy
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
    const { FilesetResolver, HandLandmarker } = await import(`${this._vendorUrl}/vision_bundle.mjs`);
    const fileset = await FilesetResolver.forVisionTasks(`${this._vendorUrl}/wasm`);
    for (const delegate of ['GPU', 'CPU']) {
      try {
        const lm = await HandLandmarker.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: `${this._vendorUrl}/hand_landmarker.task`, delegate },
          runningMode: 'VIDEO', numHands: 2,
          minHandDetectionConfidence: .4, minHandPresenceConfidence: .35, minTrackingConfidence: .3 });
        if (this._worker) { try { lm.close(); } catch {} return; }  // worker adopted meanwhile
        this.landmarker = lm;
        this.delegate = delegate.toLowerCase();
        return;
      } catch { /* try next delegate */ }
    }
    if (!this._worker) this.delegate = 'none';
  }
  /* One frame in flight. Inference cost scales with pixels (~20ms at
     640×480 → ~150ms at 1280×720 — five frames' budget in one detect), so
     anything wider than INFER_W is downscaled BEFORE it crosses to the
     worker. getUserMedia 'ideal' doesn't guarantee 640×480 — cams with no
     native 480p mode deliver 720p+, and ?vid= files are full-res — and
     VideoFrame silently ignores resizeWidth on video elements; only
     createImageBitmap honours it. */
  _send(v) {
    this._inFlight = true;
    this._sentAt = performance.now();
    const vw = v.videoWidth || 0, vh = v.videoHeight || 0;
    const post = (frame) => {
      this.stats.frameWidth = frame.displayWidth || frame.width || vw;
      this.stats.frameHeight = frame.displayHeight || frame.height || vh;
      try { this._worker.postMessage({ type: 'frame', frame }, [frame]); }
      catch { frame.close?.(); this._inFlight = false; }
    };
    const bmp = (opts) => createImageBitmap(v, opts || {}).then(post).catch(() => {
      let f; try { f = new VideoFrame(v); } catch {}   // resize unsupported → full-res
      if (f) post(f); else this._inFlight = false;
    });
    if (vw > INFER_W) return void bmp({
      resizeWidth: INFER_W,
      resizeHeight: Math.max(2, Math.round(INFER_W * vh / vw / 2) * 2),
      resizeQuality: 'low' });
    let f;
    try { f = new VideoFrame(v); } catch { f = null; }
    if (f) return void post(f);
    // VideoFrame ctor unsupported → ImageBitmap is still zero-copy enough
    bmp();
  }
  _pump(v) {
    const onNew = () => {   // only ever send a frame that's actually new
      if (v.readyState >= 2 && v.currentTime !== this._t) {
        const now = performance.now();
        if (this._lastCameraAt) this.stats.cameraHz = this.stats.cameraHz
          ? this.stats.cameraHz * .8 + 1000 / Math.max(1, now - this._lastCameraAt) * .2
          : 1000 / Math.max(1, now - this._lastCameraAt);
        this._lastCameraAt = now;
        this._t = v.currentTime;
        if (this._worker) { if (!this._inFlight) this._send(v); }
        else if (this.landmarker) {
          // inline detect blocks the render thread — cap it at ~10Hz so a
          // slow delegate can never drag the whole game down with it
          if (++this._tick % INLINE_EVERY) return true;
          try {
            const result = this.landmarker.detectForVideo(v, performance.now());
            const st = this.stats;
            st.inferMs = performance.now() - now;
            if (st.lastResultAt) st.trackHz = st.trackHz
              ? st.trackHz * .7 + 1000 / Math.max(1, performance.now() - st.lastResultAt) * .3
              : 1000 / Math.max(1, performance.now() - st.lastResultAt);
            st.lastResultAt = performance.now(); st.roundTripMs = st.inferMs;
            this._ingest(result.landmarks, result.handedness);
          } catch {}
        }
      }
      return true;
    };
    this._onNew = onNew;   // worker results re-dispatch here — no rVFC bubble
    if (v.requestVideoFrameCallback) {          // paced by the camera itself — rAF fires too often
      const again = () => v.requestVideoFrameCallback(() => { if (this._worker || this.landmarker) onNew(); again(); });
      again();
    } else {
      const again = () => { if (this._worker || this.landmarker) onNew(); requestAnimationFrame(again); };
      again();
    }
  }
  _ingest(lms, handedness = []) {
    const prev = this._prev, seen = {};
    const list = (lms || []).map((lm, i) => {
      const side = this._sideOf(lm, handedness, i); seen[side] = true;
      const p = prev[side], k = p ? LERP : 1;
      const out = { side, kind: 'hand', i,
        lm: lm.map((pt, j) => {
          const last = p?.lm?.[j];
          const x = 1 - pt.x;                       // mirror once for selfie view
          return { x: last ? last.x + (x - last.x) * k : x,
                   y: last ? last.y + (pt.y - last.y) * k : pt.y, z: pt.z };
        }) };
      out.palm = out.lm[9]; out.wrist = out.lm[0];
      out.indexTip = out.lm[8]; out.pinchAt = out.lm[4];
      const d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
      const span = d(out.lm[0], out.lm[9]) || 1e-6;
      out.pinchD = d(out.lm[4], out.lm[8]) / span;
      const extended = (tip, pip) => d(out.lm[tip], out.lm[0]) > d(out.lm[pip], out.lm[0]) * 1.12;
      const fingers = [extended(8, 6), extended(12, 10),
        extended(16, 14), extended(20, 18)];
      out.nExt = fingers.filter(Boolean).length;
      out.nExtAll = out.nExt + (d(out.lm[4], out.lm[17])
        > d(out.lm[2], out.lm[17]) * 1.08 ? 1 : 0);
      out.pinch = p?.pinch ? out.pinchD < .32 : out.pinchD < .26;
      out.kind = out.pinch ? 'pinch' : out.nExt >= 4 ? 'palm'
        : out.nExt === 0 ? 'fist' : fingers[0] && out.nExt === 1 ? 'point' : 'other';
      prev[side] = out;
      return out;
    });
    for (const s in prev) if (!seen[s]) delete prev[s];
    const st = this.state; st.hands = list;
    const get = s => list.find(h => h.side === s);
    const L = get('left'), R = get('right');
    const P = list.find(h => h.pinch) || null;
    st.pinch = P ? { x: P.pinchAt.x, y: P.pinchAt.y, hand: P } : null;
    st.point = list.find(h => h.nExt === 1) || null;
    st.orbit = R && !R.pinch ? { x: R.palm.x, y: R.palm.y } : null;
    st.zoom = (L?.pinch && R?.pinch) ? { x: (L.palm.x + R.palm.x) / 2, y: (L.palm.y + R.palm.y) / 2 } : null;
    st.spread = (L && R) ? Math.hypot(L.palm.x - R.palm.x, L.palm.y - R.palm.y) : null;
  }
  _sideOf(lm, handedness, i) {
    // detector labels the person's anatomical side; mirror it for self-view
    const label = handedness?.[i]?.[0]?.categoryName || '';
    if (label === 'Left') return 'right';
    if (label === 'Right') return 'left';
    return lm[0].x > .5 ? 'left' : 'right';
  }
  stop() {
    clearTimeout(this._retryT);
    try { this._worker?.postMessage({ type: 'close' }); } catch {}
    this._worker?.terminate(); this._worker = null;
    try { this.landmarker?.close?.(); } catch {} this.landmarker = null;
    this.state.hands = [];
  }
}
export default Hands;
