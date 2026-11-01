// cyber-probe 世界：地形高度场、地面、光照、天空、低模道具（围栏/鸡舍/饲料槽/草垛/树/石/水井/菜园/稻草人/风车）、远景、草丛与野花。
// 几何比例、配色、光照强度与阴影参数对齐参考站观感（代码为本项目自有实现，不含任何隐私数据）。
//
// ⚠ 静态零件全部按材质合进少量 BufferGeometry（mergeGeos）：道具变多但 draw call 反而比原来少，
//   手机上不会因为“场景更丰富”而掉帧。改这里不用管 draw call 数量，只要别把每件道具做成独立 Mesh。

import * as THREE from 'three';

export const WORLD_HALF = 26;      // 场地半宽（正方形 -26..26）
export const BOUNDS = WORLD_HALF;

// 小山坡：高斯高度场（渲染、本地预测、联机服三处必须一致）
const HILL = { x: 14, z: 13, h: 2.4, sigma2: 30 };
export function groundHeight(x, z) {
  const dx = x - HILL.x, dz = z - HILL.z;
  return HILL.h * Math.exp(-(dx * dx + dz * dz) / HILL.sigma2);
}

// 菜园三畦（渲染、障碍表、作物摆放共用同一组数）
const GARDEN = { x: 17.5, zs: [5.6, 8.2, 10.8], w: 7, d: 1.6 };

// ⚠ 菜园正好压在小山包的坡上：一整条 7m 的平畦必然「下坡侧悬空、上坡侧埋进土里」（用户报过两次）
//   → 按 ~1.75m 一段做成梯田，每段各自拿「四角最高地面」当畦面、最低地面当土体底面。
const GARDEN_SEG = 1.75;
const GARDEN_BEDS = (() => {
  const out = [];
  const n = Math.max(1, Math.round(GARDEN.w / GARDEN_SEG));
  const seg = GARDEN.w / n;
  for (const z of GARDEN.zs) {
    for (let i = 0; i < n; i++) {
      const x0 = GARDEN.x - GARDEN.w / 2 + i * seg, x1 = x0 + seg;
      let gmin = 1e9, gmax = -1e9;
      for (const [px, pz] of [[x0, z - GARDEN.d / 2], [x1, z - GARDEN.d / 2],
        [x0, z + GARDEN.d / 2], [x1, z + GARDEN.d / 2], [(x0 + x1) / 2, z]]) {
        const g = groundHeight(px, pz);
        gmin = Math.min(gmin, g);
        gmax = Math.max(gmax, g);
      }
      out.push({ x0, x1, cx: (x0 + x1) / 2, z, top: gmax + 0.2, bot: gmin - 0.1 });
    }
  }
  return out;
})();
/** 畦面高度：作物要坐在畦面上（直接用裸地形高度会穿出土面 / 悬在土面上） */
function gardenSurface(x, z) {
  for (const b of GARDEN_BEDS) {
    if (Math.abs(z - b.z) <= GARDEN.d / 2 + 0.1 && x >= b.x0 - 0.2 && x <= b.x1 + 0.2) return b.top;
  }
  return groundHeight(x, z) + 0.2;
}

// 土路折线（主路：鸡舍门口 → 场地中央 → 饲料槽；支线：主路 → 菜园）
const PATH_MAIN = [[-11, -6.2], [-9.2, -3.8], [-6.0, -1.0], [-1.4, 2.4], [3.2, 6.2], [7.4, 9.4], [9, 10.7]];
const PATH_BRANCH = [[3.2, 6.2], [6.6, 5.6], [10.2, 5.1], [13.6, 4.9], [15.2, 4.7]];
const PATH_WELL = [[-1.4, 2.4], [-2.1, -4.0], [-2.4, -9.5], [-2.1, -14.5], [-2, -16.4]];
// 大门 → 中央岔路口：让右栅栏的门有路可走，场地形成一条环线
const PATH_GATE = [[24.4, -2], [19.2, -1.2], [13.6, 0.8], [8.2, 3.4], [3.2, 6.2]];
// 菜园西侧绕回饲料槽：和主路接上，形成一条环线
const PATH_LOOP = [[15.2, 4.7], [12.8, 6.6], [12.0, 9.2], [9, 10.7]];
// 大门 → 围栏外的邻居家（门前小路，让那栋房子不再是"孤零零一个盒子"）
const PATH_NEIGHBOR = [[25.9, -2.2], [27.3, -4.5], [28.5, -6.5], [29.5, -7.9]];
const PATH_ALL = [PATH_MAIN, PATH_BRANCH, PATH_WELL, PATH_GATE, PATH_LOOP, PATH_NEIGHBOR];

// 岔路口那片碎石场院的范围（草/花/落叶要避开，否则草从场院里钻出来）
function inYard(x, z) {
  const dx = (x - 3.6) / 6.2, dz = (z - 5.6) / 4.4;
  return dx * dx + dz * dz < 1;
}

// 点到折线的最近距离（草和花要避开路面，不然草会从土路里长出来）
function distToPath(x, z) {
  let best = 1e9;
  for (const pts of PATH_ALL) {
    for (let i = 0; i < pts.length - 1; i++) {
      const [x1, z1] = pts[i], [x2, z2] = pts[i + 1];
      const dx = x2 - x1, dz = z2 - z1;
      const L2 = dx * dx + dz * dz || 1;
      const t = Math.max(0, Math.min(1, ((x - x1) * dx + (z - z1) * dz) / L2));
      best = Math.min(best, Math.hypot(x - (x1 + dx * t), z - (z1 + dz * t)));
    }
  }
  return best;
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
const GROUND_BASE = { spring: '#84b24a', summer: '#7fae46', autumn: '#95a34c', winter: '#a3ab93' };
function groundTexture(season) {
  const c = document.createElement('canvas');
  c.width = c.height = 512;
  const g = c.getContext('2d');
  g.fillStyle = GROUND_BASE[season] || GROUND_BASE.summer;
  g.fillRect(0, 0, 512, 512);
  const rand = mulberry32(7);
  for (let i = 0; i < 500; i++) {
    const x = rand() * 512, y = rand() * 512, r = 4 + rand() * 26;
    g.fillStyle = rand() < 0.5 ? 'rgba(106,154,60,0.27)' : 'rgba(148,190,90,0.3)';
    g.beginPath(); g.ellipse(x, y, r, r * (0.5 + rand() * 0.5), rand() * 3.14, 0, 6.29); g.fill();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(6, 6);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// 土路贴图：土黄底 + 细碎砂石，两侧压深一点（踩实的车辙）
function dirtTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#ab8859';
  g.fillRect(0, 0, 256, 256);
  const rand = mulberry32(23);
  for (let i = 0; i < 700; i++) {
    const x = rand() * 256, y = rand() * 256, r = 0.8 + rand() * 5;
    g.fillStyle = rand() < 0.5 ? 'rgba(138,106,68,0.45)' : 'rgba(200,172,126,0.42)';
    g.beginPath(); g.arc(x, y, r, 0, 6.29); g.fill();
  }
  // 两侧压深一点，再把最外缘擦成透明（羽化边，避免路是一条硬边色块）
  const grdL = g.createLinearGradient(0, 0, 30, 0);
  grdL.addColorStop(0, 'rgba(112,92,52,0.5)'); grdL.addColorStop(1, 'rgba(112,92,52,0)');
  g.fillStyle = grdL; g.fillRect(0, 0, 30, 256);
  const grdR = g.createLinearGradient(256, 0, 226, 0);
  grdR.addColorStop(0, 'rgba(112,92,52,0.5)'); grdR.addColorStop(1, 'rgba(112,92,52,0)');
  g.fillStyle = grdR; g.fillRect(226, 0, 30, 256);
  g.globalCompositeOperation = 'destination-out';
  const fadeL = g.createLinearGradient(0, 0, 34, 0);
  fadeL.addColorStop(0, 'rgba(0,0,0,1)'); fadeL.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = fadeL; g.fillRect(0, 0, 34, 256);
  const fadeR = g.createLinearGradient(256, 0, 222, 0);
  fadeR.addColorStop(0, 'rgba(0,0,0,1)'); fadeR.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = fadeR; g.fillRect(222, 0, 34, 256);
  // 边缘再啃一些随机缺口，路沿就不会是一条干净的直线
  for (let i = 0; i < 90; i++) {
    const side = i % 2 ? 0 : 256;
    const y = (i * 37.7) % 256;
    const r = 3 + ((i * 13) % 9);
    g.beginPath();
    g.arc(side + (side === 0 ? 1 : -1) * (4 + ((i * 7) % 26)), y, r, 0, 6.29);
    g.fillStyle = 'rgba(0,0,0,0.85)';
    g.fill();
  }
  g.globalCompositeOperation = 'source-over';
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// 农田贴图：麦垄条纹 + 颗粒（围栏外的田块用）
function fieldTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#c6ad5c';
  g.fillRect(0, 0, 256, 256);
  const rand = mulberry32(31);
  for (let i = 0; i < 256; i += 10) {
    g.fillStyle = (i / 10) % 2 ? 'rgba(166,140,64,0.55)' : 'rgba(226,205,126,0.45)';
    g.fillRect(i, 0, 5, 256);
  }
  for (let i = 0; i < 260; i++) {
    g.fillStyle = 'rgba(150,130,60,0.22)';
    g.fillRect(rand() * 256, rand() * 256, 2 + rand() * 6, 1 + rand() * 3);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// 碎石场院贴图（岔路口那片踩实的院子）
function yardTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#b09a72';
  g.fillRect(0, 0, 256, 256);
  const rand = mulberry32(57);
  for (let i = 0; i < 420; i++) {
    const x = rand() * 256, y = rand() * 256, r = 1.5 + rand() * 6;
    g.fillStyle = rand() < 0.5 ? 'rgba(150,132,98,0.5)' : 'rgba(206,190,158,0.45)';
    g.beginPath(); g.ellipse(x, y, r, r * 0.7, rand() * 3.14, 0, 6.29); g.fill();
  }
  // 径向羽化：外缘擦成透明，和草地自然过渡（硬边矩形一眼假）
  g.globalCompositeOperation = 'destination-out';
  const fade = g.createRadialGradient(128, 128, 60, 128, 128, 128);
  fade.addColorStop(0, 'rgba(0,0,0,0)');
  fade.addColorStop(0.6, 'rgba(0,0,0,0.45)');
  fade.addColorStop(1, 'rgba(0,0,0,1)');
  g.fillStyle = fade; g.fillRect(0, 0, 256, 256);
  // 沿边缘啃出不规则缺口（不然还是一圈干净的椭圆）
  for (let i = 0; i < 110; i++) {
    const a = (i * 2.399) % 6.283;
    const rr = 100 + ((i * 29) % 34);
    g.beginPath();
    g.arc(128 + Math.cos(a) * rr, 128 + Math.sin(a) * rr * 0.72, 6 + ((i * 11) % 12), 0, 6.29);
    g.fillStyle = 'rgba(0,0,0,0.9)';
    g.fill();
  }
  g.globalCompositeOperation = 'source-over';
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// 软边土斑：鸡舍门口、水井边、饲料槽前那种被踩秃的地面
function patchTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(64, 64, 8, 64, 64, 62);
  grd.addColorStop(0, 'rgba(126,98,58,0.62)');
  grd.addColorStop(0.55, 'rgba(126,98,58,0.34)');
  grd.addColorStop(1, 'rgba(126,98,58,0)');
  g.fillStyle = grd;
  g.beginPath(); g.arc(64, 64, 63, 0, 6.29); g.fill();
  const tex = new THREE.CanvasTexture(c);
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
  waterDeep: new THREE.MeshLambertMaterial({ color: 0x2d6f97 }),
  waterLight: new THREE.MeshLambertMaterial({ color: 0x93d6ef }),
  hay: new THREE.MeshLambertMaterial({ color: 0xd8b95a }),
  hayDark: new THREE.MeshLambertMaterial({ color: 0xb08f3c }),
  trunk: new THREE.MeshLambertMaterial({ color: 0x7a5230 }),
  leaf: new THREE.MeshLambertMaterial({ color: 0x4e8f3a }),
  leaf2: new THREE.MeshLambertMaterial({ color: 0x5da344 }),
  rock: new THREE.MeshLambertMaterial({ color: 0x9a9a92, flatShading: true }),
  hill: new THREE.MeshLambertMaterial({ color: 0x6f9e4b }),
  grass: new THREE.MeshLambertMaterial({ color: 0x6da33f }),
  // ---- 农场道具 ----
  plank: new THREE.MeshLambertMaterial({ color: 0xa9834f }),
  plankDark: new THREE.MeshLambertMaterial({ color: 0x7d5c36 }),
  stone: new THREE.MeshLambertMaterial({ color: 0x8f8b80, flatShading: true }),
  soil: new THREE.MeshLambertMaterial({ color: 0x6b4a30 }),
  soilDark: new THREE.MeshLambertMaterial({ color: 0x553a24 }),
  crop: new THREE.MeshLambertMaterial({ color: 0x5fa83c, flatShading: true }),
  corn: new THREE.MeshLambertMaterial({ color: 0x86a84a, flatShading: true }),
  cloth: new THREE.MeshLambertMaterial({ color: 0xc0503f }),
  cloth2: new THREE.MeshLambertMaterial({ color: 0x4a6fa8 }),
  metal: new THREE.MeshLambertMaterial({ color: 0x8a8f96 }),
  white: new THREE.MeshLambertMaterial({ color: 0xf2efe6 }),
  glass: new THREE.MeshLambertMaterial({ color: 0x2f4a5a }),
  petal: new THREE.MeshLambertMaterial({ color: 0xf2c33a }),
  petalCore: new THREE.MeshLambertMaterial({ color: 0x5a3a1e }),
  wallFar: new THREE.MeshLambertMaterial({ color: 0xe8e0cc }),
  roofFar: new THREE.MeshLambertMaterial({ color: 0x8a4a3f }),
  silo: new THREE.MeshLambertMaterial({ color: 0xc9c6bd }),
  cloud: new THREE.MeshLambertMaterial({ color: 0xffffff, emissive: 0x8899aa, emissiveIntensity: 0.12 }),
  apple: new THREE.MeshLambertMaterial({ color: 0xc23b2e }),
  wheat: new THREE.MeshLambertMaterial({ color: 0xd9bf6a }),
  pumpkin: new THREE.MeshLambertMaterial({ color: 0xd97a2a, flatShading: true }),
  lamp: new THREE.MeshLambertMaterial({ color: 0xffd27a, emissive: 0xffb347, emissiveIntensity: 0.85 }),
  duckBrown: new THREE.MeshLambertMaterial({ color: 0x9a7a52 }),
  duckGreen: new THREE.MeshLambertMaterial({ color: 0x2f6b4a }),
};

// 共用单位几何（用缩放拼尺寸，省内存也省 GC）
const G = {
  box: new THREE.BoxGeometry(1, 1, 1),
  cyl8: new THREE.CylinderGeometry(1, 1, 1, 8),
  cyl10: new THREE.CylinderGeometry(1, 1, 1, 10),
  cyl12: new THREE.CylinderGeometry(1, 1, 1, 12),
  cone6: new THREE.ConeGeometry(1, 1, 6),
  cone8: new THREE.ConeGeometry(1, 1, 8),
  ico: new THREE.IcosahedronGeometry(1, 0),
  planeFlat: new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
};

// ---------- 几何合并 ----------
// 把同材质的静态零件合进一个 BufferGeometry：几百个小方块只占一次 draw call（手机上更稳）。
function mergeGeos(items) {
  const geos = [];
  for (const it of items) {
    const g = it.geo.index ? it.geo.toNonIndexed() : it.geo.clone();
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(
      it.rot ? it.rot[0] : 0, it.rot ? it.rot[1] : 0, it.rot ? it.rot[2] : 0));
    m.compose(
      new THREE.Vector3(...(it.pos || [0, 0, 0])),
      q,
      new THREE.Vector3(...(it.scale || [1, 1, 1])));
    g.applyMatrix4(m);
    geos.push(g);
  }
  let count = 0;
  for (const g of geos) count += g.attributes.position.count;
  const pos = new Float32Array(count * 3);
  const nor = new Float32Array(count * 3);
  const uv = new Float32Array(count * 2);
  let o3 = 0, o2 = 0;
  for (const g of geos) {
    const n = g.attributes.position.count;
    pos.set(g.attributes.position.array, o3);
    nor.set(g.attributes.normal.array, o3);
    if (g.attributes.uv) uv.set(g.attributes.uv.array, o2);
    o3 += n * 3; o2 += n * 2;
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return out;
}

// 按材质攒零件，最后一次性合并成 mesh
class Deco {
  constructor() { this.by = new Map(); }
  add(key, geo, x = 0, y = 0, z = 0, rot = null, scale = null) {
    let a = this.by.get(key);
    if (!a) { a = []; this.by.set(key, a); }
    a.push({ geo, pos: [x, y, z], rot, scale });
    return this;
  }
  build(scene, opts = {}) {
    const out = [];
    for (const [key, items] of this.by) {
      const mat = MAT[key];
      if (!mat) continue;
      const mesh = new THREE.Mesh(mergeGeos(items), mat);
      mesh.castShadow = opts.cast !== false;
      mesh.receiveShadow = opts.receive !== false;
      scene.add(mesh);
      out.push(mesh);
    }
    return out;
  }
}

// 静态障碍物（轴对齐盒子）：渲染与本地碰撞共用；⚠ 与 server/farm_server.py 的 build_obstacles() 必须逐条一致
export function buildObstacles() {
  const o = [];
  const box = (type, x, z, w, d, h) => o.push({ type, x, z, w, d, h });
  const t = 0.4;
  box('fence', 0, -WORLD_HALF, WORLD_HALF * 2 + t, t, 1.1);
  box('fence', 0, WORLD_HALF, WORLD_HALF * 2 + t, t, 1.1);
  box('fence', -WORLD_HALF, 0, t, WORLD_HALF * 2 + t, 1.1);
  box('fence', WORLD_HALF, 0, t, WORLD_HALF * 2 + t, 1.1);
  box('coop', -11, -9.65, 5.6, 5.2, 3.6);     // 鸡舍（主建筑换成 精细模型后，碰撞按模型体积收）
  box('trough', 9, 11, 2.6, 0.9, 0.55);       // 饲料槽
  box('hay', 6, -12, 1.7, 1.7, 1.5);          // 草垛
  box('hay', -15, 10, 1.7, 1.7, 1.5);
  box('hay', 13, 3, 1.7, 1.7, 1.5);
  box('hay', -17, -12.5, 1.7, 1.7, 1.5);      // 鸡舍左后的一堆
  box('hay', 10.5, 13.5, 1.7, 1.7, 1.5);      // 菜园旁
  for (const [x, z] of [[16, 15], [-18, -15], [19, -7], [-6, 17], [-19, 4]]) box('tree', x, z, 0.7, 0.7, 2.6);
  box('rock', 1, 15, 1.6, 1.4, 0.9);
  box('rock', -8, -1, 1.2, 1.1, 0.7);
  box('rock', 11, -16, 1.8, 1.5, 1.0);
  // ---- 农场道具（新增；碰撞与联机服同表）----
  box('well', -2, -18, 2.4, 2.4, 1.6);                 // 水井
  box('crate', -6.4, -6.2, 1.3, 1.2, 1.3);             // 木箱堆
  box('barrel', -5.4, -7.8, 0.9, 0.9, 0.95);           // 木桶
  for (const z of GARDEN.zs) box('garden', GARDEN.x, z, GARDEN.w, GARDEN.d, 0.32);
  box('scarecrow', 12.8, 8.2, 0.6, 0.6, 2.2);          // 稻草人
  box('barrow', 12.4, 3.3, 1.1, 0.8, 0.9);             // 手推车（挪到支线南侧，别压在路上）
  for (const [x, z] of [[-21, 12.5], [-18, 15.5], [-22, 18.5], [-24, 15.2], [-19.5, 19.5]]) box('tree', x, z, 0.7, 0.7, 2.6);  // 果园
  box('pond', 10, -21, 7.0, 7.0, 0.2);                 // 池塘
  box('woodpile', -15.8, -8.6, 1.4, 1.2, 1.0);         // 柴堆
  box('beehive', 21.2, -1.2, 2.8, 1.4, 1.0);           // 蜂箱
  box('compost', 12.4, 13.2, 2.2, 1.6, 0.7);           // 堆肥（菜园西北角，靠路但不压路）
  box('shed', -20, -6, 4.0, 3.2, 2.4);                 // 草料棚（靠左围栏，别挡住中间的追逐路线）
  box('tractor', 13.5, -6.5, 3.0, 1.8, 1.9);           // 拖拉机
  box('tower', 17.5, -20, 3.2, 3.2, 6.6);              // 瞭望塔（模型 4×4 缩到 0.8）
  box('bench', 17.3, 13.7, 1.7, 0.6, 0.9);             // 树下长椅（造型在 buildScene 里画，这里只占碰撞）
  box('picnic', 20.6, 16.4, 2.0, 1.8, 0.8);            // 野餐桌（同样只占碰撞，模型来自 精细模型）
  box('burro', 16.2, -2.6, 1.6, 1.9, 2.0);             // 驮货的驴（只占碰撞，模型来自 精细模型）
  // 果园矮篱笆：北/南两面（西侧靠主围栏，东侧敞开当入口）
  // ⚠ 东侧不要围：(-18,18) 是浏览器方向用例的"远角空位"，围上会把 W/WASD 两条断言一起弄红
  box('fenceLow', -20.75, 10.5, 8.5, 0.16, 0.6);
  box('fenceLow', -20.75, 21, 8.5, 0.16, 0.6);
  return o;
}

// 单个道具 → 零件（绝对坐标，已含地形高度）
// 这些类型的自建版可以被 精细模型 的精细模型替换（见 js/models.js 的 PLAN）
const SWAP_TYPES = new Set(['tractor', 'well', 'barrow', 'scarecrow', 'crate', 'trough',
  'hay', 'beehive', 'compost', 'bench', 'picnic', 'coop', 'shed', 'tower', 'woodpile', 'burro', 'tree']);

function buildProp(d, o) {
  const y0 = groundHeight(o.x, o.z);
  const x = o.x, z = o.z;
  switch (o.type) {
    case 'fenceLow': {
      // 矮木栅：两根横杆 + 密一点的短桩
      const horizontal = o.w > o.d;
      const len = horizontal ? o.w : o.d;
      d.add('plank', G.box, x, y0 + 0.28, z, null, horizontal ? [len, 0.09, 0.07] : [0.07, 0.09, len]);
      d.add('plank', G.box, x, y0 + 0.5, z, null, horizontal ? [len, 0.09, 0.07] : [0.07, 0.09, len]);
      const n = Math.max(2, Math.round(len / 1.3));
      for (let i = 0; i <= n; i++) {
        const t = -len / 2 + (len / n) * i;
        d.add('plankDark', G.box, horizontal ? x + t : x, y0 + 0.3, horizontal ? z : z + t,
          null, [0.11, 0.6, 0.11]);
      }
      break;
    }
    case 'fence': {
      // 立柱 + 三道横杆 + 斜撑：之前是一整块 1.1m 高的实心板墙，远看就是一道深色屏障
      const horizontal = o.w > o.d;
      const len = horizontal ? o.w : o.d;
      const n = Math.max(2, Math.round(len / 2.6));
      const bay = len / n;
      for (let i = 0; i <= n; i++) {
        const t = -len / 2 + bay * i;
        d.add('fenceTop', G.box, horizontal ? x + t : x, y0 + 0.62, horizontal ? z : z + t, null, [0.19, 1.24, 0.19]);
      }
      for (const ry of [0.32, 0.68, 1.04]) {
        d.add('fence', G.box, x, y0 + ry, z, null, horizontal ? [len, 0.13, 0.1] : [0.1, 0.13, len]);
      }
      // 每三段插一道斜撑（结构感）
      for (let i = 0; i + 1 <= n; i += 3) {
        const t = -len / 2 + bay * (i + 0.5);
        d.add('fenceTop', G.box, horizontal ? x + t : x, y0 + 0.66, horizontal ? z : z + t,
          horizontal ? [0, 0, 0.52] : [0.52, 0, 0], horizontal ? [bay * 1.16, 0.09, 0.08] : [0.08, 0.09, bay * 1.16]);
      }
      break;
    }
    case 'coop': {
      const w = o.w, dep = o.d, h = o.h;
      const halfW = w / 2, halfD = dep / 2;
      // 地面垫料（干草铺底）
      d.add('hayDark', G.box, x, y0 + 0.05, z, null, [w - 0.3, 0.1, dep - 0.3]);
      d.add('hay', G.box, x - 1.1, y0 + 0.13, z + 0.9, [0, 0.4, 0], [3.0, 0.09, 2.2]);
      d.add('hay', G.box, x + 1.7, y0 + 0.13, z - 0.5, [0, -0.5, 0], [1.8, 0.08, 1.6]);
      d.add('wheat', G.box, x - 0.4, y0 + 0.19, z - 1.2, [0, 0.9, 0], [2.6, 0.04, 1.2]);
      d.add('wheat', G.box, x + 1.2, y0 + 0.19, z + 1.6, [0, -0.2, 0], [2.2, 0.04, 1.0]);
      // 三面墙（前脸敞开，能看见里面的栖架与垫料）
      d.add('coopWall', G.box, x, y0 + h / 2, z - halfD + 0.15, null, [w, h, 0.3]);
      d.add('coopWall', G.box, x - halfW + 0.15, y0 + h / 2, z, null, [0.3, h, dep]);
      d.add('coopWall', G.box, x + halfW - 0.15, y0 + h / 2, z, null, [0.3, h, dep]);
      // 前脸：门楣 + 两根立柱
      d.add('coopWall', G.box, x, y0 + h - 0.42, z + halfD - 0.15, null, [w, 0.84, 0.3]);
      d.add('plankDark', G.box, x - halfW + 0.32, y0 + (h - 0.84) / 2, z + halfD - 0.15, null, [0.34, h - 0.84, 0.34]);
      d.add('plankDark', G.box, x + halfW - 0.32, y0 + (h - 0.84) / 2, z + halfD - 0.15, null, [0.34, h - 0.84, 0.34]);
      // 双坡屋顶 + 屋脊 + 檐口
      d.add('coopRoof', G.box, x - w * 0.24, y0 + h + 0.42, z, [0, 0, 0.5], [w * 0.62, 0.18, dep + 0.5]);
      d.add('coopRoof', G.box, x + w * 0.24, y0 + h + 0.42, z, [0, 0, -0.5], [w * 0.62, 0.18, dep + 0.5]);
      d.add('coopTrim', G.box, x, y0 + h + 0.86, z, null, [0.16, 0.1, dep + 0.6]);
      d.add('plankDark', G.box, x, y0 + h - 0.02, z + halfD + 0.04, null, [w + 0.1, 0.12, 0.1]);
      // 墙脚石基
      d.add('coopTrim', G.box, x, y0 + 0.08, z, null, [w + 0.2, 0.16, dep + 0.2]);
      // 两侧墙的木板分缝（打破整块红墙）
      for (const sx of [x - halfW - 0.01, x + halfW + 0.01]) {
        for (const yy of [0.65, 1.15, 1.65, 2.15, 2.65]) {
          d.add('plankDark', G.box, sx, y0 + yy, z, null, [0.03, 0.05, dep - 0.2]);
        }
      }
      // 右墙的小窗（白框 + 深色玻璃 + 十字棂）
      d.add('coopTrim', G.box, x + halfW + 0.02, y0 + 1.95, z - 0.4, null, [0.06, 0.95, 1.05]);
      d.add('glass', G.box, x + halfW + 0.06, y0 + 1.95, z - 0.4, null, [0.05, 0.75, 0.85]);
      d.add('coopTrim', G.box, x + halfW + 0.09, y0 + 1.95, z - 0.4, null, [0.04, 0.75, 0.06]);
      d.add('coopTrim', G.box, x + halfW + 0.09, y0 + 1.95, z - 0.4, null, [0.04, 0.06, 0.85]);
      // ---- 内部：栖架两根（横杆 + 立柱）----
      for (const [ry, rz] of [[1.1, -0.7], [1.45, -1.45]]) {
        d.add('trunk', G.cyl8, x, y0 + ry, z + rz, [0, 0, Math.PI / 2], [0.055, w - 0.9, 0.055]);
        d.add('plankDark', G.box, x - 1.9, y0 + ry / 2, z + rz, null, [0.09, ry, 0.09]);
        d.add('plankDark', G.box, x + 1.9, y0 + ry / 2, z + rz, null, [0.09, ry, 0.09]);
      }
      // ---- 内部：后墙的产蛋箱（三格）----
      d.add('plank', G.box, x + 0.3, y0 + 0.55, z - halfD + 0.85, null, [2.5, 0.7, 0.8]);
      d.add('plankDark', G.box, x + 0.3, y0 + 0.95, z - halfD + 0.85, null, [2.6, 0.08, 0.9]);
      for (let i = 0; i < 3; i++) {
        const hx = x - 0.45 + i * 0.75;
        d.add('coopDoor', G.box, hx, y0 + 0.6, z - halfD + 1.22, null, [0.4, 0.34, 0.22]);
        d.add('plankDark', G.box, hx, y0 + 0.78, z - halfD + 1.34, null, [0.46, 0.05, 0.08]);
        d.add('plankDark', G.box, hx, y0 + 0.42, z - halfD + 1.34, null, [0.46, 0.05, 0.08]);
      }
      // ---- 内部：小料槽 + 吊灯 ----
      d.add('trough', G.box, x + 1.6, y0 + 0.26, z + 1.35, null, [1.4, 0.3, 0.55]);
      d.add('water', G.box, x + 1.6, y0 + 0.28, z + 1.35, null, [1.2, 0.05, 0.35]);
      d.add('plankDark', G.box, x + 1.2, y0 + 2.28, z + 0.6, null, [0.02, 0.44, 0.02]);
      d.add('lamp', G.box, x + 1.2, y0 + 1.98, z + 0.6, null, [0.24, 0.26, 0.24]);
      // 门口坡道 + 散落稻草
      d.add('plank', G.box, x, y0 + 0.14, z + halfD + 0.95, [-0.2, 0, 0], [2.4, 0.08, 1.5]);
      const straw = [[-2.2, 0.55, 0.35], [1.9, 0.75, -0.4], [-1.4, 1.15, 1.1], [2.3, 0.5, 0.9], [-2.6, 0.95, 0.6]];
      for (const [dx, dz, rz] of straw) {
        d.add('hay', G.box, x + dx, y0 + 0.05, z + halfD + dz, [0, rz, 0.05], [0.5, 0.03, 0.06]);
      }
      // 门口外地上的蛋
      for (let i = 0; i < 4; i++) {
        d.add('white', G.ico, x + 2.0 + i * 0.4, y0 + 0.16, z + halfD + 0.7 + (i % 2) * 0.18,
          [0, i, 0], [0.1, 0.14, 0.1]);
      }
      // 门楣下挂的木牌（空白）
      d.add('plank', G.box, x, y0 + 2.15, z + halfD - 0.05, null, [1.5, 0.42, 0.06]);
      d.add('plankDark', G.box, x - 0.55, y0 + 2.45, z + halfD - 0.05, null, [0.03, 0.2, 0.03]);
      d.add('plankDark', G.box, x + 0.55, y0 + 2.45, z + halfD - 0.05, null, [0.03, 0.2, 0.03]);
      break;
    }
    case 'trough': {
      d.add('trough', G.box, x, y0 + o.h / 2, z, null, [o.w, o.h, o.d]);
      d.add('water', G.box, x, y0 + o.h, z, null, [o.w - 0.3, 0.06, o.d - 0.3]);
      d.add('plankDark', G.box, x - o.w / 2 + 0.2, y0 + 0.1, z, null, [0.16, 0.2, o.d + 0.3]);
      d.add('plankDark', G.box, x + o.w / 2 - 0.2, y0 + 0.1, z, null, [0.16, 0.2, o.d + 0.3]);
      break;
    }
    case 'hay': {
      const ry = ((o.x * 7 + o.z * 13) % 17) / 17 * 0.6 - 0.3;
      d.add('hay', G.box, x, y0 + o.h / 2, z, [0, ry, 0], [o.w, o.h, o.d]);
      // 顶面一层浅色散草：不然方盒子看着像木箱
      d.add('wheat', G.box, x, y0 + o.h + 0.02, z, [0, ry + 0.1, 0], [o.w * 0.94, 0.06, o.d * 0.94]);
      d.add('wheat', G.box, x + 0.2, y0 + o.h + 0.05, z - 0.15, [0, ry + 0.6, 0], [o.w * 0.55, 0.05, o.d * 0.3]);
      // 捆绳（横竖各一道，粗一点才看得出来）
      d.add('hayDark', G.box, x, y0 + o.h * 0.5, z, [0, ry, 0], [o.w + 0.04, 0.12, o.d + 0.04]);
      d.add('hayDark', G.box, x, y0 + o.h * 0.5, z, [0, ry, 0], [0.12, o.h + 0.04, o.d + 0.04]);
      break;
    }
    case 'tree': {
      const variant = Math.abs(Math.round(o.x * 3 + o.z * 5)) % 3;
      d.add('trunk', G.cyl8, x, y0 + o.h / 2, z, null, [0.26, o.h, 0.26]);
      if (variant === 2) {
        // 松树：两层锥体，比阔叶树高
        d.add('leaf', G.cone6, x, y0 + o.h + 1.0, z, [0, 0.3, 0], [1.25, 2.4, 1.25]);
        d.add('leaf2', G.cone6, x, y0 + o.h + 2.0, z, [0, 0.9, 0], [0.9, 1.8, 0.9]);
      } else {
        d.add('leaf', G.ico, x, y0 + o.h + 0.7, z, [0, 0.4, 0], [1.5, 1.4, 1.5]);
        d.add('leaf2', G.ico, x + 0.5, y0 + o.h + 1.4, z + 0.3, [0.3, 0, 0], [1.05, 1.0, 1.05]);
        d.add('leaf2', G.ico, x - 0.55, y0 + o.h + 1.2, z - 0.35, [0, 0.7, 0], [0.9, 0.86, 0.9]);
      }
      break;
    }
    case 'rock': {
      d.add('rock', G.ico, x, y0 + o.h / 2, z, [0, o.x * 0.3, 0], [o.w / 2, o.h / 2 * 1.1, o.d / 2]);
      break;
    }
    case 'well': {
      d.add('stone', G.cyl12, x, y0 + 0.45, z, null, [1.2, 0.9, 1.2]);
      d.add('water', G.cyl12, x, y0 + 0.93, z, null, [0.94, 0.05, 0.94]);
      // 四根柱子从地面立到屋檐（之前是从 0.9m 开始悬空的）
      // ⚠ 柱子要在井圈外面（井圈半径 1.2），否则看起来是插在水里
      for (const [dx, dz] of [[-1.35, -1.35], [1.35, -1.35], [-1.35, 1.35], [1.35, 1.35]]) {
        d.add('plankDark', G.box, x + dx, y0 + 1.1, z + dz, null, [0.14, 2.2, 0.14]);
      }
      // 人字顶：檐口在 (±1.45, 2.2)、屋脊在 (0, 3.15)，两片板按几何摆好
      d.add('coopRoof', G.box, x - 0.725, y0 + 2.675, z, [0, 0, 0.58], [1.73, 0.14, 2.95]);
      d.add('coopRoof', G.box, x + 0.725, y0 + 2.675, z, [0, 0, -0.58], [1.73, 0.14, 2.95]);
      d.add('plankDark', G.box, x, y0 + 3.17, z, null, [0.14, 0.12, 3.0]);
      d.add('plankDark', G.cyl8, x, y0 + 1.95, z, [0, 0, Math.PI / 2], [0.06, 2.9, 0.06]);
      d.add('metal', G.cyl8, x, y0 + 1.36, z, null, [0.3, 0.36, 0.3]);
      d.add('metal', G.cyl8, x, y0 + 1.55, z, null, [0.32, 0.04, 0.32]);
      d.add('plankDark', G.box, x - 0.12, y0 + 1.72, z, null, [0.05, 0.42, 0.05]);
      d.add('plankDark', G.box, x + 0.12, y0 + 1.72, z, null, [0.05, 0.42, 0.05]);
      break;
    }
    case 'crate': {
      d.add('plank', G.box, x - 0.15, y0 + 0.45, z, [0, 0.15, 0], [1.1, 0.9, 1.0]);
      d.add('plankDark', G.box, x - 0.15, y0 + 0.9, z, [0, 0.15, 0], [1.16, 0.08, 1.06]);
      d.add('plankDark', G.box, x - 0.15, y0 + 0.45, z + 0.5, [0, 0.15, 0], [1.12, 0.1, 0.06]);
      d.add('plank', G.box, x + 0.1, y0 + 1.2, z + 0.1, [0, -0.3, 0], [0.8, 0.6, 0.75]);
      break;
    }
    case 'barrel': {
      d.add('plank', G.cyl10, x, y0 + 0.45, z, null, [0.34, 0.9, 0.34]);
      d.add('metal', G.cyl10, x, y0 + 0.2, z, null, [0.36, 0.07, 0.36]);
      d.add('metal', G.cyl10, x, y0 + 0.7, z, null, [0.36, 0.07, 0.36]);
      d.add('plankDark', G.cyl10, x, y0 + 0.9, z, null, [0.3, 0.04, 0.3]);
      break;
    }
    case 'scarecrow': {
      d.add('plankDark', G.box, x, y0 + 1.1, z, null, [0.14, 2.2, 0.14]);
      d.add('plankDark', G.box, x, y0 + 1.62, z, null, [1.7, 0.1, 0.1]);
      // 衣服 + 袖子 + 补丁
      d.add('cloth', G.box, x, y0 + 1.44, z, null, [0.54, 0.64, 0.3]);
      d.add('cloth', G.box, x - 0.72, y0 + 1.6, z, [0, 0, 0.12], [0.55, 0.16, 0.18]);
      d.add('cloth', G.box, x + 0.72, y0 + 1.6, z, [0, 0, -0.12], [0.55, 0.16, 0.18]);
      d.add('cloth2', G.box, x + 0.16, y0 + 1.5, z + 0.18, null, [0.2, 0.2, 0.02]);
      // 头 + 草帽
      d.add('coopTrim', G.ico, x, y0 + 2.02, z, [0, 0.5, 0], [0.3, 0.31, 0.3]);
      d.add('hay', G.cyl12, x, y0 + 2.27, z, null, [0.56, 0.07, 0.56]);
      d.add('hay', G.cyl12, x, y0 + 2.4, z, null, [0.3, 0.26, 0.3]);
      break;
    }
    case 'pond': {
      // 泥岸 → 浅水边 → 水面（三层，边缘才有厚度感）
      d.add('soilDark', G.cyl12, x, y0 + 0.03, z, null, [o.w / 2 + 0.45, 0.06, o.d / 2 + 0.45]);
      // 浅滩 → 中层 → 深水：三圈不同色，边缘才有"水有深度"的感觉
      d.add('waterLight', G.cyl12, x, y0 + 0.05, z, null, [o.w / 2 + 0.5, 0.05, o.d / 2 + 0.5]);
      d.add('water', G.cyl12, x, y0 + 0.075, z, null, [o.w / 2 + 0.12, 0.05, o.d / 2 + 0.12]);
      d.add('waterDeep', G.cyl12, x, y0 + 0.1, z, null, [o.w / 2 - 0.85, 0.05, o.d / 2 - 0.85]);
      // 水面几道亮波纹
      for (const [dx, dz, r, w2] of [[-1.4, 0.7, 0.5, 1.1], [0.9, -1.1, -0.7, 0.9], [1.7, 1.2, 0.3, 0.8], [-0.6, -1.7, 1.1, 0.7], [0.3, 1.9, 0.15, 0.6]]) {
        d.add('waterLight', G.box, x + dx, y0 + 0.14, z + dz, [0, r, 0], [w2, 0.012, 0.08]);
      }
      // 岸边一圈石头
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * Math.PI * 2 + 0.2;
        d.add('rock', G.ico, x + Math.cos(a) * (o.w / 2 + 0.28), y0 + 0.08, z + Math.sin(a) * (o.d / 2 + 0.28),
          [0, a, 0], [0.34 + (i % 3) * 0.06, 0.16, 0.28]);
      }
      // 芦苇：三根一丛、带斜度
      for (let i = 0; i < 6; i++) {
        const a = i * 1.11 + 0.3;
        const rx = x + Math.cos(a) * (o.w / 2 - 0.45), rz = z + Math.sin(a) * (o.d / 2 - 0.45);
        for (let k = 0; k < 3; k++) {
          d.add('leaf', G.cyl8, rx + (k - 1) * 0.12, y0 + 0.5 + k * 0.06, rz + (k - 1) * 0.05,
            [0, 0, (k - 1) * 0.18], [0.035, 1.0 + k * 0.12, 0.035]);
        }
      }
      // 西岸的芦苇丛（带蒲棒）
      for (let i = 0; i < 9; i++) {
        const a = 2.2 + i * 0.19;
        const rx = x + Math.cos(a) * (o.w / 2 - 0.5), rz = z + Math.sin(a) * (o.d / 2 - 0.5);
        const hh = 1.1 + (i % 3) * 0.28;
        d.add('leaf', G.cyl8, rx, y0 + hh / 2, rz, [0, 0, (i % 2 ? 0.08 : -0.08)], [0.03, hh, 0.03]);
        d.add('hayDark', G.cyl8, rx + 0.01, y0 + hh + 0.06, rz, null, [0.045, 0.18, 0.045]);
      }
      // 睡莲叶 + 两朵花（⚠ 挪到岸边：中间那片留给两只鸭子绕圈，不然鸭子会从叶子上穿过去）
      for (const [dx, dz, r] of [[-3.0, 1.9, 0.42], [1.6, -2.6, 0.36], [2.4, -2.0, 0.3], [-3.1, -0.6, 0.33]]) {
        d.add('leaf', G.cyl12, x + dx, y0 + 0.14, z + dz, null, [r, 0.02, r]);
        d.add('petal', G.ico, x + dx + 0.08, y0 + 0.2, z + dz, null, [0.07, 0.05, 0.07]);
      }
      // 取水的小木栈桥（朝场地这一侧，两根桩 + 桥面 + 栏杆）
      d.add('plankDark', G.box, x + o.w / 2 - 0.1, y0 + 0.02, z - 0.45, null, [0.14, 0.34, 0.14]);
      d.add('plankDark', G.box, x + o.w / 2 - 0.1, y0 + 0.02, z + 0.45, null, [0.14, 0.34, 0.14]);
      d.add('plank', G.box, x + o.w / 2 - 0.55, y0 + 0.2, z, null, [2.2, 0.09, 1.3]);
      d.add('plankDark', G.box, x + o.w / 2 + 0.5, y0 + 0.55, z - 0.6, null, [0.1, 0.6, 0.1]);
      d.add('plankDark', G.box, x + o.w / 2 + 0.5, y0 + 0.55, z + 0.6, null, [0.1, 0.6, 0.1]);
      d.add('plank', G.box, x + o.w / 2 + 0.5, y0 + 0.82, z, null, [0.12, 0.1, 1.4]);
      break;
    }
    case 'woodpile': {
      const logs = [[-0.46, 0.16, 0], [0.46, 0.16, 0], [0, 0.46, 0], [-0.23, 0.76, 0], [0.23, 0.76, 0]];
      for (const [dx, dy, dz] of logs) {
        d.add('trunk', G.cyl8, x + dx, y0 + dy, z + dz, [0, 0, Math.PI / 2], [0.16, 1.1, 0.16]);
      }
      d.add('hay', G.box, x, y0 + 1.0, z, null, [1.2, 0.06, 1.0]);
      break;
    }
    case 'beehive': {
      for (let i = 0; i < 3; i++) {
        const hx = x + (i - 1) * 0.95, hz = z + (i - 1) * 0.3, hy = groundHeight(hx, hz);
        // 木托架
        d.add('plankDark', G.box, hx, hy + 0.06, hz, [0, 0.3, 0], [0.92, 0.12, 0.92]);
        // 箱体（暖木色）+ 两道箍
        d.add('plank', G.box, hx, hy + 0.52, hz, [0, 0.3, 0], [0.78, 0.8, 0.78]);
        d.add('hayDark', G.box, hx, hy + 0.34, hz, [0, 0.3, 0], [0.82, 0.05, 0.82]);
        d.add('hayDark', G.box, hx, hy + 0.72, hz, [0, 0.3, 0], [0.82, 0.05, 0.82]);
        // 坡屋顶
        d.add('plankDark', G.box, hx - 0.22, hy + 1.02, hz, [0, 0.3, 0.42], [0.62, 0.08, 0.9]);
        d.add('plankDark', G.box, hx + 0.22, hy + 1.02, hz, [0, 0.3, -0.42], [0.62, 0.08, 0.9]);
        // 起落板 + 巢门
        d.add('plank', G.box, hx + 0.32, hy + 0.2, hz + 0.34, [0, 0.3, 0], [0.42, 0.06, 0.3]);
        d.add('coopDoor', G.box, hx + 0.3, hy + 0.3, hz + 0.36, [0, 0.3, 0], [0.32, 0.05, 0.03]);
      }
      break;
    }
    case 'shed': {
      const w = o.w, dep = o.d;
      // 四根柱子
      for (const [dx, dz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
        d.add('plankDark', G.box, x + dx * (w / 2 - 0.2), y0 + 1.1, z + dz * (dep / 2 - 0.2), null, [0.16, 2.2, 0.16]);
      }
      // 后墙 + 侧墙（木板条）
      for (let i = 0; i < 5; i++) {
        d.add('plank', G.box, x - w / 2 + 0.5 + i * 0.75, y0 + 0.8, z - dep / 2 + 0.1, null, [0.7, 1.5, 0.1]);
      }
      for (let i = 0; i < 4; i++) {
        d.add('plank', G.box, x - w / 2 + 0.1, y0 + 0.8, z - dep / 2 + 0.5 + i * 0.78, null, [0.1, 1.5, 0.7]);
      }
      d.add('plankDark', G.box, x - w / 2 + 0.1, y0 + 1.56, z, null, [0.13, 0.1, dep]);
      d.add('plankDark', G.box, x, y0 + 1.56, z - dep / 2 + 0.1, null, [w, 0.1, 0.13]);
      // 单坡屋顶
      d.add('coopRoof', G.box, x, y0 + 2.35, z, [0.16, 0, 0], [w + 0.5, 0.14, dep + 0.6]);
      d.add('plankDark', G.box, x, y0 + 2.15, z + dep / 2 + 0.2, null, [w + 0.5, 0.12, 0.12]);
      // 棚里的草料
      d.add('hay', G.box, x + 0.6, y0 + 0.45, z - 0.4, [0, 0.2, 0], [1.4, 0.9, 1.2]);
      d.add('wheat', G.box, x + 0.6, y0 + 0.92, z - 0.4, [0, 0.3, 0], [1.3, 0.06, 1.1]);
      d.add('hay', G.box, x - 1.0, y0 + 0.4, z + 0.6, [0, -0.3, 0], [1.0, 0.8, 0.9]);
      break;
    }
    case 'compost': {
      d.add('soilDark', G.ico, x, y0 + 0.22, z, [0, 0.4, 0], [1.1, 0.42, 0.85]);
      d.add('leaf2', G.ico, x - 0.35, y0 + 0.4, z + 0.25, [0, 1.2, 0], [0.3, 0.1, 0.3]);
      d.add('hay', G.box, x + 0.55, y0 + 0.08, z - 0.3, [0, 0.7, 0], [0.5, 0.05, 0.1]);
      break;
    }
    case 'tower': {
      const h = 4.4, legR = 1.0;
      // 四条腿 + 石基座
      for (const [dx, dz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
        d.add('stone', G.box, x + dx * legR, y0 + 0.16, z + dz * legR, null, [0.52, 0.32, 0.52]);
        d.add('plankDark', G.box, x + dx * legR, y0 + h / 2, z + dz * legR, [0, 0, dx * 0.03], [0.18, h, 0.18]);
      }
      // 两道交叉斜撑
      for (const yy of [1.4, 3.0]) {
        d.add('plank', G.box, x, y0 + yy, z - legR, [0, 0, 0.62], [2.6, 0.1, 0.1]);
        d.add('plank', G.box, x, y0 + yy, z + legR, [0, 0, -0.62], [2.6, 0.1, 0.1]);
        d.add('plank', G.box, x - legR, y0 + yy, z, [0.62, 0, 0], [0.1, 0.1, 2.6]);
        d.add('plank', G.box, x + legR, y0 + yy, z, [-0.62, 0, 0], [0.1, 0.1, 2.6]);
      }
      // 平台 + 水罐（木条 + 三道铁箍）+ 锥顶
      d.add('plank', G.box, x, y0 + h, z, null, [2.5, 0.14, 2.5]);
      d.add('plank', G.cyl12, x, y0 + h + 0.95, z, null, [1.25, 1.8, 1.25]);
      for (const yy of [0.35, 0.95, 1.55]) d.add('metal', G.cyl12, x, y0 + h + yy, z, null, [1.3, 0.09, 1.3]);
      d.add('coopRoof', G.cone8, x, y0 + h + 2.35, z, null, [1.45, 0.9, 1.45]);
      // 南侧爬梯
      for (const dz of [-0.22, 0.22]) d.add('plankDark', G.box, x, y0 + h / 2, z + legR + 0.3 + dz, null, [0.07, h, 0.07]);
      for (let i = 0; i < 6; i++) d.add('plankDark', G.box, x, y0 + 0.5 + i * 0.7, z + legR + 0.3, null, [0.06, 0.06, 0.5]);
      // 出水管
      d.add('metal', G.cyl8, x + 0.3, y0 + 0.62, z + 1.35, null, [0.09, 1.24, 0.09]);
      break;
    }
    case 'tractor': {
      // 轮胎：后大前小，都压在地面上（外胎 + 轮毂）
      const rearR = 0.52, frontR = 0.3;
      for (const dz of [-0.72, 0.72]) {
        d.add('coopDoor', G.cyl12, x - 0.62, y0 + rearR, z + dz, [Math.PI / 2, 0, 0], [rearR, 0.32, rearR]);
        d.add('metal', G.cyl12, x - 0.62, y0 + rearR, z + dz, [Math.PI / 2, 0, 0], [0.2, 0.34, 0.2]);
        d.add('coopDoor', G.cyl12, x + 0.95, y0 + frontR, z + dz * 0.82, [Math.PI / 2, 0, 0], [frontR, 0.22, frontR]);
        d.add('metal', G.cyl12, x + 0.95, y0 + frontR, z + dz * 0.82, [Math.PI / 2, 0, 0], [0.12, 0.24, 0.12]);
        // 后轮挡泥板
        d.add('crop', G.box, x - 0.62, y0 + rearR + 0.5, z + dz * 0.86, null, [1.0, 0.07, 0.12]);
      }
      // 车轴（把两边的轮子连起来，不然轮子像粘在车身上）
      d.add('metal', G.cyl8, x - 0.62, y0 + rearR, z, [Math.PI / 2, 0, 0], [0.07, 1.44, 0.07]);
      d.add('metal', G.cyl8, x + 0.95, y0 + frontR, z, [Math.PI / 2, 0, 0], [0.06, 1.2, 0.06]);
      // 底盘 + 引擎盖 + 格栅 + 大灯
      d.add('crop', G.box, x, y0 + 0.62, z, null, [2.2, 0.28, 0.86]);
      d.add('crop', G.box, x + 0.5, y0 + 0.98, z, null, [1.15, 0.5, 0.8]);
      d.add('coopDoor', G.box, x + 1.1, y0 + 0.95, z, null, [0.08, 0.42, 0.72]);
      d.add('lamp', G.box, x + 1.11, y0 + 1.12, z - 0.22, null, [0.06, 0.12, 0.12]);
      d.add('lamp', G.box, x + 1.11, y0 + 1.12, z + 0.22, null, [0.06, 0.12, 0.12]);
      // 驾驶室底板（座椅才不会看起来悬空）
      d.add('plankDark', G.box, x - 0.56, y0 + 0.79, z, null, [1.1, 0.07, 1.0]);
      // 驾驶室：四柱落在底盘上 + 顶棚
      for (const [dx, dz] of [[-1.02, -0.5], [-1.02, 0.5], [-0.1, -0.5], [-0.1, 0.5]]) {
        d.add('metal', G.box, x + dx, y0 + 1.12, z + dz, null, [0.06, 0.72, 0.06]);
      }
      d.add('crop', G.box, x - 0.56, y0 + 1.5, z, null, [1.12, 0.08, 1.12]);
      // 座椅 + 靠背
      d.add('coopDoor', G.box, x - 0.72, y0 + 0.8, z, null, [0.38, 0.1, 0.44]);
      d.add('coopDoor', G.box, x - 0.9, y0 + 1.0, z, null, [0.08, 0.34, 0.44]);
      // 方向盘（横圆盘）+ 转向柱
      d.add('metal', G.cyl8, x - 0.3, y0 + 1.02, z, [1.2, 0, 0], [0.04, 0.34, 0.04]);
      d.add('metal', G.cyl12, x - 0.26, y0 + 1.17, z, [1.15, 0, 0], [0.15, 0.04, 0.15]);
      // 排气管 + 后牵引钩
      d.add('metal', G.cyl8, x + 0.72, y0 + 1.34, z - 0.26, null, [0.05, 0.6, 0.05]);
      d.add('plankDark', G.box, x - 1.14, y0 + 0.5, z, null, [0.12, 0.16, 0.5]);
      break;
    }
    case 'bench': {
      // 树下长椅（自建兜底版）：座板 + 靠背 + 两条腿。
      // ⚠ 朝向必须跟 js/models.js 里那条 bench 的 yaw 一致（Math.PI*0.9），
      //   不一致的话精细模型落到同一个位置时，两块板子会错开 —— 用户截图报过"椅子模型错位"。
      const ry = Math.PI * 0.9;
      d.add('plank', G.box, x, y0 + 0.45, z, [0, ry, 0], [1.7, 0.09, 0.44]);
      d.add('plank', G.box, x - Math.sin(ry) * 0.22, y0 + 0.78, z - Math.cos(ry) * 0.22,
        [0, ry, 0.16], [1.7, 0.4, 0.07]);
      for (const t of [-0.66, 0.66]) {
        d.add('plankDark', G.box, x + Math.cos(ry) * t, y0 + 0.22, z - Math.sin(ry) * t,
          [0, ry, 0], [0.09, 0.44, 0.4]);
      }
      break;
    }
    case 'barrow': {
      // 手推车：斗 + 两个把手 + 一个轮子
      d.add('metal', G.box, x, y0 + 0.5, z, [0, 0, 0.1], [0.95, 0.42, 0.62]);
      d.add('metal', G.box, x, y0 + 0.72, z, [0, 0, 0.1], [0.95, 0.06, 0.62]);
      d.add('plankDark', G.box, x - 0.78, y0 + 0.62, z - 0.18, [0, 0, 0.42], [0.85, 0.07, 0.07]);
      d.add('plankDark', G.box, x - 0.78, y0 + 0.62, z + 0.18, [0, 0, 0.42], [0.85, 0.07, 0.07]);
      d.add('metal', G.cyl12, x + 0.42, y0 + 0.3, z, [Math.PI / 2, 0, 0], [0.3, 0.12, 0.3]);
      d.add('plankDark', G.box, x + 0.42, y0 + 0.3, z, [Math.PI / 2, 0, 0], [0.05, 0.42, 0.05]);
      d.add('plankDark', G.box, x - 0.5, y0 + 0.2, z - 0.22, null, [0.07, 0.42, 0.07]);
      d.add('plankDark', G.box, x - 0.5, y0 + 0.2, z + 0.22, null, [0.07, 0.42, 0.07]);
      break;
    }
  }
}

// 菜畦：按梯田分段建（坡地上不能一整条平畦）
function buildGardenBeds(d) {
  const dep = GARDEN.d;
  for (const b of GARDEN_BEDS) {
    const w = b.x1 - b.x0;
    const h = b.top - b.bot;
    // 土体：从最低地面一直填到畦面，下坡侧自然形成挡土的立面
    d.add('soil', G.box, b.cx, b.bot + h / 2, b.z, null, [w - 0.02, h, dep - 0.02]);
    // 畦面（翻过的土）+ 两条垄沟
    d.add('soilDark', G.box, b.cx, b.top + 0.012, b.z, null, [w - 0.16, 0.024, dep - 0.16]);
    d.add('soilDark', G.box, b.cx, b.top + 0.03, b.z - 0.34, null, [w - 0.5, 0.02, 0.12]);
    d.add('soilDark', G.box, b.cx, b.top + 0.03, b.z + 0.34, null, [w - 0.5, 0.02, 0.12]);
    // 木框：顶沿压在畦面上
    const ry = b.top + 0.12;
    d.add('plank', G.box, b.cx, ry, b.z - dep / 2 - 0.04, null, [w + 0.08, 0.2, 0.1]);
    d.add('plank', G.box, b.cx, ry, b.z + dep / 2 + 0.04, null, [w + 0.08, 0.2, 0.1]);
    d.add('plank', G.box, b.x0 - 0.04, ry, b.z, null, [0.1, 0.2, dep]);
    d.add('plank', G.box, b.x1 + 0.04, ry, b.z, null, [0.1, 0.2, dep]);
    // 四角立柱：从地面撑到木框顶，坡上才不会看着像一块悬空的蛋糕
    for (const [px, pz] of [[b.x0 - 0.04, b.z - dep / 2 - 0.04], [b.x1 + 0.04, b.z - dep / 2 - 0.04],
      [b.x0 - 0.04, b.z + dep / 2 + 0.04], [b.x1 + 0.04, b.z + dep / 2 + 0.04]]) {
      const gy = Math.min(groundHeight(px, pz), b.bot + 0.02);
      d.add('plankDark', G.box, px, (gy + ry) / 2, pz, null, [0.1, ry - gy + 0.16, 0.1]);
    }
  }
}

// 地面土路：沿折线的条带网格，逐点贴合高度场
function ribbon(pts, half, yOff = 0.035) {
  const P = [];
  let acc = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x, z] = pts[i];
    const prev = pts[i - 1] || pts[i];
    const next = pts[i + 1] || pts[i];
    let dx = next[0] - prev[0], dz = next[1] - prev[1];
    const L = Math.hypot(dx, dz) || 1;
    dx /= L; dz /= L;
    P.push({ x, z, nx: -dz, nz: dx, v: acc });
    if (i < pts.length - 1) acc += Math.hypot(pts[i + 1][0] - x, pts[i + 1][1] - z);
  }
  const pos = [], uv = [], idx = [];
  for (const p of P) {
    const y = groundHeight(p.x, p.z) + yOff;
    pos.push(p.x + p.nx * half, y, p.z + p.nz * half);
    pos.push(p.x - p.nx * half, y, p.z - p.nz * half);
    uv.push(0, p.v / 2.6, 1, p.v / 2.6);
  }
  for (let i = 0; i < P.length - 1; i++) {
    const a = i * 2, b = a + 1, c = a + 2, dd = a + 3;
    idx.push(a, c, b, b, c, dd);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// 季节：按月份自动选（3~5 春 / 6~8 夏 / 9~11 秋 / 12~2 冬），?season=xxx 可覆盖。只影响作物与草色，纯观感。
function seasonOfMonth(m) {
  return (m <= 1 || m >= 11) ? 'winter' : m <= 4 ? 'spring' : m <= 7 ? 'summer' : 'autumn';
}
const SEASON_PALETTE = {
  spring: { crop: 0x74c24a, corn: 0x9ccf5e, grass: [0x86bd52, 0x7cb44a, 0x93c95e, 0x6da33f] },
  summer: { crop: 0x5fa83c, corn: 0x86a84a, grass: [0x5d9438, 0x6da33f, 0x7cb44a, 0x4f8a30] },
  autumn: { crop: 0x93b24c, corn: 0xd2ab45, grass: [0x7a9c3c, 0x86a544, 0x6d9438, 0x93ad4e] },
  winter: { crop: 0x8aa07a, corn: 0xa89a6a, grass: [0x8a9a76, 0x7d8f66, 0x93a07a, 0x6f8060] },
};
let SEASON = 'summer';

// 光照预设：白天 / 黄昏（暖光 + 长影）。切换时同时改太阳、半球光、雾、天穹渐变与地面染色。
const LIGHT = {
  day: {
    top: 0x6fb2e2, bot: 0xdaf0fb, fog: 0xcfe7f5, bg: 0xbfe0f2,
    sun: 0xfff2d8, sunI: 1.6, sunPos: [24, 34, 12],
    hemiSky: 0xdcefff, hemiGround: 0x8fa05e, hemiI: 0.95,
    ground: 0xffffff, shadowInt: 0.55,
  },
  dusk: {
    top: 0x46608f, mid: 0xc98a86, bot: 0xf4c79a, fog: 0xe6c1a2, bg: 0xe4bd9c,
    sun: 0xffc48f, sunI: 1.75, sunPos: [40, 9, 5],
    hemiSky: 0xffdcc4, hemiGround: 0x6a5644, hemiI: 0.58,
    ground: 0xefe2d2, shadowInt: 0.95,
  },
};

// 天空穹顶：顶点色从地平线到天顶做渐变（纯色天空太单薄）；颜色可重刷，供光照预设切换
function buildSky(scene) {
  const R = 170;
  const geo = new THREE.SphereGeometry(R, 24, 14);
  const pos = geo.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const sky = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
    vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false,
  }));
  sky.frustumCulled = false;
  sky.userData.paint = (topHex, botHex, midHex) => {
    const top = new THREE.Color(topHex), bot = new THREE.Color(botHex);
    const mid = midHex ? new THREE.Color(midHex) : null;
    const c = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      const t = Math.max(0, Math.min(1, pos.getY(i) / R * 0.9 + 0.16));
      if (mid && t < 0.42) c.copy(bot).lerp(mid, t / 0.42);
      else if (mid) c.copy(mid).lerp(top, (t - 0.42) / 0.58);
      else c.copy(bot).lerp(top, t);
      colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b;
    }
    geo.attributes.color.needsUpdate = true;
  };
  scene.add(sky);
  return sky;
}

// 云：几坨压扁的低模球，慢慢飘
function buildClouds(scene, rand) {
  const clouds = [];
  for (let i = 0; i < 7; i++) {
    const d = new Deco();
    const n = 3 + Math.floor(rand() * 3);
    for (let j = 0; j < n; j++) {
      const r = 2.4 + rand() * 3.4;
      d.add('cloud', G.ico,
        (j - (n - 1) / 2) * r * 0.85 + (rand() - 0.5) * 1.6,
        (rand() - 0.5) * 1.1,
        (rand() - 0.5) * 2.2,
        [rand() * 3, rand() * 3, rand() * 3],
        [r, r * 0.6, r]);
    }
    const [mesh] = d.build(scene, { cast: false, receive: false });
    mesh.scale.setScalar(1.7);
    const ang = rand() * Math.PI * 2, dist = 62 + rand() * 34;
    mesh.position.set(Math.cos(ang) * dist, 13 + rand() * 9, Math.sin(ang) * dist);
    clouds.push(mesh);
  }
  return clouds;
}

// 远景：树线 + 农舍 + 筒仓 + 风车（都在围栏外，不参与碰撞）
function buildFar(scene, rand) {
  // 树线：一圈低模锥树，把地平线填满
  const trees = new THREE.InstancedMesh(G.cone6, MAT.hill, 52);
  const dummy = new THREE.Object3D();
  for (let i = 0; i < 52; i++) {
    const ang = (i / 52) * Math.PI * 2 + rand() * 0.09;
    const dist = 40 + rand() * 16;
    const h = 3.2 + rand() * 3.4;
    dummy.position.set(Math.cos(ang) * dist, h * 0.42 - 0.6, Math.sin(ang) * dist);
    dummy.rotation.set(0, rand() * 3.14, 0);
    dummy.scale.set(1.3 + rand() * 1.1, h, 1.3 + rand() * 1.1);
    dummy.updateMatrix();
    trees.setMatrixAt(i, dummy.matrix);
  }
  trees.castShadow = false;
  trees.receiveShadow = false;
  scene.add(trees);

  const far = new Deco();
  // 围栏外的一圈树：把栅栏和远山之间的空带填上（不参与碰撞）
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2 + rand() * 0.4;
    const d2 = 30 + rand() * 8;
    const tx = Math.cos(a) * d2, tz = Math.sin(a) * d2;
    const h = 2.4 + rand() * 1.4;
    far.add('trunk', G.cyl8, tx, h / 2, tz, null, [0.26, h, 0.26]);
    far.add('leaf', G.ico, tx, h + 0.6, tz, [0, rand() * 3, 0], [1.45, 1.35, 1.45]);
    far.add('leaf2', G.ico, tx + 0.45, h + 1.25, tz + 0.25, [0.2, 0, 0], [0.95, 0.9, 0.95]);
  }
  // 农舍（左后方）：原来只有"一块墙 + 两片斜板 + 一扇门"，远看就是个盒子（用户点名"白色房子太简陋"）
  // → 石块基座 + 木板墙 + 转角立柱 + 真坡屋顶（带屋脊/出檐）+ 烟囱 + 门廊 + 带窗框和百叶的窗
  const fx = -37, fz = -27, fy = groundHeight(fx, fz);
  {
    const hy = 0.5, hc = Math.cos(hy), hs = Math.sin(hy);
    // 房子局部坐标 (u = 面宽方向, v = 进深方向) → 世界坐标（绕 Y 转 hy）
    const HX = (u, v) => fx + u * hc + v * hs;
    const HZ = (u, v) => fz - u * hs + v * hc;
    const put = (key, u, v, y, size, rot = null) =>
      far.add(key, G.box, HX(u, v), fy + y, HZ(u, v), [0, hy, rot || 0], size);

    // 基座 + 墙体 + 转角立柱
    put('stone', 0, 0, 0.25, [7.4, 0.5, 5.8]);
    put('wallFar', 0, 0, 2.15, [7.0, 3.4, 5.4]);
    for (const [u, v] of [[-3.45, -2.65], [3.45, -2.65], [-3.45, 2.65], [3.45, 2.65]]) {
      put('plankDark', u, v, 2.15, [0.26, 3.5, 0.26]);
    }
    // 山墙（坡屋顶下的那块墙，用一个薄箱塞进屋面里）
    put('wallFar', 0, 0, 4.35, [6.9, 1.5, 3.0]);
    // 双坡屋顶：脊在 u=0（高 4.95），檐在 u=±3.5（高 3.95）
    for (const s of [-1, 1]) {
      const run = 3.5, rise = 1.0, len = Math.hypot(run, rise) + 0.7;
      const ang = Math.atan2(rise, run);
      put('roofFar', s * run / 2, 0, 4.45, [len, 0.26, 7.5], -s * ang);
    }
    put('roofFar', 0, 0, 5.02, [7.7, 0.2, 0.44]);                 // 屋脊压条
    // 石烟囱
    put('stone', 2.3, -1.3, 4.9, [0.8, 1.8, 0.8]);
    put('metal', 2.3, -1.3, 5.86, [1.0, 0.14, 1.0]);
    // 门 + 门框 + 门前石阶 + 小门廊
    put('coopDoor', -1.2, 2.74, 1.55, [1.1, 2.1, 0.14]);
    put('plankDark', -1.2, 2.70, 2.66, [1.5, 0.16, 0.2]);         // 门楣
    for (const u of [-1.82, -0.58]) put('plankDark', u, 2.70, 1.55, [0.14, 2.1, 0.2]);
    put('stone', -1.2, 3.05, 0.12, [1.7, 0.24, 0.7]);             // 石阶
    put('plankDark', -1.2, 3.35, 2.72, [2.9, 0.14, 1.6]);         // 门廊顶
    for (const u of [-2.45, 0.05]) put('plankDark', u, 3.95, 1.36, [0.14, 2.72, 0.14]);   // 门廊柱
    // 两扇前窗（窗框 + 玻璃 + 百叶 + 窗台花箱）
    for (const u of [1.5, 3.0]) {
      put('coopTrim', u, 2.74, 2.2, [1.24, 1.14, 0.1]);
      put('glass', u, 2.76, 2.2, [1.0, 0.9, 0.08]);
      put('coopTrim', u, 2.80, 2.2, [0.06, 0.9, 0.06]);
      put('plank', u - 0.8, 2.74, 2.2, [0.3, 1.0, 0.08]);
      put('plank', u + 0.8, 2.74, 2.2, [0.3, 1.0, 0.08]);
      put('plankDark', u, 2.86, 1.58, [1.2, 0.24, 0.34]);
      put('petal', u, 2.94, 1.58, [0.9, 0.12, 0.24]);
    }
    // 侧墙一扇窗
    put('coopTrim', 3.56, 0.6, 2.2, [0.1, 1.1, 1.2]);
    put('glass', 3.58, 0.6, 2.2, [0.08, 0.86, 0.96]);
    // 墙边柴堆 + 木桶（远看就有"有人住"的味道）
    for (const [u, y] of [[-3.9, 0.2], [-3.9, 0.55]]) {
      far.add('trunk', G.cyl8, HX(u, 1.6), fy + y, HZ(u, 1.6), [Math.PI / 2, hy, 0], [0.18, 1.5, 0.18]);
    }
    far.add('plank', G.cyl10, HX(-3.9, 3.0), fy + 0.42, HZ(-3.9, 3.0), null, [0.32, 0.84, 0.32]);
  }
  // 筒仓
  far.add('silo', G.cyl12, fx + 5.6, fy + 3.4, fz - 1.2, null, [1.7, 6.8, 1.7]);
  far.add('metal', G.cone8, fx + 5.6, fy + 7.2, fz - 1.2, null, [1.9, 1.6, 1.9]);

  // 围栏外的草堆（视觉上把"农场"延伸到栅栏外）
  for (const [hx, hz, hs] of [[-30, 9, 1.0], [27.5, 13, 0.85], [-9, 32, 1.1], [33, -6, 0.9]]) {
    far.add('hay', G.cyl10, hx, hs * 0.55, hz, null, [hs * 1.1, hs * 1.1, hs * 1.1]);
    far.add('hay', G.cone8, hx, hs * 1.5, hz, null, [hs * 1.25, hs * 0.9, hs * 1.25]);
  }
  far.build(scene, { cast: false, receive: false });
  // 风车（右后方，叶片单独转）
  const mill = new THREE.Group();
  const tower = new THREE.Mesh(new THREE.CylinderGeometry(0.85, 1.8, 8.4, 8), MAT.wallFar);
  tower.position.y = 4.2;
  const cap = new THREE.Mesh(new THREE.ConeGeometry(1.15, 1.3, 8), MAT.roofFar);
  cap.position.y = 8.9;
  const base = new THREE.Mesh(new THREE.CylinderGeometry(2.0, 2.2, 0.5, 10), MAT.stone);
  base.position.y = 0.25;
  const hub = new THREE.Group();
  hub.position.set(0, 8.4, 1.0);
  for (let i = 0; i < 4; i++) {
    const blade = new THREE.Mesh(new THREE.BoxGeometry(0.26, 3.6, 0.07), MAT.plank);
    blade.position.y = 1.8;
    const arm = new THREE.Group();
    arm.add(blade);
    arm.rotation.z = (i / 4) * Math.PI * 2;
    hub.add(arm);
  }
  const hubCore = new THREE.Mesh(new THREE.CylinderGeometry(0.26, 0.26, 0.5, 8), MAT.plankDark);
  hubCore.rotation.x = Math.PI / 2;
  hub.add(hubCore);
  mill.add(tower, cap, base, hub);
  mill.position.set(33, 0, -23);
  mill.rotation.y = -Math.PI * 0.28;
  mill.traverse((m) => { m.castShadow = false; m.receiveShadow = false; });
  scene.add(mill);
  return { mill, hub };
}

// 作物：菜畦里的大白菜（球）与玉米（杆 + 叶），都用实例化
function buildCrops(scene, rand) {
  if (SEASON === 'winter') {
    // 冬天菜园休耕：空畦 + 草帘/覆土堆
    const d = new Deco();
    for (const z of GARDEN.zs) {
      for (let i = 0; i < 5; i++) {
        const mx = GARDEN.x - 2.8 + i * 1.4;
        d.add('hayDark', G.ico, mx, gardenSurface(mx, z) + 0.06, z, [0, rand() * 3, 0], [0.5, 0.12, 0.42]);
      }
    }
    d.build(scene);
    return;
  }
  const cabbages = [];
  for (const z of [GARDEN.zs[0], GARDEN.zs[2]]) {
    for (let i = 0; i < 11; i++) cabbages.push([GARDEN.x - 3.2 + i * 0.64, z + (rand() - 0.5) * 0.5]);
  }
  const cabGeo = mergeGeos([
    // 外层菜叶（矮圆锥）+ 菜心（压扁的球）：单色也能看出是棵白菜
    { geo: new THREE.ConeGeometry(0.36, 0.24, 7), pos: [0, -0.15, 0] },
    { geo: new THREE.IcosahedronGeometry(0.25, 0), pos: [0, 0.02, 0], scale: [1, 0.86, 1] },
  ]);
  const cabMesh = new THREE.InstancedMesh(cabGeo, MAT.crop, cabbages.length);
  const dummy = new THREE.Object3D();
  cabbages.forEach(([x, z], i) => {
    dummy.position.set(x, gardenSurface(x, z) + 0.14, z);
    dummy.rotation.set(0, rand() * 3.14, 0);
    dummy.scale.setScalar(0.8 + rand() * 0.5);
    dummy.updateMatrix();
    cabMesh.setMatrixAt(i, dummy.matrix);
  });
  cabMesh.castShadow = true;
  scene.add(cabMesh);

  // 玉米：粗一点的杆 + 五片斜叶 + 顶穗；穗子单独一层（黄色）
  const cornGeo = mergeGeos([
    { geo: new THREE.CylinderGeometry(0.028, 0.038, 1.05, 5), pos: [0, 0.52, 0] },
    { geo: new THREE.ConeGeometry(0.075, 0.55, 4), pos: [0.12, 0.55, 0], rot: [0, 0, -0.62], scale: [1, 1, 0.3] },
    { geo: new THREE.ConeGeometry(0.075, 0.5, 4), pos: [-0.11, 0.68, 0.03], rot: [0, 0, 0.7], scale: [1, 1, 0.3] },
    { geo: new THREE.ConeGeometry(0.07, 0.45, 4), pos: [0, 0.8, -0.1], rot: [0.65, 0, 0], scale: [1, 1, 0.3] },
    { geo: new THREE.ConeGeometry(0.045, 0.22, 4), pos: [0, 1.12, 0] },
  ]);
  const cornMesh = new THREE.InstancedMesh(cornGeo, MAT.corn, 10);
  const cobMesh = new THREE.InstancedMesh(new THREE.CapsuleGeometry(0.055, 0.22, 3, 6), MAT.petal, 10);
  for (let i = 0; i < 10; i++) {
    const x = GARDEN.x - 3.0 + i * 0.67, z = GARDEN.zs[1] + (rand() - 0.5) * 0.45;
    const y = gardenSurface(x, z) - 0.02;
    dummy.position.set(x, y, z);
    dummy.rotation.set(0, rand() * 3.14, 0);
    dummy.scale.setScalar(0.9 + rand() * 0.3);
    dummy.updateMatrix();
    cornMesh.setMatrixAt(i, dummy.matrix);
    // 玉米穗挂在杆侧
    dummy.position.set(x + 0.09, y + 0.62, z + 0.08);
    dummy.rotation.set(0.3, rand() * 3.14, 0.25);
    dummy.scale.setScalar(1);
    dummy.updateMatrix();
    cobMesh.setMatrixAt(i, dummy.matrix);
  }
  cornMesh.castShadow = true;
  cobMesh.castShadow = false;
  scene.add(cornMesh, cobMesh);
}

// 秋天的落叶：贴地的小方片，撒在草地和树下（只在这个季节出现）
function buildLeaves(scene, rand) {
  if (SEASON !== 'autumn') return null;
  const geo = new THREE.PlaneGeometry(0.26, 0.18);
  const N = 160;
  const mesh = new THREE.InstancedMesh(geo, new THREE.MeshLambertMaterial({ color: 0xffffff, side: THREE.DoubleSide }), N);
  const dummy = new THREE.Object3D();
  const c = new THREE.Color();
  const cols = [0xd97a2a, 0xc9532a, 0xe0a33a, 0xa8452a, 0xd9b24a, 0xb85a2a];
  let placed = 0, guard = 0;
  while (placed < N && guard < N * 10) {
    guard++;
    const x = (rand() * 2 - 1) * (WORLD_HALF - 1.2);
    const z = (rand() * 2 - 1) * (WORLD_HALF - 1.2);
    if (distToPath(x, z) < 1.4 || inYard(x, z)) continue;
    dummy.position.set(x, groundHeight(x, z) + 0.025, z);
    dummy.rotation.set(-Math.PI / 2, 0, rand() * 6.28);
    dummy.scale.setScalar(0.75 + rand() * 0.8);
    dummy.updateMatrix();
    mesh.setMatrixAt(placed, dummy.matrix);
    c.setHex(cols[Math.floor(rand() * cols.length)]);
    mesh.setColorAt(placed, c);
    placed++;
  }
  mesh.count = placed;
  mesh.instanceColor.needsUpdate = true;
  mesh.castShadow = false;
  scene.add(mesh);
  return mesh;
}

// 草簇 + 野花：实例化，颜色按实例给（各一个 draw call）
function buildGrassAndFlowers(scene, rand, boxes = []) {
  // 道具占地内不长草：不然草丛会从野餐桌/木箱/池塘里穿出来
  const clearOfProps = (x, z) => {
    for (const b of boxes) {
      if (Math.abs(x - b.x) < b.hx + 0.28 && Math.abs(z - b.z) < b.hz + 0.28) return false;
    }
    return true;
  };
  const tuft = mergeGeos([
    { geo: new THREE.BoxGeometry(0.035, 0.42, 0.035), pos: [0, 0.21, 0] },
    { geo: new THREE.BoxGeometry(0.032, 0.36, 0.032), pos: [0, 0.18, 0], rot: [0, 2.1, 0] },
    { geo: new THREE.BoxGeometry(0.03, 0.3, 0.03), pos: [0, 0.15, 0], rot: [0, 4.2, 0] },
  ]);
  const N = innerWidth < 760 ? 220 : 320;   // 手机上草少一些（视觉密度够，三角面省三成）
  const blades = new THREE.InstancedMesh(tuft, new THREE.MeshLambertMaterial({ color: 0xffffff }), N);
  const dummy = new THREE.Object3D();
  const c = new THREE.Color();
  const greens = (SEASON_PALETTE[SEASON] || SEASON_PALETTE.summer).grass;
  for (let i = 0; i < N; i++) {
    let gx = (rand() * 2 - 1) * (WORLD_HALF - 1.2);
    let gz = (rand() * 2 - 1) * (WORLD_HALF - 1.2);
    // 土路、菜畦、池塘上不长草（否则草会从路里冒出来）
    for (let k = 0; k < 6 && distToPath(gx, gz) < 1.9; k++) {
      gx = (rand() * 2 - 1) * (WORLD_HALF - 1.2);
      gz = (rand() * 2 - 1) * (WORLD_HALF - 1.2);
    }
    if (distToPath(gx, gz) < 1.9 || inYard(gx, gz) || !clearOfProps(gx, gz)) continue;
    dummy.position.set(gx, groundHeight(gx, gz) + 0.02, gz);
    dummy.rotation.set(0, rand() * 3.14, 0);
    dummy.scale.setScalar(0.7 + rand() * 0.95);
    dummy.updateMatrix();
    blades.setMatrixAt(i, dummy.matrix);
    c.setHex(greens[Math.floor(rand() * greens.length)]);
    blades.setColorAt(i, c);
  }
  blades.castShadow = false;   // 草叶太小，投影看不出来；关掉省一半阴影绘制
  blades.instanceColor.needsUpdate = true;
  scene.add(blades);

  // 野花：小茎 + 花头
  const flower = mergeGeos([
    { geo: new THREE.CylinderGeometry(0.012, 0.016, 0.24, 4), pos: [0, 0.12, 0] },
    { geo: new THREE.IcosahedronGeometry(0.058, 0), pos: [0, 0.27, 0] },
  ]);
  const M = 150;
  const flowers = new THREE.InstancedMesh(flower, new THREE.MeshLambertMaterial({ color: 0xffffff }), M);
  const cols = [0xf7e07a, 0xf3b7c8, 0xc9b6ea, 0xf6f2e4, 0xe8e07a];
  for (let i = 0; i < M; i++) {
    // 花爱长在围栏边和菜园周围：一半贴边、一半随机
    let fx, fz;
    if (i % 2 === 0) {
      const side = Math.floor(rand() * 4);
      const t = (rand() * 2 - 1) * (WORLD_HALF - 1.5);
      fx = side === 0 ? -WORLD_HALF + 1.2 : side === 1 ? WORLD_HALF - 1.2 : t;
      fz = side === 2 ? -WORLD_HALF + 1.2 : side === 3 ? WORLD_HALF - 1.2 : t;
    } else {
      fx = (rand() * 2 - 1) * (WORLD_HALF - 2);
      fz = (rand() * 2 - 1) * (WORLD_HALF - 2);
    }
    if (distToPath(fx, fz) < 1.7 || inYard(fx, fz) || !clearOfProps(fx, fz)) continue;
    dummy.position.set(fx, groundHeight(fx, fz) + 0.02, fz);
    dummy.rotation.set(0, rand() * 3.14, 0);
    dummy.scale.setScalar(0.7 + rand() * 0.5);
    dummy.updateMatrix();
    flowers.setMatrixAt(i, dummy.matrix);
    c.setHex(cols[Math.floor(rand() * cols.length)]);
    flowers.setColorAt(i, c);
  }
  flowers.castShadow = false;
  flowers.instanceColor.needsUpdate = true;
  scene.add(flowers);
}

// 接触阴影贴图（比土斑更暗、更薄，只为把道具"压"在地面上）
function contactTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(64, 64, 4, 64, 64, 62);
  grd.addColorStop(0, 'rgba(28,40,16,0.5)');
  grd.addColorStop(0.5, 'rgba(28,40,16,0.28)');
  grd.addColorStop(1, 'rgba(28,40,16,0)');
  g.fillStyle = grd;
  g.beginPath(); g.arc(64, 64, 63, 0, 6.29); g.fill();
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// 地面踩踏土斑 + 土路
function buildGroundDetails(scene) {
  // 土路：主路（鸡舍门口 → 场地中央 → 饲料槽）+ 支线（主路 → 菜园）
  const dirt = dirtTexture();
  const pathMat = new THREE.MeshLambertMaterial({
    map: dirt, transparent: true, depthWrite: false,
    polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3,
  });
  // ⚠ 每条路给不同的 y（0.030 / 0.034 / …）：同一高度会在交叉处 Z 打架，出现明暗三角
  const main = new THREE.Mesh(ribbon(PATH_MAIN, 1.25, 0.030), pathMat);
  const branch = new THREE.Mesh(ribbon(PATH_BRANCH, 1.0, 0.034), pathMat);
  const wellRoad = new THREE.Mesh(ribbon(PATH_WELL, 0.9, 0.038), pathMat);
  const gateRoad = new THREE.Mesh(ribbon(PATH_GATE, 1.05, 0.042), pathMat);
  const loopRoad = new THREE.Mesh(ribbon(PATH_LOOP, 0.85, 0.046), pathMat);
  const neighborRoad = new THREE.Mesh(ribbon(PATH_NEIGHBOR, 0.85, 0.052), pathMat);
  for (const m of [main, branch, wellRoad, gateRoad, loopRoad, neighborRoad]) {
    m.receiveShadow = true;
    m.renderOrder = 1;
    scene.add(m);
  }

  // 软边土斑
  const d = new Deco();
  const spots = [
    [-11, -4.0, 8.6, 5.0, 0.2], [-2, -17.2, 5.0, 4.4, 0.6], [9, 12.2, 5.2, 3.4, 0.1],
    [17.5, 8.2, 9.5, 5.2, 0.05], [-6, -7.4, 4.2, 3.4, 0.9], [12.4, 8.0, 3.6, 2.8, 0.3],
  ];
  for (const [x, z, sx, sz, ry] of spots) {
    d.add('__patch', G.planeFlat, x, groundHeight(x, z) + 0.028, z, [0, ry, 0], [sx, 1, sz]);
  }
  const patchMat = new THREE.MeshLambertMaterial({
    map: patchTexture(), transparent: true, depthWrite: false,
    polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
  });
  const items = d.by.get('__patch') || [];
  if (items.length) {
    const mesh = new THREE.Mesh(mergeGeos(items), patchMat);
    mesh.receiveShadow = false;
    mesh.renderOrder = 2;
    scene.add(mesh);
  }

  // 接触阴影：鸡舍 / 水井 / 草垛 / 木箱 / 树 / 池塘边……（一个 draw call）
  const c = new Deco();
  const shadows = [
    [-11, -9, 9.2, 7.6, 0], [-2, -18, 4.2, 4.2, 0], [-15.8, -8.6, 2.6, 2.4, 0],
    [6, -12, 2.6, 2.6, 0], [-15, 10, 2.6, 2.6, 0], [13, 3, 2.6, 2.6, 0],
    [-17, -12.5, 2.6, 2.6, 0], [10.5, 13.5, 2.6, 2.6, 0], [-6.4, -6.2, 2.2, 2.0, 0],
    [-5.4, -7.8, 1.5, 1.5, 0], [12.4, 3.3, 2.0, 1.6, 0], [12.8, 8.2, 1.3, 1.3, 0],
    [10, -21, 7.4, 7.4, 0], [9, 11, 3.2, 2.0, 0], [-20, -6, 5.0, 4.2, 0],
    [13.5, -6.5, 4.0, 2.6, 0], [10, -18.6, 3.6, 2.4, 0], [17.5, -20, 5.0, 5.0, 0], [17.3, 13.7, 2.6, 1.8, 0],
    [31, -9, 8.6, 8.6, 0], [30.5, 6, 5.0, 5.0, 0],
  ];
  for (const [x, z, sx, sz, ry] of shadows) {
    c.add('__shadow', G.planeFlat, x, groundHeight(x, z) + 0.022, z, [0, ry, 0], [sx, 1, sz]);
  }
  for (const [x, z] of [[16, 15], [-18, -15], [19, -7], [-6, 17], [-19, 4], [-21, 12.5], [-18, 15.5], [-22, 18.5], [-24, 15.2], [-19.5, 19.5]]) {
    c.add('__shadow', G.planeFlat, x, groundHeight(x, z) + 0.022, z, [0, 0, 0], [3.2, 1, 3.2]);
  }
  const shadowMat = new THREE.MeshBasicMaterial({
    map: contactTexture(), transparent: true, depthWrite: false,
    polygonOffset: true, polygonOffsetFactor: -5, polygonOffsetUnits: -5,
  });
  const shadowItems = c.by.get('__shadow') || [];
  if (shadowItems.length) {
    const mesh = new THREE.Mesh(mergeGeos(shadowItems), shadowMat);
    mesh.receiveShadow = false;
    mesh.renderOrder = 3;
    scene.add(mesh);
  }
}

export function buildScene(renderer) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xbfe0f2);
  scene.fog = new THREE.Fog(0xcfe7f5, 48, 120);

  const camera = new THREE.PerspectiveCamera(62, innerWidth / innerHeight, 0.1, 220);

  // 季节：默认按当前月份，?season=spring|summer|autumn|winter 可覆盖（影响作物/草/地色，纯观感）
  const qs = new URLSearchParams(location.search);
  SEASON = qs.get('season') || seasonOfMonth(new Date().getMonth());
  const sp = SEASON_PALETTE[SEASON] || SEASON_PALETTE.summer;
  MAT.crop.color.setHex(sp.crop);
  MAT.corn.color.setHex(sp.corn);
  if (SEASON === 'winter') {
    MAT.leaf.color.setHex(0x5d6f4c);
    MAT.leaf2.color.setHex(0x6d7d5c);
    MAT.hill.color.setHex(0x7d8a6e);
  } else if (SEASON === 'autumn') {
    MAT.leaf.color.setHex(0x5b8a3c);
    MAT.leaf2.color.setHex(0x74973f);
    MAT.hill.color.setHex(0x7a9450);
  }

  const hemi = new THREE.HemisphereLight(0xdcefff, 0x8fa05e, 0.95);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xfff2d8, 1.6);
  sun.position.set(24, 34, 12);
  sun.castShadow = true;
  // 窄屏（手机）上阴影贴图降一档：2048² 的阴影 pass 在手机上很贵，1024² 在手机尺寸下几乎看不出差别
  const SHADOW_SIZE = innerWidth < 760 ? 1024 : 2048;
  sun.shadow.mapSize.set(SHADOW_SIZE, SHADOW_SIZE);
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

  const sky = buildSky(scene);

  const obstacles = buildObstacles();
  const boxObstacles = obstacles.map((o) => ({ x: o.x, z: o.z, hx: o.w / 2, hz: o.d / 2, h: o.h }));

  // ---- 地面：110 段位移网格，跟着高度场起伏 ----
  const geo = new THREE.PlaneGeometry(WORLD_HALF * 2 + 60, WORLD_HALF * 2 + 60, 110, 110);
  const pos = geo.attributes.position;
  // PlaneGeometry 在 XY 平面，rotateX(-90°) 后 y→z，所以高度取 groundHeight(x, -y)
  for (let i = 0; i < pos.count; i++) pos.setZ(i, groundHeight(pos.getX(i), -pos.getY(i)));
  geo.computeVertexNormals();
  const ground = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ map: groundTexture(SEASON) }));
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  const rand = mulberry32(42);

  // ---- 围栏外的远景山丘（装饰，靠雾与天空衔接；九座合成一个 mesh） ----
  const hills = [];
  const hillSpots = [];
  for (let i = 0; i < 9; i++) {
    const ang = (i / 9) * Math.PI * 2 + rand() * 0.5;
    const dist = WORLD_HALF + 14 + rand() * 18;
    const r = 7 + rand() * 8;
    hills.push({
      geo: new THREE.SphereGeometry(r, 12, 8),
      pos: [Math.cos(ang) * dist, -2.5, Math.sin(ang) * dist],
      scale: [1, 0.55, 1],
    });
    hillSpots.push({ x: Math.cos(ang) * dist, z: Math.sin(ang) * dist, r });
  }
  const hillMesh = new THREE.Mesh(mergeGeos(hills), MAT.hill);
  hillMesh.receiveShadow = true;
  scene.add(hillMesh);

  // ---- 道具：全部按材质合并（draw call 远少于零件数） ----
  // 标了 SWAP_TYPES 的那几种单独成组：js/models.js 从 精细模型 拉到更精细的模型后
  // 调 swapOut() 把自建版隐藏；拉不到（断网/被墙）就一直用自建版，不影响可玩性。
  const deco = new Deco();
  const swappable = new Map();
  const swappedKeys = new Set();   // 已经被精细模型顶替掉的自建道具 key
  for (const o of obstacles) {
    if (o.type === 'garden') continue;      // 菜畦按梯田另建（见 buildGardenBeds）
    if (SWAP_TYPES.has(o.type)) {
      const d = new Deco();
      buildProp(d, o);
      const meshes = d.build(scene);
      // 先藏起来：精细模型到位才显示它（否则用户会先看到一批"自建版旧模型"、
      // 过一两秒再被替换掉）。模型一直拉不到时由 models.js / main.js 的兜底把自建版放出来。
      for (const m of meshes) m.visible = false;
      swappable.set(`${o.type}@${o.x},${o.z}`, { meshes, o });
    } else {
      buildProp(deco, o);
    }
  }
  buildGardenBeds(deco);
  // 围栏大门：两根门柱是静态的，两扇门做成可开合的 Group（走近自动推开）
  const gy = groundHeight(WORLD_HALF, -2);
  deco.add('fenceTop', G.box, WORLD_HALF, gy + 0.9, -4.4, null, [0.26, 1.9, 0.26]);
  deco.add('fenceTop', G.box, WORLD_HALF, gy + 0.9, 0.4, null, [0.26, 1.9, 0.26]);
  const gateLeaves = [];
  for (const [pivotZ, dir] of [[-4.4, 1], [0.4, -1]]) {
    const leaf = new THREE.Group();
    leaf.position.set(WORLD_HALF, gy, pivotZ + dir * 0.16);
    for (const yy of [0.42, 0.92, 1.42]) {
      const bar = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.12, 2.15), MAT.plank);
      bar.position.set(0, yy, dir * 1.08);
      leaf.add(bar);
    }
    const diag = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.1, 2.3), MAT.plankDark);
    diag.position.set(0, 0.92, dir * 1.08);
    diag.rotation.x = dir * 0.2;
    leaf.add(diag);
    for (const [yy, zz] of [[0.2, 0.12], [1.6, 0.12], [0.2, 2.0], [1.6, 2.0]]) {
      const st = new THREE.Mesh(new THREE.BoxGeometry(0.09, 1.5, 0.09), MAT.plankDark);
      st.position.set(0, yy, dir * zz);
      leaf.add(st);
    }
    leaf.traverse((m) => { m.castShadow = true; m.receiveShadow = true; });
    scene.add(leaf);
    gateLeaves.push({ g: leaf, dir });   // 常闭：场地边界 ±26，门开了也走不出去
  }
  // 向日葵（左边围栏一排 + 鸡舍旁两株）
  const flowersAt = [[-24.2, -1.0], [-23.6, 1.3], [-24.4, 3.6], [-23.8, 5.8], [-15.6, -5.4], [-14.9, 12.5]];
  for (const [fx, fz] of flowersAt) {
    const fy = groundHeight(fx, fz);
    deco.add('leaf', G.cyl8, fx, fy + 0.85, fz, null, [0.05, 1.7, 0.05]);
    deco.add('leaf2', G.box, fx + 0.16, fy + 0.95, fz, [0, 0, 0.6], [0.3, 0.03, 0.16]);
    deco.add('leaf2', G.box, fx - 0.16, fy + 1.15, fz, [0, 0, -0.6], [0.3, 0.03, 0.16]);
    deco.add('petal', G.cyl12, fx, fy + 1.74, fz, [0.15, 0, 0.1], [0.22, 0.06, 0.22]);
    deco.add('petalCore', G.cyl12, fx, fy + 1.77, fz, [0.15, 0, 0.1], [0.12, 0.05, 0.12]);
  }
  // 果园的树盘（深色土圈）：让几棵树读成"一园果树"而不是散树
  for (const [tx, tz] of [[-21, 12.5], [-18, 15.5], [-22, 18.5], [-24, 15.2], [-19.5, 19.5]]) {
    deco.add('soilDark', G.cyl12, tx, groundHeight(tx, tz) + 0.03, tz, null, [1.1, 0.04, 1.1]);
  }
  // 鸡舍门前的农具角：改成**自立式木架**（梯子搭在横梁上、水桶挂在横梁下、绳圈挂在木桩上）
  // ⚠ 原来这些件是"挂在鸡舍右墙"的写死坐标；鸡舍换成 精细模型后墙往里退了 1m 多，
  //   结果梯子/水桶/绳圈全悬在半空（用户截图报过）。自立架不依赖墙，换模型也不会再飘。
  {
    const ax = -12.05, az = -6.62;
    const gy = groundHeight(ax, az);
    const py = gy + 1.78;                    // 顶梁高度
    for (const dx of [-1.05, 1.05]) {
      const px = ax + dx, pg = groundHeight(px, az);
      deco.add('plankDark', G.box, px, (pg + py) / 2, az, null, [0.13, py - pg, 0.13]);
      deco.add('plankDark', G.box, px, pg + 0.06, az, null, [0.34, 0.12, 0.5]);   // 脚墩：贴地
    }
    deco.add('plank', G.box, ax, py, az, null, [2.28, 0.11, 0.12]);               // 顶梁
    deco.add('plank', G.box, ax, gy + 1.1, az, null, [2.2, 0.08, 0.09]);          // 中梁
    for (const s of [-1, 1]) {                                                    // 斜撑
      deco.add('plankDark', G.box, ax + s * 0.8, gy + 1.44, az, [0, 0, s * 0.62], [0.9, 0.07, 0.07]);
    }
    // 木梯：底端落地、上端搭在顶梁上（θ=0.3，梁顶再露出一截）
    {
      const th = 0.3, L = 2.2, lx = ax - 0.55;
      const bz = az + 1.78 * Math.tan(th);
      const cy = gy + Math.cos(th) * L / 2, cz = bz - Math.sin(th) * L / 2;
      for (const dx of [-0.24, 0.24]) {
        deco.add('plank', G.box, lx + dx, cy, cz, [-th, 0, 0], [0.07, L, 0.08]);
      }
      for (let i = 0; i < 6; i++) {
        const t = -0.85 + i * 0.34;
        deco.add('plank', G.box, lx, cy + Math.cos(th) * t, cz - Math.sin(th) * t,
          [-th, 0, 0], [0.58, 0.05, 0.06]);
      }
    }
    // 水桶：钩子挂在顶梁下，桶沿正好顶住钩子
    {
      const bx = ax - 0.05;
      deco.add('metal', G.box, bx, py - 0.1, az + 0.02, null, [0.05, 0.14, 0.05]);
      deco.add('metal', G.cyl10, bx, py - 0.32, az + 0.02, null, [0.19, 0.32, 0.19]);
      deco.add('metal', G.cyl10, bx, py - 0.17, az + 0.02, null, [0.21, 0.04, 0.21]);
      deco.add('metal', G.box, bx, py - 0.2, az + 0.02, null, [0.03, 0.12, 0.03]);
    }
    // 绳圈：挂在横梁上的木桩上
    {
      const px = ax + 0.68;
      deco.add('plankDark', G.box, px, py - 0.12, az + 0.1, null, [0.07, 0.07, 0.24]);
      deco.add('plankDark', G.cyl12, px, py - 0.4, az + 0.14, [Math.PI / 2, 0, 0], [0.27, 0.06, 0.27]);
      deco.add('hayDark', G.cyl12, px, py - 0.4, az + 0.14, [Math.PI / 2, 0, 0], [0.19, 0.07, 0.19]);
      deco.add('hayDark', G.cyl12, px, py - 0.4, az + 0.14, [Math.PI / 2, 0, 0], [0.11, 0.08, 0.11]);
    }
    // 锄头：靠在东侧立柱上
    {
      const hx = ax + 1.17, hz = az + 0.18;
      deco.add('plankDark', G.box, hx, gy + 0.82, hz, [0, 0, 0.12], [0.06, 1.64, 0.06]);
      deco.add('metal', G.box, hx + 0.12, gy + 0.1, hz, [0, 0.35, 0], [0.26, 0.19, 0.05]);
    }
    // 架子底下的木箱
    {
      const cx2 = ax + 0.45, cz2 = az + 0.52;
      deco.add('plank', G.box, cx2, groundHeight(cx2, cz2) + 0.25, cz2, [0, 0.18, 0], [0.52, 0.5, 0.44]);
      deco.add('plankDark', G.box, cx2, groundHeight(cx2, cz2) + 0.5, cz2, [0, 0.18, 0], [0.56, 0.06, 0.48]);
    }
  }
  // 大树下的木长椅：⚠ 这里原来手绘过一把，但 buildObstacles() 里已有 'bench' 道具、
  //   buildProp 也会画（并且能被 精细模型替换）→ 两把椅子错开叠在一起（用户报"模型错位"）。
  //   现在只在 buildProp 里画一次。
  // 水井边：吊桶、小板凳、盘着的绳子
  {
    const wx = -2, wz = -18, wy = groundHeight(wx, wz);
    deco.add('metal', G.cyl8, wx + 1.45, wy + 0.18, wz + 0.2, null, [0.22, 0.3, 0.22]);
    deco.add('metal', G.cyl8, wx + 1.45, wy + 0.34, wz + 0.2, null, [0.24, 0.04, 0.24]);
    deco.add('plank', G.box, wx - 1.6, wy + 0.24, wz + 0.6, [0, 0.4, 0], [0.5, 0.08, 0.5]);
    for (const [dx, dz] of [[-0.2, -0.2], [0.2, -0.2], [-0.2, 0.2], [0.2, 0.2]]) {
      deco.add('plankDark', G.box, wx - 1.6 + dx, wy + 0.1, wz + 0.6 + dz, null, [0.05, 0.24, 0.05]);
    }
    deco.add('hayDark', G.cyl12, wx - 1.0, wy + 0.06, wz - 1.2, null, [0.3, 0.06, 0.3]);
    deco.add('hayDark', G.cyl12, wx - 1.0, wy + 0.1, wz - 1.2, null, [0.2, 0.06, 0.2]);
  }
  // 岔路口的碎石场院（一大片踩实的院子）+ 踏脚石
  {
    const yard = new THREE.Mesh(G.planeFlat, new THREE.MeshLambertMaterial({
      map: yardTexture(), transparent: true, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    }));
    yard.position.set(3.6, groundHeight(3.6, 5.6) + 0.052, 5.6);
    yard.scale.set(12, 1, 8.2);
    yard.rotation.y = -0.2;
    yard.receiveShadow = true;
    scene.add(yard);
    for (let i = 0; i < 7; i++) {
      const sx = 0.6 + i * 1.15, sz = 4.4 + (i % 3) * 0.7;
      deco.add('rock', G.ico, sx, groundHeight(sx, sz) + 0.015, sz, [0, i, 0], [0.34, 0.07, 0.28]);
    }
  }
  // 岔路口的指路木牌（四块空白箭头板）
  {
    const px = 3.2, pz = 6.2, py = groundHeight(px, pz);
    deco.add('plankDark', G.box, px, py + 1.1, pz, null, [0.15, 2.2, 0.15]);
    // ⚠ 板子要沿自己的朝向偏移 L/2+柱半径，内端才顶在柱子上（之前是随手摆的，全悬空）
    const boards = [[0.9, 1.92, 1.15], [-0.75, 1.56, 1.05], [2.55, 1.22, 1.0], [-2.35, 0.88, 0.95]];
    for (const [th, yy, len] of boards) {
      const dx = Math.cos(th) * (len / 2 + 0.075);
      const dz = -Math.sin(th) * (len / 2 + 0.075);
      deco.add('plank', G.box, px + dx, py + yy, pz + dz, [0, th, 0], [len, 0.24, 0.05]);
      deco.add('metal', G.box, px + Math.cos(th) * 0.14, py + yy, pz - Math.sin(th) * 0.14, null, [0.04, 0.04, 0.04]);
    }
  }
  // 围栏边的灌木丛（低矮装饰，不参与碰撞）
  for (const [bx, bz, bs] of [[-24.2, -12.5, 0.55], [-23.4, -10.2, 0.42], [23.6, 6.4, 0.5],
    [24.2, 9.1, 0.38], [-9.5, 23.8, 0.48], [-6.8, 24.1, 0.36], [17.5, -23.6, 0.45], [20.4, -23.2, 0.34]]) {
    const by = groundHeight(bx, bz);
    deco.add('leaf', G.ico, bx, by + bs * 0.55, bz, [0, bx, 0], [bs, bs * 0.7, bs]);
    deco.add('leaf2', G.ico, bx + bs * 0.5, by + bs * 0.4, bz + bs * 0.3, [0, bz, 0], [bs * 0.65, bs * 0.5, bs * 0.65]);
  }
  // 秋天：菜园边几个南瓜（只在这个季节出现）
  if (SEASON === 'autumn') {
    for (const [px, pz, ps] of [[13.6, 11.4, 0.42], [14.5, 12.1, 0.34], [12.9, 12.4, 0.3], [20.6, 4.3, 0.38]]) {
      const py = groundHeight(px, pz);
      deco.add('pumpkin', G.ico, px, py + ps * 0.72, pz, [0, px, 0], [ps, ps * 0.78, ps]);
      deco.add('trunk', G.cyl8, px, py + ps * 1.42, pz, null, [0.04, 0.14, 0.04]);
    }
  }
  // 果园落果：树下一圈小苹果
  for (const [tx, tz] of [[-21, 12.5], [-18, 15.5], [-22, 18.5]]) {
    for (let i = 0; i < 6; i++) {
      const a = rand() * Math.PI * 2, r = 0.7 + rand() * 1.7;
      const ax = tx + Math.cos(a) * r, az = tz + Math.sin(a) * r;
      deco.add('apple', G.ico, ax, groundHeight(ax, az) + 0.09, az, [0, rand() * 3, 0], [0.09, 0.08, 0.09]);
    }
  }
  // 菜园小件：浇水壶、菜篮、三块菜名木牌
  {
    const wx = 14.2, wz = 12.6, wy = groundHeight(wx, wz);
    deco.add('metal', G.cyl10, wx, wy + 0.2, wz, null, [0.2, 0.34, 0.2]);
    deco.add('metal', G.cyl8, wx + 0.3, wy + 0.3, wz, [0, 0, -0.9], [0.05, 0.34, 0.05]);
    deco.add('metal', G.box, wx - 0.24, wy + 0.34, wz, null, [0.16, 0.04, 0.04]);
    const bx = 15.4, bz = 12.8, by = groundHeight(bx, bz);
    deco.add('hay', G.cyl10, bx, by + 0.14, bz, null, [0.26, 0.26, 0.26]);
    deco.add('hayDark', G.cyl10, bx, by + 0.27, bz, null, [0.28, 0.05, 0.28]);
    for (let i = 0; i < 3; i++) {
      const sz = GARDEN.zs[i], sx = 13.9;
      const sy = groundHeight(sx, sz);
      deco.add('plankDark', G.box, sx, sy + 0.28, sz, null, [0.06, 0.56, 0.06]);
      deco.add('plank', G.box, sx, sy + 0.62, sz, [0, 0.5, 0], [0.5, 0.26, 0.05]);
    }
  }
  // 蜂箱边的花丛（有花才像蜂场）
  for (let i = 0; i < 16; i++) {
    const a = rand() * Math.PI * 2, r = 1.6 + rand() * 2.4;
    const fx = 21.2 + Math.cos(a) * r, fz = -1.2 + Math.sin(a) * r;
    deco.add('petal', G.ico, fx, groundHeight(fx, fz) + 0.16, fz, [0, rand() * 3, 0], [0.06, 0.05, 0.06]);
    deco.add('leaf2', G.cyl8, fx, groundHeight(fx, fz) + 0.07, fz, null, [0.012, 0.14, 0.012]);
  }
  // 路边的小石子
  for (let i = 0; i < 14; i++) {
    const t = rand();
    const seg = Math.floor(t * (PATH_MAIN.length - 1));
    const [x1, z1] = PATH_MAIN[seg], [x2, z2] = PATH_MAIN[seg + 1];
    const k = (t * (PATH_MAIN.length - 1)) % 1;
    const px = x1 + (x2 - x1) * k + (rand() < 0.5 ? -1 : 1) * (1.35 + rand() * 0.5);
    const pz = z1 + (z2 - z1) * k + (rand() - 0.5) * 0.6;
    deco.add('rock', G.ico, px, groundHeight(px, pz) + 0.06, pz, [0, rand() * 3, 0], [0.14 + rand() * 0.1, 0.09, 0.12 + rand() * 0.08]);
  }
  // 饲料槽旁撒的谷物
  for (let i = 0; i < 30; i++) {
    const fx = 9 + (rand() * 2 - 1) * 1.7, fz = 11 + (rand() * 2 - 1) * 1.3;
    deco.add('wheat', G.box, fx, groundHeight(fx, fz) + 0.025, fz, [0, rand() * 3, 0], [0.1, 0.02, 0.07]);
  }
  // 围栏外的邻居家：门前小路尽头的生活痕迹（房子本体是 精细模型，见 js/models.js 的 DECOR）
  {
    // 门口的木柴堆
    const wpX = 28.9, wpZ = -4.75, wpY = groundHeight(wpX, wpZ);
    for (const [dx, dy] of [[-0.46, 0.16], [0.46, 0.16], [0, 0.46], [-0.23, 0.76], [0.23, 0.76]]) {
      deco.add('trunk', G.cyl8, wpX + dx, wpY + dy, wpZ, [0, 0, Math.PI / 2], [0.16, 1.05, 0.16]);
    }
    deco.add('hay', G.box, wpX, wpY + 1.0, wpZ, null, [1.2, 0.06, 0.9]);
    // 门口的木桶与菜篮
    for (const [bx, bz] of [[33.0, -5.4], [33.5, -6.1]]) {
      const by = groundHeight(bx, bz);
      deco.add('plank', G.cyl10, bx, by + 0.42, bz, null, [0.32, 0.84, 0.32]);
      deco.add('metal', G.cyl10, bx, by + 0.18, bz, null, [0.34, 0.07, 0.34]);
      deco.add('metal', G.cyl10, bx, by + 0.68, bz, null, [0.34, 0.07, 0.34]);
    }
    // 路口的木灯柱（灯罩自己发光，夜里也看得见）
    {
      const lx = 28.6, lz = -6.3, ly = groundHeight(lx, lz);
      deco.add('plankDark', G.box, lx, ly + 1.15, lz, null, [0.12, 2.3, 0.12]);
      deco.add('plankDark', G.box, lx + 0.16, ly + 2.16, lz, null, [0.42, 0.08, 0.08]);
      deco.add('metal', G.box, lx + 0.32, ly + 2.0, lz, null, [0.26, 0.26, 0.26]);
      deco.add('lamp', G.box, lx + 0.32, ly + 2.0, lz, null, [0.19, 0.2, 0.19]);
      deco.add('plankDark', G.cone6, lx + 0.32, ly + 2.18, lz, null, [0.2, 0.12, 0.2]);
    }
    // 院子边的灌木与野花（用自己的固定种子，别动主 rand 序列——否则整片草花位置都会漂）
    const r2 = mulberry32(91);
    for (const [bx, bz, bs] of [[27.9, -8.6, 0.5], [34.2, -8.2, 0.44], [30.2, -12.6, 0.5]]) {
      const by = groundHeight(bx, bz);
      deco.add('leaf', G.ico, bx, by + bs * 0.55, bz, [0, bx, 0], [bs, bs * 0.7, bs]);
      deco.add('leaf2', G.ico, bx + bs * 0.5, by + bs * 0.42, bz + bs * 0.3, [0, bz, 0], [bs * 0.65, bs * 0.5, bs * 0.65]);
    }
    for (let i = 0; i < 10; i++) {
      const a = r2() * Math.PI * 2, r = 1.4 + r2() * 3.2;
      const fx = 29.4 + Math.cos(a) * r, fz = -5.4 + Math.sin(a) * r;
      deco.add('petal', G.ico, fx, groundHeight(fx, fz) + 0.14, fz, [0, r2() * 3, 0], [0.06, 0.05, 0.06]);
      deco.add('leaf2', G.cyl8, fx, groundHeight(fx, fz) + 0.07, fz, null, [0.012, 0.14, 0.012]);
    }
  }
  deco.build(scene);

  // ---- 围栏外的田块：视觉上把"农场"推到栅栏外一圈（避开山丘，不参与碰撞） ----
  {
    const fields = [];
    const fieldGeo = G.planeFlat.clone();
    for (let i = 0; i < 7; i++) {
      const ang = (i / 7) * Math.PI * 2 + 0.35;
      const dist = 33 + rand() * 6;
      const fx = Math.cos(ang) * dist, fz = Math.sin(ang) * dist;
      const w = 16 + rand() * 8, d = 11 + rand() * 6;
      const clear = hillSpots.every((h) => Math.hypot(h.x - fx, h.z - fz) > h.r + Math.max(w, d) * 0.45);
      if (!clear) continue;
      fields.push({
        geo: fieldGeo,
        pos: [fx, 0.03, fz],
        rot: [0, -ang + Math.PI / 2, 0],
        scale: [w, 1, d],
      });
    }
    if (fields.length) {
      const mesh = new THREE.Mesh(mergeGeos(fields), new THREE.MeshLambertMaterial({
        map: fieldTexture(), polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
      }));
      mesh.receiveShadow = false;
      scene.add(mesh);
    }
    fieldGeo.dispose();
  }

  // ---- 作物 / 草 / 花 / 远景 ----
  buildCrops(scene, rand);
  buildGrassAndFlowers(scene, rand, boxObstacles);
  buildLeaves(scene, rand);
  buildGroundDetails(scene);
  const clouds = buildClouds(scene, rand);
  const far = buildFar(scene, rand);

  // 池塘里的水车：木架 + 轮子（轮子单独转）
  const spinners = [];   // 精细模型里能转的部件（水车轮）
  const wheelGroup = new THREE.Group();
  {
    const wx = 10, wz = -18.6, wr = 1.25;
    const base = groundHeight(wx, wz);
    // 岸边支架（北侧）
    const frame = new Deco();
    frame.add('plankDark', G.box, wx - 0.8, base + 1.0, wz + 1.55, null, [0.12, 2.0, 0.12]);
    frame.add('plankDark', G.box, wx + 0.8, base + 1.0, wz + 1.55, null, [0.12, 2.0, 0.12]);
    frame.add('plankDark', G.box, wx, base + 1.95, wz + 1.55, null, [1.75, 0.11, 0.11]);
    // 轴：从轮毂穿到岸边支架、末端埋在轴承块里（之前轴头停在半空）
    frame.add('trunk', G.cyl8, wx, base + 1.05, wz + 0.80, [Math.PI / 2, 0, 0], [0.11, 1.80, 0.11]);
    frame.add('plankDark', G.box, wx, base + 1.05, wz + 1.55, null, [0.42, 0.42, 0.26]);
    frame.add('metal', G.cyl12, wx, base + 1.05, wz + 1.72, [Math.PI / 2, 0, 0], [0.16, 0.1, 0.16]);
    const frameMeshes = frame.build(scene);
    // 轮子：轮毂 + 8 根辐条 + 8 块桨板
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 0.18, 8), MAT.plankDark);
    hub.rotation.x = Math.PI / 2;
    wheelGroup.add(hub);
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      const spoke = new THREE.Mesh(new THREE.BoxGeometry(0.07, wr * 2 - 0.08, 0.07), MAT.plank);
      spoke.position.set(Math.sin(a) * wr * 0.5, Math.cos(a) * wr * 0.5, 0);
      spoke.rotation.z = -a;
      wheelGroup.add(spoke);
      const paddle = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.26, 0.11), MAT.plankDark);
      paddle.position.set(Math.sin(a) * wr, Math.cos(a) * wr, 0);
      paddle.rotation.z = -a;
      wheelGroup.add(paddle);
    }
    wheelGroup.position.set(wx, base + 1.05, wz);   // 轮心压低：下缘桨板能碰到水面
    wheelGroup.traverse((m) => { m.castShadow = true; m.receiveShadow = true; });
    scene.add(wheelGroup);
    // 水车整体也可以被 精细模型替换（连木架一起藏）
    const wheelMeshes = [...frameMeshes, wheelGroup];
    for (const m of wheelMeshes) m.visible = false;      // 同上：等 精细水车模型
    swappable.set('waterwheel', { meshes: wheelMeshes, o: { x: wx, z: wz } });
  }

  // 天上的鸟：四只低模小鸟绕场盘旋（身体 + 两片会扇的翅膀 + 尾羽）
  // ⚠ 原来是两片 0.5m 的扁片拼成 V 形剪影、贴图一样不扇动，远看像一只奇怪的虫子（用户报过）
  const birds = [];
  {
    const bodyGeo = mergeGeos([
      { geo: new THREE.IcosahedronGeometry(1, 0), pos: [0, 0, 0], scale: [0.1, 0.09, 0.26] },
      { geo: new THREE.IcosahedronGeometry(1, 0), pos: [0, 0.04, 0.25], scale: [0.07, 0.07, 0.08] },
      { geo: new THREE.ConeGeometry(0.035, 0.13, 4), pos: [0, 0.03, 0.35], rot: [Math.PI / 2, 0, 0] },
      { geo: new THREE.BoxGeometry(0.14, 0.02, 0.2), pos: [0, 0.01, -0.33] },
    ]);
    const wingGeo = new THREE.BoxGeometry(0.58, 0.03, 0.22).translate(0.29, 0, 0);
    const birdMat = new THREE.MeshLambertMaterial({ color: 0x2f3a30 });
    for (let i = 0; i < 4; i++) {
      const g = new THREE.Group();
      const body = new THREE.Mesh(bodyGeo, birdMat);
      const wl = new THREE.Mesh(wingGeo, birdMat);
      const wr = new THREE.Mesh(wingGeo, birdMat);
      wl.position.set(0.07, 0.03, 0.02);
      wr.position.set(-0.07, 0.03, 0.02);
      wr.rotation.y = Math.PI;
      for (const m of [body, wl, wr]) m.castShadow = false;
      g.add(body, wl, wr);
      g.scale.setScalar(1.15 + i * 0.06);
      scene.add(g);
      birds.push({
        g, wl, wr, r: 14 + i * 3.6, y: 8.6 + i * 1.9, a: i * 1.7, sp: 0.1 + i * 0.018, ph: i * 2.3,
      });
    }
  }

  // 光照预设切换（main.js 用 ?light=dusk 或按 L 调）
  const setLighting = (mode) => {
    const p = LIGHT[mode] || LIGHT.day;
    sky.userData.paint(p.top, p.bot, p.mid);
    scene.fog.color.setHex(p.fog);
    scene.background.setHex(p.bg);
    sun.color.setHex(p.sun);
    sun.intensity = p.sunI;
    sun.position.set(p.sunPos[0], p.sunPos[1], p.sunPos[2]);
    hemi.color.setHex(p.hemiSky);
    hemi.groundColor.setHex(p.hemiGround);
    hemi.intensity = p.hemiI;
    ground.material.color.setHex(p.ground);
    if ('intensity' in sun.shadow) sun.shadow.intensity = p.shadowInt;
    // 冬天白天给冷光（同一个 day 预设，季节不同观感不同）
    if (mode === 'day' && SEASON === 'winter') {
      sun.color.setHex(0xf2f7ff);
      hemi.color.setHex(0xe4eefb);
      hemi.groundColor.setHex(0x8a9080);
    }
  };
  setLighting('day');

  // 蝴蝶：菜园/花丛上方几只小方块，慢慢飘 + 扇翅膀
  const butterflies = [];
  {
    const wing = new THREE.PlaneGeometry(0.13, 0.1);
    const cols = [0xfff2b0, 0xffc9de, 0xffd27a, 0xd7c4ff, 0xfff2b0];
    for (let i = 0; i < 5; i++) {
      const m = new THREE.Mesh(wing, new THREE.MeshBasicMaterial({
        color: cols[i % cols.length], side: THREE.DoubleSide, transparent: true, opacity: 0.95,
      }));
      m.castShadow = false;
      scene.add(m);
      butterflies.push({
        mesh: m, cx: 14.5 + rand() * 7, cz: 4 + rand() * 8,
        ph: rand() * 6.28, sp: 0.5 + rand() * 0.6, r: 1.0 + rand() * 1.8, h: 0.75 + rand() * 0.7,
      });
    }
  }

  // 池塘里的两只野鸭（慢慢绕圈 + 上下浮动）
  const ducks = [];
  {
    // 一只白鸭、一只绿头野鸭：颜色分开才读得出是"鸭"
    const mkDuck = (bodyMat, headMat) => {
      const g = new THREE.Group();
      const body = new THREE.Mesh(new THREE.SphereGeometry(0.32, 8, 6), bodyMat);
      body.scale.set(1, 0.62, 1.4);
      const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.14, 0.28, 6), headMat);
      neck.position.set(0, 0.26, 0.3); neck.rotation.x = 0.35;
      const head = new THREE.Mesh(new THREE.SphereGeometry(0.17, 8, 6), headMat);
      head.position.set(0, 0.42, 0.36);
      const beak = new THREE.Mesh(new THREE.ConeGeometry(0.07, 0.2, 5), MAT.petal);
      beak.position.set(0, 0.4, 0.54); beak.rotation.x = Math.PI / 2;
      const tail = new THREE.Mesh(new THREE.ConeGeometry(0.13, 0.32, 4), bodyMat);
      tail.position.set(0, 0.12, -0.44); tail.rotation.x = -Math.PI / 2;
      g.add(body, neck, head, beak, tail);
      g.scale.setScalar(1.45);
      g.traverse((m) => { m.castShadow = true; m.receiveShadow = true; });
      return g;
    };
    const duckCfg = [[MAT.white, MAT.white], [MAT.duckBrown, MAT.duckGreen]];
    for (let i = 0; i < 2; i++) {
      const g = mkDuck(duckCfg[i][0], duckCfg[i][1]);
      scene.add(g);
      // ⚠ 绕圈中心/半径要避开小船（x 10.6~14）与栈桥：原来 r=1.5/2.3 绕 (10,-21)，
      //   会从小船的船尾穿过去（用户报过"鸭子在旋转的时候会穿模"）
      ducks.push({ g, r: 0.9 + i * 0.5, a: i * 2.4, sp: 0.16 + i * 0.06, ph: i * 1.7 });
    }
  }

  let tt = 0;
  const update = (dt, playerPos) => {
    tt += dt;
    for (const d of ducks) {
      d.a += dt * d.sp;
      const dx = 8.2 + Math.cos(d.a) * d.r, dz = -21.9 + Math.sin(d.a) * d.r * 0.72;
      d.g.position.set(dx, 0.14 + Math.sin(tt * 1.7 + d.ph) * 0.045, dz);
      d.g.rotation.y = -d.a + Math.PI * 0.5;
    }
    for (const b of butterflies) {
      const a = tt * b.sp + b.ph;
      const bx = b.cx + Math.sin(a) * b.r, bz = b.cz + Math.cos(a * 0.8) * b.r * 0.7;
      b.mesh.position.set(bx, groundHeight(bx, bz) + b.h + Math.sin(tt * 2.6 + b.ph) * 0.16, bz);
      b.mesh.rotation.y = -a;
      b.mesh.scale.x = 0.45 + Math.abs(Math.sin(tt * 14 + b.ph)) * 0.75;
    }
    for (const b of birds) {
      b.a += dt * b.sp;
      const bx = Math.cos(b.a) * b.r, bz = Math.sin(b.a) * b.r;
      b.g.position.set(bx, b.y + Math.sin(b.a * 2.3 + b.ph) * 0.5, bz);
      b.g.rotation.y = -b.a;                       // 机头对着切线方向
      b.g.rotation.z = Math.sin(b.a + b.ph) * 0.12; // 转弯时轻微压坡
      const f = Math.sin(tt * 7.2 + b.ph);
      b.wl.rotation.z = 0.28 + f * 0.6;
      b.wr.rotation.z = 0.28 + f * 0.6;
    }
    for (const c of clouds) {
      c.position.x += dt * 0.6;
      if (c.position.x > 96) c.position.x = -96;
    }
    if (far.hub) far.hub.rotation.z += dt * 0.45;
    wheelGroup.rotation.z -= dt * 0.32;
    for (const s of spinners) s.rotation.z -= dt * 0.32;
    // 大门：玩家走到 4.5m 内就推开，走远自动关
  };

  return {
    scene, camera, obstacles: [], boxObstacles, sun, update, setLighting,
    swappable,
    spinners,
    /** 隐藏某个自建道具（返回它的障碍记录，给模型定位用） */
    swapOut(key) {
      const s = swappable.get(key);
      if (!s) return null;
      for (const m of s.meshes) m.visible = false;
      swappedKeys.add(key);        // 记一笔：之后 showAllFallbacks 不会把这个又放出来（会两份叠着）
      return s.o;
    },
    /** 精细模型没拉到（或根本没开）：把自建版放出来，别让位置空着 */
    showFallback(key) {
      if (swappedKeys.has(key)) return;      // 已经换成精细模型了，别把自建版又摆回去
      const s = swappable.get(key);
      if (!s) return;
      for (const m of s.meshes) m.visible = true;
    },
    showAllFallbacks() {
      for (const key of swappable.keys()) this.showFallback(key);
    },
  };
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
