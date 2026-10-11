#!/usr/bin/env node
/* Static server for the spatial-objects webcam mockups.
   No dependencies — serves the folder on http://127.0.0.1:8791
   (localhost = secure context, so getUserMedia works). */
import { createServer } from 'node:http';
import { open, stat, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { extname, join, normalize, sep } from 'node:path';
import { networkInterfaces } from 'node:os';

const ROOT = import.meta.dirname;
const ROOT_REAL = await realpath(ROOT);   // resolve once — ROOT itself may be linked
const VENDOR_PREFIX = ROOT_REAL + sep + 'vendor' + sep;
// resolved-path denylist — never web content. The 0.0.0.0 bind makes these
// reachable to the whole LAN: .git leaks the full repo history (including
// secrets that were committed then deleted), .env would leak live ones.
const DENY = new Set(['.git', '.env']);
const PORT = Number(process.env.PORT || 8791);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.gif': 'image/gif',
  '.wasm': 'application/wasm',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
  '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json',
  '.task': 'application/octet-stream', '.onnx': 'application/octet-stream',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf',
  '.tflite': 'application/octet-stream', '.bin': 'application/octet-stream',
};

const server = createServer(async (req, res) => {
  try {
    // a reset socket must never take the process down — client aborts can
    // surface as 'error' on the req/res wrappers, and an 'error' event with
    // no listener throws
    req.on('error', () => {});
    res.on('error', () => {});
    // read-only server — anything but GET/HEAD is a clean 405. Previously a
    // POST fell through to a 200 + body, and its payload was never drained
    // off the socket.
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD' });
      return res.end('method not allowed');
    }
    let path;
    try {
      path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    } catch { res.writeHead(400); return res.end('bad request'); }
    if (path.endsWith('/')) path += 'index.html';
    const file = normalize(join(ROOT, path));
    // prefix check must include the separator — `startsWith(ROOT)` alone
    // would also match a sibling like `<ROOT>-evil/…`
    if (file !== ROOT && !file.startsWith(ROOT + sep)) {
      res.writeHead(403); return res.end('no');
    }
    // cheap existence probe first — a missing file must be a 404, not the
    // 403 a failed realpath() below would report
    const st0 = await stat(file).catch(() => null);
    if (!st0 || !st0.isFile()) { res.writeHead(404); return res.end('not found'); }
    // symlink escape guard — a link inside the tree pointing outside would
    // sail past the lexical check above
    const real = await realpath(file).catch(() => null);
    if (!real || (real !== ROOT_REAL && !real.startsWith(ROOT_REAL + sep))) {
      res.writeHead(403); return res.end('no');
    }
    if (real.split(sep).some(s => DENY.has(s))) {
      res.writeHead(404); return res.end('not found');
    }
    // Pin the resolved file to an fd for the rest of the request. stat() →
    // realpath() → readFile() on the PATH is three lookups — a symlink or dir
    // component swapped in between could redirect the read outside the vetted
    // root (TOCTOU). fstat + read on one fd always hit the same inode.
    // O_NONBLOCK keeps a fifo swapped into that race from parking a worker
    // thread inside open() forever.
    let fh;
    try {
      fh = await open(real, constants.O_RDONLY | constants.O_NONBLOCK);
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;   // vanished mid-race → 404; else → 500
      res.writeHead(404); return res.end('not found');
    }
    try {
      // re-verify the PINNED inode, not the path — a dir component of `real`
      // could be swapped for an escaping symlink between realpath() and
      // open(); resolving /proc/self/fd/<n> tells us what we actually opened.
      // Falls back to `real` where /proc doesn't exist (non-Linux).
      const fdReal = await realpath(`/proc/self/fd/${fh.fd}`).catch(() => real);
      if (fdReal !== ROOT_REAL && !fdReal.startsWith(ROOT_REAL + sep)) {
        res.writeHead(403); return res.end('no');
      }
      const st = await fh.stat();
      if (!st.isFile()) { res.writeHead(404); return res.end('not found'); }

      // vendored models/wasm (~20MB) never change mid-fight — cache them hard.
      // Source files revalidate instead: no-store forced a full refetch of
      // everything on every reload; last-modified gives us cheap 304s.
      // Keyed off the RESOLVED path — `/vendor/..%2fx` decodes to a vendor/
      // prefix but lands outside it, and must not borrow the immutable policy
      // (or the 304 skip) for a file that isn't actually under vendor/.
      const cacheable = real.startsWith(VENDOR_PREFIX);
      const hdrs = {
        'content-type': MIME[extname(file).toLowerCase()] || 'application/octet-stream',
        'cache-control': cacheable ? 'max-age=86400, immutable' : 'no-cache',
        'last-modified': st.mtime.toUTCString(),
        'accept-ranges': 'bytes',
        'cross-origin-opener-policy': 'same-origin',
        'cross-origin-embedder-policy': 'credentialless',
        'cross-origin-resource-policy': 'same-origin',
        'origin-agent-cluster': '?1',
      };
      const range = req.headers.range;
      const ims = Date.parse(req.headers['if-modified-since'] || 0);
      if (!range && !cacheable && ims && st.mtimeMs <= ims + 999) {   // 1s slack for sec-granularity
        res.writeHead(304, hdrs); return res.end();
      }

      // single byte-range — Chromium's media stack asks for these on the .mp4
      // test input; a 200-with-body fallback made seeking/looping unreliable.
      // RFC 9110 §14.1.2: an unknown range unit MUST be ignored — and ignoring
      // a multi-range set is equally legal; the client just gets the whole
      // body. Only a syntactically broken or unsatisfiable bytes= spec 416s.
      let status = 200, start = 0, end = st.size - 1;
      if (range) {
        const spec = range.trim();
        const isBytes = /^bytes\s*=/i.test(spec);
        const m = /^bytes=(\d*)-(\d*)$/i.exec(spec);
        if (isBytes && m && (m[1] !== '' || m[2] !== '') && !spec.includes(',')) {
          if (m[1] === '') {                       // suffix: last N bytes
            start = Math.max(0, st.size - (+m[2] || 0));
          } else {
            start = +m[1];
            if (m[2] !== '') end = Math.min(end, +m[2]);
          }
          if (start > end || start >= st.size) {
            res.writeHead(416, { ...hdrs, 'content-range': `bytes */${st.size}` });
            return res.end();
          }
          status = 206;
          hdrs['content-range'] = `bytes ${start}-${end}/${st.size}`;
        } else if (isBytes && !spec.includes(',')) {
          // bytes= spec that isn't a usable single range (bytes=abc, bytes=-)
          res.writeHead(416, { ...hdrs, 'content-range': `bytes */${st.size}` });
          return res.end();
        }
        // else: unknown unit (items=…) or a multi-range set — ignored, the
        // client receives the whole 200 body
      }

      // read BEFORE writeHead — a file that vanishes between fstat() and here
      // must still get a clean 500, never a 200 status followed by a dead
      // body or a second writeHead (that threw ERR_HTTP_HEADERS_SENT and
      // killed the whole server on an unhandled rejection)
      const buf = req.method === 'HEAD' ? null : await fh.readFile();
      if (buf && status === 206) {
        // it may also have SHRUNK between fstat() and readFile() — never
        // promise bytes we didn't actually read
        if (start >= buf.length) {
          res.writeHead(416, { ...hdrs, 'content-range': `bytes */${buf.length}` });
          return res.end();
        }
        end = Math.min(end, buf.length - 1);
      } else if (buf) {
        end = buf.length - 1;                    // 200: deliver what was read
      }
      hdrs['content-length'] = end - start + 1;
      res.writeHead(status, hdrs);
      if (req.method === 'HEAD') return res.end();
      res.end(status === 206 ? buf.subarray(start, end + 1) : buf);
    } finally {
      await fh.close().catch(() => {});
    }
  } catch (e) {
    try {
      if (!res.headersSent) res.writeHead(500);
      res.end(String(e));
    } catch { /* socket already gone */ }
  }
});
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE')
    console.error(`server.mjs: port ${PORT} already in use — pick another: PORT=<free> node server.mjs`);
  else console.error('server.mjs:', e);
  process.exit(1);
});
server.listen(PORT, '0.0.0.0', () => {
  const lan = Object.values(networkInterfaces()).flat().find(i => i && i.family === 'IPv4' && !i.internal)?.address;
  console.log(`spatial-objects → http://127.0.0.1:${PORT}` + (lan ? `  (lan: http://${lan}:${PORT})` : ''));
});
