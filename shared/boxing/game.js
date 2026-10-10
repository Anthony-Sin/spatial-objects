/* shared/boxing/game.js — the glue between input, sims, world and HUD.

   const game = await createGame({ THREE, renderer, cam, world, hands, face,
                                   video, vendorUrl, manifestUrl,
                                   ringOpts, fistOpts, fightOpts })
     → { world, scene, npc, sim, tracker, fight, cam,
         step(dt, handsState, faceState), calibrate(), reset(),
         get hands, get face }

   Per frame (step):
     FistTracker.update(hands, face) → drain punches/guard/sway
     → RingSim.step(dt, {sway, playerDodge, npcDir: fight.npcDir(), npcStunned})
     → Fight.step(dt, {punches, guard, sway, distance})
     → drain fight.state.events (single consumer — HUD/scene share the copy)
     → scene.update / npc.update / first-person camera
     → returns { events, state, sim, tracker } for the page's HUD.

   THREE is passed in (never imported) so this module stays node-importable.
   Contract modules (ring/fists/fight) are static imports — they're pure JS.
*/

import { RingSim } from './ring.js';
import { FistTracker } from './fists.js';
import { Fight } from './fight.js';
import { buildScene } from './scene.js';
import { createNpc } from './npc.js';
import { makeFx } from './fx.js';

export async function createGame(opts = {}) {
  const { THREE, cam } = opts;
  const world = opts.world || buildScene(THREE, opts.renderer);
  const npc = await createNpc(THREE, {
    scene: world.scene, manifestUrl: opts.manifestUrl, manifest: opts.manifest,
  });
  const sim = new RingSim(opts.ringOpts || {});
  const tracker = new FistTracker(opts.fistOpts || {});
  const fight = new Fight({ npcName: npc.name?.toUpperCase?.() || 'PIP', ...(opts.fightOpts || {}) });

  // webcam trackers: use the ones the page hands in; create only if a video
  // element is provided (dynamic imports keep this file node-safe)
  let hands = opts.hands || null, face = opts.face || null;
  if (opts.video) {
    const vend = opts.vendorUrl || './vendor/mediapipe';
    if (!face) try { face = await (await import('../face.js')).Face.create(opts.video, vend); } catch {}
    if (!hands) try { hands = (await import('../hands.js')).default.create(opts.video, vend); } catch {}
  }

  /* camera sits low — chin/chest height — so the fighter's face rides the
     upper frame and its gloves own the center. NPC punches thrown at glove
     height come straight at the lens and read as real hits. */
  const EYE = (npc.eyeY ?? 1.4) * .78;
  const HEAD = (npc.headY ?? 1.0) * .85;

  const fx = makeFx(THREE, world.scene);
  let camSway = 0, shakeT = 0, dodged = false, tNow = 0;
  let push = 0, lastDmgStage = 0;                 // push = camera shove-back state
  const hitPos = new THREE.Vector3();

  function step(dt, hs, fs) {
    tNow += dt;
    tracker.update(hs || { hands: [] }, fs || null, dt);
    const punches = tracker.punches.splice(0, tracker.punches.length);

    // committed dodge hop = a fresh strong lean (edge-triggered, resets in dead zone)
    const sw = tracker.sway || 0;
    let dodge = 0;
    if (Math.abs(sw) >= .75 && !dodged) { dodge = Math.sign(sw); dodged = true; }
    if (Math.abs(sw) < .5) dodged = false;

    const st = fight.state;
    sim.step(dt, {
      sway: sw,
      playerDodge: dodge,
      npcDir: fight.npcDir(),
      npcStunned: st.npc.action === 'hurt' || st.npc.action === 'down',
    });
    fight.step(dt, { punches, guard: tracker.guard, sway: sw, distance: sim.distance() });
    const events = st.events.splice(0, st.events.length);   // single drain — shared below
    if (events.some(e => /hit|ko/.test(e)))
      shakeT = Math.max(shakeT, events.includes('ko') ? .5 : .22);

    /* impact fx + push physics. Burst origin = npc head; blood/sweat flies
       toward the player. Getting hit shoves the camera back (spring return). */
    for (const e of events) {
      const lb = st.lastBlow || {};
      hitPos.set(sim.npc.pos.x, HEAD, sim.npc.pos.z);
      const toPlayer = { x: (sim.player.pos.x - sim.npc.pos.x) / (sim.distance() || 1),
                         z: (sim.player.pos.z - sim.npc.pos.z) / (sim.distance() || 1) };
      if (e === 'player-hit' || e === 'npc-hit') {
        const heavy = /hook|upper/.test(lb.kind || '');
        fx.burst(hitPos, { color: 'sweat', n: 14, dir: toPlayer, speed: 1.3 });
        if (heavy || (lb.dmg || 0) >= 15) fx.burst(hitPos, { color: 'blood', n: 24, dir: toPlayer, speed: 1.8 });
        npc.kick.x -= toPlayer.x * (.1 + (lb.dmg || 0) * .008);
        npc.kick.z -= toPlayer.z * (.1 + (lb.dmg || 0) * .008);            // npc knocked back
      } else if (e === 'player-hit-taken') {
        push += .14 + Math.min(.3, (lb.dmg || 10) * .012);              // view shoved back
        fx.burst({ x: sim.player.pos.x, y: EYE * .85, z: sim.player.pos.z - .2 },
                 { color: (lb.dmg || 0) >= 14 ? 'blood' : 'star', n: 18, speed: .8, up: .6, spread: .5 });
      } else if (e === 'player-blocked') {
        push += .06;                                                     // blocked still nudges
      } else if (e === 'ko') {
        push += st.phase === 'playerdown' ? .7 : .55;
        fx.burst(hitPos, { color: 'blood', n: 40, dir: toPlayer, speed: 2.4 });
        fx.burst(hitPos, { color: 'star', n: 18, speed: 1.6, up: 2.2 });
      }
    }
    const dmgStage = st.npc.hp <= 0 ? 4 : st.npc.hp < st.npc.maxHp * .33 ? 3
      : st.npc.hp < st.npc.maxHp * .66 ? 2 : st.npc.hp < st.npc.maxHp * .9 ? 1 : 0;
    if (dmgStage > lastDmgStage) { npc.setDamage(dmgStage); lastDmgStage = dmgStage; }

    world.update(dt, { fight: st, sim, events });
    npc.update(dt, { pos: sim.npc.pos, target: sim.player.pos, npc: st.npc });
    fx.update(dt);

    /* first-person camera: eyes at the player's sim position, aimed down the
       bearing to the NPC. Sway slides the head laterally; hits shake; taking
       a punch shoves the view back (push decays with a spring feel); idle
       breathing bob keeps the player alive between inputs. */
    if (cam) {
      const p = sim.player.pos, n = sim.npc.pos;
      const dx = n.x - p.x, dz = n.z - p.z, d = Math.hypot(dx, dz) || 1;
      const fwdX = dx / d, fwdZ = dz / d, lx = -fwdZ, lz = fwdX;  // fwd + left-of-fwd
      camSway += (sw - camSway) * Math.min(1, dt * 8);
      shakeT = Math.max(0, shakeT - dt);
      push *= Math.exp(-dt * 5.5);                          // spring back
      const shk = shakeT > 0 ? Math.sin(tNow * 90) * shakeT * .06 : 0;
      const bob = Math.sin(tNow * 2.3) * .012 + Math.sin(tNow * 3.7) * .006;  // idle bob
      const weave = Math.sin(tNow * .9) * .02;
      cam.position.set(
        p.x + lx * (camSway * .38 + weave) - fwdX * (push + shk),
        EYE - Math.abs(camSway) * .05 + bob + push * .05,   // head dips then rocks up
        p.z + lz * (camSway * .38 + weave) - fwdZ * (push + shk));
      cam.lookAt(n.x, HEAD, n.z);
      cam.rotateZ(-camSway * .12 - push * .08);             // head-lean roll + hit tilt
    }
    return { events, state: st, sim, tracker };
  }

  return {
    world, scene: world.scene, npc, sim, fight, tracker, cam,
    step,
    calibrate() { tracker.calibrate?.(); },
    reset() { sim.reset(); fight.reset(); },
    get hands() { return hands; }, get face() { return face; },
  };
}
