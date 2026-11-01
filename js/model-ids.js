// 精细模型 id 清单（唯一来源）：
//   · js/models.js 用它提前 import（网络与"搭场景"重叠）
//   · js/prewarm.js 在 index.html 里最先执行，**不依赖 three**，所以在 three.js 还在下载时
//     这些模型就已经在路上了 —— 用户进页面时不会先看到一批自建道具、几秒后才被替换。
// ⚠ 改 js/models.js 的 PLAN/DECOR（或 js/dog.js 的狗）时，记得同步这里；漏一个只是少预热一次，
//   不影响功能（models.js 的 loadOne 还会按需加载）。tools/ci.sh 有一条点名核对的静态门禁。
export const MODEL_IDS = [
  'compact-tractor-35b84b',
  'roofed-well-43a2fc',
  'wheelbarrow-0f8406',
  'scarecrow-334079',
  'wooden-crate-e46521',
  'plank-trough-baf3d5',
  'hay-bale-079e8c',
  'beehive-2e70bf',
  'compost-heap-dfec38',
  'split-log-bench-289780',
  'heavy-timber-picnic-table-1ac060',
  'chicken-coop-371f97',
  'open-woodshed-050a0a',
  'fire-lookout-tower-75a129',
  'firewood-stack-8a2899',
  'burro-with-marigold-panniers-1f04ab',
  'stream-water-wheel-ea2d68',
  'oak-tree-50ee7c',
  'broadleaf-oak-997c22',
  'orchard-apple-tree-b21f85',
  'hand-water-pump-448037',
  'cauldron-on-coals-ddbab6',
  'reed-bed-bbbefb',
  'lily-pads-b0c5d0',
  'lake-pebbles-6c0359',
  'wooden-rowboat-916981',
  'grain-silo-58ca67',
  'porch-log-cabin-d2f3ef',
  'farm-dog-723730',          // NPC·看门狗（js/dog.js）
];
