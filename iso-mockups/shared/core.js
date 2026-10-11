/* iso-mockups/shared/core.js — shared engine for the roster-isolation mockups.
   One blank plane, every character on it, orbit/zoom/pan + focus + poses.
   Each theme calls initIso(opts) and only supplies look-and-feel.

   const iso = initIso({ bg, floor, fog, lights(scene), dress(scene,x,i,meta),
                         tagFmt(i,meta), tagClass, cam });
   iso = { scene, cam, ren, chars, meta, ctl, focus, fitAll, setPose,
           toggleBoxes, toggleSpin, addTick, POSES } */
import * as THREE from 'three';
import { buildBoxer, VARIANTS, VARIANT_INFO } from '../../shared/boxing/protoBoxer.js';

export const POSES = ['idle', 'windup', 'jab', 'cross', 'hook', 'upper', 'block',
  'hurt', 'down', 'celebrate', 'stunned', 'whiff'];

/* the roster: every proto variant + the player avatar (playerLook build) */
export const ROSTER = [
  ...VARIANTS.map(v => ({ id: v, label: VARIANT_INFO[v]?.label || v,
    opts: { variant: v } })),
  { id: 'you', label: 'YOU (player)', opts: { variant: 'bubble', playerLook: true,
    palette: { skin: 0xeebd91, skinShade: 0xce9673, skinLight: 0xf5cba3,
      shorts: 0x354d7a, trim: 0xffe9b8, leaf: 0xffc53d,
      glove: 0xff6b57, gloveDeep: 0xb43f39, gloveShine: 0xffa18c } } },
];

export function initIso(o = {}) {
  const view = { w: innerWidth, h: innerHeight };
  const ren = new THREE.WebGLRenderer({ antialias: true });
  ren.setSize(view.w, view.h); ren.setPixelRatio(devicePixelRatio);
  if (o.shadows) {
    ren.shadowMap.enabled = true;
    ren.shadowMap.type = THREE.PCFSoftShadowMap;
  }
  document.body.appendChild(ren.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(o.bg ?? 0xe8e6e1);
  if (o.fog) scene.fog = new THREE.Fog(o.fog.color ?? o.bg ?? 0xe8e6e1,
    o.fog.near ?? 8, o.fog.far ?? 24);
  const cam = new THREE.PerspectiveCamera(42, view.w / view.h, .02, 120);

  if (o.lights) o.lights(scene, THREE);
  else {
    scene.add(new THREE.HemisphereLight(0xfff3d8, 0x6a6258, 1.45));
    const k = new THREE.DirectionalLight(0xfff0d0, 1.5);
    k.position.set(2.5, 4, 3); scene.add(k);
  }

  /* blank plane */
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(220, 220),
    new THREE.MeshLambertMaterial({ color: o.floor ?? 0xdcd9d2 }));
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = !!o.shadows;
  scene.add(floor);
  if (o.grid !== null) {
    const g = o.grid instanceof THREE.Object3D ? o.grid
      : new THREE.GridHelper(40, 160, 0xbfbab0, 0xcfccc4);
    g.position.y = .001;
    scene.add(g);
    var gridObj = g;
  }

  /* roster row */
  const GAP = o.gap ?? 1.6, X0 = -(ROSTER.length - 1) * GAP / 2;
  const chars = [], meta = [], tags = [], boxes = [];
  const box = new THREE.Box3();
  for (let i = 0; i < ROSTER.length; i++) {
    const r = ROSTER[i], x = X0 + i * GAP;
    const b = buildBoxer(THREE, r.opts);
    b.group.position.set(x, 0, 0);
    b.snap('idle', 0);
    if (o.shadows) b.group.traverse(m => { if (m.isMesh) m.castShadow = true; });
    scene.add(b.group);
    b.group.updateMatrixWorld(true);
    box.setFromObject(b.group);
    const m = { i, r, x, h: box.max.y - box.min.y, w: box.max.x - box.min.x,
      top: box.max.y, box: box.clone() };
    meta.push(m); chars.push(b);
    o.dress?.(scene, x, i, m, THREE);
    if (o.tags !== false) {
      const t = document.createElement('div');
      t.className = o.tagClass || 'tag';
      const parts = (o.tagFmt || defaultFmt)(i, m);
      t.innerHTML = `<div class="n">${parts[0]}</div>` +
        (parts[1] ? `<div class="s">${parts[1]}</div>` : '');
      document.body.appendChild(t);
      tags.push({ el: t, obj: b.group, lift: m.top + (o.tagLift ?? .14) });
    }
    console.log(`[iso] ${r.label}: h ${m.h.toFixed(3)}u w ${m.w.toFixed(3)} ` +
      `top ${m.top.toFixed(3)}`);
  }
  function defaultFmt(i, m) {
    return [`${i + 1} · ${m.r.label}`, `bbox ${m.h.toFixed(3)}u · top ${m.top.toFixed(3)}`];
  }

  /* ---- camera: orbit / zoom / pan ---- */
  const ctl = { theta: .35, phi: 1.25,
    rad: Math.max(3.6, ROSTER.length * GAP * .8), tgt: new THREE.Vector3(0, .7, 0),
    ...(o.cam || {}) };
  if (o.cam?.tgt) ctl.tgt = new THREE.Vector3(...o.cam.tgt);
  const home = { theta: ctl.theta, phi: ctl.phi, rad: ctl.rad, tgt: ctl.tgt.clone() };
  function applyCam() {
    ctl.phi = Math.max(.06, Math.min(1.54, ctl.phi));
    ctl.rad = Math.max(.2, Math.min(40, ctl.rad));
    const sp = Math.sin(ctl.phi);
    cam.position.set(
      ctl.tgt.x + ctl.rad * sp * Math.sin(ctl.theta),
      ctl.tgt.y + ctl.rad * Math.cos(ctl.phi),
      ctl.tgt.z + ctl.rad * sp * Math.cos(ctl.theta));
    cam.lookAt(ctl.tgt);
  }
  const cv = ren.domElement;
  let drag = null, moved = 0;
  cv.addEventListener('pointerdown', e => {
    moved = 0;
    drag = { x: e.clientX, y: e.clientY, pan: e.button === 2 || e.shiftKey };
    cv.setPointerCapture(e.pointerId);
  });
  cv.addEventListener('pointermove', e => {
    if (!drag) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    moved += Math.abs(dx) + Math.abs(dy);
    drag.x = e.clientX; drag.y = e.clientY;
    if (drag.pan) {
      const k = ctl.rad * .0016;
      const right = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 0);
      const up = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 1);
      ctl.tgt.addScaledVector(right, -dx * k).addScaledVector(up, dy * k);
    } else { ctl.theta -= dx * .0055; ctl.phi -= dy * .0055; }
    applyCam();
  });
  addEventListener('pointerup', () => drag = null);
  cv.addEventListener('wheel', e => {
    e.preventDefault(); ctl.rad *= Math.pow(1.0015, e.deltaY); applyCam();
  }, { passive: false });
  cv.addEventListener('contextmenu', e => e.preventDefault());
  cv.addEventListener('dblclick', fitAll);

  const ray = new THREE.Raycaster(), ptr = new THREE.Vector2();
  cv.addEventListener('click', e => {
    if (moved > 6) return;
    ptr.set(e.clientX / view.w * 2 - 1, -(e.clientY / view.h) * 2 + 1);
    ray.setFromCamera(ptr, cam);
    for (let i = 0; i < chars.length; i++)
      if (ray.intersectObject(chars[i].group, true).length) return focus(i);
  });
  function focus(i) {
    box.setFromObject(chars[i].group);
    const c = box.getCenter(new THREE.Vector3());
    ctl.tgt.copy(c);
    ctl.rad = Math.max(1.1, (box.max.y - box.min.y) * 1.9);
    applyCam(); return i;
  }
  function fitAll() {
    ctl.theta = home.theta; ctl.phi = home.phi; ctl.rad = home.rad;
    ctl.tgt.copy(home.tgt); applyCam();
  }
  addEventListener('keydown', e => {
    if (e.key === '0') fitAll();
    else if (e.key === 'b') api.toggleBoxes();
    else if (e.key === 'g' && gridObj) gridObj.visible = !gridObj.visible;
    else if (e.key >= '1' && e.key <= String(ROSTER.length)) focus(+e.key - 1);
  });
  addEventListener('resize', () => {
    view.w = innerWidth; view.h = innerHeight;
    ren.setSize(view.w, view.h);
    cam.aspect = view.w / view.h; cam.updateProjectionMatrix();
    applyCam();
  });

  function setPose(p, t01 = 0) { for (const b of chars) b.pose(p, t01); }

  /* bbox wireframes — the size-check tool */
  let boxesOn = false;
  function toggleBoxes(force) {
    boxesOn = force ?? !boxesOn;
    if (boxesOn && !boxes.length)
      for (const c of chars) {
        const h = new THREE.Box3Helper(new THREE.Box3(), o.boxColor ?? 0x33ff66);
        scene.add(h); boxes.push(h);
      }
    for (const h of boxes) h.visible = boxesOn;
  }

  /* per-frame hooks + loop */
  const hooks = [];
  let spin = false;
  const v = new THREE.Vector3();
  let last = performance.now(), boxAcc = 0;
  (function loop() {
    requestAnimationFrame(loop);
    const now = performance.now(), dt = Math.min(.1, (now - last) / 1000); last = now;
    for (const b of chars) {
      if (spin) b.group.rotation.y += dt * .6;
      b.tick(dt, {});
    }
    if (boxesOn && (boxAcc += dt) > .2) {
      boxAcc = 0;
      for (let i = 0; i < chars.length; i++)
        boxes[i].box.setFromObject(chars[i].group);
    }
    for (const t of tags) {
      v.setFromMatrixPosition(t.obj.matrixWorld); v.y = t.lift;
      v.project(cam);
      const vis = v.z > -1 && v.z < 1;
      t.el.style.display = vis ? '' : 'none';
      if (vis) {
        t.el.style.left = (v.x + 1) * view.w * .5 + 'px';
        t.el.style.top = (1 - v.y) * view.h * .5 + 'px';
      }
    }
    for (const f of hooks) f(dt, now / 1000);
    ren.render(scene, cam);
  })();
  applyCam();

  const api = { THREE, scene, cam, ren, chars, meta, ctl, applyCam, focus,
    fitAll, setPose, toggleBoxes, grid: gridObj, floor,
    toggleSpin(f) { spin = f ?? !spin; return spin; },
    addTick: f => hooks.push(f), POSES, ROSTER };
  window.__iso = api;
  return api;
}
