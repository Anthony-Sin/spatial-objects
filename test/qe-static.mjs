#!/usr/bin/env node
/* test/qe-static.mjs — static checks over the 4 top-level HTML pages.

   Checks (brief w1):
     1. Every <script type="module"> block is written to a temp .mjs file
        and syntax-checked with `node --check`.
     2. Every <script type="importmap"> parses as JSON; every mapped
        relative/absolute path exists on disk.
     3. Every import/export-from/dynamic-import specifier in inline modules
        AND every .js under shared/ that is relative resolves to a real file.
        Bare specifiers must be covered by the importmap of every page whose
        module graph reaches the file that uses them (crawled per page).
     4. Duplicate id="…" attributes within a file.

   Prints findings; exits 1 if any, else 0.
   Pure static — no server, no browser.
*/
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync,
  readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PAGES = ['index.html', 'lineup.html', 'gallery.html', 'boxing.html'];
/* w9-qe-pages owns these — new bug-class checks FAIL on owned files but are
   only notes on foreign files (their owners fix them, not us). */
const OWNED_PAGES = new Set(['index.html', 'lineup.html', 'gallery.html']);
const OWNED_SHARED = new Set(['shared/hands.js', 'shared/face.js',
  'shared/glove.js', 'shared/track-worker.js']);
const findings = [];
const notes = [];
const fail = (file, line, msg) => {
  findings.push({ file, line, msg });
  console.log(`FAIL  ${file}:${line}  ${msg}`);
};
const note = m => { notes.push(m); console.log('note  ' + m); };
const flag = (owned, file, line, msg) =>
  owned ? fail(file, line, msg) : note(`${file}:${line} ${msg}`);
const lineOf = (src, idx) => src.slice(0, idx).split('\n').length;
/* is `i` lexically inside an OPEN `try { …` block? Walk try-keywords back
   and brace-count: if the nearest try's block is still unclosed at i the
   call is try-guarded; a catch/finally that already balanced the block
   does NOT count (a call inside `catch {}` isn't protected by that try).
   Supersedes the crude "try in a 500-char window / tries>catches" guess —
   that one wrongly cancelled an enclosing try whenever an earlier try…catch
   pair sat inside the lookback. */
const nearTry = (code, i, back = 4000) => {
  const lo = Math.max(0, i - back);
  for (let t = code.lastIndexOf('try', i); t !== -1 && t >= lo; ) {
    const b4 = code[t - 1], af = code[t + 3];
    if ((b4 && /[\w$]/.test(b4)) || (af && /[\w$]/.test(af))) {
      t = t > 0 ? code.lastIndexOf('try', t - 1) : -1;   // entry/retry — not the keyword
      continue;
    }
    const brace = code.indexOf('{', t + 3);
    if (brace === -1 || brace >= i) {
      t = t > 0 ? code.lastIndexOf('try', t - 1) : -1;
      continue;
    }
    let d = 1;
    for (let j = brace + 1; j < i && d > 0; j++)
      d += code[j] === '{' ? 1 : code[j] === '}' ? -1 : 0;
    if (d > 0) return true;                            // try's block still open → i is inside
    t = t > 0 ? code.lastIndexOf('try', t - 1) : -1;   // this try closed before i — look back
  }
  return false;
};

/* ---- wave-3 generic hardening checks — run over inline module bodies, all
   page-reachable local files (notes for foreign files), and shared/*.js ---- */
function hardenChecks(code0, line0, file, owned) {
  /* blank block comments (index-preserving) so comment text can't trip the
     source patterns — 'await import()' in a doc comment isn't a call */
  const code = code0.replace(/\/\*[\s\S]*?\*\//g, m =>
    m.replace(/[^\n]/g, ' '));

  // localStorage reads outside try — getItem/removeItem throw SecurityError
  // where storage is blocked (private mode, denied site data)
  for (const m of code.matchAll(/\blocalStorage\.(?:getItem|removeItem)\s*\(/g))
    if (!nearTry(code, m.index))
      flag(owned, file, line0 + lineOf(code, m.index) - 1,
        `${m[0].replace(/\s*\($/, '')} outside try/catch — throws where storage is blocked`);

  // HTML-string sinks: markup from a variable is the DOM-XSS class.
  // Quoted-literal RHS (incl. static templates) is fine; interpolation isn't.
  for (const m of code.matchAll(/\.(?:innerHTML|outerHTML)\s*=\s*/g)) {
    const after = code.slice(m.index + m[0].length, m.index + m[0].length + 400);
    if (/^['"]/.test(after)) continue;                                  // quoted literal
    if (after.startsWith('`') && !after.includes('${')) continue;       // static template
    flag(owned, file, line0 + lineOf(code, m.index) - 1,
      'innerHTML/outerHTML assigned a non-literal — storage/user-fed markup is DOM XSS');
  }
  for (const m of code.matchAll(/\binsertAdjacentHTML\s*\(|document\.write\s*\(/g))
    flag(owned, file, line0 + lineOf(code, m.index) - 1,
      `'${m[0].replace(/\s*\($/, '')}' HTML-string sink — audit the markup source`);

  // 'webglcontextrestored' must not unconditionally restart the render loop:
  // a rAF scheduled before 'lost' can still be pending → doubled chain forever
  for (const m of code.matchAll(/addEventListener\(\s*['"]webglcontextrestored['"]/g)) {
    let body = code.slice(m.index, m.index + 400);
    const end = body.indexOf('});');                      // bound to the call, not the file
    if (end >= 0) body = body.slice(0, end);
    const arg = body.replace(/^[^,]*,/, '');              // just the handler arg
    if (/^\s*[\w$.]+\s*$/.test(arg)) continue;            // named handler — can't judge statically
    if (!/\bif\b|\.reload\b/.test(arg))
      flag(owned, file, line0 + lineOf(code, m.index) - 1,
        'webglcontextrestored restarts the loop unconditionally — pending rAF → doubled chain');
  }

  // viewport reads inside a rAF/rVFC-driven render path but no resize /
  // orientation listener → canvas/camera caches stale sizes on resize,
  // browser-zoom (DPR change), and device rotation
  if (/\binnerWidth\b|\binnerHeight\b/.test(code)
      && /requestAnimationFrame\s*\(|requestVideoFrameCallback\s*\(/.test(code)
      && !/addEventListener\(\s*['"](?:resize|orientationchange)/.test(code)
      && !/\bonresize\s*=/.test(code))
    flag(owned, file, line0,
      'innerWidth/innerHeight in a render loop but no resize listener — stale-size cache');

  // dynamic imports must be failure-guarded: a failed chunk must degrade,
  // not kill the module before UI wiring (menu dead-button class)
  for (const m of code.matchAll(/await\s+(?:Promise\.all\s*\(\[[^\]]*?)?import\s*\(/gs)) {
    const i = m.index;
    const guarded = nearTry(code, i) || /\.catch\s*\(/.test(code.slice(i, i + 700));
    if (!guarded)
      flag(owned, file, line0 + lineOf(code, i) - 1,
        'await import() unguarded — a failed chunk kills the module before UI wiring');
  }

  // raw number parse straight off localStorage — NaN/adversarial-string leak
  // (the boxing:volume Number(getItem) bug class)
  for (const m of code.matchAll(/\b(?:Number|parseFloat|parseInt)\s*\(\s*localStorage\.getItem/g))
    flag(owned, file, line0 + lineOf(code, m.index) - 1,
      'Number()/parseFloat()/parseInt() directly on getItem — validate, NaN leaks');

  // teardown calls that can throw must be try-guarded — an escaping
  // landmarker.close()/worker.terminate() abandons every cleanup line after
  // it (the _adopt class: close threw → landmarker stayed truthy → every
  // future _initLocal early-returned → no inline fallback on the next death)
  for (const m of code.matchAll(/\.(?:close|terminate)\s*(?:\?\.)?\s*\(/g))
    if (!nearTry(code, m.index))
      flag(owned, file, line0 + lineOf(code, m.index) - 1,
        `'${m[0].replace(/\s*\($/, '')}' outside try/catch — a throwing teardown abandons the rest of cleanup`);

  // storage objects mutated in place need shape validation first — a corrupt
  // JSON value (null/42/"x") then throws on property set (boxing:ko class)
  for (const m of code.matchAll(/(?:const|let)\s+(\w+)\s*=\s*(?:[\w.]+\.)?get\s*\(\s*['"]boxing:[\w-]+['"]\s*,\s*\{[\s\S]*?\}\s*\)/g)) {
    const window_ = code.slice(m.index, m.index + m[0].length + 400);
    const name = m[1];
    if (new RegExp(`\\b${name}\\s*\\.\\s*[\\w$]+\\s*(?:[+\\-*/|&^%]?=(?!=)|\\+\\+|--)`).test(window_)
      && !new RegExp(`typeof\\s+${name}\\s*===\\s*['"]object['"]`).test(window_))
      flag(owned, file, line0 + lineOf(code, m.index) - 1,
        `stored object '${name}' mutated without shape check — corrupt value throws`);
  }
}

/* ---------- extractors ---------- */
const SCRIPT_RE = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
const blocks = (html, type) => {
  const out = [];
  for (const m of html.matchAll(SCRIPT_RE))
    if (new RegExp(`type\\s*=\\s*["']${type}["']`, 'i').test(m[1]))
      out.push({ body: m[2], idx: m.index });
  return out;
};
const SPEC_RE = /(?:import|export)\s+(?:[\w${},*\s]+\s+from\s+)?['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]/g;
const specifiers = code => {
  const out = [];
  for (const m of code.matchAll(SPEC_RE)) out.push(m[1] || m[2]);
  return out.filter(Boolean);
};
const isRel = s => s.startsWith('./') || s.startsWith('../') || s.startsWith('/');
const resolveRel = (spec, fromDir) =>
  resolve(fromDir, spec.replace(/^\//, './')); // '/x' treated as site-root-relative

function* walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.name.endsWith('.js') || e.name.endsWith('.mjs')) yield p;
  }
}

const tmp = mkdtempSync(join(tmpdir(), 'qe-static-'));
let checked = 0;
try {
  for (const page of PAGES) {
    const pagePath = join(ROOT, page);
    if (!existsSync(pagePath)) { fail(page, 0, 'file missing'); continue; }
    const html = readFileSync(pagePath, 'utf8');
    const pageDir = dirname(pagePath);

    /* duplicate ids */
    const ids = new Map();
    for (const m of html.matchAll(/\bid\s*=\s*["']([^"']+)["']/g)) {
      const id = m[1];
      if (ids.has(id))
        fail(page, lineOf(html, m.index), `duplicate id="${id}" (first at line ${ids.get(id)})`);
      else ids.set(id, lineOf(html, m.index));
    }

    /* importmap */
    const maps = new Map(); // specifier → true
    for (const b of blocks(html, 'importmap')) {
      let j;
      try { j = JSON.parse(b.body); }
      catch (e) { fail(page, lineOf(html, b.idx), `importmap JSON parse: ${e.message}`); continue; }
      for (const section of ['imports', 'scopes']) {
        const obj = j[section] || {};
        const entries = section === 'scopes'
          ? Object.values(obj).flatMap(o => Object.entries(o))
          : Object.entries(obj);
        for (const [k, v] of entries) {
          maps.set(k, true);
          if (/^https?:/i.test(v)) { note(`${page}: importmap '${k}' → remote ${v} (skipped existence)`); continue; }
          if (!existsSync(resolveRel(v, pageDir)))
            fail(page, lineOf(html, b.idx), `importmap '${k}' → '${v}' not on disk`);
        }
      }
    }

    /* inline module blocks → node --check + specifier crawl roots */
    const mods = blocks(html, 'module');
    if (!mods.length) note(`${page}: no module scripts`);
    const queue = [];
    mods.forEach((b, i) => {
      checked++;
      const f = join(tmp, `${page}.${i}.mjs`);
      writeFileSync(f, b.body);
      try {
        execFileSync(process.execPath, ['--check', f], { stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (e) {
        fail(page, lineOf(html, b.idx),
          `module[${i}] node --check: ${String(e.stderr).trim().split('\n').pop()}`);
      }
      queue.push({ code: b.body, fromDir: pageDir, fromFile: `${page} inline module[${i}]`, line: lineOf(html, b.idx) });
    });

    /* crawl module graph: relative imports must exist; bare imports must be
       covered by THIS page's importmap (the map is what the browser uses).
       Page-reachable local files also get the wave-3 hardening checks as
       NOTES — foreign files (mockups, shared/* owned elsewhere) can't be
       fixed here but their bugs are routable. shared/ is skipped — the
       shared-walk below covers it with proper ownership. */
    const seen = new Set();
    const crawlFiles = [];
    while (queue.length) {
      const { code, fromDir, fromFile, line } = queue.shift();
      for (const spec of specifiers(code)) {
        if (isRel(spec)) {
          const abs = resolveRel(spec, fromDir);
          if (!existsSync(abs)) {
            fail(page, line, `${fromFile} imports '${spec}' — not on disk`);
            continue;
          }
          if (!seen.has(abs) && /\.m?js$/.test(abs) && abs.startsWith(ROOT)) {
            seen.add(abs);
            try {
              const code2 = readFileSync(abs, 'utf8');
              const rel = abs.slice(ROOT.length + 1);
              if (!rel.startsWith('shared/')) crawlFiles.push({ rel, code: code2 });
              queue.push({ code: code2, fromDir: dirname(abs),
                fromFile: rel, line: 1 });
            } catch { }
          }
        } else if (!/^https?:/i.test(spec)) {
          if (!maps.has(spec))
            fail(page, line, `${fromFile} imports bare '${spec}' — not in ${page}'s importmap`);
        }
      }
    }
    for (const { rel, code } of crawlFiles) hardenChecks(code, 1, rel, false);

    /* ---- w9 round-2 bug-class checks (fail on owned pages, note others) */
    const owned = OWNED_PAGES.has(page);

    // contract: no emojis in UI — Emoji_Presentation chars in markup
    for (const m of html.matchAll(/\p{Emoji_Presentation}/gu))
      flag(owned, page, lineOf(html, m.index),
        `emoji U+${m[0].codePointAt(0).toString(16).toUpperCase()} in markup — contract says draw shapes, no emojis`);

    /* ---- wave-5 (b5-pages) a11y media-query checks ----
       OS-level signals the page must honor: a stylesheet that animates but
       never mentions prefers-reduced-motion ignores the vestibular
       setting; outline:none with no :focus-visible anywhere erases the
       keyboard focus indicator entirely. */
    const cssBlob = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)]
      .map(m => m[1]).join('\n');
    if (cssBlob) {
      if (/(?:animation|transition)(?:-[\w]+)?\s*:/.test(cssBlob)
          && !/prefers-reduced-motion/.test(cssBlob))
        flag(owned, page, 0,
          'CSS animates but no prefers-reduced-motion media query — OS vestibular setting ignored');
      if (/outline\s*:\s*(?:none|0)\b/.test(cssBlob) && !/:focus-visible\b/.test(cssBlob))
        flag(owned, page, 0,
          'outline:none with no :focus-visible replacement — keyboard focus indicator erased');
    }

    // every local src=/href= (and meta-refresh url=) must resolve on disk
    for (const m of html.matchAll(/\b(?:src|href)\s*=\s*["']([^"']+)["']/gi)) {
      const u = m[1];
      if (/^(?:https?:|data:|mailto:|#|javascript:)/i.test(u)) continue;
      const p = u.split('?')[0];
      if (!p || !existsSync(resolve(pageDir, p)))
        flag(owned, page, lineOf(html, m.index), `resource '${u}' — not on disk`);
    }
    for (const m of html.matchAll(/content\s*=\s*["'][^"']*?\burl=([^"'\s]+)["']/gi)) {
      const u = m[1];
      if (!/^(?:https?:|data:)/i.test(u) && !existsSync(resolve(pageDir, u)))
        flag(owned, page, lineOf(html, m.index), `meta-refresh '${u}' — not on disk`);
    }

    for (const { body, idx } of mods) {
      const line = lineOf(html, idx);
      // leftover markers must never ship
      for (const m of body.matchAll(/\b(?:TODO|FIXME|XXX|HACK)\b/g))
        flag(owned, page, line + lineOf(body, m.index) - 1, `leftover '${m[0]}' marker in module code`);

      // unguarded JSON.parse / localStorage write = corrupt-storage crash class
      for (const m of body.matchAll(/\bJSON\.parse\s*\(/g))
        if (!nearTry(body, m.index))
          flag(owned, page, line + lineOf(body, m.index) - 1, 'JSON.parse outside try/catch — corrupt localStorage kills the module');
      for (const m of body.matchAll(/\blocalStorage\.setItem\s*\(/g))
        if (!nearTry(body, m.index))
          flag(owned, page, line + lineOf(body, m.index) - 1, 'localStorage.setItem outside try/catch — throws when storage is full/blocked');

      // literal '#id' lookups must name an id that exists in this page
      for (const m of body.matchAll(/getElementById\(\s*['"]([\w-]+)['"]/g))
        if (!new RegExp(`id=["']${m[1]}["']`).test(html))
          flag(owned, page, line + lineOf(body, m.index) - 1, `getElementById('${m[1]}') — no such id in ${page}`);
      for (const m of body.matchAll(/(?:querySelector(?:All)?|\$)\(\s*['"]#([\w-]+)['"]/g))
        if (!new RegExp(`id=["']${m[1]}["']`).test(html))
          flag(owned, page, line + lineOf(body, m.index) - 1, `querySelector('#${m[1]}') — no such id in ${page}`);

      // WebGL hardening: constructing a renderer without probing first, or a
      // rAF loop with no webglcontextlost handling — both page-killers
      if (/new\s+THREE\.WebGLRenderer|WebGLRenderer\s*\(/.test(body)) {
        if (!/getContext\(\s*['"]webgl/.test(body))
          flag(owned, page, line, 'WebGLRenderer without a webgl context probe — creation failure crashes the module');
        if (/requestAnimationFrame\s*\(/.test(body) && !/webglcontextlost/i.test(body))
          flag(owned, page, line, 'render loop without webglcontextlost handling — lost context burns a dead rAF loop');
      }

      // quoted './x' or '../x' literals (non-import references: workers, fetches, hrefs)
      for (const m of body.matchAll(/['"](\.{1,2}\/[^'"?\s`]+)['"]/g)) {
        const p = m[1];
        if (!existsSync(resolve(pageDir, p)))
          flag(owned, page, line + lineOf(body, m.index) - 1, `'${p}' literal — not on disk`);
      }

      // a STATIC relative import can't be try/caught — if a decorative dep
      // (3D backdrop, stage engine) fails to load, the whole module dies and
      // every UI listener it wired dies with it. Modules that wire the DOM
      // should fetch optional deps via dynamic import() inside try.
      if (/addEventListener|getElementById|querySelector/.test(body))
        for (const m of body.matchAll(/^\s*import\s[^;()]*?from\s*['"](\.[^'"]+)['"]/gm))
          flag(owned, page, line + lineOf(body, m.index) - 1,
            `static import '${m[1]}' in a DOM-wiring module — a failed dep kills the UI; prefer dynamic import() inside try`);

      // wave-3 generic hardening checks over the inline module body
      hardenChecks(body, line, page, owned);
    }
  }

  /* every .js under shared/ — all import specifiers: relative must resolve
     even if a file isn't reachable from a current page */
  const shared = join(ROOT, 'shared');
  if (existsSync(shared)) {
    for (const f of walk(shared)) {
      const rel = f.slice(ROOT.length + 1);
      const code = readFileSync(f, 'utf8');
      for (const spec of specifiers(code)) {
        if (isRel(spec) && !existsSync(resolveRel(spec, dirname(f))))
          fail(rel, 1, `imports '${spec}' — not on disk`);
      }

      /* w9 round-2: bug-class checks (fail on w9-owned shared files) */
      const relOwned = OWNED_SHARED.has(rel);
      // quoted './x' literals: Worker/fetch/asset paths — they may resolve
      // file-relative (new URL('./w.js', import.meta.url)) OR page-relative
      // (fetch('./shared/…') runs off the document) — flag only when BOTH miss
      for (const m of code.matchAll(/['"](\.{1,2}\/[^'"?\s`]+)['"]/g)) {
        const p = m[1];
        if (!existsSync(resolve(dirname(f), p)) && !existsSync(resolve(ROOT, p)))
          flag(relOwned, rel, lineOf(code, m.index), `'${p}' literal — resolves neither file- nor page-relative`);
      }
      for (const m of code.matchAll(/\bJSON\.parse\s*\(/g))
        if (!nearTry(code, m.index))
          flag(relOwned, rel, lineOf(code, m.index), 'JSON.parse outside try/catch — corrupt storage kills the caller');
      for (const m of code.matchAll(/\b(?:TODO|FIXME|XXX|HACK)\b/g))
        flag(relOwned, rel, lineOf(code, m.index), `leftover '${m[0]}' marker`);
      // wave-3 generic hardening checks (fail on owned shared files, note otherwise)
      hardenChecks(code, 1, rel, relOwned);
      // syntax check each shared module too — cheap, catches dead-file rot
      checked++;
      const tf = join(tmp, rel.replace(/[^\w.-]+/g, '_'));
      writeFileSync(tf, code);
      try {
        execFileSync(process.execPath, ['--check', tf], { stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (e) {
        fail(rel, 1, `node --check: ${String(e.stderr).trim().split('\n').pop()}`);
      }
    }
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

/* ================= wave-4 (b4-pages) dynamic probes =================
   Static regexes can't prove the double-grace boot races, stop() reaping a
   still-booting worker, _initLocal-vs-'ready' ordering, or track-worker's
   protocol robustness — those are behavioral. This section runs the REAL
   shared/{hands,face,track-worker}.js in Node under stubbed browser
   globals + a file-backed fake vision bundle. The grace/stuck/respawn
   clocks shrink via the create() {bootMs,stuckMs,respawnMs} opts and every
   assertion keys on an observable OUTCOME (adopted? delegate? state?), not
   on which timer fired — so a loaded box can't flake the ordering. */
const probe = (ok, file, msg) => {
  if (ok) return;
  fail(file, 0, `probe: ${msg}`);
};
const ptick = (ms = 15) => new Promise(r => setTimeout(r, ms));
const puntil = async (pred, ms = 3000) => {
  const t0 = Date.now();
  while (!pred()) { if (Date.now() - t0 > ms) return false; await ptick(8); }
  return true;
};
let unhandled = 0;
process.on('unhandledRejection', () => unhandled++);

async function dynamicProbes() {
  const VEND = mkdtempSync(join(tmpdir(), 'qe-vend-'));
  try {
    writeFileSync(join(VEND, 'vision_bundle.mjs'), `
      /* fake MediaPipe bundle — stands in for the ~13MB download. Timing and
         failure hooks ride globalThis so the probe controls ordering. */
      const mk = async (o) => {
        globalThis.__lmPending = (globalThis.__lmPending || 0) + 1;
        try {
          if (globalThis.__lmDelay)
            await new Promise(r => setTimeout(r, globalThis.__lmDelay));
          if (globalThis.__lmFail) throw new Error('createFromOptions boom');
          const lm = { o, closed: 0,
            close() { this.closed++;
              if (globalThis.__lmCloseThrow) throw new Error('close boom'); },
            detectForVideo(frame, ts) {
              (globalThis.__detectLog ||= []).push(ts);
              if (globalThis.__detectThrow) throw new Error('detect boom');
              if (globalThis.__detectUndef) return undefined;   // skipped frame, not a fault
              return { landmarks: [], handedness: [], detections: [] };
            } };
          (globalThis.__lmLog ||= []).push(lm);
          return lm;
        } finally { globalThis.__lmPending--; }
      };
      export const FilesetResolver = { forVisionTasks: async () => ({}) };
      export class HandLandmarker { static createFromOptions(fs, o) { return mk(o); } }
      export class FaceLandmarker { static createFromOptions(fs, o) { return mk(o); } }
      export class FaceDetector { static createFromOptions(fs, o) { return mk(o); } }
    `);
    const VEND_URL = pathToFileURL(VEND).href.replace(/\/$/, '');
    const DEAD_URL = 'http://127.0.0.1:1/none';   // unsupported scheme → instant import failure

    /* ---- browser-global stubs (set BEFORE the real modules import) ---- */
    const fakeWorkers = [];
    const RealWorker = class {
      constructor(url) { this.url = String(url); this.msgs = []; this.terminated = false;
        this.onmessage = null; this.onerror = null; fakeWorkers.push(this); }
      postMessage(m) { if (globalThis.__failPost) throw new Error('post boom');
        this.msgs.push(m); }
      terminate() { this.terminated = true; }
      emit(d) { this.onmessage?.({ data: d }); }
      err() { this.onerror?.(new Event('error')); }
    };
    globalThis.Worker = RealWorker;
    globalThis.location ??= { href: 'http://qe.local/index.html' };
    globalThis.requestAnimationFrame ??= (cb) => setTimeout(() => cb(performance.now()), 16);
    globalThis.VideoFrame ??= class {
      constructor(v) { this.timestamp = (v?.currentTime ?? 0) * 1e6;
        this.displayWidth = v?.videoWidth || 0; this.displayHeight = v?.videoHeight || 0;
        this.closed = 0; }
      close() { this.closed++; }
    };
    globalThis.OffscreenCanvas ??= class { constructor(w, h) { this.width = w; this.height = h; } };

    const fakeVideo = () => {
      const v = { readyState: 2, currentTime: 0, videoWidth: 640, videoHeight: 480,
        _rvc: null, requestVideoFrameCallback(cb) { v._rvc = cb; return 1; } };
      v.step = (t = .04) => { v.currentTime += t; const cb = v._rvc; v._rvc = null;
        cb?.(performance.now(), {}); };
      return v;
    };

    const { Hands } = await import(new URL('../shared/hands.js', import.meta.url).href);
    const { Face } = await import(new URL('../shared/face.js', import.meta.url).href);
    const VALID_HAND = Array.from({ length: 21 }, (_, i) => ({ x: .1 + i * .01, y: .3, z: 0 }));
    const OPTS = { bootMs: 60, stuckMs: 70, respawnMs: 40 };
    const make = async (Ctor, vid, vend = VEND_URL) => {
      const r = await Promise.race([Ctor.create(vid, vend, OPTS), ptick(4000).then(() => 'TIMEOUT')]);
      return r === 'TIMEOUT' ? null : r;
    };
    const isHands = (Ctor) => Ctor.name === 'Hands';
    const gotHands = (h) => isHands(h.constructor) ? h.state.hands.length : h.state.found;
    const resetFlags = () => { globalThis.__lmDelay = 0; globalThis.__lmCloseThrow = false;
      globalThis.__lmFail = false; globalThis.__failPost = false;
      globalThis.__detectThrow = false; globalThis.__detectUndef = false; };

    for (const Ctor of [Hands, Face]) {
      const F = `shared/${Ctor.name.toLowerCase()}.js`;

      /* A) 'ready' inside grace-1 → immediate adopt, frames flow, results
            clear the flight gate, stop() reaps the adopted worker */
      {
        const v = fakeVideo(), n0 = fakeWorkers.length;
        const p = Ctor.create(v, VEND_URL, OPTS);
        await puntil(() => fakeWorkers.length > n0);
        const w = fakeWorkers.at(-1);
        probe(w.msgs.some(m => m.type === 'init'), F,
          `${Ctor.name}: boot worker never got its init message`);
        w.emit({ type: 'ready', delegate: 'gpu' });
        const h = await p;
        probe(h && h._worker === w && h.delegate === 'gpu-worker' && h._bootW === null,
          F, `${Ctor.name}: grace-1 adopt failed (worker=${!!h?._worker}, delegate=${h?.delegate})`);
        v.step();
        probe(w.msgs.some(m => m.type === 'frame'), F,
          `${Ctor.name}: adopted worker never received a frame`);
        w.emit({ type: 'result', landmarks: [], handedness: [], inferMs: 4 });
        probe(h._inFlight === false, F, `${Ctor.name}: result did not clear _inFlight`);
        h.stop();
        probe(w.terminated && h._stopped, F, `${Ctor.name}: stop() did not reap adopted worker`);
      }

      /* B) 'ready' landing between the two grace races (past the first
            BOOT_MS, before the second expires) → still 'ok', no inline */
      {
        const v = fakeVideo(), n0 = fakeWorkers.length;
        const p = Ctor.create(v, VEND_URL, OPTS);
        await puntil(() => fakeWorkers.length > n0);
        const w = fakeWorkers.at(-1);
        await ptick(OPTS.bootMs + 30);                     // past grace-1
        w.emit({ type: 'ready', delegate: 'cpu' });
        const h = await p;
        probe(h && h._worker === w && h.delegate === 'cpu-worker',
          F, `${Ctor.name}: 'ready' in grace-2 was not adopted (delegate=${h?.delegate})`);
        probe(h && h.landmarker === null, F,
          `${Ctor.name}: inline landmarker built despite worker 'ok'`);
        h?.stop();
      }

      /* C) spawnP 'fail' inside race-2 (onerror) → create falls back to
            inline via _initLocal */
      {
        const v = fakeVideo(), n0 = fakeWorkers.length;
        const p = Ctor.create(v, VEND_URL, OPTS);
        await puntil(() => fakeWorkers.length > n0);
        const w = fakeWorkers.at(-1);
        await ptick(OPTS.bootMs + 30);                     // inside race-2
        w.err();
        const h = await p;
        probe(h && h._worker === null && !!h.landmarker
          && (h.delegate === 'cpu' || h.delegate === 'gpu'),
          F, `${Ctor.name}: race-2 'fail' did not land on inline (delegate=${h?.delegate})`);
        probe(w.terminated, F, `${Ctor.name}: failed boot worker not reaped`);
        h?.stop();
      }

      /* D) double-'slow' → create() waits the worker's real verdict instead
            of spawning a competing ~13MB fetch (b4-soak: at 60s both realms
            fetched anyway — the inline cover itself was the bug). While the
            worker still boots NO inline landmarker may be built; a late
            'ready' still adopts. */
      {
        const v = fakeVideo(), lmN = (globalThis.__lmLog || []).length;
        const p = Ctor.create(v, VEND_URL, OPTS);
        await puntil(() => fakeWorkers.length > 0);
        const w = fakeWorkers.at(-1);
        await ptick(OPTS.bootMs * 2 + 40);              // past both grace windows
        probe((globalThis.__lmLog || []).length === lmN,
          F, `${Ctor.name}: inline fetch started while worker still booting`);
        w.emit({ type: 'ready', delegate: 'gpu' });
        const h = await p;
        probe(!!h && h._worker === w && h.delegate === 'gpu-worker' && !h.landmarker,
          F, `${Ctor.name}: late 'ready' after graces not adopted (delegate=${h?.delegate})`);
        h.stop();
      }

      /* D2) a late 'fail' after the graces still lands on inline cover —
            the worker's verdict, not a timer, decides the fallback */
      {
        const v = fakeVideo(), n0 = fakeWorkers.length;
        const p = Ctor.create(v, VEND_URL, OPTS);
        await puntil(() => fakeWorkers.length > n0);
        const w = fakeWorkers.at(-1);
        await ptick(OPTS.bootMs * 2 + 40);
        w.err();
        const h = await p;
        probe(!!h && (h.delegate === 'cpu' || h.delegate === 'gpu'),
          F, `${Ctor.name}: late 'fail' after graces never reached inline (delegate=${h?.delegate})`);
        h?.stop();
      }

      /* E) 'ready' lands while _initLocal's createFromOptions is still
            in flight → the pending landmarker is closed, never installed.
            (Under wait-for-verdict, inline only starts after 'fail' — so
            the racy worker errors first, then reports ready anyway.) */
      {
        globalThis.__lmPending = 0;
        globalThis.__lmDelay = 120;                        // inline build outlives the adopt
        const v = fakeVideo(), n0 = fakeWorkers.length;
        const p = Ctor.create(v, VEND_URL, OPTS);
        await puntil(() => fakeWorkers.length > n0);
        const w = fakeWorkers.at(-1);
        w.err();                                            // verdict 'fail' → _initLocal starts
        const inflight = await puntil(() => (globalThis.__lmPending || 0) > 0, 2500);
        probe(inflight, F, `${Ctor.name}: _initLocal never reached createFromOptions`);
        if (inflight) w.emit({ type: 'ready', delegate: 'gpu' });
        const h = await p;
        globalThis.__lmDelay = 0;
        probe(h && h._worker === w && h.delegate === 'gpu-worker',
          F, `${Ctor.name}: 'ready' during pending _initLocal not adopted`);
        /* the inline wait is itself capped now — `await p` may return BEFORE
           the delayed build lands; the post-await check still has to close
           it when it does (never installed over the adopted worker) */
        const closedPending = await puntil(() => {
          const l = (globalThis.__lmLog || []).at(-1);
          return l && l.closed === 1;
        }, 2500);
        probe(closedPending && h && h.landmarker === null,
          F, `${Ctor.name}: pending inline landmarker installed over the adopted worker`);
        h?.stop();
      }

      /* F) a stray 'ready'+error on an ADOPTED worker must not leave
            _worker dangling at a terminated worker (wedges _inFlight) */
      {
        const v = fakeVideo(), n0 = fakeWorkers.length;
        const p = Ctor.create(v, VEND_URL, OPTS);
        await puntil(() => fakeWorkers.length > n0);
        const w = fakeWorkers.at(-1);
        w.emit({ type: 'ready', delegate: 'gpu' });
        const h = await p;
        probe(h._worker === w, F, `${Ctor.name}: setup adopt failed`);
        w.emit({ type: 'ready', error: 'stray second init' });
        probe(h._worker === null && w.terminated,
          F, `${Ctor.name}: 'ready'+error on adopted worker left _worker dangling`);
        const rearmed = await puntil(() => !!h.landmarker, 1500);
        probe(rearmed, F, `${Ctor.name}: adopted-worker death did not re-arm inline`);
        h.stop();
      }

      /* G) landmarker.close() throwing inside _adopt must not lose the
            adoption, skip the onerror rewire, or leave a stale landmarker
            that blocks every future _initLocal */
      {
        const v = fakeVideo(), n0 = fakeWorkers.length;
        const p = Ctor.create(v, VEND_URL, OPTS);
        await puntil(() => fakeWorkers.length > n0);
        const w = fakeWorkers.at(-1);
        w.err();                                            // 'fail' → inline cover (no timer path)
        const h = await p;
        probe(!!h && !!h.landmarker, F, `${Ctor.name}: setup inline failed`);
        globalThis.__lmCloseThrow = true;
        let threw = false;
        try { w.emit({ type: 'ready', delegate: 'gpu' }); } catch { threw = true; }
        globalThis.__lmCloseThrow = false;
        probe(!threw, F, `${Ctor.name}: landmarker.close() throw escaped _adopt/onmessage`);
        probe(h && h._worker === w && h.landmarker === null && h.delegate === 'gpu-worker',
          F, `${Ctor.name}: adopt incomplete after close() throw`);
        // and the next worker death must still find an inline fallback
        w.err();
        const rearmed = await puntil(() => !!h.landmarker, 1500);
        probe(rearmed, F, `${Ctor.name}: stale landmarker ref blocked _initLocal after death`);
        h?.stop();
      }

      /* H) hung infer (frame taken, never answered, never errored) → the
            STUCK watchdog reaps and a replacement worker respawns */
      {
        const v = fakeVideo(), n0 = fakeWorkers.length;
        const p = Ctor.create(v, VEND_URL, OPTS);
        await puntil(() => fakeWorkers.length > n0);
        const w = fakeWorkers.at(-1);
        w.emit({ type: 'ready', delegate: 'gpu' });
        const h = await p;
        v.step();                                          // send a frame — never answer it
        probe(h._inFlight === true, F, `${Ctor.name}: frame never reached _send`);
        await ptick(OPTS.stuckMs + 60);
        v.step();                                          // watchdog check lives in onNew
        probe(h._worker === null && w.terminated,
          F, `${Ctor.name}: hung infer not reaped by the STUCK watchdog`);
        const respawned = await puntil(() => fakeWorkers.length > n0 + 1, OPTS.respawnMs + 2500);
        probe(respawned, F, `${Ctor.name}: dead worker never respawned`);
        const w2 = fakeWorkers.at(-1);
        probe(w2 !== w && w2.msgs.some(m => m.type === 'init'),
          F, `${Ctor.name}: respawned worker never got init`);
        h.stop();
      }

      /* I) a 'result' from a replaced (zombie) worker must be ignored */
      {
        const v = fakeVideo(), n0 = fakeWorkers.length;
        const p = Ctor.create(v, VEND_URL, OPTS);
        await puntil(() => fakeWorkers.length > n0);
        const w = fakeWorkers.at(-1);
        w.emit({ type: 'ready', delegate: 'gpu' });
        const h = await p;
        h._workerDied(w);                                  // manual reap → respawn scheduled
        await puntil(() => fakeWorkers.at(-1) !== w, OPTS.respawnMs + 2000);
        const w2 = fakeWorkers.at(-1);
        probe(w2 !== w, F, `${Ctor.name}: zombie setup — no respawn`);
        w2.emit({ type: 'ready', delegate: 'gpu' });
        probe(h._worker === w2, F, `${Ctor.name}: respawned worker did not adopt`);
        const before = gotHands(h);
        w.emit({ type: 'result', landmarks: [VALID_HAND],
          handedness: [[{ categoryName: 'Left' }]], inferMs: 1 });
        probe(gotHands(h) === before, F, `${Ctor.name}: zombie result mutated state`);
        h.stop();
      }

      /* J) stop() must reap a still-booting worker that never answered —
            before _bootW it kept downloading ~13MB (or leaked forever if
            'ready' never landed) */
      {
        const v = fakeVideo(), n0 = fakeWorkers.length;
        const h = await make(Ctor, v, DEAD_URL);           // inline can't boot either → 'none'
        probe(h && h.delegate === 'none', F,
          `${Ctor.name}: dead-everything boot should resolve 'none' (got ${h?.delegate})`);
        probe(h && !!v._rvc, F,
          `${Ctor.name}: pump never armed — a late 'ready' could never adopt`);
        const w = fakeWorkers.at(-1);
        probe(!!w && !w.terminated && fakeWorkers.length === n0 + 1,
          F, `${Ctor.name}: boot worker missing before stop()`);
        h.stop();
        probe(w.terminated && h._bootW === null,
          F, `${Ctor.name}: stop() left the still-booting worker running`);
      }

      /* K) stop() is idempotent; post-stop 'result' is ignored */
      {
        const v = fakeVideo(), n0 = fakeWorkers.length;
        const p = Ctor.create(v, VEND_URL, OPTS);
        await puntil(() => fakeWorkers.length > n0);
        const w = fakeWorkers.at(-1);
        w.emit({ type: 'ready', delegate: 'gpu' });
        const h = await p;
        h.stop(); h.stop();
        w.emit({ type: 'result', landmarks: [VALID_HAND],
          handedness: [[{ categoryName: 'Left' }]] });
        probe(!gotHands(h), F, `${Ctor.name}: post-stop result mutated state`);
      }

      /* L) malformed 'result' payloads are dropped at _ingest — hands take
            landmarks as [mesh,…], face as the flat mesh itself */
      {
        const v = fakeVideo(), n0 = fakeWorkers.length;
        const p = Ctor.create(v, VEND_URL, OPTS);
        await puntil(() => fakeWorkers.length > n0);
        const w = fakeWorkers.at(-1);
        w.emit({ type: 'ready', delegate: 'gpu' });
        const h = await p;
        const bad = Array.from({ length: 20 }, () => ({ x: NaN, y: 0 }));
        w.emit({ type: 'result', landmarks: 'oops', handedness: 7, inferMs: 'x' });
        w.emit({ type: 'result',
          landmarks: isHands(Ctor) ? [bad] : bad, handedness: [] });
        // hands gate first-sight detections behind CONFIRM_FRAMES of
        // persistence — emit enough results for the track to go live
        for (let e = 0; e < 4; e++)
          w.emit({ type: 'result',
            landmarks: isHands(Ctor) ? [VALID_HAND] : VALID_HAND,
            handedness: [[{ categoryName: 'Left' }]] });
        const got = gotHands(h);
        probe(isHands(Ctor) ? got === 1 && h.state.hands[0].side === 'right' : got === true,
          F, `${Ctor.name}: malformed payloads not dropped / valid payload lost (got=${got})`);
        h.stop();
      }

      /* M) Worker ctor/postMessage throwing at spawn → 'fail' → inline */
      {
        const v = fakeVideo();
        globalThis.Worker = class { constructor() { throw new Error('no workers'); } };
        let h = await make(Ctor, v);
        globalThis.Worker = RealWorker;
        probe(h && !!h.landmarker && h._worker === null,
          F, `${Ctor.name}: Worker ctor throw did not fall back to inline`);
        h?.stop();
        const v2 = fakeVideo();
        const n2 = fakeWorkers.length;
        globalThis.__failPost = true;
        h = await make(Ctor, v2);
        globalThis.__failPost = false;
        probe(h && !!h.landmarker && h._worker === null,
          F, `${Ctor.name}: init-post throw did not fall back to inline`);
        probe(fakeWorkers.length > n2 && fakeWorkers.at(-1).terminated,
          F, `${Ctor.name}: init-post throw left a half-spawned worker running`);
        h?.stop();
      }

      /* N) grace-3 dead-man cap: a silently-dead worker (posts NOTHING —
            no 'ready', no error, no fatal) must resolve create() after
            bootMs+bootMs+bootMs*3 total: cover with inline while the worker
            KEEPS booting for a late adopt. No inline fetch may start
            before the cap — that's the whole point of verdict-wait. */
      {
        const v = fakeVideo(), n0 = fakeWorkers.length;
        const lmN = (globalThis.__lmLog || []).length;
        const p = Ctor.create(v, VEND_URL, OPTS);
        await puntil(() => fakeWorkers.length > n0);
        const w = fakeWorkers.at(-1);
        await ptick(OPTS.bootMs * 2 + 40);              // inside grace-3 — too early for inline
        probe((globalThis.__lmLog || []).length === lmN, F,
          `${Ctor.name}: inline build started before the grace-3 cap`);
        const h = await Promise.race([p, ptick(3000).then(() => null)]);
        probe(!!h && h._worker === null && !!h.landmarker
          && (h.delegate === 'cpu' || h.delegate === 'gpu'), F,
          `${Ctor.name}: silent-dead worker did not resolve to inline cover (delegate=${h?.delegate})`);
        probe(h && h._bootW === w && !w.terminated, F,
          `${Ctor.name}: grace-3 cap reaped a still-plausibly-booting worker`);
        probe(h && !!v._rvc, F,
          `${Ctor.name}: pump never armed after the cap — a late 'ready' could never adopt`);
        const lm = (globalThis.__lmLog || []).at(-1);
        w.emit({ type: 'ready', delegate: 'gpu' });      // late 'ready' post-inline → adopt + close it
        probe(h && h._worker === w && h.delegate === 'gpu-worker' && h.landmarker === null
          && h._bootW === null && lm && lm.closed === 1, F,
          `${Ctor.name}: post-cap 'ready' did not adopt over inline (delegate=${h?.delegate}, closed=${lm?.closed})`);
        h.stop();
        probe(w.terminated, F, `${Ctor.name}: adopted-after-cap worker not reaped on stop`);
      }

      /* P) a hung INLINE build must not wedge create() either — the cover
            gets its own dead-man window; a late-landing build still
            installs (the pump picks it up) and no second fetch starts */
      {
        globalThis.__lmPending = 0;
        globalThis.__lmDelay = 400;                       // inline build >> the cover cap (bootMs)
        const v = fakeVideo(), n0 = fakeWorkers.length;
        const p = Ctor.create(v, VEND_URL, OPTS);
        await puntil(() => fakeWorkers.length > n0);
        const w = fakeWorkers.at(-1);
        w.err();                                          // verdict 'fail' → _initLocal begins
        const t0 = Date.now();
        const h = await Promise.race([p, ptick(3000).then(() => null)]);
        const dt = Date.now() - t0;
        probe(!!h && dt < 300, F,
          `${Ctor.name}: create() waited ${dt}ms on a hung inline build (cap=${OPTS.bootMs}ms)`);
        probe(h && h.landmarker === null && h._worker === null, F,
          `${Ctor.name}: pending inline build wrongly installed at resolve`);
        probe(h && !!v._rvc, F, `${Ctor.name}: pump not armed after the capped inline wait`);
        const built = await puntil(() => h && h.landmarker, 2500);   // late build still installs
        probe(built && (h.delegate === 'cpu' || h.delegate === 'gpu'), F,
          `${Ctor.name}: late inline build never installed after the cap (delegate=${h?.delegate})`);
        globalThis.__lmDelay = 0;
        h?.stop();
      }

      /* Q) once a worker owns the pump, _initLocal must be a no-op — a late
            'ready' racing the verdict→inline gap must not trigger a second
            ~13MB build. And a superseding _spawn reaps the stale boot
            handle rather than orphaning it. */
      {
        const v = fakeVideo(), n0 = fakeWorkers.length;
        const p = Ctor.create(v, VEND_URL, OPTS);
        await puntil(() => fakeWorkers.length > n0);
        const w = fakeWorkers.at(-1);
        w.emit({ type: 'ready', delegate: 'gpu' });
        const h = await p;
        const lmN = (globalThis.__lmLog || []).length;
        await h._initLocal();
        probe((globalThis.__lmLog || []).length === lmN, F,
          `${Ctor.name}: _initLocal built an inline landmarker over an adopted worker`);
        const stale = new globalThis.Worker('qe-stale');     // an orphan boot handle
        h._bootW = stale;
        h._spawn();                                          // superseding spawn must reap it
        probe(stale.terminated, F,
          `${Ctor.name}: _spawn orphaned the previous still-booting worker`);
        const w2 = fakeWorkers.at(-1);
        w2.emit({ type: 'ready', delegate: 'gpu' });
        probe(h._worker === w2 && w.terminated, F,
          `${Ctor.name}: superseding spawn did not adopt / old worker kept alive`);
        h?.stop();
      }

      /* R) rapid create→stop×20 with verdicts at every reachable lifecycle
            point — no zombie workers, no resurrected landmarkers,
            consistent post-stop state every cycle */
      {
        const base = fakeWorkers.length;
        for (let i = 0; i < 20; i++) {
          const mode = i % 4;
          const v = fakeVideo(), n0 = fakeWorkers.length;
          const p = Ctor.create(v, VEND_URL, OPTS);
          await puntil(() => fakeWorkers.length > n0);
          const w = fakeWorkers.at(-1);
          if (mode === 1) w.emit({ type: 'ready', error: 'init blew up' });  // verdict: init error
          else if (mode === 2) w.err();                                      // verdict: worker death
          else w.emit({ type: 'ready', delegate: 'gpu' });                   // verdict: adopt
          const h = await Promise.race([p, ptick(1500).then(() => null)]);
          if (!h) { probe(false, F, `${Ctor.name}: cycle${i} create() never resolved`); continue; }
          if (mode === 0) {              // adopt → stop → post-stop msgs ignored
            h.stop();
            w.emit({ type: 'result', landmarks: [], handedness: [] });
            w.emit({ type: 'ready', delegate: 'gpu' });      // must NOT resurrect
          } else if (mode === 3) {       // death → respawn armed → stop cancels it
            h._workerDied(w);
            h.stop();
          } else h.stop();               // modes 1/2 — verdict already resolved create
          probe(h._stopped && h._worker === null && h._bootW === null
            && h.landmarker === null && h.delegate === 'none' && h._inFlight === false,
            F, `${Ctor.name}: cycle${i} stop left inconsistent state `
              + `(worker=${!!h._worker}, lm=${!!h.landmarker}, delegate=${h.delegate})`);
        }
        await ptick(OPTS.respawnMs + 80);                    // a leaked respawn timer would fire here
        const alive = fakeWorkers.slice(base).filter(w => !w.terminated);
        probe(alive.length === 0, F,
          `${Ctor.name}: ${alive.length} zombie worker(s) after 20 rapid create/stop cycles`);
      }
      resetFlags();
    }

    /* ---------- shared/track-worker.js — protocol fuzz on the real module */
    {
      const F = 'shared/track-worker.js';
      const outbox = [];
      globalThis.self = { onmessage: null, postMessage: (m) => outbox.push(m) };
      globalThis.__detectLog = []; globalThis.__detectThrow = false;
      await import(new URL('../shared/track-worker.js', import.meta.url).href);
      const post = (m) => self.onmessage({ data: m });
      const readyErr = () => outbox.filter(m => m.type === 'ready' && m.error);
      const readyOk = () => outbox.filter(m => m.type === 'ready' && !m.error);
      const results = () => outbox.filter(m => m.type === 'result');
      const fatals = () => outbox.filter(m => m.type === 'fatal');
      const lastTs = () => (globalThis.__detectLog || []).at(-1);
      const frame = (over = {}) => Object.assign({
        timestamp: 5_000_000, displayWidth: 640, displayHeight: 480,
        close() { this.closed = (this.closed || 0) + 1; } }, over);

      // garbage envelopes — ignored without crashing the handler
      post(42); post('x'); post(null); post({ type: 'nope' });
      probe(true, F, 'garbage envelopes crashed the worker handler');   // reaching here = pass
      // a frame before ANY init — landmarker is null but the page's
      // _inFlight still needs its clearing result
      const preN = results().length;
      post({ type: 'frame', frame: frame() });
      probe(results().length === preN + 1 && results().at(-1).landmarks === null,
        F, 'pre-init frame got no clearing result');
      post({ type: 'init', kind: 'bogus', vendorUrl: VEND_URL });
      probe(await puntil(() => readyErr().length === 1), F,
        "init kind='bogus' did not post ready+error");
      post({ type: 'init', kind: 'hands', vendorUrl: 'javascript:alert(1)' });
      probe(await puntil(() => readyErr().length === 2), F,
        'init with bogus vendorUrl did not post ready+error');
      post({ type: 'init', kind: 'hands', vendorUrl: 'file:///no/such/dir' });
      probe(await puntil(() => readyErr().length === 3), F,
        'init with missing bundle did not post ready+error');
      // a garbage preferCpu is just truthiness — it orders delegates, it
      // can't poison anything; init must still succeed
      post({ type: 'init', kind: 'hands', vendorUrl: VEND_URL, preferCpu: { oops: 1 } });
      probe(await puntil(() => readyOk().length === 1), F,
        'init with garbage preferCpu did not post ready');
      post({ type: 'init', kind: 'hands', vendorUrl: VEND_URL });
      probe(await puntil(() => readyOk().length === 2), F, 'good init never posted ready');
      probe((globalThis.__lmLog || []).length > 0, F, 'init never built a landmarker');
      probe((globalThis.__detectLog || []).includes(1), F, 'warm-up detect never ran');
      // monotonic-ts is a per-LANDMARKER invariant — each init resets lastTs
      // and re-warms at ts=1, so only frames after this init count
      const logBase = (globalThis.__detectLog || []).length;

      // real frame + timestamp-edge frames — every ts reaching detect must stay finite
      let n0 = results().length;
      post({ type: 'frame', frame: frame() });
      probe(results().length === n0 + 1, F, 'a real frame got no result');
      probe(Number.isFinite(lastTs()), F, 'media-stamped frame produced a non-finite ts');
      post({ type: 'frame', frame: frame({ timestamp: Infinity }) });
      probe(Number.isFinite(lastTs()), F,
        'Infinity timestamp poisoned the ts pipeline');
      post({ type: 'frame', frame: frame({ timestamp: NaN }) });
      probe(Number.isFinite(lastTs()), F, 'NaN timestamp poisoned the ts pipeline');
      post({ type: 'frame', frame: frame({ timestamp: -9 }) });
      probe(Number.isFinite(lastTs()), F, 'negative timestamp broke the ts pipeline');
      post({ type: 'frame', frame: frame({ timestamp: undefined }) });
      probe(Number.isFinite(lastTs()), F, 'untimestamped frame broke the ts pipeline');
      const log = (globalThis.__detectLog || []).slice(logBase);
      probe(log.every((t, i) => i === 0 || t > log[i - 1]),
        F, 'infer timestamps not strictly increasing');

      // malformed frames on a LIVE landmarker — answer (clears _inFlight)
      // but must NOT count failN → never escalate a healthy landmarker
      const fatalBefore = fatals().length;
      for (let i = 0; i < 35; i++) {
        post({ type: 'frame' });                              // no frame at all
        post({ type: 'frame', frame: 'definitely not a frame' });
        post({ type: 'frame', frame: { timestamp: 1 } });     // no close() — not a real frame
      }
      probe(fatals().length === fatalBefore,
        F, '105 malformed frame envelopes escalated a healthy landmarker to fatal');

      // genuine detect faults still escalate — failN exists for a dying delegate
      globalThis.__detectThrow = true;
      for (let i = 0; i < 32; i++) post({ type: 'frame', frame: frame() });
      probe(fatals().length === 1, F, 'sustained detect failure never escalated to fatal');
      globalThis.__detectThrow = false;
      n0 = results().length;
      post({ type: 'frame', frame: frame() });
      probe(results().length === n0 + 1, F, 'post-fatal frame got no clearing result');

      // second init re-boots cleanly (kind switch hands→face), close quiets it
      post({ type: 'init', kind: 'face', vendorUrl: VEND_URL });
      probe(await puntil(() => readyOk().length === 3), F,
        'second init (kind switch) did not post ready');
      n0 = results().length;
      post({ type: 'frame', frame: frame() });
      probe(results().length === n0 + 1, F, 'post-reinit frame got no result');
      post({ type: 'close' });
      await ptick(40);                                       // doClose rides the serial chain
      post({ type: 'frame', frame: frame() });
      probe(results().at(-1)?.face === null && results().at(-1)?.landmarks === null,
        F, 'post-close frame did not get the empty result');

      /* wave-5 additions — lifecycle chain + healthy-detect edge cases */

      // init→close→init must serialize on the chain: the superseded init's
      // landmarker is closed, the last init wins, readies stay ordered
      const lmBase = (globalThis.__lmLog || []).length;
      post({ type: 'init', kind: 'hands', vendorUrl: VEND_URL });
      post({ type: 'close' });
      post({ type: 'init', kind: 'face', vendorUrl: VEND_URL });
      probe(await puntil(() => readyOk().length >= 5), F,
        'serialized init→close→init never posted the final ready');
      const chained = (globalThis.__lmLog || []).slice(lmBase);
      probe(chained.length >= 2 && chained[0].closed === 1, F,
        'init→close→init leaked the superseded landmarker');

      // out-of-order media stamps stay monotonic — anchored offset + floor
      const logBase2 = (globalThis.__detectLog || []).length;
      post({ type: 'frame', frame: frame({ timestamp: 9_000_000 }) });
      post({ type: 'frame', frame: frame({ timestamp: 1_000_000 }) });   // media-time went backwards
      const log2 = (globalThis.__detectLog || []).slice(logBase2);
      probe(log2.length === 2 && log2[1] > log2[0], F,
        'out-of-order media stamps broke the monotonic-ts floor');

      // a landmarker returning undefined = a skipped frame, not a fault —
      // still answers a clearing result and must never burn failN
      globalThis.__detectUndef = true;
      const resN = results().length, fatN = fatals().length;
      for (let i = 0; i < 35; i++) post({ type: 'frame', frame: frame() });
      probe(fatals().length === fatN && results().length === resN + 35, F,
        'undefined detect results escalated a healthy landmarker to fatal');
      globalThis.__detectUndef = false;
      post({ type: 'close' });
      await ptick(40);
    }

    /* ---------- shared/glove.js — drawGlove domain fuzz on the real module.
       A recording fake ctx stands in for canvas 2d; every assertion is
       "returned, didn't throw" + canvas state balanced + no poison reached
       a style/text sink. */
    {
      const F = 'shared/glove.js';
      const { drawGlove } = await import(
        new URL('../shared/glove.js', import.meta.url).href);
      const P21 = Array.from({ length: 21 }, (_, i) =>
        ({ x: 50 + i * 8, y: 100 + (i % 4) * 20 }));
      class FakeCtx {
        constructor(failAt) {
          this.calls = []; this.styles = []; this.texts = [];
          this._failAt = failAt; this._saves = 0; this._restores = 0;
          this.canvas = { width: 800, height: 600 };
        }
        _r(n) { this.calls.push(n); if (n === this._failAt) throw new Error(n + ' boom'); }
        save() { this._saves++; } restore() { this._restores++; }
        beginPath() { this._r('beginPath'); } moveTo() { this._r('moveTo'); }
        lineTo() { this._r('lineTo'); } quadraticCurveTo() { this._r('quadraticCurveTo'); }
        closePath() { this._r('closePath'); } arc() { this._r('arc'); }
        arcTo() { this._r('arcTo'); } rect() { this._r('rect'); }
        ellipse() { this._r('ellipse'); } roundRect() { this._r('roundRect'); }
        fill() { this._r('fill'); } stroke() { this._r('stroke'); }
        translate() { this._r('translate'); } rotate() { this._r('rotate'); }
        fillText(t) { this._r('fillText'); this.texts.push(String(t)); }
        measureText() { return { width: 20 }; }
        set fillStyle(v) { this.styles.push(v); }
        set strokeStyle(v) { this.styles.push(v); }
        set lineWidth(v) {} set lineCap(v) {} set lineJoin(v) {}
        set font(v) {} set textAlign(v) {}
      }
      const okCall = (fn) => { try { fn(); return true; } catch { return false; } };

      probe(okCall(() => drawGlove(null, P21)), F, 'null ctx threw');
      const c1 = new FakeCtx();
      probe(okCall(() => drawGlove(c1, P21)) && c1._saves >= 1 && c1._saves === c1._restores,
        F, 'valid draw left unbalanced ctx save/restore');
      probe(c1.calls.includes('fill') && c1.calls.includes('fillText'),
        F, 'valid landmarks produced no paint ops');

      // invalid P shapes must return BEFORE touching ctx state
      for (const bad of [null, [], P21.slice(0, 20),
          P21.map((p, i) => i === 5 ? { x: NaN, y: 0 } : p), 'string', 42]) {
        const c = new FakeCtx();
        probe(okCall(() => drawGlove(c, bad)) && c._saves === 0 && !c.calls.length,
          F, `bad landmarks (${typeof bad}) reached paint or threw`);
      }
      // a Proxy landmark whose getter throws must not escape into the tick
      const proxyP = new Proxy(P21, {
        get(t, k) { if (k === '7') throw new Error('poison'); return t[k]; } });
      const cp = new FakeCtx();
      probe(okCall(() => drawGlove(cp, proxyP)) && cp._saves === 0,
        F, 'throwing proxy landmark escaped validation or reached paint');

      // frozen inputs — rescale path must copy, not mutate
      const cf = new FakeCtx();
      probe(okCall(() => drawGlove(cf,
        Object.freeze(P21.map(Object.freeze)), { kind: 'fist', side: 'left' })),
        F, 'frozen landmarks threw');
      const BIG = Object.freeze(P21.map(p =>
        Object.freeze({ x: p.x * 100, y: p.y * 100 })));   // forces the rescale path
      const cb = new FakeCtx();
      probe(okCall(() => drawGlove(cb, BIG)) && cb._saves === cb._restores && cb._saves >= 1,
        F, 'frozen oversized landmarks threw (rescale mutated input?)');

      // hostile opts — every field is untrusted
      for (const o of [null, 42, 'x', { kind: '__proto__' }, { kind: 'constructor' },
          { kind: 'toString' }, { kind: 'hasOwnProperty' }, { kind: {} }, { kind: null },
          { side: 42 }, { side: {} }, { side: [] },
          { kind: 'pinch', pinchAt: { x: NaN, y: NaN } },
          { kind: 'pinch', pinchAt: 'no' }, { tool: 'drill' }, { tool: {} }, { tool: 42 }]) {
        const c = new FakeCtx();
        probe(okCall(() => drawGlove(c, P21, o)),
          F, `opts ${JSON.stringify(o)} threw`);
      }
      // proto-key kinds must not leak inherited objects into style/text sinks
      const ck = new FakeCtx();
      drawGlove(ck, P21, { kind: '__proto__' });
      probe(!ck.styles.some(s => s !== null && typeof s === 'object'), F,
        "'__proto__' kind leaked an inherited object into a canvas style");
      const ck2 = new FakeCtx();
      drawGlove(ck2, P21, { kind: 'toString' });
      probe(ck2.texts.length && !ck2.texts.some(t => /function|native code/.test(t)), F,
        "'toString' kind rendered function source as the tag text");

      // a mid-draw fault drops ONE frame — restore() still runs, no escape
      const ct = new FakeCtx('quadraticCurveTo');
      probe(okCall(() => drawGlove(ct, P21)) && ct._saves === ct._restores && ct._restores >= 1,
        F, 'mid-draw canvas fault leaked ctx state or escaped drawGlove');
      // a ctx with no canvas must not NaN the size cap or throw
      const cno = new FakeCtx();
      delete cno.canvas;
      probe(okCall(() => drawGlove(cno, P21)), F, 'canvas-less ctx threw');
      // a throwing save()/restore() pair can't wedge the tick either
      const cs = new FakeCtx();
      cs.save = () => { throw new Error('save boom'); };
      probe(okCall(() => drawGlove(cs, P21)), F, 'throwing ctx.save() escaped');
    }

    /* every inline landmarker built anywhere in this suite must have been
       closed — workers, cycles, pending builds: a live one is a leaked
       GPU/CPU graph */
    {
      const openLm = (globalThis.__lmLog || []).filter(l => !l.closed);
      probe(openLm.length === 0, 'shared/hands.js',
        `${openLm.length} inline landmarker(s) leaked across all probes`);
    }

    /* the whole point of res()-only spawnP + .catch'd _initLocal: no tracker
       path may ever produce an unhandled rejection */
    probe(unhandled === 0, 'shared/hands.js',
      `${unhandled} unhandled promise rejection(s) leaked from tracker paths`);
  } finally {
    rmSync(VEND, { recursive: true, force: true });
  }
}

try {
  await dynamicProbes();
} catch (e) {
  fail('qe-static', 0, `dynamic probe harness threw: ${e?.stack || e}`);
}

console.log('---- qe-static summary ----');
console.log(`checked ${checked} module blocks/files across ${PAGES.length} pages`);
console.log(findings.length ? `${findings.length} finding(s)` : 'CLEAN');
process.exit(findings.length ? 1 : 0);
