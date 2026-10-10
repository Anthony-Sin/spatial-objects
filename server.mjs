#!/usr/bin/env node
/* Static server for the spatial-objects webcam mockups.
   No dependencies — serves the folder on http://127.0.0.1:8791
   (localhost = secure context, so getUserMedia works). */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { networkInterfaces } from 'node:os';

const ROOT = import.meta.dirname;
const PORT = Number(process.env.PORT || 8791);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.wasm': 'application/wasm',
  '.task': 'application/octet-stream', '.onnx': 'application/octet-stream',
  '.woff2': 'font/woff2', '.ttf': 'font/ttf',
};

createServer(async (req, res) => {
  try {
    let path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (path.endsWith('/')) path += 'index.html';
    const file = normalize(join(ROOT, path));
    if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end('no'); }
    const st = await stat(file).catch(() => null);
    if (!st || !st.isFile()) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, {
      'content-type': MIME[extname(file)] || 'application/octet-stream',
      'cache-control': 'no-store',
      'cross-origin-opener-policy': 'same-origin',
      'cross-origin-embedder-policy': 'credentialless',
    });
    res.end(await readFile(file));
  } catch (e) { res.writeHead(500); res.end(String(e)); }
}).listen(PORT, '0.0.0.0', () => {
  const lan = Object.values(networkInterfaces()).flat().find(i => i && i.family === 'IPv4' && !i.internal)?.address;
  console.log(`spatial-objects → http://127.0.0.1:${PORT}` + (lan ? `  (lan: http://${lan}:${PORT})` : ''));
});
