import * as THREE from 'three';

// Silhouettes are measured in the original 1284 × 873 reference, not a
// generated replacement. Each is a tessellated, curved, closed 3D shell.
const foregroundOutline = [
  [543,155],[571,153],[598,166],[620,161],[650,174],[676,200],
  [689,229],[692,260],[685,293],[678,310],[678,332],[666,355],
  [648,376],[633,405],[634,436],[657,459],[696,480],[743,499],
  [790,525],[815,551],[839,591],[854,634],[864,684],[868,737],
  [877,782],[846,804],[807,826],[768,841],[728,851],[685,857],
  [642,859],[599,857],[555,850],[512,839],[471,822],[432,802],
  [394,778],[359,750],[337,725],[322,697],[315,670],[320,630],
  [331,585],[346,548],[367,525],[408,504],[458,482],[486,466],
  [489,450],[480,429],[488,412],[486,389],[478,365],[474,337],
  [470,307],[463,280],[458,247],[462,223],[474,202],[495,183],[518,168]
];

const backgroundOutline = [
  [221,376],[236,364],[254,364],[272,373],[285,393],[291,414],
  [287,444],[275,469],[284,484],[307,493],[326,513],[343,545],
  [349,585],[336,633],[326,664],[309,682],[291,666],[271,638],
  [249,596],[235,555],[225,509],[220,466],[219,423]
];

export function createPhotoSubjects({ project, texture, landmarks = [], pixelScale, includeForeground = true }) {
  const group = new THREE.Group();
  group.name = 'Photo-based reconstructed people';
  const photoMaterial = new THREE.MeshBasicMaterial({
    map: texture, side: THREE.DoubleSide, toneMapped: false,
  });
  photoMaterial.name = 'Original reference photograph';

  const featurePoints = landmarks.slice(0, 468).map(p => [p.x * 1284, p.y * 873, p.z]);
  function headDepth(x, y) {
    const rx = (x - 573) / 116;
    const ry = (y - 300) / 151;
    let depth = .135 + .058 * (1 - Math.sqrt(Math.max(0, 1 - rx * rx * .65 - ry * ry * .28)));
    // Interpolate measured facial relief, preserving the photograph's UVs.
    if (featurePoints.length && y > 212 && y < 432 && x > 479 && x < 665) {
      const nearest = [];
      for (const p of featurePoints) {
        const d = (x - p[0]) ** 2 + (y - p[1]) ** 2;
        if (nearest.length < 4 || d < nearest[3][0]) {
          nearest.push([d, p[2]]);
          nearest.sort((a, b) => a[0] - b[0]);
          if (nearest.length > 4) nearest.pop();
        }
      }
      let sum = 0, weights = 0;
      for (const [d, z] of nearest) { const w = 1 / (d + 2); sum += z * w; weights += w; }
      const faceDepth = .148 + sum / weights * 1284 * pixelScale * 1.6;
      const edge = Math.min((x - 479) / 20, (665 - x) / 20, (y - 212) / 20, (432 - y) / 20, 1);
      depth = THREE.MathUtils.lerp(depth, faceDepth, Math.max(0, edge));
    }
    return depth;
  }

  function foregroundDepth(x, y) {
    if (y < 432) return headDepth(x, y);
    const across = Math.min(1, Math.abs((x - 592) / 283));
    const torso = .125 + .085 * (1 - Math.sqrt(1 - across * across));
    if (y < 506) {
      const neck = .167 + .02 * Math.min(1, Math.abs(x - 565) / 100);
      return THREE.MathUtils.lerp(headDepth(x, 424), neck, Math.min(1, (y - 432) / 42)) * (1 - Math.max(0, y - 480) / 26)
        + torso * Math.max(0, y - 480) / 26;
    }
    // The hand comes forward of the shirt at the bottom of the photograph.
    const hand = Math.exp(-(((x - 633) / 102) ** 4) - ((y - 841) / 33) ** 4);
    return torso - .035 * hand;
  }

  if (includeForeground) {
    group.add(reliefShell('Foreground person — curved photo mesh', foregroundOutline,
      foregroundDepth, project, photoMaterial, (_x,y) => y < 435 ? .205 : .265));
  }
  group.add(reliefShell('Background person — curved photo mesh', backgroundOutline,
    (x, y) => .32 + .035 * Math.min(1, ((x - 264) / 79) ** 2) + (y > 490 ? .01 : 0),
    project, photoMaterial, .365));

  // A complete foreground GLB replaces the relief and all its crop extensions.
  // Keep the background person independent, at their original depth.
  if (!includeForeground) return group;

  // Complete the torso below the circular source crop. This geometry extends
  // beyond the viewport; its unseen shape and fabric are approximations.
  const extensionMaterial = new THREE.MeshBasicMaterial({color: 0x292f3e, toneMapped: false, side: THREE.DoubleSide});
  extensionMaterial.name = 'Inferred navy fabric outside reference crop';
  const extension = new THREE.BufferGeometry();
  const lower = [[338,704],[360,750],[394,778],[432,802],[471,822],[512,839],
    [555,850],[599,857],[642,859],[685,857],[728,851],[768,841],[807,826],
    [846,804],[877,782],[901,1100],[304,1100]];
  const verts = lower.map(p => new THREE.Vector2(...p));
  const positions = [];
  for (const tri of THREE.ShapeUtils.triangulateShape(verts, [])) {
    for (const i of tri) positions.push(...project(lower[i][0], lower[i][1], .222).toArray());
  }
  extension.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  extension.computeVertexNormals();
  const shirtExtension = new THREE.Mesh(extension, extensionMaterial);
  shirtExtension.name = 'Inferred lower torso';
  group.add(shirtExtension);

  // Continue exposed arms beyond the circular crop using adjacent skin
  // samples. These are invented continuations, hidden below the main view.
  function armExtension(name, outline, patch) {
    const shape=outline.map(p=>new THREE.Vector2(...p));
    const positions=[],uvs=[];
    const xs=outline.map(p=>p[0]), ys=outline.map(p=>p[1]);
    const x0=Math.min(...xs),x1=Math.max(...xs),y0=Math.min(...ys),y1=Math.max(...ys);
    for(const tri of THREE.ShapeUtils.triangulateShape(shape,[]))for(const i of tri){
      const [x,y]=outline[i];
      positions.push(...project(x,y,.216).toArray());
      uvs.push((patch[0]+(x-x0)/(x1-x0)*(patch[2]-patch[0]))/1284,
        1-(patch[1]+(y-y0)/(y1-y0)*(patch[3]-patch[1]))/873);
    }
    const geometry=new THREE.BufferGeometry();
    geometry.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));
    geometry.setAttribute('uv',new THREE.Float32BufferAttribute(uvs,2));
    geometry.computeVertexNormals();
    const mesh=new THREE.Mesh(geometry,photoMaterial);mesh.name=name;group.add(mesh);
  }
  armExtension('Inferred right forearm',[[768,841],[807,826],[846,804],[877,782],[902,1100],[788,1100]], [790,784,827,803]);
  armExtension('Inferred left forearm',[[352,742],[369,758],[390,775],[405,784],[383,1100],[326,1100]], [358,749,374,758]);
  return group;
}

function reliefShell(name, outline, depthAt, project, material, backDepth) {
  const contour = outline.map(p => new THREE.Vector2(...p));
  const triangles = THREE.ShapeUtils.triangulateShape(contour, []);
  const positions = [], uvs = [];
  function emit(p) {
    positions.push(...project(p[0], p[1], depthAt(...p)).toArray());
    uvs.push(p[0] / 1284, 1 - p[1] / 873);
  }
  function subdivide(a, b, c, level = 0) {
    const lengths = [distance(a,b), distance(b,c), distance(c,a)];
    const max = Math.max(...lengths);
    if (max <= 9 || level >= 15) { emit(a); emit(b); emit(c); return; }
    const i = lengths.indexOf(max);
    if (i === 0) { const m = midpoint(a,b); subdivide(a,m,c,level+1); subdivide(m,b,c,level+1); }
    else if (i === 1) { const m = midpoint(b,c); subdivide(a,b,m,level+1); subdivide(a,m,c,level+1); }
    else { const m = midpoint(c,a); subdivide(a,b,m,level+1); subdivide(m,b,c,level+1); }
  }
  for (const tri of triangles) subdivide(...tri.map(i => outline[i]));
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions,3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs,2));
  geometry.computeVertexNormals();
  const group = new THREE.Group(); group.name = name;
  const surface = new THREE.Mesh(geometry, material); surface.name = 'Sculpted front surface'; group.add(surface);

  const shellPositions = [], shellUVs = [];
  const front = outline.map(p => project(p[0],p[1],depthAt(...p)));
  const back = front.map((p,i) => new THREE.Vector3(p.x,p.y,
    -(typeof backDepth==='function'?backDepth(...outline[i]):backDepth)));
  const add = (pos, uv) => {shellPositions.push(...pos.toArray());shellUVs.push(uv[0]/1284,1-uv[1]/873);};
  for(let i=0;i<outline.length;i++) {
    const j=(i+1)%outline.length;
    for(const [pos,uv] of [[front[i],outline[i]],[back[i],outline[i]],[front[j],outline[j]],
      [front[j],outline[j]],[back[i],outline[i]],[back[j],outline[j]]]) add(pos,uv);
  }
  for(const tri of triangles)for(const i of [...tri].reverse())add(back[i],outline[i]);
  const shell=new THREE.BufferGeometry();
  shell.setAttribute('position',new THREE.Float32BufferAttribute(shellPositions,3));
  shell.setAttribute('uv',new THREE.Float32BufferAttribute(shellUVs,2));
  shell.computeVertexNormals();
  const side = new THREE.Mesh(shell,material);side.name='Inferred side and back surfaces';group.add(side);
  return group;
}

function midpoint(a,b){return [(a[0]+b[0])/2,(a[1]+b[1])/2];}
function distance(a,b){return Math.hypot(a[0]-b[0],a[1]-b[1]);}
