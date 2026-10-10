/* shared/boxing/scene.js — the cartoon ring world.

   buildScene(THREE, renderer) → { scene, ring, update(dt, state) }

   A Punch-Out!!-flavored toy boxing ring in the house palette (warm paper,
   ink outlines, saturated accents): canvas-textured mat, corner posts +
   turnbuckle pads (player RED corner at +x/+z, NPC BLUE at −x/−z), three
   rope lines per side, a bobbing blob-crowd floating in the warm void,
   stage-light cones and a key spotlight over the mat.

   update(dt, state) is driven by game.js each frame:
     state = { events: [...drained fight events...], fight: fight.state, sim }
   It animates crowd excitement, rope jolt, telegraph spotlight tint and
   the KO confetti burst. Everything degrades gracefully with state = {}.
*/

const C = {
  paper: 0xfff8ec, paper2: 0xfdf3e3, ink: 0x2b2118,
  coral: 0xff6b57, sun: 0xffc53d, leaf: 0x4fb06d, sky: 0x5da9e9, berry: 0xb565d8,
  void_: 0x241c12, apron: 0x3a2d20,
};
const RING = 2.95;          // post-to-post half-extent; sim plays inside ~r2.6
const ROPE_Y = [1.32, 1.0, .68];
const ROPE_COL = [C.coral, C.paper, C.sky];

/* the mat's painted top — paper canvas with ink rings, corner triangles and
   a doodle star at center. Falls back to flat color where no DOM canvas. */
function matTexture(THREE) {
  if (typeof document === 'undefined') return null;
  const cv = document.createElement('canvas'); cv.width = cv.height = 512;
  const x = cv.getContext('2d');
  x.fillStyle = '#fdf3e3'; x.fillRect(0, 0, 512, 512);
  x.strokeStyle = '#2b2118'; x.lineWidth = 10; x.strokeRect(14, 14, 484, 484);
  x.lineWidth = 4; x.strokeRect(30, 30, 452, 452);
  // corner triangles — red +x/+z quadrant, blue −x/−z (canvas y = world z)
  x.fillStyle = '#ff6b57';
  x.beginPath(); x.moveTo(512, 392); x.lineTo(512, 512); x.lineTo(392, 512); x.closePath(); x.fill();
  x.fillStyle = '#5da9e9';
  x.beginPath(); x.moveTo(0, 0); x.lineTo(120, 0); x.lineTo(0, 120); x.closePath(); x.fill();
  // center doodle star + ring
  x.strokeStyle = '#2b2118'; x.lineWidth = 6;
  x.beginPath(); x.arc(256, 256, 92, 0, 7); x.stroke();
  x.fillStyle = '#ffc53d';
  x.save(); x.translate(256, 256); x.rotate(-.2);
  x.beginPath();
  for (let i = 0; i < 10; i++) {
    const r = i % 2 ? 30 : 66, a = i * Math.PI / 5 - Math.PI / 2;
    x[i ? 'lineTo' : 'moveTo'](Math.cos(a) * r, Math.sin(a) * r);
  }
  x.closePath(); x.fill(); x.stroke();
  x.restore();
  // faint paper speckle
  x.fillStyle = 'rgba(43,33,24,.05)';
  for (let i = 0; i < 350; i++) x.fillRect(Math.random() * 512, Math.random() * 512, 2, 2);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

const lerp = (a, b, t) => a + (b - a) * t;

export function buildScene(THREE, renderer) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(C.void_);
  scene.fog = new THREE.Fog(C.void_, 9, 19);
  if (renderer) renderer.shadowMap.enabled = true;

  const flat = (c, opts = {}) =>
    new THREE.MeshStandardMaterial({ color: c, roughness: .92, metalness: 0, ...opts });
  const basic = (c, opts = {}) => new THREE.MeshBasicMaterial({ color: c, ...opts });

  /* ---------- lights ---------- */
  scene.add(new THREE.HemisphereLight(0xfff2dd, 0x2b2118, .85));
  const key = new THREE.DirectionalLight(0xffe6bd, .9);
  key.position.set(4, 7, 3); key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  key.shadow.camera.left = key.shadow.camera.bottom = -5;
  key.shadow.camera.right = key.shadow.camera.top = 5;
  scene.add(key);
  const spot = new THREE.SpotLight(0xffe9b8, 90, 16, .52, .65, 1.6);
  spot.position.set(0, 7.2, 0); spot.target.position.set(0, 0, 0);
  scene.add(spot, spot.target);
  // warm accent glows over the two corners
  const redGlow = new THREE.PointLight(C.coral, 8, 7); redGlow.position.set(RING, 1.6, RING);
  const bluGlow = new THREE.PointLight(C.sky, 8, 7); bluGlow.position.set(-RING, 1.6, -RING);
  scene.add(redGlow, bluGlow);

  /* ---------- ring platform ---------- */
  const ring = new THREE.Group(); scene.add(ring);
  const topTex = matTexture(THREE);
  const topMat = topTex
    ? new THREE.MeshStandardMaterial({ map: topTex, roughness: .95 })
    : flat(C.paper2);
  const mat = new THREE.Mesh(
    new THREE.BoxGeometry(RING * 2 + .3, .3, RING * 2 + .3),
    [flat(C.apron), flat(C.apron), topMat, flat(C.apron), flat(C.apron), flat(C.apron)]);
  mat.position.y = -.15; mat.receiveShadow = true; ring.add(mat);
  // apron skirt + sun-gold trim band under the mat edge
  const skirt = new THREE.Mesh(new THREE.BoxGeometry(RING * 2 + 1.0, .55, RING * 2 + 1.0), flat(C.ink));
  skirt.position.y = -.58; ring.add(skirt);
  const band = new THREE.Mesh(new THREE.BoxGeometry(RING * 2 + 1.04, .12, RING * 2 + 1.04), flat(C.sun));
  band.position.y = -.34; ring.add(band);

  /* ---------- posts + corner pads ---------- */
  const posts = [], pads = [];
  const postGeo = new THREE.CylinderGeometry(.055, .075, 1.72, 10);
  const capGeo = new THREE.SphereGeometry(.1, 10, 8);
  const padGeo = new THREE.BoxGeometry(.24, .52, .15);
  for (const [sx, sz] of [[1, 1], [1, -1], [-1, -1], [-1, 1]]) {
    const isRed = sx > 0 && sz > 0, isBlu = sx < 0 && sz < 0;
    const post = new THREE.Mesh(postGeo, flat(C.ink));
    post.position.set(sx * RING, .86, sz * RING);
    post.castShadow = true; ring.add(post); posts.push(post);
    const cap = new THREE.Mesh(capGeo, flat(isRed ? C.coral : isBlu ? C.sky : C.paper));
    cap.position.set(sx * RING, 1.76, sz * RING); ring.add(cap);
    // turnbuckle pad faces the ring center
    const pad = new THREE.Mesh(padGeo, flat(isRed ? C.coral : isBlu ? C.sky : C.paper2));
    pad.position.set(sx * (RING - .1), 1.0, sz * (RING - .1));
    pad.lookAt(0, 1.0, 0); ring.add(pad); pads.push(pad);
  }

  /* ---------- ropes ---------- */
  const ropes = [];
  const ropeGeoX = new THREE.CylinderGeometry(.024, .024, RING * 2, 8).rotateZ(Math.PI / 2);
  const ropeGeoZ = new THREE.CylinderGeometry(.024, .024, RING * 2, 8).rotateX(Math.PI / 2);
  for (let lvl = 0; lvl < 3; lvl++) {
    const m = flat(ROPE_COL[lvl]);
    for (const s of [-1, 1]) {
      const rx = new THREE.Mesh(ropeGeoX, m);      // runs along X, on ±Z sides
      rx.position.set(0, ROPE_Y[lvl], s * RING);
      const rz = new THREE.Mesh(ropeGeoZ, m);      // runs along Z, on ±X sides
      rz.position.set(s * RING, ROPE_Y[lvl], 0);
      rx.userData = rz.userData = { y0: ROPE_Y[lvl], ph: Math.random() * 6.28 };
      ring.add(rx, rz); ropes.push(rx, rz);
    }
  }

  /* ---------- the void + blob crowd ---------- */
  const floor = new THREE.Mesh(new THREE.CircleGeometry(14, 40).rotateX(-Math.PI / 2), flat(0x1b1510));
  floor.position.y = -.86; floor.receiveShadow = true; scene.add(floor);
  const wall = new THREE.Mesh(
    new THREE.CylinderGeometry(13, 13, 9, 36, 1, true),
    basic(0x2a211a, { side: THREE.BackSide }));
  wall.position.y = 3.4; scene.add(wall);

  // stage-light cones — translucent shafts from the rafters onto the mat
  const coneMat = basic(0xffe9b8, { transparent: true, opacity: .055,
    blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
  for (const [x, z, tilt] of [[0, 0, 0], [2.4, 1.6, .3], [-2.4, -1.6, -.3]]) {
    const cone = new THREE.Mesh(new THREE.ConeGeometry(2.6, 7, 24, 1, true), coneMat);
    cone.position.set(x * .5, 3.6, z * .5); cone.rotation.z = tilt * .2;
    scene.add(cone);
  }

  // crowd: instanced blob heads ringing the arena in bleacher arcs
  const N = 150;
  const crowd = new THREE.InstancedMesh(
    new THREE.SphereGeometry(.17, 10, 8),
    new THREE.MeshStandardMaterial({ roughness: .9 }), N);
  const crowdCols = [C.paper, C.sun, C.leaf, C.sky, C.coral, C.berry, C.paper2];
  const cd = [];                                   // per-head data
  const dummy = new THREE.Object3D(), col = new THREE.Color();
  for (let i = 0; i < N; i++) {
    const lane = i % 3, a = (i / N) * Math.PI * 2 + lane * .7 + Math.random() * .12;
    const r = 5.4 + lane * 1.5 + Math.random() * .7;
    cd.push({ x: Math.cos(a) * r, z: Math.sin(a) * r,
      y: -.2 + lane * .75 + Math.random() * .35,
      ph: Math.random() * 6.28, sp: 1.6 + Math.random() * 1.6 });
    dummy.position.set(cd[i].x, cd[i].y, cd[i].z);
    dummy.updateMatrix(); crowd.setMatrixAt(i, dummy.matrix);
    crowd.setColorAt(i, col.setHex(crowdCols[i % crowdCols.length]).multiplyScalar(.55));
  }
  crowd.instanceColor.needsUpdate = true;
  scene.add(crowd);

  /* ---------- confetti (KO payoff) ---------- */
  const CN = 90;
  const confetti = new THREE.InstancedMesh(
    new THREE.PlaneGeometry(.09, .13),
    basic(0xffffff, { side: THREE.DoubleSide }), CN);
  confetti.visible = false; scene.add(confetti);
  const cf = [];
  for (let i = 0; i < CN; i++) cf.push({ p: new THREE.Vector3(), v: new THREE.Vector3(),
    rx: 0, ry: 0, rvx: 0, rvy: 0, life: 0 });
  const burst = () => {
    confetti.visible = true;
    for (const c of cf) {
      c.p.set((Math.random() - .5) * 2, 2.6 + Math.random() * 1.4, (Math.random() - .5) * 2);
      c.v.set((Math.random() - .5) * 2.4, .5 + Math.random() * 1.6, (Math.random() - .5) * 2.4);
      c.rx = Math.random() * 6.28; c.ry = Math.random() * 6.28;
      c.rvx = (Math.random() - .5) * 12; c.rvy = (Math.random() - .5) * 12;
      c.life = 1.6 + Math.random() * 1.4;
    }
    for (let i = 0; i < CN; i++)
      confetti.setColorAt(i, col.setHex(crowdCols[(i * 3) % crowdCols.length]));
    confetti.instanceColor.needsUpdate = true;
  };

  /* ---------- per-frame animation ---------- */
  let t = 0, excite = 0, jolt = 0, tel = 0;
  const spotWarm = new THREE.Color(0xffe9b8), spotHot = new THREE.Color(C.coral);

  function update(dt, state = {}) {
    t += dt;
    const ev = state.events || [];
    const npcAction = state.fight?.npc?.action;
    for (const e of ev) {
      if (e === 'npc-hit' || e === 'player-hit' || e === 'player-hit-taken') { excite = Math.min(1.6, excite + .55); jolt = Math.min(1.4, jolt + 1); }
      else if (e === 'ko') { excite = 1.8; jolt = 1.6; burst(); }
      else if (e === 'win' || e === 'lose') { excite = 1.8; burst(); }
      else excite = Math.min(1.6, excite + .22);
    }
    excite = Math.max(0, excite - dt * .75);
    jolt = Math.max(0, jolt - dt * 2.6);
    tel = lerp(tel, npcAction === 'windup' ? 1 : 0, Math.min(1, dt * 9));

    // spotlight flushes coral + flickers while the NPC telegraphs
    spot.color.lerpColors(spotWarm, spotHot, tel);
    spot.intensity = 90 + tel * (30 + Math.sin(t * 31) * 22) + excite * 18;
    redGlow.intensity = 8 + excite * 10; bluGlow.intensity = 8 + tel * 10;

    // ropes jolt when a hit lands
    for (const r of ropes)
      r.position.y = r.userData.y0 + Math.sin(t * 26 + r.userData.ph) * jolt * .045;

    // crowd bobs — higher when the fight is spicy
    for (let i = 0; i < N; i++) {
      const c = cd[i];
      dummy.position.set(c.x, c.y + Math.sin(t * c.sp + c.ph) * (.05 + excite * .3), c.z);
      dummy.updateMatrix(); crowd.setMatrixAt(i, dummy.matrix);
    }
    crowd.instanceMatrix.needsUpdate = true;

    // confetti fall
    if (confetti.visible) {
      let alive = 0;
      for (let i = 0; i < CN; i++) {
        const c = cf[i];
        if (c.life > 0) {
          alive++;
          c.life -= dt; c.v.y -= 2.6 * dt;
          c.p.x += (c.v.x + Math.sin(t * 9 + i) * .5) * dt;
          c.p.y += c.v.y * dt; c.p.z += c.v.z * dt;
          if (c.p.y < .02) { c.p.y = .02; c.v.set(0, 0, 0); c.rvx = c.rvy = 0; }
          c.rx += c.rvx * dt; c.ry += c.rvy * dt;
        }
        dummy.position.copy(c.p); dummy.rotation.set(c.rx, c.ry, 0);
        dummy.scale.setScalar(c.life > 0 ? 1 : .0001);
        dummy.updateMatrix(); confetti.setMatrixAt(i, dummy.matrix);
      }
      confetti.instanceMatrix.needsUpdate = true;
      if (!alive) confetti.visible = false;
    }
  }

  return { scene, ring: { group: ring, mat, posts, ropes, pads, crowd, spot }, update, burst };
}
