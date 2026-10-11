import test from 'node:test';
import assert from 'node:assert/strict';
import { PerspectiveCamera, Vector3 } from 'three';
import { applyOffAxis, estimateEye } from '../src/perspective.js';

const baseline = { centerX: 0.5, centerY: 0.45, eyeDistance: 0.12, aspect: 4 / 3 };
const closeTo = (actual, expected, tolerance = 1e-10) => {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} should equal ${expected}`);
};

// Project two physical pupils through a pinhole webcam. Keeping the camera
// model separate from estimateEye catches mistakes when undoing perspective.
function webcamSample({ x, y, z }, { width = 1280, height = 720, focalLength = 900 } = {}) {
  const ipd = .063;
  const project = pupilX => ({
    x: .5 - focalLength * pupilX / z / width,
    y: .5 - focalLength * y / z / height,
  });
  const left = project(x - ipd / 2);
  const right = project(x + ipd / 2);
  return {
    centerX: (left.x + right.x) / 2,
    centerY: (left.y + right.y) / 2,
    eyeDistance: Math.hypot((left.x - right.x) * width, (left.y - right.y) * height) / width,
    aspect: width / height,
  };
}

test('screen corners stay fixed for translated viewpoints and different screen shapes', () => {
  const camera = new PerspectiveCamera(50, 1, 0.01, 10);
  for (const [width, height] of [[0.6, 0.3375], [0.3, 0.5]]) {
    for (const eye of [
      { x: 0, y: 0, z: 0.65 },
      { x: 0.2, y: -0.1, z: 0.4 },
      { x: -0.35, y: 0.15, z: 1.2 },
    ]) {
      applyOffAxis(camera, width, height, eye);
      for (const x of [-1, 1]) {
        for (const y of [-1, 1]) {
          const projected = new Vector3(x * width / 2, y * height / 2, 0).project(camera);
          closeTo(projected.x, x);
          closeTo(projected.y, y);
          assert.ok(projected.z >= -1 && projected.z <= 1);
        }
      }
      const point = new Vector3(0.08, -0.1, -0.4);
      assert.ok(point.clone().project(camera).unproject(camera).distanceTo(point) < 1e-10);
    }
  }
});

test('a point behind the screen shifts toward the moving viewer while the screen stays fixed', () => {
  const camera = new PerspectiveCamera(50, 1, 0.01, 10);
  const projectAt = (x) => {
    applyOffAxis(camera, 0.6, 0.4, { x, y: 0, z: 0.65 });
    closeTo(new Vector3(0, 0, 0).project(camera).x, 0);
    return new Vector3(0, 0, -0.5).project(camera).x;
  };
  const left = projectAt(-0.15);
  const center = projectAt(0);
  const right = projectAt(0.15);
  assert.ok(left < center && center < right);
  closeTo(left, -right);
});

test('calibrated pose is the centered viewpoint at the requested distance', () => {
  assert.deepEqual(estimateEye(baseline, baseline), { x: 0, y: 0, z: 0.65 });
  assert.deepEqual(estimateEye(baseline, baseline, { distance: 0.8 }), { x: 0, y: 0, z: 0.8 });
});

test('unmirrored camera displacement maps to physical screen axes and aspect ratio', () => {
  const sample = { ...baseline, centerX: 0.4, centerY: 0.55 };
  const eye = estimateEye(sample, baseline);
  closeTo(eye.x, 0.0525);
  closeTo(eye.y, -0.039375);
  closeTo(eye.z, 0.65);
  const doubled = estimateEye(sample, baseline, { gain: 2 });
  closeTo(doubled.x, eye.x * 2);
  closeTo(doubled.y, eye.y * 2);
});

test('moving straight toward an off-center webcam does not introduce sideways or vertical drift', () => {
  const calibratedPosition = { x: .08, y: -.12, z: .65 };
  for (const dimensions of [{ width: 640, height: 480 }, { width: 1280, height: 720 }]) {
    const reference = webcamSample(calibratedPosition, dimensions);
    for (const z of [.35, .5, .85, 1.2]) {
      const sample = webcamSample({ ...calibratedPosition, z }, dimensions);
      const eye = estimateEye(sample, reference, { distance: calibratedPosition.z });
      closeTo(eye.x, 0);
      closeTo(eye.y, 0);
      closeTo(eye.z, z);
    }
  }
});

test('combined physical translation is recovered across depth changes and gain settings', () => {
  const calibratedPosition = { x: -.09, y: .1, z: .65 };
  const reference = webcamSample(calibratedPosition);
  for (const movement of [
    { x: .06, y: -.04, z: -.15 },
    { x: -.07, y: .03, z: .45 },
  ]) {
    const sample = webcamSample({
      x: calibratedPosition.x + movement.x,
      y: calibratedPosition.y + movement.y,
      z: calibratedPosition.z + movement.z,
    });
    for (const gain of [0, .5, 1, 1.8]) {
      const eye = estimateEye(sample, reference, { distance: calibratedPosition.z, gain });
      closeTo(eye.x, movement.x * gain);
      closeTo(eye.y, movement.y * gain);
      closeTo(eye.z, calibratedPosition.z + movement.z * gain);
    }
  }
});

test('apparent face size changes depth and gain scales displacement from calibration', () => {
  const nearer = { ...baseline, eyeDistance: 0.16 };
  closeTo(estimateEye(nearer, baseline).z, 0.4875);
  closeTo(estimateEye(nearer, baseline, { gain: 0.5 }).z, 0.56875);
  const farther = { ...baseline, eyeDistance: 0.08 };
  closeTo(estimateEye(farther, baseline).z, 0.975);
  const stationary = estimateEye({ ...farther, centerX: 0.8 }, baseline, { gain: 0 });
  closeTo(stationary.x, 0);
  closeTo(stationary.y, 0);
  closeTo(stationary.z, 0.65);
});

test('extreme valid estimates remain inside safe camera bounds', () => {
  assert.deepEqual(estimateEye({ ...baseline, centerX: 0, centerY: 1, eyeDistance: 0.001 }, baseline), {
    x: 0.45, y: -0.3, z: 1.5,
  });
  closeTo(estimateEye({ ...baseline, eyeDistance: 1 }, baseline, { gain: 4 }).z, 0.25);
});

test('missing, invalid, and overflowing measurements return a finite neutral pose', () => {
  const neutral = { x: 0, y: 0, z: 0.65 };
  for (const sample of [
    null, undefined, {},
    { ...baseline, centerX: NaN },
    { ...baseline, centerY: Infinity },
    { ...baseline, eyeDistance: 0 },
    { ...baseline, eyeDistance: -1 },
    { ...baseline, eyeDistance: Number.MIN_VALUE },
    { ...baseline, aspect: 0 },
  ]) assert.deepEqual(estimateEye(sample, baseline), neutral);
  assert.deepEqual(estimateEye(baseline, null), neutral);
  for (const options of [null, { distance: NaN, gain: Infinity, ipd: -1 }]) {
    const eye = estimateEye(baseline, baseline, options);
    assert.ok(Object.values(eye).every(Number.isFinite));
    closeTo(eye.z, 0.65);
  }
});

test('invalid projection inputs fail before corrupting camera matrices', () => {
  const camera = new PerspectiveCamera();
  const eye = { x: 0, y: 0, z: 0.65 };
  assert.throws(() => applyOffAxis(camera, 0, 0.3, eye), RangeError);
  assert.throws(() => applyOffAxis(camera, 0.5, 0.3, { ...eye, z: 0 }), RangeError);
  assert.throws(() => applyOffAxis(camera, 0.5, 0.3, { ...eye, x: NaN }), RangeError);
});
