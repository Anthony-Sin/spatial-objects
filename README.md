# Spatial Objects

Phone-first browser prototype for detecting real objects and exploring an aligned, relative depth estimate.

Published site: https://spatial-objects-lab.asinchi001.chatgpt.site  
Phone QR: `open-on-phone-qr.png`

## Try it

Open the published HTTPS link on a phone, tap **Start camera**, then **Scan frame**. Tap a detected box for its AI label, confidence, relative depth, and actions. **Depth** and **Mesh** use the exact captured frame, so their pixels remain aligned. **Live camera** resumes object detection. You can also use **Try a photo**.

## Implementation

- MediaPipe EfficientDet Lite0 detects common COCO object categories on the device.
- Transformers.js Depth Anything V2 Small estimates monocular depth on the device after capture. The quantized model download is about 27 MB, plus runtime files. First use can take time.
- Bounding boxes are in camera image coordinates and transformed with the same `contain` mapping as the image. The depth model receives an aspect-preserving resize of that frame and is drawn using the same mapping.
- The Mesh view draws a 2D triangular wireframe whose colors are sampled from estimated depth. It is a visualization of the image, not reconstructed 3D surfaces.
- No object names, boxes, depth values, or object metadata are hardcoded. The depth color palette and UI text are fixed presentation choices.
- Pins attach to the captured image coordinates. They do not persist in 3D space or track when the camera moves.

## Limits

Depth is inferred from one RGB image, not a sensor depth map. It has no metric scale and may be inaccurate. This browser build does not perform ARCore world tracking, 3D anchoring, surface mesh reconstruction, or realistic object occlusion. Detector categories are limited to the model's trained classes. Camera access requires HTTPS or localhost. Model files are fetched from Google, jsDelivr, and Hugging Face when first used.
