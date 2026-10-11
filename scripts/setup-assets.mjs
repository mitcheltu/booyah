import { mkdir, cp, stat, writeFile } from 'node:fs/promises';
const modelUrl = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';
await mkdir('public/models', { recursive: true });
await cp('node_modules/@mediapipe/tasks-vision/wasm', 'public/wasm', { recursive: true });
let modelExists = false;
try { modelExists = (await stat('public/models/face_landmarker.task')).size > 1000000; } catch {}
if (!modelExists) {
  const response = await fetch(modelUrl);
  if (!response.ok) throw new Error(`Model download failed: ${response.status}`);
  await writeFile('public/models/face_landmarker.task', Buffer.from(await response.arrayBuffer()));
}
console.log('Face model and WebAssembly assets are ready locally.');
