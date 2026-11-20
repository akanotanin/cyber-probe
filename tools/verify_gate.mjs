// 大门开合的浏览器实测（裸 CDP，不依赖 playwright，与 cdp_test.mjs 同一套姿势）：
//   玩家瞬移到门口 → 门扇转起来；走远 → 自动关回；过程平滑不瞬跳。
// 跑法（mock/serve.py 起 8899、farm_server 起 28910 之后）：
//   node tools/verify_gate.mjs
//   GATE_URL='https://farm.example.com/chicken/?debug' node tools/verify_gate.mjs   # 线上专项
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const URL_ = process.env.GATE_URL
  || 'http://127.0.0.1:8899/chicken/?debug&nomodels&ws=ws://127.0.0.1:28910';
const PORT = 9413;
const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find(existsSync);
if (!CHROME) { console.error('no chrome found'); process.exit(1); }

mkdirSync('shots', { recursive: true });
const profile = `${process.env.LOCALAPPDATA}/Temp/cdp-gate-${Date.now()}`;
const proc = spawn(CHROME, [
  '--headless=new', '--remote-debugging-port=' + PORT, '--remote-allow-origins=*',
  `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
  '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--hide-scrollbars',
  '--window-size=1280,800', '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
], { stdio: 'ignore' });

let wsUrl = null;
for (let i = 0; i < 60 && !wsUrl; i++) {
  await sleep(300);
  try { wsUrl = (await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json()).webSocketDebuggerUrl; } catch { }
}
if (!wsUrl) { console.error('chrome 调试端口没起来'); proc.kill(); process.exit(1); }

const ws = new WebSocket(wsUrl);
await new Promise((res) => ws.addEventListener('open', res));
let id = 0, sessionId = null;
const pending = new Map(), logs = [];
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.method === 'Runtime.exceptionThrown') {
    logs.push(`${m.params.exceptionDetails.text} ${m.params.exceptionDetails.exception?.description || ''}`);
  }
});
const send = (method, params = {}, useSession = true) => {
  const msg = { id: ++id, method, params };
  if (useSession && sessionId) msg.sessionId = sessionId;
  ws.send(JSON.stringify(msg));
  return new Promise((res) => pending.set(msg.id, res));
};
const target = await send('Target.createTarget', { url: 'about:blank' }, false);
sessionId = (await send('Target.attachToTarget', { targetId: target.result.targetId, flatten: true }, false)).result.sessionId;
await send('Runtime.enable'); await send('Page.enable');

const evalJS = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) {
    throw new Error(r.result.exceptionDetails.text + ' '
      + (r.result.exceptionDetails.exception?.description || ''));
  }
  return r.result?.result?.value;
};

const fails = [];
const check = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS  ' : 'FAIL  '}${name}${cond ? '' : '  ' + detail}`);
  if (!cond) fails.push(name);
};

await send('Page.navigate', { url: URL_ });
let has = false;
for (let i = 0; i < 100 && !has; i++) {          // 最多等 ~40s（线上模块大）
  await sleep(400);
  has = await evalJS('!!(window.__farm && window.__farm.world && window.__farm.world.gateState)');
}
check('?debug 下有 world.gateState() 钩子（供量门扇角度）', has === true, 'no hook');

if (has) {
  const setPos = (x, z) => evalJS(`(() => {
    const f = window.__farm;
    f.player.pos.x = ${x}; f.player.pos.z = ${z}; f.player.pos.y = f.groundHeight(${x}, ${z});
    return true; })()`);
  const angles = () => evalJS('window.__farm.world.gateState().angles.map(Math.abs)');

  // 1) 远离门口 → 关着
  await setPos(20, 20);
  await sleep(900);
  const aFar = await angles();
  check('玩家远离时门是关着的', Array.isArray(aFar) && aFar.every((a) => a < 0.06), JSON.stringify(aFar));

  // 2) 门口 4.5m 内 → 推开
  await setPos(24.5, -2);
  await sleep(1100);
  const aNear = await angles();
  check('玩家走到门口 4.5m 内门会推开',
    Array.isArray(aNear) && aNear.some((a) => a > 1.0), JSON.stringify(aNear));

  // 3) 走远 → 自动关回
  await setPos(-10, 10);
  await sleep(1600);
  const aBack = await angles();
  check('走远后门自动关回', Array.isArray(aBack) && aBack.every((a) => a < 0.1), JSON.stringify(aBack));

  // 4) 平滑（有中间帧，不是瞬跳）
  await setPos(24.5, -2);
  const samples = [];
  for (let i = 0; i < 10; i++) { await sleep(45); samples.push(await angles()); }
  const mid = samples.some((s) => Array.isArray(s) && s.some((a) => a > 0.15 && a < 1.0));
  check('开合是平滑过渡（有中间帧，不瞬跳）', mid, JSON.stringify(samples.slice(0, 5)));

  // 5) 门开了也走不出去：边界碰撞盒仍在
  const boxed = await evalJS('(window.__farm.world.boxObstacles || []).length > 0');
  check('边界碰撞盒仍在（门开了也走不出去）', boxed === true, 'no boxObstacles');

  const r = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync('shots/gate-probe.png', Buffer.from(r.result.data, 'base64'));
  console.log('screenshot -> shots/gate-probe.png');
}

check('没有 JS 异常', logs.length === 0, logs.slice(0, 3).join(' | '));
ws.close();
proc.kill();
console.log(fails.length ? `\n失败 ${fails.length} 项` : '\n全部通过');
process.exit(fails.length ? 1 : 0);
