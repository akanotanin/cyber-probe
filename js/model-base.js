// 模型模块从哪来：**先本地、缺了再回落到远端**。
//
// 分层策略（安装/更新时会把能拉到的都下到 vendor/models/）：
//   1. 本地 <站点根>/vendor/models/<id>.js  —— 站点自己的文件，浏览器只跟你的域名说话
//   2. 远端 <模型源>/<id>.mjs               —— 没拉到的那几个先用远端顶着，下次安装/update 再补
// 远端地址不写在代码里：由安装器/部署写进 js/site-options.js 的 CP_OPTIONS.modelFallback
// （仓库里默认是空串 = 只认本地；拉不到就用 js/world.js 的自建道具兜底）。
//
// 落盘用 .js 而不是 .mjs：不少服务器（nginx 默认 mime.types）没有 .mjs 的 MIME 映射，
// 会按 application/octet-stream 返回，配合 nosniff 浏览器直接拒绝执行模块。
export const MODEL_DIR = new URL('../vendor/models/', import.meta.url).href;

function fallbackBase() {
  const v = (typeof window !== 'undefined' && window.CP_OPTIONS && window.CP_OPTIONS.modelFallback) || '';
  if (!v) return '';
  return String(v).replace(/\/?$/, '/');
}

/** 某个模型可以尝试的 URL 列表：本地优先，其次远端（没配远端就只有本地） */
export function modelUrls(id) {
  const list = [MODEL_DIR + id + '.js'];
  const fb = fallbackBase();
  if (fb) list.push(fb + id + '.mjs');
  return list;
}

/** 按顺序 import：本地失败自动试远端；都失败就抛（调用方退回自建道具） */
export async function importModel(id) {
  let lastErr;
  for (const url of modelUrls(id)) {
    try {
      return await import(/* @vite-ignore */ url);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('model unavailable: ' + id);
}
