import './style.css';
import { PerspectiveScene } from './scene.js';
import { FaceTracker } from './tracker.js';
import { estimateEye } from './perspective.js';

const $ = (id) => document.getElementById(id);
const settings = { distance: 1, gain: 1, smoothing: 20, width: .35 };
let scene, baseline = null, latestSample = null, status = 'stopped', wantsCamera = false;
let target = { x: 0, y: 0, z: settings.distance }, eye = { ...target };
let calibrationSamples = [];
let toastTimer;

function message(text, isError = false, duration = 4500) {
  const toast = $('status-message');
  clearTimeout(toastTimer);
  toast.textContent = text;
  toast.classList.toggle('error', isError);
  toast.hidden = !text;
  if (text && duration > 0) toastTimer = setTimeout(() => { toast.hidden = true; }, duration);
}

try {
  scene = new PerspectiveScene($('scene'), {
    centralModelUrl: `${import.meta.env.BASE_URL}models/central-person.glb`, enhanceFace: true,
    screenWidth: settings.width, viewDistance: settings.distance,
  });
  scene.ready?.catch((error) => { message(error.message || 'The scene could not load. Please reload.', true, 12000); });
} catch (error) {
  $('scene-error').hidden = false;
  $('scene-error').textContent = 'The 3D view needs WebGL 2. Try Chrome or Edge with graphics acceleration enabled.';
  console.error(error);
}

function cameraState(state) {
  status = state.status;
  const button = $('camera-toggle');
  button.dataset.state = status;
  if (status === 'error' || status === 'stopped') {
    wantsCamera = false;
    baseline = null;
    latestSample = null;
    calibrationSamples = [];
    target = { x: 0, y: 0, z: settings.distance };
  }
  button.setAttribute('aria-pressed', String(wantsCamera));
  $('camera-preview').hidden = !wantsCamera || !$('webcam').srcObject || $('webcam').readyState < 2;
  button.querySelector('span').textContent = wantsCamera
    ? (status === 'loading' ? 'Cancel head tracking' : 'Disable head tracking')
    : 'Enable head tracking';
  if (status === 'searching') {
    latestSample = null;
    if (!baseline) calibrationSamples = [];
    target = { x: 0, y: 0, z: settings.distance };
  }
  if (status === 'tracking') {
    if (baseline) message('');
  } else {
    message(state.message, status === 'error', status === 'error' ? 12000 : 5000);
  }
}

function beginCalibration() {
  baseline = null;
  calibrationSamples = [];
  target = { x: 0, y: 0, z: settings.distance };
  message('Sit centered in front of the scene, then hold still to recenter.', false, 5000);
}

const tracker = new FaceTracker({
  video: $('webcam'),
  onState: cameraState,
  onSample: (sample) => {
    latestSample = sample;
    if (!baseline) {
      if (calibrationSamples.length === 0) message('Sit centered in front of the scene, then hold still to recenter.');
      calibrationSamples.push(sample);
      if (calibrationSamples.length < 15) return;
      baseline = { ...sample };
      for (const key of ['centerX', 'centerY', 'eyeDistance']) {
        baseline[key] = calibrationSamples.reduce((sum, item) => sum + item[key], 0) / calibrationSamples.length;
      }
      calibrationSamples = [];
      message('Centered.', false, 1800);
    }
    target = estimateEye(sample, baseline, settings);
  },
});

async function startTracking() {
  if (wantsCamera) return;
  wantsCamera = true;
  baseline = null;
  latestSample = null;
  calibrationSamples = [];
  const permissionHint = setTimeout(() => {
    if (wantsCamera && status === 'loading' && !$('webcam').srcObject) {
      message('Allow camera access in the browser. If no prompt appears here, open this page in Chrome or Edge.', false, 12000);
    }
  }, 8000);
  await tracker.start();
  clearTimeout(permissionHint);
}

$('camera-toggle').addEventListener('click', () => {
  if (wantsCamera) tracker.stop();
  else startTracking();
});

const trackingPrompt = $('tracking-prompt');
$('prompt-enable').addEventListener('click', () => {
  trackingPrompt.close();
  startTracking();
});
$('prompt-skip').addEventListener('click', () => trackingPrompt.close());
trackingPrompt.addEventListener('close', () => $('camera-toggle').focus({ preventScroll: true }));
if (scene) trackingPrompt.showModal();

$('reset-view').addEventListener('click', () => {
  target = { x: 0, y: 0, z: settings.distance };
  if (wantsCamera && latestSample) beginCalibration();
});
$('gain').addEventListener('input', (event) => {
  settings.gain = Number(event.target.value);
  $('gain-output').textContent = `${settings.gain.toFixed(1)}×`;
});
$('smoothing').addEventListener('input', (event) => {
  settings.smoothing = Number(event.target.value);
  $('smoothing-output').textContent = `${settings.smoothing}%`;
});
for (const [id, key] of [['distance', 'distance'], ['screen-width', 'width']]) {
  $(id).addEventListener('input', (event) => {
    const input = event.target;
    const value = Number(input.value);
    if (!Number.isFinite(value) || value < Number(input.min) || value > Number(input.max)) return;
    settings[key] = value / 100;
    $(`${id}-output`).textContent = `${value} cm`;
    if (key === 'width') scene?.setWidth(settings.width);
    else target.z = settings.distance;
  });
  $(id).addEventListener('change', () => {
    if (key === 'distance' && wantsCamera) beginCalibration();
  });
}

$('scene').addEventListener('pointermove', (event) => {
  if (wantsCamera) return;
  const rect = $('scene').getBoundingClientRect();
  target = {
    x: ((event.clientX - rect.left) / rect.width - .5) * .28 * settings.gain,
    y: (.5 - (event.clientY - rect.top) / rect.height) * .20 * settings.gain,
    z: settings.distance,
  };
});
$('scene').addEventListener('pointerleave', () => {
  if (!wantsCamera) target = { x: 0, y: 0, z: settings.distance };
});
$('fullscreen').addEventListener('click', async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await $('stage-shell').requestFullscreen();
  } catch {
    message('Full screen is unavailable in this browser panel. Open this page in Chrome or Edge.');
  }
});
document.addEventListener('fullscreenchange', () => {
  const label = document.fullscreenElement ? 'Exit full screen' : 'Enter full screen';
  $('fullscreen').setAttribute('aria-label', label);
  $('fullscreen').title = label;
});

let loadingModel = false;
async function loadModel(file) {
  if (!file || !scene || loadingModel) return;
  loadingModel = true;
  message('Loading model…', false, 0);
  try {
    await scene.loadModel(file);
    message('Model ready.');
  } catch (error) {
    message(error.message || 'The model could not load.', true, 10000);
  } finally {
    loadingModel = false;
    $('model-file').value = '';
  }
}
$('model-file').addEventListener('change', (event) => loadModel(event.target.files[0]));
const shell = $('stage-shell');
shell.addEventListener('dragover', (event) => {
  if (!event.dataTransfer.types.includes('Files')) return;
  event.preventDefault();
  $('drop-overlay').classList.add('visible');
});
shell.addEventListener('dragleave', (event) => {
  if (!shell.contains(event.relatedTarget)) $('drop-overlay').classList.remove('visible');
});
shell.addEventListener('drop', (event) => {
  event.preventDefault();
  $('drop-overlay').classList.remove('visible');
  loadModel(event.dataTransfer.files[0]);
});
window.addEventListener('pagehide', () => tracker.stop());

let previous = performance.now();
function animate(now) {
  const dt = Math.min((now - previous) / 1000, .1);
  previous = now;
  const timeConstant = .018 + settings.smoothing / 100 * .20;
  const alpha = 1 - Math.exp(-dt / timeConstant);
  for (const axis of ['x', 'y', 'z']) eye[axis] += (target[axis] - eye[axis]) * alpha;
  scene?.render(eye);
  requestAnimationFrame(animate);
}
requestAnimationFrame(animate);
