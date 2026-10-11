import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { createPhotoRoom } from '../src/photo-room.js';
import { createPhotoSubjects } from '../src/photo-subjects.js';

// Export the same mesh builders as the live application. No renderer, screenshot,
// canvas polyfill, or additional dependency is required.
const root = new URL('../', import.meta.url);
const referenceBytes = await readFile(new URL('public/reference/IMG_6660.PNG', root));
const landmarks = JSON.parse(await readFile(new URL('public/reference/landmarks.json', root), 'utf8'));
const texture = new THREE.Texture();
texture.name = 'Original IMG_6660.PNG';
texture.colorSpace = THREE.SRGBColorSpace;
const pixelScale = .48 / (16 / 9) / 800;
const project = (x, y, depth) => {
  const perspectiveScale = (.65 + depth) / .65;
  return new THREE.Vector3((x - 620) * pixelScale * perspectiveScale,
    (455 - y) * pixelScale * perspectiveScale, -depth);
};
const scene = new THREE.Scene();
scene.name = 'Booyah — portrait room reconstruction';
scene.add(createPhotoRoom({ project, texture }));
scene.add(createPhotoSubjects({ project, texture, landmarks, pixelScale }));
scene.updateMatrixWorld(true);

const bounds = new THREE.Box3().setFromObject(scene);
if (bounds.isEmpty() || ![...bounds.min.toArray(), ...bounds.max.toArray()].every(Number.isFinite)) {
  throw new Error('The scene must have nonempty finite bounds.');
}
const { glb, statistics } = serializeGLB(scene, referenceBytes, texture);
const output = new URL('public/models/booyah-scene.glb', root);
await mkdir(new URL('public/models/', root), { recursive: true });
await writeFile(output, glb);
console.log(JSON.stringify({
  file: fileURLToPath(output),
  bytes: glb.length,
  ...statistics,
  bounds: { min: bounds.min.toArray(), max: bounds.max.toArray() },
  imageMimeType: imageMimeType(referenceBytes),
  textureVFlippedForGLTF: true,
}, null, 2));

function imageMimeType(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  throw new Error('The reference must contain PNG or JPEG image bytes.');
}

function serializeGLB(scene, imageBytes, photoTexture) {
  const document = {
    asset: { version: '2.0', generator: 'Booyah source geometry exporter' },
    scene: 0,
    scenes: [{ name: scene.name, nodes: [] }],
    nodes: [], meshes: [], materials: [], accessors: [], bufferViews: [],
    buffers: [{ byteLength: 0 }],
    samplers: [{ magFilter: 9729, minFilter: 9987, wrapS: 33071, wrapT: 33071 }],
    images: [], textures: [{ sampler: 0, source: 0 }],
    extras: {
      sourceReference: 'IMG_6660.PNG',
      framingAspect: 16 / 9,
      screenWidth: .48,
      neutralEye: [0, 0, .65],
      description: 'Photo-based mesh reconstruction. Surfaces unseen in the source photograph are approximated.',
    },
  };
  const chunks = [];
  let byteLength = 0;
  const materialIndices = new Map();
  const geometryIndices = new Map();
  const extensions = new Set();
  const statistics = { meshes: 0, triangles: 0, vertices: 0, materials: 0, embeddedImages: 1 };

  function bufferView(bytes, target) {
    const padding = (4 - byteLength % 4) % 4;
    if (padding) { chunks.push(Buffer.alloc(padding)); byteLength += padding; }
    const index = document.bufferViews.length;
    const view = { buffer: 0, byteOffset: byteLength, byteLength: bytes.length };
    if (target) view.target = target;
    document.bufferViews.push(view);
    chunks.push(bytes);
    byteLength += bytes.length;
    return index;
  }

  function attributeAccessor(attribute, type, { flipV = false, indices = false } = {}) {
    const size = indices ? 1 : attribute.itemSize;
    const count = attribute.count;
    const values = [];
    const minimum = Array(size).fill(Infinity);
    const maximum = Array(size).fill(-Infinity);
    for (let i = 0; i < count; i++) {
      for (let component = 0; component < size; component++) {
        let value = attribute.getComponent(i, component);
        if (flipV && component === 1) value = 1 - value;
        if (!indices) value = Math.fround(value);
        if (!Number.isFinite(value)) throw new Error(`Nonfinite ${type} attribute at vertex ${i}.`);
        if (indices && (!Number.isInteger(value) || value < 0)) throw new Error('Indices must be unsigned integers.');
        values.push(value);
        minimum[component] = Math.min(minimum[component], value);
        maximum[component] = Math.max(maximum[component], value);
      }
    }
    if (!count) throw new Error('Empty geometry attributes cannot be exported.');
    const componentType = indices ? (maximum[0] > 65535 ? 5125 : 5123) : 5126;
    const typed = componentType === 5125 ? new Uint32Array(values)
      : componentType === 5123 ? new Uint16Array(values) : new Float32Array(values);
    const bytes = Buffer.from(typed.buffer, typed.byteOffset, typed.byteLength);
    const accessor = {
      bufferView: bufferView(bytes, indices ? 34963 : 34962),
      componentType, count, type,
      min: minimum, max: maximum,
    };
    document.accessors.push(accessor);
    return document.accessors.length - 1;
  }

  function materialIndex(material) {
    if (materialIndices.has(material)) return materialIndices.get(material);
    if (material.map && material.map !== photoTexture) throw new Error('Unexpected texture in scene.');
    const output = {
      name: material.name || material.type,
      pbrMetallicRoughness: {
        baseColorFactor: [...material.color.toArray(), material.opacity],
        metallicFactor: material.metalness ?? 0,
        roughnessFactor: material.roughness ?? 1,
      },
      doubleSided: material.side === THREE.DoubleSide,
    };
    if (material.map) output.pbrMetallicRoughness.baseColorTexture = { index: 0, texCoord: 0 };
    if (material.transparent) output.alphaMode = 'BLEND';
    else if (material.alphaTest > 0) { output.alphaMode = 'MASK'; output.alphaCutoff = material.alphaTest; }
    if (material.isMeshBasicMaterial) {
      output.extensions = { KHR_materials_unlit: {} };
      extensions.add('KHR_materials_unlit');
    }
    const index = document.materials.length;
    document.materials.push(output);
    materialIndices.set(material, index);
    return index;
  }

  function geometryAccessors(geometry) {
    if (geometryIndices.has(geometry)) return geometryIndices.get(geometry);
    if (!geometry.attributes.normal) geometry.computeVertexNormals();
    const attributes = { POSITION: attributeAccessor(geometry.attributes.position, 'VEC3') };
    attributes.NORMAL = attributeAccessor(geometry.attributes.normal, 'VEC3');
    if (geometry.attributes.uv) {
      // TextureLoader uploads the source with flipY=true. GLTFLoader sets it to
      // false, so reverse V in the exported UVs to retain the exact photo mapping.
      attributes.TEXCOORD_0 = attributeAccessor(geometry.attributes.uv, 'VEC2', { flipV: true });
    }
    const indices = geometry.index ? attributeAccessor(geometry.index, 'SCALAR', { indices: true }) : undefined;
    if (geometry.index && document.accessors[indices].max[0] >= geometry.attributes.position.count) {
      throw new Error('Geometry index exceeds its vertex count.');
    }
    const result = { attributes, indices };
    geometryIndices.set(geometry, result);
    return result;
  }

  function nodeIndex(object) {
    object.updateMatrix();
    const output = { name: object.name || object.type, matrix: object.matrix.toArray() };
    if (!output.matrix.every(Number.isFinite)) throw new Error(`Nonfinite transform in ${output.name}.`);
    const index = document.nodes.length;
    document.nodes.push(output);
    if (object.isMesh) {
      if (Array.isArray(object.material)) throw new Error('Multi-material meshes require explicit primitive groups.');
      const geometry = object.geometry;
      const { attributes, indices } = geometryAccessors(geometry);
      const primitive = { attributes, material: materialIndex(object.material), mode: 4 };
      if (indices !== undefined) primitive.indices = indices;
      output.mesh = document.meshes.length;
      document.meshes.push({ name: object.name || 'Mesh', primitives: [primitive] });
      const elementCount = geometry.index?.count ?? geometry.attributes.position.count;
      if (elementCount % 3) throw new Error('Triangle mesh element count is not divisible by three.');
      statistics.meshes++;
      statistics.triangles += elementCount / 3;
      statistics.vertices += geometry.attributes.position.count;
    }
    const children = object.children.filter(child => child.visible).map(nodeIndex);
    if (children.length) output.children = children;
    return index;
  }

  document.scenes[0].nodes = scene.children.filter(child => child.visible).map(nodeIndex);
  document.images.push({ name: photoTexture.name, mimeType: imageMimeType(imageBytes), bufferView: bufferView(imageBytes) });
  if (extensions.size) document.extensionsUsed = [...extensions];
  statistics.materials = document.materials.length;
  document.buffers[0].byteLength = byteLength;
  const binary = Buffer.concat(chunks);
  const json = Buffer.from(JSON.stringify(document), 'utf8');
  const paddedJSON = Buffer.concat([json, Buffer.alloc((4 - json.length % 4) % 4, 0x20)]);
  const paddedBinary = Buffer.concat([binary, Buffer.alloc((4 - binary.length % 4) % 4)]);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + paddedJSON.length + 8 + paddedBinary.length, 8);
  const jsonHeader = Buffer.alloc(8);
  jsonHeader.writeUInt32LE(paddedJSON.length, 0);
  jsonHeader.writeUInt32LE(0x4e4f534a, 4);
  const binaryHeader = Buffer.alloc(8);
  binaryHeader.writeUInt32LE(paddedBinary.length, 0);
  binaryHeader.writeUInt32LE(0x004e4942, 4);
  return { glb: Buffer.concat([header, jsonHeader, paddedJSON, binaryHeader, paddedBinary]), statistics };
}
