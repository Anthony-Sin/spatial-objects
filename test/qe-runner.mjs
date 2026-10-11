#!/usr/bin/env node
/* test/qe-runner.mjs — generic headless page-QE runner (puppeteer-core + /usr/bin/chromium).

   Usage:
     node test/qe-runner.mjs <url> [--name <n>] [--seconds <n>] [--gpu]

   Behavior (master prompt R1/R2):
     • ALWAYS gates the Chromium launch on waitForResources() — load1 < 10,
       MemAvailable > 2500 MB, GPU mem < 6000 MiB.
     • ONE Chromium at a time: advisory lockfile .teamwork/qe/.chromium.lock
       (pid-stamped, auto-stales after 15 min) serializes concurrent runners.
     • Chromium is niced via a tiny `nice -n 10` wrapper script in os.tmpdir()
       (puppeteer can't inject nice itself; executablePath → wrapper).
     • Captures pageerror, console error+warning, requestfailed, HTTP ≥400.
     • rAF FPS sampling (pattern from test/fps-probe.mjs): median frame ms,
       avg fps, worst 1-s-window fps, p95, worst frame.
     • Samples the Chromium process-tree RSS (sum of /proc/<pid>/status VmRSS
       over the browser pid + descendants) once a second while running.
     • Mid-run re-check: if MemAvailable drops below 1500 MB the browser is
       killed, JSON records aborted:"resources", exit 2.
     • Default flags: fake-media so getUserMedia resolves instantly +
       SwiftShader GL (matches test/boxing-page.mjs). --gpu switches to the
       Vulkan flag set from test/fps-probe.mjs.
     • Writes .teamwork/qe/<name>.json, prints a summary.
       Exit 1 on any pageerror / console-error / failed request / HTTP≥400,
       exit 2 on resource abort, else 0.
*/
import puppeteer from 'puppeteer-core';
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync,
  statSync, readdirSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { waitForResources, snapshot, memAvailMB } from './qe-resources.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, '..', '.teamwork', 'qe');
const LOCK = join(OUT_DIR, '.chromium.lock');
const CHROMIUM = '/usr/bin/chromium';
const MEM_FLOOR_MB = 1500;

/* ---------- arg parse ---------- */
const args = process.argv.slice(2);
const url = args.find(a => !a.startsWith('--'));
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const name = (opt('name', null) ||
  (url || 'run').replace(/^https?:\/\//, '').replace(/[^\w.-]+/g, '_').slice(0, 60))
  .replace(/[^\w.-]+/g, '_');
const seconds = +opt('seconds', 15);
const useGpu = args.includes('--gpu');

if (!url) {
  console.error('usage: node test/qe-runner.mjs <url> [--name <n>] [--seconds <n>] [--gpu]');
  process.exit(64);
}

/* ---------- event store ---------- */
const ev = { pageerrors: [], consoleErrors: [], consoleWarnings: [],
  requestfailed: [], httpStatus: [] };
// matches test/boxing-page.mjs: tracker INFO lines surface as console "error" but are benign
const BENIGN = /^INFO:|XNNPACK|TensorFlow|Created TensorFlow|GroupMarker/i;

/* ---------- chromium pid-tree RSS ---------- */
function treeRssMB(pid) {
  if (!pid) return null;
  let kids;
  try {
    kids = new Map();
    for (const d of readdirSync('/proc')) {
      if (!/^\d+$/.test(d)) continue;
      try {
        const stat = readFileSync(`/proc/${d}/stat`, 'utf8');
        const rp = stat.lastIndexOf(')');
        const ppid = +stat.slice(rp + 2).split(' ')[1];
        if (!kids.has(ppid)) kids.set(ppid, []);
        kids.get(ppid).push(+d);
      } catch { /* gone */ }
    }
  } catch { return null; }
  let total = 0;
  const stack = [pid], seen = new Set();
  while (stack.length) {
    const p = stack.pop();
    if (seen.has(p)) continue;
    seen.add(p);
    try {
      const m = readFileSync(`/proc/${p}/status`, 'utf8')
        .match(/^VmRSS:\s+(\d+)\s*kB/m);
      if (m) total += +m[1];
    } catch { /* gone */ }
    for (const c of kids.get(p) || []) stack.push(c);
  }
  return Math.round(total / 1024);
}

/* ---------- one-chromium advisory lock ---------- */
async function acquireLock(log) {
  mkdirSync(OUT_DIR, { recursive: true });
  for (;;) {
    let stale = true;
    if (existsSync(LOCK)) {
      try {
        const { pid, ts } = JSON.parse(readFileSync(LOCK, 'utf8'));
        const alive = pid && (() => { try { process.kill(pid, 0); return true; } catch { return false; } })();
        if (alive && Date.now() - ts < 15 * 60 * 1000) stale = false;
      } catch { /* unreadable → stale */ }
      if (stale) { try { unlinkSync(LOCK); } catch { } }
    }
    if (!stale) {
      log('[qe-run] another qe-runner chromium holds the lock — waiting 3s');
      await delay(3000);
      continue;
    }
    try {
      writeFileSync(LOCK, JSON.stringify({ pid: process.pid, ts: Date.now() }), { flag: 'wx' });
      return;
    } catch { await delay(250); } // raced someone else
  }
}
const releaseLock = () => { try { unlinkSync(LOCK); } catch { } };

/* ---------- nice wrapper ---------- */
function niceChromium() {
  const p = join(tmpdir(), `qe-nice-chromium-${process.pid}.sh`);
  writeFileSync(p, `#!/bin/sh\nexec nice -n 10 ${CHROMIUM} "$@"\n`, { mode: 0o755 });
  return p;
}

/* ---------- run ---------- */
const log = (...a) => console.log('[qe-run]', ...a);
const result = {
  tool: 'qe-runner', name, url, gpu: useGpu,
  startedAt: new Date().toISOString(), gate: null, fps: null,
  ramMB: { peak: null, samples: [] }, events: ev,
  aborted: null, loadError: null, exitCode: 0,
};
let browser = null, wrapper = null, abortTimer = null, rssTimer = null;

try {
  await acquireLock(log);

  log('gating launch on resources…');
  const gate = await waitForResources({ timeoutMs: 120000, pollMs: 2000, log });
  result.gate = { ...gate };

  wrapper = niceChromium();
  const gpuArgs = ['--use-angle=vulkan', '--enable-features=Vulkan',
    '--ignore-gpu-blocklist', '--enable-gpu-rasterization'];
  const swArgs = ['--use-gl=angle', '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader'];
  browser = await puppeteer.launch({
    executablePath: wrapper, headless: 'new',
    args: ['--no-sandbox', '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream', '--mute-audio',
      '--window-size=1600,900', ...(useGpu ? gpuArgs : swArgs)],
  });
  const pid = browser.process()?.pid;
  log(`chromium up (pid ${pid}, niced, gpu=${useGpu})`);

  // mid-run memory floor
  abortTimer = setInterval(() => {
    const m = memAvailMB();
    if (m < MEM_FLOOR_MB && !result.aborted) {
      result.aborted = 'resources';
      log(`MemAvailable ${m}MB < ${MEM_FLOOR_MB}MB — killing chromium`);
      try { browser?.process()?.kill('SIGKILL'); } catch { }
    }
  }, 2000);
  rssTimer = setInterval(() => {
    const r = treeRssMB(pid);
    if (r != null) {
      result.ramMB.samples.push(r);
      if (!result.ramMB.peak || r > result.ramMB.peak) result.ramMB.peak = r;
    }
  }, 1000);

  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 900 });
  page.on('pageerror', e => ev.pageerrors.push(String(e)));
  page.on('console', m => {
    const t = m.type(), txt = m.text();
    if (t === 'error') ev.consoleErrors.push({ text: txt, benign: BENIGN.test(txt) });
    else if (t === 'warning') ev.consoleWarnings.push(txt);
  });
  page.on('requestfailed', r => ev.requestfailed.push(
    { url: r.url(), error: r.failure()?.errorText, type: r.resourceType() }));
  page.on('response', r => { if (r.status() >= 400) ev.httpStatus.push(
    { url: r.url(), status: r.status() }); });

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })
    .catch(e => { result.loadError = String(e); });
  if (result.aborted) throw new Error('aborted: resources');
  await delay(3000); // settle: module eval, tracker boot, first paints

  if (!result.loadError && !result.aborted) {
    log(`sampling rAF for ${seconds}s…`);
    result.fps = await page.evaluate(async (secs) => {
      const t0 = performance.now();
      const frames = [];
      let last = t0, worst = 0, worstWin = 0, winStart = t0, winN = 0;
      await new Promise(done => {
        const tick = (t) => {
          const dt = t - last; last = t;
          if (dt > 0 && dt < 1000) frames.push(dt);
          if (dt > worst) worst = dt;
          winN++;
          if (t - winStart > 1000) {
            const f = 1000 * winN / (t - winStart);
            if (!worstWin || f < worstWin) worstWin = f;
            winStart = t; winN = 0;
          }
          if (t - t0 < secs * 1000) requestAnimationFrame(tick); else done();
        };
        requestAnimationFrame(tick);
      });
      frames.sort((a, b) => a - b);
      const sum = frames.reduce((a, b) => a + b, 0) || 1;
      return {
        frames: frames.length,
        avgFps: +(1000 * frames.length / sum).toFixed(1),
        p50Ms: +(frames[Math.floor(frames.length * .5)] ?? 0).toFixed(1),
        p95Ms: +(frames[Math.floor(frames.length * .95)] ?? 0).toFixed(1),
        worstMs: +worst.toFixed(1),
        worst1sFps: +(worstWin || 0).toFixed(1),
      };
    }, seconds).catch(e => ({ error: String(e) }));
  }
} catch (e) {
  if (result.aborted) result.exitCode = 2;
  else { result.fatal = String(e); result.exitCode = 1; }
} finally {
  clearInterval(abortTimer); clearInterval(rssTimer);
  if (browser) { try { await Promise.race([browser.close(), delay(8000)]); }
    catch { try { browser.process()?.kill('SIGKILL'); } catch { } } }
  if (wrapper) { try { rmSync(wrapper); } catch { } }
  releaseLock();
}

/* ---------- verdict ---------- */
const hardErrors =
  ev.pageerrors.length +
  ev.consoleErrors.filter(c => !c.benign).length +
  ev.requestfailed.length +
  ev.httpStatus.length;
if (result.aborted) result.exitCode = 2;
else if (!result.exitCode) result.exitCode = (hardErrors || result.loadError) ? 1 : 0;
result.durationMs = Date.now() - new Date(result.startedAt).getTime();

mkdirSync(OUT_DIR, { recursive: true });
const outPath = join(OUT_DIR, name + '.json');
writeFileSync(outPath, JSON.stringify(result, null, 1));

console.log('---- qe-runner summary ----');
console.log(`url=${url} gpu=${useGpu} seconds=${seconds}`);
console.log(`fps=${JSON.stringify(result.fps)}`);
console.log(`chromiumRSS peak=${result.ramMB.peak}MB samples=${result.ramMB.samples.length}`);
console.log(`pageerrors=${ev.pageerrors.length} consoleErrors=${ev.consoleErrors.length}` +
  ` (benign=${ev.consoleErrors.filter(c => c.benign).length})` +
  ` warnings=${ev.consoleWarnings.length} reqFailed=${ev.requestfailed.length}` +
  ` http>=400=${ev.httpStatus.length}`);
if (result.aborted) console.log('ABORTED: resources');
if (result.loadError) console.log('loadError: ' + result.loadError);
console.log(`json → ${outPath}`);
process.exit(result.exitCode);
