import { Vector3 } from 'three';
import { frameCorners } from 'three/addons/utils/CameraUtils.js';

const bottomLeft = new Vector3();
const bottomRight = new Vector3();
const topLeft = new Vector3();
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

function validSample(sample) {
  return sample != null
    && Number.isFinite(sample.centerX)
    && Number.isFinite(sample.centerY)
    && Number.isFinite(sample.eyeDistance)
    && sample.eyeDistance > 0
    && Number.isFinite(sample.aspect)
    && sample.aspect > 0;
}

/**
 * Estimate the eye midpoint in meters relative to a calibrated screen center.
 * Input coordinates are from the original, unmirrored camera image. Depth is
 * approximate: changes in apparent pupil separation also depend on head yaw.
 */
export function estimateEye(sample, baseline, options = {}) {
  const {
    distance: requestedDistance = 0.65,
    gain: requestedGain = 1,
    ipd: requestedIpd = 0.063,
  } = options ?? {};
  const distance = Number.isFinite(requestedDistance) && requestedDistance > 0
    ? clamp(requestedDistance, 0.25, 1.5) : 0.65;
  const gain = Number.isFinite(requestedGain) && requestedGain >= 0
    ? requestedGain : 1;
  const ipd = Number.isFinite(requestedIpd) && requestedIpd > 0
    ? requestedIpd : 0.063;

  if (!validSample(sample) || !validSample(baseline)) {
    return { x: 0, y: 0, z: distance };
  }

  const depth = clamp(distance * baseline.eyeDistance / sample.eyeDistance, 0.25, 1.5);
  // Unproject each eye midpoint at its own depth before subtracting the
  // calibrated position. Subtracting image coordinates first would turn a
  // straight approach into lateral motion when the webcam is off-center.
  // The image center approximates the webcam's optical principal point.
  const x = ipd * ((baseline.centerX - .5) / baseline.eyeDistance
    - (sample.centerX - .5) / sample.eyeDistance) * gain;
  const y = ipd * ((baseline.centerY - .5) / (baseline.eyeDistance * baseline.aspect)
    - (sample.centerY - .5) / (sample.eyeDistance * sample.aspect)) * gain;
  const z = distance + (depth - distance) * gain;

  // Reject arithmetic overflow or degenerate measurements before they reach
  // the camera matrices. A lost measurement returns to the calibrated center.
  if (![x, y, z].every(Number.isFinite)) return { x: 0, y: 0, z: distance };

  return {
    x: clamp(x, -0.45, 0.45),
    y: clamp(y, -0.3, 0.3),
    z: clamp(z, 0.25, 1.5),
  };
}

/**
 * Treat the canvas as a fixed window at z=0, with content behind it at z<0.
 * Width, height, and eye position must share the same physical units.
 * This replaces the projection matrix: do not call updateProjectionMatrix()
 * or lookAt() afterward, since either would break the window alignment.
 */
export function applyOffAxis(camera, width, height, eye) {
  if (!camera?.isPerspectiveCamera) throw new TypeError('A PerspectiveCamera is required.');
  if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) {
    throw new RangeError('Screen dimensions must be finite and positive.');
  }
  if (!eye || ![eye.x, eye.y, eye.z].every(Number.isFinite) || eye.z <= 0) {
    throw new RangeError('The eye must have finite coordinates in front of the screen.');
  }

  bottomLeft.set(-width / 2, -height / 2, 0);
  bottomRight.set(width / 2, -height / 2, 0);
  topLeft.set(-width / 2, height / 2, 0);
  camera.position.set(eye.x, eye.y, eye.z);
  frameCorners(camera, bottomLeft, bottomRight, topLeft);
  camera.updateMatrixWorld(true);
  return camera;
}
