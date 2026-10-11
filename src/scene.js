import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { applyOffAxis } from './perspective.js';
import { createPhotoRoom } from './photo-room.js';
import { createPhotoSubjects } from './photo-subjects.js';
import { enhancePortraitFace } from './portrait-texture.js';

export class PerspectiveScene {
  constructor(element, { centralModelUrl = null, enhanceFace = false } = {}) {
    this.element = element;
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.setClearColor(0x656466);
    this.renderer.toneMapping = THREE.NoToneMapping;
    element.append(this.renderer.domElement);
    this.scene = new THREE.Scene();
    this.scene.name = 'Booyah — portrait room reconstruction';
    this.scene.add(new THREE.AmbientLight(0xffffff, 2.8));
    const flash = new THREE.DirectionalLight(0xffffff, 1.2);
    flash.position.set(-.12,.13,.8);
    this.scene.add(flash);
    this.camera = new THREE.PerspectiveCamera(45,1,.005,15);
    this.width = .48;
    this.eye = {x:0,y:0,z:.65};
    this.room = new THREE.Group();
    this.placeholder = new THREE.Group();
    this.content = new THREE.Group();
    this.centralPerson = new THREE.Group();
    this.centralPerson.name = 'Volumetric central person';
    this.centralPerson.visible = false;
    this.centralPersonLayout = { x: 542.0671, y: 489.9827, height: 640.5211, depth: .18 };
    this.centralPersonError = null;
    this.enhanceFace = enhanceFace;
    this._centralLoadGeneration = 0;
    this.scene.add(this.room,this.placeholder,this.content,this.centralPerson);
    this.content.position.z = -.14;
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(element);
    this.resize();
    this.referenceReady = this.loadReference();
    this.ready = this.referenceReady.then(async () => {
      if (!centralModelUrl) return;
      try {
        await this.loadCentralPerson(centralModelUrl);
      } catch (error) {
        // A generated asset is optional. Keep the complete relief usable if it
        // fails, including the independent drag-and-drop model workflow.
        this.centralPersonError = error;
        console.warn('The central-person GLB could not load; retaining the photo relief.', error);
      }
    });
  }

  async loadReference() {
    const [texture, landmarks] = await Promise.all([
      new THREE.TextureLoader().loadAsync(`${import.meta.env.BASE_URL}reference/IMG_6660.PNG`),
      fetch(`${import.meta.env.BASE_URL}reference/landmarks.json`).then(response => {
        if(!response.ok) throw new Error('The reference face geometry could not load.');
        return response.json();
      }),
    ]);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = Math.min(8,this.renderer.capabilities.getMaxAnisotropy());
    texture.name = 'Original IMG_6660.PNG';
    this.photoTexture = texture;
    this.landmarks = landmarks;
    this.rebuildRoom();
    this.render();
  }

  resize() {
    const {width,height} = this.element.getBoundingClientRect();
    if(!width||!height)return;
    this.aspect=width/height;
    this.height=this.width/this.aspect;
    this.renderer.setSize(width,height,false);
    this.rebuildRoom();
    this.render();
  }

  setWidth(width) { this.width=width;this.resize(); }

  rebuildRoom() {
    if(!this.photoTexture||!this.height)return;
    const wasVisible=this.placeholder.visible;
    for(const group of [this.room,this.placeholder]) {
      this.scene.remove(group);
      disposeObject(group,this.photoTexture);
    }
    // Preserve the photograph's neutral framing with different depths for
    // each surface. Moving the off-axis camera reveals actual mesh parallax.
    const pixelScale=this.height/800;
    const project=(x,y,depth)=> {
      const perspectiveScale=(.65+depth)/.65;
      return new THREE.Vector3((x-620)*pixelScale*perspectiveScale,
        (455-y)*pixelScale*perspectiveScale,-depth);
    };
    this.room=createPhotoRoom({project,texture:this.photoTexture,width:this.width,height:this.height});
    this.placeholder=createPhotoSubjects({project,texture:this.photoTexture,
      landmarks:this.landmarks,pixelScale,includeForeground:!this.centralPersonModel});
    this.placeholder.visible=wasVisible;
    this.scene.add(this.room,this.placeholder);
    this.content.scale.setScalar(Math.min(this.width,this.height)*.62/.23);
    this.fitCentralPerson(project,pixelScale);
  }

  fitCentralPerson(project,pixelScale) {
    if(!this.centralPersonModel||!this.centralPersonBounds)return;
    const {x,y,height,depth}=this.centralPersonLayout;
    const modelHeight=this.centralPersonBounds.getSize(new THREE.Vector3()).y;
    const physicalHeight=height*pixelScale*(.65+depth)/.65;
    this.centralPerson.scale.setScalar(physicalHeight/modelHeight);
    this.centralPerson.position.copy(project(x,y,depth));
    this.centralPerson.visible=!this.loadedModel;
  }

  async loadCentralPerson(url) {
    const generation=++this._centralLoadGeneration;
    await this.referenceReady;
    const assetUrl=new URL(url,window.location.href);
    if(assetUrl.origin!==window.location.origin||!assetUrl.pathname.toLowerCase().endsWith('.glb')) {
      throw new Error('The central-person asset must be a local, self-contained .glb file.');
    }
    const response=await fetch(assetUrl);
    if(!response.ok)throw new Error(`The central-person model could not load (${response.status}).`);
    const model=await parseSelfContainedGLB(await response.arrayBuffer());
    if(generation!==this._centralLoadGeneration){disposeObject(model);return null;}
    model.updateMatrixWorld(true);
    const box=new THREE.Box3().setFromObject(model,true);
    const size=box.getSize(new THREE.Vector3());
    if(![...box.min.toArray(),...box.max.toArray()].every(Number.isFinite)||size.y<=0) {
      disposeObject(model);
      throw new Error('The central-person model contains no finite visible geometry.');
    }
    // Offset a parent rather than changing the imported node transforms. Keep
    // the complete GLB and its original proportions/materials intact.
    const centered=new THREE.Group();
    centered.name='Centered central-person asset';
    centered.position.copy(box.getCenter(new THREE.Vector3())).negate();
    centered.add(model);
    let portraitController;
    if(this.enhanceFace) {
      try {
        const response=await fetch(`${import.meta.env.BASE_URL}reference/model-landmarks.json`);
        if(!response.ok)throw new Error('The facial alignment could not load.');
        const points=await response.json();
        portraitController=enhancePortraitFace(model,this.photoTexture,this.landmarks,points);
      } catch(error) { console.warn('Using the generated facial texture.',error); }
    }
    if(generation!==this._centralLoadGeneration) {
      portraitController?.dispose();
      disposeObject(model,this.photoTexture);
      return null;
    }
    if(this.enhanceFace) {
      // The supplied portrait ends mid-torso. Continue its cropped lower
      // surface below the viewing window without changing the measured head.
      // Preserve the downloaded GLB; this is only the scene's presentation.
      model.traverse(mesh=>{
        if(!mesh.isMesh)return;
        if(!portraitController)mesh.geometry=mesh.geometry.clone();
        const position=mesh.geometry.attributes.position;
        for(let i=0;i<position.count;i++) {
          const y=position.getY(i);
          const lowerBody=THREE.MathUtils.smoothstep(-y,.30,.43);
          const raisedHand=THREE.MathUtils.smoothstep(position.getZ(i),.135,.19)
            *THREE.MathUtils.smoothstep(-y,.12,.19);
          position.setY(i,y-.18*Math.max(lowerBody,raisedHand));
        }
        position.needsUpdate=true;
        mesh.geometry.computeVertexNormals();
        mesh.geometry.computeBoundingBox();
        mesh.geometry.computeBoundingSphere();
      });
    }
    const previous=this.centralPersonModel;
    this.portraitController?.dispose();
    this.portraitController=portraitController;
    this.centralPerson.add(centered);
    if(previous){this.centralPerson.remove(previous);disposeObject(previous);}
    this.centralPersonModel=centered;
    this.centralPersonBounds=box;
    this.centralPersonError=null;
    this.centralModelUrl=assetUrl.pathname;
    this.rebuildRoom();
    this.render();
    return centered;
  }

  render(eye=this.eye) {
    this.eye=eye;
    if(!this.height)return;
    applyOffAxis(this.camera,this.width,this.height,eye);
    this.renderer.render(this.scene,this.camera);
  }

  async loadModel(file) {
    if(!file.name.toLowerCase().endsWith('.glb'))throw new Error('Choose a self-contained .glb model.');
    if(file.size>100*1024*1024)throw new Error('Please use a GLB smaller than 100 MB.');
    await this.ready;
    const buffer=await file.arrayBuffer();
    const model=await parseSelfContainedGLB(buffer);
    const box=new THREE.Box3().setFromObject(model);
    const size=box.getSize(new THREE.Vector3());
    const extent=Math.max(size.x,size.y,size.z);
    if(!Number.isFinite(extent)||extent<=0){disposeObject(model);throw new Error('The model contains no visible geometry.');}
    model.position.sub(box.getCenter(new THREE.Vector3()));
    const wrapper=new THREE.Group();wrapper.add(model);wrapper.scale.setScalar(.23/extent);
    if(this.loadedModel){this.content.remove(this.loadedModel);disposeObject(this.loadedModel);}
    this.placeholder.visible=false;
    this.centralPerson.visible=false;
    this.loadedModel=wrapper;
    this.content.add(wrapper);
  }

  restoreModel() {
    if(this.loadedModel){this.content.remove(this.loadedModel);disposeObject(this.loadedModel);this.loadedModel=null;}
    this.placeholder.visible=true;
    this.centralPerson.visible=!!this.centralPersonModel;
  }
}

async function parseSelfContainedGLB(buffer) {
  const manager=new THREE.LoadingManager();
  let blockedResource=null;
  manager.setURLModifier(url=>{
    if(url.startsWith('blob:')||url.startsWith('data:'))return url;
    blockedResource=url;
    throw new Error('This model references external files. Export a self-contained GLB.');
  });
  const gltf=await new GLTFLoader(manager).parseAsync(buffer,'');
  if(blockedResource!==null){disposeObject(gltf.scene);throw new Error('This model references external files. Export a self-contained GLB.');}
  return gltf.scene;
}

function disposeObject(object,retainedTexture) {
  const geometries=new Set(),materials=new Set(),textures=new Set();
  object.traverse(child=>{
    if(child.geometry)geometries.add(child.geometry);
    for(const material of(Array.isArray(child.material)?child.material:[child.material])) {
      if(!material)continue;
      materials.add(material);
      for(const value of Object.values(material))if(value?.isTexture&&value!==retainedTexture)textures.add(value);
    }
  });
  for(const geometry of geometries)geometry.dispose();
  for(const texture of textures)texture.dispose();
  for(const material of materials)material.dispose();
}
