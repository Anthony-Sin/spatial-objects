#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
npm ci --ignore-scripts
mkdir -p tools
if [[ ! -s tools/yolov8n.onnx ]]; then
  curl -fL --retry 3 'https://huggingface.co/webml/yolov8n/resolve/main/onnx/yolov8n.onnx' -o tools/yolov8n.onnx
fi
echo 'Setup complete. Run: npm run remote'
