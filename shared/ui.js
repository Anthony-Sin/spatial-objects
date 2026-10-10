/* shared/ui.js — boots the whole stack for a variant page.

   const app = await SpatialUI.boot(root, {
     video:   '[data-cam]',      // <video> — mirrored webcam feed (BIG)
     overlay: '[data-hands]',    // <canvas> — fixed full-window AR layer
     cad:     '[data-cad]',      // <canvas> — three.js bench
     chip:    '[data-detect]',   // element — "sees: mug · 91%"
     status:  '[data-status]',   // element — line of status text
     tools:   '[data-tools]',    // container — tool dock gets buttons injected
     cadOpts: { bg: 0xf3ede1 },  // forwarded to CADScene
     spawn:   true,              // lock a held object → ghost forms → CAD part drops in
   });

   The AR loop: Detector boxes the held object → a scanning reticle sweeps
   it on the video overlay → after ~1s stable the matching 3D primitive is
   ghosted over the object (cup→cylinder, ball→sphere, box/phone→box…)
   → then it solidifies and drops onto the CAD bench as a real grabbable
   part. You literally watch AR take shape over the thing you're holding.

   ?mouse → pointer emulates the hand (move=hover, drag=pinch, shift-drag
   =orbit, wheel=zoom, E=explode) for headless/no-camera testing.
*/
import * as THREE from 'three';
import Hands from './hands.js';
import Detector from './detect.js';
import CADScene from './cad.js';
import { drawGlove } from './glove.js';

const TOOLS = [
  ['select', 'grab / move'], ['box', '+ box'], ['cyl', '+ cylinder'],
  ['sphere', '+ sphere'], ['cone', '+ cone'], ['drill', 'drill hole'],
];

/* COCO label → primitive kind for the materialize step */
const KIND_OF = [
  [/bottle|cup|vase|wine glass|toilet|potted plant|fire hydrant|parking meter|traffic light/, 'cyl'],
  [/sports ball|orange|apple|bowl|clock|donut|pizza|frisbee|tennis/, 'sphere'],
  [/umbrella|kite|skateboard|snowboard|surfboard|skis/, 'box'],
  [/cell phone|book|laptop|tv|remote|keyboard|suitcase|backpack|handbag|tie|microwave|oven|refrigerator|bed|bench|chair|couch|dining table/, 'box'],
];
const BASE = import.meta.url.replace(/shared\/ui\.js$/, '');
const params = new URLSearchParams(location.search);

async function cam(video) {
  /* baseline-video mode: ?vid=<path> loops a recorded clip instead of the cam —
     same pipeline, deterministic input for testing. */
  if (params.get('vid')) {
    video.src = decodeURIComponent(params.get('vid'));
    video.loop = true; video.muted = true;
    video._baseline = true;
    await video.play();
    return null;
  }
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' }, audio: false });
  video.srcObject = stream;
  await video.play();
  return stream;
}

export default { boot };

export async function boot(root, sel) {
  const $ = (s) => root.querySelector(s) || document.querySelector(s);
  const video = $(sel.video), overlay = $(sel.overlay), cadCv = $(sel.cad);
  const chip = $(sel.chip), status = $(sel.status), toolsEl = $(sel.tools);
  const say = (t) => { if (status) status.textContent = t; };
  const emit = (n, d) => dispatchEvent(new CustomEvent(n, { detail: d }));
  const mouseMode = params.has('mouse');

  const cad = new CADScene(cadCv, sel.cadOpts || {});
  cad.start();
  window.__cad = cad;

  // tool dock — setTool syncs dock state + emits x:tool so pages can bind keys/HUD
  let toolBtns = [];
  const setTool = (id) => {
    const label = TOOLS.find(t => t[0] === id)?.[1] ?? id;
    cad.setTool(id);
    toolBtns.forEach(x => x.classList.toggle('on', x.dataset.tool === id));
    say(`tool: ${label}`);
    emit('x:tool', { id, label });
  };
  if (toolsEl) {
    for (const [id, label] of TOOLS) {
      const b = document.createElement('button');
      b.type = 'button'; b.dataset.tool = id; b.innerHTML =
        `<i>${{ select: '⌖', box: '▣', cyl: '⬤', sphere: '●', cone: '▲', drill: '◎' }[id] || ''}</i><span>${label}</span>`;
      b.classList.toggle('on', id === 'select');
      b.onclick = () => setTool(id);
      toolsEl.appendChild(b); toolBtns.push(b);
    }
  }
  addEventListener('keydown', e => {
    if (e.target.matches('input,textarea')) return;
    const n = parseInt(e.key);
    if (n >= 1 && n <= TOOLS.length) setTool(TOOLS[n - 1][0]);
    else if (e.key === 'Tab') { e.preventDefault();
      setTool(TOOLS[(TOOLS.findIndex(t => t[0] === cad.tool) + 1) % TOOLS.length][0]); }
  });

  /* pose→tool: hold a finger-count pose steady (~350 ms) to arm a tool.
     ✊ fist=drill · ☝️=select · ✌️=box · 🤟=cyl · 🖖=sphere · 🖐=cone */
  const POSE_TOOL = ['drill', 'select', 'box', 'cyl', 'sphere', 'cone'];
  let _pose = -1, _poseT = 0, _poseSw = false;
  const poseToolTick = (hs, now, vr) => {
    const single = (hs.hands || []).length === 1 && !hs.zoom && !hs.spread;
    const k = hs.hands?.[0]?.kind;
    // never steal the tool while a pinch/grab is in progress — and a fist held
    // over the camera is a clutch-import, not a tool pose
    const fistOverVid = k === 'fist' && vr && (() => {
      const w = hs.hands[0].wrist;
      return vr.left + w.x * vr.width > vr.left && vr.left + w.x * vr.width < vr.right &&
             vr.top + w.y * vr.height > vr.top && vr.top + w.y * vr.height < vr.bottom;
    })();
    if (!single || mouseMode || k === 'pinch' || cad.grabbed || fistOverVid) { _pose = -1; _poseSw = false; return; }
    const n = hs.hands[0].nExtAll ?? hs.hands[0].nExt;
    if (n !== _pose) { _pose = n; _poseT = now; _poseSw = false; return; }
    if (!_poseSw && now - _poseT > 350) {
      _poseSw = true;
      const t = POSE_TOOL[n];
      if (t && t !== cad.tool) setTool(t);
    }
  };

  /* voice commands — "drill", "box", "explode", "assemble"… opt-in via ?voice
     or the page's mic toggle (Chrome SpeechRecognition) */
  const WORD_TOOL = { select: 'select', point: 'select', box: 'box', block: 'box', cube: 'box',
    cylinder: 'cyl', tube: 'cyl', sphere: 'sphere', ball: 'sphere',
    cone: 'cone', pyramid: 'cone', drill: 'drill', hole: 'drill', punch: 'drill' };
  let _rec = null;
  const voice = () => {
    if (_rec) { try { _rec.stop(); } catch {} _rec = null; emit('x:voice', { on: false }); say('voice off'); return false; }
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { say('voice not supported here'); return false; }
    _rec = new SR(); _rec.continuous = true; _rec.interimResults = false; _rec.lang = 'en-US';
    _rec.onresult = e => {
      const w = [...e.results].pop()[0].transcript.toLowerCase().trim();
      emit('x:voice', { on: true, word: w });
      for (const [k, t] of Object.entries(WORD_TOOL))
        if (w.includes(k)) { setTool(t); return; }
      if (/explode|apart|break/.test(w)) cad.explode(1);
      else if (/assemble|together|build/.test(w)) cad.explode(0);
    };
    _rec.onend = () => { if (_rec) try { _rec.start(); } catch {} };
    try { _rec.start(); say('voice on — say a tool name'); emit('x:voice', { on: true }); }
    catch { _rec = null; return false; }
    return true;
  };
  if (params.has('voice')) voice();

  /* ---------- mouse emulation ---------- */
  const M = { p: null, pinch: false, orbiting: false, last: null };
  const mouseState = () => {
    if (!M.p) return { ok: false, hands: [], pinch: null, orbit: null, zoom: null, spread: null, point: null };
    const cur = { x: M.p.x / innerWidth, y: M.p.y / innerHeight };
    let orbit = null;
    if (M.orbiting && M.last)
      orbit = { x: cur.x, y: cur.y, dx: cur.x - M.last.x, dy: cur.y - M.last.y };
    return {
      ok: true, hands: [], point: cur,
      pinch: M.pinch ? cur : null, orbit, zoom: null, spread: null,
    };
  };
  if (mouseMode) {
    addEventListener('pointermove', e => { M.p = { x: e.clientX, y: e.clientY }; M.orbiting = e.shiftKey && e.buttons === 1; });
    addEventListener('pointerdown', e => { M.p = { x: e.clientX, y: e.clientY }; if (e.shiftKey) M.orbiting = true; else M.pinch = true; });
    addEventListener('pointerup', () => { M.pinch = false; M.orbiting = false; });
    addEventListener('wheel', e => { cad.orbitT.dist = Math.max(3.6, Math.min(12, cad.orbitT.dist + e.deltaY * .004)); }, { passive: true });
    addEventListener('keydown', e => { if (e.key === 'e' || e.key === 'E') cad.explode(cad.explodeGoal > .5 ? 0 : 1); });
  }

  /* ---------- scan → lock → materialize (declared before use) ---------- */
  const scan = { hit: null, hold: 0, phase: 'idle', ghostK: 0, lastLabel: null, clutch: false, miss: 0 };
  const STABLE_T = 850, CLUTCH_T = 380;   // clutching a held object scans 2× faster
  let det = null;

  function kindOf(label) {
    for (const [re, k] of KIND_OF) if (re.test(label)) return k;
    return 'box';
  }

  const SKIP_HIT = /^person$/;        // people are operators, not objects — never scan them
  const onHits = (hits) => {
    const top = hits.find(h => !SKIP_HIT.test(h.label));
    if (chip) {
      chip.innerHTML = top
        ? `<b>${top.label}</b><span>${Math.round(top.conf * 100)}%</span>`
        : `<span>scanning…</span>`;
      chip.dataset.hot = !!top;
    }
    emit('x:detect', hits);

    if (!top || scan.phase === 'forming') {
      // grace: brief detection gaps don't reset a scan in progress
      if (!top && scan.phase === 'scanning' && ++scan.miss > 2) { scan.hit = null; scan.hold = 0; scan.miss = 0; }
      return;
    }
    scan.miss = 0;
    if (scan.phase === 'idle' || scan.phase === 'scanning') {
      const same = scan.hit && scan.hit.label === top.label &&
        Math.abs(scan.hit.x - top.x) < .14 && Math.abs(scan.hit.y - top.y) < .14;
      scan.hit = top;
      scan.phase = 'scanning';
      scan.hold = same ? scan.hold + 1 : 1;       // polls, not ms
      const req = scan.clutch ? CLUTCH_T : STABLE_T;
      if (scan.hold * (det?.period || 420) > req) { scan.phase = 'forming'; scan.ghostK = 0; scan.lastLabel = top.label; }
    }
  };
  const wireDetect = (d) => { det = d; window.__det = d; d.on(onHits); };

  /* dimension helpers — map a marquee rect (video-normalized) to world units */
  let _pendingDims = null;
  const marqDims = (wPx, hPx) => {
    const wx = Math.min(2.4, Math.max(.25, wPx / 260));
    const hy = Math.min(2.4, Math.max(.3, hPx / 260));
    return { x: wx, y: hy, z: Math.min(wx, hy) * .9 };
  };
  const applyDims = (m, kind, d) => {
    if (kind === 'sphere') m.scale.setScalar(d.y);
    else if (kind === 'cyl' || kind === 'cone') m.scale.set(d.x, d.y, d.x);
    else m.scale.set(d.x, d.y, d.z);
    m.userData.baseScale?.copy(m.scale);
  };
  /* snapshot a raw-camera-space box from the live video → THREE texture.
     This is what makes an imported part look like YOUR actual item. */
  const snapTex = (b) => {
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !b) return null;
    const px = Math.max(0, b.x * vw | 0), py = Math.max(0, b.y * vh | 0);
    const pw = Math.max(16, Math.min(vw - px, b.w * vw | 0)),
          ph = Math.max(16, Math.min(vh - py, b.h * vh | 0));
    const c = document.createElement('canvas');
    c.width = pw; c.height = ph;
    c.getContext('2d').drawImage(video, px, py, pw, ph, 0, 0, pw, ph);
    const t = new THREE.CanvasTexture(c);
    if ('colorSpace' in t) t.colorSpace = THREE.SRGBColorSpace;
    return t;
  };

  const spawnSized = (kind, d, name, tex = null) => {
    const spot = cad.traySlotPos(); spot.y = 3.0;
    const m = cad.addPart(kind, spot, { name, tex });
    applyDims(m, kind, d);
    m.userData.dropFrom = 3.0; m.userData.dropTo = .55; m.userData.dropping = 0;
    emit('x:materialize', { label: name, kind, part: m });
    return m;
  };

  function materializeNow() {
    const hit = scan.hit; if (!hit) return;
    const kind = kindOf(hit.label);
    const spot = cad.traySlotPos(); spot.y = 3.0;
    const m = cad.addPart(kind, spot, { name: hit.label, tex: snapTex(hit) });
    if (_pendingDims) { applyDims(m, kind, _pendingDims); _pendingDims = null; }
    m.userData.dropFrom = 3.2; m.userData.dropTo = .55; m.userData.dropping = 0;
    m.userData.fromObject = hit.label;
    say(`materialized ${hit.label} → ${kind}`);
    emit('x:materialize', { label: hit.label, kind, part: m });
    scan.phase = 'idle'; scan.hit = null; scan.hold = 0;
  }

  /* ---------- camera + trackers ---------- */
  let hands = { state: { ok: false, hands: [] } };
  try {
    await cam(video);
    emit('x:camera', { on: true }); emit('x:camera-state', { on: true });
    say(video._baseline ? 'baseline video loop' : mouseMode ? 'camera on · mouse-emulating hand' : 'camera on — show your hand');
  } catch (e) {
    emit('x:camera', { on: false });
    say(mouseMode ? 'no camera — mouse mode' : 'camera blocked — allow it, or ?mouse to test');
  }
  if ((video.srcObject || video._baseline) && !mouseMode) {
    try {
      hands = await Hands.create(video, `${BASE}../vendor/mediapipe`);
      say('hand tracking live');
    } catch (e) { say('hand model failed — check vendor/mediapipe'); }
    try {
      wireDetect(await Detector.create(video, BASE, 420));
      say('detector live — hold an object up');
    } catch (e) { say('detector failed to load'); }
  } else if (mouseMode) {
    // still load the detector so the corner panel is real in tests
    if (video.srcObject) Detector.create(video, BASE, 900).then(wireDetect).catch(() => {});
  }

  /* ---------- hand overlay ---------- */
  const ov = overlay?.getContext('2d');
  const JOINTS = [[0,1],[1,2],[2,3],[3,4],[0,5],[5,6],[6,7],[7,8],[5,9],[9,10],[10,11],[11,12],
                  [9,13],[13,14],[14,15],[15,16],[13,17],[17,18],[18,19],[19,20],[0,17]];

  /* ---------- gesture HUD feed ---------- */
  let _lastCur = null, _speed = 0, _hudT = 0, _lastFrameT = performance.now(), _fps = 60;
  function hudTick(hs, now) {
    const cur = hs.pinch || hs.point || hs.orbit;
    const dt = Math.max(1, now - _lastFrameT); _lastFrameT = now;
    _fps = _fps * .9 + (1000 / dt) * .1;
    if (cur && _lastCur) {
      const v = Math.hypot(cur.x - _lastCur.x, cur.y - _lastCur.y) * innerWidth / (dt / 1000);
      _speed = _speed * .8 + v * .2;
    } else _speed *= .92;
    _lastCur = cur ? { x: cur.x, y: cur.y } : null;
    _hudT += dt;
    if (_hudT > 110) {
      _hudT = 0;
      const g = hs.zoom ? 'zoom' : hs.spread ? 'explode' : hs.pinch ? 'grab'
        : hs.orbit ? 'orbit' : hs.point ? 'point'
        : (hs.hands || []).map(h => h.kind).find(k => k !== 'other') || 'idle';
      emit('x:hud', { gesture: g, speed: Math.round(_speed), fps: Math.round(_fps),
        held: cad.grabbed?.userData?.name || null,
        scan: scan.phase, clutch: scan.clutch, det: det ? det.latest.length : null });
    }
  }

  /* ---------- marquee: drag a box/ellipse around the item in view ---------- */
  const marq = { on: false, x0: 0, y0: 0, x1: 0, y1: 0 };
  let _wasPinch = false;
  const marqTick = (pin, hs, vr) => {
    if (pin && !_wasPinch) {
      const vx = (pin.x * innerWidth - vr.left) / vr.width,
            vy = (pin.y * innerHeight - vr.top) / vr.height;
      if (vx > 0 && vx < 1 && vy > 0 && vy < 1) { marq.on = true; marq.x0 = marq.x1 = vx; marq.y0 = marq.y1 = vy; }
    }
    if (marq.on && pin) {
      marq.x1 = (pin.x * innerWidth - vr.left) / vr.width;
      marq.y1 = (pin.y * innerHeight - vr.top) / vr.height;
    }
    if (marq.on && !pin && !hs.zoom) { marq.on = false; finalizeMarquee(vr); }
    _wasPinch = !!pin;
  };
  function finalizeMarquee(vr) {
    const x = Math.min(marq.x0, marq.x1), y = Math.min(marq.y0, marq.y1);
    const w = Math.abs(marq.x1 - marq.x0), h = Math.abs(marq.y1 - marq.y0);
    if (w < .02 || h < .02) return;
    // marquee in raw camera coords (video is mirrored for display)
    const mr = { x: 1 - (x + w), y, w, h };
    let best = null, bi = 0;
    for (const d of (det?.latest || []).filter(d => !SKIP_HIT.test(d.label))) {
      const ix = Math.max(0, Math.min(mr.x + mr.w, d.x + d.w) - Math.max(mr.x, d.x));
      const iy = Math.max(0, Math.min(mr.y + mr.h, d.y + d.h) - Math.max(mr.y, d.y));
      const i = ix * iy, u = mr.w * mr.h + d.w * d.h - i;
      const iou = u ? i / u : 0;
      if (iou > bi) { bi = iou; best = d; }
    }
    const dims = marqDims(w * vr.width, h * vr.height);
    if (best && bi > .12) {
      // user framed a detected object — skip the hold, form it at marquee size
      scan.hit = best; scan.phase = 'forming'; scan.ghostK = 0; scan.lastLabel = best.label;
      _pendingDims = dims;
      say(`locked ${best.label} — forming`);
      emit('x:marquee', { label: best.label, conf: best.conf });
    } else {
      const kind = cad.tool !== 'select' && cad.tool !== 'drill' ? cad.tool : 'box';
      spawnSized(kind, dims, 'custom');
      say(`sketched ${kind} — drag to the bench`);
      emit('x:marquee', { kind, custom: true });
    }
  }

  /* ---------- clutch import: hold a fist over an item ~450 ms and it pulls
     a snapshot of what's under your hand into the tray, textured for real. */
  const clutch = { t: 0, done: false, hand: null, k: 0 };
  const clutchTick = (hs, vr) => {
    const f = hs.hands?.find(h => h.kind === 'fist');
    // fist must be over the camera view, not over the bench
    const inVid = f && vr &&
      vr.left + f.wrist.x * vr.width < vr.right && vr.top + f.wrist.y * vr.height < vr.bottom &&
      vr.left + f.wrist.x * vr.width > vr.left && vr.top + f.wrist.y * vr.height > vr.top;
    if (!f || !inVid || mouseMode) { clutch.t = 0; clutch.done = false; clutch.hand = null; clutch.k = 0; return; }
    clutch.hand = f;
    if (clutch.done) return;
    if (!clutch.t) { clutch.t = performance.now(); return; }
    clutch.k = (performance.now() - clutch.t) / 450;
    if (clutch.k < 1) return;
    clutch.done = true;
    // raw-camera bbox of the fist landmarks, padded → that's the held item
    let x0 = 1, y0 = 1, x1 = 0, y1 = 0;
    for (const l of f.lm) { x0 = Math.min(x0, l.x); y0 = Math.min(y0, l.y); x1 = Math.max(x1, l.x); y1 = Math.max(y1, l.y); }
    const pad = .07;
    const box = { x: Math.max(0, x0 - pad), y: Math.max(0, y0 - pad) };
    box.w = Math.min(1 - box.x, x1 + pad - box.x); box.h = Math.min(1 - box.y, y1 + pad - box.y);
    let best = null, bi = 0;
    for (const d of (det?.latest || []).filter(d => !SKIP_HIT.test(d.label))) {
      const ix = Math.max(0, Math.min(box.x + box.w, d.x + d.w) - Math.max(box.x, d.x));
      const iy = Math.max(0, Math.min(box.y + box.h, d.y + d.h) - Math.max(box.y, d.y));
      const i = ix * iy, u = box.w * box.h + d.w * d.h - i;
      const iou = u ? i / u : 0;
      if (iou > bi) { bi = iou; best = d; }
    }
    const label = best?.label ?? 'object';
    const kind = best ? kindOf(best.label) : 'box';
    const dims = marqDims(box.w * vr.width, box.h * vr.height);
    const m = spawnSized(kind, dims, label, snapTex(box));
    m.userData.fromObject = label;
    say(`clutch-imported ${label} → ${kind}`);
    emit('x:clutch', { label, kind });
  };

  /* displayed video sub-rect — the feed uses object-fit:cover, so the visible
     image is scaled/cropped inside the element. Gloves, reticles and marquee
     coords must map through THIS rect or they drift off the real picture. */
  const vidRect = () => {
    const er = video.getBoundingClientRect();
    const vw = video.videoWidth || 16, vh = video.videoHeight || 9;
    const va = vw / vh, ea = er.width / er.height;
    let dw = er.width, dh = er.height, dx = 0, dy = 0;
    if (va > ea) { dw = er.height * va; dx = (er.width - dw) / 2; }
    else { dh = er.width / va; dy = (er.height - dh) / 2; }
    return { left: er.left + dx, top: er.top + dy, width: dw, height: dh };
  };

  function frame() {
    requestAnimationFrame(frame);
    const hs = window.__forceHands || (mouseMode ? mouseState() : hands.state);
    const vrNow = vidRect();
    poseToolTick(hs, performance.now(), vrNow);
    /* hand roles — LEFT pinches over the camera import objects; RIGHT pinch
       drags parts on the bench. Falls back to any pinch when sides unknown. */
    const sideKnown = hs.hands?.some(h => h.side);
    const pinchAt = (s) => hs.hands?.find(h => h.side === s && h.kind === 'pinch')?.pinchAt;
    const marqPinch = sideKnown ? pinchAt('left') : hs.pinch;
    const cadPinch = sideKnown ? pinchAt('right') : hs.pinch;
    marqTick(marqPinch, hs, vrNow);
    clutchTick(hs, vrNow);
    cad.feed(marq.on ? { ...hs, pinch: null } : { ...hs, pinch: cadPinch }, { w: innerWidth, h: innerHeight });
    M.last = M.p ? { x: M.p.x / innerWidth, y: M.p.y / innerHeight } : null;
    hudTick(hs, performance.now());
    if (!ov || !overlay) return;
    const r = overlay.getBoundingClientRect();
    if (overlay.width !== r.width) { overlay.width = r.width; overlay.height = r.height; }
    ov.clearRect(0, 0, r.width, r.height);

    // displayed video rect → where detections land on screen (video is mirrored)
    const vr = vrNow;
    const detBox = (h) => {
      const bx = vr.left + (1 - h.x - h.w) * vr.width;            // mirrored
      return { x: bx, y: vr.top + h.y * vr.height, w: h.w * vr.width, h: h.h * vr.height };
    };

    /* --- clutch cue: hand landmarks wrapped around the detected object --- */
    scan.clutch = false;
    if (scan.hit && (hs.hands || []).length) {
      for (const hnd of hs.hands) {
        let inside = 0;
        for (const lm of hnd.lm)
          if (lm.x > scan.hit.x && lm.x < scan.hit.x + scan.hit.w &&
              lm.y > scan.hit.y && lm.y < scan.hit.y + scan.hit.h) inside++;
        if (inside >= 5) { scan.clutch = true; break; }
      }
    }

    /* --- detection scan reticle --- */
    if (scan.hit && scan.phase !== 'idle') {
      const b = detBox(scan.hit), now = performance.now();
      const req = scan.clutch ? CLUTCH_T : STABLE_T;
      const prog = Math.min(1, scan.hold * (det?.period || 420) / req);
      // corner brackets
      ov.strokeStyle = scan.phase === 'forming' || scan.clutch ? '#4f8f6b' : '#d85c3a';
      ov.lineWidth = 2.5;
      const L = Math.min(18, b.w * .2, b.h * .2), pad = -4;
      for (const [cx, cy, sx, sy] of [[b.x + pad, b.y + pad, 1, 1], [b.x + b.w - pad, b.y + pad, -1, 1],
                                     [b.x + pad, b.y + b.h - pad, 1, -1], [b.x + b.w - pad, b.y + b.h - pad, -1, -1]]) {
        ov.beginPath(); ov.moveTo(cx + L * sx, cy); ov.lineTo(cx, cy); ov.lineTo(cx, cy + L * sy); ov.stroke();
      }
      // clutch cue: pulsing ring + label over the held item
      if (scan.clutch && scan.phase === 'scanning') {
        const cxp = b.x + b.w / 2, cyp = b.y + b.h / 2;
        const pk = (now / 700) % 1;
        ov.strokeStyle = `rgba(79,143,107,${1 - pk})`; ov.lineWidth = 2;
        ov.beginPath(); ov.arc(cxp, cyp, 14 + pk * 26, 0, 7); ov.stroke();
        ov.fillStyle = '#4f8f6b'; ov.font = '600 10px system-ui';
        ov.fillText('IN HAND — HOLD STEADY', b.x + pad + 2, b.y + pad - 8);
      }
      // sweeping scanline while locking
      if (scan.phase === 'scanning') {
        const sy = b.y + ((now / 900) % 1) * b.h;
        const g = ov.createLinearGradient(0, sy - 14, 0, sy + 14);
        g.addColorStop(0, 'rgba(216,92,58,0)'); g.addColorStop(.5, 'rgba(216,92,58,.5)'); g.addColorStop(1, 'rgba(216,92,58,0)');
        ov.fillStyle = g; ov.fillRect(b.x, sy - 14, b.w, 28);
        ov.strokeStyle = 'rgba(216,92,58,.9)'; ov.lineWidth = 1;
        ov.strokeRect(b.x + pad, b.y + pad, b.w - pad * 2, b.h - pad * 2);
        // progress pip-strip under the box
        ov.fillStyle = scan.clutch ? 'rgba(79,143,107,.9)' : 'rgba(216,92,58,.85)';
        ov.fillRect(b.x + pad, b.y + b.h + 8, (b.w - pad * 2) * prog, 3);
      }
      // ghost primitive forming over the object
      if (scan.phase === 'forming') {
        scan.ghostK += 1 / 45;
        const k = Math.min(1, scan.ghostK);
        const kind = kindOf(scan.lastLabel);
        ov.save();
        ov.translate(b.x + b.w / 2, b.y + b.h / 2);
        ov.strokeStyle = `rgba(79,143,107,${.25 + k * .75})`;
        ov.setLineDash([10 * k + 2, 8 - 6 * k]); ov.lineWidth = 2.5;
        const rw = b.w * .5, rh = b.h * .5;
        ov.beginPath();
        if (kind === 'sphere') ov.arc(0, 0, Math.min(rw, rh) * 1.06, -Math.PI / 2, -Math.PI / 2 + k * 7);
        else if (kind === 'cyl') { ov.ellipse(0, -rh * .55, rw * .75, rh * .18, 0, Math.PI, Math.PI + k * Math.PI); ov.rect(-rw * .75 * Math.min(1, k * 2), -rh * .55, rw * 1.5 * Math.min(1, k * 2), rh * 1.1 * k); ov.ellipse(0, rh * .55 * k, rw * .75, rh * .18, 0, 0, Math.PI * k); }
        else ov.rect(-rw * Math.min(1, k * 1.4), -rh * Math.min(1, k * 1.4), rw * 2 * Math.min(1, k), rh * 2 * Math.min(1, k));
        ov.stroke();
        ov.setLineDash([]);
        ov.fillStyle = `rgba(79,143,107,${k * .16})`;
        ov.fillRect(-rw, -rh, rw * 2, rh * 2);
        ov.restore();
        ov.font = '11px monospace'; ov.fillStyle = '#4f8f6b';
        ov.fillText(`${scan.lastLabel} → ${kind}`, b.x, b.y - 10);
        if (k >= 1) materializeNow();
      }
    }

    /* --- clutch hold ring: fills over 450 ms while a fist hovers the view --- */
    if (clutch.hand && clutch.k > 0 && !clutch.done) {
      const f = clutch.hand;
      const cx = vr.left + f.palm.x * vr.width, cy = vr.top + f.palm.y * vr.height;
      ov.strokeStyle = 'rgba(51,41,29,.4)'; ov.lineWidth = 5;
      ov.beginPath(); ov.arc(cx, cy, 30, 0, 7); ov.stroke();
      ov.strokeStyle = GRN; ov.lineWidth = 5;
      ov.beginPath(); ov.arc(cx, cy, 30, -Math.PI / 2, -Math.PI / 2 + clutch.k * 7); ov.stroke();
      tag('CLUTCH TO IMPORT', cx, cy - 46, GRN);
    }

    /* --- marquee: the box/ellipse the user is dragging over the video --- */
    if (marq.on) {
      const ax = vr.left + Math.min(marq.x0, marq.x1) * vr.width,
            ay = vr.top + Math.min(marq.y0, marq.y1) * vr.height,
            aw = Math.abs(marq.x1 - marq.x0) * vr.width,
            ah = Math.abs(marq.y1 - marq.y0) * vr.height;
      const circ = ['cyl', 'sphere', 'cone'].includes(cad.tool);
      ov.strokeStyle = '#33291d'; ov.lineWidth = 1.8; ov.setLineDash([7, 5]);
      ov.beginPath();
      if (circ) ov.ellipse(ax + aw / 2, ay + ah / 2, aw / 2, ah / 2, 0, 0, 7);
      else ov.rect(ax, ay, aw, ah);
      ov.stroke(); ov.setLineDash([]);
      ov.fillStyle = 'rgba(243,237,225,.16)';
      if (circ) { ov.beginPath(); ov.ellipse(ax + aw / 2, ay + ah / 2, aw / 2, ah / 2, 0, 0, 7); ov.fill(); }
      else ov.fillRect(ax, ay, aw, ah);
      ov.font = '600 9.5px system-ui';
      const label = (cad.tool === 'select' ? 'scan' : cad.tool) + ' — release to create';
      const tw = ov.measureText(label).width + 16;
      ov.fillStyle = 'rgba(243,237,225,.94)'; ov.strokeStyle = '#33291d'; ov.lineWidth = 1.2;
      ov.beginPath(); ov.roundRect(ax + aw / 2 - tw / 2, ay - 22, tw, 19, 9); ov.fill(); ov.stroke();
      ov.fillStyle = '#33291d'; ov.textAlign = 'center';
      ov.fillText(label, ax + aw / 2, ay - 8.5); ov.textAlign = 'left';
    }

    /* --- gloved hands + gesture cues (landmarks live in video space) --- */
    const hp = (i, lm) => ({ x: vr.right - lm[i].x * vr.width, y: vr.top + lm[i].y * vr.height });
    const GRN = '#4f8f6b';
    const tag = (txt, x, y, col) => {
      ov.font = '600 9.5px system-ui';
      const w = ov.measureText(txt).width + 16;
      ov.fillStyle = 'rgba(243,237,225,.94)';
      ov.strokeStyle = col; ov.lineWidth = 1.2;
      ov.beginPath(); ov.roundRect(x - w / 2, y - 10, w, 19, 9); ov.fill(); ov.stroke();
      ov.fillStyle = col; ov.textAlign = 'center'; ov.fillText(txt, x, y + 3.5); ov.textAlign = 'left';
    };
    for (const hnd of hs.hands || []) {
      const P = Array.from({ length: 21 }, (_, i) => hp(i, hnd.lm));
      drawGlove(ov, P, {
        kind: hnd.kind, side: hnd.side, tool: cad.tool,
        pinchAt: hnd.pinchAt
          ? { x: vr.left + hnd.pinchAt.x * vr.width, y: vr.top + hnd.pinchAt.y * vr.height }
          : null,
      });
    }
    // two-hand link lines
    const handPt = (h) => ({ x: vr.left + (h.pinchAt || h.palm).x * vr.width, y: vr.top + (h.pinchAt || h.palm).y * vr.height });
    if ((hs.zoom || hs.spread) && (hs.hands || []).length === 2) {
      const a = handPt(hs.hands[0]), b2 = handPt(hs.hands[1]);
      const zooming = !!hs.zoom;
      ov.strokeStyle = zooming ? '#5c7fbf' : GRN; ov.lineWidth = 1.6;
      ov.setLineDash([5, 5]); ov.beginPath(); ov.moveTo(a.x, a.y); ov.lineTo(b2.x, b2.y); ov.stroke(); ov.setLineDash([]);
      tag(zooming ? 'ZOOM' : 'EXPLODE', (a.x + b2.x) / 2, (a.y + b2.y) / 2 - 16, zooming ? '#5c7fbf' : GRN);
      for (const p of [a, b2]) { ov.beginPath(); ov.arc(p.x, p.y, 5, 0, 7); ov.fillStyle = zooming ? '#5c7fbf' : GRN; ov.fill(); }
    }

    /* --- interaction cursor (window space, already mirrored) --- */
    const px = (p) => ({ x: p.x * r.width, y: p.y * r.height });
    const cur = hs.pinch || hs.point;
    if (cur) {
      const p = px(cur);
      ov.beginPath(); ov.arc(p.x, p.y, hs.pinch ? 13 : 9, 0, 7);
      ov.strokeStyle = hs.pinch ? '#d85c3a' : 'rgba(58,49,40,.9)';
      ov.lineWidth = hs.pinch ? 3 : 2; ov.stroke();
      if (hs.pinch) { ov.beginPath(); ov.arc(p.x, p.y, 4, 0, 7); ov.fillStyle = '#d85c3a'; ov.fill(); }
    }
    if (hs.zoom) { ov.strokeStyle = '#5c7fbf'; ov.beginPath(); ov.arc(hs.zoom.cx * r.width, hs.zoom.cy * r.height, 18, 0, 7); ov.stroke(); }
  }
  frame();

  const app = { cad, hands, det, video, say, setTool, voice };
  window.__spatial = app;
  emit('x:ready', app);
  return app;
}
