/* shared/face.js — webcam face tracker. Same tiny API, two engines:
     - worker path (preferred): a dedicated track-worker.js runs
       FaceLandmarker (478-pt landmark mesh) off the main thread, CPU
       delegate first — the iGPU keeps render + hand inference, and the
       landmarker sits on spare cores. BlazeFace is the fallback inside
       the worker if the landmarker can't boot.
     - inline path: FaceLandmarker on the main thread, only if workers die.
   .state {found, nose{x,y}, size, center{x,y}, lm[...]} stays
   self-view-mirrored — lm is the full mesh (or null on the det fallback).

   Cadence: in the worker every new camera frame is offered — the
   one-in-flight gate self-throttles to whatever the delegate sustains
   (FaceLandmarker ≈10–20ms on CPU → ~camera rate), so it can never drag
   render fps. Inline blocks the thread → every 3rd. Boot policy mirrors
   hands.js: worker first, inline covers a slow boot after 30s, a late
   worker 'ready' always adopts the pump.
*/
const BOOT_MS = 30000;
const STUCK_MS = 5000;    // an infer this long with no result/error = hung worker
const RESPAWN_MS = 3000;  // delay before re-spawning a mid-game-dead worker
/* a glove passed in front of the camera occludes the face for a moment —
   'found' only concedes the face is gone after this much CONTINUOUS loss,
   so a punch flurry never makes the nose dot / head tracking blink out */
const LOST_MS = 3000;
const INFER_W = 640;      // downscale wider frames before inference — same cap as hands.js
const sleep = ms => new Promise(r => setTimeout(r, ms));
/* create() opts {bootMs,stuckMs,respawnMs} shrink these for QE probes —
   production callers never set them, so the constants stay the defaults */
const posMs = (v, d) => (Number.isFinite(+v) && +v > 0 ? +v : d);

export class Face {
  constructor() {
    this.state = { found: false, nose: { x: .5, y: .5 }, size: 0,
      center: { x: .5, y: .5 }, lm: null };
    this.inferMs = 0;
    this.delegate = 'none';
    this._worker = null; this._inFlight = false; this._okAt = -1;
    this.landmarker = null;                       // inline fallback only
    this._t = -1; this._tick = 0; this._rate = 2;
    this._vendorUrl = null; this._video = null; this._onNew = null;
    this._retryT = null; this._initLocalP = null; this._stopped = false;
    this._sentAt = 0; this._bootW = null;
    this._bootMs = BOOT_MS; this._stuckMs = STUCK_MS; this._respawnMs = RESPAWN_MS;
  }
  static async create(video, vendorUrl = './vendor/mediapipe', opts = {}) {
    const f = new Face();
    f._vendorUrl = new URL(vendorUrl, location.href).href.replace(/\/$/, '');
    f._video = video;
    // face infer is light enough that CPU-first is the right default — the
    // GPU stays reserved for render + hands. opt out with preferCpu:false
    f._preferCpu = opts.preferCpu !== false;
    f._bootMs = posMs(opts.bootMs, BOOT_MS);
    f._stuckMs = posMs(opts.stuckMs, STUCK_MS);
    f._respawnMs = posMs(opts.respawnMs, RESPAWN_MS);
    const spawnP = f._spawn();
    let which = await Promise.race([spawnP, sleep(f._bootMs).then(() => 'slow')]);
    // 'slow' = model download still in flight — don't race it with a second
    // inline fetch; extend the worker one grace window before covering (see
    // hands.js — same duplicate-download fix)
    if (which === 'slow')
      which = await Promise.race([spawnP, sleep(f._bootMs).then(() => 'slow')]);
    if (which === 'slow')
      which = await Promise.race([spawnP, sleep(f._bootMs * 3).then(() => 'slow')]);
    // 'fail' or a third 'slow' → cover the gap; see hands.js — the worker
    // keeps booting either way so a late 'ready' still adopts
    if (f._stopped) return f;
    /* the inline cover itself gets a dead-man window: a stalled bundle
       fetch must not wedge create() any more than a silently-dead worker
       may. A build landing after the cap still installs — the pump picks
       it up; a late 'ready' adopting meanwhile closes the pending graph. */
    if (which !== 'ok')
      await Promise.race([f._initLocal(), sleep(f._bootMs)]);
    if (f._stopped) return f;
    f._pump(video);
    return f;
  }
  _spawn() {
    const f = this;
    /* _bootW is a single-slot handle — a superseded still-booting worker
       must be reaped, never orphaned: overwriting the slot would leak a
       worker nothing can reach (its ~13MB download runs to completion for
       a tracker nobody owns, or forever if 'ready' never lands) */
    try { f._bootW?.terminate(); } catch {} f._bootW = null;
    return new Promise(res => {
      let w;
      try { w = new Worker(new URL('./track-worker.js', import.meta.url)); }   // classic worker — ESM in via import()
      catch { return res('fail'); }
      /* until 'ready' adopts it the worker isn't in _worker — keep a handle
         anyway so stop() (or a superseding spawn) can reap a still-booting
         worker instead of letting its ~13MB download run for a dead tracker —
         and if 'ready' never lands, it would leak forever */
      f._bootW = w;
      const done = () => { if (f._bootW === w) f._bootW = null; };
      w.onmessage = (e) => {
        const d = e.data || {};
        if (d.type === 'ready') {
          done();
          /* 'ready'+error can also land on an already-ADOPTED worker (a stray
             second init round-trip): route it through _workerDied so _worker
             never dangles at a terminated worker — a bare terminate() would
             wedge _inFlight until the STUCK watchdog noticed */
          if (d.error) { f._workerDied(w, false); res('fail'); }
          else { f._adopt(w, d.delegate); res('ok'); }
        }
        else if (d.type === 'result') {
          if (f._worker !== w) return;   // zombie worker (errored but not yet reaped) — ignore its frames
          f._inFlight = false; f.inferMs = d.inferMs || 0;
          try { f._ingest(d); } catch {}   // a bad frame must never swallow the _onNew re-dispatch
          f._onNew?.();
        }
        else if (d.type === 'fatal') {
          done(); f._workerDied(w, false);       // no respawn — the delegate itself is bad
        }
      };
      w.onerror = () => { done(); f._workerDied(w); res('fail'); };
      try { w.postMessage({ type: 'init', kind: 'face', vendorUrl: f._vendorUrl,
        preferCpu: f._preferCpu }); }
      /* init never arrived — reap the half-spawned worker too; it holds a
         real thread even though it got no orders */
      catch { try { w.terminate(); } catch {} done(); res('fail'); }
    });
  }
  _adopt(w, delegate) {
    if (this._bootW === w) this._bootW = null;   // ownership moves to _worker
    // a 'ready' landing after stop() would resurrect a worker on a dead
    // tracker — kill it instead of adopting
    if (this._stopped) { try { w.terminate(); } catch {} return; }
    // a stale boot can finish after a respawn already won — never keep two
    if (this._worker && this._worker !== w) { try { this._worker.terminate(); } catch {} }
    this._worker = w;
    this.delegate = `${delegate || 'unknown'}-worker`;   // a bare 'ready' must not print 'undefined-worker'
    this._rate = 1;   // offer every camera frame — _inFlight gates the pace
    /* close() CAN throw on a half-dead GL graph — escaping the onmessage
       handler it would skip res('ok'), skip the onerror rewire, and leave
       `landmarker` truthy: that stale ref then blocked every future
       _initLocal early-return, so the NEXT worker death had no inline
       fallback to land on */
    try { this.landmarker?.close?.(); } catch {}
    this.landmarker = null;
    w.onerror = () => this._workerDied(w);               // mid-game death → inline + one respawn
  }
  /* One place a worker goes to die. Idempotent: a zombie that already lost
     its slot is reaped but touches nothing else — only the CURRENT worker
     gets the flight gate cleared, the inline fallback and the respawn. */
  _workerDied(w, respawn = true) {
    try { w.terminate(); } catch {}                      // terminate() is safe to repeat
    if (this._worker !== w) return;                      // already replaced
    this._worker = null; this.delegate = 'none';
    this._inFlight = false;
    this._initLocal().catch(() => {});
    clearTimeout(this._retryT);
    if (respawn) this._retryT = setTimeout(() => {
      if (!this._worker && !this._stopped) this._spawn();
    }, this._respawnMs);
  }
  /* concurrent callers (fatal + onerror can fire together) must share ONE
     boot — two inline landmarkers meant leaked GPU/CPU graphs */
  async _initLocal() {
    // a worker that already owns the pump must never get a second inline
    // graph built under it — the 'ready'-vs-verdict race used to sneak one in
    if (this.landmarker || this._stopped || this._worker) return;
    if (this._initLocalP) return this._initLocalP;
    this._initLocalP = this._initLocalOnce().finally(() => { this._initLocalP = null; });
    return this._initLocalP;
  }
  async _initLocalOnce() {
    if (this.landmarker || this._stopped || this._worker) return;
    try {
      const { FilesetResolver, FaceLandmarker } = await import(`${this._vendorUrl}/vision_bundle.mjs`);
      const fileset = await FilesetResolver.forVisionTasks(`${this._vendorUrl}/wasm`);
      const order = this._preferCpu ? ['CPU', 'GPU'] : ['GPU', 'CPU'];
      for (const delegate of order) {
        try {
          const lm = await FaceLandmarker.createFromOptions(fileset, {
            baseOptions: { modelAssetPath: `${this._vendorUrl}/face_landmarker.task`, delegate },
            runningMode: 'VIDEO', numFaces: 1,
            minFaceDetectionConfidence: .35, minFacePresenceConfidence: .35, minTrackingConfidence: .25 });
          if (this._worker || this._stopped) { try { lm.close(); } catch {} return; }  // worker adopted / tracker stopped meanwhile
          this.landmarker = lm;
          this.delegate = delegate.toLowerCase();
          this._rate = 3;                                // inline blocks the thread — third-rate
          return;
        } catch { /* try next delegate */ }
      }
    } catch { /* bundle/wasm failed to load — stay on 'none', never reject */ }
    if (!this._worker) this.delegate = 'none';
  }
  /* One camera frame in flight, downscaled like hands.js — 'ideal' camera
     constraints don't guarantee 640×480, and VideoFrame ignores resize on
     video elements; createImageBitmap honours it. */
  _send(v) {
    this._inFlight = true;
    this._sentAt = performance.now();                    // watchdog baseline
    const vw = v.videoWidth || 0, vh = v.videoHeight || 0;
    const post = (frame) => {
      try { this._worker.postMessage({ type: 'frame', frame }, [frame]); }
      catch { try { frame.close?.(); } catch {} this._inFlight = false; }
    };
    // createImageBitmap itself may not exist, may reject, or may throw
    // SYNCHRONOUSLY — every path must land here, not in the rVFC callback
    // where an exception kills the pump chain
    const bmp = (opts) => {
      let p = null;
      try { p = typeof createImageBitmap === 'function' ? createImageBitmap(v, opts || {}) : null; }
      catch {}
      return (p || Promise.reject(new Error('no createImageBitmap')))
        .then(post).catch(() => {
          let f; try { f = new VideoFrame(v); } catch {}
          if (f) post(f); else this._inFlight = false;
        });
    };
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
        if (this._worker) {
          if (!this._inFlight) this._send(v);
          /* the worker took the frame but never answered and never errored
             (hung infer — a GPU deadlock fires no onerror): _inFlight would
             latch forever and tracking silently stops. The warm-up proved a
             detect CAN complete, so past the watchdog window it's dead. */
          else if (this._sentAt && performance.now() - this._sentAt > this._stuckMs)
            this._workerDied(this._worker);
        }
        else if (this.landmarker) {
          try { this._ingest({ landmarks: this.landmarker.detectForVideo(v, performance.now()).faceLandmarks?.[0] }); } catch {}
        }
      }
      return true;
    };
    this._onNew = onNew;   // worker results re-dispatch here — no rVFC bubble
    // an exception inside onNew must never kill the chain — re-scheduling is
    // unconditional so one bad frame can't end tracking for the session
    if (v.requestVideoFrameCallback) {
      const again = () => { try {
        v.requestVideoFrameCallback(() => {
          if (this._stopped) return;              // stop() must kill the chain, not just idle it
          try { if (this._worker || this.landmarker) onNew(); } catch {} again(); });
        /* re-registering can throw on a detached document — an escape from
           inside the rVFC callback is an uncaught error AND a dead chain;
           ending quietly is strictly better */
      } catch {} };
      again();
    } else {
      const again = () => {
        if (this._stopped) return;
        try { if (this._worker || this.landmarker) onNew(); } catch {}
        requestAnimationFrame(again); };
      again();
    }
  }
  _ingest(d) {
    const s = this.state;
    const fin = Number.isFinite;
    let tx = 0, ty = 0, tsize = 0, cx = 0, cy = 0, ok = false;
    /* Malformed input must die here, not downstream: an empty landmarks []
       used to produce a ~2.8e9 "face size" (bbox of nothing), and a single
       NaN point poisons the EMA below — .68 weighting never washes NaN out,
       so the tracker would report a NaN nose until page reload. */
    if (d && d.face) {                         // BlazeFace fallback: nose keypoint + box
      const f = d.face, b = f.box || {}, n = f.nose || {};
      if (fin(n.x) && fin(n.y) && fin(b.x) && fin(b.y)
          && fin(b.w) && fin(b.h) && b.w > 0 && b.h > 0) {
        s.lm = null;
        tx = 1 - n.x; ty = n.y;
        tsize = Math.hypot(b.w, b.h);
        cx = 1 - (b.x + b.w / 2); cy = b.y + b.h / 2;
        ok = true;
      }
    } else if (d && Array.isArray(d.landmarks) && d.landmarks.length) {
      // FaceLandmarker: bbox + mesh over 478 pts
      const lm = d.landmarks;
      let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9, bad = 0;
      const pts = s.lm && s.lm.length === lm.length ? s.lm : (s.lm = new Array(lm.length));
      for (let i = 0, n = lm.length; i < n; i++) {
        const p = lm[i] || {};
        const px = p.x, py = p.y;
        if (!fin(px) || !fin(py)) { bad++; continue; }
        if (px < x0) x0 = px; if (px > x1) x1 = px;
        if (py < y0) y0 = py; if (py > y1) y1 = py;
        const q = pts[i] || (pts[i] = { x: 0, y: 0, z: 0 });   // reuse — no per-frame GC
        q.x = 1 - px; q.y = py; q.z = fin(p.z) ? p.z : 0;      // mirror once, like hands.js
      }
      // the whole frame is dropped if any point is corrupt — a partial mesh
      // reads as a glitching face, not a slightly-wrong one
      if (!bad) {
        const nose = lm[1] && fin(lm[1].x) && fin(lm[1].y)
          ? lm[1] : { x: (x0 + x1) / 2, y: (y0 + y1) / 2 };
        tx = 1 - nose.x; ty = nose.y;
        tsize = Math.hypot(x1 - x0, y1 - y0);
        cx = 1 - (x0 + x1) / 2; cy = (y0 + y1) / 2;
        ok = fin(tx) && fin(ty) && fin(tsize) && tsize > 0;
      }
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
    this._stopped = true;
    clearTimeout(this._retryT);
    this._inFlight = false;
    /* a still-booting worker isn't _worker yet — kill it too or it keeps
       downloading ~13MB for a dead tracker (and leaks forever if its
       'ready' never lands) */
    try { this._bootW?.terminate(); } catch {} this._bootW = null;
    try { this._worker?.postMessage({ type: 'close' }); } catch {}
    try { this._worker?.terminate(); } catch {} this._worker = null;
    try { this.landmarker?.close?.(); } catch {} this.landmarker = null;
    this._okAt = -1;
    this.delegate = 'none';
    this.state.found = false;
    this.state.lm = null;
  }
}
export default Face;
