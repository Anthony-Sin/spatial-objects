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
import { fileURLToPath } from 'node:url';
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
/* `try` somewhere in the lookback window = "guarded" (heuristic — a parse
   right after a }catch{ slips through, but unguarded top-level calls are
   the crash class this targets). Deeper second pass: a long try block can
   exceed the window — if an open `try` has no `catch` yet between it and
   the call, the call is inside it ('.catch(' is a promise method, not a
   catch clause, so it's excluded from the count). */
const nearTry = (code, i, back = 500) => {
  if (/\btry\b/.test(code.slice(Math.max(0, i - back), i))) return true;
  const seg = code.slice(Math.max(0, i - 2400), i);
  const tries = (seg.match(/\btry\b/g) || []).length;
  const catches = (seg.match(/(?:^|[}\s])catch\s*[({]/gm) || []).length;
  return tries > catches;
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

console.log('---- qe-static summary ----');
console.log(`checked ${checked} module blocks/files across ${PAGES.length} pages`);
console.log(findings.length ? `${findings.length} finding(s)` : 'CLEAN');
process.exit(findings.length ? 1 : 0);
