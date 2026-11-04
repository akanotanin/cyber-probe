// js/data.js 的输入净化回归（纯 Node，不需要浏览器）：
//   ① monitor /api/nodes 返回 [null] / {nodes:"bad"} 不能把整个 Farm 弄崩
//   ② 字符串延迟/丢包要被净化成数字或 null（详情页不会再拼出奇怪 HTML）
import path from 'node:path';
import { pathToFileURL } from 'node:url';

globalThis.window = { CP_OPTIONS: {} };
globalThis.document = {
  baseURI: 'http://example.test/chicken/index.html',
  hidden: false,
  addEventListener() {},
  removeEventListener() {},
};

const payloads = [
  [null, { id: 1, name: 'a', online: true, metrics: {} }],
  { nodes: 'bad' },
];
let which = 0;
globalThis.fetch = async (url) => {
  const p = new URL(String(url)).pathname;
  if (p.endsWith('/api/nodes')) {
    const data = payloads[Math.min(which++, payloads.length - 1)];
    return { ok: true, status: 200, json: async () => data };
  }
  return { ok: false, status: 404, json: async () => ({}) };
};

const { Farm } = await import(pathToFileURL(path.resolve('js/data.js')).href);
const fails = [];
const check = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + detail}`);
  if (!cond) fails.push(name);
};

const f = new Farm();
await f.refreshNodes();
check('null 节点被过滤（只留 1 个对象）', f.nodes.length === 1 && f.nodes[0].id === 1,
  JSON.stringify(f.nodes));
check('onlineCount 不因 null 条目抛异常', f.onlineCount === 1, String(f.onlineCount));

await f.refreshNodes();       // 第二次返回 {nodes:"bad"} → 应该当空数组，而不是抛 filter is not a function
check('畸形 d.nodes（字符串）退化成空数组', Array.isArray(f.nodes) && f.nodes.length === 0,
  JSON.stringify(f.nodes));

// 延迟/丢包净化：字符串数字转 number，垃圾值变 null
const okJson = (obj) => ({ ok: true, status: 200, json: async () => obj });
globalThis.fetch = async (url) => {
  const p = new URL(String(url)).pathname;
  if (p.includes('/metrics')) {
    return okJson({
      probes: { 1: 't' },
      ping: [{ task_id: 1, ts: Date.now() / 1000, latency: '42' },
             { task_id: 1, ts: Date.now() / 1000, latency: '</span><img onerror=x>' }],
      loss: { 1: '3.5' },
    });
  }
  return okJson({});
};
const m = await f._fetchPing({ id: 1, name: 'a' });
check('字符串延迟 42 被转成 number 42', m.get(1).latency === 42, String(m.get(1).latency));
check('字符串丢包 3.5 被转成 number 3.5', f.lossByNode.get(1)[1] === 3.5,
  String(f.lossByNode.get(1)[1]));
check('延迟不会把 HTML 拼进详情页（非法值归 null）',
  !JSON.stringify([...m]).includes('onerror'), JSON.stringify([...m]));

console.log();
if (fails.length) {
  console.log(`失败 ${fails.length} 项：${fails.join('，')}`);
  process.exit(1);
}
console.log('全部通过');

// 服务器时钟比浏览器慢 10 分钟：样本仍是新鲜的（不能拿 Date.now 直接减 p.ts）
f.nodes = [{ id: 2, name: 'skew', online: true, metrics: {} }];
f.probes = { 1: 't' };
f.ping = new Map();
globalThis.fetch = async (url) => {
  const p = new URL(String(url)).pathname;
  if (p.includes('/metrics')) {
    return okJson({ probes: { 1: 't' }, ping: [{ task_id: 1, ts: Date.now() / 1000 - 600, latency: 42 }] });
  }
  return okJson({});
};
const m2 = await f._fetchPing({ id: 2, name: 'skew' });
f._aggregate();
check('服务器时钟慢 10 分钟时样本仍判新鲜（按 skew 归一）',
      m2.get(1)?.latency === 42 && f.tasks.get(1)?.n === 1,
      JSON.stringify({ ping: [...m2], task: f.tasks.get(1) }));

// 运行时拼的 vendor/models URL 也要带 assetsV（cachebust 扫不到）
globalThis.window.CP_OPTIONS = { assetsV: 'v-test' };
const mb = await import(pathToFileURL(path.resolve('js/model-base.js')).href);
check('model-base：本地模型 URL 带 assetsV', mb.modelUrls('demo')[0].endsWith('.js?v=v-test'),
  mb.modelUrls('demo')[0]);
