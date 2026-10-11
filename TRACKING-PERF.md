# Webcam → glove tracking: latency notes

Measured on ANT's machine (i7-13620H, Intel RPL-P iGPU, RTX 4070 dead in-driver,
Chromium, real webcam @ 640×480/30fps):

| stage | before | now |
|---|---|---|
| camera request | 1280×720 | 640×480 |
| hand infer delegate | CPU (weakGpu hint) | GPU worker |
| inferMs, 0 hands | ~37ms | ~15ms |
| inferMs, 1 hand | — | ~20ms |
| trackHz vs cameraHz | ~15/s vs 30/s | ~30/s ≈ 1:1 |
| drawn pose | EMA .72 + extrapolation | latest measured pose, 1:1 |
| HUD label | `60 fps` (render only) | `cam N/s · track N/s · Nms · render N fps` |

End-to-end motion→pixel latency is now ~35ms — inference (~20ms) + up to one
render frame (~16ms). The rest is the webcam's own sensor/USB latency, which
software cannot remove.

## Root causes that were fixed

1. `VideoFrame` resize hint ignored → full 720p frames went to the landmarker.
   Fixed by requesting 640×480 at `getUserMedia` (`boxing.html`) — then HARD-
   enforced in `hands.js`/`face.js` `_send`: sources wider than 640px are
   downscaled via `createImageBitmap` resize before they cross to the worker
   (`ideal` getUserMedia is a hint, not a guarantee — cams without a native
   480p mode deliver 720p+, and `?vid=` files are always full-res. Measured:
   inferMs 149 → ~21, trackHz 11.5 → 44 on a 720p source).
2. `preferCpu: weakGpu` sent hand inference to XNNPACK at ~37ms — half the
   camera's frames were dropped. GPU delegate keeps 30Hz. Hands get the whole
   iGPU; BlazeFace (~4ms) moved to a CPU worker (`boxing.html`, `track-worker.js`).
3. Smoothing layers between result and glove: `hands.js` LERP .72, overlay
   `k=.55/frame` + `lead` extrapolation, `dispReach` EMA — each trailed the real
   hand. All removed; the overlay draws the newest measured pose.
4. Punch/guard velocities were EMA'd against render `dt`; they now use the
   sample interval `dtS` (`fists.js`).
5. Sway chain lag ~400ms (face k .45 → FACE_SMOOTH 8 → SWAY_SMOOTH 9 →
   camSway 8). Tightened to ~180ms (face k .68, SMOOTHs 15, camSway 14).
6. HUD fps counted redraws only — never camera/track rate. Now reports each.

## Re-probe anytime

```bash
node server.mjs                 # PORT=8890 default 8791 — probes use 8890
node test/_probe-e2e.mjs        # real webcam: delegate, cam/track Hz, inferMs
node test/_probe-vid.mjs        # ?vid=/test-input.mp4 path (no hands in file)
```

Status text on the webcam tag tells the truth: if `track` < `cam`, inference
isn't keeping up — check `hands?.stats.inferMs` (needs <33ms at 30fps) and
which `delegate` booted.

## System-level fixes (outside the game)

- **CPU governor → `performance`, persistent**: `cpu-performance.service`
  (systemd, runs at boot) + `99-cpu-performance.rules` (udev, re-asserts on
  every AC plug/unplug event). Works on battery too — intel_pstate still
  downclocks idle cores; it just boosts instantly under load.
  Check: `cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_governor`
- **NVIDIA RTX 4070 wedged**: `NV_ERR_RESET_REQUIRED` in dmesg (driver
  memory-manager assertion). `nvidia-smi --gpu-reset` unsupported on laptop
  GPUs; PCI reset can't take while Hyprland holds `/dev/nvidia0`. Recovers on
  reboot. Chromium already renders on Intel (`renderD128`) — unaffected.
