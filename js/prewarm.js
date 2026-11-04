// 最先跑的一小段（index.html 里排在 main.js 之前，不 import three）：
// 只把模型模块（vendor/models/*.js）提前 import 出去。它们内部会 import 'three'（走 import map 里的本地副本），
// 所以这一步同时预热了 three.js —— 等 main.js 开始搭场景时，模型多半已经在内存里了。
//
// 为什么单独一个文件：js/models.js 顶部 import * as THREE，它的模块级代码要等 three 下载完才执行；
// 放在这里就没有这个等待，能早 1~2 秒开始下载（用户之前看到"先进来是旧模型、几秒后才换"就是这段）。
import { MODEL_IDS } from './model-ids.js';
import { importModel } from './model-base.js';

// ?nomodels 是给省流/AB 用的：连模型模块都不该下载（以前这里无条件预热，开关形同虚设）
if (typeof location === 'undefined' || !new URLSearchParams(location.search).has('nomodels')) {
  for (const id of MODEL_IDS) {
    importModel(id).catch(() => { /* 拉不到就算了：models.js 会按需重试，最差退回自建道具 */ });
  }
}
