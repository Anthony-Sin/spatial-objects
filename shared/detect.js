/* shared/detect.js — YOLOv8n object detection, in-browser via onnxruntime-web.

   const det = await Detector.create(videoEl, {model, wasm, labels});
   det.on(hits => …)   hits: [{label, conf, x,y,w,h}] normalized 0–1,
   det.latest → same   empty array when nothing confident.
   det.stop()

   Loads vendor/ort/ort.all.min.js (UMD → window.ort) itself, sets wasmPaths
   to the vendored wasm folder, letterboxes the frame to 640² and runs every
   ~550 ms (latest-wins; skipped while a run is in flight). 80 COCO classes.
*/
const LABELS_URL = '../../tools/model-labels.json';
const CONF = 0.45, IOU = 0.45, SIZE = 640;

async function loadScript(src) {
  if (window.ort) return;
  await new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = src; s.onload = res; s.onerror = () => rej(new Error('ort load failed'));
    document.head.appendChild(s);
  });
}

class Detector {
  static async create(video, base /* url of shared/ dir */, period = 550) {
    const d = new Detector();
    d.video = video; d.period = period; d.latest = []; d._cbs = new Set();
    d.cv = document.createElement('canvas'); d.cv.width = d.cv.height = SIZE;
    d.cx = d.cv.getContext('2d', { willReadFrequently: true });
    d.labels = await (await fetch(`${base}${LABELS_URL}`)).json();
    if (!Array.isArray(d.labels)) d.labels = Object.values(d.labels);
    await loadScript(`${base}../vendor/ort/ort.all.min.js`);
    ort.env.wasm.wasmPaths = `${base}../vendor/ort/`;
    ort.env.wasm.numThreads = 2;
    ort.env.wasm.proxy = true;                 // inference off the main thread → snappy UI
    const url = `${base}../tools/yolov8n.onnx`;
    try {
      d.session = await ort.InferenceSession.create(url, { executionProviders: ['webgpu'] });
      d.backend = 'webgpu';
    } catch {
      d.session = await ort.InferenceSession.create(url, { executionProviders: ['wasm'] });
      d.backend = 'wasm';
    }
    d._run = d._run.bind(d);
    d._timer = setInterval(d._run, period);
    return d;
  }

  on(cb) { this._cbs.add(cb); return () => this._cbs.delete(cb); }
  stop() { clearInterval(this._timer); }

  async _run() {
    if (this._busy || this.video.readyState < 2) return;
    this._busy = true;
    try { await this._infer(); } catch { /* frame-level failure: keep going */ }
    this._busy = false;
  }

  async _infer() {
    const { video, cx, cv } = this;
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh) return;
    // letterbox to 640²
    const sc = Math.min(SIZE / vw, SIZE / vh);
    const dw = vw * sc, dh = vh * sc, dx = (SIZE - dw) / 2, dy = (SIZE - dh) / 2;
    cx.fillStyle = '#808080'; cx.fillRect(0, 0, SIZE, SIZE);
    cx.drawImage(video, dx, dy, dw, dh);
    const img = cx.getImageData(0, 0, SIZE, SIZE).data;
    const n = SIZE * SIZE;
    const buf = new Float32Array(3 * n);
    for (let i = 0; i < n; i++) {
      buf[i] = img[i * 4] / 255;          // R
      buf[n + i] = img[i * 4 + 1] / 255;  // G
      buf[2 * n + i] = img[i * 4 + 2] / 255;
    }
    const out = await this.session.run({ images: new ort.Tensor('float32', buf, [1, 3, SIZE, SIZE]) });
    const t = out[Object.keys(out)[0]];                  // [1,84,8400]
    const a = t.data, C = t.dims[1], N = t.dims[2];
    const cand = [];
    for (let i = 0; i < N; i++) {
      let best = 0, bi = -1;
      for (let c = 4; c < C; c++) { const v = a[c * N + i]; if (v > best) { best = v; bi = c - 4; } }
      if (best < CONF) continue;
      const cxp = a[i], cyp = a[N + i], wp = a[2 * N + i], hp = a[3 * N + i];
      cand.push({ x: cxp - wp / 2, y: cyp - hp / 2, w: wp, h: hp, conf: best, cls: bi });
    }
    // NMS
    cand.sort((p, q) => q.conf - p.conf);
    const keep = [];
    for (const c of cand) {
      if (keep.some(k => iou(k, c) > IOU)) continue;
      keep.push(c); if (keep.length >= 6) break;
    }
    // un-letterbox → normalized coords in the ORIGINAL frame
    this.latest = keep.map(k => ({
      label: this.labels[k.cls] || `class ${k.cls}`,
      conf: k.conf,
      x: (k.x - dx) / dw, y: (k.y - dy) / dh, w: k.w / dw, h: k.h / dh,
    }));
    for (const cb of this._cbs) cb(this.latest);
  }
}
function iou(a, b) {
  const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
  const r = Math.min(a.x + a.w, b.x + b.w), bo = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, r - x) * Math.max(0, bo - y);
  return inter / (a.w * a.h + b.w * b.h - inter + 1e-6);
}

window.Detector = Detector;
export default Detector;
