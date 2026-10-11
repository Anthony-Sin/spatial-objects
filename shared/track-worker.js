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
let landmarker = null, kind = null, model = null, lastTs = -1, warned = false, failN = 0;

self.onmessage = async (e) => {
  const m = e.data || {};
  if (m.type === 'init') {
    kind = m.kind;
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
    return;
  }

  if (m.type === 'close') { try { landmarker?.close?.(); } catch {} landmarker = null; return; }
  if (m.type !== 'frame') return;
  const frame = m.frame;
  if (!landmarker) {          // closed mid-flight — still post, or _inFlight wedges
    self.postMessage({ type: 'result', landmarks: kind === 'hands' ? [] : null,
      handedness: [], face: null });
    frame?.close?.(); return;
  }
  try {
    // VIDEO mode wants strictly increasing ms — the frame's own capture
    // timestamp is the truest source; perf clock is the fallback
    const ts = Math.max(lastTs + 1,
      frame.timestamp > 0 ? frame.timestamp / 1e3 : performance.now());
    lastTs = ts;
    const inferStart = performance.now();
    const res = landmarker.detectForVideo(frame, ts);
    const inferMs = performance.now() - inferStart;
    failN = 0;
    if (kind === 'hands')
      self.postMessage({ type: 'result',
        landmarks: res.landmarks || [], handedness: res.handedness || [], inferMs });
    else if (model === 'det-gpu' || model === 'det-cpu') {
      // biggest box wins — [0] is highest score, not closest face
      let det = null;
      for (const d2 of res.detections || [])
        if (!det || d2.boundingBox.width * d2.boundingBox.height
            > det.boundingBox.width * det.boundingBox.height) det = d2;
      const W = frame.displayWidth || frame.width || 1;
      const H = frame.displayHeight || frame.height || 1;
      self.postMessage({ type: 'result', inferMs, face: det ? {
        nose: { x: det.keypoints[2].x, y: det.keypoints[2].y },
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
    frame?.close?.();          // return the frame to the pool — leaks stall video
  }
};
