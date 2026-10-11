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
const STUCK_MS = 5000;     // an infer this long with no result/error = hung worker
const RESPAWN_MS = 3000;   // delay before re-spawning a mid-game-dead worker
const INFER_W = 640;       // frames wider than this are downscaled for inference
const INLINE_EVERY = 3;    // inline detects block the thread — third-rate only
/* phantom gate — MediaPipe pop-outs: a 1–2 result 'hand' detected on a
   hand-shaped background blob (a face, a poster, a lamp) re-fires at the
   SAME spot every time, and at 1:1 display each one paints a mitt there.
   A detection becomes real only after its track persists CONFIRM_FRAMES
   consecutive results; a live track stays warm through TRACK_MISS empty
   results so a real hand's flicker-outs never re-pay the delay. */
const CONFIRM_FRAMES = 2;  // consecutive results a new track must survive
const CLAIM_D = .28;       // norm units a tracked palm may jump per result
const CLAIM_D_HOT = .5;    // a verified track may reach farther — fast punches
const TRACK_MISS = 5;      // unclaimed results a live track stays warm
/* dead-spot memory — a track that dies UNVERIFIED was a phantom, not a hand,
   and phantoms re-fire at the same spot: the next track born there runs a
   longer streak. A verified hand always dies clean — during a fight its
   spot must never tax the hand's own re-entry. A verification nearby also
   clears the spot: a real hand re-asserting itself ends the suspicion. */
const GHOST_TTL = 100;     // ingest results a dead spot stays suspicious
const GHOST_D = .2;        // norm radius that counts as 'the same spot'
const CONFIRM_GHOST = 3;   // streak needed where an unverified track just died
/* jitter-in-a-box: a phantom on a static blob is re-LOCKED to a slightly
   different spot every result — its claims stay inside a small radius but
   jump hard frame to frame. A real still hand sits within ~±.01 of itself;
   a real moving hand breaks the radius entirely. The accusation needs the
   pattern on JIT_ACCUSE consecutive claims — real-hand landmark noise can
   spike briefly during motion, a phantom's never stops. */
const JIT_R = .18;         // norm box a suspect track's claims must fit
const JIT_D = .034;        // median per-claim jump that marks detector jitter
const JIT_N = 5;           // claims needed before the pattern can accuse
const JIT_ACCUSE = 2;      // consecutive suspect reads before suppression
const jitterBox = (h) => {        // h = flat [x0,y0,x1,y1,...] of claim points
  const m = h.length >> 1;
  if (m < JIT_N) return false;
  let mnx = 9, mxx = -9, mny = 9, mxy = -9;
  const ds = [];
  for (let i = 0; i < m; i++) {
    const x = h[i * 2], y = h[i * 2 + 1];
    if (x < mnx) mnx = x; if (x > mxx) mxx = x;
    if (y < mny) mny = y; if (y > mxy) mxy = y;
    if (i) ds.push(Math.hypot(x - h[i * 2 - 2], y - h[i * 2 - 1]));
  }
  ds.sort((a, b) => a - b);
  return mxx - mnx < JIT_R && mxy - mny < JIT_R && ds[(ds.length - 1) >> 1] > JIT_D;
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
/* create() opts {bootMs,stuckMs,respawnMs} shrink these for QE probes —
   production callers never set them, so the constants stay the defaults */
const posMs = (v, d) => (Number.isFinite(+v) && +v > 0 ? +v : d);

export class Hands {
  constructor() {
    this.state = { hands: [], pinch: null, point: null, orbit: null, zoom: null, spread: null };
    this.delegate = 'none';
    this._worker = null; this._inFlight = false;
    this.landmarker = null;                       // inline fallback only
    this._t = -1; this._prev = {}; this._tick = 0;
    this._tracks = []; this._ghosts = []; this._ingestN = 0;
    this._vendorUrl = null; this._video = null; this._onNew = null;
    this._retryT = null; this._initLocalP = null; this._stopped = false;
    this._sentAt = 0; this._bootW = null;
    this._bootMs = BOOT_MS; this._stuckMs = STUCK_MS; this._respawnMs = RESPAWN_MS;
    this.stats = { cameraHz: 0, trackHz: 0, roundTripMs: 0, inferMs: 0,
      lastResultAt: 0, frameWidth: 0, frameHeight: 0 };
    this._lastCameraAt = 0;
  }
  static async create(video, vendorUrl = './vendor/mediapipe', opts = {}) {
    const h = new Hands();
    h._vendorUrl = new URL(vendorUrl, location.href).href.replace(/\/$/, '');
    h._video = video;
    h._preferCpu = !!opts.preferCpu;
    h._bootMs = posMs(opts.bootMs, BOOT_MS);
    h._stuckMs = posMs(opts.stuckMs, STUCK_MS);
    h._respawnMs = posMs(opts.respawnMs, RESPAWN_MS);
    const spawnP = h._spawn();
    let which = await Promise.race([spawnP, sleep(h._bootMs).then(() => 'slow')]);
    /* 'slow' almost always means the ~13MB model download is still in
       flight — racing it with a second inline fetch doubles the transfer
       on the exact weak link causing the slowness (b3-soak: both fetched
       ~13MB at once, each starving the other). Give the in-flight worker
       one more grace window alone before covering with an inline
       landmarker; a late 'ready' still adopts either way. */
    if (which === 'slow')
      which = await Promise.race([spawnP, sleep(h._bootMs).then(() => 'slow')]);
    /* still slow after two grace windows? Keep waiting on the worker's
       verdict rather than spawning a competing ~13MB fetch (b4-soak: at
       60s both realms fetched anyway — the inline cover itself starves
       weak links). But a silently-dead worker must not wedge create()
       forever: after 3 more windows of silence, cover with inline while
       the worker keeps booting — a late 'ready' still adopts. */
    if (which === 'slow')
      which = await Promise.race([spawnP, sleep(h._bootMs * 3).then(() => 'slow')]);
    // a stop() during the boot race must not resurrect an inline landmarker
    if (h._stopped) return h;
    /* the inline cover itself gets a dead-man window: a stalled bundle
       fetch must not wedge create() any more than a silently-dead worker
       may. If the build lands after the cap it still installs — the pump
       picks it up — and if a late 'ready' adopted meanwhile the pending
       graph is closed by the post-await checks in _initLocalOnce. */
    if (which !== 'ok')
      await Promise.race([h._initLocal(), sleep(h._bootMs)]);
    if (h._stopped) return h;
    h._pump(video);
    return h;
  }
  /* Boot one worker. Resolves 'ok' once adopted, 'fail' on init error/death.
     A late 'ready' (after BOOT_MS race is lost) still adopts the pump. */
  _spawn() {
    const h = this;
    /* _bootW is a single-slot handle — a superseded still-booting worker
       must be reaped, never orphaned: overwriting the slot would leak a
       worker nothing can reach (its ~13MB download runs to completion for
       a tracker nobody owns, or forever if 'ready' never lands) */
    try { h._bootW?.terminate(); } catch {} h._bootW = null;
    return new Promise(res => {
      let w;
      try { w = new Worker(new URL('./track-worker.js', import.meta.url)); }   // classic worker — ESM in via import()
      catch { return res('fail'); }
      /* until 'ready' adopts it the worker isn't in _worker — keep a handle
         anyway so stop() (or a superseding spawn) can reap a still-booting
         worker instead of letting its ~13MB download run for a dead tracker —
         and if 'ready' never lands, it would leak forever */
      h._bootW = w;
      const done = () => { if (h._bootW === w) h._bootW = null; };
      w.onmessage = (e) => {
        const d = e.data || {};
        if (d.type === 'ready') {
          done();
          /* 'ready'+error can also land on an already-ADOPTED worker (a stray
             second init round-trip): route it through _workerDied so _worker
             never dangles at a terminated worker — a bare terminate() would
             wedge _inFlight until the STUCK watchdog noticed */
          if (d.error) { h._workerDied(w, false); res('fail'); }
          else { h._adopt(w, d.delegate); res('ok'); }
        }
        else if (d.type === 'result') {
          if (h._worker !== w) return;   // zombie worker (errored but not yet reaped) — ignore its frames
          const now = performance.now(), st = h.stats;
          st.roundTripMs = h._sentAt ? now - h._sentAt : 0;
          st.inferMs = d.inferMs || 0;
          if (st.lastResultAt) st.trackHz = st.trackHz
            ? st.trackHz * .7 + (1000 / Math.max(1, now - st.lastResultAt)) * .3
            : 1000 / Math.max(1, now - st.lastResultAt);
          st.lastResultAt = now;
          h._inFlight = false;
          try { h._ingest(d.landmarks, d.handedness); } catch {}  // a bad frame must never swallow the _onNew re-dispatch
          h._onNew?.();
        }
        else if (d.type === 'fatal') {   // repeated detect errors — GPU ctx died
          done(); h._workerDied(w, false);       // no respawn — the delegate itself is bad
        }
      };
      w.onerror = () => { done(); h._workerDied(w); res('fail'); };
      try { w.postMessage({ type: 'init', kind: 'hands', vendorUrl: h._vendorUrl,
        preferCpu: h._preferCpu }); }
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
    /* close() CAN throw on a half-dead GL graph — escaping the onmessage
       handler it would skip res('ok'), skip the onerror rewire, and leave
       `landmarker` truthy: that stale ref then blocked every future
       _initLocal early-return, so the NEXT worker death had no inline
       fallback to land on */
    try { this.landmarker?.close?.(); } catch {}
    this.landmarker = null;                            // worker won — free the inline copy
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
      const { FilesetResolver, HandLandmarker } = await import(`${this._vendorUrl}/vision_bundle.mjs`);
      const fileset = await FilesetResolver.forVisionTasks(`${this._vendorUrl}/wasm`);
      for (const delegate of ['GPU', 'CPU']) {
        try {
          const lm = await HandLandmarker.createFromOptions(fileset, {
            baseOptions: { modelAssetPath: `${this._vendorUrl}/hand_landmarker.task`, delegate },
            // same thresholds as track-worker.js — permissive on purpose:
            // phantom filtering lives in _ingest (confirm gate + ghost
            // spots), not in the conf floor where it drops real fists
            runningMode: 'VIDEO', numHands: 2,
            minHandDetectionConfidence: .4, minHandPresenceConfidence: .35, minTrackingConfidence: .3 });
          if (this._worker || this._stopped) { try { lm.close(); } catch {} return; }  // worker adopted / tracker stopped meanwhile
          this.landmarker = lm;
          this.delegate = delegate.toLowerCase();
          return;
        } catch { /* try next delegate */ }
      }
    } catch { /* bundle/wasm failed to load — stay on 'none', never reject */ }
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
      catch { try { frame.close?.(); } catch {} this._inFlight = false; }
    };
    // createImageBitmap itself may not exist, may reject, or may throw
    // SYNCHRONOUSLY — every path must land here, not in the rVFC callback
    // where an exception kills the pump chain (the next frame's 'new frame'
    // check would never run again)
    const bmp = (opts) => {
      let p = null;
      try { p = typeof createImageBitmap === 'function' ? createImageBitmap(v, opts || {}) : null; }
      catch {}
      return (p || Promise.reject(new Error('no createImageBitmap')))
        .then(post).catch(() => {
          let f; try { f = new VideoFrame(v); } catch {}   // resize unsupported → full-res
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
        if (this._worker) {
          if (!this._inFlight) this._send(v);
          /* the worker took the frame but never answered and never errored
             (hung infer — a GPU deadlock fires no onerror): _inFlight would
             latch forever and tracking silently stops. The warm-up proved a
             detect CAN complete, so past the watchdog window it's dead. */
          else if (this._sentAt && now - this._sentAt > this._stuckMs)
            this._workerDied(this._worker);
        }
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
    // an exception inside onNew must never kill the chain — re-scheduling is
    // unconditional so one bad frame can't end tracking for the session
    if (v.requestVideoFrameCallback) {          // paced by the camera itself — rAF fires too often
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
  _ingest(lms, handedness = []) {
    const n = ++this._ingestN;
    const prev = this._prev, seen = {}, tracks = this._tracks;
    for (const t of tracks) t.claimed = false;
    /* pass 1 — validate each detection, then claim the nearest live track
       by palm proximity. A track younger than CONFIRM_FRAMES results never
       reaches state.hands: single-frame pop-outs die here instead of
       painting a mitt at their fixed spot. */
    const cand = [];
    const raw = Array.isArray(lms) ? lms : [];
    for (let i = 0; i < raw.length; i++) {
      const lm = raw[i];
      // a malformed detection must never reach consumers: require the full
      // 21-pt skeleton with finite x/y. A short array crashes on lm[9]; a
      // NaN point poisons every downstream EMA, span and canvas path forever.
      let valid = Array.isArray(lm) && lm.length >= 21;
      for (let j = 0; valid && j < 21; j++)
        valid = !!lm[j] && Number.isFinite(lm[j].x) && Number.isFinite(lm[j].y);
      if (!valid) continue;
      const px = 1 - lm[9].x, py = lm[9].y;
      /* nearest claimable track wins — a VERIFIED track reaches CLAIM_D_HOT
         because a real punch legitimately covers >CLAIM_D between results,
         while an unverified track stays on the short leash so a flickering
         phantom can't slide into the gate by drifting */
      let trk = null, bd = Infinity;
      for (const t of tracks) if (!t.claimed) {
        const d = Math.hypot(t.x - px, t.y - py);
        if (d < (t.ok ? CLAIM_D_HOT : CLAIM_D) && d < bd) { bd = d; trk = t; }
      }
      if (!trk) {
        /* a track born where a short-lived track just died runs a longer
           streak — a phantom re-fires at the same spot, a hand does not */
        let need = CONFIRM_FRAMES;
        for (const g of this._ghosts)
          if (Math.hypot(g.x - px, g.y - py) < GHOST_D) { need = CONFIRM_GHOST; break; }
        tracks.push(trk = { x: px, y: py, age: 0, streak: 0, miss: 0, ok: false, need });
      }
      trk.claimed = true; trk.x = px; trk.y = py;
      /* verification counts CONSECUTIVE claims only — a phantom flickering
         every other frame never earns it, while an already-live track keeps
         its ok through the warm window no matter how streaks reset */
      trk.streak = trk.miss ? 1 : trk.streak + 1;
      trk.miss = 0; trk.age++;
      if (!trk.ok && trk.streak >= trk.need) {
        trk.ok = true; trk.okT = n;
        /* a verification consumes nearby dead spots — a real hand
           re-asserting itself is proof the spot was never haunted */
        if (this._ghosts.length)
          this._ghosts = this._ghosts.filter(g => Math.hypot(g.x - px, g.y - py) >= GHOST_D);
      }
      /* claim history feeds the jitter check — a phantom is re-locked to a
         different nearby spot every result while a real hand is either still
         (tiny jumps) or traveling (leaves the box). The accusation needs the
         pattern on consecutive claims: a real hand's noise spikes briefly
         during motion, a phantom's never stops. */
      const h = trk.hist || (trk.hist = []);
      h.push(px, py); if (h.length > 16) h.splice(0, 2);
      trk.jit = jitterBox(h) ? (trk.jit || 0) + 1 : 0;
      if (trk.ok && trk.jit < JIT_ACCUSE) cand.push({ lm, i, trk, side: this._sideOf(lm, handedness, i) });
    }
    /* unclaimed tracks age out — a hand gone longer than the warm window
       re-confirms on return instead of inheriting a stale identity. Only a
       NEVER-verified death leaves the spot hot: during a fight a real hand
       flickers in and out constantly, and it must never pay a tax to come
       back to the place it just left. */
    this._tracks = [];
    for (const t of tracks) {
      if (t.claimed || ++t.miss <= TRACK_MISS) { this._tracks.push(t); continue; }
      if (!t.ok) this._ghosts.push({ x: t.x, y: t.y, ttl: GHOST_TTL });
    }
    for (const g of this._ghosts) g.ttl--;
    this._ghosts = this._ghosts.filter(g => g.ttl > 0).slice(-8);
    /* same-side collision (two live detections sharing a label): the older
       track owns the slot. The loser is still a real hand on the OTHER side
       — the detector just flipped a label mid-cross — so hand it the free
       slot instead of blinking a glove out mid-punch. The mitt draws at its
       own (correct) landmarks either way. */
    cand.sort((a, b) => b.trk.age - a.trk.age);
    const list = [];
    for (const c of cand) {
      if (seen[c.side]) {
        const other = c.side === 'left' ? 'right' : 'left';
        if (seen[other]) continue;
        c.side = other;
      }
      seen[c.side] = true;
      const lm = c.lm, i = c.i, side = c.side;
      const p = prev[side], k = p ? LERP : 1;
      const out = { side, kind: 'hand', i,
        // contract is a 21-pt skeleton — a longer mesh (NaN beyond index 20
        // slipped the per-point check) must not carry poison downstream
        lm: lm.slice(0, 21).map((pt, j) => {
          const last = p?.lm?.[j];
          const x = 1 - pt.x;                       // mirror once for selfie view
          return { x: last ? last.x + (x - last.x) * k : x,
                   y: last ? last.y + (pt.y - last.y) * k : pt.y,
                   z: Number.isFinite(pt.z) ? pt.z : 0 };
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
      c.trk.out = out;                  // remembered for stale-pose coasting
      list.push(out);
    }
    /* stale-pose coasting — a verified track that misses a result emits its
       last measured pose for up to TRACK_MISS results. A punch is exactly
       when detection flickers (motion blur, the arm occluding the face):
       dropping the hand that instant blinks the mitt out mid-throw and the
       player can't tell the shot registered. A jit-accused track stays
       silent — coasting must not resurrect the phantom it caught. */
    for (const t of this._tracks) {
      if (t.claimed || !t.ok || !t.out || t.jit >= JIT_ACCUSE) continue;
      const s = t.out.side;
      if (seen[s]) continue;
      seen[s] = true;
      list.push(t.out);
    }
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
    // MediaPipe labels assume a mirrored selfie input. We feed the raw camera
    // frame and mirror only the drawn landmarks, so its label already names
    // the matching side of the final selfie view. Reversing it swapped mitts.
    const label = handedness?.[i]?.[0]?.categoryName || '';
    if (label === 'Left') return 'left';
    if (label === 'Right') return 'right';
    return (lm[0]?.x ?? 0) > .5 ? 'left' : 'right';
  }
  stop() {
    this._stopped = true;
    clearTimeout(this._retryT);
    this._inFlight = false; this._prev = {}; this._tracks = []; this._ghosts = [];
    /* a still-booting worker isn't _worker yet — kill it too or it keeps
       downloading ~13MB for a dead tracker (and leaks forever if its
       'ready' never lands) */
    try { this._bootW?.terminate(); } catch {} this._bootW = null;
    try { this._worker?.postMessage({ type: 'close' }); } catch {}
    try { this._worker?.terminate(); } catch {} this._worker = null;
    try { this.landmarker?.close?.(); } catch {} this.landmarker = null;
    this.delegate = 'none';
    // drop the whole derived state, not just .hands — a stale pinch/orbit
    // handle kept pointing at a dead hand object after stop()
    const st = this.state;
    st.hands = [];
    st.pinch = st.point = st.orbit = st.zoom = st.spread = null;
  }
}
export default Hands;
