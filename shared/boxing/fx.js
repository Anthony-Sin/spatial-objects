/* shared/boxing/fx.js — impact juice: splash bursts + mat stains.

   makeFx(THREE, scene, cam) → { burst(pos, opts), stain(pos, opts), update(dt) }
   Bursts: sprite droplets thrown in a cone (bias direction e.g. toward the
   camera), gravity pulls them down; droplets that hit mat height splat into
   a short-lived floor stain. All cartoon — chunky round sprites, no shaders.

   PERF: sprites and stains are POOLED — the old version cloned a material
   per sprite and added/removed scene nodes on every hit, which spiked the
   frame exactly when a punch landed. Pool members keep their own material
   (per-sprite fade) but swap textures and toggle visibility; the pool is a
   ring buffer so a simultaneous double-hit steals the oldest instead of
   growing unboundedly. cam is optional — sprites parked on the lens shrink
   a touch so a face-full of sweat doesn't turn into a fill-rate wall.
*/
const texCache = {};
function dotTex(THREE, inner, outer) {
  const key = inner + '|' + outer;
  if (texCache[key]) return texCache[key];
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const x = c.getContext('2d');
  const g = x.createRadialGradient(32, 32, 4, 32, 32, 30);
  g.addColorStop(0, inner); g.addColorStop(.72, outer); g.addColorStop(1, 'rgba(0,0,0,0)');
  x.fillStyle = g; x.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c); texCache[key] = t; return t;
}

const POOL_N = 72, STAIN_N = 24;

export function makeFx(THREE, scene, cam) {
  const BLOOD = dotTex(THREE, 'rgba(190,30,20,1)', 'rgba(140,10,8,.55)');
  const SWEAT = dotTex(THREE, 'rgba(235,245,255,.95)', 'rgba(190,215,235,.5)');
  const STAR  = dotTex(THREE, 'rgba(255,214,66,1)', 'rgba(255,180,40,.55)');
  const FLASH = dotTex(THREE, 'rgba(255,255,255,1)', 'rgba(255,240,200,.5)');
  const STREAK = dotTex(THREE, 'rgba(220,235,255,.9)', 'rgba(160,190,235,.4)');

  /* sprite pool — created once, toggled visible forever after */
  const pool = [];
  for (let i = 0; i < POOL_N; i++) {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({
      map: BLOOD, transparent: true, depthWrite: false }));
    s.visible = false;
    scene.add(s);
    pool.push({ s, v: new THREE.Vector3(), t: 0, life: 0, base: .1, on: false });
  }
  let poolAt = 0;

  /* stain pool — one shared unit-circle geometry, radius via mesh scale */
  const stainGeo = new THREE.CircleGeometry(1, 14);
  const stainPool = [];
  for (let i = 0; i < STAIN_N; i++) {
    const m = new THREE.Mesh(stainGeo, new THREE.MeshBasicMaterial({
      color: 0x8c1a12, transparent: true, opacity: 0, depthWrite: false }));
    m.rotation.x = -Math.PI / 2;
    m.visible = false;
    scene.add(m);
    stainPool.push({ m, t: 0, life: 0, on: false });
  }
  let stainAt = 0;

  function burst(pos, { color = 'blood', n = 22, dir = null, speed = 1.5,
    size = .085, up = 1.3, spread = .9, life = .8 } = {}) {
    const tex = { blood: BLOOD, sweat: SWEAT, star: STAR, flash: FLASH,
      streak: STREAK }[color] || BLOOD;
    for (let i = 0; i < n; i++) {
      const p = pool[poolAt]; poolAt = (poolAt + 1) % POOL_N;   // steal oldest
      p.s.material.map = tex;
      const a = Math.random() * Math.PI * 2, r = Math.random() * spread;
      if (dir) p.v.set(dir.x + Math.cos(a) * r * .5, up * (0.4 + Math.random() * .8), dir.z + Math.sin(a) * r * .5);
      else p.v.set(Math.cos(a) * r, up * (0.5 + Math.random()), Math.sin(a) * r);
      p.v.multiplyScalar(speed * (0.6 + Math.random() * .7));
      p.s.position.copy(pos);
      p.base = size * (0.6 + Math.random() * .9);
      p.s.scale.setScalar(p.base);
      p.s.material.opacity = 1;
      p.s.visible = true;
      p.t = 0; p.life = life * (0.6 + Math.random() * .8); p.on = true;
    }
  }

  function stain(pos, { color = 0x8c1a12, r = .16 + Math.random() * .1, life = 7 } = {}) {
    const s = stainPool[stainAt]; stainAt = (stainAt + 1) % STAIN_N;
    s.m.material.color.set(color);
    s.m.scale.setScalar(r);
    s.m.position.set(pos.x + (Math.random() - .5) * .12, .012 + stainAt * .0004,
                     pos.z + (Math.random() - .5) * .12);
    s.m.material.opacity = .55;
    s.m.visible = true;
    s.t = 0; s.life = life; s.on = true;
  }

  function update(dt) {
    for (const p of pool) {
      if (!p.on) continue;
      p.t += dt;
      p.v.y -= 4.5 * dt;
      p.s.position.addScaledVector(p.v, dt);
      p.s.material.opacity = Math.max(0, 1 - p.t / p.life);
      if (p.s.position.y <= .02 && p.v.y < 0) {
        stain(p.s.position, { r: p.base * 1.5 });
        p.t = p.life;
      }
      if (cam) {
        // fill-rate guard: a sprite hugging the lens covers half the screen —
        // shrink it a little; still reads as a face-full of sweat
        const d = Math.sqrt(p.s.position.distanceToSquared(cam.position));
        p.s.scale.setScalar(p.base * Math.min(1, .5 + d * 1.1));
      }
      if (p.t >= p.life) { p.on = false; p.s.visible = false; }
    }
    for (const s of stainPool) {
      if (!s.on) continue;
      s.t += dt;
      if (s.t > s.life * .7)
        s.m.material.opacity = .55 * Math.max(0, 1 - (s.t - s.life * .7) / (s.life * .3));
      if (s.t >= s.life) { s.on = false; s.m.visible = false; }
    }
  }

  return { burst, stain, update };
}
