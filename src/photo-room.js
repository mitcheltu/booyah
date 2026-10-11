import * as THREE from 'three';

/**
 * The room visible behind the portrait, rebuilt as independent geometry.
 * Pixel coordinates refer to the 1284 x 873 reference photograph. Only clean
 * wall/ceiling patches are sampled: the original people never appear behind
 * their foreground meshes when the viewer moves.
 */
export function createPhotoRoom({ project, texture }) {
  const room = new THREE.Group();
  room.name = 'Photo room — walls, window, and plant';
  const matte = (color, extra = {}) => new THREE.MeshStandardMaterial({
    color, roughness: 0.94, metalness: 0, side: THREE.DoubleSide, ...extra,
  });
  // The photograph already contains the room's soft illumination. Preserve
  // those colors instead of lighting the sampled walls a second time.
  const wallMaterial = texture
    ? new THREE.MeshBasicMaterial({ map: texture, side: THREE.DoubleSide, toneMapped: false })
    : matte(0xc5c3c1);
  const frameMaterial = matte(0xb6b5b5);
  const frameEdgeMaterial = matte(0x8f9090);
  const glassMaterial = new THREE.MeshBasicMaterial({ color: 0x1d1e21, side: THREE.DoubleSide });
  const shadowMaterial = matte(0x676965);

  function quad(name, corners, material, patch) {
    const points = corners.map(([x, y, depth]) => project(x, y, depth));
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(points.flatMap(p => p.toArray()), 3));
    geometry.setIndex([0, 1, 2, 0, 2, 3]);
    if (patch) {
      const [left, top, right, bottom] = patch;
      geometry.setAttribute('uv', new THREE.Float32BufferAttribute([
        left / 1284, 1 - top / 873,
        right / 1284, 1 - top / 873,
        right / 1284, 1 - bottom / 873,
        left / 1284, 1 - bottom / 873,
      ], 2));
    }
    geometry.computeVertexNormals();
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = name;
    mesh.receiveShadow = true;
    room.add(mesh);
    return mesh;
  }

  function rectangle(name, left, top, right, bottom, depth, material, patch) {
    return quad(name, [
      [left, top, depth], [right, top, depth],
      [right, bottom, depth], [left, bottom, depth],
    ], material, patch);
  }

  // An actual six-sided solid rather than a painted frame on the glass.
  function beam(name, left, top, right, bottom, depth, thickness, material = frameMaterial) {
    const corners = [
      [left, top], [right, top], [right, bottom], [left, bottom],
    ];
    const points = [depth, depth + thickness].flatMap(z =>
      corners.flatMap(([x, y]) => project(x, y, z).toArray()));
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(points, 3));
    geometry.setIndex([
      0, 1, 2, 0, 2, 3,
      7, 6, 5, 7, 5, 4,
      0, 4, 5, 0, 5, 1,
      1, 5, 6, 1, 6, 2,
      2, 6, 7, 2, 7, 3,
      3, 7, 4, 3, 4, 0,
    ]);
    geometry.computeVertexNormals();
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = name;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    room.add(mesh);
    return mesh;
  }

  // Extend the architecture outside the circular photo crop so it fills every
  // aspect ratio. The visible vertical corner remains at the reference x=847.
  rectangle('Back wall', -4000, 184, 850, 4000, 0.57, wallMaterial, [728, 217, 832, 310]);
  quad('Ceiling', [
    [-4000, -4000, 0.16], [4000, -650, 0.19],
    [847, 198, 0.57], [-4000, 183, 0.57],
  ], wallMaterial, [550, 58, 735, 126]);
  quad('Right wall', [
    [847, 198, 0.57], [4000, -650, 0.19],
    [4000, 4000, 0.19], [847, 4000, 0.57],
  ], wallMaterial, [883, 300, 977, 534]);

  // The reference is a night interior with broad painted double-door frames.
  rectangle('Window recess', 195, 319, 776, 1650, 0.547, shadowMaterial);
  rectangle('Left glass pane', 219, 347, 411, 1630, 0.536, glassMaterial);
  rectangle('Right glass pane', 428, 358, 747, 1630, 0.536, glassMaterial);
  beam('Door outer left reveal', 194, 319, 215, 1650, 0.507, 0.04, frameEdgeMaterial);
  beam('Door outer right reveal', 754, 331, 776, 1650, 0.507, 0.04, frameEdgeMaterial);
  beam('Door top reveal', 194, 319, 776, 339, 0.507, 0.04, frameEdgeMaterial);
  beam('Door left jamb', 207, 337, 231, 1650, 0.493, 0.044);
  beam('Door top rail', 210, 337, 760, 367, 0.49, 0.047);
  beam('Door center mullion', 395, 343, 429, 1650, 0.489, 0.047);
  beam('Door right jamb', 724, 350, 759, 1650, 0.493, 0.043);
  beam('Left frame inner lip', 230, 366, 237, 1650, 0.509, 0.021, frameEdgeMaterial);
  beam('Right frame inner lip', 716, 367, 725, 1650, 0.509, 0.021, frameEdgeMaterial);

  // Muted reflected strips and tiny distant lights retain the dark window's
  // character without introducing a second copy of either photographed person.
  const reflection = new THREE.MeshBasicMaterial({ color: 0x73858b, transparent: true, opacity: 0.12, side: THREE.DoubleSide, depthWrite: false });
  const softReflection = new THREE.MeshBasicMaterial({ color: 0x688896, transparent: true, opacity: 0.075, side: THREE.DoubleSide, depthWrite: false });
  quad('Left glass reflection', [[341, 369, 0.531], [363, 369, 0.531], [390, 743, 0.531], [353, 743, 0.531]], reflection);
  quad('Broad window reflection', [[449, 369, 0.53], [490, 369, 0.53], [480, 794, 0.53], [438, 794, 0.53]], softReflection);
  const lightMaterial = new THREE.MeshBasicMaterial({ color: 0xffd897 });
  for (const [x, y, radius] of [[299, 462, 2.8], [339, 461, 1.8], [380, 466, 2.4], [421, 465, 1.8]]) {
    const center = project(x, y, 0.529);
    const size = center.distanceTo(project(x + radius, y, 0.529));
    const bulb = new THREE.Mesh(new THREE.SphereGeometry(size, 8, 6), lightMaterial);
    bulb.name = 'Distant warm window light';
    bulb.position.copy(center);
    room.add(bulb);
  }

  const plant = new THREE.Group();
  plant.name = 'Dark leafy plant behind right shoulder';
  room.add(plant);
  const leafMaterials = [matte(0x151d13), matte(0x1c2618), matte(0x11190f)];
  const stemMaterial = matte(0x273023);

  function stem(from, to) {
    const a = project(...from);
    const b = project(...to);
    const middle = a.clone().lerp(b, 0.5);
    middle.x += 0.003;
    const curve = new THREE.QuadraticBezierCurve3(a, middle, b);
    const mesh = new THREE.Mesh(new THREE.TubeGeometry(curve, 12, 0.0008, 5, false), stemMaterial);
    mesh.name = 'Curved plant stem';
    plant.add(mesh);
  }

  // A leaf is a curved tapered surface with a raised midrib, built from 96
  // triangles. Each has its own depth and does not rely on a flat sprite.
  function leaf(base, tip, width, bend, materialIndex) {
    const dx = tip[0] - base[0], dy = tip[1] - base[1];
    const length = Math.hypot(dx, dy);
    const nx = -dy / length, ny = dx / length;
    const rows = 12, columns = 4;
    const positions = [], indices = [];
    for (let row = 0; row <= rows; row++) {
      const t = row / rows;
      const curve = Math.sin(Math.PI * t);
      const halfWidth = width * Math.pow(curve, 0.9);
      for (let col = 0; col <= columns; col++) {
        const across = col / columns * 2 - 1;
        const x = base[0] + dx * t + nx * (halfWidth * across + bend * curve);
        const y = base[1] + dy * t + ny * (halfWidth * across + bend * curve);
        const depth = base[2] + (tip[2] - base[2]) * t - 0.006 * curve * (1 - across * across);
        positions.push(...project(x, y, depth).toArray());
        if (row < rows && col < columns) {
          const i = row * (columns + 1) + col;
          indices.push(i, i + 1, i + columns + 1, i + 1, i + columns + 2, i + columns + 1);
        }
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    const mesh = new THREE.Mesh(geometry, leafMaterials[materialIndex % leafMaterials.length]);
    mesh.name = 'Curved tapered leaf';
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    plant.add(mesh);
  }

  stem([791, 718, 0.38], [770, 470, 0.36]);
  stem([786, 610, 0.367], [826, 535, 0.346]);
  stem([785, 583, 0.369], [746, 486, 0.345]);
  const leaves = [
    [[775, 487, 0.36], [788, 433, 0.34], 8, -3],
    [[773, 510, 0.355], [737, 457, 0.338], 12, 2],
    [[786, 526, 0.35], [787, 468, 0.337], 10, 7],
    [[789, 548, 0.355], [817, 514, 0.336], 9, -4],
    [[799, 561, 0.349], [847, 522, 0.332], 8, 4],
    [[785, 550, 0.36], [747, 497, 0.339], 11, -4],
    [[793, 579, 0.36], [840, 562, 0.34], 7, -3],
    [[788, 599, 0.367], [753, 548, 0.346], 9, 3],
  ];
  leaves.forEach(([base, tip, width, bend], i) => leaf(base, tip, width, bend, i));

  return room;
}
