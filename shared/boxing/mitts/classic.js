/* mitts/classic.js — 'Old Faithful': the original work-glove silhouette,
   painted boxing-glove red. The same blob-palm + knuckle-bump mitten the
   hand tracker always drew (fingers merged into one solid silhouette —
   bumpy knuckle edge, no skeleton), recolored to leather red with a cream
   laced cuff.

   When real landmarks ride in via o.lm (21 px pts) the mitt articulates
   with the hand exactly like the old renderer; without them it draws a
   closed-fist blob at pos (gallery/bots).

   Perf: no shadowBlur (a full extra blur pass per stroke — ~12× per glove
   per frame); the drop shadow is one cheap offset silhouette pass instead.
   Every working buffer is module-scratch — nothing allocates per frame. */
const FINGERS = [[1, 2, 3, 4], [5, 6, 7, 8], [9, 10, 11, 12], [13, 14, 15, 16], [17, 18, 19, 20]];
const RED = '#dc493c', RED_D = '#a92d2a', INK = '#2b2118',
  CUFF = '#fff8ec', LACE = '#dc493c', SHINE = 'rgba(255,248,236,.85)';
const SHADOW = 'rgba(20,16,20,.3)';
const RING = [0, 1, 5, 9, 13, 17];          // palm outline landmark ids
const PUFF = [.3, .12, .07, .07, .07, .16]; // per-RING-position outward puff
const LACES = [-.28, 0, .28];
const PASSES = [{ c: INK, dw: 5 }, { c: RED, dw: 0 }];

/* closed-fist 21-pt cloud — same mitten shape the mouse fallback uses,
   unit scale (span lm0→lm9 = 1.35) */
const FIST = [[0, 1.15], [.55, .78], [.8, .5], [1.0, .32], [1.12, .18],
  [.36, -.12], [.4, -.4], [.42, -.6], [.44, -.74],
  [0, -.2], [0, -.48], [0, -.7], [0, -.86],
  [-.34, -.12], [-.38, -.36], [-.4, -.55], [-.42, -.68],
  [-.6, -.05], [-.66, -.26], [-.7, -.42], [-.72, -.52]];

/* arm-anchored variant: same mitten but every digit chain is already folded
   in — a hand-less pose has no fingers to articulate, so the chains stay
   short knuckle bumps on the fist edge instead of splaying into stubs. */
const ARM_FIST = [[0, 1.15], [.55, .78], [.6, .62], [.64, .48], [.68, .34],
  [.36, -.12], [.37, -.18], [.38, -.24], [.4, -.3],
  [0, -.2], [0, -.27], [0, -.33], [0, -.38],
  [-.34, -.12], [-.35, -.18], [-.36, -.24], [-.36, -.3],
  [-.6, -.05], [-.62, -.1], [-.64, -.14], [-.65, -.17]];

/* module scratch — refilled every draw, never retained by the caller */
const SCR_FIST = FIST.map(() => ({ x: 0, y: 0 }));
const SCR_P = FIST.map(() => ({ x: 0, y: 0 }));
const BLOB_R = RING.map(() => ({ x: 0, y: 0 }));

function blobPalm(ctx, P, col) {
  let cx = 0, cy = 0;
  for (const i of RING) { cx += P[i].x; cy += P[i].y; }
  cx /= 6; cy /= 6;
  for (let i = 0; i < 6; i++) {
    const p = P[RING[i]], r = BLOB_R[i], k = PUFF[i];
    r.x = p.x + (p.x - cx) * k; r.y = p.y + (p.y - cy) * k;
  }
  const last = BLOB_R[5], first = BLOB_R[0];
  ctx.beginPath();
  ctx.moveTo((last.x + first.x) / 2, (last.y + first.y) / 2);
  for (let i = 0; i < 6; i++) {
    const r = BLOB_R[i], n = BLOB_R[(i + 1) % 6];
    ctx.quadraticCurveTo(r.x, r.y, (r.x + n.x) / 2, (r.y + n.y) / 2);
  }
  ctx.closePath();
  ctx.fillStyle = col; ctx.fill();
}

const strokeFingers = (ctx, P) => {
  // one path, five sub-chains: each subpath still strokes as its own capsule
  // but costs a single stroke() call instead of five — ~15 calls/glove saved
  ctx.beginPath();
  for (const ch of FINGERS) {
    ctx.moveTo(P[ch[0]].x, P[ch[0]].y);
    for (let j = 1; j < 4; j++) ctx.lineTo(P[ch[j]].x, P[ch[j]].y);
  }
  ctx.stroke();
};

export const ID = 'classic';
export const NAME = 'Old Faithful';

export function draw(ctx, pos, o = {}) {
  if (!pos) return;
  const reach = Math.max(0, Math.min(2.4, o.reach ?? 1));
  // Landmarks determine the shape, while this cap prevents a close hand from
  // swallowing the whole opponent on small screens. (o.cap raises it for
  // overlays that dress a world-space glove, e.g. the outro avatar.)
  const size = Math.min(o.cap ?? 96, Math.max(28, pos.size * (0.55 + 0.45 * Math.min(reach, 1.8))));
  const dim = o.dim ?? 1;
  const sq = o.squash ?? 0;

  /* landmarks: real ones when handed in, else the fist cloud at pos.
     Everything is re-anchored on pos.x/y so manual poses still work. */
  let P;
  if (o.arm) {
    /* o.arm = {x,y} px anchor up the arm: the same fist mitt, rotated so its
       wrist rides down the arm — drawn over a sleeve that runs the glove's
       forearm back onto the stub arm so the hand can't float off it. */
    const adx = pos.x - o.arm.x, ady = pos.y - o.arm.y;
    const ad = Math.hypot(adx, ady) || 1, ux = adx / ad, uy = ady / ad;
    const a = Math.atan2(uy, ux) + Math.PI / 2;
    const ca = Math.cos(a), sa = Math.sin(a);
    const x0 = pos.x - ux * size * 1.02, y0 = pos.y - uy * size * 1.02;
    const x1 = pos.x - ux * size * .1, y1 = pos.y - uy * size * .1;
    ctx.save();
    ctx.globalAlpha = dim; ctx.lineCap = 'round';
    ctx.save(); ctx.translate(0, 5);
    ctx.strokeStyle = SHADOW; ctx.lineWidth = size * .5;
    ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
    ctx.restore();
    ctx.strokeStyle = INK; ctx.lineWidth = size * .5 + 8;
    ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
    ctx.strokeStyle = RED; ctx.lineWidth = size * .5;
    ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
    ctx.restore();
    P = SCR_FIST;
    for (let i = 0; i < 21; i++) {
      const u = ARM_FIST[i];
      P[i].x = pos.x + (u[0] * ca - u[1] * sa) * size;
      P[i].y = pos.y + (u[0] * sa + u[1] * ca) * size;
    }
  } else if (o.lm && o.lm.length >= 21) P = o.lm;
  else {
    P = SCR_FIST;
    for (let i = 0; i < 21; i++) { P[i].x = pos.x + FIST[i][0] * size; P[i].y = pos.y + FIST[i][1] * size; }
  }

  // rescale the hand around its palm center so the mitt matches pos.size
  let cx = 0, cy = 0;
  for (const i of RING) { cx += P[i].x; cy += P[i].y; }
  cx /= 6; cy /= 6;
  const span = Math.hypot(P[0].x - P[9].x, P[0].y - P[9].y) || 1;
  const k = (size * 1.35) / span;
  for (let i = 0; i < 21; i++) { SCR_P[i].x = pos.x + (P[i].x - cx) * k; SCR_P[i].y = pos.y + (P[i].y - cy) * k; }
  P = SCR_P;

  // A fist still follows each knuckle, but the finger tips fold into one
  // padded lobe instead of looking like five separate extended fingers.
  if (o.kind === 'fist') {
    for (let fi = 1; fi < 5; fi++) {
      const ch = FINGERS[fi], base = P[ch[0]];
      for (let j = 1; j < 4; j++) {
        const p = P[ch[j]];
        p.x = base.x + (p.x - base.x) * .25;
        p.y = base.y + (p.y - base.y) * .25;
      }
    }
  }

  const fw = size * .24;
  const ang = Math.atan2(P[9].y - P[0].y, P[9].x - P[0].x);

  ctx.save();
  ctx.globalAlpha = dim;
  ctx.translate(pos.x, pos.y);
  // The landmarks already contain the hand's angle. The generated fallback
  // needs the pose angle because it has no tracked orientation of its own.
  if (!o.lm) ctx.rotate((pos.ang || 0) * .35);
  ctx.translate(-pos.x, -pos.y);
  if (sq > 0) {                            // punch smear along the thrust
    ctx.translate(0, -size * .3 * sq);
    ctx.scale(1 - sq * .14, 1 + sq * .28);
  }

  // one solid glove: INK pass silhouettes fingers + palm as one shape;
  // RED pass paints it slightly smaller — ink survives only at the edge.
  // Fake drop shadow first: one offset silhouette pass ≈ free vs shadowBlur.
  ctx.save();
  ctx.translate(0, 5);
  ctx.strokeStyle = ctx.fillStyle = SHADOW;
  ctx.lineWidth = fw + 5;
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  strokeFingers(ctx, P);
  blobPalm(ctx, P, SHADOW);
  ctx.restore();
  for (const pass of PASSES) {
    ctx.strokeStyle = ctx.fillStyle = pass.c;
    ctx.lineWidth = fw + pass.dw;
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    strokeFingers(ctx, P);
    blobPalm(ctx, P, pass.c);
  }

  // A thumb pad and short knuckle highlight give the silhouette a glove
  // surface while leaving the landmark-driven outline intact. (The arm-
  // anchored mitt skips the pad — a bare tip ellipse reads as a stalk.)
  const thumb = P[4], palm = P[1];
  if (!o.arm) {
    ctx.beginPath();
    ctx.ellipse(thumb.x, thumb.y, fw * .72, fw * .52, ang, 0, Math.PI * 2);
    ctx.fillStyle = RED_D; ctx.fill();
    ctx.strokeStyle = INK; ctx.lineWidth = Math.max(2, fw * .13); ctx.stroke();
  }
  ctx.beginPath();
  ctx.moveTo(palm.x - fw * .7, palm.y - fw * .5);
  ctx.quadraticCurveTo(P[9].x, P[9].y - fw * 1.15, P[13].x + fw * .35, P[13].y - fw * .35);
  ctx.strokeStyle = SHINE; ctx.lineWidth = Math.max(2.5, fw * .18); ctx.stroke();

  // cuff band + red lace ticks (worn like the old rim stripe)
  ctx.save(); ctx.translate(P[0].x, P[0].y); ctx.rotate(ang);
  ctx.beginPath(); ctx.roundRect(-fw * 1.7, -fw * 1.05, fw * 1.6, fw * 2.1, fw * .45);
  ctx.fillStyle = CUFF; ctx.fill(); ctx.strokeStyle = INK; ctx.lineWidth = 2; ctx.stroke();
  ctx.lineWidth = 2; ctx.strokeStyle = LACE;
  ctx.beginPath();
  for (const lx of LACES) {
    ctx.moveTo(-fw * 1.55 + lx * fw, -fw * .8);
    ctx.lineTo(-fw * 1.55 + lx * fw, fw * .8);
  }
  ctx.stroke();
  ctx.restore();

  // sheen arc across the knuckle bumps
  ctx.beginPath();
  ctx.arc(P[9].x - fw * .4, P[9].y - fw * .6, fw * 1.1, Math.PI * 1.05, Math.PI * 1.6);
  ctx.strokeStyle = SHINE; ctx.lineWidth = Math.max(2, fw * .22); ctx.lineCap = 'round'; ctx.stroke();
  ctx.restore();
}
