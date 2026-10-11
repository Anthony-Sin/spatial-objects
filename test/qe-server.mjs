#!/usr/bin/env node
/* test/qe-server.mjs — QE round-2 HTTP probe suite for server.mjs.

   `node test/qe-server.mjs`         spawns its OWN server.mjs on a scratch
                                     port (QE_PORT, default 8893, +1 on busy),
                                     builds fixtures under test/.qe-server-tmp,
                                     runs the full probe matrix, cleans up.
                                     Never touches the live :8791 instance.
   `node test/qe-server.mjs --live`  read-only sanity pass against the live
                                     http://127.0.0.1:8791 — GETs/HEADs only,
                                     no spawn, no POST/PUT/DELETE, no raw
                                     sockets. Pre-fix behavior on the live
                                     build is tolerated where noted.

   Verbatim-path probes go through http.request's `path` (fetch/URL would
   normalize ../ and %2e%2e client-side); truly malformed bytes go through
   node:net raw sockets. Prints PASS/FAIL lines then a markdown probe matrix.
   Exit 1 on any FAIL. Zero deps. */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, writeFile, symlink, rm, readFile } from 'node:fs/promises';
import { request } from 'node:http';
import { connect } from 'node:net';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const ROOT = join(import.meta.dirname, '..');
const LIVE = process.argv.includes('--live');
let PORT = Number(process.env.QE_PORT || (LIVE ? 8791 : 8893));
const FIX_URL = '/test/.qe-server-tmp/';

let pass = 0, fail = 0;
const rows = [];
const short = v => {
  const s = String(v).replace(/\|/g, '/').replace(/\s+/g, ' ');
  return s.length > 80 ? s.slice(0, 77) + '…' : s;
};
const check = (name, exp, got, cond) => {
  const ok = !!cond; ok ? pass++ : fail++;
  rows.push([name, short(exp), short(got), ok ? 'pass' : '**FAIL**']);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  — expected ${short(exp)}, got ${short(got)}`);
};

/* one request, path sent verbatim (no client-side normalization) */
const req = (path, { method = 'GET', headers = {}, body } = {}) => new Promise((resolve, reject) => {
  let r;
  try {
    r = request({ host: '127.0.0.1', port: PORT, path, method, headers, agent: false }, rsp => {
      const chunks = [];
      rsp.on('data', c => chunks.push(c));
      rsp.on('error', reject);
      rsp.on('end', () => resolve({ status: rsp.statusCode, headers: rsp.headers, body: Buffer.concat(chunks) }));
    });
  } catch (e) { return reject(e); }
  r.on('error', reject);
  r.setTimeout(10000, () => r.destroy(new Error('client timeout')));
  if (body) r.write(body);
  r.end();
});

/* raw bytes on a socket — for requests http.request refuses to send */
const raw = bytes => new Promise(resolve => {
  const s = connect(PORT, '127.0.0.1');
  const out = [];
  let done = false;
  const fin = () => { if (!done) { done = true; s.destroy(); resolve(Buffer.concat(out).toString('latin1')); } };
  s.on('connect', () => s.write(bytes));
  s.on('data', d => out.push(d));
  s.on('error', () => {});
  s.on('close', fin);
  s.setTimeout(2000, fin);
});
const statusOf = resp => +(String(resp).match(/^HTTP\/\d\.\d (\d+)/)?.[1] || 0);

const spawnServer = port => new Promise(resolve => {
  const child = spawn(process.execPath, [join(ROOT, 'server.mjs')],
    { env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
  const to = setTimeout(() => { child.kill('SIGKILL'); resolve(null); }, 10000);
  child.stdout.on('data', d => {
    if (String(d).includes('→')) { clearTimeout(to); resolve(child); }
  });
  child.stderr.on('data', d => process.stderr.write(`[srv:${port}!] ${d}`));
  child.on('exit', () => { clearTimeout(to); resolve(null); });
});

/* ---------------- fixtures ---------------- */
const FIX = join(ROOT, 'test', '.qe-server-tmp');
const BLOB = Buffer.alloc(5000);
for (let i = 0; i < 5000; i++) BLOB[i] = (i * 31 + 7) & 0xff;   // deterministic pattern

let child = null;
try {
  if (!LIVE) {
    for (let p = PORT; p < PORT + 8 && !child; p++) {
      child = await spawnServer(p);
      if (child) PORT = p;
    }
    if (!child) { console.error('could not start a scratch server on 8893+'); process.exit(2); }
    await delay(100);
  }
  console.log(`# probing ${LIVE ? 'LIVE' : 'scratch'} http://127.0.0.1:${PORT}`);

  await rm(FIX, { recursive: true, force: true });
  await mkdir(join(FIX, 'dir'), { recursive: true });
  const wf = (n, c) => writeFile(join(FIX, n), c);
  await wf('blob.bin', BLOB);
  await wf('empty.bin', Buffer.alloc(0));
  await wf('space name.txt', 'hello spaces');
  await wf('plus+file.txt', 'hello plus');
  await wf('uni-雪.txt', 'hello snow');
  await wf('mystery.xyz', 'unknown ext');
  await wf('style.css', 'a { b: c }');
  await wf('x.png', 'not really a png');            // MIME keys off the ext only
  await wf('UPPER.HTML', '<b>up</b>');
  await wf('dir/index.html', '<!doctype html><title>qe-dir</title><p>dir index</p>');
  let symlinks = true;
  try {
    await symlink('/etc/passwd', join(FIX, 'escape.lnk'));   // escapes root
    await symlink('loop.lnk', join(FIX, 'loop.lnk'));        // ELOOP
    await symlink('../boxing-fight.mjs', join(FIX, 'inside.lnk')); // stays in root
  } catch (e) {
    symlinks = false;
    console.log('# note: symlink fixtures unavailable:', e.code || e.message);
  }

  /* ================ A. byte ranges ================ */
  {
    let r = await req(FIX_URL + 'blob.bin', { headers: { range: 'bytes=0-0' } });
    check('range bytes=0-0', '206 cr=bytes 0-0/5000', `${r.status} cr=${r.headers['content-range']}`,
      r.status === 206 && r.headers['content-range'] === 'bytes 0-0/5000'
      && r.body.length === 1 && r.body[0] === BLOB[0]);

    r = await req(FIX_URL + 'blob.bin', { headers: { range: 'bytes=100-' } });
    check('range bytes=100- (open end)', '206 cr=bytes 100-4999/5000', `${r.status} cr=${r.headers['content-range']}`,
      r.status === 206 && r.headers['content-range'] === 'bytes 100-4999/5000'
      && r.body.equals(BLOB.subarray(100)));

    r = await req(FIX_URL + 'blob.bin', { headers: { range: 'bytes=-500' } });
    check('range bytes=-500 (suffix)', '206 cr=bytes 4500-4999/5000', `${r.status} cr=${r.headers['content-range']}`,
      r.status === 206 && r.headers['content-range'] === 'bytes 4500-4999/5000'
      && r.body.equals(BLOB.subarray(4500)));

    r = await req(FIX_URL + 'blob.bin', { headers: { range: 'bytes=-99999' } });
    check('range suffix > size clamps', '206 cr=bytes 0-4999/5000', `${r.status} cr=${r.headers['content-range']}`,
      r.status === 206 && r.headers['content-range'] === 'bytes 0-4999/5000' && r.body.equals(BLOB));

    r = await req(FIX_URL + 'blob.bin', { headers: { range: 'bytes=abc' } });
    check('range bytes=abc malformed', '416 cr=bytes */5000', `${r.status} cr=${r.headers['content-range']}`,
      r.status === 416 && r.headers['content-range'] === 'bytes */5000');

    r = await req(FIX_URL + 'blob.bin', { headers: { range: 'bytes=50-10' } });
    check('range start>end', '416 cr=bytes */5000', `${r.status} cr=${r.headers['content-range']}`,
      r.status === 416 && r.headers['content-range'] === 'bytes */5000');

    r = await req(FIX_URL + 'blob.bin', { headers: { range: 'bytes=999999999-' } });
    check('range start past EOF', '416 cr=bytes */5000', `${r.status} cr=${r.headers['content-range']}`,
      r.status === 416 && r.headers['content-range'] === 'bytes */5000');

    r = await req(FIX_URL + 'blob.bin', { headers: { range: 'bytes=-0' } });
    check('range zero-length suffix', '416 cr=bytes */5000', `${r.status} cr=${r.headers['content-range']}`,
      r.status === 416 && r.headers['content-range'] === 'bytes */5000');

    r = await req(FIX_URL + 'blob.bin', { headers: { range: 'bytes=-' } });
    check('range empty spec', '416', `${r.status} cr=${r.headers['content-range']}`, r.status === 416);

    r = await req(FIX_URL + 'blob.bin', { headers: { range: 'bytes=0-999999' } });
    check('range end past EOF clamps', '206 cr=bytes 0-4999/5000', `${r.status} cr=${r.headers['content-range']}`,
      r.status === 206 && r.headers['content-range'] === 'bytes 0-4999/5000' && r.body.equals(BLOB));

    // RFC 9110 §14.1.2 — an unknown range unit MUST be ignored (→200).
    r = await req(FIX_URL + 'blob.bin', { headers: { range: 'items=0-1' } });
    check('range unknown unit ignored', LIVE ? '200 (fixed) / 416 (pre-fix live)' : '200 whole body',
      `${r.status} len=${r.body.length}`,
      LIVE ? (r.status === 200 || r.status === 416)
           : (r.status === 200 && r.body.equals(BLOB)));

    // a multi-range set is valid syntax we don't serve — ignore (→200), not 416
    r = await req(FIX_URL + 'blob.bin', { headers: { range: 'bytes=0-1,2-3' } });
    check('multi-range ignored', LIVE ? '200 (fixed) / 416 (pre-fix live)' : '200 whole body',
      `${r.status} len=${r.body.length}`,
      LIVE ? (r.status === 200 || r.status === 416)
           : (r.status === 200 && r.body.equals(BLOB)));

    // round-trip: ranged chunks reassemble to the full body
    const full = await req(FIX_URL + 'blob.bin');
    const parts = [];
    for (const [a, b] of [[0, 999], [1000, 2499], [2500, 3999], [4000, 4999]]) {
      const p = await req(FIX_URL + 'blob.bin', { headers: { range: `bytes=${a}-${b}` } });
      parts.push(p.status === 206 ? p.body : Buffer.alloc(0));
    }
    const joined = Buffer.concat(parts);
    check('ranged chunks reassemble == full body', 'identical 5000B',
      `joined=${joined.length}B eq=${joined.equals(BLOB)}`,
      full.status === 200 && joined.equals(BLOB) && joined.equals(full.body));

    r = await req(FIX_URL + 'blob.bin', { method: 'HEAD', headers: { range: 'bytes=0-0' } });
    check('HEAD + range', '206 cl=1 empty body', `${r.status} cl=${r.headers['content-length']} len=${r.body.length}`,
      r.status === 206 && r.headers['content-length'] === '1' && r.body.length === 0);

    r = await req(FIX_URL + 'empty.bin');
    check('empty file GET', '200 cl=0', `${r.status} cl=${r.headers['content-length']} len=${r.body.length}`,
      r.status === 200 && r.body.length === 0);

    r = await req(FIX_URL + 'empty.bin', { headers: { range: 'bytes=0-0' } });
    check('empty file range', '416 cr=bytes */0', `${r.status} cr=${r.headers['content-range']}`,
      r.status === 416 && r.headers['content-range'] === 'bytes */0');

    // the real media file ranges exist for
    const mp4 = await readFile(join(ROOT, 'test-input.mp4'));
    r = await req('/test-input.mp4', { headers: { range: 'bytes=0-1023' } });
    check('mp4 first 1KB range', `206 cr=bytes 0-1023/${mp4.length}`, `${r.status} cr=${r.headers['content-range']}`,
      r.status === 206 && r.headers['content-range'] === `bytes 0-1023/${mp4.length}`
      && r.body.equals(mp4.subarray(0, 1024)));

    // ranges still work on immutable vendor files
    r = await req('/vendor/models/glb/boxing/boxing-gloves.glb', { headers: { range: 'bytes=0-99' } });
    check('range on vendor file', '206 len=100', `${r.status} len=${r.body.length}`,
      r.status === 206 && r.body.length === 100);

    // a Range must beat If-Modified-Since (no bogus 304 of a partial)
    const lm = (await req(FIX_URL + 'blob.bin')).headers['last-modified'];
    r = await req(FIX_URL + 'blob.bin', { headers: { range: 'bytes=0-0', 'if-modified-since': lm } });
    check('range beats if-modified-since', '206', `${r.status}`, r.status === 206);
  }

  /* ================ B. traversal ================ */
  {
    let r = await req('/../.teamwork/CONTRACT.md');
    check('traversal /../ (parser collapses)', '404 (in-root miss)', `${r.status}`,
      r.status === 404 || r.status === 403);
    r = await req('/%2e%2e/.teamwork/CONTRACT.md');
    check('traversal /%2e%2e/ (parser collapses)', '404 (in-root miss)', `${r.status}`,
      r.status === 404 || r.status === 403);
    // %2f survives URL parsing and reaches the lexical guard as a real slash
    r = await req('/..%2f.teamwork%2fCONTRACT.md');
    check('traversal /..%2f', '403', `${r.status}`, r.status === 403);
    r = await req('/%2e%2e%2f.teamwork%2fCONTRACT.md');
    check('traversal /%2e%2e%2f', '403', `${r.status}`, r.status === 403);
    r = await req('/test/%2e%2e%2f%2e%2e%2f.teamwork%2fCONTRACT.md');
    check('traversal nested %2e%2e%2f', '403', `${r.status}`, r.status === 403);
    r = await req('/..%2f..%2fetc%2fpasswd');
    check('traversal to /etc/passwd', '403', `${r.status}`,
      r.status === 403 && !r.body.includes('root:'));
    r = await req('/%00');
    check('NUL byte in path', '404', `${r.status}`, r.status === 404 || r.status === 400);
    r = await req('/..\\..\\.teamwork\\CONTRACT.md');
    check('raw backslashes (linux = filename chars)', '404', `${r.status}`, r.status === 404 || r.status === 403);
    r = await req('/%2e%2e%5c%2e%2e%5c.teamwork%5cCONTRACT.md');
    check('encoded backslashes', '404', `${r.status}`, r.status === 404 || r.status === 403);
    r = await req('/%252e%252e/%252e%252e/x');
    check('double-encoded %2e (no double decode)', '404', `${r.status}`, r.status === 404 || r.status === 403);
    r = await req('//');
    check('bare //', '400 (// = scheme-relative, bad URL)', `${r.status}`,
      r.status === 400 || r.status === 200);
    if (symlinks) {
      r = await req(FIX_URL + 'escape.lnk');
      check('symlink escape → outside root', '403, no /etc/passwd leak',
        `${r.status} leaked=${r.body.includes('root:')}`,
        r.status === 403 && !r.body.includes('root:'));
      r = await req(FIX_URL + 'loop.lnk');
      check('symlink ELOOP', '4xx', `${r.status}`, r.status === 404 || r.status === 403);
      const tgt = await readFile(join(ROOT, 'test', 'boxing-fight.mjs'));
      r = await req(FIX_URL + 'inside.lnk');
      check('symlink staying inside root serves', '200 real bytes',
        `${r.status} eq=${r.body.equals(tgt)}`, r.status === 200 && r.body.equals(tgt));
    }
    r = await req('/.git/config');
    check('repo internals denied (/.git)', LIVE ? '404 (fixed) / 200 leak (pre-fix live)' : '404',
      `${r.status}`, LIVE ? (r.status === 404 || r.status === 200) : r.status === 404);
    r = await req('/.git%2fconfig');
    check('encoded /.git%2f denied', LIVE ? '404 (fixed) / 200 leak (pre-fix live)' : '404',
      `${r.status}`, LIVE ? (r.status === 404 || r.status === 200) : r.status === 404);
  }

  /* ================ C. HEAD == GET − body ================ */
  {
    const g = await req('/package.json');
    const h = await req('/package.json', { method: 'HEAD' });
    check('HEAD == GET minus body', 'same status/ct/cl/lm, empty body',
      `h=${h.status} cl=${h.headers['content-length']} len=${h.body.length} g=${g.status} cl=${g.headers['content-length']}`,
      h.status === g.status && h.status === 200
      && h.headers['content-type'] === g.headers['content-type']
      && h.headers['content-length'] === g.headers['content-length']
      && h.headers['last-modified'] === g.headers['last-modified']
      && h.body.length === 0 && g.body.length === +g.headers['content-length']);
  }

  /* ================ D. conditional requests ================ */
  {
    const one = await req(FIX_URL + 'blob.bin');
    const lm = one.headers['last-modified'];
    let r = await req(FIX_URL + 'blob.bin', { headers: { 'if-modified-since': lm } });
    check('IMS echo → 304 (non-vendor)', '304 empty body', `${r.status} len=${r.body.length}`,
      r.status === 304 && r.body.length === 0);
    r = await req(FIX_URL + 'blob.bin', { headers: { 'if-modified-since': new Date(Date.now() + 60000).toUTCString() } });
    check('future IMS → 304', '304', `${r.status}`, r.status === 304);
    r = await req(FIX_URL + 'blob.bin', { headers: { 'if-modified-since': 'not a date' } });
    check('garbage IMS ignored', '200', `${r.status}`, r.status === 200);
    check('cache-control non-vendor', 'no-cache', one.headers['cache-control'],
      one.headers['cache-control'] === 'no-cache');

    const v = await req('/vendor/mediapipe/wasm/vision_wasm_internal.js');
    const vlm = v.headers['last-modified'];
    const r2 = await req('/vendor/mediapipe/wasm/vision_wasm_internal.js',
      { headers: { 'if-modified-since': vlm } });
    check('vendor file does NOT 304 (immutable)', '200 + body', `${r2.status} len=${r2.body.length}`,
      r2.status === 200 && r2.body.equals(v.body));
    check('cache-control vendor', 'max-age=86400, immutable', v.headers['cache-control'],
      v.headers['cache-control'] === 'max-age=86400, immutable');

    // the resolved-path fix — a %2f-boosted .. must not borrow vendor policy
    r = await req('/vendor/..%2fpackage.json');
    check('/vendor/..%2f escapes immutable policy', LIVE ? 'no-cache (fixed) / immutable (pre-fix)' : 'no-cache',
      `${r.status} cc=${r.headers['cache-control']}`,
      LIVE ? r.status === 200
           : r.status === 200 && r.headers['cache-control'] === 'no-cache');
    const r3 = await req('/vendor/..%2fpackage.json',
      { headers: { 'if-modified-since': r.headers['last-modified'] } });
    check('/vendor/..%2f honors IMS → 304', LIVE ? '304 (fixed) / 200 (pre-fix)' : '304',
      `${r3.status}`, LIVE ? (r3.status === 304 || r3.status === 200) : r3.status === 304);
  }

  /* ================ E. methods (not on live) ================ */
  if (!LIVE) {
    for (const m of ['POST', 'PUT', 'DELETE', 'PATCH', 'PROPFIND']) {
      const r = await req('/package.json', { method: m, body: m === 'POST' ? 'x=1' : undefined });
      check(`${m} refused`, '405 allow=GET, HEAD', `${r.status} allow=${r.headers['allow']}`,
        r.status === 405 && /GET/.test(r.headers['allow'] || '') && /HEAD/.test(r.headers['allow'] || ''));
    }
    // POST with an undrained body must not wedge the next request
    await req('/package.json', { method: 'POST', body: 'x'.repeat(4096) });
    const r = await req('/package.json');
    check('GET after undrained POST body', '200', `${r.status}`, r.status === 200);
  }

  /* ================ F. MIME map ================ */
  {
    const mime = async (path, exp, method = 'HEAD') => {
      const r = await req(path, { method });
      check(`MIME ${path.split('/').pop()}`, exp, `${r.status} ${r.headers['content-type']}`,
        r.status === 200 && r.headers['content-type'] === exp);
    };
    await mime('/index.html', 'text/html; charset=utf-8');
    await mime('/package.json', 'application/json; charset=utf-8');
    await mime('/test/boxing-fight.mjs', 'text/javascript; charset=utf-8');
    await mime('/vendor/mediapipe/wasm/vision_wasm_internal.js', 'text/javascript; charset=utf-8');
    await mime('/vendor/ort/ort-wasm-simd-threaded.wasm', 'application/wasm');
    await mime('/test-input.mp4', 'video/mp4');
    await mime('/vendor/models/glb/boxing/boxing-gloves.glb', 'model/gltf-binary');
    await mime('/vendor/mediapipe/hand_landmarker.task', 'application/octet-stream');
    await mime(FIX_URL + 'mystery.xyz', 'application/octet-stream');
    await mime(FIX_URL + 'style.css', 'text/css; charset=utf-8');
    await mime(FIX_URL + 'x.png', 'image/png');
    await mime(FIX_URL + 'UPPER.HTML', 'text/html; charset=utf-8');   // case-insensitive ext

    const r = await req('/package.json');
    check('isolation headers (COOP/COEP/CORP)', 'same-origin/credentialless/same-origin',
      `${r.headers['cross-origin-opener-policy']}/${r.headers['cross-origin-embedder-policy']}/${r.headers['cross-origin-resource-policy']}`,
      r.headers['cross-origin-opener-policy'] === 'same-origin'
      && r.headers['cross-origin-embedder-policy'] === 'credentialless'
      && r.headers['cross-origin-resource-policy'] === 'same-origin');
    check('accept-ranges advertised', 'bytes', r.headers['accept-ranges'],
      r.headers['accept-ranges'] === 'bytes');
  }

  /* ================ G. index / directory ================ */
  {
    let idx = await readFile(join(ROOT, 'index.html'));
    let r = await req('/');
    // another agent may be editing index.html right now — re-read once on mismatch
    if (!r.body.equals(idx)) idx = await readFile(join(ROOT, 'index.html'));
    check('/ serves index.html', `200 == index.html (${idx.length}B)`,
      `${r.status} ${r.body.length}B eq=${r.body.equals(idx)}`,
      r.status === 200 && r.body.equals(idx));
    r = await req(FIX_URL + 'dir/');
    check('/dir/ appends index.html', '200 dir index body', `${r.status} "${r.body.toString().slice(0, 40)}"`,
      r.status === 200 && r.body.toString().includes('qe-dir'));
    r = await req(FIX_URL + 'dir');
    check('dir without trailing slash', '404 (no redirect)', `${r.status}`, r.status === 404);
    r = await req('/no-such-dir-qe/');
    check('missing dir index', '404', `${r.status}`, r.status === 404);
  }

  /* ================ H. URL quirks ================ */
  {
    let r = await req(FIX_URL + 'space%20name.txt');
    check('%20 space in name', '200 "hello spaces"', `${r.status} "${r.body}"`,
      r.status === 200 && r.body.toString() === 'hello spaces');
    r = await req(FIX_URL + 'space+name.txt');
    check('+ is NOT a space in path', '404', `${r.status}`, r.status === 404);
    r = await req(FIX_URL + 'plus+file.txt');
    check('literal + in name', '200 "hello plus"', `${r.status} "${r.body}"`,
      r.status === 200 && r.body.toString() === 'hello plus');
    r = await req(FIX_URL + 'plus%20file.txt');
    check('%20 does not match + file', '404', `${r.status}`, r.status === 404);
    r = await req(FIX_URL + 'uni-%E9%9B%AA.txt');
    check('utf-8 percent-decoded name', '200', `${r.status} "${r.body}"`,
      r.status === 200 && r.body.toString() === 'hello snow');
    const pkg = await readFile(join(ROOT, 'package.json'));
    r = await req('/package.json?x=/../../etc/passwd&y=%00');
    check('query string ignored', '200 package.json', `${r.status} eq=${r.body.equals(pkg)}`,
      r.status === 200 && r.body.equals(pkg));
    r = await req('/package.json?');
    check('empty query', '200', `${r.status}`, r.status === 200);
    r = await req(FIX_URL + 'blob.bin;param');
    check('semicolon suffix = literal name', '404', `${r.status}`, r.status === 404);
    r = await req('/' + 'a'.repeat(5000));
    check('5KB path', '404 (ENAMETOOLONG swallowed)', `${r.status}`,
      r.status === 404 || r.status === 400 || r.status === 414);
  }

  /* ================ I. malformed requests / survival (not on live) ================ */
  if (!LIVE) {
    const alive = async tag => {
      const r = await req('/');
      check(`server alive after ${tag}`, '200', `${r.status}`, r.status === 200);
    };

    let resp = await raw('GARBAGE NOTHTTP\r\n\r\n');
    check('garbage request-line refused', '4xx or closed', `${statusOf(resp) || 'closed'}`,
      statusOf(resp) === 0 || (statusOf(resp) >= 400 && statusOf(resp) < 600));
    await alive('garbage request');

    resp = await raw('GET /% HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n');
    check('bad % escape → 400', '400', `${statusOf(resp)}`, statusOf(resp) === 400);
    await alive('bad percent escape');

    resp = await raw('GET / HTTP/9.9\r\nHost: x\r\nConnection: close\r\n\r\n');
    check('bogus HTTP version refused', '4xx/5xx or closed', `${statusOf(resp) || 'closed'}`,
      statusOf(resp) === 0 || statusOf(resp) >= 400);
    await alive('bogus HTTP version');

    resp = await raw('GET /%0d%0aX-Injected:%20yes HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n');
    check('CRLF-in-URL cannot inject headers', '4xx, no x-injected header',
      `${statusOf(resp)} injected=${/x-injected/i.test(resp)}`,
      (statusOf(resp) === 404 || statusOf(resp) === 400) && !/x-injected/i.test(resp));
    await alive('CRLF injection probe');

    // client vanishes mid-download — socket error must not kill the process
    await new Promise(res => {
      const s = connect(PORT, '127.0.0.1');
      s.on('connect', () => {
        s.write('GET /test-input.mp4 HTTP/1.1\r\nHost: x\r\n\r\n');
        setTimeout(() => { s.destroy(); res(); }, 40);
      });
      s.on('error', () => {});
    });
    await delay(120);
    await alive('client abort mid-download');

    // half-sent request then RST
    await new Promise(res => {
      const s = connect(PORT, '127.0.0.1');
      s.on('connect', () => { s.write('GET / HTTP/1.1\r\nHost:'); s.destroy(); res(); });
      s.on('error', () => {});
    });
    await delay(120);
    await alive('half-sent request');

    resp = await raw('GET /package.json HTTP/1.1\r\nHost: x\r\n\r\n'
      + 'GET /package.json HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n');
    const ok200 = (resp.match(/HTTP\/1\.1 200/g) || []).length;
    check('pipelined requests both answered', 'two HTTP/1.1 200', `${ok200}x200`, ok200 === 2);
    await alive('pipelining');

    resp = await raw(`GET http://127.0.0.1:${PORT}/package.json HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`);
    check('absolute-form request-target', '200', `${statusOf(resp)}`, statusOf(resp) === 200);

    resp = await raw('OPTIONS * HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n');
    check('OPTIONS * refused', '405', `${statusOf(resp)}`, statusOf(resp) === 405);
    await alive('OPTIONS *');

    resp = await raw('GET / HTTP/1.0\n\n');   // LF-only line endings
    check('LF-only request tolerated or refused', 'any, then alive', `${statusOf(resp) || 'closed'}`, true);
    await alive('LF-only request');

    resp = await raw(`GET /${'a'.repeat(20000)} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`);
    check('>16KB request line refused by parser', '4xx or closed', `${statusOf(resp) || 'closed'}`,
      statusOf(resp) === 0 || (statusOf(resp) >= 400 && statusOf(resp) < 600));
    await alive('oversized request line');
  }

  /* ================ report ================ */
  console.log('\n--- probe matrix ---');
  console.log('| case | expected | got | result |');
  console.log('|---|---|---|---|');
  for (const row of rows) console.log(`| ${row[0]} | ${row[1]} | ${row[2]} | ${row[3]} |`);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
} finally {
  await rm(FIX, { recursive: true, force: true }).catch(() => {});
  if (child) { child.kill('SIGKILL'); child.unref(); }
}
