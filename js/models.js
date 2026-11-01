// 精细低模装饰：从 模型库 的 CDN 取模型（官方支持热链、免账号、可商用免署名）。
//
// 为什么不把模型文件放进仓库：
//   它的许可允许「随便用在自己的游戏/网站里」，但不允许「再分发模型本体」。
//   热链只引 URL、不复制文件，所以公开仓库里不会出现第三方模型资产。
//   代价是运行时依赖对方 CDN —— 所以每个模型都有超时 + 静默失败：
//   拿不到就保留 js/world.js 里的自建版（world.swapOut 不会被调用），断网/被墙时只是少了细节，不影响可玩性。
//
// 尺寸都用模型自带的真实世界米（size_m），这里只做朝向修正：
//   模型库 的长边在 +z，我们的道具长边在 +x，所以需要 +90° 的朝向修正。

import * as THREE from 'three';
import { MODEL_IDS } from './model-ids.js';

const CDN = './vendor/models/';
export const PF_VERSION = 8;   // 改这个文件时 +1，方便确认浏览器真的拿到了新代码

/** 替换自建道具：key 必须与 js/world.js 里 buildObstacles() 的 `${type}@${x},${z}` 完全一致 */
const PLAN = [
  { key: 'tractor@13.5,-6.5', id: 'compact-tractor-35b84b', yaw: Math.PI / 2 - 0.55, s: 1.05 },
  { key: 'well@-2,-18', id: 'roofed-well-43a2fc', yaw: 0.3, s: 1.0 },
  { key: 'barrow@12.4,3.3', id: 'wheelbarrow-0f8406', yaw: Math.PI / 2 + 1.15, s: 1.0 },
  { key: 'scarecrow@12.8,8.2', id: 'scarecrow-334079', yaw: 0.45, s: 1.0 },
  { key: 'crate@-6.4,-6.2', id: 'wooden-crate-e46521', yaw: 0.2, s: 1.6 },
  { key: 'trough@9,11', id: 'plank-trough-baf3d5', yaw: 0, s: 1.0 },
  // 草垛 ×5（同一个模块只会下载一次，浏览器自己复用）
  { key: 'hay@6,-12', id: 'hay-bale-079e8c', yaw: 0.2, s: 2.2 },
  { key: 'hay@-15,10', id: 'hay-bale-079e8c', yaw: 1.1, s: 2.2 },
  { key: 'hay@13,3', id: 'hay-bale-079e8c', yaw: 2.4, s: 2.2 },
  { key: 'hay@-17,-12.5', id: 'hay-bale-079e8c', yaw: 0.7, s: 2.2 },
  { key: 'hay@10.5,13.5', id: 'hay-bale-079e8c', yaw: 1.9, s: 2.2 },
  { key: 'beehive@21.2,-1.2', id: 'beehive-2e70bf', yaw: 0.3, s: 2.2 },
  { key: 'compost@12.4,13.2', id: 'compost-heap-dfec38', yaw: 0.5, s: 2.0 },
  { key: 'bench@17.3,13.7', id: 'split-log-bench-289780', yaw: Math.PI * 0.9, s: 1.0 },
  { key: 'picnic@20.6,16.4', id: 'heavy-timber-picnic-table-1ac060', yaw: 0.35, s: 1.0 },
  // 主建筑：鸡舍（架高的木质鸡舍 + 坡道 + 产蛋箱）与草料棚
  { key: 'coop@-11,-9.65', id: 'chicken-coop-371f97', yaw: Math.PI / 2, s: 1.7 },
  { key: 'shed@-20,-6', id: 'open-woodshed-050a0a', yaw: Math.PI * 0.5, s: 1.0 },
  { key: 'tower@17.5,-20', id: 'fire-lookout-tower-75a129', yaw: Math.PI * 0.15, s: 0.8 },
  { key: 'woodpile@-15.8,-8.6', id: 'firewood-stack-8a2899', yaw: 0.4, s: 1.35 },
  { key: 'burro@16.2,-2.6', id: 'burro-with-marigold-panniers-1f04ab', yaw: -0.9, s: 1.35 },  // 驮货的驴（1.0 时肩高只有 0.8m，太小，用户报过）
  { key: 'waterwheel', id: 'stream-water-wheel-ea2d68', yaw: 0, s: 0.6 },
  // 树：散栽的换成橡树/阔叶树，果园 5 棵换成苹果树
  { key: 'tree@16,15', id: 'oak-tree-50ee7c', yaw: 0.4, s: 0.75 },
  { key: 'tree@-18,-15', id: 'broadleaf-oak-997c22', yaw: 1.2, s: 0.75 },
  { key: 'tree@19,-7', id: 'oak-tree-50ee7c', yaw: 2.1, s: 0.8 },
  { key: 'tree@-6,17', id: 'broadleaf-oak-997c22', yaw: 0.2, s: 0.7 },
  { key: 'tree@-19,4', id: 'oak-tree-50ee7c', yaw: 1.7, s: 0.72 },
  { key: 'tree@-21,12.5', id: 'orchard-apple-tree-b21f85', yaw: 0.5, s: 0.85 },
  { key: 'tree@-18,15.5', id: 'orchard-apple-tree-b21f85', yaw: 1.4, s: 0.85 },
  { key: 'tree@-22,18.5', id: 'orchard-apple-tree-b21f85', yaw: 2.6, s: 0.8 },
  { key: 'tree@-24,15.2', id: 'orchard-apple-tree-b21f85', yaw: 0.9, s: 0.9 },
  { key: 'tree@-19.5,19.5', id: 'orchard-apple-tree-b21f85', yaw: 3.4, s: 0.82 },   // 池塘水车（模型里能转的轮子会被 world.spinners 接管）
];

/** 纯新增装饰（没有碰撞，只是好看） */
const DECOR = [
  { id: 'hand-water-pump-448037', x: 14.2, z: 9.4, yaw: 0.6, s: 1.0 },      // 菜园边的手压水井
  { id: 'cauldron-on-coals-ddbab6', x: -14.6, z: -6.6, yaw: 0.3, s: 1.0 },  // 鸡舍旁的吊锅（煮饲料）
  // 池塘生态：芦苇丛 / 睡莲 / 岸边卵石 / 小船（都浮在水面，dy 抬高）
  { id: 'reed-bed-bbbefb', x: 6.6, z: -23.2, yaw: 0.4, s: 1.1 },
  { id: 'reed-bed-bbbefb', x: 13.4, z: -23.6, yaw: -0.5, s: 1.0 },
  { id: 'lily-pads-b0c5d0', x: 9.0, z: -19.6, yaw: 0.2, s: 1.0, dy: 0.13 },
  { id: 'lily-pads-b0c5d0', x: 11.8, z: -22.6, yaw: 1.2, s: 0.9, dy: 0.13 },
  { id: 'lake-pebbles-6c0359', x: 6.9, z: -20.2, yaw: 0.3, s: 0.9 },
  { id: 'lake-pebbles-6c0359', x: 13.2, z: -20.4, yaw: 1.4, s: 0.8 },
  { id: 'lake-pebbles-6c0359', x: 8.8, z: -24.3, yaw: 0.7, s: 0.9 },
  { id: 'wooden-rowboat-916981', x: 12.3, z: -19.9, yaw: -0.9, s: 1.0, dy: 0.14 },
  // 围栏外的"邻居农场"：远景地标，给场地做出纵深
  { id: 'grain-silo-58ca67', x: 30.5, z: 6, yaw: 0.3, s: 1.0 },
  // 邻居家：原 miner's shack 就是一块坡顶平板 + 两根交叉梁，太简陋 → 换成带门廊/烟囱/原木墙的小屋
  { id: 'porch-log-cabin-d2f3ef', x: 31, z: -9, yaw: 3.83, s: 0.72 },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function withTimeout(p, ms) {
  return Promise.race([
    p,
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
  ]);
}

/** 贴地（按包围盒底面对齐，别信模型自报的 origin_y）、朝向、缩放、投影 */
function place(g, x, z, yaw, s, groundHeight, dy = 0) {
  g.position.set(x, 0, z);
  g.rotation.y = yaw;
  if (s !== 1) g.scale.setScalar(s);
  g.updateMatrixWorld(true);
  const bb = new THREE.Box3().setFromObject(g);
  // 坡地上要找"四角最低的地面"再贴：只按中心点贴地会让下坡那侧悬空（小山包上实测悬空一片）
  const hx = Math.max(0.2, (bb.max.x - bb.min.x) / 2 - 0.15);
  const hz = Math.max(0.2, (bb.max.z - bb.min.z) / 2 - 0.15);
  let gy = groundHeight(x, z);
  for (const [dx, dz] of [[-hx, -hz], [hx, -hz], [-hx, hz], [hx, hz]]) {
    gy = Math.min(gy, groundHeight(x + dx, z + dz));
  }
  if (Number.isFinite(bb.min.y)) g.position.y = gy - bb.min.y - 0.02 + dy;
  g.traverse((m) => {
    if (m.isMesh) { m.castShadow = true; m.receiveShadow = true; }
  });
}

// 模型模块的下载在**模块加载时就开始**（models.js 被 main.js 顶层 import，早于 buildScene）：
// 网络和"搭场景"（~几百 ms）重叠，首帧时模型基本已经到手 —— 用户就不会先看到一批自建道具再被替换。
// 同一个 id 只下载一次（浏览器也会按 URL 复用模块）。
const mods = new Map();
function fetchMod(id, timeout = 7000) {
  let p = mods.get(id);
  if (!p) {
    p = withTimeout(import(/* @vite-ignore */ CDN + id + '.mjs'), timeout);
    p.catch(() => mods.delete(id));      // 失败了下次还能重试
    mods.set(id, p);
  }
  return p;
}

async function loadOne(id, timeout) {
  const mod = await fetchMod(id, timeout);
  const make = mod.createAsset || mod.default;
  if (typeof make !== 'function') throw new Error('no createAsset');
  return make();
}

// 立刻开跑（不 await）：清单在 js/model-ids.js（index.html 里的 js/prewarm.js 更早就跑了同一份）
for (const id of MODEL_IDS) fetchMod(id).catch(() => {});

/**
 * 把 PLAN 里的道具逐个换成 模型库 的模型，再摆上 DECOR。
 * 自建版在 world.js 里是**先藏起来的**（不让人先看到"旧模型"）；这里换成功就保持隐藏，
 * 换不上（超时/被墙）就把那个自建版放出来，位置不会空着。返回成功数量。
 */
export async function decorate(world, scene, groundHeight, opts = {}) {
  const timeout = opts.timeout || 7000;
  let ok = 0;

  const swapJobs = PLAN.map((p) => [p.id, p.key, async () => {
    const g = await loadOne(p.id, timeout);
    const o = world.swapOut(p.key);         // 先找自建版（找不到就不换，避免两份叠在一起）
    if (!o) throw new Error('no prop');
    place(g, o.x, o.z, p.yaw, p.s, groundHeight);
    g.userData.pf = p.id;
    // 模型自带的"能转的部件"（水车的轮子）：挂到 world.spinners，由渲染循环转
    g.traverse((m) => {
      if (world.spinners && m.name === 'wheel') world.spinners.push(m);   // 只认名字正好是 wheel 的组（拖拉机也有 wheel-* 子网格，别一起转）
    });
    scene.add(g);
  }]);
  const decorJobs = DECOR.map((p) => [p.id, null, async () => {
    const g = await loadOne(p.id, timeout);
    place(g, p.x, p.z, p.yaw, p.s, groundHeight, p.dy || 0);
    g.userData.pf = p.id;
    scene.add(g);
  }]);

  // ⚠ 不要错开请求：模型是一堆很小的模块（同 URL 浏览器自己复用），错开 110ms×N 会让
  //   最后一个道具在 3 秒后才换上来 —— 用户看到的就是"先进来看的是旧模型，过几秒才变新的"。
  //   现在全部同时 import（index.html 的 prewarm.js 更早就开始下载了）。
  const t0 = performance.now();
  window.__pfStart = Math.round(t0);      // decorate 开始时的时间戳（和首帧 FCP 对比用）
  window.__pfLog = [];
  const swapped = new Set();
  const total = swapJobs.length + decorJobs.length;
  await Promise.all([...swapJobs, ...decorJobs].map(async ([id, key, job]) => {
    try {
      await job();
      ok += 1;
      if (key) swapped.add(key);
      window.__pfLog.push([id, Math.round(performance.now() - t0)]);
      // 首屏等待条上显示进度，让人知道在等什么（换完/失败都不再更新）
      const el = document.querySelector('#boot span');
      if (el) el.textContent = `🐔 正在布置农场 ${ok}/${total}`;
    } catch { /* 静默：这个道具没拉到 → 下面把它自己的自建版放回来 */ }
  }));
  // 没换上的道具：把自建版放出来（它们一开始是藏着的，见 world.js 的 buildScene）
  for (const p of PLAN) if (!swapped.has(p.key)) world.showFallback(p.key);
  window.__pfSwapMs = Math.round(performance.now() - t0);   // 从开始加载到全部换完的耗时（调试用）
  window.__pfModels = ok;            // 调试/断言用：成功摆了几个
  window.__pfV = PF_VERSION;
  return ok;
}
