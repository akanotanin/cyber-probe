// js/net.js 的连接状态回归（不需要真浏览器/真 WebSocket）。
// 覆盖 2026-11-04 复审发现的两条：
//   ① connect() 关旧 socket 后，旧 socket 迟到的 close 不能把新连接置空；
//   ② stop() 之后不能再被 onclose 安排重连。
import { pathToFileURL } from 'node:url';
import path from 'node:path';

globalThis.location = { protocol: 'http:', host: 'example.test' };
globalThis.document = { baseURI: 'http://example.test/chicken/' };

class FakeWS {
  static all = [];
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    FakeWS.all.push(this);
  }
  open() { this.readyState = 1; this.onopen?.(); }
  message(obj) { this.onmessage?.({ data: JSON.stringify(obj) }); }
  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    setTimeout(() => this.onclose?.({ code: 1006, reason: '' }), 0);
  }
  send(s) { this.sent.push(s); }
}
globalThis.WebSocket = FakeWS;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fails = [];
const check = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + detail}`);
  if (!cond) fails.push(name);
};

const { Net } = await import(pathToFileURL(path.resolve('js/net.js')).href);

const n = new Net();
n.connect();
const oldWs = n.ws;
n.connect();                     // 旧连接还在 CONNECTING 就被新 connect 关掉
const newWs = n.ws;
check('connect：新 socket 已替换旧 socket', !!newWs && newWs !== oldWs);

oldWs.open();                    // 旧 socket 迟到的 open 不能把状态写成 online
check('connect：旧 socket 迟到的 open 被忽略', n.mode !== 'online' || n.ws === newWs);

newWs.open();
check('connect：新 socket open 后在线', n.mode === 'online' && n.online === true, `mode=${n.mode}`);

await sleep(10);                 // 等旧 socket 的 onclose 到达
check('connect：旧 socket 迟到的 close 不置空新连接', n.ws === newWs && n.mode === 'online', `ws=${!!n.ws} mode=${n.mode}`);

newWs.message({ t: 'welcome', id: 7, tick: 1, ts: 1, cc: 'JP' });
check('welcome：id 被记录', n.id === 7, String(n.id));

n.stop();
await sleep(10);
check('stop：状态回到 local 且 socket 清空', n.mode === 'local' && n.ws === null, `mode=${n.mode} ws=${!!n.ws}`);
check('stop：不再安排重连（retryT 为空）', !n.retryT, String(n.retryT));

console.log();
if (fails.length) {
  console.log(`失败 ${fails.length} 项：${fails.join('，')}`);
  process.exit(1);
}
console.log('全部通过');
