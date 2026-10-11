/* shared/track-worker.js — MediaPipe landmark inference off the main thread.

   CLASSIC worker (not module): the Emscripten vision glue loads its pieces
   with importScripts(), which module workers forbid. The ESM bundle itself
   comes in through dynamic import(), which classic workers do allow.

   One worker instance owns ONE landmarker ('hands' | 'face'). The page posts
   transferred VideoFrames/ImageBitmaps in; raw landmarks post back. Keeping
   detectForVideo off the main thread is what lets the render loop hold 60 —
   a synchronous call there costs 10–30ms every camera frame.

   The 'face' worker runs FaceLandmarker (478-pt landmark mesh) — ~10–20ms
   on the CPU delegate, nothing on the main thread, and it stays off the
   GPU so the iGPU keeps render + hand inference. BlazeFace (~230KB) stays
   vendored as the last-resort fallback if the landmarker can't boot.

   Messages in:  {type:'init', kind, vendorUrl}   (vendorUrl = absolute)
                 {type:'frame', frame:VideoFrame|ImageBitmap}  (transferred)
                 {type:'close'}
   Messages out: {type:'ready', delegate} | {type:'ready', error}
                 {type:'result', landmarks:[...], handedness:[[...]]}   (hands)
                 {type:'result', landmarks:[...]|null}                  (face·landmarker)
                 {type:'result', face:{nose:{x,y},box:{x,y,w,h}}|null}  (face·detector,
                    all normalized 0–1, NOT selfie-mirrored — page handles that)
*/
let landmarker = null, kind = null, model = null, lastTs = -1, warned = false,
  failN = 0, tsOff = null, warnedFrame = false;

/* init/close are async (they await import() + createFromOptions) — if two
   inits, or an init and a close, interleave at those awaits, the loser's
   graph is never closed and kind/model can end up describing a different
   landmarker than the one installed. Run every lifecycle message through
   ONE serial chain: order is preserved and each step sees the previous
   fully settled. 'frame' stays off the chain — it's synchronous anyway. */
let chain = Promise.resolve();

async function doInit(m) {
    kind = (m.kind === 'hands' || m.kind === 'face') ? m.kind : null;
    // re-init must not leak the previous graph or carry a half-spent failN
    try { landmarker?.close?.(); } catch {}
    landmarker = null; model = null; lastTs = -1; warned = false; failN = 0;
    tsOff = null;
    if (!kind) {
      self.postMessage({ type: 'ready', error: `unknown landmarker kind '${m.kind}'` });
      return;
    }
    try {
      const { FilesetResolver, HandLandmarker, FaceLandmarker, FaceDetector } =
        await import(`${m.vendorUrl}/vision_bundle.mjs`);
      const fileset = await FilesetResolver.forVisionTasks(`${m.vendorUrl}/wasm`);
      // preferCpu: when the renderer owns a weak iGPU, GPU inference *competes*
      // with it — CPU delegates on separate cores keep the GPU for drawing.
      const order = m.preferCpu ? ['CPU', 'GPU'] : ['GPU', 'CPU'];
      let attempts;
      if (kind === 'hands') {
        attempts = order.map(delegate => [HandLandmarker, {
          baseOptions: { modelAssetPath: `${m.vendorUrl}/hand_landmarker.task`, delegate },
          /* thresholds stay permissive — phantom filtering lives in hands.js
             (the confirm gate + dead-spot memory), NOT here: pop-outs score
             .9+ anyway, so a higher floor only drops real edge-on fists */
          runningMode: 'VIDEO', numHands: 2, minHandDetectionConfidence: .4,
          minHandPresenceConfidence: .35, minTrackingConfidence: .3 }, delegate.toLowerCase()]);
      } else {
        attempts = [
          ...order.map(delegate => [FaceLandmarker, {
            baseOptions: { modelAssetPath: `${m.vendorUrl}/face_landmarker.task`, delegate },
            runningMode: 'VIDEO', numFaces: 1, minFaceDetectionConfidence: .35,
            minFacePresenceConfidence: .35, minTrackingConfidence: .25 }, delegate.toLowerCase()]),
          ...order.map(delegate => [FaceDetector, {
            baseOptions: { modelAssetPath: `${m.vendorUrl}/blaze_face_short_range.tflite`, delegate },
            runningMode: 'VIDEO', minDetectionConfidence: .4 }, `det-${delegate.toLowerCase()}`]),
        ];
      }
      let lastErr = null;
      for (const [Cls, o, tag] of attempts) {
        try {
          landmarker = await Cls.createFromOptions(fileset, o);
          model = tag;
          // warm-up: the first real detect compiles shaders + inits the graph —
          // burn a dummy frame at camera size so tensors pre-allocate too.
          // it consumed ts=1 — floor lastTs so the first real frame can't
          // arrive with a media-time stamp below it (VIDEO mode demands
          // strictly increasing ts across EVERY detect on this landmarker)
          try { landmarker.detectForVideo(new OffscreenCanvas(1280, 720), 1); } catch {}
          lastTs = Math.max(lastTs, 1);
          self.postMessage({ type: 'ready', delegate: tag });
          return;
        } catch (err) { lastErr = err; }
      }
      self.postMessage({ type: 'ready', error: String(lastErr) });
    } catch (err) { self.postMessage({ type: 'ready', error: String(err) }); }
}

function doClose() { try { landmarker?.close?.(); } catch {} landmarker = null; }

function handleFrame(m) {
  const frame = m.frame;
  /* malformed envelope — a sender bug, not a dying delegate. Still post so
     the page's _inFlight clears, but DON'T count failN: 35 of these used to
     escalate a perfectly healthy landmarker to 'fatal' */
  if (!frame || typeof frame !== 'object' || typeof frame.close !== 'function') {
    if (!warnedFrame) { warnedFrame = true;
      console.warn('track-worker: frame message with no usable frame — ignored'); }
    self.postMessage({ type: 'result', landmarks: kind === 'hands' ? [] : null,
      handedness: [], face: null });
    return;
  }
  if (!landmarker) {          // closed mid-flight — still post, or _inFlight wedges
    self.postMessage({ type: 'result', landmarks: kind === 'hands' ? [] : null,
      handedness: [], face: null });
    try { frame?.close?.(); } catch {} return;
  }
  try {
    // VIDEO mode wants strictly increasing ms — the frame's own media
    // timestamp is the truest source, perf clock the fallback. The two clocks
    // have different origins, so the media clock is anchored ONCE into the
    // local scale: a first frame stamped 0 falls back to perf.now (~seconds),
    // and a later 40ms media stamp must map to ~perf-time too — the bare
    // Math.max() this replaced would clamp it to +1ms/frame forever, making
    // the graph's temporal filters see a nearly-frozen stream. The offset
    // preserves real inter-frame deltas; the lastTs floor keeps ordering
    // through seeks/underruns; untimestamped frames (ImageBitmap) just take
    // perf time, which already sits on the anchored scale.
    // Guard the stamp itself too: Infinity used to anchor tsOff=-Inf and
    // land NaN in lastTs, poisoning every later frame's ts with NaN.
    const raw = Number.isFinite(frame.timestamp) && frame.timestamp > 0
      ? frame.timestamp / 1e3 : null;
    if (raw != null && tsOff == null)
      tsOff = Math.max(lastTs + 1, performance.now()) - raw;
    const ts = Math.max(lastTs + 1,
      raw != null ? raw + tsOff : performance.now());
    lastTs = ts;
    const inferStart = performance.now();
    /* a detect may legitimately resolve with undefined (skipped frame on a
       busy graph) — treating that as a throw used to burn failN on a
       perfectly healthy landmarker and could escalate it to 'fatal' */
    const res = landmarker.detectForVideo(frame, ts) || {};
    const inferMs = performance.now() - inferStart;
    failN = 0;
    if (kind === 'hands')
      self.postMessage({ type: 'result',
        landmarks: res.landmarks || [], handedness: res.handedness || [], inferMs });
    else if (model === 'det-gpu' || model === 'det-cpu') {
      // biggest box wins — [0] is highest score, not closest face
      let det = null;
      for (const d2 of res.detections || [])
        if (d2?.boundingBox && (!det || d2.boundingBox.width * d2.boundingBox.height
            > det.boundingBox.width * det.boundingBox.height)) det = d2;
      const W = frame.displayWidth || frame.width || 1;
      const H = frame.displayHeight || frame.height || 1;
      const nose = det?.keypoints?.[2];   // malformed detection ≠ a face
      self.postMessage({ type: 'result', inferMs, face: det && nose ? {
        nose: { x: nose.x, y: nose.y },
        box: { x: det.boundingBox.originX / W, y: det.boundingBox.originY / H,
               w: det.boundingBox.width / W, h: det.boundingBox.height / H } } : null });
    } else
      self.postMessage({ type: 'result', inferMs,
        landmarks: res.faceLandmarks?.[0] || null });
  } catch (err) {
    if (!warned) { warned = true; console.warn('track-worker detect failed:', String(err)); }
    // a dead delegate returns empty landmarks forever — escalate so the page
    // can fall back instead of silently tracking nothing
    if (++failN > 30) { try { landmarker?.close?.(); } catch {} landmarker = null;
      self.postMessage({ type: 'fatal' }); return; }
    self.postMessage({ type: 'result', landmarks: kind === 'hands' ? [] : null,
      handedness: [], face: null });
  } finally {
    // return the frame to the pool — leaks stall video; a throwing close()
    // here would mask the real outcome, so it stays wrapped
    try { frame?.close?.(); } catch {}
  }
}

self.onmessage = (e) => {
  const m = e.data || {};
  if (m.type === 'init' || m.type === 'close') {
    // serialized — see the chain comment above; a rejection must not wedge it
    chain = chain
      .then(() => m.type === 'init' ? doInit(m) : doClose())
      .catch(err => console.warn('track-worker lifecycle error:', String(err)));
    return;
  }
  if (m.type === 'frame') handleFrame(m);
};
