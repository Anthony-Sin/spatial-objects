/* shared/cad.js — gesture-driven 3D CAD bench.

   const cad = new CADScene(canvas, opts);  cad.start();

   Scene: a small assembled object on a warm beige bench + loose primitive
   blocks. All geometry is real THREE geometry; drilling uses real CSG
   subtraction (three-bvh-csg) — pick the drill tool, pinch on a round part,
   and a hole is physically cut through it.

   Gesture map (fed from shared/hands.js state, or mouse in ?mouse mode):
     hover (point/mouse move)        → raycast highlight
     pinch / mouse-drag on a part    → grab & drag it on the bench plane
     open-palm drag / shift-drag     → orbit camera
     two-pinch spread / wheel        → dolly in-out
     two palms spread / key E        → explode ↔ assemble (analog: dd delta)
     pinch on empty space            → nothing (selection stays)

   API:
     cad.setTool('select'|'drill'|'box'|'cyl'|'sphere'|'cone')
     cad.explode(t01) / cad.exploded
     cad.feed(handsState, viewportEl)   // call every frame from ui.js
     cad.on('part-add'|'grab'|'drop'|'drill'|'explode', fn)
     window.__cad.debug()               // state for tests
*/
import * as THREE from 'three';
import { Brush, Evaluator, SUBTRACTION } from 'three-bvh-csg';

const TAN = 0xe8dfd0, INK = 0x3a3128, ACCENT = 0xd85c3a;

const PRIMS = {
  box:      () => new THREE.BoxGeometry(1, 1, 1),
  cyl:      () => new THREE.CylinderGeometry(.5, .5, 1, 40),
  sphere:   () => new THREE.SphereGeometry(.55, 40, 28),
  cone:     () => new THREE.ConeGeometry(.5, 1, 40),
  capsule:  () => new THREE.CapsuleGeometry(.4, .6, 8, 24),
};
const PALETTE = [0xd85c3a, 0xe6a13c, 0x4f8f6b, 0x5c7fbf, 0x9a6fbf, 0xc9b99a];

export default class CADScene {
  constructor(canvas, opts = {}) {
    this.cv = canvas;
    this.opts = opts;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(opts.bg ?? 0xf3ede1);

    this.camera = new THREE.PerspectiveCamera(38, 1, .1, 100);
    this.target = new THREE.Vector3(0, .6, 0);
    this.orbit = { theta: Math.PI * .24, phi: .9, dist: 7.4 };
    this.orbitT = { ...this.orbit };

    // light — warm studio
    this.scene.add(new THREE.HemisphereLight(0xfff6e6, 0x8f8574, 1.05));
    const sun = new THREE.DirectionalLight(0xffeedd, 2.1);
    sun.position.set(4, 7, 3); sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.left = sun.shadow.camera.bottom = -7;
    sun.shadow.camera.right = sun.shadow.camera.top = 7;
    this.scene.add(sun);
    const fill = new THREE.DirectionalLight(0xdfe8ff, .4);
    fill.position.set(-5, 4, -4);
    this.scene.add(fill);

    // bench: soft disc + hairline grid
    const bench = new THREE.Mesh(
      new THREE.CylinderGeometry(4.6, 4.8, .18, 72),
      new THREE.MeshStandardMaterial({ color: 0xefe6d6, roughness: .95 }));
    bench.position.y = -.09; bench.receiveShadow = true;
    this.scene.add(bench);
    const grid = new THREE.PolarGridHelper(4.55, 12, 6, 96, 0xcbbfa8, 0xdcd2bd);
    grid.position.y = .006;
    grid.material.transparent = true; grid.material.opacity = .5;
    this.scene.add(grid);

    // parts tray — pickup zone on the bench's right/front edge. Materialized
    // objects and spare blocks live here so the center stays clear.
    const t = this.tray = { x0: 1.8, x1: 3.15, z0: .5, z1: 1.9, cols: 3, rows: 3 };
    const tline = new THREE.LineLoop(
      new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(t.x0, .015, t.z0), new THREE.Vector3(t.x1, .015, t.z0),
        new THREE.Vector3(t.x1, .015, t.z1), new THREE.Vector3(t.x0, .015, t.z1)]),
      new THREE.LineDashedMaterial({ color: 0xa99c82, dashSize: .1, gapSize: .08, transparent: true, opacity: .9 }));
    tline.computeLineDistances();
    this.scene.add(tline);
    this._traySlot = 0;

    this.parts = new THREE.Group(); this.scene.add(this.parts);
    this._cbs = {}; this.tool = 'select';
    this.explodeT = 0; this.explodeGoal = 0;
    this.hover = null; this.grabbed = null;
    this._ray = new THREE.Raycaster();
    this._plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    this._dragY = 0;
    this._buildAssembly();
    this.resize();
    new ResizeObserver(() => this.resize()).observe(canvas.parentElement || canvas);
  }

  /* ---------- stock ---------- */
  _mat(hex) { return new THREE.MeshStandardMaterial({ color: hex, roughness: .62, metalness: .04 }); }

  addPart(kind, pos, { hex, scale = 1, home = null, name, tex } = {}) {
    const g = PRIMS[kind]();
    const mat = tex
      ? new THREE.MeshStandardMaterial({ map: tex, roughness: .82, metalness: .05 })
      : this._mat(hex ?? PALETTE[this.parts.children.length % PALETTE.length]);
    const m = new THREE.Mesh(g, mat);
    m.castShadow = m.receiveShadow = true;
    m.frustumCulled = false;   // few parts, always near camera — skip culling
    m.position.copy(pos);
    m.scale.setScalar(scale);
    m.userData = {
      kind, name: name || kind,
      home: home ? { pos: home.pos.clone(), rot: home.rot.clone() } : { pos: pos.clone(), rot: m.rotation.clone() },
      // explode direction: radial from assembly center + up bias
      ed: pos.clone().setY(0).normalize().multiplyScalar(1.4).add(new THREE.Vector3(0, .8 + Math.abs(pos.x) * .2, 0)),
    };
    m.userData.ed.normalize();
    m.userData._ph = Math.random() * Math.PI * 2;  // levitation phase
    this.parts.add(m);
    this._emit('part-add', m);
    return m;
  }

  _buildAssembly() {
    // a little interlocking "camera rig" assembly: base plate, block, cyl
    // post, sleeve, knob — explodes apart radially; center stays put.
    const A = [];
    A.push(this.addPart('box', new THREE.Vector3(0, .25, 0), { hex: 0xc9b99a, scale: 1, name: 'base plate' }));
    A[0].scale.set(2.4, .5, 1.7);
    const b = this.addPart('box', new THREE.Vector3(-.7, .8, 0), { hex: 0xd85c3a, name: 'block' });
    b.scale.set(.9, .6, .9);
    const c = this.addPart('cyl', new THREE.Vector3(.75, .95, 0), { hex: 0x4f8f6b, name: 'post' });
    c.scale.set(.6, 1.4, .6);
    const s = this.addPart('cyl', new THREE.Vector3(.75, .95, 0), { hex: 0xe6a13c, name: 'sleeve' });
    s.scale.set(.95, .5, .95); s.userData.ed.y += .8;
    const k = this.addPart('sphere', new THREE.Vector3(.75, 1.95, 0), { hex: 0x5c7fbf, name: 'knob' });
    k.scale.setScalar(.62); k.userData.ed.y += 1.1;
    const side = this.addPart('capsule', new THREE.Vector3(-1.35, .55, .45), { hex: 0x9a6fbf, name: 'handle' });
    side.rotation.z = .5; side.scale.setScalar(.55);
    side.userData.ed.set(-1.6, .5, .8).normalize();
    // keep base centered during explode
    A[0].userData.ed.set(0, -.15, 0);
    // a few loose blocks staged in the tray, ready to pick up
    const p1 = this.addPart('box', this.traySlotPos(), { hex: 0xc9b99a, scale: .55, name: 'spare cube' });
    p1.rotation.y = .4; p1.position.y = .28; p1.userData.home.pos.y = .28;
    const p2 = this.addPart('cyl', this.traySlotPos(), { hex: 0xc9b99a, scale: .55, name: 'spare puck' });
    p2.position.y = .3; p2.userData.home.pos.y = .3;
  }

  /* next open slot in the tray (right/front pickup zone) */
  traySlotPos() {
    const t = this.tray, i = this._traySlot++;
    const col = i % t.cols, row = Math.floor(i / t.cols) % t.rows;
    return new THREE.Vector3(
      t.x0 + .25 + col * ((t.x1 - t.x0 - .5) / (t.cols - 1)),
      .5,
      t.z0 + .3 + row * ((t.z1 - t.z0 - .6) / (t.rows - 1)));
  }

  /* ---------- gestures ---------- */
  feed(h, vp) {
    // h = Hands.state (normalized coords). Map to NDC over the canvas rect.
    // hand coords are normalized 0–1 over the WINDOW; map to canvas NDC
    const r = this.cv.getBoundingClientRect();
    const W = vp?.w || innerWidth, H = vp?.h || innerHeight;
    const ndc = (p) => ({
      x: ((p.x * W - r.left) / r.width) * 2 - 1,
      y: -(((p.y * H - r.top) / r.height) * 2 - 1) });
    const cursor = h.pinch || h.point || h.orbit || null;
    if (cursor && !this.grabbed) {
      const p = ndc(cursor);
      this._pick(p);
    } else if (!cursor) this.hover = null;

    // pinch → grab / tool apply
    if (h.pinch && !this._pinching) {
      this._pinching = true;
      const p = ndc(h.pinch);
      this._pinchStart(p);
    }
    if (h.pinch && this.grabbed) {
      const p = ndc(h.pinch);
      const hit = new THREE.Vector3();
      this._ray.setFromCamera(p, this.camera);
      if (this.explodeT > .3) {
        // exploded: free 3D move on a camera-facing plane through the part
        this._vPlane ??= new THREE.Plane();
        this._vPlane.normal.copy(this.camera.getWorldDirection(this._vN ??= new THREE.Vector3())).negate();
        this._vPlane.setFromNormalAndCoplanarPoint(this._vPlane.normal, this.grabbed.position);
        if (this._ray.ray.intersectPlane(this._vPlane, hit))
          this.grabbed.position.lerp(new THREE.Vector3(
            THREE.MathUtils.clamp(hit.x, -5.5, 5.5),
            THREE.MathUtils.clamp(hit.y, .2, 5.5),
            THREE.MathUtils.clamp(hit.z, -5.5, 5.5)), .5);
      } else if (this._ray.ray.intersectPlane(this._plane, hit)) {
        this.grabbed.position.lerp(new THREE.Vector3(
          THREE.MathUtils.clamp(hit.x, -4.1, 4.1), this._dragY,
          THREE.MathUtils.clamp(hit.z, -4.1, 4.1)), .55);
      }
    }
    if (!h.pinch && !h.zoom && this._pinching) { this._pinching = false; this._drop(); }

    // orbit
    if (h.orbit) {
      this.orbitT.theta -= h.orbit.dx * 4.2;
      this.orbitT.phi = THREE.MathUtils.clamp(this.orbitT.phi - h.orbit.dy * 3.2, .25, 1.4);
    }
    // two pinches — resize the held part, else dolly the camera
    if (h.zoom) {
      if (this.grabbed) {
        const k = THREE.MathUtils.clamp(1 + h.zoom.dd * 3, .88, 1.12);
        this.grabbed.scale.multiplyScalar(k).clampScalar(.15, 4);
        this.grabbed.userData.baseScale?.copy(this.grabbed.scale);
      } else {
        this.orbitT.dist = THREE.MathUtils.clamp(this.orbitT.dist - h.zoom.dd * 14, 3.6, 12);
      }
    }
    // explode / assemble
    if (h.spread && Math.abs(h.spread.dd) > .001)
      this.explodeGoal = THREE.MathUtils.clamp(this.explodeGoal + h.spread.dd * 5.2, 0, 1);
  }

  _pick(p) {
    this._ray.setFromCamera(p, this.camera);
    const hits = this._ray.intersectObjects(this.parts.children, false);
    this.hover = hits[0]?.object || null;
    return this.hover;
  }

  _pinchStart(p) {
    const m = this._pick(p);
    if (this.tool === 'drill' && m) { this._drill(m); return; }
    if (PRIMS[this.tool] && this.tool !== 'select') {
      // spawn tool: pinch on bench → new block lands
      const hit = new THREE.Vector3();
      this._ray.setFromCamera(p, this.camera);
      if (this._ray.ray.intersectPlane(this._plane, hit)) {
        const x = THREE.MathUtils.clamp(hit.x, -4, 4), z = THREE.MathUtils.clamp(hit.z, -4, 4);
        const part = this.addPart(this.tool, new THREE.Vector3(x, 3.4, z));
        part.userData.dropFrom = 3.4; part.userData.dropTo = .55;
        part.userData.dropping = 0;
      }
      return;
    }
    if (m) {
      this.grabbed = m; this._dragY = m.position.y;
      m.userData.wasGrabbed = true;
      this._emit('grab', m);
    }
  }

  _drop() {
    if (!this.grabbed) return;
    const m = this.grabbed; this.grabbed = null;
    // snap gently to a .25 grid on the bench — but floating parts stay put
    if (this.explodeT <= .3) {
      m.position.x = Math.round(m.position.x * 4) / 4;
      m.position.z = Math.round(m.position.z * 4) / 4;
    }
    m.userData.settle = 0;
    m.userData.home = null; // once moved by hand it no longer snaps to assembly
    this._emit('drop', m);
  }

  _drill(m) {
    // real boolean: subtract a cylinder through the part's local Y
    const r = Math.min(.32, .36 * Math.min(m.scale.x, m.scale.z));
    const cutter = new THREE.Mesh(new THREE.CylinderGeometry(r, r, 4, 24));
    cutter.position.copy(m.position); cutter.quaternion.copy(m.quaternion);
    cutter.updateMatrixWorld(true);
    try {
      const ev = new Evaluator();
      ev.attributes = ['position', 'normal'];
      const a = new Brush(m.geometry); a.applyMatrix4(m.matrixWorld);
      const b = new Brush(cutter.geometry); b.applyMatrix4(cutter.matrixWorld);
      const res = ev.evaluate(a, b, SUBTRACTION);
      res.geometry.computeVertexNormals();
      m.geometry.dispose();
      m.geometry = res.geometry;
      m.position.set(0, 0, 0); m.rotation.set(0, 0, 0);   // result is world-space; keep transform sane
      m.userData.drilled = true;
      this._emit('drill', m);
      this._flash(m);
    } catch (e) { this._emit('drill-fail', m); }
  }

  _flash(m) {
    m.userData.flash = 0;
    this._ring ??= new THREE.Mesh(new THREE.TorusGeometry(.9, .03, 10, 48),
      new THREE.MeshBasicMaterial({ color: ACCENT, transparent: true }));
    this._ring.position.copy(m.userData.drilled ? m.position.clone().setY(m.geometry.boundingSphere?.center.y ?? .8) : m.position);
    // place ring at the drilled world position (mesh is world-baked now)
    const c = new THREE.Vector3(); m.geometry.computeBoundingSphere();
    m.geometry.boundingSphere.getCenter(c); this._ring.position.copy(c);
    this._ring.material.opacity = .95; this._ring.visible = true;
    this.scene.add(this._ring);
  }

  setTool(t) { this.tool = t; this._emit('tool', t); }
  explode(t) { this.explodeGoal = t; }
  on(ev, cb) { (this._cbs[ev] ??= []).push(cb); }
  _emit(ev, d) { (this._cbs[ev] || []).forEach(f => f(d)); }

  /* ---------- frame ---------- */
  start() {
    const tick = (t) => {
      this._update(t / 1000);
      this.renderer.render(this.scene, this.camera);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  _update(t) {
    // camera easing
    this.orbit.theta += (this.orbitT.theta - this.orbit.theta) * .14;
    this.orbit.phi += (this.orbitT.phi - this.orbit.phi) * .14;
    this.orbit.dist += (this.orbitT.dist - this.orbit.dist) * .14;
    const { theta, phi, dist } = this.orbit;
    this.camera.position.set(
      this.target.x + dist * Math.sin(phi) * Math.cos(theta),
      this.target.y + dist * Math.cos(phi),
      this.target.z + dist * Math.sin(phi) * Math.sin(theta));
    this.camera.lookAt(this.target);

    // explode ease
    const prev = this.explodeT;
    this.explodeT += (this.explodeGoal - this.explodeT) * .09;
    if (Math.abs(this.explodeT - prev) > .0004 && !this._explodeSent) { this._emit('explode', this.explodeT); this._explodeSent = true; }
    else if (Math.abs(this.explodeT - prev) <= .0004) this._explodeSent = false;
    const e = this.explodeT * this.explodeT * (3 - 2 * this.explodeT); // smoothstep
    // camera reframes: lift the target as the stack rises
    this.target.y = .6 + e * 1.4;

    for (const m of this.parts.children) {
      const u = m.userData;
      // explode offset for parts that still belong to the assembly (home set)
      if (u.home && m !== this.grabbed) {
        const hx = u.home.pos.x + u.ed.x * e * 2.3;
        const hy = u.home.pos.y + u.ed.y * e * 2.3;
        const hz = u.home.pos.z + u.ed.z * e * 2.3;
        // exploded parts levitate: gentle bob + slow tumble
        const bob = Math.sin(t * 1.3 + u._ph) * .09 * e;
        m.position.set(hx, hy + bob, hz);
        m.rotation.y = u.home.rot.y + e * u.ed.x * .5 + Math.sin(t * .55 + u._ph) * .12 * e;
        m.rotation.x = Math.sin(t * .7 + u._ph * 1.3) * .08 * e;
      }
      // drop-in: fall from spawn height to bench with a small overshoot
      if (u.dropping != null) {
        u.dropping += 1 / 24;
        const k = Math.min(1, u.dropping);
        const e2 = 1 - Math.pow(1 - k, 3);
        m.position.y = u.dropFrom + (u.dropTo - u.dropFrom) * e2 - Math.sin(k * Math.PI) * .18;
        if (k >= 1) { m.position.y = u.dropTo; delete u.dropping; }
      }
      if (u.settle != null && ++u.settle > 12) delete u.settle;
      // hover / grab visual
      const target = m === this.grabbed ? 1.1 : m === this.hover ? 1.05 : 1;
      m.userData._hs = THREE.MathUtils.lerp(m.userData._hs || 1, target, .2);
      const s = (u.baseScale ?? (u.baseScale = m.scale.clone()));
      if (!u.drilled) m.scale.copy(s).multiplyScalar(u._hs);
    }

    if (this._ring?.visible) {
      this._ring.scale.multiplyScalar(1.06);
      this._ring.material.opacity *= .9;
      if (this._ring.material.opacity < .02) this._ring.visible = false;
      else this._ring.lookAt(this.camera.position);
    }
  }

  resize() {
    const el = this.cv.parentElement || this.cv;
    const w = el.clientWidth || 640, h = el.clientHeight || 480;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
  }

  debug() {
    return {
      parts: this.parts.children.length,
      drilled: this.parts.children.filter(m => m.userData.drilled).length,
      exploded: +this.explodeT.toFixed(2),
      orbit: { ...this.orbit }, grabbed: !!this.grabbed, tool: this.tool,
      cam: this.camera.position.toArray().map(v => +v.toFixed(2)),
    };
  }
}
window.CADScene = CADScene;
