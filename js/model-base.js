// 模型模块放在哪：安装器（tools/fetch_models.sh）会把它们下载到 vendor/models/。
//
// 为什么不把模型文件提交进仓库：
//   模型来自 模型库（https://精细模型.dev/），它的许可允许在自己的作品里随便用、可商用免署名，
//   但不允许"再分发模型本体"（把文件放到自己的服务器/仓库给别人下载）。所以下载发生在安装这一步，
//   仓库里只有脚本与 id 清单；运行时浏览器只访问你自己的域名，不再打到第三方 CDN。
//
// 目录结构：<站点根>/vendor/models/<id>.mjs（与 vendor/three.module.js 同级的 vendor 目录）。
export const MODEL_DIR = new URL('../vendor/models/', import.meta.url).href;
