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
    for(let i=0;i<position.count;i++)assert.ok(new THREE.Vector3().fromBufferAttribute(position,i).applyMatrix4(object.matrixWorld).z<0,object.name);
  });}
  assert.ok(count>30);
  assert.ok(room.getObjectByName('Curved tapered leaf'));
  assert.ok(room.getObjectByName('Door center mullion'));
});
