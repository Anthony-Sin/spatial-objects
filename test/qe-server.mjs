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
   Exit 1 on any FAIL. Zero deps.

   Section J (added wave 3) is the CONCURRENCY/TIME matrix: parallel range
   storms, delete/truncate mid-flight, trickle readers, abort storms,
   keep-alive + pipelining, Expect:100-continue, slow-loris, fd exhaustion.
   Scratch-server only — it would hammer the live instance.

   Wave 4 adds: K conditional-request edges (ETag / If-Range / If-Match /
   If-None-Match / If-Unmodified-Since / IMS-on-HEAD — live-safe, tolerant of
   the pre-fix build), L method+protocol oddballs (OPTIONS/TRACE/CONNECT/
   Upgrade/HTTP-1.0/absolute-form/missing-Host), M request-smuggling
   robustness (dup-CL, CL+TE, negative/huge CL, trailers, desync framing),
   N URL normalization (encoded slashes, //, ./, overlong UTF-8, confusables)
   and O keep-alive lifecycle + fd hygiene. L/M/O are scratch-only. */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, writeFile, symlink, rm, readFile, open, utimes, readdir } from 'node:fs/promises';
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

/* scratch child's RSS in KB via /proc (linux-only, like the server's own
   /proc/self/fd check); 0 = unavailable — RSS checks then just record 0 */
const rssKB = async () => {
  try {
    const s = await readFile(`/proc/${child.pid}/status`, 'utf8');
    return +(/VmRSS:\s*(\d+)/.exec(s)?.[1] || 0);
  } catch { return 0; }
};

/* open-fd count of the scratch child via /proc/<pid>/fd (linux-only, same
   constraint as the server's own /proc/self/fd check); -1 = unavailable —
   fd probes then degrade to recording -1 */
const fdCount = async () => {
  try { return (await readdir(`/proc/${child.pid}/fd`)).length; }
  catch { return -1; }
};

/* persistent-connection wrapper: buffers the socket, hands out parsed
   responses one at a time in wire order. Used for keep-alive reuse,
   pipelining, interim 1xx and Expect:100-continue probes — things the
   one-shot http.request helper can't express. */
const conn = () => {
  const s = connect(PORT, '127.0.0.1');
  s.on('error', () => {});
  let buf = Buffer.alloc(0), closed = false;
  const waiters = [];
  const pump = () => { while (waiters.length && waiters[0]()) waiters.shift(); };
  s.on('data', d => { buf = Buffer.concat([buf, d]); pump(); });
  s.on('close', () => { closed = true; pump(); });
  const take = n => new Promise(resolve => {
    waiters.push(() => {
      if (buf.length >= n) { const out = buf.subarray(0, n); buf = buf.subarray(n); resolve(out); return true; }
      if (closed) { resolve(null); return true; }
      return false;
    });
    pump();   // the bytes may already be buffered — don't wait for a new 'data'
  });
  const takeHead = () => new Promise(resolve => {
    waiters.push(() => {
      const i = buf.indexOf('\r\n\r\n');
      if (i >= 0) { const out = buf.subarray(0, i); buf = buf.subarray(i + 4); resolve(out); return true; }
      if (closed) { resolve(null); return true; }
      return false;
    });
    pump();
  });
  const rest = () => new Promise(resolve => {
    waiters.push(() => {
      if (!closed) return false;
      const out = buf; buf = Buffer.alloc(0); resolve(out); return true;
    });
    pump();
  });
  // error-path responses (writeHead + end('msg')) come back CHUNKED —
  // node only auto-adds content-length on an un-headered single end()
  const takeChunked = () => new Promise(resolve => {
    waiters.push(() => {
      const chunks = [];
      let pos = 0;
      for (;;) {
        const le = buf.indexOf('\r\n', pos);
        if (le < 0) return closed ? (resolve(Buffer.concat(chunks)), true) : false;
        const sz = parseInt(buf.subarray(pos, le).toString('latin1').split(';')[0], 16);
        if (!Number.isFinite(sz)) { resolve(Buffer.concat(chunks)); return true; }
        if (sz === 0) {
          let end = -1;
          if (buf.subarray(le + 2, le + 4).toString('latin1') === '\r\n') end = le + 4;   // no trailers
          else {
            const t = buf.indexOf('\r\n\r\n', le + 2);                                  // trailers → empty line
            if (t >= 0) end = t + 4;
          }
          if (end < 0) return closed ? (resolve(Buffer.concat(chunks)), true) : false;
          buf = buf.subarray(end); resolve(Buffer.concat(chunks)); return true;
        }
        if (buf.length < le + 2 + sz + 2) return closed ? (resolve(Buffer.concat(chunks)), true) : false;
        chunks.push(buf.subarray(le + 2, le + 2 + sz));
        pos = le + 2 + sz + 2;
      }
    });
    pump();
  });
  const readResp = async (method = 'GET') => {
    const headBuf = await takeHead();
    if (!headBuf) return { status: 0, headers: {}, body: Buffer.alloc(0) };
    const head = headBuf.toString('latin1');
    const status = +(/^HTTP\/\d\.\d (\d+)/.exec(head)?.[1] || 0);
    const headers = {};
    for (const line of head.split('\r\n').slice(1)) {
      const i = line.indexOf(':');
      if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
    }
    let body = Buffer.alloc(0);
    const noBody = method === 'HEAD' || status === 204 || status === 304 || (status >= 100 && status < 200);
    if (!noBody) {
      if ((headers['transfer-encoding'] || '').includes('chunked')) body = (await takeChunked()) || Buffer.alloc(0);
      else if (headers['content-length'] !== undefined) body = (await take(+headers['content-length'])) || Buffer.alloc(0);
      else body = (await rest()) || Buffer.alloc(0);   // close-delimited fallback
    }
    return { status, headers, body };
  };
  return {
    s,
    readResp,
    write: d => s.write(d),
    ready: new Promise(r => s.once('connect', r)),
    close: () => s.destroy(),
  };
};

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
  await wf('cond.bin', 'conditional bytes');
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

  /* ================ J. concurrency + load (scratch only — would DoS live) ================ */
  if (!LIVE) {
    const mp4 = await readFile(join(ROOT, 'test-input.mp4'));
    const alive = async () => (await req('/')).status === 200;
    const rss0 = await rssKB();

    /* ---- J1. 50 parallel disjoint ranged GETs on the 2.6MB mp4 ---- */
    {
      const N = 50, CH = Math.ceil(mp4.length / N);
      const t0 = Date.now();
      const rs = await Promise.all(Array.from({ length: N }, (_, i) =>
        req('/test-input.mp4', { headers: { range: `bytes=${i * CH}-${Math.min(mp4.length - 1, (i + 1) * CH - 1)}` } })));
      const dt = Date.now() - t0;
      let okAll = true, bad = '';
      for (let i = 0; i < N; i++) {
        const lo = i * CH, hi = Math.min(mp4.length - 1, (i + 1) * CH - 1);
        const r = rs[i];
        if (r.status !== 206 || !r.body.equals(mp4.subarray(lo, hi + 1))
            || r.headers['content-range'] !== `bytes ${lo}-${hi}/${mp4.length}`
            || +r.headers['content-length'] !== r.body.length) {
          okAll = false; bad = `#${i} ${r.status} cr=${r.headers['content-range']} len=${r.body.length}`; break;
        }
      }
      const rss1 = await rssKB();
      check('50 parallel disjoint ranges on 2.6MB mp4', 'all 206, bodies == file slices',
        `${okAll ? 'all ok' : bad} ${dt}ms rss ${rss0}→${rss1}KB`, okAll);
      check('server RSS sane after 50x2.6MB storm', '< 1GB', `${rss1}KB`, rss1 > 0 && rss1 < 1024 * 1024);
    }

    /* ---- J2. 20 parallel mixed GET/HEAD/range/404 ---- */
    {
      const plans = [
        ['/package.json', {}, 200, 'pkg'],
        ['/test-input.mp4', { headers: { range: 'bytes=0-1023' } }, 206, 'mp4-1k'],
        [FIX_URL + 'blob.bin', { method: 'HEAD' }, 200, 'head'],
        ['/no-such-qe-mixed', {}, 404, '404'],
        [FIX_URL + 'blob.bin', { headers: { range: 'bytes=10-19' } }, 206, 'rng10'],
        [FIX_URL + 'blob.bin', { headers: { range: 'bytes=abc' } }, 416, '416'],
        [FIX_URL + 'dir/', {}, 200, 'diridx'],
      ];
      const jobs = Array.from({ length: 20 }, (_, i) => plans[i % plans.length]);
      const rs = await Promise.all(jobs.map(([p, o]) => req(p, o)));
      let okAll = true, bad = '';
      rs.forEach((r, i) => {
        const want = jobs[i][2];
        if (r.status !== want) { okAll = false; bad = `#${i}(${jobs[i][3]}) ${r.status}≠${want}`; }
        else if (r.headers['content-length'] !== undefined && jobs[i][1].method !== 'HEAD'
                 && +r.headers['content-length'] !== r.body.length) {
          okAll = false; bad = `#${i}(${jobs[i][3]}) cl=${r.headers['content-length']} body=${r.body.length}`;
        }
      });
      check('20 parallel mixed GET/HEAD/range/404', 'each its expected status, cl==body',
        okAll ? 'all ok' : bad, okAll);
    }

    /* ---- J3. same file deleted mid-flight ---- */
    {
      const eph = join(FIX, 'ephemeral.bin');
      const ephBytes = Buffer.alloc(600_000);
      for (let i = 0; i < ephBytes.length; i++) ephBytes[i] = (i * 17 + 3) & 0xff;
      const tally = {}; let corrupt = 0;
      for (let i = 0; i < 12; i++) {
        await writeFile(eph, ephBytes);
        const ps = Array.from({ length: 6 }, () => req(FIX_URL + 'ephemeral.bin'));
        const del = rm(eph, { force: true });          // unlink while they fly
        for (const r of await Promise.all(ps)) {
          tally[r.status] = (tally[r.status] || 0) + 1;
          // fd-pinned invariant: a 200 must deliver the WHOLE original file
          if (r.status === 200 && !r.body.equals(ephBytes)) corrupt++;
        }
        await del;
      }
      check('same file deleted mid-flight (12x6)', '200+full bytes / 404 / 500 — never 403, never torn',
        `${JSON.stringify(tally)} corrupt200=${corrupt}`,
        corrupt === 0 && !('403' in tally) && Object.keys(tally).every(s => [200, 404, 500].includes(+s)));
      check('server alive after delete storm', 'GET / → 200', `${await req('/').then(r => r.status)}`,
        await alive());
    }

    /* ---- J4. trickle reader vs hammering others (whole-file buffering) ---- */
    {
      // 12MB — bigger than loopback's autotuned TCP buffers, so a paused
      // client really stalls the send and the undrained remainder stays
      // pinned in the server's socket writelist (measurable via RSS)
      const tk = join(FIX, 'trickle.bin');
      const tkBuf = Buffer.alloc(12_000_000);
      for (let i = 0; i < tkBuf.length; i++) tkBuf[i] = (i * 29 + 11) & 0xff;
      await writeFile(tk, tkBuf);
      const s = connect(PORT, '127.0.0.1');
      s.on('error', () => {});
      await new Promise(r => s.once('connect', r));
      let got = Buffer.alloc(0);
      s.on('data', d => { got = Buffer.concat([got, d]); });
      s.write('GET ' + FIX_URL + 'trickle.bin HTTP/1.1\r\nHost: x\r\n\r\n');
      await delay(400);                                  // headers + whatever fits in kernel bufs
      const beforePause = got.length;
      s.pause();                                         // stop draining the socket
      await delay(300);
      const duringPause = got.length - beforePause;      // what still leaked into client-side bufs
      const rssStall = await rssKB();
      const lats = [];
      let allOk = true;
      for (let i = 0; i < 20; i++) {                     // hammer while the reader is stalled
        const t = Date.now();
        const r = i % 4 === 0
          ? await req('/test-input.mp4', { headers: { range: 'bytes=0-99' } })
          : await req('/package.json');
        lats.push(Date.now() - t);
        if (r.status !== 200 && r.status !== 206) allOk = false;
      }
      const maxLat = Math.max(...lats);
      check('stalled reader does not starve others', '20 mixed reqs each <1.5s while client paused',
        `maxLat=${maxLat}ms drained=${beforePause}B +${duringPause}B rss=${rss0}→${rssStall}KB`,
        allOk && maxLat < 1500);
      s.resume();                                        // drain the rest, verify integrity
      const dl = Date.now() + 15000;
      while (Date.now() < dl) {
        const hEnd = got.indexOf('\r\n\r\n');
        if (hEnd >= 0) {
          const cl = +(/content-length: (\d+)/i.exec(got.subarray(0, hEnd).toString('latin1'))?.[1] || -1);
          if (cl >= 0 && got.length >= hEnd + 4 + cl) break;
        }
        await delay(50);
      }
      const hEnd = got.indexOf('\r\n\r\n');
      const body = got.subarray(hEnd + 4);
      check('trickle reader eventually gets intact body', `body == ${tkBuf.length}B file`,
        `got=${body.length}B eq=${body.equals(tkBuf)}`, body.equals(tkBuf));
      s.destroy();
      await rm(tk, { force: true });
    }

    /* ---- J5. abort storm: 100x connect→request→abort mid-response ---- */
    {
      let settled = 0;
      for (let w = 0; w < 4; w++) {
        await Promise.all(Array.from({ length: 25 }, (_, i) => new Promise(res => {
          const s = connect(PORT, '127.0.0.1');
          let done = false;
          const fin = () => { if (!done) { done = true; settled++; s.destroy(); res(); } };
          s.on('connect', () => {
            s.write('GET /test-input.mp4 HTTP/1.1\r\nHost: x\r\n\r\n');
            if (i % 4 === 0) fin();                        // abort before any response
            else if (i % 4 === 1) s.once('data', fin);     // abort on first bytes
            else setTimeout(fin, 3 + (i % 25));            // abort mid-body
          });
          s.on('error', fin); s.on('close', fin);
          setTimeout(fin, 4000);                           // safety
        })));
      }
      await delay(300);                                    // let the server unwind
      const r = await req('/');
      const rss2 = await rssKB();
      check('abort storm 100x (EPIPE/ECONNRESET survival)', 'all settled, server alive',
        `settled=${settled} GET→${r.status} rss=${rss2}KB exit=${child.exitCode}`,
        settled === 100 && r.status === 200 && child.exitCode === null);
    }

    /* ---- J6. keep-alive: 30 sequential + 30 pipelined on one socket ---- */
    {
      const c = conn();
      await c.ready;
      let seqOk = true, seqBad = '';
      for (let i = 0; i < 30; i++) {
        const head = i % 6 === 5;
        const miss = i % 7 === 6;
        const path = miss ? FIX_URL + 'nope.bin' : FIX_URL + 'blob.bin';
        const want = miss ? 404 : 200;
        c.write(`${head ? 'HEAD' : 'GET'} ${path}?seq=${i} HTTP/1.1\r\nHost: x\r\n\r\n`);
        const r = await c.readResp(head ? 'HEAD' : 'GET');
        if (r.status !== want || (!head && !miss && !r.body.equals(BLOB))
            || (head && r.body.length !== 0)) {
          seqOk = false; seqBad = `#${i}:${r.status}/${r.body.length}`; break;
        }
      }
      check('30 sequential requests on one keep-alive socket', 'all correct, conn reused',
        seqOk ? '30/30' : seqBad, seqOk);
      c.close();

      const c2 = conn();
      await c2.ready;
      const plan = [];
      for (let i = 0; i < 30; i++) {
        if (i % 10 === 9) plan.push(['HEAD', '/package.json', 200]);
        else if (i % 10 === 4) plan.push(['GET', FIX_URL + 'nope.bin', 404]);
        else if (i % 10 === 7) plan.push(['GET', FIX_URL + 'blob.bin', 206, 'bytes=0-9']);
        else plan.push(['GET', FIX_URL + 'blob.bin', 200]);
      }
      c2.write(plan.map(([m, p, , rg], i) =>
        `${m} ${p}?p=${i} HTTP/1.1\r\nHost: x\r\n${rg ? `Range: ${rg}\r\n` : ''}${i === 29 ? 'Connection: close\r\n' : ''}\r\n`).join(''));
      let pipeOk = true, pipeBad = '';
      for (let i = 0; i < 30; i++) {
        const [m, , want, rg] = plan[i];
        const r = await c2.readResp(m);
        if (r.status !== want) { pipeOk = false; pipeBad = `#${i}:${r.status}≠${want}`; break; }
        if (m === 'GET' && want === 200 && !r.body.equals(BLOB)) { pipeOk = false; pipeBad = `#${i}:body`; break; }
        if (rg && !r.body.equals(BLOB.subarray(0, 10))) { pipeOk = false; pipeBad = `#${i}:range`; break; }
      }
      check('30 pipelined requests answered in order', 'all expected, framing intact',
        pipeOk ? '30/30' : pipeBad, pipeOk);
      c2.close();

      const resp = await raw('GET /package.json HTTP/1.1\r\nHost: x\r\n'
        + Array.from({ length: 120 }, (_, i) => `X-Pad-${i}: ${'y'.repeat(20)}\r\n`).join('')
        + 'Connection: close\r\n\r\n');
      check('header-heavy request (120 headers)', '200', `${statusOf(resp)}`, statusOf(resp) === 200);
    }

    /* ---- J7. Expect: 100-continue + undrained body + keep-alive ---- */
    {
      const c = conn();
      await c.ready;
      c.write('GET ' + FIX_URL + 'blob.bin HTTP/1.1\r\nHost: x\r\nExpect: 100-continue\r\nContent-Length: 8\r\n\r\n');
      const interim = await c.readResp('GET');
      const r = await c.readResp('GET');                  // server may answer before body arrives
      c.write('12345678');                                 // the promised body, after the fact
      c.write('GET /package.json HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n');
      const next = await c.readResp('GET');
      check('Expect: 100-continue → interim 100', '100', `${interim.status}`, interim.status === 100);
      check('undrained req body does not wedge keep-alive', '200 blob then 200 pkg',
        `${r.status} len=${r.body.length} next=${next.status}`,
        r.status === 200 && r.body.equals(BLOB) && next.status === 200);
      c.close();
    }

    /* ---- J8. mid-write races: range on file being truncated; IMS 304 ---- */
    {
      const swingPath = join(FIX, 'swing.bin');
      const BIG = 3_000_000, SMALL = 900_000, START = 700_000;
      const swingBuf = Buffer.alloc(BIG);
      for (let i = 0; i < BIG; i++) swingBuf[i] = (i * 31 + 7) & 0xff;
      await writeFile(swingPath, swingBuf);
      const fh = await open(swingPath, 'r+');
      let racy = 0, inconsistent = 0, weird = '';
      for (let i = 0; i < 80 && racy < 4; i++) {
        await fh.truncate(BIG);
        const pr = req(FIX_URL + 'swing.bin', { headers: { range: `bytes=${START}-` } });
        const dl = Date.now() + 60;
        let tog = true;
        while (Date.now() < dl) { await fh.truncate(tog ? SMALL : BIG); tog = !tog; }
        const r = await pr;
        if (r.status === 206) {
          if (r.body.length !== BIG - START) racy++;
          const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(r.headers['content-range'] || '');
          if (!m || (+m[2]) - (+m[1]) + 1 !== r.body.length
              || +r.headers['content-length'] !== r.body.length) {
            inconsistent++;
            weird = `cr=${r.headers['content-range']} cl=${r.headers['content-length']} body=${r.body.length}`;
          }
        } else if (r.status !== 416) { inconsistent++; weird = `status=${r.status}`; }
      }
      // plain-GET consistency under the same hammer: cl must equal body bytes
      let getBad = 0;
      for (let i = 0; i < 8; i++) {
        await fh.truncate(BIG);
        const pr = req(FIX_URL + 'swing.bin');
        const dl = Date.now() + 30;
        let tog = true;
        while (Date.now() < dl) { await fh.truncate(tog ? SMALL : BIG); tog = !tog; }
        const r = await pr;
        if (r.status !== 200 || +r.headers['content-length'] !== r.body.length) getBad++;
      }
      // conditional request while the file is mid-write: 304 stays empty
      const p304 = req(FIX_URL + 'swing.bin',
        { headers: { 'if-modified-since': new Date(Date.now() + 60000).toUTCString() } });
      {
        const dl = Date.now() + 30; let tog = true;
        while (Date.now() < dl) { await fh.truncate(tog ? SMALL : BIG); tog = !tog; }
      }
      const r304 = await p304;
      await fh.truncate(BIG); await fh.close();
      check('range vs mid-write truncate: headers self-consistent', 'cr span == body on every 206',
        `racy=${racy} inconsistent=${inconsistent} ${weird}`, inconsistent === 0 && racy > 0);
      check('GET vs mid-write truncate: cl == body', 'consistent', `bad=${getBad}`, getBad === 0);
      check('future-IMS during mid-write → 304 empty', '304 len=0',
        `${r304.status} len=${r304.body.length}`, r304.status === 304 && r304.body.length === 0);
    }

    /* ---- J9. slow-loris header drip: documented node-timeout behavior ---- */
    {
      const loris = [];
      for (let i = 0; i < 8; i++) {
        const s = connect(PORT, '127.0.0.1');
        s.on('error', () => {});
        await new Promise(r => s.once('connect', r));
        s.write(`GET /package.json HTTP/1.1\r\nHost: x\r\nX-Drip-${i}: `);   // never-ending header
        loris.push(s);
      }
      const drip = setInterval(() => loris.forEach((s, i) => {
        try { s.write(`${i}`); } catch { /* gone */ }
      }), 200);
      const t0 = Date.now();
      const r1 = await req('/package.json');
      await delay(1600);
      const r2 = await req('/package.json');
      clearInterval(drip);
      // one drip finishes its headers → server must still answer it
      let lorisResp = '';
      loris[0].on('data', d => { lorisResp += d.toString('latin1'); });
      loris[0].write('done\r\n\r\n');
      await delay(500);
      loris.forEach(s => s.destroy());
      check('slow-loris header drip: others unaffected, drip completes', 'fast GETs + 200',
        `lat=${Date.now() - t0}ms r=${r1.status}/${r2.status} loris=${statusOf(lorisResp)}`,
        r1.status === 200 && r2.status === 200 && statusOf(lorisResp) === 200);
      await delay(150);
      check('server alive after loris sockets destroyed', 'GET / → 200',
        `${await req('/').then(r => r.status)}`, await alive());
    }

    /* ---- J10. fd exhaustion: dedicated low-limit child, flood + recover ---- */
    {
      const LP = PORT + 60;
      const lchild = spawn('/bin/sh', ['-c', 'ulimit -n 48; exec "$0" "$@"',
        process.execPath, join(ROOT, 'server.mjs')],
        { env: { ...process.env, PORT: String(LP) }, stdio: ['ignore', 'pipe', 'pipe'] });
      let ldead = false;
      lchild.on('exit', () => { ldead = true; });
      const up = await Promise.race([
        new Promise(r => lchild.stdout.on('data', d => String(d).includes('→') && r(true))),
        delay(8000).then(() => false),
      ]);
      let flooded = 0, survived = false;
      if (up) {
        const socks = [];
        for (let i = 0; i < 160 && !ldead; i++) {          // ~3x its fd limit
          const s = connect(LP, '127.0.0.1');
          s.on('error', () => {});
          await new Promise(r => { s.once('connect', r); s.once('error', r); s.once('close', r); });
          s.write(`GET /package.json HTTP/1.1\r\nHost: x\r\nX-Hold: ${i}\r\n`);
          socks.push(s);
          if (i % 40 === 0) await delay(40);
        }
        flooded = socks.length;
        await delay(1200);                                 // time for EMFILE to bite if it kills
        socks.forEach(s => s.destroy());                   // drain the flood
        await delay(700);
        survived = await (async () => {
          try { return (await new Promise((res, rej) => {
            const q = request({ host: '127.0.0.1', port: LP, path: '/', agent: false },
              rsp => { rsp.resume(); rsp.on('end', () => res(rsp.statusCode)); });
            q.on('error', rej); q.setTimeout(3000, () => { q.destroy(); rej(new Error('t/o')); });
            q.end();
          })) === 200; } catch { return false; }
        })();
      }
      check('fd exhaustion (48-fd server, 160-socket flood)', 'survives + recovers',
        `flooded=${flooded} dead=${ldead} recovered=${survived}`, up && !ldead && survived);
      lchild.kill('SIGKILL');
    }
  }

  /* ================ K. conditional-request edges ================
     wave-4 server emits a strong etag ("sizeHEX-mtimeHEX") and honors
     If-Match / If-Unmodified-Since / If-None-Match / If-Range. The live
     pre-fix build ignores them all → tolerated alternates on --live. */
  {
    const one = await req(FIX_URL + 'blob.bin');
    const et = one.headers['etag'], lm = one.headers['last-modified'];
    check('etag validator emitted', LIVE ? '"<hex>" (fixed) / absent (pre-fix live)' : '"sizeHEX-mtimeHEX"',
      `etag=${et || 'absent'}`,
      LIVE ? true : /^"[0-9a-f]+-[0-9a-f.]+"$/.test(et || ''));

    let r = await req(FIX_URL + 'blob.bin', { headers: { 'if-none-match': et || '"x"' } });
    check('INM matching etag', LIVE ? '304 (fixed) / 200 (pre-fix live)' : '304 empty',
      `${r.status} len=${r.body.length}`,
      LIVE ? (r.status === 304 || r.status === 200)
           : r.status === 304 && r.body.length === 0);
    r = await req(FIX_URL + 'blob.bin', { headers: { 'if-none-match': '*' } });
    check('INM * → 304', LIVE ? '304 / 200 (pre-fix live)' : '304', `${r.status}`,
      LIVE ? (r.status === 304 || r.status === 200) : r.status === 304);
    r = await req(FIX_URL + 'blob.bin', { headers: { 'if-none-match': 'W/' + (et || '"x"') } });
    check('INM weak W/etag matches (weak compare)', LIVE ? '304 / 200 (pre-fix live)' : '304',
      `${r.status}`, LIVE ? (r.status === 304 || r.status === 200) : r.status === 304);
    r = await req(FIX_URL + 'blob.bin', { headers: { 'if-none-match': '"deadbeef"' } });
    check('INM bogus → 200', '200', `${r.status}`, r.status === 200);
    r = await req(FIX_URL + 'blob.bin', { headers: { 'if-none-match': `"deadbeef", ${et || '"x"'}` } });
    check('INM list containing ours → 304', LIVE ? '304 / 200 (pre-fix live)' : '304',
      `${r.status}`, LIVE ? (r.status === 304 || r.status === 200) : r.status === 304);
    r = await req(FIX_URL + 'blob.bin', { method: 'HEAD', headers: { 'if-none-match': et || '"x"' } });
    check('INM on HEAD → 304', LIVE ? '304 / 200 (pre-fix live)' : '304 empty',
      `${r.status} len=${r.body.length}`,
      LIVE ? (r.status === 304 || r.status === 200) : r.status === 304 && r.body.length === 0);
    // RFC 9110 §13.1.3: a present INM (even non-matching) suppresses IMS
    r = await req(FIX_URL + 'blob.bin',
      { headers: { 'if-none-match': '"deadbeef"', 'if-modified-since': lm } });
    check('IMS ignored when INM present', LIVE ? '200 (fixed) / 304 (pre-fix live: no INM)' : '200',
      `${r.status}`, LIVE ? (r.status === 200 || r.status === 304) : r.status === 200);
    // precondition beats range: matching INM + Range → 304, not 206
    r = await req(FIX_URL + 'blob.bin',
      { headers: { 'if-none-match': et || '"x"', range: 'bytes=0-9' } });
    check('matching INM + Range → 304 wins', LIVE ? '304 / 206 (pre-fix live)' : '304',
      `${r.status}`, LIVE ? (r.status === 304 || r.status === 206) : r.status === 304);

    r = await req(FIX_URL + 'blob.bin', { headers: { 'if-match': '*' } });
    check('If-Match * → 200', '200', `${r.status}`, r.status === 200);
    r = await req(FIX_URL + 'blob.bin', { headers: { 'if-match': et || '"x"' } });
    check('If-Match own etag → 200', '200', `${r.status}`, r.status === 200);
    r = await req(FIX_URL + 'blob.bin', { headers: { 'if-match': '"deadbeef"' } });
    check('If-Match bogus → 412', LIVE ? '412 / 200 (pre-fix live)' : '412', `${r.status}`,
      LIVE ? (r.status === 412 || r.status === 200) : r.status === 412);
    r = await req(FIX_URL + 'blob.bin', { headers: { 'if-match': 'W/' + (et || '"x"') } });
    check('If-Match weak tag → 412 (strong compare)', LIVE ? '412 / 200 (pre-fix live)' : '412',
      `${r.status}`, LIVE ? (r.status === 412 || r.status === 200) : r.status === 412);

    const past = 'Wed, 01 Jan 2020 00:00:00 GMT';
    const future = new Date(Date.now() + 3600e3).toUTCString();
    r = await req(FIX_URL + 'blob.bin', { headers: { 'if-unmodified-since': past } });
    check('IUS stale → 412', LIVE ? '412 / 200 (pre-fix live)' : '412', `${r.status}`,
      LIVE ? (r.status === 412 || r.status === 200) : r.status === 412);
    r = await req(FIX_URL + 'blob.bin', { headers: { 'if-unmodified-since': future } });
    check('IUS future → 200', '200', `${r.status}`, r.status === 200);
    r = await req(FIX_URL + 'blob.bin', { headers: { 'if-unmodified-since': 'not a date' } });
    check('IUS malformed → ignored → 200', '200', `${r.status}`, r.status === 200);
    r = await req(FIX_URL + 'blob.bin', { headers: { 'if-match': '*', 'if-unmodified-since': past } });
    check('IUS ignored when If-Match present', '200', `${r.status}`, r.status === 200);

    // If-Range — the wave-4 defect: a stale validator used to get a 206
    // splice of the CHANGED file; now the Range is ignored → whole 200
    r = await req(FIX_URL + 'blob.bin', { headers: { range: 'bytes=0-9', 'if-range': lm } });
    check('If-Range matching Last-Modified → 206', '206 len=10',
      `${r.status} len=${r.body.length}`, r.status === 206 && r.body.length === 10);
    r = await req(FIX_URL + 'blob.bin', { headers: { range: 'bytes=0-9', 'if-range': et || '"x"' } });
    check('If-Range matching etag → 206', '206 len=10', `${r.status} len=${r.body.length}`,
      r.status === 206 && r.body.length === 10);
    r = await req(FIX_URL + 'blob.bin', { headers: { range: 'bytes=0-9', 'if-range': past } });
    check('If-Range stale date → 200 whole', LIVE ? '200 (fixed) / 206 splice (pre-fix live)' : '200 len=5000',
      `${r.status} len=${r.body.length}`,
      LIVE ? (r.status === 200 || r.status === 206) : r.status === 200 && r.body.equals(BLOB));
    r = await req(FIX_URL + 'blob.bin', { headers: { range: 'bytes=0-9', 'if-range': '"deadbeef"' } });
    check('If-Range unknown etag → 200 whole', LIVE ? '200 (fixed) / 206 (pre-fix live)' : '200 len=5000',
      `${r.status} len=${r.body.length}`,
      LIVE ? (r.status === 200 || r.status === 206) : r.status === 200 && r.body.equals(BLOB));
    r = await req(FIX_URL + 'blob.bin', { headers: { range: 'bytes=0-9', 'if-range': 'W/' + (et || '"x"') } });
    check('If-Range WEAK etag → 200 (never gates)', LIVE ? '200 / 206 (pre-fix live)' : '200',
      `${r.status}`, LIVE ? (r.status === 200 || r.status === 206) : r.status === 200);
    r = await req(FIX_URL + 'blob.bin', { headers: { range: 'bytes=0-9', 'if-range': 'garbage-value' } });
    check('If-Range garbage → 200', LIVE ? '200 / 206 (pre-fix live)' : '200',
      `${r.status}`, LIVE ? (r.status === 200 || r.status === 206) : r.status === 200);
    r = await req(FIX_URL + 'blob.bin', { headers: { range: 'bytes=abc', 'if-range': '"deadbeef"' } });
    check('failed If-Range ignores malformed Range → 200', LIVE ? '200 / 416 (pre-fix live)' : '200',
      `${r.status}`, LIVE ? (r.status === 200 || r.status === 416) : r.status === 200);
    r = await req(FIX_URL + 'empty.bin', { headers: { range: 'bytes=0-9', 'if-range': '"deadbeef"' } });
    check('failed If-Range on empty file → 200 cl=0', LIVE ? '200 / 416 (pre-fix live)' : '200 cl=0',
      `${r.status} cl=${r.headers['content-length']}`,
      LIVE ? (r.status === 200 || r.status === 416)
           : r.status === 200 && +r.headers['content-length'] === 0);
    r = await req(FIX_URL + 'blob.bin',
      { method: 'HEAD', headers: { range: 'bytes=0-9', 'if-range': '"deadbeef"' } });
    check('HEAD + failed If-Range → 200 full cl', LIVE ? '200 / 206 (pre-fix live)' : '200 cl=5000 empty',
      `${r.status} cl=${r.headers['content-length']} len=${r.body.length}`,
      LIVE ? (r.status === 200 || r.status === 206)
           : r.status === 200 && +r.headers['content-length'] === BLOB.length && r.body.length === 0);

    // mid-write mtime: deterministic via utimes — the etag must track it,
    // catching changes the second-granularity Last-Modified can't see
    const condPath = join(FIX, 'cond.bin');
    await utimes(condPath, new Date(), new Date('2024-06-01T12:00:00.000Z'));
    const c1 = await req(FIX_URL + 'cond.bin');
    await utimes(condPath, new Date(), new Date('2024-06-01T12:00:01.500Z'));
    const c2 = await req(FIX_URL + 'cond.bin');
    check('etag tracks mid-write mtime', LIVE ? 'etag changed / absent (pre-fix live)' : 'etag1 ≠ etag2',
      `${c1.headers.etag || 'none'} → ${c2.headers.etag || 'none'}`,
      LIVE ? true : !!c1.headers.etag && !!c2.headers.etag && c1.headers.etag !== c2.headers.etag);
    if (!LIVE && c1.headers.etag && c2.headers.etag) {
      r = await req(FIX_URL + 'cond.bin', { headers: { 'if-none-match': c1.headers.etag } });
      check('INM pre-write etag → 200 (revalidate catches mtime)', '200', `${r.status}`,
        r.status === 200);
      r = await req(FIX_URL + 'cond.bin', { headers: { 'if-none-match': c2.headers.etag } });
      check('INM current etag → 304', '304', `${r.status}`, r.status === 304);
      r = await req(FIX_URL + 'cond.bin',
        { headers: { range: 'bytes=0-3', 'if-range': c1.headers['last-modified'] } });
      check('If-Range pre-write LM → 200 (mtime moved 1.5s)', '200', `${r.status} len=${r.body.length}`,
        r.status === 200);
      r = await req(FIX_URL + 'cond.bin',
        { headers: { range: 'bytes=0-3', 'if-range': c2.headers['last-modified'] } });
      check('If-Range current LM → 206', '206 len=4', `${r.status} len=${r.body.length}`,
        r.status === 206 && r.body.length === 4);
      r = await req(FIX_URL + 'cond.bin',
        { headers: { range: 'bytes=0-3', 'if-range': c1.headers.etag } });
      check('If-Range pre-write etag → 200 whole', '200', `${r.status} len=${r.body.length}`,
        r.status === 200);
      r = await req(FIX_URL + 'cond.bin',
        { headers: { range: 'bytes=0-3', 'if-range': c2.headers.etag } });
      check('If-Range current etag → 206', '206 len=4', `${r.status} len=${r.body.length}`,
        r.status === 206 && r.body.length === 4);
    }

    // conditionals never mask a miss — 404 before precondition eval
    r = await req(FIX_URL + 'nope.bin', { headers: { 'if-none-match': '*', 'if-match': '*' } });
    check('conditionals never mask a 404', '404', `${r.status}`, r.status === 404);

    // vendor files: immutable policy skips IMS, but the etag still applies
    const v = await req('/vendor/mediapipe/wasm/vision_wasm_internal.js');
    r = await req('/vendor/mediapipe/wasm/vision_wasm_internal.js',
      { headers: { 'if-none-match': v.headers.etag || '"x"' } });
    check('vendor INM → 304 (etag works under immutable)', LIVE ? '304 / 200 (pre-fix live)' : '304',
      `${r.status}`, LIVE ? (r.status === 304 || r.status === 200) : r.status === 304);
    // HEAD + IMS → 304 with no body (IMS path covered for GET already)
    r = await req(FIX_URL + 'blob.bin', { method: 'HEAD', headers: { 'if-modified-since': lm } });
    check('IMS on HEAD → 304 empty', '304 len=0', `${r.status} len=${r.body.length}`,
      r.status === 304 && r.body.length === 0);
    r = await req(FIX_URL + 'blob.bin',
      { method: 'HEAD', headers: { 'if-modified-since': 'Tue, 99 Foo 9999 99:99:99 GMT' } });
    check('malformed IMS on HEAD → 200', '200', `${r.status}`, r.status === 200);
  }

  /* ================ L. method / protocol oddballs (scratch only) ================ */
  if (!LIVE) {
    const alive = async tag => {
      const r = await req('/package.json');
      check(`server alive after ${tag}`, '200', `${r.status}`, r.status === 200);
    };
    const allowHdr = s => (String(s).match(/allow: [^\r\n]*/i) || ['-'])[0];

    let resp = await raw('OPTIONS /package.json HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n');
    check('OPTIONS / → 405 + allow', '405 allow=GET, HEAD', `${statusOf(resp)} ${allowHdr(resp)}`,
      statusOf(resp) === 405 && /GET/.test(resp) && /HEAD/.test(resp));

    resp = await raw('TRACE /package.json HTTP/1.1\r\nHost: x\r\nX-Echo: secret-token\r\nConnection: close\r\n\r\n');
    check('TRACE → 405, request not echoed', '405 no echo', `${statusOf(resp)} echoed=${/X-Echo|secret-token/i.test(resp)}`,
      statusOf(resp) === 405 && !/X-Echo|secret-token/i.test(resp));
    await alive('TRACE');

    resp = await raw(`CONNECT 127.0.0.1:${PORT} HTTP/1.1\r\nHost: x\r\n\r\n`);
    check('CONNECT refused (no tunnel)', 'closed or ≥400', `${statusOf(resp) || 'closed'}`,
      statusOf(resp) === 0 || statusOf(resp) >= 400);
    await alive('CONNECT');

    resp = await raw('UPGRADE /package.json HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n');
    check('UPGRADE method refused', '405/400/closed', `${statusOf(resp) || 'closed'}`,
      statusOf(resp) === 405 || statusOf(resp) === 400 || statusOf(resp) === 0);
    resp = await raw('GET /package.json HTTP/1.1\r\nHost: x\r\nConnection: upgrade\r\nUpgrade: websocket\r\nConnection: close\r\n\r\n');
    check('GET w/ Upgrade hdrs (no upgrade listener)', 'served-as-GET or closed — never 101',
      `${statusOf(resp) || 'closed'} got101=${/HTTP\/\d\.\d 101/.test(resp)}`,
      !/HTTP\/\d\.\d 101/.test(resp));
    await alive('upgrade probes');

    resp = await raw('GET /package.json HTTP/1.0\r\n\r\n');
    const connHdr = (resp.match(/connection: [^\r\n]*/i) || ['-'])[0];
    check('HTTP/1.0 GET → 200 + close', '200 connection: close', `${statusOf(resp)} ${connHdr}`,
      statusOf(resp) === 200 && /close/i.test(connHdr));
    {
      const c = conn(); await c.ready;
      c.write('GET /package.json HTTP/1.0\r\nConnection: keep-alive\r\n\r\n');
      const r1 = await c.readResp();
      c.write('GET /package.json HTTP/1.0\r\n\r\n');
      const r2 = await c.readResp();
      check('HTTP/1.0 + Connection: keep-alive honored', 'two 200s on one socket',
        `${r1.status}→${r2.status} conn=${r1.headers.connection || '-'}`,
        r1.status === 200 && r2.status === 200 && /keep-alive/i.test(r1.headers.connection || ''));
      c.close();
    }
    resp = await raw('GET /package.json HTTP/1.0\r\n\r\nGET /package.json HTTP/1.0\r\n\r\n');
    // node refuses the ambiguous second request-line as a single 400 — the
    // contract is "exactly one response, then close", whichever status it is
    check('HTTP/1.0 pipelined w/o keep-alive → 1 response', 'one response then close',
      `${(resp.match(/HTTP\/\d\.\d \d+/g) || []).length}x → ${statusOf(resp)}`,
      (resp.match(/HTTP\/\d\.\d \d+/g) || []).length === 1);
    await alive('HTTP/1.0 probes');

    resp = await raw(`GET http://other.host:${PORT}/package.json HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`);
    check('absolute-form foreign host (host ignored)', '200', `${statusOf(resp)}`, statusOf(resp) === 200);
    resp = await raw('GET https://example.com/package.json HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n');
    check('absolute-form https URI', '200', `${statusOf(resp)}`, statusOf(resp) === 200);
    resp = await raw('GET http://x/%2e%2e%2fetc%2fpasswd HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n');
    check('absolute-form traversal still guarded', '403 no leak', `${statusOf(resp)} leaked=${/root:/.test(resp)}`,
      statusOf(resp) === 403 && !/root:/.test(resp));
    resp = await raw('GET example.com:80 HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n');
    check('authority-form on GET refused', '400/closed', `${statusOf(resp) || 'closed'}`,
      statusOf(resp) === 400 || statusOf(resp) === 0);
    resp = await raw('GET * HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n');
    check('asterisk-form on GET', '404/400', `${statusOf(resp)}`,
      statusOf(resp) === 404 || statusOf(resp) === 400);
    await alive('request-target forms');

    resp = await raw('GET /package.json HTTP/1.1\r\nConnection: close\r\n\r\n');
    check('HTTP/1.1 missing Host → 400', '400', `${statusOf(resp)}`, statusOf(resp) === 400);
    resp = await raw('GET /package.json HTTP/1.1\r\nHost:\r\nConnection: close\r\n\r\n');
    check('HTTP/1.1 EMPTY Host → 400', '400', `${statusOf(resp)}`, statusOf(resp) === 400);
    resp = await raw('GET /package.json HTTP/1.1\r\nHost: \t \r\nConnection: close\r\n\r\n');
    check('HTTP/1.1 whitespace-only Host → 400', '400', `${statusOf(resp)}`, statusOf(resp) === 400);
    resp = await raw('GET /package.json HTTP/1.0\r\n\r\n');   // 1.0 is exempt from Host
    check('HTTP/1.0 no Host tolerated', '200', `${statusOf(resp)}`, statusOf(resp) === 200);
    await alive('Host probes');

    for (const [tag, wire] of [
      ['HTTP/1.2', 'GET /package.json HTTP/1.2\r\nHost: x\r\nConnection: close\r\n\r\n'],
      ['HTTP/2.0 text', 'GET /package.json HTTP/2.0\r\nHost: x\r\nConnection: close\r\n\r\n'],
      ['HTTP/0.9', 'GET /package.json HTTP/0.9\r\nHost: x\r\nConnection: close\r\n\r\n'],
      ['HTTP/9.9', 'GET /package.json HTTP/9.9\r\nHost: x\r\nConnection: close\r\n\r\n'],
    ]) {
      // llhttp is version-lenient: 1.2/2.0/0.9 get served as 1.x (documented
      // leniency), 9.9 is refused. Anything sane goes — never a wedge.
      resp = await raw(wire);
      check(`${tag} version tolerated or refused`, '200 / 4xx / closed', `${statusOf(resp) || 'closed'}`,
        statusOf(resp) === 200 || statusOf(resp) === 0 || (statusOf(resp) >= 400 && statusOf(resp) < 600));
    }
    await alive('bogus versions');
  }

  /* ================ M. request-smuggling robustness (scratch only) ================
     llhttp does the front-line parsing; what we assert here is the server.mjs
     contract: never serve smuggled bytes, never wedge, stay alive. */
  if (!LIVE) {
    const ping = async () => (await req('/package.json')).status;
    const smug = async (name, wire, okStatuses) => {
      const resp = await raw(wire);
      check(name, okStatuses.join('/') + ' or closed', `${statusOf(resp) || 'closed'}`,
        okStatuses.includes(statusOf(resp)) || statusOf(resp) === 0);
      return resp;
    };
    const pingAfter = async tag => {
      const s = await ping();
      check(`server alive after ${tag}`, '200', `${s}`, s === 200);
    };

    await smug('duplicate Content-Length (identical)',
      'POST /package.json HTTP/1.1\r\nHost: x\r\nContent-Length: 4\r\nContent-Length: 4\r\n\r\nxxxx',
      [400, 405]);
    await smug('duplicate Content-Length (conflicting)',
      'POST /package.json HTTP/1.1\r\nHost: x\r\nContent-Length: 4\r\nContent-Length: 6\r\n\r\nxxxx',
      [400]);
    await smug('Content-Length: -5',
      'POST /package.json HTTP/1.1\r\nHost: x\r\nContent-Length: -5\r\n\r\n', [400]);
    await smug('Content-Length: huge (overflow)',
      'POST /package.json HTTP/1.1\r\nHost: x\r\nContent-Length: 99999999999999999999\r\n\r\n', [400]);
    await smug('Content-Length: 0x10 (non-decimal)',
      'POST /package.json HTTP/1.1\r\nHost: x\r\nContent-Length: 0x10\r\n\r\n', [400]);
    await smug('Content-Length : space before colon',
      'POST /package.json HTTP/1.1\r\nHost: x\r\nContent-Length : 4\r\n\r\nxxxx', [400]);
    await smug('CL + TE: chunked conflict',
      'POST /package.json HTTP/1.1\r\nHost: x\r\nContent-Length: 5\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n',
      [400]);
    await smug('TE + CL (reversed order)',
      'POST /package.json HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: chunked\r\nContent-Length: 5\r\n\r\n0\r\n\r\n',
      [400]);
    await smug('Transfer-Encoding: chunked ×2',
      'POST /package.json HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: chunked\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n',
      [400]);
    await pingAfter('CL/TE conflict probes');

    // trailers must not bleed into the response
    const resp = await smug('chunked POST + trailer fields',
      'POST /package.json HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nabcde\r\n0\r\nX-Smuggled: yes\r\n\r\n',
      [405]);
    check('trailer never reaches response headers', 'no x-smuggled in resp',
      `echoed=${/x-smuggled/i.test(resp)}`, !/x-smuggled/i.test(resp));

    // obs-fold line continuation must not smuggle a header
    await smug('obs-fold header continuation',
      'GET /package.json HTTP/1.1\r\nHost: x\r\nX-Fold: a\r\n b\r\nConnection: close\r\n\r\n', [400]);
    await pingAfter('trailer/obs-fold probes');

    // the desync probe that matters on a non-proxy server: a declared body
    // must be consumed EXACTLY so the pipelined next request stays aligned
    {
      const c = conn(); await c.ready;
      c.write('GET /package.json HTTP/1.1\r\nHost: x\r\nContent-Length: 4\r\n\r\n');
      c.write('XXXX');
      c.write('GET /package.json?second HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n');
      const r1 = await c.readResp();
      const r2 = await c.readResp();
      check('GET + CL body + pipelined: framing aligned', '200 then 200',
        `${r1.status}→${r2.status}`, r1.status === 200 && r2.status === 200);
      c.close();
    }
    // a whole request embedded in a declared body is consumed as bytes —
    // only the 405 and the real next request come back, never the smuggled one
    {
      const smugReq = 'GET /index.html HTTP/1.1\r\nHost: x\r\n\r\n';       // consumed as body
      const c = conn(); await c.ready;
      c.write(`POST /x HTTP/1.1\r\nHost: x\r\nContent-Length: ${smugReq.length}\r\n\r\n`);
      c.write(smugReq);
      c.write('GET /package.json?legit HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n');
      const r1 = await c.readResp('POST');
      const r2 = await c.readResp();
      const r3 = await c.readResp();
      check('smuggled request inside CL body never dispatched', '405→200→(closed), no 3rd resp',
        `${r1.status}→${r2.status}→${r3.status}`,
        r1.status === 405 && r2.status === 200 && r3.status === 0);
      c.close();
    }
    // chunked GET body + trailers + pipelined GET — chunk framing must not desync
    {
      const c = conn(); await c.ready;
      c.write('GET /package.json HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: chunked\r\n\r\n');
      c.write('4\r\nWXYZ\r\n0\r\nX-Trailer: nope\r\n\r\n');
      c.write('GET /package.json?after HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n');
      const r1 = await c.readResp();
      const r2 = await c.readResp();
      check('chunked GET + trailers + pipelined → aligned', '200 then 200',
        `${r1.status}→${r2.status}`, r1.status === 200 && r2.status === 200);
      c.close();
    }
    // declared huge body never sent, then RST — must not wedge the parser
    {
      const s = connect(PORT, '127.0.0.1');
      s.on('error', () => {});
      await new Promise(r => { s.once('connect', r); s.once('error', r); });
      s.write('POST /x HTTP/1.1\r\nHost: x\r\nContent-Length: 500000\r\n\r\n' + 'x'.repeat(32));
      await delay(300);
      s.destroy();
      const r = await req('/package.json');
      check('partial body + RST does not wedge', '200', `${r.status}`, r.status === 200);
    }
    await pingAfter('smuggling probes');
  }

  /* ================ N. URL normalization 2.0 (live-safe) ================
     decoded path must always stay inside root — and map predictably. */
  {
    let r = await req(FIX_URL + './blob.bin');
    check('./ segment collapses', '200 blob', `${r.status}`, r.status === 200 && r.body.equals(BLOB));
    r = await req(FIX_URL + 'dir/../blob.bin');
    check('in-root dir/../ collapses', '200 blob', `${r.status}`, r.status === 200 && r.body.equals(BLOB));
    r = await req('/test//.qe-server-tmp//blob.bin');
    check('// inside path = separators', '200 blob', `${r.status}`, r.status === 200 && r.body.equals(BLOB));
    r = await req('//test/.qe-server-tmp/blob.bin');
    check('//host prefix eaten → in-root miss', '404', `${r.status}`, r.status === 404);
    r = await req(FIX_URL + 'blob.bin%23frag');
    check('%23 → literal # in filename', '404', `${r.status}`, r.status === 404);
    r = await req('/%EF%BC%8E%EF%BC%8E/package.json');                    // fullwidth dots ．．
    check('unicode confusable dots ≠ traversal', '404', `${r.status}`, r.status === 404);
    r = await req('/%D0%B5%2e%2e%2fpackage.json');                        // cyrillic е + ../
    check('cyrillic lookalike + encoded .. → in-root only', '403/404, no leak',
      `${r.status}`, (r.status === 403 || r.status === 404) && !r.body.includes('"scripts"'));
    r = await req('/%C0%AE%C0%AE/package.json');                          // overlong UTF-8 '..'
    check('overlong UTF-8 %C0%AE → 400', '400', `${r.status}`, r.status === 400);
    r = await req('/%ED%A0%80/x');                                        // lone surrogate
    check('lone surrogate %ED%A0%80 → 400', '400', `${r.status}`, r.status === 400);
    r = await req('/%F0%28%8C%BC/x');                                     // invalid UTF-8 seq
    check('invalid UTF-8 %F0%28 → 400', '400', `${r.status}`, r.status === 400);
    r = await req('/%FE%FE/x');                                           // never-valid bytes
    check('invalid UTF-8 %FE → 400', '400', `${r.status}`, r.status === 400);
    r = await req('/test/%2e%2e/%2e%2e/x');
    check('%2e%2e collapses inside root', '404/403', `${r.status}`, r.status === 404 || r.status === 403);
    r = await req(FIX_URL + 'dir%2f%2e%2e%2fblob.bin');
    check('encoded-slash in-root traversal resolves inside', '200 blob', `${r.status}`,
      r.status === 200 && r.body.equals(BLOB));
    r = await req('/a/./b');
    check('/a/./b collapses', '404', `${r.status}`, r.status === 404);
    r = await req('/a//../b');
    check('/a//../b collapses in root', '404', `${r.status}`, r.status === 404);
    r = await req('/..;/x');
    check('..; is a literal name', '404', `${r.status}`, r.status === 404);
    r = await req('/%2f');
    check('bare %2f → //index.html stays in root', '200/404', `${r.status}`,
      r.status === 200 || r.status === 404);
    r = await req(FIX_URL + 'blob.bin%00.txt');
    check('NUL mid-filename', '4xx', `${r.status}`, r.status === 404 || r.status === 400);
    const bf = await readFile(join(ROOT, 'test', 'boxing-fight.mjs'));
    r = await req('/test/.qe-server-tmp/../boxing-fight.mjs');
    check('in-root ../ serves real file', '200 bytes == file', `${r.status} eq=${r.body.equals(bf)}`,
      r.status === 200 && r.body.equals(bf));
    r = await req('/%2e%2e%2f%2e%2e%2f%2e%2e%2f%2e%2e%2fetc%2fpasswd');
    check('deep encoded traversal → refused, no leak', '403/404 no root:', `${r.status} leaked=${r.body.includes('root:')}`,
      (r.status === 403 || r.status === 404) && !r.body.includes('root:'));
    r = await req('/%2E%2E%2F%2E%2E%2Fetc%2Fpasswd');                     // uppercase hex
    check('uppercase-hex traversal → refused, no leak', '403/404 no root:', `${r.status} leaked=${r.body.includes('root:')}`,
      (r.status === 403 || r.status === 404) && !r.body.includes('root:'));
  }

  /* ================ O. keep-alive lifecycle + fd hygiene (scratch only) ================ */
  if (!LIVE) {
    const fd0 = await fdCount();

    // 100 half-open sockets — connected, never send a byte. Bounded by the
    // parser's headersTimeout (60s) — well beyond the probe window, so what
    // we assert is: responsive while held, and fds reclaimed once they die.
    const held = [];
    for (let i = 0; i < 100; i++) {
      const s = connect(PORT, '127.0.0.1');
      s.on('error', () => {});
      held.push(s);
    }
    await Promise.all(held.map(s => new Promise(r => { s.once('connect', r); s.once('error', r); })));
    await delay(400);
    const fdHeld = await fdCount();
    const rMid = await req('/package.json');
    held.forEach(s => s.destroy());
    await delay(900);
    const fdAfter = await fdCount();
    check('100 half-open sockets: responsive while held', '200, fds rose ~100',
      `fd ${fd0}→${fdHeld} req=${rMid.status}`,
      rMid.status === 200 && (fdHeld < 0 || fd0 < 0 || fdHeld >= fd0 + 50));
    check('fds reclaimed after half-open sockets die', '≈ baseline +15',
      `fd ${fd0}→${fdAfter}`, fdAfter < 0 || fd0 < 0 || fdAfter <= fd0 + 15);

    // clean FIN mid-headers — refused or closed, never a wedge
    {
      const s = connect(PORT, '127.0.0.1');
      s.on('error', () => {});
      const out = [];
      s.on('data', d => out.push(d));
      await new Promise(r => s.once('connect', r));
      s.end('GET /package.json HTTP/1.1\r\nHost: x');                  // FIN mid-headers
      await delay(700);
      const resp = Buffer.concat(out).toString('latin1');
      check('FIN mid-headers refused cleanly', '400 or closed', `${statusOf(resp) || 'closed'}`,
        statusOf(resp) === 400 || statusOf(resp) === 0);
      s.destroy();
    }

    // complete request then immediate FIN — node's http layer drops the
    // response on a half-closed socket (verified vs stock node http) —
    // the invariant we own: no crash, no fd held open afterwards
    {
      const fdB = await fdCount();
      let responded = 0;
      for (let i = 0; i < 20; i++) {
        const s = connect(PORT, '127.0.0.1');
        s.on('error', () => {});
        const out = [];
        s.on('data', d => out.push(d));
        await new Promise(r => { s.once('connect', r); s.once('error', r); });
        s.end('GET /package.json HTTP/1.1\r\nHost: x\r\n\r\n');
        await new Promise(r => { s.once('close', r); setTimeout(r, 800); });
        if (Buffer.concat(out).toString('latin1').includes('200')) responded++;
        s.destroy();
      }
      await delay(400);
      const r = await req('/package.json');
      const fdC = await fdCount();
      check('20× FIN-after-request: alive, no fd leak', '200 + fds back',
        `responded=${responded}/20 next=${r.status} fd ${fdB}→${fdC}`,
        r.status === 200 && (fdC < 0 || fdB < 0 || fdC <= fdB + 15));
    }

    // idle keep-alive socket — keepAliveTimeout (5s) must reap it, else an
    // idle conn pins an fd forever
    {
      const c = conn();
      await c.ready;
      c.write('GET /package.json HTTP/1.1\r\nHost: x\r\n\r\n');
      const r = await c.readResp();
      const t0 = Date.now();
      let closedIn = 0;
      await new Promise(res => {
        c.s.once('close', () => { closedIn = Date.now() - t0; res(); });
        setTimeout(res, 7500);
      });
      check('idle keep-alive reaped by keepAliveTimeout', 'closed within ~7s',
        `resp=${r.status} closedIn=${closedIn || '>7500'}ms`,
        r.status === 200 && closedIn > 500 && closedIn <= 7500);
      c.close();
    }

    // Connection: close must actually close on 1.1
    {
      const c = conn();
      await c.ready;
      c.write('GET /package.json HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n');
      const r = await c.readResp();
      const closed = await Promise.race([
        new Promise(rr => c.s.once('close', () => rr(true))),
        delay(900).then(() => false),
      ]);
      check('Connection: close honored on 1.1', '200 + closed', `${r.status} closed=${closed}`,
        r.status === 200 && closed);
      c.close();
    }

    // keep-alive must survive error responses too: 405 then GET, same socket
    {
      const c = conn();
      await c.ready;
      c.write('POST /package.json HTTP/1.1\r\nHost: x\r\nContent-Length: 0\r\n\r\n');
      const r1 = await c.readResp('POST');
      c.write('GET /package.json HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n');
      const r2 = await c.readResp();
      check('keep-alive survives a 405', '405 then 200', `${r1.status}→${r2.status}`,
        r1.status === 405 && r2.status === 200);
      c.close();
    }
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
