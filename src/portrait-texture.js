import * as THREE from 'three';

// Broad anatomical anchors avoid tiny or collapsed triangles around the
// generated eyelids. Iris centers are deliberately not used for closed eyes.
const ANCHORS = [
  10, 33, 133, 362, 263, 1, 4, 61, 291, 13, 152, 234,
  454, 70, 300, 9, 168, 172, 397, 127, 356, 93, 323, 175,
];
const FACE_OVAL = [
  10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288,
  397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136,
  172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109,
];
const activeEnhancements = new WeakMap();

/**
 * Project the original photograph onto the front facial surface of a real
 * GLB. The mapping is fixed in model coordinates; moving the viewing camera
 * never changes it. Geometry and generated textures on the sides/back remain.
 *
 * modelLandmarks must come from a +Z orthographic render spanning [-.55,.55]
 * horizontally and vertically. Both landmark arrays use MediaPipe's 478-point
 * ordering. referenceLandmarks are normalized to the original photograph.
 *
 * Returns { enabled, strength, stats, dispose() }. Call dispose() before
 * disposing/replacing the model. This runtime shader is not baked into GLB.
 */
export function enhancePortraitFace(model, photoTexture, referenceLandmarks, modelLandmarks) {
  if (!model?.isObject3D) throw new TypeError('Portrait enhancement requires a loaded Three.js model.');
  if (!photoTexture?.isTexture) throw new TypeError('Portrait enhancement requires the original photograph texture.');
  validateLandmarks(referenceLandmarks, 'Original photograph');
  validateLandmarks(modelLandmarks, 'Model render');

  const target = modelLandmarks.map(point => ({ x: (point.x - .5) * 1.1, y: (.5 - point.y) * 1.1 }));
  const source = referenceLandmarks.map(point => ({ x: point.x, y: 1 - point.y }));
  const targetOval = FACE_OVAL.map(index => target[index]);
  const sourceOval = FACE_OVAL.map(index => source[index]);
  const targetBounds = boundsOf(targetOval);
  const sourceBounds = boundsOf(sourceOval);
  const targetFeather = (targetBounds.maxX - targetBounds.minX) * .055;
  const sourceFeather = (sourceBounds.maxX - sourceBounds.minX) * .055;
  const warp = createThinPlateWarp(target, source, ANCHORS, targetBounds);

  // Restoring an existing controller first avoids stacking shader hooks and
  // allocating repeated geometry copies if the reference is recalibrated.
  activeEnhancements.get(model)?.dispose();
  model.updateWorldMatrix(true, true);
  const toModel = new THREE.Matrix4().copy(model.matrixWorld).invert();
  const weightUniform = { value: 1 };
  const photoUniform = { value: photoTexture };
  const records = [];
  let weightedVertices = 0;
  let maximumWeight = 0;

  try {
    model.traverse(mesh => {
      if (!mesh.isMesh) return;
      const originalMaterials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      if (!originalMaterials.some(material => material?.isMeshStandardMaterial)) return;
      const position = mesh.geometry?.attributes.position;
      const normal = mesh.geometry?.attributes.normal;
      if (!position || !normal) throw new Error('The portrait mesh needs position and normal attributes.');

      const localToModel = new THREE.Matrix4().multiplyMatrices(toModel, mesh.matrixWorld);
      const normalToModel = new THREE.Matrix3().getNormalMatrix(localToModel);
      const point = new THREE.Vector3();
      const direction = new THREE.Vector3();
      const uvs = new Float32Array(position.count * 2);
      const weights = new Float32Array(position.count);
      let meshWeights = 0;

      for (let i = 0; i < position.count; i++) {
        point.fromBufferAttribute(position, i).applyMatrix4(localToModel);
        if (point.x < targetBounds.minX || point.x > targetBounds.maxX
          || point.y < targetBounds.minY || point.y > targetBounds.maxY) continue;
        // This GLB's front faces +Z. Both gates are fixed in object space, so
        // looking around it never projects the photograph onto its rear.
        direction.fromBufferAttribute(normal, i).applyMatrix3(normalToModel).normalize();
        const frontWeight = smoothstep(.2, .65, direction.z) * smoothstep(.035, .105, point.z);
        if (frontWeight <= 0) continue;
        const targetDistance = interiorEdgeDistance(point, targetOval);
        if (targetDistance <= 0) continue;
        const uv = warp(point.x, point.y);
        if (!Number.isFinite(uv.x) || !Number.isFinite(uv.y)
          || uv.x < 0 || uv.x > 1 || uv.y < 0 || uv.y > 1) continue;
        const sourceDistance = interiorEdgeDistance(uv, sourceOval);
        if (sourceDistance <= 0) continue;
        const weight = frontWeight * Math.min(
          smoothstep(0, targetFeather, targetDistance),
          smoothstep(0, sourceFeather, sourceDistance),
        );
        uvs[i * 2] = uv.x;
        uvs[i * 2 + 1] = uv.y;
        weights[i] = weight;
        if (weight > .001) meshWeights++;
        maximumWeight = Math.max(maximumWeight, weight);
      }

      if (!meshWeights) return;
      const geometry = mesh.geometry.clone();
      geometry.setAttribute('portraitUv', new THREE.BufferAttribute(uvs, 2));
      geometry.setAttribute('portraitWeight', new THREE.BufferAttribute(weights, 1));
      const createdMaterials = [];
      const materials = originalMaterials.map(original => {
        if (!original?.isMeshStandardMaterial) return original;
        const material = original.clone();
        material.name = `${original.name || 'Portrait PBR'} — original face projection`;
        material.onBeforeCompile = (shader, renderer) => {
          original.onBeforeCompile.call(material, shader, renderer);
          if (!shader.vertexShader.includes('#include <begin_vertex>')
            || !shader.fragmentShader.includes('#include <opaque_fragment>')) {
            throw new Error('This material shader cannot accept the portrait projection.');
          }
          shader.uniforms.portraitPhoto = photoUniform;
          shader.uniforms.portraitStrength = weightUniform;
          shader.vertexShader = `attribute vec2 portraitUv;
attribute float portraitWeight;
varying vec2 vPortraitUv;
varying float vPortraitWeight;
${shader.vertexShader}`.replace('#include <begin_vertex>', `#include <begin_vertex>
// Weight UVs too, so masked-out vertices cannot pull a boundary sample
// toward their unused (0,0) coordinates during interpolation.
vPortraitUv = portraitUv * portraitWeight;
vPortraitWeight = portraitWeight;`);
          shader.fragmentShader = `uniform sampler2D portraitPhoto;
uniform float portraitStrength;
varying vec2 vPortraitUv;
varying float vPortraitWeight;
${shader.fragmentShader}`.replace('#include <opaque_fragment>', `
float portraitBlend = clamp(vPortraitWeight * portraitStrength, 0.0, 1.0);
if (portraitBlend > 0.0001) {
  vec2 portraitSampleUv = vPortraitUv / max(vPortraitWeight, 0.00001);
  vec4 portraitColor = texture2D(portraitPhoto, clamp(portraitSampleUv, vec2(0.0), vec2(1.0)));
  // The source photograph already contains its lighting. Blend before the
  // renderer's final output conversion rather than lighting the photo twice.
  outgoingLight = mix(outgoingLight, portraitColor.rgb, portraitBlend * portraitColor.a);
}
#include <opaque_fragment>`);
        };
        material.customProgramCacheKey = () => `${original.customProgramCacheKey()}|booyah-portrait-tps-v1`;
        createdMaterials.push(material);
        return material;
      });
      records.push({
        mesh, originalGeometry: mesh.geometry, originalMaterial: mesh.material,
        geometry, material: Array.isArray(mesh.material) ? materials : materials[0], createdMaterials,
      });
      weightedVertices += meshWeights;
    });
    if (!records.length || !weightedVertices) {
      throw new Error('No front facial surface matched the model landmarks. Check the +Z orthographic reference and model orientation.');
    }
  } catch (error) {
    for (const record of records) {
      record.geometry.dispose();
      record.createdMaterials.forEach(material => material.dispose());
    }
    throw error;
  }

  for (const record of records) {
    record.mesh.geometry = record.geometry;
    record.mesh.material = record.material;
  }
  let strength = 1;
  let enabled = true;
  let disposed = false;
  const controller = {
    stats: { meshes: records.length, weightedVertices, maximumWeight, anchors: warp.anchorCount },
    get strength() { return strength; },
    set strength(value) {
      if (!Number.isFinite(value)) throw new TypeError('Portrait strength must be a finite number.');
      strength = THREE.MathUtils.clamp(value, 0, 1);
      weightUniform.value = enabled ? strength : 0;
    },
    get enabled() { return enabled; },
    set enabled(value) { enabled = !!value; weightUniform.value = enabled ? strength : 0; },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const record of records) {
        if (record.mesh.geometry === record.geometry) record.mesh.geometry = record.originalGeometry;
        if (record.mesh.material === record.material) record.mesh.material = record.originalMaterial;
        record.geometry.dispose();
        record.createdMaterials.forEach(material => material.dispose());
      }
      activeEnhancements.delete(model);
    },
  };
  activeEnhancements.set(model, controller);
  return controller;
}

function validateLandmarks(landmarks, label) {
  if (!Array.isArray(landmarks) || landmarks.length < 478
    || landmarks.slice(0, 478).some(point => !Number.isFinite(point?.x) || !Number.isFinite(point?.y))) {
    throw new Error(`${label} must provide all 478 finite MediaPipe face landmarks.`);
  }
}

function boundsOf(points) {
  const bounds = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
  for (const point of points) {
    bounds.minX = Math.min(bounds.minX, point.x); bounds.maxX = Math.max(bounds.maxX, point.x);
    bounds.minY = Math.min(bounds.minY, point.y); bounds.maxY = Math.max(bounds.maxY, point.y);
  }
  return bounds;
}

function smoothstep(minimum, maximum, value) {
  const t = THREE.MathUtils.clamp((value - minimum) / (maximum - minimum), 0, 1);
  return t * t * (3 - 2 * t);
}

// Returns zero outside the polygon, otherwise distance to its closest edge.
function interiorEdgeDistance(point, polygon) {
  let inside = false;
  let distanceSquared = Infinity;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[j], b = polygon[i];
    if ((a.y > point.y) !== (b.y > point.y)
      && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
    const dx = b.x - a.x, dy = b.y - a.y;
    const lengthSquared = dx * dx + dy * dy;
    const t = lengthSquared ? THREE.MathUtils.clamp(((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared, 0, 1) : 0;
    distanceSquared = Math.min(distanceSquared, (point.x - a.x - t * dx) ** 2 + (point.y - a.y - t * dy) ** 2);
  }
  return inside ? Math.sqrt(distanceSquared) : 0;
}

function radialBasis(distanceSquared) {
  return distanceSquared > 1e-14 ? distanceSquared * Math.log(distanceSquared) : 0;
}

function createThinPlateWarp(target, source, indices, bounds) {
  const span = Math.max(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY);
  if (!Number.isFinite(span) || span < 1e-5) throw new Error('The model face landmarks have no usable extent.');
  const centerX = (bounds.minX + bounds.maxX) / 2;
  const centerY = (bounds.minY + bounds.maxY) / 2;
  const anchors = [];
  for (const index of indices) {
    const x = (target[index].x - centerX) / span;
    const y = (target[index].y - centerY) / span;
    if (anchors.some(point => (point.x - x) ** 2 + (point.y - y) ** 2 < 1e-8)) continue;
    anchors.push({ x, y, u: source[index].x, v: source[index].y });
  }
  if (anchors.length < 6) throw new Error('Too few distinct facial anchors are available for the portrait projection.');
  const count = anchors.length;
  const size = count + 3;
  const matrix = Array.from({ length: size }, () => new Float64Array(size + 2));
  for (let row = 0; row < count; row++) {
    const a = anchors[row];
    for (let col = 0; col < count; col++) {
      const b = anchors[col];
      matrix[row][col] = radialBasis((a.x - b.x) ** 2 + (a.y - b.y) ** 2);
    }
    matrix[row][row] += 1e-5;
    matrix[row][count] = matrix[count][row] = 1;
    matrix[row][count + 1] = matrix[count + 1][row] = a.x;
    matrix[row][count + 2] = matrix[count + 2][row] = a.y;
    matrix[row][size] = a.u;
    matrix[row][size + 1] = a.v;
  }
  solveAugmented(matrix, size);
  const warp = (x, y) => {
    x = (x - centerX) / span;
    y = (y - centerY) / span;
    let u = matrix[count][size] + matrix[count + 1][size] * x + matrix[count + 2][size] * y;
    let v = matrix[count][size + 1] + matrix[count + 1][size + 1] * x + matrix[count + 2][size + 1] * y;
    for (let i = 0; i < count; i++) {
      const basis = radialBasis((x - anchors[i].x) ** 2 + (y - anchors[i].y) ** 2);
      u += matrix[i][size] * basis;
      v += matrix[i][size + 1] * basis;
    }
    return { x: u, y: v };
  };
  warp.anchorCount = count;
  return warp;
}

// Partial-pivot Gaussian elimination, solving both UV components together.
function solveAugmented(matrix, size) {
  for (let col = 0; col < size; col++) {
    let pivot = col;
    for (let row = col + 1; row < size; row++) {
      if (Math.abs(matrix[row][col]) > Math.abs(matrix[pivot][col])) pivot = row;
    }
    if (Math.abs(matrix[pivot][col]) < 1e-12) throw new Error('The facial anchor layout is degenerate; portrait calibration cannot be solved.');
    [matrix[col], matrix[pivot]] = [matrix[pivot], matrix[col]];
    const divisor = matrix[col][col];
    for (let j = col; j < size + 2; j++) matrix[col][j] /= divisor;
    for (let row = 0; row < size; row++) {
      if (row === col) continue;
      const factor = matrix[row][col];
      for (let j = col; j < size + 2; j++) matrix[row][j] -= factor * matrix[col][j];
    }
  }
}
