import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { inspectCharacterBuffer } from '../scripts/inspect-character.mjs';

const bytes = await readFile(new URL('../public/models/central-person.glb', import.meta.url));
const metadata = JSON.parse(await readFile(new URL('../public/models/central-person-metadata.json', import.meta.url), 'utf8'));
const metrics = inspectCharacterBuffer(bytes);

test('delivered character has finite indexed 3D geometry and front/back depth through the head and torso', () => {
  assert.equal(metrics.meshCount, 1);
  assert.equal(metrics.attributesFinite, true);
  assert.equal(metrics.indexed, true);
  assert.equal(metrics.hasNormals, true);
  assert.equal(metrics.hasUVs, true);
  assert.ok(metrics.triangles > 100_000);
  assert.ok(metrics.minToMaxExtentRatio > .4, 'All three axes must have substantial extent.');
  assert.ok(metrics.normalLength.min > .999 && metrics.normalLength.max < 1.001);
  for (const probe of metrics.depthProbes) {
    assert.ok(probe.intersectionCount >= 2, `${probe.label} must have separate front and back surfaces.`);
    assert.ok(probe.outerSurfaceSpan > .3, `${probe.label} is too shallow to match this generated character.`);
  }
});

test('character has a dominant connected surface without open boundary edges', () => {
  assert.ok(metrics.topology.largestComponentFraction > .999);
  assert.equal(metrics.topology.boundaryEdges, 0);
  assert.equal(metrics.topology.degenerateTriangles, 0);
  assert.equal(metrics.topology.inconsistentWindingEdges, 0);
  // The export has a few non-manifold joins; this test does not label it a
  // printable watertight solid or require the hollow interior to be filled.
  assert.equal(metadata.metrics.topology.nonManifoldEdges, metrics.topology.nonManifoldEdges);
});

test('character embeds both 4096px PBR textures and its metadata matches the delivered asset', () => {
  assert.equal(metrics.externalResources, false);
  assert.equal(metrics.images.length, 2);
  for (const image of metrics.images) {
    assert.equal(image.mimeType, 'image/webp');
    assert.equal(image.width, 4096);
    assert.equal(image.height, 4096);
  }
  const pbr = metrics.materials[0].pbrMetallicRoughness;
  assert.equal(pbr.baseColorTexture.index, 0);
  assert.equal(pbr.metallicRoughnessTexture.index, 1);
  assert.equal(metrics.sha256, metadata.metrics.sha256);
  assert.equal(metadata.source.seed, 800915613);
  assert.equal(metadata.source.resolution, 1536);
});
