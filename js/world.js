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

// 土路折线（主路：鸡舍门口 → 场地中央 → 饲料槽；支线：主路 → 菜园）
const PATH_MAIN = [[-11, -6.2], [-9.2, -3.8], [-6.0, -1.0], [-1.4, 2.4], [3.2, 6.2], [7.4, 9.4], [9, 10.7]];
const PATH_BRANCH = [[3.2, 6.2], [6.6, 5.6], [10.2, 5.1], [13.6, 4.9], [15.2, 4.7]];
const PATH_WELL = [[-1.4, 2.4], [-2.1, -4.0], [-2.4, -9.5], [-2.1, -14.5], [-2, -16.4]];
const PATH_ALL = [PATH_MAIN, PATH_BRANCH, PATH_WELL];

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
function groundTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 512;
  const g = c.getContext('2d');
  g.fillStyle = '#7fae46';
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
  // 左右边缘压深，路和草地之间有个自然过渡
  const grdL = g.createLinearGradient(0, 0, 34, 0);
  grdL.addColorStop(0, 'rgba(112,92,52,0.55)'); grdL.addColorStop(1, 'rgba(112,92,52,0)');
  g.fillStyle = grdL; g.fillRect(0, 0, 34, 256);
  const grdR = g.createLinearGradient(256, 0, 222, 0);
  grdR.addColorStop(0, 'rgba(112,92,52,0.55)'); grdR.addColorStop(1, 'rgba(112,92,52,0)');
  g.fillStyle = grdR; g.fillRect(222, 0, 34, 256);
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
  box('coop', -11, -9, 7, 5.5, 3.2);          // 鸡舍
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
  box('compost', 7.5, 2.6, 2.2, 1.6, 0.7);             // 堆肥
  box('shed', -20, -6, 4.0, 3.2, 2.4);                 // 草料棚（靠左围栏，别挡住中间的追逐路线）
  return o;
}

// 单个道具 → 零件（绝对坐标，已含地形高度）
function buildProp(d, o) {
  const y0 = groundHeight(o.x, o.z);
  const x = o.x, z = o.z;
  switch (o.type) {
    case 'fence': {
      const horizontal = o.w > o.d;
      const len = horizontal ? o.w : o.d;
      d.add('fence', G.box, x, y0 + o.h / 2, z, null, horizontal ? [len, o.h, 0.12] : [0.12, o.h, len]);
      d.add('fenceTop', G.box, x, y0 + o.h - 0.05, z, null, horizontal ? [len, 0.09, 0.08] : [0.08, 0.09, len]);
      const n = Math.max(2, Math.round(len / 3));
      for (let i = 0; i <= n; i++) {
        const t = -len / 2 + (len / n) * i;
        d.add('fenceTop', G.box, horizontal ? x + t : x, y0 + (o.h + 0.15) / 2, horizontal ? z : z + t,
          null, [0.18, o.h + 0.15, 0.18]);
      }
      break;
    }
    case 'coop': {
      const w = o.w, dep = o.d, h = o.h;
      d.add('coopWall', G.box, x, y0 + h / 2, z, null, [w, h, dep]);
      // 双坡屋顶 + 屋脊压条
      d.add('coopRoof', G.box, x - w * 0.24, y0 + h + 0.42, z, [0, 0, 0.5], [w * 0.62, 0.18, dep + 0.5]);
      d.add('coopRoof', G.box, x + w * 0.24, y0 + h + 0.42, z, [0, 0, -0.5], [w * 0.62, 0.18, dep + 0.5]);
      d.add('coopTrim', G.box, x, y0 + h + 0.86, z, null, [0.16, 0.1, dep + 0.6]);
      // 墙脚一圈石基 + 屋顶檐口
      d.add('coopTrim', G.box, x, y0 + 0.08, z, null, [w + 0.2, 0.16, dep + 0.2]);
      d.add('plankDark', G.box, x, y0 + h - 0.02, z + dep / 2 + 0.04, null, [w + 0.1, 0.12, 0.1]);
      // 门（朝 +z）+ 门框 + 门把手
      d.add('coopDoor', G.box, x, y0 + 0.8, z + dep / 2 + 0.03, null, [1.1, 1.6, 0.1]);
      d.add('coopTrim', G.box, x - 0.62, y0 + 0.8, z + dep / 2 + 0.05, null, [0.12, 1.72, 0.1]);
      d.add('coopTrim', G.box, x + 0.62, y0 + 0.8, z + dep / 2 + 0.05, null, [0.12, 1.72, 0.1]);
      d.add('coopTrim', G.box, x, y0 + 1.66, z + dep / 2 + 0.05, null, [1.36, 0.12, 0.1]);
      d.add('metal', G.box, x + 0.42, y0 + 0.85, z + dep / 2 + 0.1, null, [0.07, 0.2, 0.06]);
      // 小窗（白框 + 深色玻璃 + 十字窗棂）
      d.add('coopTrim', G.box, x - 2.2, y0 + 1.95, z + dep / 2 + 0.04, null, [1.0, 0.9, 0.08]);
      d.add('glass', G.box, x - 2.2, y0 + 1.95, z + dep / 2 + 0.08, null, [0.8, 0.7, 0.06]);
      d.add('coopTrim', G.box, x - 2.2, y0 + 1.95, z + dep / 2 + 0.11, null, [0.06, 0.7, 0.04]);
      d.add('coopTrim', G.box, x - 2.2, y0 + 1.95, z + dep / 2 + 0.11, null, [0.8, 0.06, 0.04]);
      // 门前的坡道
      d.add('plank', G.box, x, y0 + 0.14, z + dep / 2 + 0.95, [-0.2, 0, 0], [1.5, 0.08, 1.5]);
      // 靠墙一排产蛋箱
      d.add('plank', G.box, x + 2.35, y0 + 0.5, z + dep / 2 + 0.24, null, [1.5, 0.6, 0.5]);
      d.add('plankDark', G.box, x + 2.35, y0 + 0.82, z + dep / 2 + 0.26, null, [1.6, 0.08, 0.58]);
      for (let i = 0; i < 3; i++) {
        d.add('coopDoor', G.box, x + 1.75 + i * 0.6, y0 + 0.56, z + dep / 2 + 0.5, null, [0.3, 0.28, 0.06]);
      }
      // 门口散落的稻草
      const straw = [[-0.9, 0.55, 0.35], [0.7, 0.75, -0.4], [-0.3, 1.15, 1.1], [1.1, 0.5, 0.9], [-1.3, 0.95, 0.6]];
      for (const [dx, dz, rz] of straw) {
        d.add('hay', G.box, x + dx, y0 + 0.05, z + dep / 2 + dz, [0, rz, 0.05], [0.5, 0.03, 0.06]);
      }
      // 产蛋箱前地上的蛋
      for (let i = 0; i < 4; i++) {
        d.add('white', G.ico, x + 1.6 + i * 0.42, y0 + 0.16, z + dep / 2 + 0.6 + (i % 2) * 0.18,
          [0, i, 0], [0.1, 0.14, 0.1]);
      }
      // 门上方的木牌（空白的，不写字）
      d.add('plank', G.box, x, y0 + 2.42, z + dep / 2 + 0.06, null, [1.5, 0.42, 0.06]);
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
      for (const [dx, dz] of [[-0.95, -0.95], [0.95, -0.95], [-0.95, 0.95], [0.95, 0.95]]) {
        d.add('plankDark', G.box, x + dx, y0 + 1.5, z + dz, null, [0.12, 1.2, 0.12]);
      }
      d.add('coopRoof', G.box, x - 0.5, y0 + 2.2, z, [0, 0, 0.55], [1.3, 0.1, 2.3]);
      d.add('coopRoof', G.box, x + 0.5, y0 + 2.2, z, [0, 0, -0.55], [1.3, 0.1, 2.3]);
      d.add('plankDark', G.cyl8, x, y0 + 1.92, z, [0, 0, Math.PI / 2], [0.06, 2.1, 0.06]);
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
    case 'garden': {
      d.add('soil', G.box, x, y0 + 0.15, z, null, [o.w, 0.3, o.d]);
      d.add('plank', G.box, x, y0 + 0.2, z - o.d / 2 - 0.04, null, [o.w + 0.1, 0.22, 0.1]);
      d.add('plank', G.box, x, y0 + 0.2, z + o.d / 2 + 0.04, null, [o.w + 0.1, 0.22, 0.1]);
      d.add('plank', G.box, x - o.w / 2 - 0.04, y0 + 0.2, z, null, [0.1, 0.22, o.d]);
      d.add('plank', G.box, x + o.w / 2 + 0.04, y0 + 0.2, z, null, [0.1, 0.22, o.d]);
      // 垄沟：两条深色浅槽，土面不再是一块平板
      d.add('soilDark', G.box, x, y0 + 0.305, z - 0.4, null, [o.w - 0.6, 0.02, 0.14]);
      d.add('soilDark', G.box, x, y0 + 0.305, z + 0.4, null, [o.w - 0.6, 0.02, 0.14]);
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
      // 睡莲叶 + 两朵花
      for (const [dx, dz, r] of [[-1.3, 0.9, 0.42], [0.9, -1.1, 0.36], [1.4, 1.3, 0.3], [-0.6, -1.4, 0.33]]) {
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
      d.add('plank', G.box, x - w / 2 + 0.1, y0 + 0.8, z, null, [0.1, 1.5, dep]);
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

// 地面土路：沿折线的条带网格，逐点贴合高度场
function ribbon(pts, half) {
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
    const y = groundHeight(p.x, p.z) + 0.035;
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

// 天空穹顶：顶点色从地平线到天顶做渐变（纯色天空太单薄）
function buildSky(scene) {
  const R = 170;
  const geo = new THREE.SphereGeometry(R, 24, 14);
  const pos = geo.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  const top = new THREE.Color(0x6fb2e2);
  const bot = new THREE.Color(0xdaf0fb);
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const t = Math.max(0, Math.min(1, pos.getY(i) / R * 0.9 + 0.16));
    c.copy(bot).lerp(top, t);
    colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const sky = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
    vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false,
  }));
  sky.frustumCulled = false;
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
  // 农舍（左后方）
  const fx = -37, fz = -27, fy = 0;
  far.add('wallFar', G.box, fx, fy + 1.8, fz, [0, 0.5, 0], [7, 3.6, 5.4]);
  far.add('roofFar', G.box, fx - 1.5, fy + 4.1, fz, [0, 0.5, 0.42], [4.6, 0.24, 6.2]);
  far.add('roofFar', G.box, fx + 1.5, fy + 4.1, fz, [0, 0.5, -0.42], [4.6, 0.24, 6.2]);
  far.add('coopDoor', G.box, fx + 1.4, fy + 1.1, fz + 2.5, [0, 0.5, 0], [1.1, 2.2, 0.12]);
  far.add('glass', G.box, fx - 1.6, fy + 2.2, fz + 2.5, [0, 0.5, 0], [1.0, 0.9, 0.1]);
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
  const cabbages = [];
  for (const z of [GARDEN.zs[0], GARDEN.zs[2]]) {
    for (let i = 0; i < 11; i++) cabbages.push([GARDEN.x - 3.2 + i * 0.64, z + (rand() - 0.5) * 0.5]);
  }
  const cabGeo = mergeGeos([
    // 外层菜叶（矮圆锥）+ 菜心（压扁的球）：单色也能看出是棵白菜
    { geo: new THREE.ConeGeometry(0.33, 0.22, 7), pos: [0, -0.14, 0] },
    { geo: new THREE.IcosahedronGeometry(0.25, 0), pos: [0, 0.02, 0], scale: [1, 0.86, 1] },
  ]);
  const cabMesh = new THREE.InstancedMesh(cabGeo, MAT.crop, cabbages.length);
  const dummy = new THREE.Object3D();
  cabbages.forEach(([x, z], i) => {
    dummy.position.set(x, groundHeight(x, z) + 0.52, z);
    dummy.rotation.set(0, rand() * 3.14, 0);
    dummy.scale.setScalar(0.8 + rand() * 0.5);
    dummy.updateMatrix();
    cabMesh.setMatrixAt(i, dummy.matrix);
  });
  cabMesh.castShadow = true;
  scene.add(cabMesh);

  // 玉米：粗一点的杆 + 五片斜叶 + 顶穗；穗子单独一层（黄色）
  const cornGeo = mergeGeos([
    { geo: new THREE.CylinderGeometry(0.045, 0.06, 1.5, 6), pos: [0, 0.75, 0] },
    { geo: new THREE.ConeGeometry(0.16, 1.0, 4), pos: [0.2, 0.72, 0], rot: [0, 0, -0.55], scale: [1, 1, 0.3] },
    { geo: new THREE.ConeGeometry(0.16, 0.95, 4), pos: [-0.19, 0.92, 0.04], rot: [0, 0, 0.62], scale: [1, 1, 0.3] },
    { geo: new THREE.ConeGeometry(0.15, 0.9, 4), pos: [0, 1.1, -0.18], rot: [0.6, 0, 0], scale: [1, 1, 0.3] },
    { geo: new THREE.ConeGeometry(0.15, 0.85, 4), pos: [0, 0.6, 0.2], rot: [-0.6, 0, 0], scale: [1, 1, 0.3] },
    { geo: new THREE.ConeGeometry(0.07, 0.35, 5), pos: [0, 1.62, 0] },
  ]);
  const cornMesh = new THREE.InstancedMesh(cornGeo, MAT.corn, 10);
  const cobMesh = new THREE.InstancedMesh(new THREE.CapsuleGeometry(0.055, 0.22, 3, 6), MAT.petal, 10);
  for (let i = 0; i < 10; i++) {
    const x = GARDEN.x - 3.0 + i * 0.67, z = GARDEN.zs[1] + (rand() - 0.5) * 0.45;
    const y = groundHeight(x, z) + 0.3;
    dummy.position.set(x, y, z);
    dummy.rotation.set(0, rand() * 3.14, 0);
    dummy.scale.setScalar(0.9 + rand() * 0.3);
    dummy.updateMatrix();
    cornMesh.setMatrixAt(i, dummy.matrix);
    // 玉米穗挂在杆侧
    dummy.position.set(x + 0.12, y + 0.85, z + 0.1);
    dummy.rotation.set(0.3, rand() * 3.14, 0.25);
    dummy.scale.setScalar(1);
    dummy.updateMatrix();
    cobMesh.setMatrixAt(i, dummy.matrix);
  }
  cornMesh.castShadow = true;
  cobMesh.castShadow = false;
  scene.add(cornMesh, cobMesh);
}

// 草簇 + 野花：实例化，颜色按实例给（各一个 draw call）
function buildGrassAndFlowers(scene, rand) {
  const tuft = mergeGeos([
    { geo: new THREE.BoxGeometry(0.035, 0.42, 0.035), pos: [0, 0.21, 0] },
    { geo: new THREE.BoxGeometry(0.032, 0.36, 0.032), pos: [0, 0.18, 0], rot: [0, 2.1, 0] },
    { geo: new THREE.BoxGeometry(0.03, 0.3, 0.03), pos: [0, 0.15, 0], rot: [0, 4.2, 0] },
  ]);
  const N = innerWidth < 760 ? 220 : 320;   // 手机上草少一些（视觉密度够，三角面省三成）
  const blades = new THREE.InstancedMesh(tuft, new THREE.MeshLambertMaterial({ color: 0xffffff }), N);
  const dummy = new THREE.Object3D();
  const c = new THREE.Color();
  const greens = [0x6da33f, 0x7cb44a, 0x5d9438, 0x86bd52];
  for (let i = 0; i < N; i++) {
    let gx = (rand() * 2 - 1) * (WORLD_HALF - 1.2);
    let gz = (rand() * 2 - 1) * (WORLD_HALF - 1.2);
    // 土路、菜畦、池塘上不长草（否则草会从路里冒出来）
    for (let k = 0; k < 6 && distToPath(gx, gz) < 1.9; k++) {
      gx = (rand() * 2 - 1) * (WORLD_HALF - 1.2);
      gz = (rand() * 2 - 1) * (WORLD_HALF - 1.2);
    }
    if (distToPath(gx, gz) < 1.9) continue;
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
    if (distToPath(fx, fz) < 1.7) continue;
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
    map: dirt, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3,
  });
  const main = new THREE.Mesh(ribbon(PATH_MAIN, 1.25), pathMat);
  const branch = new THREE.Mesh(ribbon(PATH_BRANCH, 1.0), pathMat);
  const wellRoad = new THREE.Mesh(ribbon(PATH_WELL, 0.9), pathMat);
  for (const m of [main, branch, wellRoad]) {
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
    [10, -21, 7.4, 7.4, 0], [9, 11, 3.2, 2.0, 0],
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

  buildSky(scene);

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

  const rand = mulberry32(42);

  // ---- 围栏外的远景山丘（装饰，靠雾与天空衔接；九座合成一个 mesh） ----
  const hills = [];
  for (let i = 0; i < 9; i++) {
    const ang = (i / 9) * Math.PI * 2 + rand() * 0.5;
    const dist = WORLD_HALF + 14 + rand() * 18;
    const r = 7 + rand() * 8;
    hills.push({
      geo: new THREE.SphereGeometry(r, 12, 8),
      pos: [Math.cos(ang) * dist, -2.5, Math.sin(ang) * dist],
      scale: [1, 0.55, 1],
    });
  }
  const hillMesh = new THREE.Mesh(mergeGeos(hills), MAT.hill);
  hillMesh.receiveShadow = true;
  scene.add(hillMesh);

  // ---- 道具：全部按材质合并（draw call 远少于零件数） ----
  const deco = new Deco();
  for (const o of obstacles) buildProp(deco, o);
  // 围栏大门（右栅栏上的一段，纯装饰）
  const gy = groundHeight(WORLD_HALF, -2);
  deco.add('fenceTop', G.box, WORLD_HALF, gy + 0.9, -4.4, null, [0.26, 1.8, 0.26]);
  deco.add('fenceTop', G.box, WORLD_HALF, gy + 0.9, 0.4, null, [0.26, 1.8, 0.26]);
  for (const yy of [0.45, 0.95, 1.45]) {
    deco.add('plank', G.box, WORLD_HALF, gy + yy, -2, null, [0.1, 0.12, 4.6]);
  }
  deco.add('plank', G.box, WORLD_HALF, gy + 0.95, -2, [0.24, 0, 0], [0.08, 0.1, 4.9]);
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
  // 围栏边的灌木丛（低矮装饰，不参与碰撞）
  for (const [bx, bz, bs] of [[-24.2, -12.5, 0.55], [-23.4, -10.2, 0.42], [23.6, 6.4, 0.5],
    [24.2, 9.1, 0.38], [-9.5, 23.8, 0.48], [-6.8, 24.1, 0.36], [17.5, -23.6, 0.45], [20.4, -23.2, 0.34]]) {
    const by = groundHeight(bx, bz);
    deco.add('leaf', G.ico, bx, by + bs * 0.55, bz, [0, bx, 0], [bs, bs * 0.7, bs]);
    deco.add('leaf2', G.ico, bx + bs * 0.5, by + bs * 0.4, bz + bs * 0.3, [0, bz, 0], [bs * 0.65, bs * 0.5, bs * 0.65]);
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
    const wx = 13.4, wz = 6.6, wy = groundHeight(wx, wz);
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
  deco.build(scene);

  // ---- 作物 / 草 / 花 / 远景 ----
  buildCrops(scene, rand);
  buildGrassAndFlowers(scene, rand);
  buildGroundDetails(scene);
  const clouds = buildClouds(scene, rand);
  const far = buildFar(scene, rand);

  // 天上的鸟：三只 V 形剪影慢慢绕场飞（点缀，不影响任何逻辑）
  const birds = [];
  {
    const birdGeo = mergeGeos([
      { geo: new THREE.BoxGeometry(0.5, 0.04, 0.06), pos: [0, 0, 0], rot: [0, 0, 0.22] },
      { geo: new THREE.BoxGeometry(0.5, 0.04, 0.06), pos: [0, 0, 0], rot: [0, 0, -0.22] },
    ]);
    const birdMat = new THREE.MeshBasicMaterial({ color: 0x3b4a3a });
    for (let i = 0; i < 3; i++) {
      const b = new THREE.Mesh(birdGeo, birdMat);
      b.scale.setScalar(1.4);
      scene.add(b);
      birds.push({ mesh: b, r: 17 + i * 5, y: 15 + i * 2.5, a: i * 2.1, sp: 0.09 + i * 0.02 });
    }
  }

  const update = (dt) => {
    for (const b of birds) {
      b.a += dt * b.sp;
      b.mesh.position.set(Math.cos(b.a) * b.r, b.y + Math.sin(b.a * 2.3) * 0.6, Math.sin(b.a) * b.r);
      b.mesh.rotation.y = -b.a + Math.PI / 2;
    }
    for (const c of clouds) {
      c.position.x += dt * 0.6;
      if (c.position.x > 96) c.position.x = -96;
    }
    if (far.hub) far.hub.rotation.z += dt * 0.45;
  };

  return { scene, camera, obstacles: [], boxObstacles, sun, update };
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
