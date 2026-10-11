# Booyah

A browser-native scene that changes its perspective as you move your head. Camera frames are processed on the device with MediaPipe Face Landmarker. Three.js renders a fixed screen aperture using an off-axis projection, creating motion parallax for one viewer.

The default scene now contains a **volumetric 3D model of the central person**, with front, side, and back geometry generated using Microsoft TRELLIS.2. The room has separate reconstructed walls, window frames, glass, and plant geometry; the secondary person remains a photo relief. The room's opening is fixed to the four screen corners, with walls, ceiling, and floor receding behind it. It adapts to resizing and fullscreen. The page title is **Booyah**, and the scene fills the screen with the tracking button, sliders, camera preview, reset, and fullscreen controls.

The original `IMG_6660.PNG` is retained. At runtime, `src/portrait-texture.js` projects its face onto the front facial surface using 24 stable anchors from matching 478-point landmark sets. This improves the front likeness while the sides and back retain generated textures. The projection is fixed to the model as the viewer moves. It is an application material effect, **not baked into the downloadable GLB**.

The model is an upper-body bust with inferred sides and back. The app extends its cropped lower mesh below the viewport for the scene presentation; the downloaded asset retains the original bust geometry. A single photograph cannot establish accurate unseen anatomy or appearance, and this reconstruction does not guarantee photorealistic identity from every angle. Additional side and rear reference photographs would be needed to improve those views.

## Run

Published site: [mitcheltu.github.io/booyah](https://mitcheltu.github.io/booyah/).

Requires Node.js 22.12 or newer.

```powershell
npm install
npm run setup:assets
npm run dev
```

Open [Booyah](http://127.0.0.1:5173/) in Chrome or Edge. Each page load asks whether to enable head tracking. Choose **Enable head tracking** and allow camera access, or **Not now** to explore with the pointer. You can also dismiss the prompt with Escape and enable tracking later using the upper-right button. The camera is only requested after you choose to enable it. If the embedded browser does not show a camera prompt, use a regular browser.

Sit with your eyes centered in front of the visible scene and hold still for the initial calibration (15 tracked frames). Lean gently left/right or up/down, or move closer/farther away. Use the **reset** icon at the lower right to return to the centered view and recalibrate while tracking. The adjacent **fullscreen** icon enters or exits fullscreen.

The display is the open face of a rectangular box extending 57 cm behind it. Opposing walls are parallel; the back wall has the same physical width and height as the opening. Its smaller apparent size comes entirely from perspective. Window frames are straight solids, and the window and plant keep their proportions when fitted into different viewport shapes.

The four sliders below the tracking button control:

- **Movement:** head or pointer movement sensitivity.
- **Smoothing:** the balance between responsiveness and steadiness.
- **Distance:** your eye-to-screen distance in centimeters. Changing it while tracking starts a new calibration.
- **View width:** the measured physical width of the visible scene in centimeters, excluding browser sidebars.

For the box to align with your real viewpoint, measure **View width** and eye-to-screen **Distance**, keep **Movement** at **1.0×**, then reset while centered. Recheck the visible width after changing the browser window or entering fullscreen. The defaults are 48 cm wide and 65 cm away; the browser cannot determine these physical measurements. Smoothing defaults to 20% to reduce the delay during movement.

While the camera is running, a small mirrored live preview appears in the bottom-left corner, including in fullscreen. It shows the entire camera frame. Click **Disable head tracking** to release the camera and hide the preview. Connection and error messages appear briefly when needed.

This is a perspective illusion, not a stereoscopic display or gaze tracker. Translating your head produces the strongest effect. Depth is estimated from apparent pupil separation using a nominal 63 mm pupil distance. Turning your face strongly can affect that estimate. Best results use one viewer, good lighting, and a webcam above the display.

## Your model

Drop a self-contained `.glb` into the scene (up to 100 MB) to replace the portrait subjects with your own model. The room stays visible, and the model is fit and centered automatically. The current model stays in place if a replacement fails. Files are processed locally; external texture/buffer URLs are blocked. Reload the page to return to the default character scene.

Uncompressed GLB is supported. Draco or KTX2 compressed assets need additional decoders and should be exported without those compressions for this version. Model animation is not played. Uploaded models are not persisted on refresh.

The generated asset is [central-person.glb](public/models/central-person.glb), served at [the local model URL](http://127.0.0.1:5173/models/central-person.glb). It contains 279,958 triangles and two embedded 4096 × 4096 PBR textures. [central-person-metadata.json](public/models/central-person-metadata.json) records the source input, TRELLIS.2 generation settings, asset hash, geometry checks, and limitations. It is a hollow surface mesh with a few non-manifold joins, not a certified printable solid.

For a separate 360-degree inspection, open [the character review page](http://127.0.0.1:5173/qa/character-review.html?model=/models/central-person.glb&portrait=1). It shows the original photograph alongside the model with front, side, and back presets, orbit controls, and textured, shaded, and wireframe views. The `portrait=1` option applies the original-face material; remove that option to inspect the raw generated textures. This QA page is separate from the minimal main interface.

## Checks

```powershell
npm test
npm run build
```

The Node tests check screen-corner invariance under head movement, projection inversion, parallax direction, calibration, depth, axis signs, and invalid tracking inputs. They also inspect the actual character GLB for finite attributes, head and torso depth, topology, embedded texture dimensions, and correspondence with its metadata. Development fixtures at `/qa/vision.html`, `/qa/face.html`, and `/qa/model.html` check model initialization, blank-frame inference, all 478 landmarks on the official MediaPipe test portrait, and local GLB loading/restoration. The QA fixtures are not included in the production build.

The app serves MediaPipe model and WASM files from `public/` after setup. The interface uses system fonts and does not request Google Fonts. Camera tracking runs locally: this application does not record or upload camera frames and has no analytics. Camera access requires localhost or HTTPS. Character generation was a separate cloud operation using TRELLIS.2 on Hugging Face with the user's consent; running the completed scene does not repeat that upload or require a cloud generation service.

No Blender installation or other modeling application is required to run Booyah. Node.js and a supported browser are sufficient; the character model, photograph, and tracking assets are served locally.

## GitHub Pages

Commits to `main` run `.github/workflows/pages.yml`: install the locked dependencies, prepare MediaPipe's local model and WASM files, run tests, build, and deploy `dist/` to GitHub Pages. The repository's Pages source must be **GitHub Actions**. Generated tracking assets, build output, and local screenshots are excluded from Git.

Production assets use the `/booyah/` base path. Local development continues at `/`; `npm run preview` serves the production build at `http://127.0.0.1:4173/booyah/`. The Pages site uses HTTPS, so supported browsers can request camera access. Camera video stays in the browser.

## Sources

- Concept reference: https://github.com/ndaneil/interactive-3d-screen — valid Python/PySide6/OpenGL demo that depends on AMD Ryzen AI; it is not a browser application. This implementation does not copy its source.
- Rendering: https://github.com/mrdoob/three.js (MIT).
- Face tracking: https://github.com/google-ai-edge/mediapipe (Apache-2.0).
- Tracker API: https://ai.google.dev/edge/mediapipe/solutions/vision/face_landmarker/web_js
- Off-axis projection: https://threejs.org/docs/pages/module-CameraUtils.html
- Official face model: https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task

Installed library license notices remain under `node_modules`. The asset setup script copies the matching installed MediaPipe WASM runtime and downloads the official model.
