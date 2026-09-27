// cyber-probe 世界：地形高度场、地面、光照、天空、低模道具（围栏/鸡舍/饲料槽/草垛/树/石）、远景山丘、草丛。
// 几何比例、配色、光照强度与阴影参数对齐参考站观感（代码为本项目自有实现，不含任何隐私数据）。

import * as THREE from 'three';

export const WORLD_HALF = 26;      // 场地半宽（正方形 -26..26）
export const BOUNDS = WORLD_HALF;

// 小山坡：高斯高度场（渲染、本地预测、联机服三处必须一致）
const HILL = { x: 14, z: 13, h: 2.4, sigma2: 30 };
export function groundHeight(x, z) {
  const dx = x - HILL.x, dz = z - HILL.z;
  return HILL.h * Math.exp(-(dx * dx + dz * dz) / HILL.sigma2);
}

// 固定种子伪随机：装饰物每次刷新位置一致，画面稳定
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 草地贴图：基色 + 大小不一的椭圆色斑，比纯色平铺有层次
function groundTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 512;
  const g = c.getContext('2d');
  g.fillStyle = '#7fae46';
  g.fillRect(0, 0, 512, 512);
  const rand = mulberry32(7);
  for (let i = 0; i < 500; i++) {
    const x = rand() * 512, y = rand() * 512, r = 4 + rand() * 26;
    g.fillStyle = rand() < 0.5 ? 'rgba(106,154,60,0.35)' : 'rgba(148,190,90,0.3)';
    g.beginPath(); g.ellipse(x, y, r, r * (0.5 + rand() * 0.5), rand() * 3.14, 0, 6.29); g.fill();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(6, 6);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

const MAT = {
  fence: new THREE.MeshLambertMaterial({ color: 0x9a6a3a }),
  fenceTop: new THREE.MeshLambertMaterial({ color: 0x7a5230 }),
  coopWall: new THREE.MeshLambertMaterial({ color: 0xb5553d }),
  coopRoof: new THREE.MeshLambertMaterial({ color: 0x6b4a3a }),
  coopDoor: new THREE.MeshLambertMaterial({ color: 0x3a2a20 }),
  coopTrim: new THREE.MeshLambertMaterial({ color: 0xf0e6d0 }),
  trough: new THREE.MeshLambertMaterial({ color: 0x8a7a5a }),
  water: new THREE.MeshLambertMaterial({ color: 0x5aa7d6 }),
  hay: new THREE.MeshLambertMaterial({ color: 0xd8b95a }),
  trunk: new THREE.MeshLambertMaterial({ color: 0x7a5230 }),
  leaf: new THREE.MeshLambertMaterial({ color: 0x4e8f3a }),
  leaf2: new THREE.MeshLambertMaterial({ color: 0x5da344 }),
  rock: new THREE.MeshLambertMaterial({ color: 0x9a9a92, flatShading: true }),
  hill: new THREE.MeshLambertMaterial({ color: 0x6f9e4b }),
  grass: new THREE.MeshLambertMaterial({ color: 0x6da33f }),
};

// 静态障碍物（轴对齐盒子）：渲染与本地碰撞共用
export function buildObstacles() {
  const o = [];
  const box = (type, x, z, w, d, h) => o.push({ type, x, z, w, d, h });
  const t = 0.4;
  box('fence', 0, -WORLD_HALF, WORLD_HALF * 2 + t, t, 1.1);
  box('fence', 0, WORLD_HALF, WORLD_HALF * 2 + t, t, 1.1);
  box('fence', -WORLD_HALF, 0, t, WORLD_HALF * 2 + t, 1.1);
  box('fence', WORLD_HALF, 0, t, WORLD_HALF * 2 + t, 1.1);
  box('coop', -11, -9, 7, 5.5, 3.2);          // 鸡舍
  box('trough', 9, 11, 2.6, 0.9, 0.55);       // 饲料槽
  box('hay', 6, -12, 1.7, 1.7, 1.5);          // 草垛
  box('hay', -15, 10, 1.7, 1.7, 1.5);
  box('hay', 13, 3, 1.7, 1.7, 1.5);
  for (const [x, z] of [[16, 15], [-18, -15], [19, -7], [-6, 17], [-19, 4]]) box('tree', x, z, 0.7, 0.7, 2.6);
  box('rock', 1, 15, 1.6, 1.4, 0.9);
  box('rock', -8, -1, 1.2, 1.1, 0.7);
  box('rock', 11, -16, 1.8, 1.5, 1.0);
  return o;
}

function buildObstacleMesh(o) {
  const grp = new THREE.Group();
  const add = (geo, mat, x, y, z) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.castShadow = m.receiveShadow = true;
    grp.add(m);
    return m;
  };

  switch (o.type) {
    case 'fence': {
      const horizontal = o.w > o.d;
      const len = horizontal ? o.w : o.d;
      add(new THREE.BoxGeometry(horizontal ? len : 0.12, o.h, horizontal ? 0.12 : len), MAT.fence, 0, o.h / 2, 0);
      const rail = new THREE.Mesh(
        new THREE.BoxGeometry(horizontal ? len : 0.08, 0.09, horizontal ? 0.08 : len), MAT.fenceTop);
      rail.position.set(0, o.h - 0.05, 0);
      rail.castShadow = true;
      grp.add(rail);
      const n = Math.max(2, Math.round(len / 3));
      for (let i = 0; i <= n; i++) {
        const t = -len / 2 + (len / n) * i;
        const post = new THREE.Mesh(new THREE.BoxGeometry(0.18, o.h + 0.15, 0.18), MAT.fenceTop);
        post.position.set(horizontal ? t : 0, (o.h + 0.15) / 2, horizontal ? 0 : t);
        post.castShadow = true;
        grp.add(post);
      }
      break;
    }
    case 'coop': {
      add(new THREE.BoxGeometry(o.w, o.h, o.d), MAT.coopWall, 0, o.h / 2, 0);
      const roofL = new THREE.Mesh(new THREE.BoxGeometry(o.w * 0.62, 0.18, o.d + 0.5), MAT.coopRoof);
      roofL.position.set(-o.w * 0.24, o.h + 0.42, 0);
      roofL.rotation.z = 0.5; roofL.castShadow = true;
      grp.add(roofL);
      const roofR = roofL.clone();
      roofR.position.x = o.w * 0.24;
      roofR.rotation.z = -0.5;
      grp.add(roofR);
      add(new THREE.BoxGeometry(1.1, 1.6, 0.1), MAT.coopDoor, 0, 0.8, o.d / 2 + 0.02);
      add(new THREE.BoxGeometry(o.w + 0.2, 0.16, o.d + 0.2), MAT.coopTrim, 0, 0.08, 0);
      break;
    }
    case 'trough': {
      add(new THREE.BoxGeometry(o.w, o.h, o.d), MAT.trough, 0, o.h / 2, 0);
      const water = new THREE.Mesh(new THREE.BoxGeometry(o.w - 0.3, 0.06, o.d - 0.3), MAT.water);
      water.position.set(0, o.h, 0);
      grp.add(water);
      break;
    }
    case 'hay':
      add(new THREE.BoxGeometry(o.w, o.h, o.d), MAT.hay, 0, o.h / 2, 0);
      break;
    case 'tree': {
      add(new THREE.CylinderGeometry(0.22, 0.3, o.h, 7), MAT.trunk, 0, o.h / 2, 0);
      const s1 = new THREE.Mesh(new THREE.IcosahedronGeometry(1.5, 0), MAT.leaf);
      s1.position.set(0, o.h + 0.7, 0); s1.castShadow = true;
      const s2 = new THREE.Mesh(new THREE.IcosahedronGeometry(1.05, 0), MAT.leaf2);
      s2.position.set(0.5, o.h + 1.4, 0.3); s2.castShadow = true;
      const s3 = new THREE.Mesh(new THREE.IcosahedronGeometry(0.9, 0), MAT.leaf2);
      s3.position.set(-0.55, o.h + 1.2, -0.35); s3.castShadow = true;
      grp.add(s1, s2, s3);
      break;
    }
    case 'rock': {
      const r = new THREE.Mesh(new THREE.DodecahedronGeometry(o.w / 2, 0), MAT.rock);
      r.position.set(0, o.h / 2, 0);
      r.scale.y = o.h / (o.w / 2) * 0.6;
      r.castShadow = r.receiveShadow = true;
      grp.add(r);
      break;
    }
  }
  grp.position.set(o.x, groundHeight(o.x, o.z), o.z);
  return grp;
}

export function buildScene(renderer) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xa8d8f0);
  scene.fog = new THREE.Fog(0xa8d8f0, 45, 110);

  const camera = new THREE.PerspectiveCamera(62, innerWidth / innerHeight, 0.1, 220);

  const hemi = new THREE.HemisphereLight(0xcfe6ff, 0x8a9a5a, 0.95);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xfff2d8, 1.6);
  sun.position.set(24, 34, 12);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -34; sun.shadow.camera.right = 34;
  sun.shadow.camera.top = 34; sun.shadow.camera.bottom = -34;
  sun.shadow.camera.far = 90;
  sun.shadow.bias = -0.0004;
  // 阴影压淡一点（r165+ 的 shadow.intensity）：原本硬邦邦的深色多边形阴影会正好落在名牌背后，
  // 看着像卡片被切开/血条坏了（用户反馈过；射线检测确认那里没有网格，是渲染出来的阴影）
  if ('intensity' in sun.shadow) sun.shadow.intensity = 0.55;
  scene.add(sun);

  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const obstacles = buildObstacles();
  const boxObstacles = obstacles.map((o) => ({ x: o.x, z: o.z, hx: o.w / 2, hz: o.d / 2, h: o.h }));

  // ---- 地面：110 段位移网格，跟着高度场起伏 ----
  const geo = new THREE.PlaneGeometry(WORLD_HALF * 2 + 60, WORLD_HALF * 2 + 60, 110, 110);
  const pos = geo.attributes.position;
  // PlaneGeometry 在 XY 平面，rotateX(-90°) 后 y→z，所以高度取 groundHeight(x, -y)
  for (let i = 0; i < pos.count; i++) pos.setZ(i, groundHeight(pos.getX(i), -pos.getY(i)));
  geo.computeVertexNormals();
  const ground = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ map: groundTexture() }));
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  for (const o of obstacles) scene.add(buildObstacleMesh(o));

  // ---- 围栏外的远景山丘（装饰，靠雾与天空衔接） ----
  const rand = mulberry32(42);
  for (let i = 0; i < 9; i++) {
    const ang = (i / 9) * Math.PI * 2 + rand() * 0.5;
    const dist = WORLD_HALF + 14 + rand() * 18;
    const hill = new THREE.Mesh(new THREE.SphereGeometry(7 + rand() * 8, 12, 8), MAT.hill);
    hill.position.set(Math.cos(ang) * dist, -2.5, Math.sin(ang) * dist);
    hill.scale.y = 0.55;
    hill.receiveShadow = true;
    scene.add(hill);
  }

  // ---- 草丛：实例化圆锥，随地形贴地 ----
  const blades = new THREE.InstancedMesh(new THREE.ConeGeometry(0.05, 0.34, 4), MAT.grass, 240);
  const dummy = new THREE.Object3D();
  for (let i = 0; i < 240; i++) {
    const gx = (rand() * 2 - 1) * (WORLD_HALF - 1.5);
    const gz = (rand() * 2 - 1) * (WORLD_HALF - 1.5);
    dummy.position.set(gx, groundHeight(gx, gz) + 0.16, gz);
    dummy.rotation.y = rand() * 3.14;
    dummy.scale.setScalar(0.7 + rand() * 0.9);
    dummy.updateMatrix();
    blades.setMatrixAt(i, dummy.matrix);
  }
  blades.castShadow = true;
  scene.add(blades);

  return { scene, camera, obstacles: [], boxObstacles, sun };
}

/** 圆柱 + 方形障碍的简易推开；越界夹回场地内。返回修正后的 [x, z] */
export function resolveCollision(x, z, radius, obstacles, boxObstacles) {
  for (const o of obstacles || []) {
    const dx = x - o.x, dz = z - o.z;
    const d = Math.hypot(dx, dz), min = o.r + radius;
    if (d < min && d > 1e-4) { x = o.x + dx / d * min; z = o.z + dz / d * min; }
  }
  for (const b of boxObstacles || []) {
    const dx = x - b.x, dz = z - b.z;
    const ox = b.hx + radius - Math.abs(dx);
    const oz = b.hz + radius - Math.abs(dz);
    if (ox > 0 && oz > 0) {
      if (ox < oz) x = b.x + Math.sign(dx || 1) * (b.hx + radius);
      else z = b.z + Math.sign(dz || 1) * (b.hz + radius);
    }
  }
  x = Math.max(-BOUNDS + 0.8, Math.min(BOUNDS - 0.8, x));
  z = Math.max(-BOUNDS + 0.8, Math.min(BOUNDS - 0.8, z));
  return [x, z];
}
