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
const findings = [];
const notes = [];
const fail = (file, line, msg) => {
  findings.push({ file, line, msg });
  console.log(`FAIL  ${file}:${line}  ${msg}`);
};
const note = m => { notes.push(m); console.log('note  ' + m); };
const lineOf = (src, idx) => src.slice(0, idx).split('\n').length;

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
       covered by THIS page's importmap (the map is what the browser uses) */
    const seen = new Set();
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
              queue.push({ code: readFileSync(abs, 'utf8'), fromDir: dirname(abs),
                fromFile: abs.slice(ROOT.length + 1), line: 1 });
            } catch { }
          }
        } else if (!/^https?:/i.test(spec)) {
          if (!maps.has(spec))
            fail(page, line, `${fromFile} imports bare '${spec}' — not in ${page}'s importmap`);
        }
      }
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
