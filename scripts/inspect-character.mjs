import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const components = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
const componentTypes = { 5120: ['getInt8', 1], 5121: ['getUint8', 1], 5122: ['getInt16', 2], 5123: ['getUint16', 2], 5125: ['getUint32', 4], 5126: ['getFloat32', 4] };

function ensure(condition, message) { if (!condition) throw new Error(message); }

function webpSize(bytes) {
  ensure(bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP', 'Embedded image is not WebP.');
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const type = bytes.toString('ascii', offset, offset + 4);
    const length = bytes.readUInt32LE(offset + 4);
    const data = offset + 8;
    ensure(data + length <= bytes.length, 'Invalid WebP chunk length.');
    if (type === 'VP8X') return { width: bytes.readUIntLE(data + 4, 3) + 1, height: bytes.readUIntLE(data + 7, 3) + 1 };
    if (type === 'VP8L') {
      ensure(bytes[data] === 0x2f, 'Invalid lossless WebP header.');
      const packed = bytes.readUInt32LE(data + 1);
      return { width: (packed & 0x3fff) + 1, height: ((packed >>> 14) & 0x3fff) + 1 };
    }
    if (type === 'VP8 ') return { width: bytes.readUInt16LE(data + 6) & 0x3fff, height: bytes.readUInt16LE(data + 8) & 0x3fff };
    offset = data + length + (length % 2);
  }
  throw new Error('WebP has no image dimensions.');
}

export function inspectCharacterBuffer(bytes) {
  ensure(bytes.readUInt32LE(0) === 0x46546c67 && bytes.readUInt32LE(4) === 2, 'Expected GLB version 2.');
  ensure(bytes.readUInt32LE(8) === bytes.length, 'GLB length does not match its header.');
  const jsonLength = bytes.readUInt32LE(12);
  ensure(bytes.readUInt32LE(16) === 0x4e4f534a, 'Missing GLB JSON chunk.');
  const document = JSON.parse(bytes.toString('utf8', 20, 20 + jsonLength));
  const binOffset = 20 + jsonLength;
  ensure(bytes.readUInt32LE(binOffset + 4) === 0x004e4942, 'Missing GLB binary chunk.');
  const binary = bytes.subarray(binOffset + 8);
  ensure(bytes.readUInt32LE(binOffset) === binary.length, 'Binary chunk size is incorrect.');
  ensure(document.buffers.length === 1 && !document.buffers[0].uri, 'Expected a self-contained binary buffer.');
  const dataView = new DataView(binary.buffer, binary.byteOffset, binary.byteLength);
  for (const view of document.bufferViews) {
    ensure(view.buffer === 0 && (view.byteOffset || 0) + view.byteLength <= binary.length, 'Buffer view is out of bounds.');
  }
  const accessorCache = new Map();
  function accessor(index) {
    if (accessorCache.has(index)) return accessorCache.get(index);
    const definition = document.accessors[index];
    ensure(definition && !definition.sparse, 'Unsupported or missing accessor.');
    const view = document.bufferViews[definition.bufferView];
    const [getter, byteSize] = componentTypes[definition.componentType] || [];
    const size = components[definition.type];
    ensure(getter && size, 'Unknown accessor type.');
    const stride = view.byteStride || byteSize * size;
    const start = (view.byteOffset || 0) + (definition.byteOffset || 0);
    const end = start + (definition.count - 1) * stride + size * byteSize;
    ensure(end <= (view.byteOffset || 0) + view.byteLength, 'Accessor exceeds its buffer view.');
    const values = new Float64Array(definition.count * size);
    const min = Array(size).fill(Infinity), max = Array(size).fill(-Infinity);
    for (let vertex = 0; vertex < definition.count; vertex++) {
      for (let component = 0; component < size; component++) {
        const value = dataView[getter](start + vertex * stride + component * byteSize, true);
        ensure(Number.isFinite(value), `Nonfinite value in accessor ${index}.`);
        values[vertex * size + component] = value;
        min[component] = Math.min(min[component], value);
        max[component] = Math.max(max[component], value);
      }
    }
    const result = { values, min, max, count: definition.count, size };
    accessorCache.set(index, result);
    return result;
  }
  document.accessors.forEach((_, index) => accessor(index));
  ensure(document.meshes.length === 1 && document.meshes[0].primitives.length === 1, 'Inspector expects the single generated character mesh.');
  const primitive = document.meshes[0].primitives[0];
  ensure((primitive.mode ?? 4) === 4 && primitive.indices !== undefined, 'Expected indexed triangles.');
  const positions = accessor(primitive.attributes.POSITION);
  const normals = accessor(primitive.attributes.NORMAL);
  const uv = accessor(primitive.attributes.TEXCOORD_0);
  const indices = accessor(primitive.indices);
  ensure(positions.size === 3 && normals.size === 3 && uv.size === 2, 'Required mesh attributes have incorrect dimensions.');
  ensure(positions.count === normals.count && positions.count === uv.count, 'Attribute vertex counts do not match.');
  ensure(indices.count % 3 === 0, 'Index count must describe complete triangles.');
  ensure(indices.min[0] >= 0 && indices.max[0] < positions.count, 'Triangle indices are out of range.');

  // UV seams duplicate vertices. Weld equal positions before checking connectivity
  // and boundary edges, without changing the actual delivered mesh.
  const weldTolerance = 1e-6;
  const weldedByPosition = new Map();
  const remap = new Uint32Array(positions.count);
  const weldedPositions = [];
  for (let vertex = 0; vertex < positions.count; vertex++) {
    const p = [...positions.values.subarray(vertex * 3, vertex * 3 + 3)];
    const key = p.map(value => Math.round(value / weldTolerance)).join(',');
    let id = weldedByPosition.get(key);
    if (id === undefined) { id = weldedPositions.length; weldedByPosition.set(key, id); weldedPositions.push(p); }
    remap[vertex] = id;
  }
  const parent = new Uint32Array(weldedPositions.length);
  for (let i = 0; i < parent.length; i++) parent[i] = i;
  function find(value) {
    while (parent[value] !== value) { parent[value] = parent[parent[value]]; value = parent[value]; }
    return value;
  }
  function union(a, b) { a = find(a); b = find(b); if (a !== b) parent[b] = a; }
  const edges = new Map();
  let degenerateTriangles = 0, signedVolume = 0, surfaceArea = 0;
  const normalLength = { min: Infinity, max: 0 };
  for (let i = 0; i < normals.count; i++) {
    const length = Math.hypot(...normals.values.subarray(i * 3, i * 3 + 3));
    normalLength.min = Math.min(normalLength.min, length);
    normalLength.max = Math.max(normalLength.max, length);
  }
  for (let i = 0; i < indices.count; i += 3) {
    const ids = [remap[indices.values[i]], remap[indices.values[i + 1]], remap[indices.values[i + 2]]];
    const [a, b, c] = ids.map(id => weldedPositions[id]);
    union(ids[0], ids[1]); union(ids[0], ids[2]);
    for (let j = 0; j < 3; j++) {
      const from = ids[j], to = ids[(j + 1) % 3];
      const key = Math.min(from, to) * weldedPositions.length + Math.max(from, to);
      let edge = edges.get(key);
      if (!edge) { edge = { count: 0, direction: 0 }; edges.set(key, edge); }
      edge.count++;
      edge.direction += from < to ? 1 : -1;
    }
    const ab = b.map((value, axis) => value - a[axis]);
    const ac = c.map((value, axis) => value - a[axis]);
    const cross = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]];
    const area = Math.hypot(...cross) / 2;
    surfaceArea += area;
    if (new Set(ids).size < 3 || area < 1e-14) degenerateTriangles++;
    signedVolume += (a[0] * (b[1] * c[2] - b[2] * c[1]) + a[1] * (b[2] * c[0] - b[0] * c[2]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6;
  }
  const groups = new Map();
  for (let i = 0; i < indices.count; i += 3) {
    const id = find(remap[indices.values[i]]);
    groups.set(id, (groups.get(id) || 0) + 1);
  }
  const componentTriangles = [...groups.values()].sort((a, b) => b - a);
  let boundaryEdges = 0, nonManifoldEdges = 0, inconsistentWindingEdges = 0;
  for (const edge of edges.values()) {
    if (edge.count === 1) boundaryEdges++;
    if (edge.count > 2) nonManifoldEdges++;
    if (edge.count === 2 && edge.direction !== 0) inconsistentWindingEdges++;
  }
  const size = positions.min.map((value, axis) => positions.max[axis] - value);
  const depthProbes = [{ label: 'torso', x: 0, y: -.35 }, { label: 'head', x: 0, y: .25 }].map(probe => {
    const hits = [];
    for (let i = 0; i < indices.count; i += 3) {
      const [a, b, c] = [indices.values[i], indices.values[i + 1], indices.values[i + 2]].map(index =>
        positions.values.subarray(index * 3, index * 3 + 3));
      if (probe.x < Math.min(a[0], b[0], c[0]) || probe.x > Math.max(a[0], b[0], c[0])
        || probe.y < Math.min(a[1], b[1], c[1]) || probe.y > Math.max(a[1], b[1], c[1])) continue;
      const determinant = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
      if (Math.abs(determinant) < 1e-16) continue;
      const u = ((b[1] - c[1]) * (probe.x - c[0]) + (c[0] - b[0]) * (probe.y - c[1])) / determinant;
      const v = ((c[1] - a[1]) * (probe.x - c[0]) + (a[0] - c[0]) * (probe.y - c[1])) / determinant;
      if (u < 0 || v < 0 || u + v > 1) continue;
      hits.push(u * a[2] + v * b[2] + (1 - u - v) * c[2]);
    }
    hits.sort((a, b) => a - b);
    let pairedIntervalSum = 0;
    for (let i = 0; i + 1 < hits.length; i += 2) pairedIntervalSum += hits[i + 1] - hits[i];
    return { ...probe, intersectionCount: hits.length, zIntersections: hits,
      outerSurfaceSpan: hits.length ? hits.at(-1) - hits[0] : 0, pairedIntervalSum };
  });
  const images = document.images.map((image, index) => {
    ensure(!image.uri && image.bufferView !== undefined && image.mimeType === 'image/webp', 'Texture must be an embedded WebP image.');
    const view = document.bufferViews[image.bufferView];
    const imageBytes = binary.subarray(view.byteOffset || 0, (view.byteOffset || 0) + view.byteLength);
    return { index, mimeType: image.mimeType, bytes: imageBytes.length, ...webpSize(imageBytes) };
  });
  return {
    file: 'central-person.glb', bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    meshCount: document.meshes.length, materialCount: document.materials.length,
    vertices: positions.count, triangles: indices.count / 3, attributesFinite: true,
    indexed: true, hasNormals: true, hasUVs: true,
    bounds: { min: positions.min, max: positions.max, size },
    depthToHeightRatio: size[2] / size[1], minToMaxExtentRatio: Math.min(...size) / Math.max(...size),
    signedVolume, absoluteVolume: Math.abs(signedVolume), surfaceArea, normalLength, depthProbes,
    uvBounds: { min: uv.min, max: uv.max },
    topology: {
      weldTolerance, weldedVertices: weldedPositions.length, edges: edges.size,
      connectedComponents: componentTriangles.length, componentTriangles,
      largestComponentFraction: componentTriangles[0] / (indices.count / 3),
      boundaryEdges, nonManifoldEdges, inconsistentWindingEdges, degenerateTriangles,
      watertightAfterWelding: boundaryEdges === 0 && nonManifoldEdges === 0,
    },
    images, materials: document.materials,
    extensionsRequired: document.extensionsRequired || [],
    externalResources: document.buffers.some(buffer => buffer.uri) || document.images.some(image => image.uri),
  };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const bytes = await readFile(new URL('../public/models/central-person.glb', import.meta.url));
  const metrics = inspectCharacterBuffer(bytes);
  const metadata = {
    title: 'Booyah central person — generated volumetric character',
    source: {
      service: 'Microsoft TRELLIS.2 on Hugging Face',
      input: '../reference/central-person-input.png',
      inputProvenance: '../reference/central-person-input.json',
      originalReference: '../reference/IMG_6660.PNG',
      seed: 800915613, resolution: 1536, textureResolution: 4096,
    },
    metrics,
    limitations: [
      'A single front photograph cannot establish the true shape or appearance of unseen sides and back; these are generated estimates.',
      'The input was an image_gen edited transparent subject image, not an exact pixel-preserving extraction.',
      'Finite attributes, depth, volume, and topology checks confirm volumetric geometry; they do not establish photorealism or exact facial likeness.',
      'The mesh is a hollow thin-walled surface: enclosed shell-material volume is much smaller than the full outer body volume.',
      'After welding UV seams, no boundary edges were detected, but 12 non-manifold edges and two tiny disconnected components remain. This is not certified as a watertight printable solid.',
      'Bounds and topology are reported in raw asset coordinates. Front-view orientation must be checked visually.',
    ],
  };
  if (process.argv.includes('--write-metadata')) {
    await writeFile(new URL('../public/models/central-person-metadata.json', import.meta.url), `${JSON.stringify(metadata, null, 2)}\n`);
  }
  console.log(JSON.stringify(metadata, null, 2));
}
