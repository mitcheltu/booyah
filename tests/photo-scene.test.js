import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { createPhotoSubjects } from '../src/photo-subjects.js';
import { createPhotoRoom } from '../src/photo-room.js';
import { applyOffAxis } from '../src/perspective.js';

const width=.48,height=width/(16/9),pixelScale=height/800;
const landmarks=JSON.parse(readFileSync(new URL('../public/reference/landmarks.json',import.meta.url)));
const texture=new THREE.Texture();
const project=(x,y,depth)=>new THREE.Vector3((x-620)*pixelScale*(.65+depth)/.65,
  (455-y)*pixelScale*(.65+depth)/.65,-depth);
const subjects=createPhotoSubjects({project,texture,landmarks,pixelScale});
const room=createPhotoRoom({project,texture});

test('the reference has a measured face and nonplanar subject geometry',()=>{
  assert.equal(landmarks.length,478);
  const front=subjects.children[0].getObjectByName('Sculpted front surface');
  const position=front.geometry.attributes.position;
  assert.ok(position.count>10000);
  let near=-Infinity,far=Infinity;
  for(let i=0;i<position.count;i++){near=Math.max(near,position.getZ(i));far=Math.min(far,position.getZ(i));}
  assert.ok(near-far>.035,'A flat picture cannot satisfy the depth range.');
});

test('the neutral view preserves the reference photograph on the curved foreground',()=>{
  const camera=new THREE.PerspectiveCamera(45,16/9,.005,15);
  applyOffAxis(camera,width,height,{x:0,y:0,z:.65});
  const front=subjects.children[0].getObjectByName('Sculpted front surface');
  const {position,uv}=front.geometry.attributes;
  for(let i=0;i<position.count;i+=211){
    const p=new THREE.Vector3().fromBufferAttribute(position,i).project(camera);
    const x=uv.getX(i)*1284,y=(1-uv.getY(i))*873;
    assert.ok(Math.abs(p.x-(x-620)*pixelScale/(width/2))<1e-5);
    assert.ok(Math.abs(p.y-(455-y)*pixelScale/(height/2))<1e-5);
  }
});

test('the room and people have finite renderable surfaces at independent depths',()=>{
  let count=0;
  for(const root of [room,subjects]){root.updateMatrixWorld(true);root.traverse(object=>{
    if(!object.isMesh)return;
    count++;
    const position=object.geometry.attributes.position;
    assert.ok(position.count>=3);
    assert.ok([...position.array].every(Number.isFinite),object.name);
    for(let i=0;i<position.count;i++)assert.ok(new THREE.Vector3().fromBufferAttribute(position,i).applyMatrix4(object.matrixWorld).z<=0,object.name);
  });}
  assert.ok(count>30);
  assert.ok(room.getObjectByName('Curved tapered leaf'));
  assert.ok(room.getObjectByName('Door center mullion'));
});

const roomSurfaces = ['Back wall', 'Ceiling', 'Right wall', 'Floor', 'Left wall'];
const screenSizes = [.25, .48, .95].flatMap(width => [9/16, 1, 16/9, 32/9]
  .map(aspect => ({width, height: width / aspect, aspect})));

function roomForScreen(width, height) {
  const pixelScale = height / 800;
  const project = (x, y, depth) => new THREE.Vector3(
    (x - 620) * pixelScale * (.65 + depth) / .65,
    (455 - y) * pixelScale * (.65 + depth) / .65, -depth);
  return createPhotoRoom({project, texture, width, height});
}

test('all four room seams stay attached to screen corners as the viewer moves', () => {
  const eyes = [{x:0,y:0,z:.65}, {x:-.12,y:.07,z:.4}, {x:.2,y:-.11,z:1.2}];
  for (const {width, height, aspect} of screenSizes) {
    const room = roomForScreen(width, height);
    const camera = new THREE.PerspectiveCamera(45, aspect, .005, 15);
    const opening = [];
    for (const name of roomSurfaces) {
      const position = room.getObjectByName(name).geometry.attributes.position;
      for (let i = 0; i < position.count; i++) {
        if (position.getZ(i) === 0) opening.push(new THREE.Vector3().fromBufferAttribute(position, i));
      }
    }
    assert.equal(opening.length, 8, 'Each opening corner joins two room surfaces.');
    assert.equal(new Set(opening.map(p => `${Math.sign(p.x)},${Math.sign(p.y)}`)).size, 4);
    for (const eye of eyes) {
      applyOffAxis(camera, width, height, eye);
      for (const corner of opening) {
        const projected = corner.clone().project(camera);
        assert.ok(Math.abs(projected.x - Math.sign(corner.x)) < 1e-6);
        assert.ok(Math.abs(projected.y - Math.sign(corner.y)) < 1e-6);
      }
    }
    const rearCorner = new THREE.Vector3().fromBufferAttribute(room.getObjectByName('Back wall').geometry.attributes.position, 0);
    applyOffAxis(camera, width, height, eyes[0]);
    const centered = rearCorner.clone().project(camera);
    applyOffAxis(camera, width, height, eyes[1]);
    assert.ok(rearCorner.clone().project(camera).distanceTo(centered) > .01,
      'The rear of the room must retain head-motion parallax.');
  }
});

test('room surfaces share every seam and have only the screen opening as a boundary', () => {
  for (const {width, height} of screenSizes) {
    const room = roomForScreen(width, height);
    const edges = new Map();
    for (const name of roomSurfaces) {
      const position = room.getObjectByName(name).geometry.attributes.position;
      for (let i = 0; i < 4; i++) {
        const a = new THREE.Vector3().fromBufferAttribute(position, i);
        const b = new THREE.Vector3().fromBufferAttribute(position, (i + 1) % 4);
        const key = [a.toArray().join(','), b.toArray().join(',')].sort().join('|');
        const edge = edges.get(key) ?? {count:0, a, b};
        edge.count++;
        edges.set(key, edge);
      }
    }
    assert.equal(edges.size, 12);
    assert.equal([...edges.values()].filter(edge => edge.count === 2).length, 8);
    const boundary = [...edges.values()].filter(edge => edge.count === 1);
    assert.equal(boundary.length, 4);
    for (const {a, b} of boundary) assert.ok(a.z === 0 && b.z === 0);
  }
});

test('the room is a rectangular box with parallel walls and right-angle corners', () => {
  for (const {width, height, aspect} of screenSizes) {
    const room = roomForScreen(width, height);
    const rear = room.getObjectByName('Back wall').geometry.attributes.position;
    const camera = new THREE.PerspectiveCamera(45, aspect, .005, 15);
    applyOffAxis(camera, width, height, {x:0,y:0,z:.65});
    for (let i = 0; i < rear.count; i++) {
      const p = new THREE.Vector3().fromBufferAttribute(rear, i);
      assert.ok(Math.abs(Math.abs(p.x) - width / 2) < 1e-6);
      assert.ok(Math.abs(Math.abs(p.y) - height / 2) < 1e-6);
      const projected = p.clone().project(camera);
      const expectedScale = .65 / (.65 - p.z);
      assert.ok(Math.abs(projected.x - Math.sign(p.x) * expectedScale) < 1e-6);
      assert.ok(Math.abs(projected.y - Math.sign(p.y) * expectedScale) < 1e-6);
    }
    for (const name of roomSurfaces) {
      const vertices = room.getObjectByName(name).geometry.attributes.position;
      const a = new THREE.Vector3().fromBufferAttribute(vertices, 0);
      const b = new THREE.Vector3().fromBufferAttribute(vertices, 1);
      const c = new THREE.Vector3().fromBufferAttribute(vertices, 2);
      assert.ok(Math.abs(a.sub(b).normalize().dot(c.sub(b).normalize())) < 1e-6, name);
    }
  }
});

test('window beams have straight depth edges and decor keeps its proportions', () => {
  for (const {width, height} of screenSizes) {
    const room = roomForScreen(width, height);
    for (const name of ['Window fitted inside the back wall', 'Dark leafy plant behind right shoulder']) {
      const {x, y, z} = room.getObjectByName(name).scale;
      assert.equal(x, y, name);
      assert.equal(y, z, name);
    }
    room.getObjectByName('Window fitted inside the back wall').traverse(object => {
      const p = object.geometry?.attributes.position;
      if (!p || p.count !== 8) return;
      for (let i = 0; i < 4; i++) {
        assert.equal(p.getX(i), p.getX(i + 4), object.name);
        assert.equal(p.getY(i), p.getY(i + 4), object.name);
        assert.ok(p.getZ(i + 4) < p.getZ(i), object.name);
      }
    });
  }
});

test('the window and plant stay within the room at portrait and landscape sizes', () => {
  for (const {width, height} of screenSizes) {
    const room = roomForScreen(width, height);
    room.updateMatrixWorld(true);
    const back = room.getObjectByName('Back wall').geometry.attributes.position;
    const depth = -back.getZ(0);
    for (const name of ['Window fitted inside the back wall', 'Dark leafy plant behind right shoulder']) {
      room.getObjectByName(name).traverse(object => {
        if (!object.isMesh) return;
        const position = object.geometry.attributes.position;
        for (let i = 0; i < position.count; i++) {
          const p = new THREE.Vector3().fromBufferAttribute(position, i).applyMatrix4(object.matrixWorld);
          assert.ok(p.z >= -depth - 1e-6 && p.z < 0, object.name);
          assert.ok(Math.abs(p.x) < width / 2, object.name);
          assert.ok(Math.abs(p.y) < height / 2, object.name);
        }
      });
    }
  }
});
