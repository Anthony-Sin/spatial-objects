/* lineup-mockups/_hero/engine.mjs — shared "hero stage" engine for wave-4.

   One contender holds the center plinth under the big type; the other two
   slide onto dim side plinths. Everything the museum version added stays:
   per-rival spotlights that crossfade, floor glow, click-to-select
   raycasts, career pills, lock gates, drag-orbit, wheel zoom, the degraded
   no-WebGL path. What changed is the stage direction — camera target is
   pinned dead-center, never pans to a plinth.

   Page contract — the host HTML provides:
     <canvas id="webgl-canvas">                        fullscreen GL layer
     [data-best] [data-wins] [data-kos] [data-koavg]   career pills
     [data-note]                                       status line
     [data-hero-name] [data-hero-desc] [data-hero-badge]
     [data-stat-atk|def|spd]                           numeric readouts
     [data-pip-atk|def|spd]                            pip rows
     [data-spec-name] [data-spec-desc]                 signature move
     [data-pick] [data-enter]                          pick label + CTA
     [data-sel="0|1|2"]                                selector chips/dots
     [data-prev] [data-next]                           optional arrows
     [data-pop]                                        element(s) to re-pop
     [data-lockic="0|1|2"]                             optional lock badges
     [data-tab="0|1|2"]                                els toggling .sel/.no
*/
import * as THREE from 'three';
import { buildBoxer, VARIANTS, VARIANT_INFO } from '../../shared/boxing/protoBoxer.js';

const $ = (s) => document.querySelector(s);
const put = (el, v) => { if (el) el.textContent = v; };
const TAU = Math.PI * 2;

export function boot(cfg = {}) {
  const C = Object.assign({
    // stage palette — host theme passes its own
    bg: 0x171310, fogNear: 9, fogFar: 30,
    hemiSky: 0x9a8a70, hemiGround: 0x1a140f, hemiInt: 0.5,
    floor: 0x1f1914, floorRough: 0.82, floorSize: 90,
    plinth: 0xefe6d2, plinthRough: 0.72,
    rim: 0xd4af69, rimMetal: 0.65, rimRough: 0.35,
    spotColor: 0xffe6bd, spotHot: 42, spotDim: 1.2,
    glowHot: 0.36, glowDim: 0.015,
    // stage blocking — center hero + two flanks slightly back
    centerSlot: { x: 0, z: 0.1, s: 1.14 },
    sideSlot: { x: 2.35, z: -0.65, s: 0.8 },
    camTheta: 0, camPhi: 1.17, camRad: 4.6, camTgtY: 1.02,
    yaw: 0,                     // extra facing twist for the hero
    fixedCam: false,            // pinned shot — no orbit/zoom at all
    footer: null,               // optional note fallback override
  }, cfg);

  const canvas = $('#webgl-canvas');
  const noteEl = $('[data-note]');
  const pickEl = $('[data-pick]');
  const enterEl = $('[data-enter]');
  const selEls = [...document.querySelectorAll('[data-sel]')];
  const tabEls = selEls.length ? selEls : [...document.querySelectorAll('[data-tab]')];
  const popEls = () => [...document.querySelectorAll('[data-pop]')];

  /* ---------- career record / lock gate (same as lineup.html) ---------- */
  const ls = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  };
  const num = (v) => (typeof v === 'number' && Number.isFinite(v)) ? v : 0;
  const koRaw = ls.get('boxing:ko', { n: 0, sum: 0 });
  const ko = { n: num(koRaw?.n), sum: num(koRaw?.sum) };
  const koAvg = ko.n > 0 ? ko.sum / ko.n : 0;
  put($('[data-best]'), num(ls.get('boxing:best', 0)).toLocaleString());
  put($('[data-wins]'), num(ls.get('boxing:wins', 0)));
  put($('[data-kos]'), ko.n);
  put($('[data-koavg]'), ko.n ? koAvg.toFixed(1) : '—');

  const practice = new URLSearchParams(location.search).get('practice') ? '?practice=1' : '';
  /* roster follows whatever protoBoxer currently ships — the stage is
     built for 3 (center + two flanks), extras are ignored */
  const ROSTER = VARIANTS.slice(0, 3);
  const GLOW = [0xff6b57, 0x5da9e9, 0xb565d8];
  const isLocked = (v) => {
    const need = VARIANT_INFO[v]?.koAvg;
    return need != null && !(ko.n > 0 && koAvg <= need);
  };
  ROSTER.forEach((v, i) => {
    const lbl = VARIANT_INFO[v]?.label || v.toUpperCase();
    const nameEl = tabEls[i]?.querySelector('[data-sel-name]');
    if (nameEl) nameEl.textContent = lbl;
    tabEls[i]?.setAttribute('aria-label', lbl);
    const ic = tabEls[i]?.querySelector('[data-lockic]') || $(`[data-lockic="${i}"]`);
    if (ic) ic.style.display = isLocked(v) ? 'inline' : 'none';
    tabEls[i]?.classList.toggle('locked', isLocked(v));
  });
  for (let i = ROSTER.length; i < tabEls.length; i++) tabEls[i].style.display = 'none';

  /* ---------- contenders + slots ---------- */
  const contenders = ROSTER.map((v, i) => ({
    i, variant: v, id: `proto:${v}`,
    info: VARIANT_INFO[v] || { label: v.toUpperCase(), desc: '' },
    locked: isLocked(v),
    x: 0, z: 0, s: 1,            // live lerped slot transform
    tx: 0, tz: 0, ts: 1,         // targets
  }));

  let selectedIdx = 0;
  try {
    const found = ROSTER.indexOf((localStorage.getItem('boxing:npc') || '').replace(/^proto:/, ''));
    if (found >= 0) selectedIdx = found;
  } catch {}

  /* slot plan: selected → center; next in roster → right; prev → left */
  function planSlots(sel) {
    const n = contenders.length;
    for (const c of contenders) {
      if (c.i === sel) { c.tx = C.centerSlot.x; c.tz = C.centerSlot.z; c.ts = C.centerSlot.s; }
      else if (c.i === (sel + 1) % n) { c.tx = C.sideSlot.x; c.tz = C.sideSlot.z; c.ts = C.sideSlot.s; }
      else { c.tx = -C.sideSlot.x; c.tz = C.sideSlot.z; c.ts = C.sideSlot.s; }
    }
  }
  planSlots(selectedIdx);
  contenders.forEach(c => { c.x = c.tx; c.z = c.tz; c.s = c.ts; });

  /* ---------- camera — pinned to center, orbit/zoom still allowed ---------- */
  let cam = null;
  const camCtl = {
    theta: C.camTheta, phi: C.camPhi, rad: C.camRad,
    tgt: new THREE.Vector3(0, C.camTgtY, 0),
  };
  function applyCam() {
    if (!cam) return;
    camCtl.phi = Math.max(0.5, Math.min(1.5, camCtl.phi));
    camCtl.rad = Math.max(2.6, Math.min(9.0, camCtl.rad));
    const sp = Math.sin(camCtl.phi);
    cam.position.set(
      camCtl.tgt.x + camCtl.rad * sp * Math.sin(camCtl.theta),
      camCtl.tgt.y + camCtl.rad * Math.cos(camCtl.phi),
      camCtl.tgt.z + camCtl.rad * sp * Math.cos(camCtl.theta));
    cam.lookAt(camCtl.tgt);
  }

  let drag = null, dragMoved = 0, dead = false, fails = 0;
  const interactive = [];

  /* ---------- the stage ---------- */
  const webglOK = (() => {
    try { const c = document.createElement('canvas');
      return !!(c.getContext('webgl2') || c.getContext('webgl')); }
    catch { return false; }
  })();

  if (webglOK && canvas) try {
    const ren = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    ren.setSize(innerWidth, innerHeight);
    ren.setPixelRatio(Math.min(devicePixelRatio, 2));
    ren.shadowMap.enabled = true;
    ren.shadowMap.type = THREE.PCFSoftShadowMap;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(C.bg);
    scene.fog = new THREE.Fog(C.bg, C.fogNear, C.fogFar);
    cam = new THREE.PerspectiveCamera(38, innerWidth / innerHeight, 0.1, 80);
    applyCam();

    scene.add(new THREE.HemisphereLight(C.hemiSky, C.hemiGround, C.hemiInt));

    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(C.floorSize, C.floorSize),
      new THREE.MeshStandardMaterial({ color: C.floor, roughness: C.floorRough }));
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    scene.add(floor);
    if (cfg.floorDress) cfg.floorDress(THREE, scene);

    contenders.forEach((c) => {
      const { i } = c;
      const unit = new THREE.Group();   // whole exhibit slides as one piece

      const ped = new THREE.Mesh(
        new THREE.CylinderGeometry(0.56, 0.64, 0.14, 40),
        new THREE.MeshStandardMaterial({ color: C.plinth, roughness: C.plinthRough }));
      ped.position.y = 0.07; ped.receiveShadow = true;
      ped.userData = { contenderIndex: i };
      unit.add(ped); interactive.push(ped);

      const rim = new THREE.Mesh(
        new THREE.TorusGeometry(0.60, 0.018, 12, 48).rotateX(Math.PI / 2),
        new THREE.MeshStandardMaterial({ color: C.rim, metalness: C.rimMetal, roughness: C.rimRough }));
      rim.position.y = 0.142; rim.userData = { contenderIndex: i };
      unit.add(rim); interactive.push(rim);

      const glow = new THREE.Mesh(
        new THREE.CircleGeometry(0.78, 40),
        new THREE.MeshBasicMaterial({ color: GLOW[i], transparent: true,
          opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
      glow.rotation.x = -Math.PI / 2; glow.position.y = 0.004;
      unit.add(glow);

      const boxer = buildBoxer(THREE, { variant: c.variant });
      boxer.group.position.y = 0.14;
      boxer.snap('idle', 0);
      boxer.group.traverse(m => {
        if (m.isMesh) { m.castShadow = true; m.userData.contenderIndex = i; interactive.push(m); }
      });
      unit.add(boxer.group);

      const spot = new THREE.SpotLight(C.spotColor, C.spotDim, 9.5, 0.46, 0.5, 1.5);
      spot.position.set(0.32, 3.7, 1.0);
      spot.castShadow = true;
      spot.shadow.mapSize.set(1024, 1024);
      spot.shadow.bias = -0.0004;
      unit.add(spot); spot.target.position.set(0, 0.14, 0); unit.add(spot.target);

      unit.position.set(c.x, 0, c.z);
      unit.scale.setScalar(c.s);
      scene.add(unit);
      Object.assign(c, { unit, boxer, spot, glow });
    });

    /* orbit + zoom (target never pans — the center is the star);
       fixedCam pages skip the controls entirely — one pinned shot */
    if (!C.fixedCam) {
      canvas.addEventListener('pointerdown', e => {
        dragMoved = 0; drag = { x: e.clientX, y: e.clientY };
        try { canvas.setPointerCapture(e.pointerId); } catch {}
      });
      canvas.addEventListener('pointermove', e => {
        if (!drag) return;
        const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
        dragMoved += Math.abs(dx) + Math.abs(dy);
        drag.x = e.clientX; drag.y = e.clientY;
        camCtl.theta -= dx * 0.0055; camCtl.phi -= dy * 0.0055;
        applyCam();
      });
      addEventListener('pointerup', () => { drag = null; });
      canvas.addEventListener('wheel', e => {
        e.preventDefault(); camCtl.rad *= Math.pow(1.0012, e.deltaY); applyCam();
      }, { passive: false });
    } else {
      canvas.style.cursor = 'default';
    }
    addEventListener('resize', () => {
      if (!cam) return;
      cam.aspect = innerWidth / innerHeight; cam.updateProjectionMatrix();
      ren.setSize(innerWidth, innerHeight); applyCam();
    });
    canvas.addEventListener('webglcontextlost', () => { dead = true; });
    canvas.addEventListener('webglcontextrestored', () => { dead = false; fails = 0; animate(); });

    /* click a rival (or their plinth) to bring them center */
    const ray = new THREE.Raycaster(), mv = new THREE.Vector2();
    canvas.addEventListener('click', e => {
      if (dragMoved > 6) return;
      mv.x = (e.clientX / innerWidth) * 2 - 1;
      mv.y = -(e.clientY / innerHeight) * 2 + 1;
      ray.setFromCamera(mv, cam);
      const hits = ray.intersectObjects(interactive, true);
      if (!hits.length) return;
      let o = hits[0].object;
      while (o && o.userData?.contenderIndex == null && o.parent) o = o.parent;
      const hi = o?.userData?.contenderIndex;
      if (hi != null && hi >= 0 && hi < contenders.length) {
        if (contenders[hi].locked) {
          tabEls[hi]?.classList.add('no');
          setTimeout(() => tabEls[hi]?.classList.remove('no'), 400);
        }
        selectContender(hi, true);
      }
    });
    canvas.addEventListener('pointermove', e => {
      if (drag) return;
      mv.x = (e.clientX / innerWidth) * 2 - 1;
      mv.y = -(e.clientY / innerHeight) * 2 + 1;
      ray.setFromCamera(mv, cam);
      canvas.style.cursor = ray.intersectObjects(interactive, true).length
        ? 'pointer' : (C.fixedCam ? 'default' : 'grab');
    });

    let last = performance.now();
    function animate() {
      if (dead) return;
      requestAnimationFrame(animate);
      try {
        const now = performance.now();
        const dt = Math.min(0.1, (now - last) / 1000); last = now;
        const k = 1 - Math.exp(-dt * 7);      // slot slide easing
        for (const c of contenders) {
          c.boxer?.tick(dt, {});
          c.x += (c.tx - c.x) * k; c.z += (c.tz - c.z) * k; c.s += (c.ts - c.s) * k;
          c.unit?.position.set(c.x, 0, c.z);
          c.unit?.scale.setScalar(c.s);
          const sel = c.i === selectedIdx;
          const spotT = sel ? C.spotHot : C.spotDim;
          const glowT = sel ? C.glowHot : C.glowDim;
          c.spot.intensity += (spotT - c.spot.intensity) * (1 - Math.exp(-dt * 9));
          c.glow.material.opacity += (glowT - c.glow.material.opacity) * (1 - Math.exp(-dt * 9));
          if (c.boxer) c.boxer.group.rotation.y =
            sel ? C.yaw : (c.tx < 0 ? 0.35 : -0.35);   // flanks angle in
        }
        ren.render(scene, cam);
        fails = 0;
      } catch (e) {
        if (++fails >= 5) { dead = true; console.warn('hero-stage: render stopped — UI still works:', e); }
      }
    }
    animate();
  } catch (e) {
    dead = true;
    console.warn('hero-stage: 3D unavailable — UI still works:', e);
  }
  if (dead && canvas) {
    canvas.style.visibility = 'hidden';
    put(noteEl, C.footer || 'the stage lights are out — the card below still picks your rival');
  }

  /* ---------- selection UI ---------- */
  function renderPips(el, count, total = 5) {
    if (!el) return;
    el.innerHTML = '';
    for (let i = 0; i < total; i++) {
      const pip = document.createElement('i');
      if (i < count) pip.className = 'on';
      el.appendChild(pip);
    }
  }

  function selectContender(idx, triggerPose = true) {
    const t = contenders[idx];
    if (!t) return;
    selectedIdx = idx;
    const { variant, info, locked, boxer } = t;

    put($('[data-hero-name]'), info.label || variant.toUpperCase());
    put($('[data-hero-desc]'), info.desc || 'original contender');
    const badge = $('[data-hero-badge]');
    if (badge) {
      if (locked) { badge.className = badge.dataset.clsLocked || 'badge locked';
        badge.textContent = `LOCKED · AVG KO ≤ R${info.koAvg ?? 2}`; }
      else { badge.className = badge.dataset.clsOpen || 'badge open';
        badge.textContent = 'READY TO SCRAP'; }
    }
    const st = info.stats || { atk: 3, def: 3, spd: 3 };
    put($('[data-stat-atk]'), st.atk); put($('[data-stat-def]'), st.def); put($('[data-stat-spd]'), st.spd);
    renderPips($('[data-pip-atk]'), st.atk);
    renderPips($('[data-pip-def]'), st.def);
    renderPips($('[data-pip-spd]'), st.spd);
    const spec = info.special || { name: 'RAPID JAB', desc: 'quick strike' };
    put($('[data-spec-name]'), spec.name);
    put($('[data-spec-desc]'), `— ${spec.desc}`);
    put(pickEl, (info.label || variant).toUpperCase());

    if (enterEl) {
      if (locked) {
        enterEl.classList.add('locked');
        enterEl.textContent = `LOCKED (AVG KO ≤ R${info.koAvg})`;
        enterEl.removeAttribute('href');
      } else {
        enterEl.classList.remove('locked');
        enterEl.textContent = 'ENTER THE RING →';
        enterEl.href = `./boxing.html${practice}`;
        try { localStorage.setItem('boxing:npc', `proto:${variant}`); } catch {}
      }
    }
    tabEls.forEach((el, i) => el.classList.toggle('sel', i === idx));
    planSlots(idx);
    popEls().forEach(el => {
      el.classList.remove('pop'); void el.offsetWidth; el.classList.add('pop');
    });
    if (triggerPose && boxer) {
      boxer.pose('jab', 0.2);
      setTimeout(() => boxer.pose('idle', 0), 450);
    }
    put(noteEl, locked
      ? `${info.label} is locked — drop your average KO to round ${info.koAvg}`
      : `${info.label} wraps their hands — ready for the bell`);
  }

  tabEls.forEach((el, idx) => el.addEventListener('click', () => {
    const c = contenders[idx];
    if (!c) return;
    if (c.locked) { el.classList.add('no'); setTimeout(() => el.classList.remove('no'), 400); }
    selectContender(idx, true);
  }));
  $('[data-prev]')?.addEventListener('click', () =>
    selectContender((selectedIdx + contenders.length - 1) % contenders.length, true));
  $('[data-next]')?.addEventListener('click', () =>
    selectContender((selectedIdx + 1) % contenders.length, true));

  enterEl?.addEventListener('click', (e) => {
    const cur = contenders[selectedIdx];
    if (cur?.locked) {
      e.preventDefault();
      tabEls[selectedIdx]?.classList.add('no');
      setTimeout(() => tabEls[selectedIdx]?.classList.remove('no'), 400);
      put(noteEl, `${cur.info.label} is locked — earn KO avg ≤ R${cur.info.koAvg} first`);
    }
  });

  addEventListener('keydown', (e) => {
    const n = contenders.length;
    if (e.key >= '1' && e.key <= String(n)) selectContender(+e.key - 1, true);
    else if (e.key === 'ArrowLeft' || e.key === 'a' || e.key === 'A')
      selectContender((selectedIdx + n - 1) % n, true);
    else if (e.key === 'ArrowRight' || e.key === 'd' || e.key === 'D')
      selectContender((selectedIdx + 1) % n, true);
    else if (e.key === 'Enter') {
      const cur = contenders[selectedIdx];
      if (cur && !cur.locked) location.href = `./boxing.html${practice}`;
    }
  });

  selectContender(selectedIdx, false);
  try { window.__stage = { contenders, select: selectContender }; } catch {}
  return { select: selectContender };
}
