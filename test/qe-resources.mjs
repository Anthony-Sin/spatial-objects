#!/usr/bin/env node
/* test/qe-resources.mjs — QE resource governor.

   Gates headless Chromium launches on system headroom (master prompt R2):
     load1 < 10 AND MemAvailable > 2500 MB AND GPU mem used < 6000 MiB.

   Exports:
     snapshot()                         → {load1, load5, memAvailMB,
                                           gpuUtilPct, gpuMemUsedMB,
                                           ok, reasons[]}
     waitForResources({timeoutMs,pollMs}) → resolves with the ok snapshot
                                           (+waitedMs), throws on timeout.
   CLI:  node test/qe-resources.mjs   prints the snapshot, exits 0 ok / 1 not.

   nvidia-smi is optional: if absent or it reports N/A, GPU fields are null
   and the GPU check is treated as satisfied.
*/
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

export const LIMITS = { load1: 10, memAvailMB: 2500, gpuMemUsedMB: 6000 };

/* Test hooks: point these env vars at fake files/values to exercise the
   gate without stressing the shared box. Never set them in real runs. */
const LOADAVG = process.env.QE_LOADAVG || '/proc/loadavg';
const MEMINFO = process.env.QE_MEMINFO || '/proc/meminfo';
const FAKE_GPU_MB = process.env.QE_GPU_MEM_USED; // set → skips nvidia-smi

function gpuStats() {
  if (FAKE_GPU_MB != null)
    return { gpuUtilPct: null, gpuMemUsedMB: +FAKE_GPU_MB };
  try {
    const out = execFileSync('nvidia-smi',
      ['--query-gpu=utilization.gpu,memory.used', '--format=csv,noheader,nounits'],
      { timeout: 5000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .trim().split('\n')[0] || '';
    const [u, m] = out.split(',').map(s => s.trim());
    return {
      gpuUtilPct: /^\d+$/.test(u) ? +u : null,   // e.g. "[N/A]" → null
      gpuMemUsedMB: /^\d+$/.test(m) ? +m : null,
    };
  } catch {
    return { gpuUtilPct: null, gpuMemUsedMB: null }; // no nvidia-smi → GPU ok
  }
}

export function memAvailMB() {
  const m = readFileSync(MEMINFO, 'utf8').match(/^MemAvailable:\s+(\d+)\s*kB/m);
  return m ? Math.round(+m[1] / 1024) : 0;
}

export function snapshot() {
  const parts = readFileSync(LOADAVG, 'utf8').trim().split(/\s+/);
  const load1 = +parts[0], load5 = +parts[1];
  const mem = memAvailMB();
  const { gpuUtilPct, gpuMemUsedMB } = gpuStats();
  const reasons = [];
  if (!(load1 < LIMITS.load1))
    reasons.push(`load1 ${load1} >= ${LIMITS.load1}`);
  if (!(mem > LIMITS.memAvailMB))
    reasons.push(`MemAvailable ${mem}MB <= ${LIMITS.memAvailMB}MB`);
  if (gpuMemUsedMB != null && !(gpuMemUsedMB < LIMITS.gpuMemUsedMB))
    reasons.push(`gpuMemUsed ${gpuMemUsedMB}MiB >= ${LIMITS.gpuMemUsedMB}MiB`);
  return { load1, load5, memAvailMB: mem, gpuUtilPct, gpuMemUsedMB,
    ok: reasons.length === 0, reasons };
}

export async function waitForResources(
  { timeoutMs = 120000, pollMs = 2000, log = console.log } = {}) {
  const t0 = Date.now();
  for (let cycle = 0; ; cycle++) {
    const s = snapshot();
    if (s.ok) {
      if (cycle) log(`[qe-res] resources OK after ${Date.now() - t0}ms ` +
        `(load1=${s.load1} mem=${s.memAvailMB}MB gpu=${s.gpuMemUsedMB ?? 'n/a'}MiB)`);
      return { ...s, waitedMs: Date.now() - t0 };
    }
    if (Date.now() - t0 >= timeoutMs)
      throw new Error(`waitForResources timed out after ${timeoutMs}ms — ` +
        s.reasons.join('; '));
    log(`[qe-res] gate blocked (cycle ${cycle}): ${s.reasons.join('; ')}` +
      ` — retry in ${pollMs}ms`);
    await delay(pollMs);
  }
}

/* ---- CLI ---- */
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const s = snapshot();
  console.log(JSON.stringify(s, null, 1));
  console.log(s.ok ? 'RESOURCES OK' : 'RESOURCES INSUFFICIENT: ' + s.reasons.join('; '));
  process.exit(s.ok ? 0 : 1);
}
