# Spatial Objects

Live phone camera scanning with object detection on your computer and aligned AI depth estimates. The phone loads a public GitHub Pages site; frames and results travel through an AES-GCM-encrypted MQTT relay, so it works on any network without a USB cable or tunnel ports.

- Site: https://anthony-sin.github.io/spatial-objects/
- Repo: https://github.com/Anthony-Sin/spatial-objects

## Run on this computer

```bash
cd /home/ANT/unclockable-knighthacks-2026/spatial-objects
npm run setup:linux
npm run remote
```

The second command prints a **LIVE PHONE LINK** and creates `live-qr.png`. Open that link or scan the QR on the Motorola, then tap **Start camera**. Keep the terminal running. Each run creates a fresh relay channel and encryption key embedded in the link; they are not committed to the repository.

The app also works without the computer server when served from HTTPS: MediaPipe detects objects live on the phone and **Scan frame** estimates depth on a captured frame. Remote mode is recommended for continuous object and depth updates.

For local development, `npm start` serves `dist/` at `http://127.0.0.1:8791/?token=...` with a direct WebSocket instead of the relay (browser on the same computer only — the server binds to localhost).

## Use

- **RGB** shows computer-processed object boxes as results arrive.
- **Depth** and **Mesh** display the latest complete depth frame. Their boxes and tap targets come from that exact frame, so the overlays remain aligned even while the camera moves.
- Tap a highlighted object or just outside its box to hold that frame and open its actions. Tap **Continue live scan** to resume.
- If no object is detected, change the angle or lighting. The detector recognizes the 80 classes in its model metadata, not arbitrary items.

## How it works

The computer server runs a [YOLOv8 Nano ONNX model](https://huggingface.co/webml/yolov8n) for object detection and a quantized [Depth Anything V2 Small model](https://huggingface.co/onnx-community/depth-anything-v2-small) for relative depth. `model-labels.json` was generated from the YOLO model metadata. Object results return as soon as they are ready; depth runs separately on sampled frames. Frames are processed in memory and are not stored by this app.

The phone page is hosted on GitHub Pages from `dist/` on the `gh-pages` branch. The phone publishes resized JPEG frames to `spatial/<session>/frames` and reads results from `spatial/<session>/results` on a public MQTT-over-WebSocket broker (`demo.tbmq.io`, port 443 — usable where outbound tunnel ports are blocked). Every message is AES-GCM encrypted with a key that exists only in the phone link and the server process, so the relay never sees plaintext frames. Results reference the frame by id rather than re-sending the image, which keeps relay traffic near the upload size.

The depth map is an estimate from one RGB image. It is not metric distance, physical surface reconstruction, ARCore tracking, or a persistent 3D anchor. The triangular mesh is a depth-colored 2D visualization.

## Update the public site

```bash
npm run deploy:site
```

Syncs `dist/` from the root UI files, commits, pushes `main`, publishes `dist/` to the `gh-pages` branch, and enables GitHub Pages on the repo.

## Files

- `app.js`, `index.html`, `style.css`: phone UI; `dist/` is the served copy and also carries `mqtt.min.js` and `.nojekyll`.
- `server.mjs`: local HTTP/WebSocket/MQTT inference server.
- `relay-crypto.mjs`: AES-GCM helpers shared with the phone-side code.
- `scripts/setup-linux.sh`: downloads dependencies and the 12.8 MB detector.
- `scripts/start-remote.mjs`: starts the server, creates the relay session, prints the live link and QR.
- `scripts/deploy-site.sh`: syncs `dist/` and publishes it to GitHub Pages.

The YOLO model's metadata reports an [AGPL-3.0 license](https://github.com/ultralytics/ultralytics/blob/main/LICENSE). Check that license before distributing a modified service.
