#!/usr/bin/env node
/* Static server for the spatial-objects webcam mockups.
   No dependencies — serves the folder on http://127.0.0.1:8791
   (localhost = secure context, so getUserMedia works). */
import { createServer } from 'node:http';
import { readFile, stat, realpath } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { networkInterfaces } from 'node:os';

const ROOT = import.meta.dirname;
const ROOT_REAL = await realpath(ROOT);   // resolve once — ROOT itself may be linked
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
    const st = await stat(file).catch(() => null);
    if (!st || !st.isFile()) { res.writeHead(404); return res.end('not found'); }
    // symlink escape guard — a link inside the tree pointing outside would
    // sail past the lexical check above
    const real = await realpath(file).catch(() => null);
    if (!real || (real !== ROOT_REAL && !real.startsWith(ROOT_REAL + sep))) {
      res.writeHead(403); return res.end('no');
    }

    // vendored models/wasm (~20MB) never change mid-fight — cache them hard.
    // Source files revalidate instead: no-store forced a full refetch of
    // everything on every reload; last-modified gives us cheap 304s.
    const cacheable = path.startsWith('/vendor/');
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
    // test input; a 200-with-body fallback made seeking/looping unreliable
    let status = 200, start = 0, end = st.size - 1;
    if (range) {
      const m = /^bytes=(\d*)-(\d*)$/i.exec(range.trim());
      if (m && (m[1] !== '' || m[2] !== '')) {
        if (m[1] === '') {                       // suffix: last N bytes
          start = Math.max(0, st.size - (+m[2] || 0));
        } else {
          start = +m[1];
          if (m[2] !== '') end = Math.min(end, +m[2]);
        }
      }
      if (!m || (m[1] === '' && m[2] === '') || start > end || start >= st.size) {
        res.writeHead(416, { ...hdrs, 'content-range': `bytes */${st.size}` });
        return res.end();
      }
      status = 206;
      hdrs['content-range'] = `bytes ${start}-${end}/${st.size}`;
    }
    hdrs['content-length'] = end - start + 1;
    // read BEFORE writeHead — a file that vanishes between stat() and here
    // must still get a clean 500, never a 200 status followed by a dead
    // body or a second writeHead (that threw ERR_HTTP_HEADERS_SENT and
    // killed the whole server on an unhandled rejection)
    const buf = req.method === 'HEAD' ? null : await readFile(file);
    res.writeHead(status, hdrs);
    if (req.method === 'HEAD') return res.end();
    res.end(status === 206 ? buf.subarray(start, end + 1) : buf);
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
