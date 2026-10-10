/* shared/boxing/fx.js — impact juice: splash bursts + mat stains.

   makeFx(THREE, scene) → { burst(pos, opts), stain(pos, opts), update(dt) }
   Bursts: sprite droplets thrown in a cone (bias direction e.g. toward the
   camera), gravity pulls them down; droplets that hit mat height splat into
   a short-lived floor stain. All cartoon — chunky round sprites, no shaders.
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

export function makeFx(THREE, scene) {
  const parts = [], stains = [];
  const BLOOD = dotTex(THREE, 'rgba(190,30,20,1)', 'rgba(140,10,8,.55)');
  const SWEAT = dotTex(THREE, 'rgba(235,245,255,.95)', 'rgba(190,215,235,.5)');
  const STAR  = dotTex(THREE, 'rgba(255,214,66,1)', 'rgba(255,180,40,.55)');

  const mats = {};
  const matFor = (tex) => mats[tex] || (mats[tex] = new THREE.SpriteMaterial({
    map: tex, transparent: true, depthWrite: false }));

  function burst(pos, { color = 'blood', n = 22, dir = null, speed = 1.5,
    size = .085, up = 1.3, spread = .9, life = .8 } = {}) {
    const tex = { blood: BLOOD, sweat: SWEAT, star: STAR }[color] || BLOOD;
    const mat = matFor(tex).clone();
    for (let i = 0; i < n; i++) {
      const s = new THREE.Sprite(mat.clone());
      const a = Math.random() * Math.PI * 2, r = Math.random() * spread;
      const v = dir
        ? new THREE.Vector3(dir.x + Math.cos(a) * r * .5, up * (0.4 + Math.random() * .8), dir.z + Math.sin(a) * r * .5)
        : new THREE.Vector3(Math.cos(a) * r, up * (0.5 + Math.random()), Math.sin(a) * r);
      v.multiplyScalar(speed * (0.6 + Math.random() * .7));
      s.position.copy(pos);
      s.scale.setScalar(size * (0.6 + Math.random() * .9));
      scene.add(s);
      parts.push({ s, v, t: 0, life: life * (0.6 + Math.random() * .8) });
    }
  }

  function stain(pos, { color = 0x8c1a12, r = .16 + Math.random() * .1, life = 7 } = {}) {
    const m = new THREE.Mesh(new THREE.CircleGeometry(r, 14),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: .55, depthWrite: false }));
    m.rotation.x = -Math.PI / 2;
    m.position.set(pos.x + (Math.random() - .5) * .12, .012 + stains.length * .0004, pos.z + (Math.random() - .5) * .12);
    scene.add(m);
    stains.push({ m, t: 0, life });
    if (stains.length > 24) { const old = stains.shift(); scene.remove(old.m); }
  }

  function update(dt) {
    for (let i = parts.length - 1; i >= 0; i--) {
      const p = parts[i];
      p.t += dt;
      p.v.y -= 4.5 * dt;
      p.s.position.addScaledVector(p.v, dt);
      p.s.material.opacity = Math.max(0, 1 - p.t / p.life);
      if (p.s.position.y <= .02 && p.v.y < 0) {
        stain(p.s.position, { color: 0x8c1a12, r: p.s.scale.x * 1.5 });
        p.t = p.life;
      }
      if (p.t >= p.life) { scene.remove(p.s); p.s.material.dispose?.(); parts.splice(i, 1); }
    }
    for (let i = stains.length - 1; i >= 0; i--) {
      const s = stains[i];
      s.t += dt;
      if (s.t > s.life * .7) s.m.material.opacity = .55 * Math.max(0, 1 - (s.t - s.life * .7) / (s.life * .3));
      if (s.t >= s.life) { scene.remove(s.m); s.m.geometry.dispose(); s.m.material.dispose(); stains.splice(i, 1); }
    }
  }

  return { burst, stain, update };
}
