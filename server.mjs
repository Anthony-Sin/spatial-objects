#!/usr/bin/env node
/* Static server for the spatial-objects webcam mockups.
   No dependencies — serves the folder on http://127.0.0.1:8791
   (localhost = secure context, so getUserMedia works). */
import { createServer } from 'node:http';
import { open, readFile, stat, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { extname, join, normalize, sep } from 'node:path';
import { networkInterfaces } from 'node:os';

const ROOT = import.meta.dirname;
/* drop KEY=value lines from ./.env into process.env (real env wins) — the
   coach proxies read their upstream keys from here, and the DENY list below
   keeps the file itself from ever being served. */
try {
  for (const line of (await readFile(join(ROOT, '.env'), 'utf8')).split('\n')) {
    const m = /^\s*([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (m && process.env[m[1]] === undefined)
      process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
} catch { /* no .env — fine */ }
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

/* the halftime corner card can't call TensorMux from the page — the API
   sends no CORS header on preflight, so any authenticated browser request
   dies there. The tip rides through this one POST route instead; the key
   stays server-side (TENSOR_KEY env overrides the baked-in demo key). */
const TENSOR = {
  url: 'https://api.tensormux.com/v1/chat/completions',
  key: process.env.TENSOR_KEY || 'tmx_af21566252975c8498a877ceed4eb7b5',
  model: 'glm-4-7-flash',
};
async function coachTip(req, res) {
  const j = (code, obj) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(obj));
  };
  try {
    // a corner prompt is a paragraph — anything bigger is drained then refused
    let body = '', big = false;
    for await (const c of req) {
      body += c;
      if (body.length > 8192) { big = true; break; }
    }
    if (big) { req.resume(); return j(413, { error: 'too big' }); }
    let prompt = '';
    try { prompt = String(JSON.parse(body)?.prompt || '').slice(0, 2000); } catch {}
    if (!prompt) return j(400, { error: 'no prompt' });
    const ctl = new AbortController(), to = setTimeout(() => ctl.abort(), 8000);
    try {
      const r = await fetch(TENSOR.url, { method: 'POST', signal: ctl.signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TENSOR.key}` },
        body: JSON.stringify({ model: TENSOR.model, reasoning_effort: 'none', max_tokens: 80,
          messages: [{ role: 'user', content: prompt }] }) });
      const d = await r.json().catch(() => null);
      const tip = String(d?.choices?.[0]?.message?.content || '')
        .replace(/^[\s"'`*]+|[\s"'`*]+$/g, '').slice(0, 240);   // models wrap tips in *""* flourishes — strip the wrapping
      if (!r.ok || !tip) return j(502, { error: `upstream ${r.status}` });
      j(200, { tip });
    } catch { j(502, { error: 'coach unreachable' }); }
    finally { clearTimeout(to); }
  } catch { j(500, { error: 'coach route failed' }); }
}

/* same problem for the voice: the tip is spoken in a gravelly corner voice
   (ElevenLabs). Same route shape — page posts {text, voice?}, gets mp3 back.
   ELEVENLABS_KEY / ELEVENLABS_VOICE in env or .env; no key → a clean 501 and
   the page just stays quiet instead of failing the break. */
const ELEVEN = {
  key: process.env.ELEVENLABS_KEY || '',
  voice: process.env.ELEVENLABS_VOICE || '2EiwWnXFnvU5JabPnvig',  // Clyde — war-vet rasp, born for corners
  model: 'eleven_turbo_v2_5',                                   // fast enough to land mid-break
};
async function coachVoice(req, res) {
  const j = (code, obj) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(obj));
  };
  try {
    if (!ELEVEN.key) return j(501, { error: 'no ELEVENLABS_KEY configured' });
    let body = '', big = false;
    for await (const c of req) {
      body += c;
      if (body.length > 4096) { big = true; break; }
    }
    if (big) { req.resume(); return j(413, { error: 'too big' }); }
    let text = '', voice = ELEVEN.voice;
    try {
      const d = JSON.parse(body);
      text = String(d?.text || '').slice(0, 400);
      // a caller can audition voices via ?voice= — voice ids are opaque
      // alnum strings, nothing else gets through
      if (/^[a-zA-Z0-9]{15,30}$/.test(d?.voice || '')) voice = d.voice;
    } catch {}
    if (!text) return j(400, { error: 'no text' });
    const ctl = new AbortController(), to = setTimeout(() => ctl.abort(), 10000);
    try {
      const r = await fetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${voice}?output_format=mp3_44100_64`,
        { method: 'POST', signal: ctl.signal,
          headers: { 'xi-api-key': ELEVEN.key, 'Content-Type': 'application/json' },
          body: JSON.stringify({ text, model_id: ELEVEN.model,
            voice_settings: { stability: .45, similarity_boost: .75, style: .4, speed: 1.05 } }) });
      if (!r.ok) return j(502, { error: `upstream ${r.status}` });
      const buf = Buffer.from(await r.arrayBuffer());
      res.writeHead(200, { 'content-type': 'audio/mpeg', 'content-length': buf.length,
        'cache-control': 'no-store' });
      res.end(buf);
    } catch { j(502, { error: 'voice unreachable' }); }
    finally { clearTimeout(to); }
  } catch { j(500, { error: 'voice route failed' }); }
}

const server = createServer(async (req, res) => {
  try {
    // a reset socket must never take the process down — client aborts can
    // surface as 'error' on the req/res wrappers, and an 'error' event with
    // no listener throws
    req.on('error', () => {});
    res.on('error', () => {});
    // the two POST routes — everything below stays read-only static
    const api = req.method === 'POST' ? req.url.split('?')[0] : '';
    if (api === '/api/coach') return coachTip(req, res);
    if (api === '/api/coach-voice') return coachVoice(req, res);
    // read-only server — anything but GET/HEAD is a clean 405. Previously a
    // POST fell through to a 200 + body, and its payload was never drained
    // off the socket.
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD' });
      return res.end('method not allowed');
    }
    // node itself 400s a MISSING Host on HTTP/1.1 but `Host:` with an empty
    // value sails through — an empty authority is equally useless (§7.2)
    if (req.headers.host === '') {
      res.writeHead(400); return res.end('bad request');
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
    // sail past the lexical check above. realpath FAILING is different: the
    // path vanished (or is a dangling/looping link) between stat() and here —
    // that's "not found", not "forbidden" (a delete mid-request was surfacing
    // as a bogus 403)
    const real = await realpath(file).catch(() => null);
    if (!real) { res.writeHead(404); return res.end('not found'); }
    if (real !== ROOT_REAL && !real.startsWith(ROOT_REAL + sep)) {
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
      // kernel readlink appends " (deleted)" to the path of an fd whose file
      // was unlinked after open — strip it, or a denied basename like ".env"
      // becomes ".env (deleted)" and evades the exact-match denylist below
      const fdPath = fdReal.endsWith(' (deleted)') ? fdReal.slice(0, -' (deleted)'.length) : fdReal;
      if (fdPath !== ROOT_REAL && !fdPath.startsWith(ROOT_REAL + sep)) {
        res.writeHead(403); return res.end('no');
      }
      // DENY re-checked against the OPENED inode's path, not just `real`: a
      // dir component of `real` swapped for a symlink between realpath() and
      // open() could land this fd on a still-in-root denied file (.git/, .env)
      if (fdPath.split(sep).some(s => DENY.has(s))) {
        res.writeHead(404); return res.end('not found');
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
      // strong entity tag: identical size + identical mtime ⇔ identical bytes.
      // A bare Last-Modified only carries second granularity and can't gate
      // If-Match / If-None-Match / If-Range — those need a real validator.
      const etag = `"${st.size.toString(16)}-${st.mtimeMs.toString(16)}"`;
      const hdrs = {
        'content-type': MIME[extname(file).toLowerCase()] || 'application/octet-stream',
        'cache-control': cacheable ? 'max-age=86400, immutable' : 'no-cache',
        'last-modified': st.mtime.toUTCString(),
        'etag': etag,
        'accept-ranges': 'bytes',
        'cross-origin-opener-policy': 'same-origin',
        'cross-origin-embedder-policy': 'credentialless',
        'cross-origin-resource-policy': 'same-origin',
        'origin-agent-cluster': '?1',
      };
      const range = req.headers.range;
      // Conditional preconditions in RFC 9110 §13.2.2 order: If-Match →
      // If-Unmodified-Since → If-None-Match → If-Modified-Since → (If-Range is
      // evaluated with the Range below). A malformed date NaNs out → ignored,
      // not failed — a client can't be faulted for a validator we never issued.
      const tagList = v => v.split(',').map(t => t.trim()).filter(Boolean);
      const im = req.headers['if-match'];
      const imTags = im === undefined ? [] : tagList(im);
      if (imTags.length && !imTags.some(t => t === '*' || t === etag)) {   // strong compare — weak never matches
        res.writeHead(412, hdrs); return res.end('precondition failed');
      }
      // If-Unmodified-Since is ignored when If-Match is present (§13.1.4).
      // Presence-gated: Date.parse(0) → Jan 2000, which is truthy — the
      // `|| 0` fallback would invent a validator the client never sent.
      const iusHdr = im === undefined ? req.headers['if-unmodified-since'] : undefined;
      const ius = iusHdr === undefined ? NaN : Date.parse(iusHdr);
      if (ius && st.mtimeMs > ius + 999) {                       // file IS newer → precondition fails
        res.writeHead(412, hdrs); return res.end('precondition failed');
      }
      const inm = req.headers['if-none-match'];
      const inmTags = inm === undefined ? [] : tagList(inm);
      if (inmTags.length
          && inmTags.some(t => t === '*' || t.replace(/^W\//, '') === etag)) {   // weak compare (§13.1.2)
        res.writeHead(304, hdrs); return res.end();
      }
      // If-Modified-Since is ignored when If-None-Match is present (§13.1.3).
      // The vendor exemption stays: immutable files revalidate by freshness,
      // not by conditional date. (Presence-gated like IUS — see above.)
      const imsHdr = inm === undefined ? req.headers['if-modified-since'] : undefined;
      const ims = imsHdr === undefined ? NaN : Date.parse(imsHdr);
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
        // If-Range (RFC 9110 §14.3): the range applies only while the
        // client's cached validator still matches. A stale one means the
        // file changed under it — serving the 206 splice would silently
        // corrupt a resumed download, so the whole representation goes out.
        // Weak etags can never gate a range; an HTTP-date must equal our
        // Last-Modified exactly (HTTP-dates only carry second granularity).
        const ifr = req.headers['if-range']?.trim();
        const ifrOk = ifr === undefined ? true
          : ifr.startsWith('W/') ? false
          : ifr.startsWith('"') ? ifr === etag
          : Math.floor(Date.parse(ifr) / 1000) === Math.floor(st.mtimeMs / 1000);
        const spec = range.trim();
        const isBytes = /^bytes\s*=/i.test(spec);
        const m = /^bytes=(\d*)-(\d*)$/i.exec(spec);
        if (ifrOk && isBytes && m && (m[1] !== '' || m[2] !== '') && !spec.includes(',')) {
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
        } else if (ifrOk && isBytes && !spec.includes(',')) {
          // bytes= spec that isn't a usable single range (bytes=abc, bytes=-)
          res.writeHead(416, { ...hdrs, 'content-range': `bytes */${st.size}` });
          return res.end();
        }
        // else: unknown unit (items=…) / multi-range set / failed If-Range —
        // all ignored, the client receives the whole 200 body
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
        // ...and the content-range set from fstat() is now stale: it would
        // announce a span LONGER than the body on the wire (and a stale
        // total) — re-derive it from what was actually read
        hdrs['content-range'] = `bytes ${start}-${end}/${buf.length}`;
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
