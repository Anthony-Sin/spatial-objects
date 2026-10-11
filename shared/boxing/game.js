/* shared/boxing/game.js — the glue between input, sims, world and HUD.

   const game = await createGame({ THREE, renderer, cam, world, hands, face,
                                   video, vendorUrl, manifestUrl,
                                   ringOpts, fistOpts, fightOpts })
     → { world, scene, npc, sim, tracker, fight, cam,
         step(dt, handsState, faceState), calibrate(), reset(),
         get hands, get face }

   Per frame (step):
     FistTracker.update(hands, face) → drain punches/guard/sway
     → RingSim.step(dt, {sway, playerDodge, playerStep, npcDir: fight.npcDir(), npcStunned})
     → Fight.step(dt, {punches, guard, sway, distance})
     → drain fight.state.events (single consumer — HUD/scene share the copy)
     → scene.update / npc.update / first-person camera
     → returns { events, state, sim, tracker } for the page's HUD.

   THREE is passed in (never imported) so this module stays node-importable.
   Contract modules (ring/fists/fight) are static imports — they're pure JS.
*/

import { RingSim } from './ring.js';
import { FistTracker } from './fists.js';
import { Fight, TUNING as FIGHT_TUNING, VSTATS } from './fight.js';
import { buildScene } from './scene.js';
import { createNpc } from './npc.js';
import { makeFx } from './fx.js';
import { buildBoxer } from './protoBoxer.js';
import { entranceSign } from './entrance.js';

export async function createGame(opts = {}) {
  const { THREE, cam } = opts;
  const world = opts.world || buildScene(THREE, opts.renderer);
  const npc = await createNpc(THREE, {
    scene: world.scene, manifestUrl: opts.manifestUrl, manifest: opts.manifest,
  });
  /* The rival's frame sets the gap it fights at: VSTATS.range scales its
     attack distance (a long/big rival swings from farther out), and the
     ring parks it just inside that reach so it never has to crowd the lens
     to land. Caller ringOpts still override everything. */
  const stat = VSTATS[npc.variant] || VSTATS.bubble;
  const atkRange = FIGHT_TUNING.attackAt * (Number.isFinite(stat?.range) ? stat.range : 1);
  const sim = new RingSim({
    punchRange: atkRange - .05,
    midRange: atkRange + .5,
    ...(Number.isFinite(stat?.size) && stat.size > 0 ? { npcRadius: stat.size } : {}),
    ...(opts.ringOpts || {}),
  });
  const playerAvatar = buildBoxer(THREE, { variant: 'bubble', playerLook: true,
    palette: { skin: 0xeebd91, skinShade: 0xce9673, skinLight: 0xf5cba3,
      shorts: 0x354d7a, trim: 0xffe9b8, leaf: 0xffc53d,
      glove: 0xff6b57, gloveDeep: 0xb43f39, gloveShine: 0xffa18c } });
  world.scene.add(playerAvatar.group);
  const tracker = new FistTracker(opts.fistOpts || {});
  const fight = new Fight({ npcName: npc.name?.toUpperCase?.() || 'PIP',
    npcVariant: npc.variant, ...(opts.fightOpts || {}) });

  // webcam trackers: use the ones the page hands in; create only if a video
  // element is provided (dynamic imports keep this file node-safe)
  let hands = opts.hands || null, face = opts.face || null;
  if (opts.video) {
    const vend = opts.vendorUrl || './vendor/mediapipe';
    if (!face) try { face = await (await import('../face.js')).Face.create(opts.video, vend); } catch {}
    if (!hands) try { hands = (await import('../hands.js')).default.create(opts.video, vend); } catch {}
  }
  // pages that boot trackers async can hand in thunks — they always read
  // the latest instance, so late-resolving creates aren't lost to a stale
  // null captured here at createGame() time
  const readHands = opts.getHands || (() => hands);
  const readFace = opts.getFace || (() => face);

  /* camera sits low — chin/chest height — so the fighter's face rides the
     upper frame and its gloves own the center. NPC punches thrown at glove
     height come straight at the lens and read as real hits. */
  const EYE = (npc.eyeY ?? 1.4) * .78;
  const HEAD = (npc.headY ?? 1.0) * .85;

  const fx = makeFx(THREE, world.scene, cam);
  let camSway = 0, shakeT = 0, dodged = false;
  let skipRequested = !!opts.skipIntro;
  let tNow = skipRequested ? FIGHT_TUNING.introT : 0;
  let introStartedAt = typeof performance !== 'undefined' ? performance.now() : 0;
  let downCamT = 0;
  let neutralFaceSize = 0, lastFaceSize = 0, depthStep = 0;
  let push = 0, pushUp = 0;                       // camera shove-back + uppercut launch
  let snapYaw = 0;                                // hook snaps the head sideways
  let hitStopT = 0;                               // impact freeze — classic hit-stop
  let slowT = 0;                                  // perfect-dodge slow-mo (real seconds left)
  let holdT = 0;                                  // landed glove stays planted in your face
  let dodgeX = 0, dodgeY = 0;                     // eased camera slip / duck offset
  let prevDodgeKey = 0;
  let swingRes = null;                            // live npc swing: null → 'landed'|'dodged'
  let outroT = 0;                                 // seconds since the final bell
  let lookX = null;                               // damped head-turn target (world x)
  const SLOW_LEN = .55, SLOW_SCALE = .22;
  const strike = { reach: null, y: null };        // npc punch target (npc-local)
  const hitPos = new THREE.Vector3();
  const NO_PUNCHES = [];                          // shared empty — splice only when non-empty
  const EMPTY_HS = { hands: [] };
  const GUARD_UP = { left: 1, right: 1 };
  const INTRO_POSE = { hype: 'celebrate', ready: 'block', wave: 'wave',
    point: 'point', victory: 'victory' };
  /* Entrance beats (of introU): you pose ALONE in the ring first; the
     challenger walks on from the crowd edge only once you've had the stage.
     walk-on covers the middle of the intro, first-person blend unchanged. */
  const ENTER_AT = .5, ENTER_LEN = .28;
  const ENT_Z = -(sim.t.radius + 1.4);            // crowd-side spawn, just past
  const entPos = { x: 0, z: ENT_Z };              // the ring posts at any radius
  // Third-person shots use the avatar's own gloves, which are solved to the
  // arms each frame. The first-person canvas is reserved for visible hands.
  const aGloves = [];
  for (const n of ['gloveL', 'gloveR'])
    playerAvatar.parts?.[n]?.children?.forEach(m => aGloves.push(m));

  // per-frame input/output objects are persistent — re-allocated each frame
  // otherwise and it all becomes GC pressure at 60fps
  const simIn = {}, fightIn = {}, worldIn = {}, npcIn = {}, tp = { x: 0, z: 0 };
  const out = { events: null, state: null, sim, tracker, depthStep: 0,
    entranceSign: 'idle', entranceWaiting: false, telegraph: null };

  function step(dt, hs, fs, controls = {}) {
    /* hold the bell while trackers boot: controls.waitForHands means a
       landmarker is still loading (never true once it resolves or fails,
       so camera-denied/mouse players are never blocked). Applies in intro
       AND countdown — skipIntro() jumps straight to countdown and mustn't
       kill the hold, or a slow boot starts the bout with defenseless
       gloves (b3-soak: KO'd at ~39s on a slow link). */
    const waiting = (fight.state.phase === 'intro' || fight.state.phase === 'countdown')
      && !!controls.waitForHands;
    if (waiting) { tNow = 0; introStartedAt = typeof performance !== 'undefined' ? performance.now() : 0; }
    else tNow += dt;
    /* hit-stop: on impact frames the WORLD freezes for ~70-180ms while
       input tracking, camera shake and the glove overlay keep running —
       the punch reads heavy without the fight ever feeling slow. */
    if (hitStopT > 0) hitStopT = Math.max(0, hitStopT - dt);
    // perfect-dodge slow-mo: the world crawls while the glove sails past,
    // then eases back to full speed (input + camera stay real-time)
    if (slowT > 0) slowT = Math.max(0, slowT - dt);
    const slow = slowT > 0 ? SLOW_SCALE + (1 - SLOW_SCALE) * Math.pow(1 - slowT / SLOW_LEN, 3) : 1;
    const fdt = hitStopT > 0 ? 0 : dt * slow;
    /* cornerHold — the halftime pause. The whole bout freezes behind the
       coach card (fight, sim, npc anim, world, fx) while tracking, camera
       and the glove overlay stay live; punches thrown into the break are
       dropped below so nothing lands through the pause. */
    const cornerHold = !!controls.cornerHold;
    const hdt = cornerHold ? 0 : fdt;
    if (holdT > 0) holdT = Math.max(0, holdT - dt);
    tracker.update(hs || EMPTY_HS, fs || null, dt);
    const punches = tracker.punches.length
      ? tracker.punches.splice(0, tracker.punches.length) : NO_PUNCHES;

    // committed dodge hop = a fresh strong lean (edge-triggered, resets in dead zone)
    const sw = tracker.sway || 0;
    let dodge = 0;
    if (Math.abs(sw) >= .75 && !dodged) { dodge = Math.sign(sw); dodged = true; }
    if (Math.abs(sw) < .5) dodged = false;

    const st = fight.state;
    // Two head-driven depth signals sum into the step. Face bbox size is a
    // stable rough depth signal: step in when closer to the camera, step back
    // when farther (neutral captured on first face acquisition and with C).
    // tracker.pitch is chin tilt: nod down to press in, tilt back to retreat —
    // it works seated, no footwork, and a dead zone ignores small changes.
    let targetStep = tracker.pitch || 0;
    if (fs?.found && Number.isFinite(fs.size) && fs.size > .05) {
      lastFaceSize = fs.size;
      if (!neutralFaceSize) neutralFaceSize = fs.size;
      const delta = fs.size / neutralFaceSize - 1;
      if (delta > .16) targetStep += Math.min(1, (delta - .16) / .22);
      else if (delta < -.16) targetStep += Math.max(-1, (delta + .16) / .2);
    }
    targetStep = Math.max(-1, Math.min(1, targetStep));
    /* shrug-level lean ≠ intent: the summed pitch+size signal must clear a
       floor before it steps at all, so micro-nods and settling posture stop
       walking you into the ropes. Deliberate tilts are unaffected — they
       reach far past the floor. Keyboard intent skips the floor entirely. */
    if (Math.abs(targetStep) < .28) targetStep = 0;
    if (Number.isFinite(controls.step) && controls.step !== 0)
      targetStep = Math.max(-1, Math.min(1, controls.step));
    if (st.phase !== 'fighting') targetStep = 0;
    depthStep += (targetStep - depthStep) * (1 - Math.exp(-dt * 9));
    simIn.sway = sw; simIn.playerDodge = dodge; simIn.playerStep = depthStep;
    simIn.npcDir = fight.npcDir();
    simIn.npcStunned = st.npc.action === 'hurt' || st.npc.action === 'down' || st.npc.action === 'stunned';
    sim.step(hdt, simIn);
    // keyboard dodge is edge-triggered (a held key = one slip); duck holds
    const dKey = Math.sign(+controls.dodge || 0);
    fightIn.dodge = cornerHold ? 0 : (dKey && dKey !== prevDodgeKey ? dKey : 0);
    prevDodgeKey = dKey;
    fightIn.punches = cornerHold ? NO_PUNCHES : punches; fightIn.sway = sw;
    fightIn.guard = controls.guard ? GUARD_UP : tracker.guard;   // F key = gloves up
    fightIn.duck = cornerHold ? 0 : Math.max(tracker.duck || 0, +controls.duck || 0);
    fightIn.distance = sim.distance();
    fightIn.riseAspect = cam?.aspect || 1;      // overlay W/H — get-up ring hit-test
    fightIn.riseTouch = NO_PUNCHES;             // glove palms — touch-tag a ring
    if (st.phase === 'playerdown' && st.rise?.active && hs?.hands) {
      /* while you're on the canvas a glove pressed onto the ring counts too —
         the throw never has to fire for "I hit it" to feel true */
      const tl = [];
      for (const h of hs.hands)
        if (h?.palm && Number.isFinite(h.palm.x) && Number.isFinite(h.palm.y))
          tl.push({ x: h.palm.x, y: h.palm.y });
      if (tl.length) fightIn.riseTouch = tl;
    }
    fight.step(waiting ? 0 : hdt, fightIn);
    // The entrance lasts six real seconds even when rendering runs slowly.
    // Start after fight.step so the bell event reaches the HUD this frame.
    const wallIntro = typeof performance !== 'undefined'
      ? (performance.now() - introStartedAt) / (FIGHT_TUNING.introT * 1000) : 0;
    if (st.phase === 'intro' && (wallIntro >= 1 || skipRequested)) {
      fight.startNow(); skipRequested = false;
    }
    /* Emotes belong to the END of the fight: once the bell decides it, the
       camera pulls back onto your boxer and hand signs (or 1-5) play to the
       crowd. The walk-on intro is just a ready stance — no sign prompts. */
    const over = st.phase === 'win' || st.phase === 'lose';
    outroT = over ? outroT + dt : 0;
    const sign = over ? (controls.sign || entranceSign(hs)) : 'idle';
    const introU = Math.max(0, Math.min(1, Math.max(tNow / FIGHT_TUNING.introT, wallIntro)));
    const showAv = (st.phase === 'intro' && introU < .82) || (over && outroT > .7);   // once the lens has cleared its head
    playerAvatar.group.visible = showAv;
    for (const m of aGloves) m.visible = showAv;
    if (showAv) {
      playerAvatar.group.position.set(sim.player.pos.x, 0, sim.player.pos.z);
      // play to the camera — a boxer working the crowd, not swaying at air.
      // (uses last frame's cam position: fine, it pans smoothly anyway)
      const cdx = cam.position.x - sim.player.pos.x, cdz = cam.position.z - sim.player.pos.z;
      playerAvatar.group.rotation.y = Math.atan2(cdx, cdz) * .6 + Math.sin(tNow * .9) * .05;
      // intro: guard-up ready stance; outro: your sign, else win → victory, loss → dazed
      const pose = over ? (INTRO_POSE[sign] || (st.phase === 'win' ? 'victory' : 'hurt')) : 'block';
      playerAvatar.pose(pose, pose === 'block' || pose === 'point' ? 1 : pose === 'hurt' ? .45 : tNow * 1.3);
      /* your live hands pin the glove anchors BEFORE the blend + limb solve:
         close shot keeps them parked by the cheeks, the pulled-back outro
         holds them inside a believable arm reach — hands you don't have
         fall back to the pose's gloves on their own */
      playerAvatar.trackHands(hs, over ? 'wide' : 'close');
      playerAvatar.tick(dt);
    }
    /* Challenger entrance: the ring is YOURS for the first half of the intro
       (npc hidden), then the opponent walks up the center aisle from the
       crowd edge — sim position is untouched, this is purely the visual. */
    const entryU = st.phase === 'intro'
      ? Math.max(0, Math.min(1, (introU - ENTER_AT) / ENTER_LEN)) : 1;
    // Keep the result shot on the player's boxer alone. The opponent returns
    // when a new bout starts and the entrance phase runs again.
    npc.group.visible = entryU > 0 && !over;
    const events = st.events.length
      ? st.events.splice(0, st.events.length) : NO_PUNCHES;   // single drain — shared below

    /* impact fx + push physics. Burst origin = npc head; blood/sweat flies
       toward the player. Getting hit shoves the camera back (spring return).
       fight.step emits BOTH 'player-hit' and 'npc-hit' per landed blow —
       fx/kick run once on 'player-hit' or trade/ko frames would double up. */
    let hasHit = false, hasKo = false;
    if (events.length) {
      const lb = st.lastBlow || {};
      hitPos.set(sim.npc.pos.x, HEAD, sim.npc.pos.z);
      const dd = sim.distance() || 1;
      tp.x = (sim.player.pos.x - sim.npc.pos.x) / dd;
      tp.z = (sim.player.pos.z - sim.npc.pos.z) / dd;
      const toPlayer = tp;
      for (const e of events) {
        if (e === 'ko') hasKo = true;
        else if (e === 'player-hit' || e === 'npc-hit' || e === 'player-hit-taken') hasHit = true;
        if (e === 'npc-punch') swingRes = null;
        else if (e === 'player-hit-taken' || e === 'player-blocked') swingRes = 'landed';
        else if (e === 'player-dodged') swingRes = 'dodged';
        if (e === 'player-hit') {
          hitStopT = Math.max(hitStopT, .07);
          // white impact pop — the freeze + flash frame that sells contact
          fx.burst(hitPos, { color: 'flash', n: 2, dir: toPlayer, speed: .3, size: .4, life: .14, up: .05, spread: .1 });
          const heavy = /hook|upper/.test(lb.kind || '');
          fx.burst(hitPos, { color: 'sweat', n: 7, dir: toPlayer, speed: 1.3, size: .05, life: .5 });
          if (heavy || (lb.dmg || 0) >= 15) fx.burst(hitPos, { color: 'blood', n: 12, dir: toPlayer, speed: 1.8, size: .055, life: .55 });
          const kb = .1 + (lb.dmg || 0) * .008;
          npc.kick.x -= toPlayer.x * kb; npc.kick.z -= toPlayer.z * kb;    // npc knocked back
          // punch-specific physics: uppercut launches it, hooks fling it sideways
          if (lb.kind === 'uppercut') npc.kick.y += .2 + (lb.dmg || 0) * .006;
          if (lb.kind === 'hook') {
            const px = -toPlayer.z, pz = toPlayer.x;                     // lateral, screen-side
            const sgn = lb.side === 'left' ? 1 : -1;
            npc.kick.x += px * sgn * .16; npc.kick.z += pz * sgn * .16;
          }
        } else if (e === 'player-hit-taken') {
          const heavy = (lb.dmg || 0) >= 12;
          hitStopT = Math.max(hitStopT, heavy ? .17 : .12);           // you eat it — hold the frame
          holdT = heavy ? .3 : .22;                                     // glove stays planted on the lens
          push += .14 + Math.min(.3, (lb.dmg || 10) * .012);            // view shoved back
          if (lb.kind === 'upper') pushUp += .26;                        // uppercut rocks the head UP
          // hook whips the head AWAY from the glove: PIP's left lands on your right
          if (lb.kind === 'hook') snapYaw += (lb.side === 'left' ? 1 : -1) * .32;
          hitPos.set(sim.player.pos.x, EYE * .85, sim.player.pos.z - .2);
          fx.burst(hitPos,
                   { color: (lb.dmg || 0) >= 14 ? 'blood' : 'star', n: 18, speed: .8, up: .6, spread: .5 });
        } else if (e === 'perfect-dodge') {
          slowT = SLOW_LEN;                                              // bullet-time fly-by
        } else if (e === 'player-blocked') {
          push += .06;                                                   // blocked still nudges
          hitPos.set(sim.player.pos.x + (lb.side === 'left' ? .18 : -.18), EYE * .85, sim.player.pos.z - .25);
          fx.burst(hitPos, { color: 'flash', n: 3, speed: .4, size: .3, life: .14, up: .1, spread: .2 });
          fx.burst(hitPos, { color: 'star', n: 12, speed: 1.6, size: .055, life: .35, up: .5, spread: .6 });
        } else if (e === 'npc-blocked') {
          hitStopT = Math.max(hitStopT, .04);                            // crisp block friction
          fx.burst(hitPos, { color: 'flash', n: 2, dir: toPlayer, speed: .3, size: .25, life: .12, up: .05 });
          fx.burst(hitPos, { color: 'star', n: 10, dir: toPlayer, speed: 1.4, size: .05, life: .32, up: .4, spread: .5 });
        } else if (e === 'ko') {
          hitStopT = Math.max(hitStopT, .18);
          push += st.phase === 'playerdown' ? .7 : .55;
          fx.burst(hitPos, { color: 'flash', n: 3, dir: toPlayer, speed: .3, size: .5, life: .2, up: .05, spread: .1 });
          fx.burst(hitPos, { color: 'blood', n: 40, dir: toPlayer, speed: 2.4 });
          fx.burst(hitPos, { color: 'star', n: 18, speed: 1.6, up: 2.2 });
        } else if (e === 'npc-punch') {
          // release whoosh — speed-lines off the swinging glove; a fast
          // release is what makes a readable telegraph feel fair, not slow
          fx.burst(hitPos, { color: 'streak', n: 7, dir: toPlayer, speed: 2.6, size: .05, life: .3, up: .4, spread: .55 });
        } else if (e === 'player-dodged') {
          hitPos.set(sim.player.pos.x, EYE, sim.player.pos.z);
          fx.burst(hitPos, { color: 'streak', n: 5, speed: 1.8, size: .04, life: .25, up: .3, spread: .9 });
        }
      }
    }
    if (hasHit || hasKo) shakeT = Math.max(shakeT, hasKo ? .5 : .22);
    // bruise deepens continuously — painted onto the fighter's materials
    npc.setDamage?.(1 - st.npc.hp / (st.npc.maxHp || 1));

    worldIn.fight = st; worldIn.sim = sim; worldIn.events = events;
    world.update(hdt, worldIn);
    if (entryU < 1) {                    // walk the aisle — visual only
      const ee = entryU * entryU * (3 - 2 * entryU);
      entPos.x = sim.npc.pos.x * ee;
      entPos.z = ENT_Z + (sim.npc.pos.z - ENT_Z) * ee;
      npcIn.pos = entPos;
    } else npcIn.pos = sim.npc.pos;
    npcIn.vel = sim.npc.vel;
    npcIn.target = sim.player.pos; npcIn.npc = st.npc;
    /* the swing is aimed at the LENS, not at air in front of PIP: the punching
       glove's npc-local target is the camera's resting spot. A landed glove
       stops just short of the glass (then holds there); a dodged one keeps
       going straight through where your head was. */
    const na = st.npc.action;
    const holding = holdT > 0 && swingRes === 'landed' && na !== 'hurt' && na !== 'down';
    const flyBy = swingRes === 'dodged'
      && (na === 'punch' || ((na === 'whiff' || na === 'stunned') && st.npc.actionT < .15));
    if (st.phase === 'fighting' && (na === 'punch' || holding || flyBy)) {
      const viewPull = .38 + Math.max(0, 1.2 - (cam?.aspect || 1)) * 1.5;
      strike.reach = sim.distance() + viewPull + (flyBy ? .35 : -.3);
      strike.y = EYE - .04;            // aimed where your head WAS — slip and it sails by
    } else strike.reach = null;
    npcIn.strike = strike;
    npc.update(hdt, npcIn);
    if (st.phase === 'intro' && entryU > 0 && entryU < 1)
      npc.pose('celebrate', tNow * 1.8);              // showboat strut
    fx.update(hdt);

    /* first-person camera: eyes at the player's sim position, aimed down the
       bearing to the NPC. Sway slides the head laterally; hits shake; taking
       a punch shoves the view back (push decays with a spring feel); idle
       breathing bob keeps the player alive between inputs. */
    if (cam) {
      const p = sim.player.pos, n = sim.npc.pos;
      /* the head turns to follow PIP only partway and with a lag — PIP's
         footwork drifts across the frame instead of yanking the view; only
         YOUR lean / dodge / step moves the camera with any speed */
      const tgtX = p.x + (n.x - p.x) * .55;
      lookX = lookX === null ? tgtX : lookX + (tgtX - lookX) * (1 - Math.exp(-dt * 3));
      const dx = lookX - p.x, dz = n.z - p.z, d = Math.hypot(dx, dz) || 1;
      const fwdX = dx / d, fwdZ = dz / d, lx = -fwdZ, lz = fwdX;  // fwd + left-of-fwd
      const viewPull = .38 + Math.max(0, 1.2 - (cam.aspect || 1)) * 1.5;
      downCamT += st.phase === 'playerdown' ? dt : -dt * 3;
      downCamT = Math.max(0, Math.min(.8, downCamT));
      const fall = downCamT / .8;
      // dead zone: tracking jitter / tiny posture shifts don't nudge the view
      const swView = Math.abs(sw) < .18 ? 0 : Math.sign(sw) * (Math.abs(sw) - .18) / .82;
      camSway += (swView - camSway) * Math.min(1, dt * 12);
      // committed dodge = a big, fast head move that eases home (snap out, drift back)
      const dd = st.player.dodge?.dir;
      const tx = dd === 'left' ? -1 : dd === 'right' ? 1 : 0;
      const ty = Math.max(dd === 'duck' ? 1 : 0, (fightIn.duck || 0) * .85);   // held duck shows too
      dodgeX += (tx - dodgeX) * (1 - Math.exp(-dt * (tx ? 24 : 8)));
      dodgeY += (ty - dodgeY) * (1 - Math.exp(-dt * (ty ? 24 : 8)));
      shakeT = Math.max(0, shakeT - dt);
      push *= Math.exp(-dt * 5.5);                          // spring back
      pushUp *= Math.exp(-dt * 6);
      snapYaw *= Math.exp(-dt * 7);
      const wob = st.player.hurtT > 0 ? Math.sin(tNow * 17) * st.player.hurtT * .09 : 0;   // rung bell
      const shk = shakeT > 0 ? Math.sin(tNow * 90) * shakeT * .06 : 0;
      const bob = Math.sin(tNow * 2.3) * .016 + Math.sin(tNow * 3.7) * .007;  // idle bob
      // anticipation pull — the lens breathes in as the telegraph charges,
      // then snaps back on release: reads as danger without slowing anything
      const ant = st.npc.action === 'windup' ? (st.npc.telegraph?.t01 || 0) : 0;
      const pull = push + shk + viewPull - ant * .055;
      const lat = camSway * .5 + dodgeX * .46;
      const px = p.x + lx * lat - fwdX * pull;
      const py = EYE - Math.abs(camSway) * .09 - Math.abs(dodgeX) * .08 - dodgeY * .34
        + bob + push * .05 + pushUp;
      const pz = p.z + lz * lat - fwdZ * pull;
      // Film the player's visible boxer first, then move behind them into
      // the tracked first-person view for the opening bell.
      const sweep = Math.max(0, Math.min(1, introU / .72));
      const sweepEase = sweep * sweep * (3 - 2 * sweep);
      const blendU = Math.max(0, Math.min(1, (introU - .70) / .30));
      // outro: ease back out to a front shot of your boxer, PIP behind
      const outU = Math.min(1, outroT / 1.4), outE = outU * outU * (3 - 2 * outU);
      const blend = st.phase === 'intro' ? blendU * blendU * (3 - 2 * blendU) : 1 - outE;
      const shotX = over ? p.x + .55 : p.x - 1.35 + 2.6 * sweepEase;
      const shotY = over ? 1.25 : 1.32 + .2 * Math.sin(sweepEase * Math.PI);
      const shotZ = over ? p.z + 1.45 : p.z + 1.18 + .12 * Math.sin(sweepEase * Math.PI);
      cam.position.set(
        shotX * (1 - blend) + px * blend,
        shotY * (1 - blend) + (py - fall * (py - .35)) * blend,
        shotZ * (1 - blend) + pz * blend);
      const fpY = st.phase === 'npcdown' || (over && st.npc.action === 'down') ? HEAD * .42 : HEAD;
      cam.lookAt((over ? p.x - .15 : p.x) * (1 - blend) + lookX * blend,
        .84 * (1 - blend) + fpY * blend,
        (over ? p.z - .25 : p.z) * (1 - blend) + n.z * blend);
      cam.rotateZ(-camSway * .14 - dodgeX * .2 * blend - push * .08 + fall * .5 + wob * blend);
      cam.rotateY(snapYaw * blend);                         // hook whips the head sideways
      cam.rotateX(push * .4 + pushUp * .6);                 // hits pitch the view upward
    }
    out.events = events; out.state = st; out.depthStep = depthStep;
    out.holdT = holdT; out.slow = slow; out.duck = fightIn.duck;
    out.entranceSign = sign; out.entranceWaiting = waiting;
    out.telegraph = st.npc.telegraph;              // overlay block-side cue
    return out;
  }

  return {
    world, scene: world.scene, npc, playerAvatar, sim, fight, tracker, cam,
    step,
    skipIntro() { if (fight.state.phase === 'intro') { tNow = FIGHT_TUNING.introT; skipRequested = true; } },
    calibrate() { tracker.calibrate?.(); if (lastFaceSize) neutralFaceSize = lastFaceSize; depthStep = 0; },
    /* corner-break reposition — under the blackout both fighters walk back
       to the marks the sim dealt at the opening bell, and every camera
       impulse from the scramble dies with it. Fight state (hp, round, the
       clock, painted bruises) is untouched — this is scenery, not a rematch. */
    recenter() {
      sim.reset();
      push = pushUp = snapYaw = camSway = shakeT = 0;
      dodgeX = dodgeY = 0; dodged = false; prevDodgeKey = 0;
      hitStopT = 0; slowT = 0; holdT = 0; depthStep = 0;
      swingRes = null; lookX = null;
    },
    reset() {
      sim.reset(); fight.reset();
      /* nothing from the finished bout may ride into the next one: camera
         impulses (shove-back, whip-yaw, dodge lean, the down-cam), the dodge
         edge latch, punches still queued in the tracker, and the NPC's
         painted-on bruises all belong to the fight that just ended */
      push = pushUp = snapYaw = camSway = shakeT = downCamT = 0;
      dodgeX = dodgeY = 0; dodged = false; prevDodgeKey = 0;
      tracker.punches.length = 0;
      npc.resetDamage?.();
      neutralFaceSize = lastFaceSize || 0; depthStep = 0; tNow = 0;
      skipRequested = false; hitStopT = 0; slowT = 0; holdT = 0;
      swingRes = null; outroT = 0; lookX = null;
      introStartedAt = typeof performance !== 'undefined' ? performance.now() : 0;
    },
    get hands() { return readHands(); }, get face() { return readFace(); },
  };
}
