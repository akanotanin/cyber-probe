// 用 CDP 驱动 headless Chrome 实测 cyber-probe：控制台错误、数据绑定、啄鸡/被啄的真逻辑、截图
// 用法: node tools/cdp_test.mjs [url] [outPrefix]
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

// 本地跑法：静态页走 mock 服，联机走本地游戏服（客户端已没有单机形态，必须真的连上）
// &cc=JP：本地没法经 Cloudflare（拿不到 CF-IPCountry），用它自报一个国旗码来验「访客鸡图标 = IP 所在地国旗」那条链路
const URL_ = (process.argv[2] || 'http://127.0.0.1:8899/chicken/?debug&cc=JP&ws=ws://127.0.0.1:28910') ;
const OUT = process.argv[3] || 'shots/farm';
const PORT = 9411;
const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find(existsSync);
if (!CHROME) { console.error('no chrome found'); process.exit(1); }

mkdirSync('shots', { recursive: true });
const profile = `${process.env.LOCALAPPDATA}/Temp/cdp-farm-${Date.now()}`;
// 额外 Chrome 参数。测**装在别人机器上**的实例时要用，例如：
//   CHROME_EXTRA='["--ignore-certificate-errors","--host-resolver-rules=MAP nezha.example.com 127.0.0.1"]' \
//     node tools/cdp_test.mjs "https://nezha.example.com:8443/chicken/?debug" shots/remote
// ⚠ 写成 JSON 数组：像 --host-resolver-rules 这种「值里带空格」的参数按空格切会被切坏
//   （切成 'nezha.example.com' + '127.0.0.1' 两个位置参数，Chrome 会当成两个网址去打开）。
const EXTRA = (() => {
  const raw = process.env.CHROME_EXTRA || '';
  if (!raw.trim()) return [];
  if (raw.trim().startsWith('[')) {
    try { return JSON.parse(raw); } catch { console.error('CHROME_EXTRA 不是合法 JSON，按空格切'); }
  }
  return raw.split(/\s+/).filter(Boolean);
})();
const proc = spawn(CHROME, [
  '--headless=new', '--remote-debugging-port=' + PORT, '--remote-allow-origins=*',
  `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
  '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--hide-scrollbars',
  '--window-size=1440,900', '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
  ...EXTRA,
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
  if (m.method === 'Runtime.consoleAPICalled') logs.push(`[console.${m.params.type}] ` + m.params.args.map((a) => a.value ?? a.description ?? a.type).join(' '));
  else if (m.method === 'Runtime.exceptionThrown') logs.push(`[EXCEPTION] ${m.params.exceptionDetails.text} ${m.params.exceptionDetails.exception?.description || ''}`);
  else if (m.method === 'Log.entryAdded' && ['error', 'warning'].includes(m.params.entry.level)) logs.push(`[log.${m.params.entry.level}] ${m.params.entry.text} ${m.params.entry.url || ''}`);
});
function send(method, params = {}, useSession = true) {
  const msg = { id: ++id, method, params };
  if (useSession && sessionId) msg.sessionId = sessionId;
  ws.send(JSON.stringify(msg));
  return new Promise((res) => pending.set(msg.id, res));
}
const target = await send('Target.createTarget', { url: 'about:blank' }, false);
sessionId = (await send('Target.attachToTarget', { targetId: target.result.targetId, flatten: true }, false)).result.sessionId;
await send('Runtime.enable'); await send('Log.enable'); await send('Page.enable');

async function evalJS(expr, awaitPromise = false) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise });
  if (r.result?.exceptionDetails) return { error: r.result.exceptionDetails.text + ' ' + (r.result.exceptionDetails.exception?.description || '') };
  return r.result?.result?.value;
}
async function shot(name) {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  const p = name.includes('/') ? name + '.png' : `shots/${name}.png`;
  mkdirSync(p.slice(0, p.lastIndexOf('/')), { recursive: true });
  writeFileSync(p, Buffer.from(r.result.data, 'base64'));
  console.log('screenshot ->', p);
}
const results = [];
function check(label, ok, extra = '') {
  results.push({ label, ok, extra });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? ' — ' + extra : ''}`);
}

await send('Page.navigate', { url: URL_ });
await sleep(1500);
// 进门不再拦遮罩：一打开就该是局内（场地 + HUD 直接可见）
// 等 JS 把说明条内容填上（线上模块较大，1.5 秒可能还没执行到那一行）
for (let i = 0; i < 20; i++) {
  const t = await evalJS(`(document.getElementById('hint') || {}).textContent || ''`);
  if (t && t.length > 4) break;
  await sleep(400);
}
const startup = await evalJS(`({
  noOverlay: document.getElementById('intro') === null && document.getElementById('btn-help') === null,
  hudVisible: !document.getElementById('hud').classList.contains('hidden'),
  hintText: (document.getElementById('hint') || {}).textContent || '',
  hintBox: (() => { const h = document.getElementById('hint'); if (!h) return null;
    const r = h.getBoundingClientRect(); return { cx: Math.round(r.left + r.width / 2), vw: innerWidth, bottom: Math.round(innerHeight - r.bottom) }; })(),
})`);
check('打开就进场地、且没有整屏遮罩与「?」按钮', startup?.noOverlay === true && startup?.hudVisible === true, JSON.stringify(startup));
const hintText = startup.hintText || '';
const hintOK = (/WASD/.test(hintText) && /左键/.test(hintText) && /M/.test(hintText))      // 桌面
            || (/摇杆/.test(hintText) && /轻点鸡/.test(hintText) && /双指/.test(hintText)); // 触屏
check('底部中置一条操作说明（内容齐全、水平居中、贴底）',
  hintOK && startup.hintBox && Math.abs(startup.hintBox.cx - startup.hintBox.vw / 2) <= 4 && startup.hintBox.bottom <= 40,
  JSON.stringify(startup.hintBox) + ' ' + hintText);

let boot = '';
for (let i = 0; i < 60; i++) {                       // 最多等 30 秒：hub 偶尔会慢一拍（本地/线上都可能）
  boot = await evalJS(`window.__farm ? (window.__farm.npcs ? window.__farm.npcs.size : 0) : 0`);
  if (typeof boot === 'number' && boot >= 16) break;
  await sleep(500);
}
console.log('首屏 NPC 数:', boot);
check('首屏读到探针数据（鸡都建出来了）', typeof boot === 'number' && boot >= 16, String(boot));
await shot(OUT + '-1-intro');
await sleep(1200);
// ---- 前置：客户端已没有单机形态，必须真的连上游戏服 ----
// 本地跑法：先 `python server/farm_server.py --port 28910`；默认 URL 已带 &ws=ws://127.0.0.1:28910
const pre = await evalJS(`JSON.stringify({ mode: window.__farm?.net?.mode ?? null, npcs: window.__farm?.npcs?.size ?? null })`);
let preOk = false;
try { const p = JSON.parse(pre); preOk = p.mode === 'online' && p.npcs > 0; } catch { /* 下面会红 */ }
check('页面已连上游戏服（没有单机兜底：连不上就只剩自己的鸡）', preOk, pre);

// ---- 站名：config.js 里的 SITE_NAME 覆盖页签名（没给就用页面自带的默认名）----
// 站名刻意不写死在 index.html 里：公开仓库/发布包保持中性默认，每个实例在目标机上用自己的名字
const titleInfo = await evalJS(`(async () => {
  try {
    const t = await (await fetch('js/config.js', { cache: 'no-store' })).text();
    const m = t.match(/SITE_NAME\\s*=\\s*"([^"]*)"/);
    return { title: document.title, siteName: m ? m[1] : '(config.js 里还没有这一项)' };
  } catch (e) { return { err: String(e) }; }
})()`, true);   // ⚠ 第二参必须 true：这家的 evalJS 默认**不等 Promise**，async 载荷会拿回一个 {} 
console.log('title:', JSON.stringify(titleInfo));
check('页签名字跟着 config.js 的 SITE_NAME 走（空则用页面默认名）',
  titleInfo.siteName
    ? titleInfo.title === titleInfo.siteName
    : (!!titleInfo.title && /cyber-probe/.test(titleInfo.title)),
  JSON.stringify(titleInfo));

const state = await evalJS(`(() => ({
  hud: !document.getElementById('hud').classList.contains('hidden'),
  online: +document.getElementById('online').textContent,
  onlineTotal: +document.getElementById('online-total').textContent,
  webOnline: +document.getElementById('web-online').textContent,
  webTotal: +document.getElementById('web-total').textContent,
  hot: +document.getElementById('hot').textContent,
  err: document.getElementById('errbar').classList.contains('hidden') ? null : document.getElementById('errbar').textContent,
  npcs: window.__farm.npcs.size,
  geese: [...window.__farm.npcs.values()].filter(n => n.kind === 'goose').length,
  nodes: window.__farm.farm.nodes.length,
  fps: null,
}))()`);
console.log('state:', JSON.stringify(state));
// 节点数是活的（hub 里加了机器就跟着变），所以拿实际数据对，别写死 7/16
check('HUD 显示的节点总数 = 实际节点数', state.onlineTotal === state.nodes && state.nodes > 0,
  `HUD ${state.onlineTotal} / 数据 ${state.nodes} 台（在线 ${state.online}）`);
check('网站鸡 = 9 个探测任务且都有数据', state.webTotal === 9 && state.webOnline === 9, `${state.webOnline}/${state.webTotal}`);
check('NPC 数量 = 探针鸡 + 网站鸡 + 大白鹅（每个节点、每个探测任务各一只，外加服务端放养的鹅）',
  state.npcs === state.nodes + state.webTotal + state.geese && state.geese >= 1,
  `${state.npcs} = ${state.nodes} 探针 + ${state.webTotal} 网站 + ${state.geese} 鹅`);
check('没有数据错误条', state.err === null, state.err || '');

// 名牌文本抽样
const plate = await evalJS(`(() => {
  const list = [...window.__farm.npcs.values()];
  const n = list.find(x => x.kind === 'probe');
  const t = list.find(x => x.kind === 'web');
  const diag = { npcs: list.length, noInfo: list.filter(x => !x.info).map(x => x.id + ':' + x.kind),
                 webs: list.filter(x => x.kind === 'web').map(x => x.id + (x.info ? '' : '(无info)')).join(',') };
  const P = (n && n.info) || {}, W = (t && t.info) || {};
  return {
    diag,
    probe: { title: P.title, code: P.code, sub: P.sub,
             rings: (P.rings || []).map(r => r.label + '=' + r.pct.toFixed(1)), rows: P.rows, online: P.online, hot: P.hot },
    web: { title: W.title, sub: W.sub, rows: W.rows, online: W.online },
  };
})()`);
console.log('plate diag:', JSON.stringify(plate && plate.diag));
console.log('probe plate:', JSON.stringify(plate && plate.probe));
console.log('web plate:', JSON.stringify(plate && plate.web));
if (!plate || plate.error) console.log('plate 载荷出错:', JSON.stringify(plate));
// ⚠ 取字段一律带兜底：载荷抛异常时 evalJS 回的是 {error}，写成 plate.probe.sub 会直接 TypeError
//   把整套断言掐断（后面再好的断言都不会跑）
const P = (plate && plate.probe) || {}, W = (plate && plate.web) || {};
check('探针鸡名牌只有节点名（无主机名/IP）', (P.sub || '') === '', `sub="${P.sub}"`);
check('网站鸡名牌不给探测目标（只给统计）',
  !/[a-z0-9-]+\.(com|net|org|cn|io|xyz|top|de)\b|\d+\.\d+\.\d+\.\d+|:\d{2,5}\b/i.test(W.sub || '')
    && /在测/.test(W.sub || ''),
  `sub="${W.sub}"`);

// ---- 隐私：页面与 config.js 里都不该出现任何主机名/IP/探测目标域名 ----
// ⚠ 要防的字符串（主机名/别名/探测目标域名…）由环境变量给，且必须在 **Node 这边**展开后注入页面：
//   页面里没有 `process`（2026-09-27 踩过：写成页面内读 process.env → ReferenceError，整条断言变 undefined 再报 TypeError）
const KNOWN_PRIVACY = (process.env.PRIVACY_STRINGS || '').split(',').map((s) => s.trim()).filter(Boolean);
const privacy = await evalJS(`(async () => {
  const ipRe = /\\b\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}\\b/;
  const domainRe = /\\.(com|net|org|cn|io|xyz)\\b/;
  const text = document.body.innerText;
  const cfg = await (await fetch('./js/config.js', { cache: 'no-store' })).text();   // 注意是 ./js/config.js（页面在 /chicken/ 下，写 ./config.js 会 404，那样这条断言就白查了）
  const known = ${JSON.stringify(KNOWN_PRIVACY)};
  return {
    known,
    hits: known.filter((k) => text.includes(k) || cfg.includes(k)),
    domIp: ipRe.test(text), cfgIp: ipRe.test(cfg),
    domDomain: domainRe.test(text), cfgDomain: domainRe.test(cfg),
    cfgHostnameKey: /hostname/.test(cfg), cfgLen: cfg.length,
  };
})()`, true);
console.log('privacy:', JSON.stringify(privacy));
check('页面/config.js 里不含任何主机名、IP 或探测目标域名',
  privacy.hits.length === 0 && !privacy.domIp && !privacy.cfgIp
  && !privacy.domDomain && !privacy.cfgDomain && !privacy.cfgHostnameKey,
  JSON.stringify(privacy));

// ---- 方向：相机看向 +x 时，前=+x、右=+z（AD 曾经反过来） ----
const move = await evalJS(`(async () => {
  const A = window.__farm;
  // 先把场上的鸡挪到对角去：实体分离会把"走位方向"测歪（联机时尤其明显）
  const saved = [...A.npcs.values()].map(n => ({ n, x: n.pos.x, z: n.pos.z }));
  for (const s of saved) s.n.pos.set(-s.x, s.n.pos.y, -s.z);
  const press = async (code) => {
    const start = { x: A.player.pos.x, z: A.player.pos.z };
    dispatchEvent(new KeyboardEvent('keydown', { code }));
    const t0 = performance.now();
    while (performance.now() - t0 < 7000) {
      await new Promise(r => setTimeout(r, 80));
      if (Math.hypot(A.player.pos.x - start.x, A.player.pos.z - start.z) > 1.2) break;
    }
    dispatchEvent(new KeyboardEvent('keyup', { code }));
    return { dx: +(A.player.pos.x - start.x).toFixed(2), dz: +(A.player.pos.z - start.z).toFixed(2) };
  };
  A.camYaw = Math.PI / 2;
  // 再挑一个离所有实体最远的角落做测量
  let spot = [0, 0], bestD = -1;
  for (const c of [[0, 0], [-18, -18], [18, -18], [-18, 18], [18, 18]]) {
    let d = 1e9;
    for (const n of A.npcs.values()) d = Math.min(d, Math.hypot(n.pos.x - c[0], n.pos.z - c[1]));
    if (d > bestD) { bestD = d; spot = c; }
  }
  const out = {};
  for (const [name, code] of [['W','KeyW'],['S','KeyS'],['D','KeyD'],['A','KeyA']]) {
    // 联机时服务端每帧把鸡的位置刷回来，走位随时可能被挤一下 —— 最多重测 3 次，取最"纯"的那次
    const main = (name === 'W' || name === 'S') ? 'dx' : 'dz';
    const other = main === 'dx' ? 'dz' : 'dx';
    let best = null;
    for (let k = 1; k <= 3; k++) {
      A.player.pos.set(spot[0], 0, spot[1]); A.player.vy = 0;
      for (const s of saved) s.n.pos.set(-s.x, s.n.pos.y, -s.z);
      await new Promise(r => setTimeout(r, 120));
      const m = await press(code);
      const ratio = Math.abs(m[main]) / (Math.abs(m[other]) + 0.01);
      if (!best || ratio > best.ratio) best = { ...m, ratio: +ratio.toFixed(2), tries: k };
      if (ratio >= 3) break;
    }
    out[name] = best;
  }
  for (const s of saved) s.n.pos.set(s.x, s.n.pos.y, s.z);
  return out;
})()`, true);
console.log('方向:', JSON.stringify(move));
// 判据：主轴要够大、且明显大于副轴（副轴可能被实体挤压污染，不能要求绝对为 0）
const axisOK = (m, main, sign) => {
  const other = main === 'dx' ? 'dz' : 'dx';
  return !!m && sign * m[main] > 1 && Math.abs(m[other]) < Math.abs(m[main]) * 0.85;
};
check('W 往相机前方走（+x）', axisOK(move.W, 'dx', 1), JSON.stringify(move.W));
check('S 后退（-x）', axisOK(move.S, 'dx', -1), JSON.stringify(move.S));
check('D 往相机右侧走（+z，此前左右反了）', axisOK(move.D, 'dz', 1), JSON.stringify(move.D));
check('A 往相机左侧走（-z）', axisOK(move.A, 'dz', -1), JSON.stringify(move.A));

// 走路：按住 W，等位移超过 2.5m（headless 帧率低，按"走够距离"判定而不是固定时长）
const walk = await evalJS(`(async () => {
  const p = window.__farm.player;
  const a = { x: p.pos.x, z: p.pos.z };
  dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW' }));
  const t0 = performance.now();
  let d = 0;
  while (performance.now() - t0 < 8000) {
    await new Promise(r => setTimeout(r, 100));
    d = Math.hypot(p.pos.x - a.x, p.pos.z - a.z);
    if (d > 2.5) break;
  }
  dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyW' }));
  return { d, ms: Math.round(performance.now() - t0), fps: window.__farm.fps };
})()`, true);
check('WASD 能走动', walk.d > 2.5, `位移 ${walk.d.toFixed(1)}m / 用时 ${walk.ms}ms / ${walk.fps.toFixed(0)}fps`);

await sleep(2500);
await shot(OUT + '-2-farm');

const panels = await evalJS(`(() => {
  const b = document.getElementById('board'), m = document.getElementById('me');
  return {
    board: !!b, me: !!m,
    collapsed: b ? b.classList.contains('collapsed') : null,                       // 默认收起
    rowsHidden: b ? getComputedStyle(document.getElementById('board-rows')).display === 'none' : null,
    title: b ? document.getElementById('board-title').textContent : null,
    meName: document.getElementById('me-name').textContent,
    score: document.getElementById('score').textContent,
    hpWidth: document.getElementById('hpfill').style.width || null,
  };
})()`);
check('右上啄倒榜加回来了（默认收起、标题是🐔啄倒榜）',
  panels.board && panels.collapsed === true && panels.rowsHidden === true && /啄倒榜/.test(panels.title),
  JSON.stringify({ collapsed: panels.collapsed, rowsHidden: panels.rowsHidden, title: panels.title }));
check('左下自身卡片加回来了（名字 / 血条 / 啄倒数）',
  panels.me && panels.meName && panels.meName !== '–' && /^🏆 啄倒 \d+ 只鸡$/.test(panels.score),
  `名字=${panels.meName} · 分数行=${panels.score} · 血条宽=${panels.hpWidth}`);

// 服务端对"单次位移"有夹取（2m + 8m/s×上报间隔，2026-09-24 加固加的）：直接瞬移会被夹回去，
// 服务端仍按旧坐标做距离判定 → 症状是"贴到鸡跟前啄却啄空"。摆位一律走这个分步挪：
// 每步 ≤1.8m、每步留一次 20Hz 上报的时间（走 20m 约 1.4 秒）。协议自测里叫 place()，同一套路。
await evalJS(`(() => {
  const f = window.__farm;
  f.place = async (tx, tz, yaw, budget = 9000) => {
    const t0 = performance.now();
    while (performance.now() - t0 < budget) {
      const dx = tx - f.player.pos.x, dz = tz - f.player.pos.z;
      const d = Math.hypot(dx, dz);
      if (d <= 0.05) break;
      const k = Math.min(1, 1.8 / d);
      const nx = f.player.pos.x + dx * k, nz = f.player.pos.z + dz * k;
      f.player.pos.set(nx, f.groundHeight(nx, nz), nz);
      await new Promise(r => setTimeout(r, 120));
    }
    if (yaw !== undefined) f.player.yaw = yaw;
    return true;
  };
  return true;
})()`);

// ---- 场景与模型（对齐参考站的那部分）----
const scene = await evalJS(`(() => {
  const a = window.__farm;
  return {
    hill: +a.groundHeight(14, 13).toFixed(2), flat: +a.groundHeight(-22, -22).toFixed(2),
    fov: a.camera.fov,
    paddles: a.scene.children.length,
  };
})()`);
console.log('scene:', JSON.stringify(scene).slice(0, 220));
check('地形有高斯山坡（山顶 2.4m，远处归零）', scene.hill > 2 && scene.flat < 0.2, `山顶 ${scene.hill} / 平原 ${scene.flat}`);
check('相机 FOV = 62（参考站同款构图）', scene.fov === 62, String(scene.fov));

// ---- 实体间不许穿模 ----
const overlap = await evalJS(`(async () => {
  const a = window.__farm;
  // 直接站到一只探针鸡身上，看分离有没有把它推开。
  // 注意：被啄晕后服务端/本地会把你复活到出生点，那样量出来的是"复活后的距离"（假通过），
  // 所以每次都要求"这次没被啄晕"才算数。
  const res = {};
  for (const [tag, target, need] of [['chick', [...a.npcs.values()].find(n => n.kind === 'probe'), 0.95]]) {
    let d = 0;
    for (let attempt = 0; attempt < 3; attempt++) {
      const tw = performance.now();
      while (performance.now() - tw < 12000 && (a.player.koT > 0 || a.player.hp <= 0)) await new Promise(r => setTimeout(r, 150));
      a.player.hp = 100;
      a.player.pos.set(target.pos.x, target.pos.y, target.pos.z);
      const t0 = performance.now();
      while (performance.now() - t0 < 2500 && a.player.koT <= 0) await new Promise(r => setTimeout(r, 60));
      d = Math.hypot(target.pos.x - a.player.pos.x, target.pos.z - a.player.pos.z);
      if (a.player.koT <= 0) break;
    }
    res[tag] = { d: +d.toFixed(3), need };
  }
  return res;
})()`, true);
console.log('overlap:', JSON.stringify(overlap));
check('玩家不能和探针鸡叠在一起', 
  overlap.chick?.d >= overlap.chick?.need - 0.08, `间距 ${overlap.chick?.d}m（要 ≥ ${(overlap.chick.need - 0.08).toFixed(2)}m）`);

// ---- 羽毛粒子 / 扇翅攻击 ----
// 联机时伤害与命中事件都由服务端裁定：本地不做命中判定，羽毛要等事件回来（约一个插值延迟）
const fx = await evalJS(`(async () => {
  const a = window.__farm;
  const online = a.mode === 'online';
  // 先保证自己没被啄晕（联机时场上有 16 只服务端 NPC，随时可能把你放倒）
  const tw = performance.now();
  while (performance.now() - tw < 12000 && (a.player.koT > 0 || a.player.hp <= 0)) await new Promise(r => setTimeout(r, 150));
  const npc = [...a.npcs.values()].find(n => n.kind === 'probe');
  a.player.pos.set(npc.pos.x + 1.0, a.groundHeight(npc.pos.x + 1.0, npc.pos.z), npc.pos.z);
  a.player.yaw = Math.atan2(npc.pos.x - a.player.pos.x, npc.pos.z - a.player.pos.z);
  while (a.peckCd > 0) await new Promise(r => setTimeout(r, 60));
  const f0 = a.feathers.pool.filter(f => f.life > 0).length;
  a.doPeck();
  await new Promise(r => setTimeout(r, online ? 800 : 150));
  const f1 = a.feathers.pool.filter(f => f.life > 0).length;
  // 扇翅：范围只有 1.35m，出手前重新贴上去（鸡一直在走）
  a.player.pos.set(npc.pos.x + 0.9, a.groundHeight(npc.pos.x + 0.9, npc.pos.z), npc.pos.z);
  const hp0 = npc.hp;
  a.doWing();
  const flapT = +a.playerChicken.flapT.toFixed(2);     // 自己扇翅的动作（两种模式都会播）
  await new Promise(r => setTimeout(r, online ? 800 : 250));
  return { f0, f1, hp0, hp1: npc.hp, flapT, online };
})()`, true);
console.log('fx:', JSON.stringify(fx));
check('啄中会炸出羽毛粒子', fx.f1 > fx.f0, `${fx.f0} → ${fx.f1} 片${fx.online ? '（联机：命中事件由服务端广播回来）' : ''}`);
if (fx.online) {
  // 联机时本地扇翅不结算伤害（服务端的 wing 结算在协议自测里断言），这里只验动作与"不本地扣血"
  check('扇翅动作会播放（联机时伤害归服务端）', fx.flapT > 0, `flapT=${fx.flapT}`);
} else {
  check('扇翅攻击能打到鸡（掉血 + 扇翅动作）', fx.hp1 < fx.hp0 && fx.flapT > 0, `hp ${fx.hp0}→${fx.hp1} · flapT=${fx.flapT}`);
}

// ---- 闲时动作：鸡停下时会啄草、振翅、理毛 ----
const idle = await evalJS(`(async () => {
  const a = window.__farm;
  const seen = new Set();
  const t0 = performance.now();
  while (performance.now() - t0 < 15000) {   // 联机时它们大多在走，闲时动作是"偶尔"出现的，窗口给足
    for (const n of a.npcs.values()) {
      const st = n.st || 0;
      if (st & 2) seen.add('啄草');
      if (st & 8) seen.add('振翅');
      if (st & 16) seen.add('理毛');
    }
    await new Promise(r => setTimeout(r, 100));
  }
  return [...seen];
})()`, true);
console.log('idle actions:', JSON.stringify(idle));
check('闲时动作（啄草/振翅/理毛）都会出现', idle.length >= 2, `观察到：${idle.join(' / ') || '（没有）'}`);

// ---- 鸡群走动节奏：对齐原站（实测 30 秒走 ~9.7m、移动时 0.65m/s、走走停停）----
const moving = await evalJS(`(async () => {
  const a = window.__farm;
  const list = [...a.npcs.values()];
  const st = new Map(list.map((n) => [n.id, { n, d: 0, moved: 0, speedSum: 0, speedN: 0 }]));
  // 速度要量**逻辑位置**（n.pos）：渲染层的 group.position 是朝逻辑位置缓动的，
  // 平滑会让“看得见的模型速度”天然低于模拟速度（单机实测 0.41 vs 模拟 0.8）。
  // 模型层只用来断言“真的在动/没有脱节”，见下面的 walked 与 modelSync。
  const vSamples = [];
  // 主循环把 dt 截断在 0.05s（防“死亡螺旋”）：低于 20fps 时**模拟时间比墙钟慢**，
  // 于是 headless 那 ~10fps 会把 NPC 的可见速度砍半（实测 0.8 → 0.39）。
  // 这里按模拟时间折算，量的是“游戏想让它跑多快”，而不是被渲染拖慢了多少。
  const fps = (window.__farm && window.__farm.fps) || 60;
  // 联机时 NPC 由服务端 20Hz 驱动，客户端掉帧**不会**拖慢它们（量墙钟就是真实速度）；
  // 现在只有联机一种形态：NPC 由服务端 20Hz 驱动，客户端掉帧不会拖慢它们，量墙钟就是真实速度
  const online = !!(window.__farm && window.__farm.net && window.__farm.net.mode === 'online');
  const simF = 1;
  let simTotal = 0;
  let prev = list.map((n) => ({ n, x: n.group.position.x, z: n.group.position.z, lx: n.pos.x, lz: n.pos.z }));
  const t0 = performance.now(); let lastT = t0;
  while (performance.now() - t0 < 24000) {
    await new Promise(r => setTimeout(r, 200));
    const nowMs = performance.now();
    const dt = Math.max(0.05, Math.min(1.0, (nowMs - lastT) / 1000));
    lastT = nowMs;
    simTotal += dt * simF;          // 每采样点累加一次（不是每只鸡一次）
    prev = prev.map((p) => {
      const s2 = st.get(p.n.id);
      const d = Math.hypot(p.n.group.position.x - p.x, p.n.group.position.z - p.z);
      const dl = Math.hypot(p.n.pos.x - p.lx, p.n.pos.z - p.lz);
      s2.d += d;
      const v = dl / (dt * simF);
      if (v > 0.3) { s2.moved += dt * simF; s2.speedSum += v; s2.speedN++; vSamples.push(v); }
      return { n: p.n, x: p.n.group.position.x, z: p.n.group.position.z, lx: p.n.pos.x, lz: p.n.pos.z };
    });
  }
  const rows = [...st.values()].map((s2) => ({ id: s2.n.id, d: +s2.d.toFixed(2),
    duty: +(100 * s2.moved / Math.max(1, simTotal)).toFixed(0), v: +(s2.speedSum / Math.max(1, s2.speedN)).toFixed(2) }));
  return { n: rows.length, fps: +fps.toFixed(0), simF: +simF.toFixed(2), walked: rows.filter((r) => r.d >= 1.5).length,
           avg: +(rows.reduce((s2, r) => s2 + r.d, 0) / Math.max(1, rows.length)).toFixed(2),
           avgSpeedMoving: +(() => { const s = vSamples.slice().sort((p, q) => p - q);
             return s.length ? s[Math.floor(s.length / 2)] : 0; })().toFixed(2),
           avgDuty: +(rows.reduce((s2, r) => s2 + r.duty, 0) / Math.max(1, rows.length)).toFixed(0),
           still: rows.filter((r) => r.d < 1.5).map((r) => r.id) };
})()`, true);
console.log('moving:', JSON.stringify(moving));
check('鸡群在场地里真的走动（24 秒内 ≥80% 走过 ≥1.5m）',
  moving.n > 0 && moving.walked >= Math.ceil(moving.n * 0.8),
  `${moving.n} 只里 ${moving.walked} 只走过 ≥1.5m，平均 ${moving.avg}m；几乎没动的：${moving.still.join(',') || '无'}`);
check('走动速度对齐原站（移动时·中位数 0.45~1.3 m/s，原站实测 0.65~0.73）',
  moving.avgSpeedMoving >= 0.45 && moving.avgSpeedMoving <= 1.3,
  `实测 ${moving.avgSpeedMoving} m/s（模拟层中位数）· 移动时间占比 ${moving.avgDuty}%（原站约 45%）`);
console.log('moving:', JSON.stringify(moving));
// 联机时最容易出的 bug：updateRemote 只改了 pos、没动 group.position（"逻辑在走、模型站着"）
const modelSync = await evalJS(`(() => {
  const a = window.__farm;
  if (a.mode !== 'online') return { online: false };
  let worst = 0, id = '';
  for (const n of a.npcs.values()) {
    const d = Math.hypot(n.group.position.x - n.pos.x, n.group.position.z - n.pos.z);
    if (d > worst) { worst = d; id = n.id; }
  }
  return { online: true, worst: +worst.toFixed(2), id };
})()`);
console.log('modelSync:', JSON.stringify(modelSync));
check('模型位置跟着逻辑位置（不会"逻辑在走、模型站着"）',
  modelSync && modelSync.online === true && modelSync.worst < 0.35,
  modelSync ? `最大偏差 ${modelSync.worst}m（${modelSync.id}）· 在线=${modelSync.online}` : '没取到');
check('鸡群大部分时间在走动（不是站着不动）',
  moving.n > 0 && moving.walked >= Math.ceil(moving.n * 0.6) && moving.avg >= 2,
  `${moving.n} 只里 ${moving.walked} 只 6 秒内走了 ≥1.5m，平均 ${moving.avg}m；几乎没动的：${moving.still.join(',') || '无'}`);

// ---- 观感细节：扇翅扬尘 / 名牌远处淡出 ----
const polish = await evalJS(`(async () => {
  const a = window.__farm;
  const online = a.mode === 'online';
  const alive = async (ms) => { const t = performance.now(); while (performance.now() - t < ms && (a.player.koT > 0 || a.player.hp <= 0)) await new Promise(r => setTimeout(r, 150)); };
  await alive(12000);
  let dustOn = 0;
  for (let i = 0; i < 3 && !dustOn; i++) {          // 被啄晕时 doWing 会直接返回，所以多试几次
    await alive(8000);
    a.doWing();
    await new Promise(r => setTimeout(r, 120));
    dustOn = a.dust.pool.filter(d => d.life > 0).length;
    if (!dustOn) await new Promise(r => setTimeout(r, 500));
  }
  // 名牌淡出：挑一只靠场地中心的鸡，把玩家放到离它最远的角上，反复贴位（联机时可能被服务端复活拉走）
  const npc = [...a.npcs.values()]
    .filter(n => n.kind === 'probe')
    .sort((p, q) => (Math.abs(p.pos.x) + Math.abs(p.pos.z)) - (Math.abs(q.pos.x) + Math.abs(q.pos.z)))[0];
  const farX0 = npc.pos.x > 0 ? -24 : 24, farZ0 = npc.pos.z > 0 ? -24 : 24;
  let far = null, camD = 0;
  for (let i = 0; i < 60; i++) {
    await alive(6000);
    // 鸡现在走得勤，会朝我这边晃过来 —— 每次挑"离它最远"的那个角站，才能稳定拉出 >30m 的距离
    let bx = farX0, bz = farZ0, bd = -1;
    for (const [cx, cz] of [[-24, -24], [24, -24], [-24, 24], [24, 24]]) {
      const dd = Math.hypot(npc.pos.x - cx, npc.pos.z - cz);
      if (dd > bd) { bd = dd; bx = cx; bz = cz; }
    }
    await a.place(bx, bz);                           // 分步挪（服务端对单次位移有夹取）
    await new Promise(r => setTimeout(r, 180));      // 等相机跟上（相机是 lerp 的）
    camD = a.camera.position.distanceTo(npc.chicken.group.position);
    const o = npc.chicken.sprite.material.opacity;
    if (camD > 30 && (o < 0.9 || !npc.chicken.sprite.visible)) { far = { o: +o.toFixed(2), shown: npc.chicken.sprite.visible, camD: +camD.toFixed(1) }; break; }
  }
  far = far || { o: +npc.chicken.sprite.material.opacity.toFixed(2), shown: npc.chicken.sprite.visible, camD: +camD.toFixed(1) };
  // 靠近：也要等到"相机真的贴到它跟前"再采样（联机时被啄晕复活会把你传走，量出来还是远景）
  let near = { o: +npc.chicken.sprite.material.opacity.toFixed(2), shown: npc.chicken.sprite.visible, camD: 0 };
  for (let i = 0; i < 30; i++) {
    await alive(6000);
    for (let k = 0; k < 4; k++) {          // 一次贴位里连采几帧，取相机离得最近的那帧（复活会把你拉走，得抢）
      a.player.pos.set(npc.pos.x + 1.0, a.groundHeight(npc.pos.x + 1.0, npc.pos.z), npc.pos.z);
      await new Promise(r => setTimeout(r, 120));
      const cd = a.camera.position.distanceTo(npc.chicken.group.position);
      const o = npc.chicken.sprite.material.opacity;
      if (cd < near.camD || near.camD === 0) near = { o: +o.toFixed(2), shown: npc.chicken.sprite.visible, camD: +cd.toFixed(1) };
      if (near.camD < 12 && near.o > 0.9) break;
    }
    if (near.camD < 12 && near.o > 0.9) break;
  }
  return { dustOn, far, near, d: +Math.hypot(npc.pos.x - farX0, npc.pos.z - farZ0).toFixed(1) };
})()`, true);
console.log('polish:', JSON.stringify(polish));
check('扇翅会扬起尘土（粒子池有点亮的粒子）', polish.dustOn > 0, `${polish.dustOn} 颗尘`);
check('名牌远处淡出、靠近又恢复', (polish.far.o < 0.9 || !polish.far.shown) && polish.near.o > 0.9 && polish.near.shown,
  `远处 ${polish.far.o}（相机距 ${polish.far.camD}m）${polish.far.shown ? '' : '(隐藏)'} → 近处 ${polish.near.o}（相机距 ${polish.near.camD}m）`);

// ---- HUD 观感（深绿玻璃卡片）----
const hudStyle = await evalJS(`(() => {
  const cs = getComputedStyle(document.getElementById('topbar'));
  return { bg: cs.backgroundColor, dir: cs.flexDirection, radius: cs.borderRadius };
})()`);
check('HUD 统计卡是深绿玻璃卡片（参考站同款）',
  /rgba?\(20,\s*30,\s*15/.test(hudStyle.bg) && hudStyle.dir === 'column',
  JSON.stringify(hudStyle));

// 真逻辑：站到探针鸡跟前连啄，应该把它啄倒
// 联机时这条链路整段在服务端：本地啄击只是上报，倒地看服务端回传的 npc 状态与 ko 事件
// （分数系统已按用户要求整体删除：这里不再验"战绩 +1"）
const peck = await evalJS(`(async () => {
  const { npcs, player, doPeck, place } = window.__farm;
  const online = window.__farm.mode === 'online';
  // 挑靶子要挑"离所有暴躁鸡最远"的那只探针鸡：暴躁鸡现在会追着玩家啄（用户新增），
  // 站在它们眼皮底下连啄十口，中途一定会被啄晕几次，血又回上去（用户新增：不挨打就回血），永远啄不倒
  const hostiles = [...npcs.values()].filter(n => n.info && n.info.hot);
  const gapTo = (n) => hostiles.length
    ? Math.min(...hostiles.map(m => Math.hypot(m.pos.x - n.pos.x, m.pos.z - n.pos.z))) : 999;
  const npc = [...npcs.values()].filter(n => n.kind === 'probe').sort((p, q) => gapTo(q) - gapTo(p))[0];
  const gap = npc ? +gapTo(npc).toFixed(1) : -1;
  const scoreBefore = player.score | 0;            // 啄倒前自己榜上的数（服务端下发）
  let sawKoT = 0, koHp = null, hpMin = npc ? npc.hp : null;
  const tStart = performance.now();
  for (let i = 0; i < 30; i++) {          // 12 伤害/口，9 口才能放倒 100 血的鸡；联机有 RTT 与复活等待，多给几轮
    if (npc.chicken.koT > 0) break;       // 联机时倒地由服务端回传
    // 被场上别的鸡啄晕时 doPeck 会直接返回，先等自己站起来（联机时别的玩家也在打你）
    const tw = performance.now();
    while (performance.now() - tw < 10000 && (player.koT > 0 || player.hp <= 0)) await new Promise(r => setTimeout(r, 150));
    await place(npc.pos.x - 1.3, npc.pos.z);      // 分步挪过去（服务端对单次位移有夹取，瞬移会白啄）
    player.yaw = Math.atan2(npc.pos.x - player.pos.x, npc.pos.z - player.pos.z);
    doPeck();
    // 等冷却在"模拟时间"里走完：headless 帧率低，主循环有 dt 上限，固定 sleep 会误判为漏击
    const t0 = performance.now();
    while (window.__farm.peckCd > 0 && performance.now() - t0 < 8000) await new Promise(r => setTimeout(r, 60));
    if (online) await new Promise(r => setTimeout(r, 220));   // 等服务端回传
    hpMin = Math.min(hpMin, npc.hp);
    // 啄倒后主循环会安排 4.5 秒复活，所以要在倒下的瞬间取样，不能等整个循环跑完
    if (npc.chicken.koT > 0) { sawKoT = npc.chicken.koT; koHp = npc.hp; break; }
  }
  const koEv = (window.__farm.evLog || []).filter((e) => e.e === 'ko').slice(-3);
  await new Promise(r => setTimeout(r, 400));       // 等这一帧快照把服务端刚记的分数带回来
  return { hp: koHp, koT: sawKoT, hpMin, online, koEv, gap, scoreBefore,
           score: player.score | 0,
           koByMe: koEv.some((e) => e.to === npc.id && e.f === window.__farm.net.id),
           waited: +((performance.now() - tStart) / 1000).toFixed(1), name: npc.info.title };
})()`, true);
console.log('peck:', JSON.stringify(peck));
// 判据：目标确实被放倒过（客户端血量采样可能刚好错开倒地那一瞬，所以再看服务端广播的 ko 事件）
check('连啄能把探针鸡啄倒（倒地由服务端裁定，本地只做表演）',
  peck.hp === 0 || peck.hpMin === 0 || peck.koByMe,
  `靶子 ${peck.name}（离暴躁鸡 ${peck.gap}m）· 最低血 ${peck.hpMin} · 服务端 ko 事件里有没有我: ${peck.koByMe}`);
check('啄倒后鸡进入倒地状态', peck.koT > 0 || peck.koByMe,
  `koT=${peck.koT} · 服务端 ko 事件里有没有我: ${peck.koByMe}`);

// ---- 啄倒榜：分数由服务端裁定，客户端只展示（2026-09-27 按参考站加回）----
const board = await evalJS(`(async () => {
  const f = window.__farm, h = f.hud, b = document.getElementById('board');
  b.click();                                        // 展开
  await new Promise(r => setTimeout(r, 300));
  const rows = [...document.querySelectorAll('#board .row')].map((r) => ({
    name: r.querySelector('span').textContent, score: +r.querySelector('b').textContent,
    me: r.classList.contains('me'), off: r.classList.contains('off'),
  }));
  const title = document.getElementById('board-title').textContent;
  const mine = rows.find((r) => r.me);
  const npcRows = rows.filter((r) => /^(探针鸡|网站鸡)·/.test(r.name));
  // 大白鹅在榜上是**合并的一行**（对齐源站：几隻鹅合成一队），名字就叫 NPC·大白鹅
  const gooseRows = rows.filter((r) => r.name === 'NPC·大白鹅');
  const playerRows = rows.filter((r) => /（玩家）$/.test(r.name));
  const sorted = rows.every((r, i) => i === 0 || rows[i - 1].score >= r.score);
  b.click();                                        // 收起
  await new Promise(r => setTimeout(r, 150));
  const collapsedAgain = b.classList.contains('collapsed');
  return { rows: rows.length, mine, npcRows: npcRows.length, playerRows: playerRows.length, sorted,
           gooseRows: gooseRows.length, gooseScore: gooseRows.length ? gooseRows[0].score : null,
           geese: [...f.npcs.values()].filter((n) => n.kind === 'goose').length,
           title, collapsedAgain, npcs: f.npcs.size, players: f.remotes.size + 1,
           cardScore: document.getElementById('score').textContent, playerScore: f.player.score,
           hudRows: h.rows.length, liveScoreInSnap: null };
})()`, true);
console.log('board:', JSON.stringify(board));
check('点标题能展开/收起啄倒榜（展开时标题带「点击收起」）',
  /点击收起/.test(board.title) && board.collapsedAgain === true,
  `展开标题=${board.title} · 再点一下是否收起=${board.collapsedAgain}`);
// 行数 = 每只探针鸡/网站鸡各一行 + 玩家各一行 + **大白鹅合成的一行**（几只鹅只占一行）
check('榜单把场上每只鸡都排进去了（探针鸡/网站鸡 + 玩家），按分数从高到低',
  board.rows >= board.npcs - board.geese + board.players + (board.gooseRows ? 1 : 0)
  && board.sorted && board.npcRows >= 1 && board.playerRows >= 1,
  `行数 ${board.rows} · 鸡行 ${board.npcRows} · 玩家行 ${board.playerRows} · 场内 NPC ${board.npcs}（含 ${board.geese} 只鹅）· 有序=${board.sorted}`);
check('大白鹅在榜上合并成一行「NPC·大白鹅」（几只鹅只占一行，分数按队累计）',
  board.geese >= 1 && board.gooseRows === 1,
  `场上 ${board.geese} 只鹅 → 榜上 ${board.gooseRows} 行（分数 ${board.gooseScore}）`);
check('你自己那一行在榜上且高亮，分数与卡片一致（都来自服务端 ps[7]）',
  !!board.mine && board.mine.score === board.playerScore && board.cardScore === `🏆 啄倒 ${board.playerScore} 只鸡`,
  `我的行=${JSON.stringify(board.mine)} · player.score=${board.playerScore} · 卡片=${board.cardScore}`);
check('啄倒记在自己头上（服务端裁定 +1）', !peck.koByMe || peck.score >= peck.scoreBefore + 1,
  `啄倒前 ${peck.scoreBefore} → 啄倒后 ${peck.score}（服务端 ko 事件里有没有我: ${peck.koByMe}）`);

// ---- NPC·大白鹅（源站里也有的那种 NPC）：服务端自己放养、有领地意识、能被打倒 ----
// 大白鹅不是探针数据：服务端按数量自己放养（id g1/g2…），客户端只渲染 + 参与啄击。
const goose = await evalJS(`(async () => {
  const a = window.__farm;
  const geese = [...a.npcs.values()].filter((n) => n.kind === 'goose');
  const g0 = geese[0];
  const out = { count: geese.length, ids: geese.map((n) => n.id).sort(),
                body: g0 ? g0.chicken.constructor.name : null,
                title: g0 ? ((g0.info && g0.info.title) || '') : null,
                hp0: g0 ? g0.hp : null,
                inScene: g0 ? g0.group.parent === a.scene : null,
                hasHit: !!(g0 && g0.chicken.hit),
                rosterHasGoose: /"g[0-9]/.test(a.npcRosterSig || '') };
  if (!g0) return out;
  // 点它一下：应该开它自己的详情卡片。
  // ⚠ 点选打的是屏幕上最近的那个碰撞球：站到它正前方 4m、把相机转过去，并且要求
  //   pickChicken 真的命中这只鹅（没命中就换个位置/换一只重试 —— 射线是活的，别写死一次）
  const proj = (o) => { const v = o.group.position.clone(); v.y += 0.75; v.project(a.camera); return v; };
  let target = null, tries = 0;
  for (const g of geese) {
    for (let attempt = 0; attempt < 2 && !target; attempt++) {
      tries++;
      const yaw = Math.atan2(g.pos.x - a.player.pos.x, g.pos.z - a.player.pos.z);
      await a.place(g.pos.x - Math.sin(yaw) * 4.0, g.pos.z - Math.cos(yaw) * 4.0, yaw);
      a.camYaw = yaw;
      await new Promise((r) => setTimeout(r, 450));        // 等相机缓动到位
      const v = proj(g);
      if (v.z > 1) continue;                                // 在相机背后/远平面外
      const sx = (v.x + 1) / 2 * innerWidth, sy = (1 - v.y) / 2 * innerHeight;
      if (a.pickChicken(sx, sy) === g) target = { sx, sy };
    }
    if (target) break;
  }
  out.tapTries = tries;
  if (target) {
    out.picked = (a.pickChicken(target.sx, target.sy) || {}).id || null;
    a.tapSelect(target.sx, target.sy);
    await new Promise((r) => setTimeout(r, 150));
    out.detailTitle = (document.getElementById('d-title') || {}).textContent || '';
    out.detailBody = ((document.getElementById('d-body') || {}).innerText || '').replace(/\\s+/g, ' ').slice(0, 200);
    a.hud.hideDetail();
  }
  // 连啄把它放倒：60 血 = 五口 12 伤害。
  // ⚠ 它被啄会以 3.6 m/s 掉头跑 2.2 秒（比探针鸡快），一路追着摆放会一直白啄 ——
  //   正确打法是等它自己贴上来（领地内它会主动追到 1.15m），只在进入啄击范围时才出手。
  const distTo = () => Math.hypot(g0.pos.x - a.player.pos.x, g0.pos.z - a.player.pos.z);
  const scoreBefore = a.player.score | 0;
  let hpMin = g0.hp, koSeen = false, pecked = 0;
  for (let i = 0; i < 30; i++) {
    if (g0.chicken.koT > 0) { koSeen = true; break; }
    const tw = performance.now();
    while (performance.now() - tw < 8000 && (a.player.koT > 0 || a.player.hp <= 0)) await new Promise((r) => setTimeout(r, 150));
    // 等它靠进啄击范围（它自己会来）；跑太远了就跟一步
    const tw2 = performance.now();
    while (performance.now() - tw2 < 4000 && distTo() > 1.5 && a.player.koT <= 0) await new Promise((r) => setTimeout(r, 100));
    if (distTo() > 3.0 && a.player.koT <= 0) await a.place(g0.pos.x, g0.pos.z, undefined, 2500);
    if (distTo() > 1.9) continue;                            // 这一轮够不着，下一轮再来
    a.player.yaw = Math.atan2(g0.pos.x - a.player.pos.x, g0.pos.z - a.player.pos.z);
    a.doPeck();
    pecked += 1;
    const t0 = performance.now();
    while (window.__farm.peckCd > 0 && performance.now() - t0 < 8000) await new Promise((r) => setTimeout(r, 60));
    await new Promise((r) => setTimeout(r, 200));            // 等服务端回传
    hpMin = Math.min(hpMin, g0.hp);
    if (g0.chicken.koT > 0) { koSeen = true; break; }
  }
  const koEv = (a.evLog || []).filter((e) => e.e === 'ko' && e.to === g0.id);
  await new Promise((r) => setTimeout(r, 300));
  return { ...out, hpMin, koSeen, pecked, scoreBefore, score: a.player.score | 0,
           koByMe: koEv.some((e) => e.f === a.net.id), waited: true };
})()`, true);
console.log('goose:', JSON.stringify(goose));
check('场上放养着 NPC·大白鹅（服务端自己放养：客户端只渲染、不把它当探针上报名单）',
  goose.count >= 1 && goose.title === 'NPC·大白鹅' && goose.inScene === true
  && goose.hasHit === true && goose.rosterHasGoose === false,
  JSON.stringify(goose));
check('大白鹅有自己的模型与名牌（不是拿鸡的模型凑的）',
  goose.body === 'GooseBody' && goose.hp0 !== null && goose.hp0 <= 60,
  `模型类=${goose.body} · 名牌=${goose.title} · 开局血量=${goose.hp0}`);
check('点大白鹅能开它自己的详情卡片（含领地/伤害/打法的说明）',
  !!(goose.picked && /^g/.test(String(goose.picked))),
  `射线命中=${goose.picked}（试了 ${goose.tapTries} 次）· 卡片标题=${goose.detailTitle} · 正文=${goose.detailBody}`);
check('详情卡片是「大白鹅」那张（标题带 NPC·大白鹅，正文说清领地与打法）',
  /大白鹅/.test(goose.detailTitle || '') && /领地/.test(goose.detailBody || ''),
  `${goose.detailTitle} | ${goose.detailBody}`);
check('大白鹅能被打倒：五口啄击放倒 60 血的它（服务端裁定 + 记一个啄倒数）',
  goose.koSeen === true && goose.hpMin === 0 && (goose.score >= goose.scoreBefore + 1 || goose.koByMe),
  `最低血量 ${goose.hpMin} · 倒地=${goose.koSeen} · 出手 ${goose.pecked} 次 · 我的分数 ${goose.scoreBefore} → ${goose.score}`);


// 客户端不上报战绩：服务端拿到 's' 也一律忽略（协议自测里有对应用例，这里再验客户端确实没发）
const noSelfScore = await evalJS(`(() => {
  const f = window.__farm;
  return { hasPlayerScore: Object.prototype.hasOwnProperty.call(f.player, 'score'),
           scoreType: typeof f.player.score, myId: f.net.id };
})()`);
check('分数是服务端下发的数字（客户端只存不报）',
  noSelfScore.hasPlayerScore && noSelfScore.scoreType === 'number', JSON.stringify(noSelfScore));

// 真逻辑：把一台节点的 CPU 拉满 → 该探针鸡变暴躁 → 主动来啄玩家
// （把 refreshNodes 停掉，否则 6 秒后真实数据会把它改回不暴躁）
const hot = await evalJS(`(async () => {
  const { farm, player, npcs } = window.__farm;
  farm.refreshNodes = async () => {};
  // 可能有"在途"的一次刷新（await fetch 之后才赋值 farm.nodes），先等它落地再挑节点，
  // 否则测的是被替换掉的旧对象：名牌说暴躁、顶栏计数却是 0（踩过）
  await new Promise(r => setTimeout(r, 1400));
  const hotBefore = farm.hotCount;                    // 注意：网络最差那只本来就是暴躁鸡（用户要求）
  const node = farm.nodes[0];
  const wasAggressive = farm.isAggressive(node);
  node.metrics = { ...(node.metrics || {}), cpu: 99 };
  farm._emit();
  const npc = npcs.get('n' + node.id);
  const hotFlag = npc.info.hot;
  const online = window.__farm.mode === 'online';
  const t0 = performance.now();
  let samples = [], minD = 1e9, runSeen = false;
  // 战斗动作（用户要求）：蹦跳 = 离地高度 >0.25m；扇翅 = 服务端事件里出现 wing 命中
  // 注意：这块是模板字符串，注释里不能出现反引号（会提前终结字符串，踩过一次）
  let jumpSeen = false, wingSeen = false, maxAir = 0;
  // 判据是「战斗时会蹦跳」而不是「**这一只**鸡会蹦跳」：暴躁鸡其实也追别的鸡（互相欺负），
  // 只盯节点 0 那一只时，它正忙着欺负别人/在歇脚，就会假红（2026-09-27 复查里连中三次）。
  const airOf = () => {
    let m = 0;
    for (const c of window.__farm.npcs.values()) {
      if (!c.group) continue;
      const y = c.group.position.y - window.__farm.groundHeight(c.group.position.x, c.group.position.z);
      if (y > m) m = y;
    }
    return m;
  };
  const airTracked = () => npc.group.position.y - window.__farm.groundHeight(npc.group.position.x, npc.group.position.z);
  const wingBy = () => (window.__farm.evLog || []).filter((e) => e.e === 'hit' && e.k === 'wing').length;
  const hitsBy = () => (window.__farm.evLog || []).filter((e) => e.e === 'hit' && e.fn === npc.info.title).length;
  // 联机时它追不追我、啄没啄到，都是服务端说了算：
  // 把玩家放到离它 ~12m 的地方站住，看它会不会主动冲过来 —— 比"等我被打"稳得多
  const ang = Math.atan2(npc.pos.z - player.pos.z, npc.pos.x - player.pos.x);
  // 站 ~7m 外等它冲过来（服务端也是"走 3~4m 就歇 5.5~7 秒"的节奏，12m 要 24s+，7m 稳一些）
  const budget = 30000;
  // 玩家站定在它 7m 外；它自己溜远了（>12m 就超出服务端 16m 的追击判定）就重新摆位。
  // 注意 px/pz 是"固定点"——每帧贴着它的当前位置放，等于玩家一直跟着退，它永远追不上（踩过）
  let px = npc.pos.x + Math.cos(ang) * 7, pz = npc.pos.z + Math.sin(ang) * 7;
  while (performance.now() - t0 < budget && hitsBy() < 1) {
    farm.nodes[0].metrics = { ...farm.nodes[0].metrics, cpu: 99 };   // 每次都按当前列表里的那只写
    farm._emit();
    if (Math.hypot(npc.pos.x - px, npc.pos.z - pz) > 12 || Math.hypot(player.pos.x - px, player.pos.z - pz) > 12) {
      const a2 = Math.atan2(npc.pos.z - player.pos.z, npc.pos.x - player.pos.x);
      px = npc.pos.x + Math.cos(a2) * 7; pz = npc.pos.z + Math.sin(a2) * 7;
    }
    if (player.koT <= 0) player.pos.set(px, 0, pz);                  // 站 7m 外等它冲过来
    const d = Math.hypot(npc.pos.x - player.pos.x, npc.pos.z - player.pos.z);
    if (player.koT <= 0) minD = Math.min(minD, d);
    if (npc.st & 4) runSeen = true;         // 服务端把它置成"奔跑(追人)"状态了
    samples.push(npc.st & 4 ? 'run' : 'walk');
    const air = airOf();
    if (air > maxAir) maxAir = air;
    if (air > 0.25) jumpSeen = true;
    if (wingBy() > 0) wingSeen = true;
    if (minD <= 2.2) break;                                          // 追到跟前了，够了
    await new Promise(r => setTimeout(r, 250));
  }
  // 贴到跟前之后再看 9 秒：鸡贴脸时会"扇一翅膀"，追人途中会蹦跳（两者都由服务端判定）
  const t1 = performance.now();
  while (performance.now() - t1 < 9000) {
    farm.nodes[0].metrics = { ...farm.nodes[0].metrics, cpu: 99 };
    farm._emit();
    if (player.koT <= 0) player.pos.set(px, 0, pz);
    const air = airOf();
    if (air > maxAir) maxAir = air;
    if (air > 0.25) jumpSeen = true;
    if (wingBy() > 0) wingSeen = true;
    await new Promise(r => setTimeout(r, 250));
  }
  // 追人途中的蹦跳是**概率事件**（服务端按 chase 状态随机触发、还有走 3~4m 歇 5~7s 的节奏）：
  // 之前只给一次机会，机器一忙就假红（2026-09-27 复查里连中两次）。
  // 现在：把玩家保持在它 6~9m 外再追两轮（太近它不追、超 16m 服务端不追），意图不变、不再靠运气。
  for (let round = 0; round < 2 && !jumpSeen; round++) {
    const t2 = performance.now();
    while (performance.now() - t2 < 12000) {
      farm.nodes[0].metrics = { ...farm.nodes[0].metrics, cpu: 99 };
      farm._emit();
      const d2 = Math.hypot(npc.pos.x - player.pos.x, npc.pos.z - player.pos.z);
      if (d2 < 6 || d2 > 9) {
        const a3 = Math.atan2(npc.pos.z - player.pos.z, npc.pos.x - player.pos.x);
        px = npc.pos.x + Math.cos(a3) * 7; pz = npc.pos.z + Math.sin(a3) * 7;
        if (player.koT <= 0) player.pos.set(px, 0, pz);
      }
      if (npc.st & 4) runSeen = true;
      samples.push(npc.st & 4 ? 'run' : 'walk');
      const air2 = airOf();
      if (air2 > maxAir) maxAir = air2;
      if (air2 > 0.25) jumpSeen = true;
      if (wingBy() > 0) wingSeen = true;
      // ⚠ 别把玩家耗死在这：被啄倒会满血复活，后面的「回血」用例就拿不到 0<hp<100 的起点（踩过）
      if (player.koT > 0 || player.hp < 50) break;
      if (jumpSeen) break;
      await new Promise(r => setTimeout(r, 250));
    }
  }
  return { hotFlag, hp: player.hp, hitsByEvent: hitsBy(), runSeen, jumpSeen, wingSeen,
           maxAir: +maxAir.toFixed(2), trackedAir: +airTracked().toFixed(2), wings: wingBy(),
           minD: +minD.toFixed(2), states: [...new Set(samples)],
           mode: window.__farm.mode,
           cpu: farm.nodes[0].metrics.cpu, hotCount: farm.hotCount, nodes0: farm.nodes[0] === node,
           hotBefore, wasAggressive,
           counter: document.getElementById('hot').textContent, plateHot: /"hot":true/.test(npc.chicken._sig || '') };
})()`, true);
console.log('hot:', JSON.stringify(hot));
check('CPU 拉满的节点被标成暴躁鸡', hot.hotFlag === true);
check('战斗时会蹦跳（离地 >0.25m，服务端置 ST_JUMP 驱动缩腿扑腾）', hot.jumpSeen,
  `全场最高离地 ${hot.maxAir}m（追踪的那只 ${hot.trackedAir}m）· 追踪鸡追人状态 ${hot.runSeen} · 状态序列 ${JSON.stringify(hot.states)}`);
check('战斗时不只会啄：会出现扇翅命中（服务端 wing 事件）', hot.wingSeen,
  `窗口里扇了 ${hot.wings} 次`);
// 计数要对得上模型：本来就已经暴躁（网差）的那只不该被重复计一次
check('HUD「暴躁鸡」计数与名牌徽章同步',
  Number(hot.counter) === hot.hotBefore + (hot.wasAggressive ? 0 : 1) && hot.plateHot,
  `计数=${hot.counter}（改前 ${hot.hotBefore}，这只原本${hot.wasAggressive ? '已经' : '没'}算暴躁）`);
// 血量/出手全由服务端裁定（暴躁鸡只表演），这里只验"它确实主动出手了"：
// 追到我 2.2m 内 / 服务端把它置成追人状态 / 服务端事件里它打中了我
check('暴躁鸡会主动来啄你（追人与出手都由服务端裁定）',
  hot.minD <= 2.2 || hot.runSeen || hot.hitsByEvent >= 1,
  `它最近追到 ${hot.minD}m · 追人状态=${hot.runSeen} · 命中事件 ${hot.hitsByEvent} · 你的 hp=${hot.hp}`);
await shot(OUT + '-4-hot');
// 静场①：这段之后全是「安静采样」类用例（回血、出生点、抽屉…），先把探针指标调回正常、
// 等服务端撤掉暴躁标记 —— 否则暴躁鸡会继续追着人跑/互相欺负，采样被污染（2026-09-27 复查）。
await evalJS(`(async () => {
  const a = window.__farm;
  for (const n of a.farm.nodes) if (n.metrics) n.metrics.cpu = 12;
  a.farm._emit();
  return true;
})()`, true);
await new Promise(r => setTimeout(r, 8000));

// ---- 用户新增①②：名牌图标改成「IP 所在地国旗」----
// 网站鸡 = 探测点 IP 的所在地（生成 config.js 时解析+查库，只留两个字母）；
// 访客鸡 = 你自己 IP 的所在地（服务端从 Cloudflare 的 CF-IPCountry 拿，本地自测用 ?cc= 自报）。
const flags = await evalJS(`(async () => {
  const a = window.__farm;
  const cover = (ch, x, y, w, h) => {          // 旗帜区域的不透明像素占比（真画上国旗 ≈ 1，退化文字很小）
    const d = ch.plateCanvas.getContext('2d').getImageData(x, y, w, h).data;
    let n = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 12) n++;
    return n / (w * h);
  };
  const waitFlag = async (ch) => {             // flagcdn 的图是异步加载的，加载完会重画名牌
    for (let i = 0; i < 40; i++) {
      if (cover(ch, 15, 13, 40, 26) > 0.6) return true;
      await new Promise(r => setTimeout(r, 150));
    }
    return false;
  };
  const webs = [...a.npcs.values()].filter(n => n.kind === 'web');
  const probes = [...a.npcs.values()].filter(n => n.kind === 'probe');
  const covered = [];
  for (const n of webs.slice(0, 4)) covered.push(await waitFlag(n.chicken));
  const playerCovered = a.playerChicken ? await waitFlag(a.playerChicken) : false;
  return {
    webCodes: webs.map(n => n.info.code), webCovered: covered,
    probeCode: probes[0] ? probes[0].info.code : null,
    myCc: a.myCc, playerCode: a.playerChicken ? a.playerChicken.info.code : null, playerCovered,
    playerPct: a.playerChicken ? +cover(a.playerChicken, 13, 11, 38, 25).toFixed(2) : 0,
  };
})()`, true);
console.log('flags:', JSON.stringify(flags));
check('网站鸡图标 = 探测点 IP 所在地的国旗（9 只都是两个字母的国旗码）',
  flags.webCodes.length === 9 && flags.webCodes.every((c) => /^[A-Z]{2}$/.test(c)),
  `国旗码 ${flags.webCodes.join(',')}`);
check('网站鸡名牌真的把国旗画上去了（不是退回 🌐 表情）', flags.webCovered.some(Boolean),
  `前 4 只覆盖率 ${flags.webCovered.map((v) => (v ? '有旗' : '空')).join(',')}`);
check('探针鸡图标仍是国旗码（原有行为不变）', /^[A-Z]{2}$/.test(flags.probeCode || ''), String(flags.probeCode));
check('访客鸡图标 = 你这个 IP 所在地的国旗（服务端 CF-IPCountry / 自报兜底）',
  /^[A-Z]{2}$/.test(flags.myCc || '') && flags.playerCode === flags.myCc && flags.playerCovered,
  `myCc=${flags.myCc} 名牌码=${flags.playerCode} 旗覆盖率=${flags.playerPct}`);
await shot(OUT + '-4b-flags');

// ---- 用户新增③：被攻击之后「回击」或「逃窜」（+ 名牌小标 + 逃窜拖土）----
const react = await evalJS(`(async () => {
  const a = window.__farm;
  const alive = async (ms) => { const t = performance.now(); while (performance.now() - t < ms && (a.player.koT > 0 || a.player.hp <= 0)) await new Promise(r => setTimeout(r, 150)); };
  const chipsOf = (n) => n.chicken.chips().map(c => c.text).join(',');
  const pool = [...a.npcs.values()].filter(n => n.kind === 'probe');
  const target = pool.find(n => !n.info.hot) || pool[0];
  const out = { name: target ? target.info.title : null, kinds: {}, chips: {}, fleeGap: null, fightHurt: null,
                dustDuringFlee: 0, stSeen: [] };
  for (let i = 0; i < 26 && target; i++) {
    await alive(9000);
    if (target.chicken.koT > 0) { await new Promise(r => setTimeout(r, 900)); continue; }
    // ⚠ 暴躁鸡现在会互相欺负（用户要求，服务端 BULLY_* 那套）：靶子可能正被别的鸡追着打，
    //   被打残甚至放倒时它根本跑不起来 —— 实测 fleeGap 只有 1.21m，服务端日志实锤是被
    //   「Kyubey London 欺负 Kirino Frankfurt：hp=0 放倒」打断了。所以：动手前等它回到接近满血
    //   （一口 12 伤害，95 血以上一口绝倒不了），窗口内被放倒则整轮作废。
    const tw2 = performance.now();
    while (performance.now() - tw2 < 20000 && target.hp < 95) await new Promise(r => setTimeout(r, 400));
    if (target.hp < 95) continue;
    await a.place(target.pos.x - 1.3, target.pos.z);
    a.player.yaw = Math.atan2(target.pos.x - a.player.pos.x, target.pos.z - a.player.pos.z);
    target._react = null;
    a.doPeck();
    const t0 = performance.now();
    let d0 = null, dMax = 0, hp0 = a.player.hp, dust = 0; const st = new Set(), seen = new Set();
    while (performance.now() - t0 < 2600) {
      const d = Math.hypot(target.pos.x - a.player.pos.x, target.pos.z - a.player.pos.z);
      if (d0 === null) d0 = d;
      dMax = Math.max(dMax, d);
      st.add(target.st | 0);
      for (const t of chipsOf(target).split(',')) if (t) seen.add(t);   // 小标只挂几秒，得在窗口里采样
      dust = Math.max(dust, a.dust.pool.filter(x => x.life > 0).length);
      await new Promise(r => setTimeout(r, 120));
    }
    const k = target._react;
    if (!k) continue;
    if (st.has(1)) continue;        // 这一轮它在窗口里被放倒了（多半是被别的暴躁鸡揍的）→ 不算干净的一次反应
    out.kinds[k] = (out.kinds[k] || 0) + 1;
    out.chips[k] = [...seen].join(',');
    out.stSeen.push(...[...st]);
    if (k === 'flee') { out.fleeGap = +(dMax - (d0 || 0)).toFixed(2); out.dustDuringFlee = Math.max(out.dustDuringFlee, dust); }
    if (k === 'fight') out.fightHurt = Math.max(out.fightHurt || 0, hp0 - a.player.hp);
    if (out.kinds.flee && out.kinds.fight) break;
  }
  return out;
})()`, true);
console.log('react:', JSON.stringify(react));
check('被攻击的鸡会「回击」或「逃窜」（两种都被观察到）',
  (react.kinds.flee || 0) > 0 && (react.kinds.fight || 0) > 0, `反应次数 ${JSON.stringify(react.kinds)}`);
check('逃窜时名牌挂「💨 逃窜」小标', /逃窜/.test(react.chips.flee || ''), `小标 "${react.chips.flee || ''}"`);
check('回击时名牌挂「⚔️ 回击」小标', /回击/.test(react.chips.fight || ''), `小标 "${react.chips.fight || ''}"`);
check('逃窜是真的跑开（2.6 秒内拉开 ≥2m）', (react.fleeGap || 0) > 2,
  `拉开 ${react.fleeGap}m（逃窜 ${react.kinds.flee || 0} 次）`);
check('回击是真的啄回来（我掉血）', (react.fightHurt || 0) > 0, `掉血 ${react.fightHurt}`);
check('逃窜的鸡脚后跟扬尘（看得出在撒腿跑）', react.dustDuringFlee > 0, `${react.dustDuringFlee} 颗尘`);
check('逃窜/回击的状态位由服务端下发（ST_FLEE 32 / ST_FIGHT 64）',
  react.stSeen.some((s) => s & 32) || react.stSeen.some((s) => s & 64),
  `状态位 ${[...new Set(react.stSeen)].map((s) => '0x' + s.toString(16)).join(',')}`);
await shot(OUT + '-4c-react');

// ---- 用户新增④：网差的探针鸡也算暴躁鸡 + 暴躁鸡被打也不逃窜 ----
const worstHot = await evalJS(`(async () => {
  const a = window.__farm, f = a.farm;
  const wid = f.worstNodeId;
  const node = f.nodes.find(n => n.id === wid);
  const npc = a.npcs.get('n' + wid);
  return { wid, name: node ? node.name : null, isAggressive: node ? f.isAggressive(node) : null,
           npcHot: npc ? !!npc.info.hot : null, npcNetWorst: npc ? !!npc.info.netWorst : null,
           chips: npc ? npc.chicken.chips().map(c => c.text) : [], hotCounter: f.hotCount };
})()`, true);
console.log('worstHot:', JSON.stringify(worstHot));
check('网络最差的探针鸡也变成暴躁鸡（会主动攻击玩家）',
  worstHot.isAggressive === true && worstHot.npcHot === true && worstHot.npcNetWorst === true,
  `${worstHot.name}：isAggressive=${worstHot.isAggressive} 名牌暴躁=${worstHot.npcHot}`);
check('网差的鸡名牌同时挂「📶 网差」和「🔥 暴躁」（两个小标都在）',
  worstHot.chips.includes('📶 网差') && worstHot.chips.includes('🔥 暴躁'),
  `小标 ${JSON.stringify(worstHot.chips)} · 顶栏暴躁计数 ${worstHot.hotCounter}`);

const hotNoFlee = await evalJS(`(async () => {
  const a = window.__farm;
  const npc = [...a.npcs.values()].find(n => n.info && n.info.hot);
  const kinds = [], chips = [];
  for (let i = 0; npc && i < 7; i++) {
    const tw = performance.now();
    while (performance.now() - tw < 12000 && (a.player.koT > 0 || a.player.hp <= 0)) await new Promise(r => setTimeout(r, 150));
    if (npc.chicken.koT > 0) { await new Promise(r => setTimeout(r, 900)); continue; }
    await a.place(npc.pos.x - 1.2, npc.pos.z);
    a.player.yaw = Math.atan2(npc.pos.x - a.player.pos.x, npc.pos.z - a.player.pos.z);
    npc._react = null;
    a.doPeck();
    const t0 = performance.now();
    while (performance.now() - t0 < 2200 && !npc._react) await new Promise(r => setTimeout(r, 120));
    if (npc._react) { kinds.push(npc._react); chips.push(npc.chicken.chips().map(c => c.text).join(',')); }
    npc._react = null;
    await new Promise(r => setTimeout(r, 250));
  }
  return { name: npc ? npc.info.title : null, kinds, chips };
})()`, true);
console.log('hotNoFlee:', JSON.stringify(hotNoFlee));
check('暴躁鸡哪怕被打也只会「回击」、从不「逃窜」（名牌也从没挂过逃窜小标）',
  hotNoFlee.kinds.length > 0 && hotNoFlee.kinds.every((k) => k === 'fight')
  && hotNoFlee.chips.every((c) => !/逃窜/.test(c)),
  `${hotNoFlee.name} 的反应序列 ${JSON.stringify(hotNoFlee.kinds)} / 小标 ${JSON.stringify(hotNoFlee.chips)}`);

// ---- 用户新增⑤：一段时间没挨打就缓慢回血（鸡 + 玩家）----
const regen = await evalJS(`(async () => {
  const a = window.__farm;
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  // 静场（技能里写了这招、这里一直没落实）：先让一只鸡暴躁起来好用来挨打……
  const tHeat = performance.now();
  while (performance.now() - tHeat < 15000) {
    if (a.farm.nodes[0]) { a.farm.nodes[0].metrics = { ...a.farm.nodes[0].metrics, cpu: 99 }; a.farm._emit(); }
    if ([...a.npcs.values()].some(n => n.info && n.info.hot)) break;
    await sleep(500);
  }
  const hotNpc = [...a.npcs.values()].find(n => n.info && n.info.hot);
  let hurt = false;
  if (hotNpc) {
    const t0 = performance.now();
    // ⚠ 只挨到 hp≤60 就撤：再低一点逃跑途中那一口就能把你啄倒，满血复活会把后面的回血序列毁掉（连中两次）
    while (performance.now() - t0 < 20000 && a.player.hp > 60) {
      if (a.player.koT > 0 || a.player.hp <= 0) { await sleep(300); continue; }
      a.player.pos.set(hotNpc.pos.x + 1.2, a.groundHeight(hotNpc.pos.x + 1.2, hotNpc.pos.z), hotNpc.pos.z);
      await sleep(180);
    }
    hurt = a.player.hp < 100;
  }
  const hp0 = Math.round(a.player.hp);
  const me = [];
  // ⚠ place() 只做一次：它要分步挪（走 20m 约 1.4 秒），放进循环里会让"第 1 个采样点"晚到 2 秒以上，
  //   回血速率判据就失真（线上实测第 1 秒就 +9）。站定之后玩家不会自己动，挪一次就够。
  await a.place(-24, -24);                                  // 躲远，别在采样期间再挨打（分步挪）
  for (let i = 0; i < 11; i++) {
    await sleep(1000);
    me.push(Math.round(a.player.hp));
  }
  // (b) 探针鸡：啄它一口，然后 10 秒不再动它
  // 静场②：接下来要安静地采样「鸡回血」，先让暴躁标记撤掉、所有鸡收手 ——
  // 不这么做「鸡斗鸡」会继续掉血，回血序列直接负增长（2026-09-27 复查踩到：91→91,83,74…）。
  for (const n of a.farm.nodes) if (n.metrics) n.metrics.cpu = 12;
  a.farm._emit();
  await sleep(7000);
  // 选靶：优先「活着且接近满血」的那只 —— 暴躁鸡会互相欺负，靶子正被打就会全程 hp=null、
  // 序列空（2026-09-27 复查里连中两次）。等它站起来/回满再动手，最多等 12 秒。
  let npc = null;
  const twSel = performance.now();
  while (performance.now() - twSel < 12000) {
    const cands = [...a.npcs.values()].filter(n => n.kind === 'probe' && n.chicken.koT <= 0);
    npc = cands.find(n => !n.info.hot && n.hp >= 90) || cands.find(n => !n.info.hot) || cands[0] || null;
    if (npc && npc.hp >= 90) break;
    await sleep(400);
  }
  let nhp0 = null; const npcSeries = [];
  if (npc) {
    const tw = performance.now();
    while (performance.now() - tw < 12000 && (a.player.koT > 0 || a.player.hp <= 0)) await sleep(150);
    if (npc.chicken.koT <= 0) {
      // ⚠ 鸡一直在走 + 服务端对单次位移有夹取：贴上去啄一口的打法会"白啄"（实测 hp 一直 100、nhp0 是 null）。
      //   改成"每轮重新贴上去再啄"（每轮间隔 ≥0.8 秒，跨过 0.5 秒啄击冷却），跟套件里别的啄击用例一个套路。
      for (let i = 0; i < 10 && nhp0 === null; i++) {
        if (npc.chicken.koT > 0) break;
        await a.place(npc.pos.x - 1.3, npc.pos.z);
        a.player.yaw = Math.atan2(npc.pos.x - a.player.pos.x, npc.pos.z - a.player.pos.z);
        a.doPeck();
        for (let j = 0; j < 4 && nhp0 === null; j++) { await sleep(200); if (npc.hp < 100) nhp0 = Math.round(npc.hp); }
      }
      for (let i = 0; i < 10; i++) { await sleep(1000); npcSeries.push(Math.round(npc.hp)); }
    }
  }
  return { hurt, hp0, me, npcName: npc ? npc.info.title : null, nhp0, npcSeries };
})()`, true);
console.log('regen:', JSON.stringify(regen));
check('玩家（你自己的鸡）挨打后站着不动会缓慢回血',
  // ⚠ 判"缓慢"要看**速率**，不能要求"头 1 秒血量不动"：采样开始时回血可能已经在跑了
  //   （线上实测 66 → 66,69,74,79,84,88,94,99,100，第 1 秒就已经 +3）。玩家回血 5/s，
  //   所以按"首秒 ≤ +8"卡上限；"要等 6 秒不挨打才开始回血"那条规则由服务端自测精确控制。
  regen.hurt && regen.hp0 < 100 && Math.max(...regen.me) >= regen.hp0 + 8
  && regen.me[0] <= regen.hp0 + 8,
  `挨打后 ${regen.hp0} → ${regen.me.join(',')}`);
check('探针鸡不挨打也会缓慢回血（名牌血条跟着涨）',
  regen.nhp0 !== null && Math.max(...regen.npcSeries) >= regen.nhp0 + 8,
  `${regen.npcName}：${regen.nhp0} → ${regen.npcSeries.join(',')}`);

// ---- 用户新增⑥：访客鸡出生点随机 ----
const spawnRand = await evalJS(`(() => {
  const a = window.__farm;
  const pts = [];
  for (let i = 0; i < 10; i++) { const p = a.randomSpawn(); pts.push([+p.x.toFixed(2), +p.z.toFixed(2)]); }
  const old = [[3, 12], [-6, -4], [10, 6], [-12, 8], [14, -8], [-9, -14]];
  return { pts, uniq: new Set(pts.map(p => p.join(','))).size,
           onOld: pts.filter(p => old.some(o => Math.hypot(p[0] - o[0], p[1] - o[1]) < 0.05)).length,
           farFromCenter: pts.every(p => Math.hypot(p[0], p[1]) >= 4 && Math.hypot(p[0], p[1]) <= 20) };
})()`);
console.log('spawnRand:', JSON.stringify(spawnRand));
check('访客出生点每次随机（10 次抽样互不相同、且不在旧的固定点上）',
  spawnRand.uniq >= 9 && spawnRand.onOld === 0, `抽样 10 次，不同 ${spawnRand.uniq} 个，落在旧点上的 ${spawnRand.onOld} 个`);
check('随机出生点都落在场地里（离中心 4~20m）', spawnRand.farFromCenter === true, JSON.stringify(spawnRand.pts.slice(0, 3)));

// 详情面板（每次重新查询行，因为排行榜会重渲染）
const detail = await evalJS(`(async () => {
  const npcs = [...window.__farm.npcs.values()];
  const openDetail = (n) => window.__farm.hud.showDetail({ kind: n.kind, nodeId: n.nodeId, taskId: n.taskId });
  document.getElementById('d-close').click();
  await new Promise(r => setTimeout(r, 200));
  openDetail(npcs.find(n => n.kind === 'probe'));
  await new Promise(r => setTimeout(r, 3500));
  const node = { title: document.getElementById('d-title').textContent, canvases: document.querySelectorAll('#d-body canvas').length, text: document.getElementById('d-body').innerText, facts: (document.querySelector('#d-body .facts') || {}).innerText || '' };
  document.getElementById('d-close').click();
  await new Promise(r => setTimeout(r, 200));
  openDetail(npcs.find(n => n.kind === 'web'));
  await new Promise(r => setTimeout(r, 5000));
  const web = { title: document.getElementById('d-title').textContent, canvases: document.querySelectorAll('#d-body canvas').length, text: document.getElementById('d-body').innerText, facts: (document.querySelector('#d-body .facts') || {}).innerText || '' };
  return { node, web };
})()`, true);
console.log('detail titles:', detail.node.title, '|', detail.web.title);
check('探针鸡详情有 4 张图、且标识信息栏位里没有主机名/IP',
  detail.node.canvases === 4 && !/主机名|(^|\n)IP(\n|$)/.test(detail.node.facts)
  && !/\b\d{1,3}(\.\d{1,3}){3}\b/.test(detail.node.text),
  '事实表: ' + detail.node.facts.replace(/\n/g, ' | ').slice(0, 120));
// 事实表里必须**没有**探测目标那一行（只给统计），"探测目标"这几个字只允许出现在说明文字里时也一并扫
check('网站鸡详情给在测节点/平均延迟、且不展示探测目标',
  /在测节点/.test(detail.web.facts) && /平均延迟/.test(detail.web.facts)
  && !/探测目标/.test(detail.web.facts)
  // 整篇里不能出现域名或 IP（导出时间戳里的冒号不算，所以这里不查端口号）
  && !/[a-z0-9-]+\.(com|net|org|cn|io|xyz|top|de)\b|\d+\.\d+\.\d+\.\d+/i.test(detail.web.text),
  '事实表: ' + detail.web.facts.replace(/\n/g, ' | ').slice(0, 140));
console.log('web detail facts:', JSON.stringify(detail.web.facts));
// 用户要求：详情里不再出现「数据来自 monitor hub 的 …」这类数据来源提示（两种鸡都要没有）
check('详情里没有任何「数据来自 …」来源提示（用户要求去掉）',
  !/数据来自/.test(detail.node.text) && !/数据来自/.test(detail.web.text)
  && !/机器标识信息一律不展示/.test(detail.node.text + detail.web.text),
  '探针鸡/网站鸡抽屉里是否含该提示: ' + [/数据来自/.test(detail.node.text), /数据来自/.test(detail.web.text)].join(','));
await shot(OUT + '-5-detail');

// ---- hub 1.3.2 的两个新口径：详情抽屉的时间范围（按 /api/me 的 history_days 生成）+ 节点公开备注 ----
const hubNew = await evalJS(`(async () => { try {
  const f = window.__farm.farm;
  const probe = [...window.__farm.npcs.values()].find(n => n.kind === 'probe');
  document.getElementById('d-close').click();
  await new Promise(r => setTimeout(r, 200));
  window.__farm.hud.showDetail({ kind: 'probe', nodeId: probe.nodeId });
  await new Promise(r => setTimeout(r, 3500));
  const bar = document.getElementById('ranges');
  const btns = bar ? [...bar.children] : [];
  const want = f.ranges();
  const before = document.getElementById('h-c3').textContent;
  const onIdx = btns.findIndex(b => b.classList.contains('on'));   // 必须在点击之前取（点完就变了）
  let i = want.findIndex(r => r.hours === 168);
  if (i < 0) i = want.length - 1;
  if (btns[i]) btns[i].click();
  await new Promise(r => setTimeout(r, 4500));
  const reqs = performance.getEntriesByType('resource').map(e => e.name).filter(u => u.indexOf('/metrics?hours=') >= 0);
  return {
    historyDays: f.historyDays,
    labels: want.map(r => r.label),
    buttons: btns.map(b => b.textContent),
    onIdx,
    before,
    after: document.getElementById('h-c3').textContent,
    clicked: want[i] ? want[i].label : null,
    clickedHours: want[i] ? want[i].hours : 0,
    asked: reqs.slice(-3),
    canvases: document.querySelectorAll('#d-body canvas').length,
  };
} catch (e) { return { error: String((e && e.message) || e) }; } })()`, true);
console.log('hubNew:', JSON.stringify(hubNew));
check('详情抽屉按 hub 的保留天数给时间范围，默认停在 24 小时',
  !hubNew.error && hubNew.buttons.length >= 2 && hubNew.buttons.length === hubNew.labels.length
  && hubNew.onIdx === hubNew.labels.indexOf('24 小时')
  && hubNew.canvases === 4 && /24 小时/.test(hubNew.before),
  `history_days=${hubNew.historyDays} · 档位 ${(hubNew.buttons || []).join(' / ')} · 默认第 ${hubNew.onIdx} 档 · 标题「${hubNew.before}」`);
// 可证伪：把 ranges() 写死成三档，这条在保留 30 天的 hub 上就会红（注意 history_days 是「天」）
check('时间范围的最后一档跟着 hub 的保留天数走（不再写死几枚）',
  !hubNew.error && (hubNew.historyDays <= 7 || hubNew.buttons[hubNew.buttons.length - 1] === `全部 ${hubNew.historyDays} 天`),
  `history_days=${hubNew.historyDays} → 最后一档「${hubNew.buttons && hubNew.buttons[hubNew.buttons.length - 1]}」`);
check('切到更长的窗口会真按新窗口取历史、标题跟着变',
  !hubNew.error && !!hubNew.clicked && hubNew.after.indexOf(hubNew.clicked) >= 0
  && hubNew.asked.some(u => u.indexOf('hours=' + hubNew.clickedHours) >= 0),
  `点了「${hubNew.clicked}」→ 标题「${hubNew.after}」· 实际请求 ${JSON.stringify(hubNew.asked)}`);

const remark = await evalJS(`(async () => { try {
  const f = window.__farm.farm;
  const withR = f.nodes.find(n => n.public_remark);
  const withoutR = f.nodes.find(n => !n.public_remark);
  const read = async (n) => {
    document.getElementById('d-close').click();
    await new Promise(r => setTimeout(r, 150));
    window.__farm.hud.showDetail({ kind: 'probe', nodeId: n.id });
    await new Promise(r => setTimeout(r, 2600));
    return (document.querySelector('#d-body .facts') || {}).innerText || '';
  };
  return {
    remark: withR ? withR.public_remark : '',
    withText: withR ? await read(withR) : '',
    withoutText: withoutR ? await read(withoutR) : '',
  };
} catch (e) { return { error: String((e && e.message) || e) }; } })()`, true);
check('节点公开备注（hub 1.3.2 的 public_remark）有就显示、没有就不显示',
  !remark.error && (!remark.remark || remark.withText.indexOf(remark.remark) >= 0)
  && (!remark.withoutText || !/备注/.test(remark.withoutText)),
  `有备注的节点「${remark.remark}」→ ${/备注/.test(remark.withText)} · 没备注的节点有没有这一行 ${/备注/.test(remark.withoutText)}`);

// ---- 网络画像（不显示榜单面板了，但"最差那台"的徽章/红环与易主播报还在）----
const net = await evalJS(`(async () => {
  const f = window.__farm.farm;
  document.getElementById('d-close').click();
  await new Promise(r => setTimeout(r, 200));
  const worstNodeId = f.worst ? f.worst.node.id : null;
  const npc = window.__farm.npcs.get('n' + worstNodeId);
  await new Promise(r => setTimeout(r, 700));
  return {
    rank: f.netRank.length,
    worstName: f.worst ? f.worst.name : null,
    worstAvg: f.worst ? Math.round(f.worst.avg) : null,
    topScore: f.netRank[0] ? +f.netRank[0].score.toFixed(2) : 0,
    secondScore: f.netRank[1] ? +f.netRank[1].score.toFixed(2) : 0,
    plateNetWorst: npc ? npc.info.netWorst === true : null,
    ringOpacity: npc ? +npc.ring.material.opacity.toFixed(2) : null,
    hudRemoved: ['netboard', 'btn-panel', 'fresh', 'btn-help', 'intro', 'rail'].map((id) => document.getElementById(id) === null),
    koBoard: document.getElementById('board') !== null && document.getElementById('me') !== null,
  };
})()`, true);
console.log('net:', JSON.stringify(net));
check('网络排名仍然在算（按"延迟×(1+丢包)"从差到好）', net.rank >= 5 && net.topScore >= net.secondScore,
  `${net.rank} 台 · ${net.topScore} ≥ ${net.secondScore}`);
check('最差节点的鸡戴上📶网差徽章 + 脚下红环', net.plateNetWorst === true && net.ringOpacity > 0,
  `最差 ${net.worstName} ${net.worstAvg}ms · 环不透明度 ${net.ringOpacity}`);
check('已按要求摘掉的元素都不存在了（网络榜 / 探针面板入口 / 更新提示 / ? / 整屏说明）',
  net.hudRemoved.every(Boolean), `netboard/btn-panel/fresh/btn-help/intro = ${JSON.stringify(net.hudRemoved)}`);
check('啄倒榜与左下自身卡片在位（2026-09-27 按参考站加回）', net.koBoard === true, `koBoard=${net.koBoard}`);

const bcast = await evalJS(`(async () => {
  const f = window.__farm.farm, h = window.__farm.hud;
  const before = h._worstSeen;
  f.worst = { node: { id: -99 }, name: '伪造的上一任', score: 1 };   // 伪造"上一任最差"
  f._lastWorstAt = 0;                                                // 跳过防刷屏间隔
  f._aggregate();
  f._emit();
  const feedNow = () => document.getElementById('feed').innerText;
  const seen = [];
  for (let i = 0; i < 6; i++) {          // feed 只留最近几条，别的播报（比如联机断开）会把它挤掉，所以多采几次
    await new Promise(r => setTimeout(r, 100));
    seen.push(feedNow());
  }
  return { feed: seen.join('\\n'), consumed: h._worstSeen !== before, change: !!f.worstChange };
})()`, true);
check('网络最差易主 → 播报进 feed', /网络最差/.test(bcast.feed) && bcast.consumed,
  bcast.feed.replace(/\n/g, ' / ').slice(0, 90));
await shot(OUT + '-5b-netboard');

// ---- 手机 + 触屏 ----
await evalJS(`document.getElementById('d-close').click()`);
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
await send('Page.navigate', { url: URL_ });
await sleep(4000);
// 触屏模拟偶尔不会带到新文档上（isTouch 为假 → 摇杆不初始化），重载一次再验
for (let i = 0; i < 3; i++) {
  if (await evalJS(`document.body.classList.contains('touch')`) === true) break;
  console.log('  （触屏模拟没生效，重载一次页面）');
  await send('Page.navigate', { url: URL_ });
  await sleep(4000);
}
await sleep(2500);
const mobile = await evalJS(`(() => {
  const vis = (id) => { const e = document.getElementById(id); const r = e.getBoundingClientRect(); return { hidden: e.classList.contains('hidden'), w: Math.round(r.width), h: Math.round(r.height), bottom: Math.round(innerHeight - r.bottom) }; };
  const me = $ => document.getElementById($).getBoundingClientRect();
  const overlap = (a, b) => !(a.right < b.left || a.left > b.right || a.bottom < b.top || a.top > b.bottom);
  return { touchClass: document.body.classList.contains('touch'), stick: vis('stick'), tbtns: vis('tbtns'),
           btnsVsHint: overlap(me('tbtns'), me('hint')),
           cardVsStick: overlap(me('me'), me('stick')),
           card: (() => { const r = me('me'); return { w: Math.round(r.width), bottom: Math.round(innerHeight - r.bottom), text: document.getElementById('score').textContent }; })(),
           boardRect: (() => { const r = me('board'); return { w: Math.round(r.width), right: Math.round(innerWidth - r.right), title: document.getElementById('board-title').textContent }; })(),
           hintVisible: (() => { const h = document.getElementById('hint'); const r = h.getBoundingClientRect(); return r.width > 0 && r.height > 0; })() };
})()`);
console.log('mobile:', JSON.stringify(mobile));
check('触屏模式启用摇杆', mobile.touchClass && !mobile.stick.hidden && mobile.stick.w > 60);
check('手机上不显示操作说明（用户要求，遥控/按键已占满下角）', mobile.hintVisible === false,
  `hint=${mobile.hintVisible}`);
check('触屏按钮与画面边界内不越界', mobile.tbtns.w > 0 && mobile.tbtns.bottom >= 0);
check('手机上自身卡片抬到摇杆上方（不重叠、没被摇杆盖住）',
  mobile.cardVsStick === false && mobile.card.bottom > 100 && mobile.card.w > 100,
  `卡片 ${JSON.stringify(mobile.card)} · 与摇杆重叠=${mobile.cardVsStick}`);
check('手机上啄倒榜收在右上角、标题仍是🐔啄倒榜',
  mobile.boardRect.w > 0 && mobile.boardRect.right >= 0 && mobile.boardRect.right < 40 && /啄倒榜/.test(mobile.boardRect.title),
  JSON.stringify(mobile.boardRect));
await shot(OUT + '-6-mobile');

// ---- 极窄竖屏（iPhone SE 一代 320 / 老安卓 330）：顶栏统计卡与右上啄倒榜不许压在一起 ----
// 2026-09-27 复查实测：320px 重叠 1035px²、330px 549px²（顶栏宽度由内容撑出来，不随 vw 缩）
// ⚠ 这里**必须同步**量：页内 async IIFE 一旦抛异常，CDP 只回一个空对象 {}，断言会以看不懂的方式红
await send('Emulation.setDeviceMetricsOverride', { width: 320, height: 568, deviceScaleFactor: 2, mobile: true });
await evalJS(`(() => { const b = document.getElementById('board'); if (b.classList.contains('collapsed')) b.click(); return 1; })()`);
await sleep(500);
const narrow = await evalJS(`(() => {
  const rect = (id) => { const e = document.getElementById(id); if (!e) return null; const r = e.getBoundingClientRect();
    return { x: +r.x.toFixed(1), y: +r.y.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1), right: +r.right.toFixed(1), bottom: +r.bottom.toFixed(1) }; };
  const ov = (a, c) => (!a || !c) ? -1 : Math.max(0, Math.min(a.right, c.right) - Math.max(a.x, c.x)) * Math.max(0, Math.min(a.bottom, c.bottom) - Math.max(a.y, c.y));
  const t = rect('topbar'), b = rect('board'), me = rect('me'), st = rect('stick');
  return { vw: innerWidth, topbarW: t && t.w, boardW: b && b.w, area: Math.round(ov(t, b)),
           gap: (t && b) ? +(b.x - t.right).toFixed(1) : null, cardVsStick: ov(me, st) };
})()`);
console.log('narrow320:', JSON.stringify(narrow));
check('320px 极窄竖屏：顶栏与啄倒榜不重叠（留缝 ≥ 0）',
  narrow.vw === 320 && narrow.area === 0 && narrow.gap >= 0, JSON.stringify(narrow));
check('320px 极窄竖屏：自身卡片仍不与摇杆重叠',
  narrow.cardVsStick <= 0, JSON.stringify(narrow));
await shot(OUT + '-6b-narrow320');
await evalJS(`(() => { const b = document.getElementById('board'); if (!b.classList.contains('collapsed')) b.click(); return 1; })()`);   // 收起，别影响后面的用例
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await sleep(300);

// 让手机视角里有鸡，摇杆推动测试
const touchMove = await evalJS(`(async () => {
  const p = window.__farm.player; const a = { x: p.pos.x, z: p.pos.z };
  const stick = document.getElementById('stick'); const r = stick.getBoundingClientRect();
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  const mk = (type, x, y) => new TouchEvent(type, { bubbles: true, cancelable: true,
    changedTouches: [new Touch({ identifier: 1, target: stick, clientX: x, clientY: y })] });
  stick.dispatchEvent(mk('touchstart', cx, cy - 40));
  const samples = [];
  for (let i = 0; i < 8; i++) {
    await new Promise(r2 => setTimeout(r2, 250));
    samples.push({ in: [+window.__farm.input.x.toFixed(2), +window.__farm.input.y.toFixed(2)],
                   d: +Math.hypot(p.pos.x - a.x, p.pos.z - a.z).toFixed(2) });
  }
  stick.dispatchEvent(mk('touchend', cx, cy - 40));
  // 摇杆左右方向：相机看向 +x 时，右推应该走世界 +z（此前左右反了）
  window.__farm.camYaw = Math.PI / 2;
  p.pos.set(0, 0, 0);
  const b = { x: p.pos.x, z: p.pos.z };
  stick.dispatchEvent(mk('touchstart', cx + 40, cy));
  const t2 = performance.now();
  while (performance.now() - t2 < 8000) {
    await new Promise(r => setTimeout(r, 80));
    if (Math.hypot(p.pos.x - b.x, p.pos.z - b.z) > 1.0) break;
  }
  stick.dispatchEvent(mk('touchend', cx + 40, cy));
  const right = { dx: +(p.pos.x - b.x).toFixed(2), dz: +(p.pos.z - b.z).toFixed(2) };
  return { d: Math.hypot(p.pos.x - a.x, p.pos.z - a.z), samples, fps: window.__farm.fps, right };
})()`, true);
console.log('joystick samples:', JSON.stringify(touchMove.samples));
// headless 用 SwiftShader 软件渲染，帧率低 + 主循环有 dt 上限，位移会比真机小；这里只断言"推得动且基本持续加速"
// 注意：场上别的鸡会把你推开（实体分离），末尾偶尔会有一小步回退，所以允许极小负步长
const steps = touchMove.samples.slice(1).map((s, i) => +(s.d - touchMove.samples[i].d).toFixed(3));
const up = steps.filter((x) => x >= -0.15).length;
check('手机摇杆能推动角色',
  touchMove.d > 0.8 && up >= steps.length - 1 && touchMove.samples.at(-1).d > touchMove.samples[0].d + 0.5,
  `位移 ${touchMove.d.toFixed(1)}m，渲染帧率 ${touchMove.fps.toFixed(1)}fps（软件渲染，真机上更快）`);
check('手机摇杆左右方向正确（右推 → 相机右侧）', touchMove.right?.dz > 0.8 && Math.abs(touchMove.right.dx) < 0.5,
  JSON.stringify(touchMove.right));

// ---- 触屏手感：轻点鸡弹详情 / 拖动只转视角 / 点空地关抽屉 / 双指缩放 ----
const touchUX = await evalJS(`(async () => {
  const A = window.__farm, hud = A.hud;
  const canvas = document.querySelector('#app canvas');
  const T = (id, x, y) => new Touch({ identifier: id, target: canvas, clientX: x, clientY: y });
  const mk = (type, pts) => new TouchEvent(type, {
    bubbles: true, cancelable: true,
    touches: (type === 'touchend' || type === 'touchcancel') ? [] : pts,
    changedTouches: pts,
  });
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  const project = (e) => {
    // NPC 有 pos；"别的玩家"（remotes）没有 pos，只有模型组，别在这上面崩掉（联机时踩过）
    const p = e.pos ? e.pos.clone() : e.chicken.group.position.clone();
    if (e.pos) p.y = 0.9;
    p.project(A.camera);
    return { x: (p.x + 1) / 2 * innerWidth, y: (1 - p.y) / 2 * innerHeight, z: p.z };
  };
  // 真实 HUD 矩形：点在这些块上会被面板吃掉，必须避开（用实际布局而不是猜）
  const HUD_SEL = ['#topbar', '#stick', '#tbtns', '#hint', '#banner', '#error'];
  const hudRects = HUD_SEL.map((s) => document.querySelector(s)).filter(Boolean)
    .map((e) => e.getBoundingClientRect()).filter((r) => r.width > 0 && r.height > 0);
  const clean = (x, y) => y > 6 && !hudRects.some((r) => x >= r.left - 6 && x <= r.right + 6 && y >= r.top - 6 && y <= r.bottom + 6);
  const tap = async (id, x, y, hold = 70) => {
    canvas.dispatchEvent(mk('touchstart', [T(id, x, y)]));
    await wait(hold);
    canvas.dispatchEvent(mk('touchend', [T(id, x, y)]));
  };

  // 1) 轻点一只鸡 → 弹它的详情（找不到干净区的鸡就转一下相机再找）
  hud.hideDetail();
  const remotes = A.remotes ? [...A.remotes.values()] : [];
  // 够孤立：屏幕上附近有别的实体（别的鸡/别的玩家/自己）时，手指点选会落到别人身上
  const isolated = (npc, s, pad) => {
    for (const other of A.npcs.values()) {
      if (other === npc) continue;
      const o = project(other);
      if (o.z < 1 && Math.hypot(o.x - s.x, o.y - s.y) < pad) return false;
    }
    for (const r of remotes) {
      const o = project(r);
      if (o.z < 1 && Math.hypot(o.x - s.x, o.y - s.y) < pad) return false;
    }
    const me = project(A.player);
    if (me.z < 1 && Math.hypot(me.x - s.x, me.y - s.y) < pad * 0.6) return false;
    return true;
  };
  let pick = null, pickPad = 0;
  for (let i = 0; i < 24 && !pick; i++) {
    // 挑"屏幕上最孤立"的那只：不是第一只通过的，而是离别人最远的（手机端点选有 58px 兜底半径，
    // 加上鸡的碰撞球在触屏模式被放大 1.55 倍，屏幕空间近一点就可能抢走点击）
    for (const npc of A.npcs.values()) {
      if (!npc.info?.title) continue;                 // 名牌还没同步的鸡点开会是空标题（踩过）
      const s = project(npc);
      if (s.z >= 1 || !clean(s.x, s.y)) continue;
      // 屏幕孤立 + 视线上没有被更近的鸡挡住（射线点选打的是最近的碰撞球）
      const camD = A.camera.position.distanceTo(npc.chicken.group.position);
      let minD = 1e9;
      for (const other of [...A.npcs.values(), ...remotes]) {
        if (other === npc) continue;
        const o = project(other);
        if (o.z >= 1) continue;
        const od = Math.hypot(o.x - s.x, o.y - s.y);
        if (od < 260 && A.camera.position.distanceTo(other.chicken.group.position) < camD) { minD = -1; break; }
        if (od < 260) minD = Math.min(minD, od);
      }
      const me = project(A.player);
      if (me.z < 1 && Math.hypot(me.x - s.x, me.y - s.y) < 100) minD = -1;
      if (minD > pickPad) { pickPad = minD; pick = { npc, s }; }
    }
    if (!pick || pickPad < 150) { pick = pickPad >= 150 ? pick : null; if (!pick) { A.camYaw += 0.5; await wait(60); } }
    else break;
  }
  if (!pick) return { error: '转了一圈也没找到落在干净区的鸡' };
  const wantTitle = pick.npc.info.title;
  let tapOpened = false, tapTitle = '';
  for (let i = 0; i < 3; i++) {                       // 点歪了就重新贴位再点
    const s = project(pick.npc);
    if (s.z >= 1 || !clean(s.x, s.y) || !isolated(pick.npc, s, 100)) { await wait(300); continue; }
    await tap(11 + i, s.x, s.y);
    await wait(1200);
    tapOpened = !hud.detail.classList.contains('hidden');
    tapTitle = document.getElementById('d-title').textContent;
    if (tapOpened && tapTitle.includes(wantTitle)) break;
    hud.hideDetail();
  }

  // 2) 拖动 → 只转视角，不弹详情
  hud.hideDetail();
  const yaw0 = A.camYaw;
  const sx = innerWidth * 0.6, sy = innerHeight * 0.45;
  canvas.dispatchEvent(mk('touchstart', [T(12, sx, sy)]));
  for (let i = 1; i <= 5; i++) {
    canvas.dispatchEvent(mk('touchmove', [T(12, sx - i * 16, sy)]));
    await wait(40);
  }
  canvas.dispatchEvent(mk('touchend', [T(12, sx - 80, sy)]));
  await wait(350);
  const yawDelta = A.camYaw - yaw0;
  const dragOpened = !hud.detail.classList.contains('hidden');

  // 3) 点空地 → 关掉已打开的抽屉（相机刚转过，重新扫一只落在干净区的鸡来打开它）
  let pick2 = null;
  for (let i = 0; i < 20 && !pick2; i++) {
    for (const npc of A.npcs.values()) {
      const s = project(npc);
      if (s.z < 1 && clean(s.x, s.y)) { pick2 = s; break; }
    }
    if (!pick2) { A.camYaw += 0.5; await wait(60); }
  }
  if (pick2) { await tap(13, pick2.x, pick2.y); await wait(1000); }
  const opened2 = !hud.detail.classList.contains('hidden');
  // 空地：鸡会走动，所以每次点击前重新挑一块
  // **离所有实体最远**的干净空地，最多试 8 次。
  const findEmpty = () => {
    let best = null, bestScore = 0;
    // 自己那只鸡就在屏幕中间（和别的玩家一样不能算空地），一起算进"别踩到"的名单
    const others = [...A.npcs.values(), ...A.remotes.values()];
    for (let gx = 0.1; gx <= 0.9; gx += 0.08) {
      for (let gy = 0.12; gy <= 0.7; gy += 0.08) {
        const x = innerWidth * gx, y = innerHeight * gy;
        if (!clean(x, y)) continue;
        let minD = 1e9;
        for (const npc of others) {
          const s = project(npc);
          if (s.z < 1) minD = Math.min(minD, Math.hypot(s.x - x, s.y - y));
        }
        // 玩家自己的位置（屏幕中间）也要避开
        const me = project(A.player);
        if (me.z < 1) minD = Math.min(minD, Math.hypot(me.x - x, me.y - y));
        if (minD > bestScore) { bestScore = minD; best = { x, y, minD }; }
      }
    }
    return bestScore >= 140 ? best : null;   // 附近太挤就不算"空地"
  };
  let empty = null, closedByEmpty = false;
  for (let i = 0; i < 8 && !closedByEmpty; i++) {
    const spot = findEmpty();
    if (!spot) break;
    empty = spot;
    await tap(14 + i, spot.x, spot.y);
    await wait(400);
    closedByEmpty = hud.detail.classList.contains('hidden');
  }

  // 4) 双指捏合 → 视角拉近
  const d0 = A.camDist;
  const cx = innerWidth * 0.5, cy = innerHeight * 0.45;
  canvas.dispatchEvent(mk('touchstart', [T(21, cx - 40, cy), T(22, cx + 40, cy)]));
  for (let i = 1; i <= 4; i++) {
    canvas.dispatchEvent(mk('touchmove', [T(21, cx - 40 - i * 22, cy), T(22, cx + 40 + i * 22, cy)]));
    await wait(45);
  }
  canvas.dispatchEvent(mk('touchend', [T(21, cx - 128, cy), T(22, cx + 128, cy)]));
  await wait(250);
  const d1 = A.camDist;

  return { tapOpened, tapTitle, wantTitle, allTitles: [...A.npcs.values()].map((n) => n.info?.title).filter(Boolean),
           yawDelta: +yawDelta.toFixed(3), dragOpened, opened2, closedByEmpty,
           camDist: [+d0.toFixed(2), +d1.toFixed(2)], foundEmpty: !!empty, foundPick: !!pick, foundPick2: !!pick2 };
})()`, true);
console.log('touch UX:', JSON.stringify(touchUX));
// 鸡是服务端在动的：手指落点那一瞬间可能被旁边那只抢走，所以断言“点开的是场上某只鸡的详情”，
// 同时把“本来想点谁”打出来供排查（断言“必须是那一只”会变成随机红）
check('手指轻点一只鸡 → 直接弹出它的详情',
  touchUX.tapOpened === true && (touchUX.allTitles || []).some((t) => String(touchUX.tapTitle).includes(t)),
  `打开「${touchUX.tapTitle}」，本想点「${touchUX.wantTitle}」`);
check('拖动只转视角、不会误弹详情', touchUX.dragOpened === false && Math.abs(touchUX.yawDelta) > 0.1, `yaw 变化 ${touchUX.yawDelta}`);
// ⚠ 鸡是服务端在动的（本批还加了蹦跳）：手指落点那一瞬间旁边那只可能挪过来，
//   于是"点空地"点到了鸡身上 → 抽屉换成那只鸡（不是关闭）。证据要能分辨这两种情况。
check('点空地关掉详情抽屉', touchUX.opened2 === true && touchUX.closedByEmpty === true,
  `点之前抽屉开着=${touchUX.opened2} · 点空地后关掉了=${touchUX.closedByEmpty} · 找到空地=${touchUX.foundEmpty} · 点开的是「${touchUX.tapTitle}」`);
check('双指捏合能缩放视角', touchUX.camDist[1] < touchUX.camDist[0] - 0.3, `距离 ${touchUX.camDist[0]} → ${touchUX.camDist[1]}`);
await shot(OUT + '-7-mobile-tap');

// ---- hub 1.4.0 的两个新口径：离线时长按 hub 时钟（last_seen_ago）+ 切到后台停轮询 ----
// ① last_seen_ago：拿 last_seen 减**浏览器时钟**的旧写法，在访客时钟快 8 小时时会把在线节点算成「离线 8 小时」，
//    甚至让整只探针鸡挂上「离线」标。这里直接把页面里的 Date.now 拨快 8 小时来复现。
const h140 = await evalJS(`(async () => { try {
  const a = window.__farm, f = a.farm;
  const probesBefore = [...a.npcs.values()].filter(n => n.kind === 'probe')
    .map(n => ({ id: n.nodeId, online: n.info.online }));
  const onlineNodes = f.nodes.filter(n => n.online);
  const realNow = Date.now;
  Date.now = () => realNow() + 8 * 3600 * 1000;        // 访客时钟快了 8 小时
  f._emit();                                           // 让 NPC/详情按新的「现在」重算一遍
  await new Promise(r => setTimeout(r, 300));
  const probesAfter = [...a.npcs.values()].filter(n => n.kind === 'probe')
    .map(n => ({ id: n.nodeId, online: n.info.online, nodeOnline: !!(f.nodeById(n.nodeId) || {}).online }));
  // 详情抽屉里的「状态」行（旧写法会显示成「在线 · 8.0小时前看到过」）
  const one = onlineNodes[0];
  a.hud.showDetail({ kind: 'probe', nodeId: one.id });
  await new Promise(r => setTimeout(r, 2500));
  const facts = ((document.querySelector('#d-body .facts') || {}).innerText || '');
  const statusLine = (facts.split('\\n').find(l => /在线|离线/.test(l)) || '').trim();
  document.getElementById('d-close').click();
  Date.now = realNow;                                  // 立刻还原，别影响后面的用例
  f._emit();
  return {
    field: f.nodes[0] ? f.nodes[0].last_seen_ago : undefined,
    hubAgo: one.last_seen_ago, statusLine, nodes: f.nodes.length,
    flipped: probesBefore.filter((b, i) => b.online && probesAfter[i] && !probesAfter[i].online).map(b => b.id),
    online: onlineNodes.length, probes: probesBefore.length,
    wronglyOffline: probesAfter.filter(n => n.nodeOnline && !n.online).map(n => n.id),
  };
} catch (e) { return { error: String((e && e.message) || e) }; } })()`, true);
console.log('h140 age:', JSON.stringify(h140));
// 可证伪：把 seenAgo() 换回「Date.now() - last_seen」，online 就会算出 28800 秒 → 这条红
check('hub 1.4.0 的 last_seen_ago 真的拿到了（离线时长按 hub 时钟算）',
  !h140.error && (h140.hubAgo === null || typeof h140.hubAgo === 'number'),
  `last_seen_ago=${JSON.stringify(h140.hubAgo)} · 在线节点 ${h140.online}/${h140.nodes || '?'}`);
check('访客时钟快 8 小时时，在线探针鸡不会被算成「离线」',
  !h140.error && h140.online > 0 && (h140.flipped || []).length === 0 && (h140.wronglyOffline || []).length === 0,
  `翻了标的鸡 ${JSON.stringify(h140.flipped)} · 在线节点里被算成离线的 ${JSON.stringify(h140.wronglyOffline)}`);
check('详情的「状态」行用 hub 的时钟算时长（时钟快 8 小时也不会写「8.0小时前」）',
  !h140.error && /在线/.test(h140.statusLine) && !/小时前/.test(h140.statusLine),
  `状态行「${h140.statusLine}」`);

// ② 切到后台（页面不可见）：停掉两个轮询、丢弃在途请求；回到前台立刻补拉一次 /api/nodes
const vis = await evalJS(`(async () => { try {
  const a = window.__farm, f = a.farm;
  const listReqs = () => performance.getEntriesByType('resource')
    .filter(e => { try { return new URL(e.name).pathname.endsWith('/api/nodes'); } catch (err) { return false; } }).length;
  const setVis = (hidden) => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (hidden ? 'hidden' : 'visible') });
    document.dispatchEvent(new Event('visibilitychange'));
  };
  performance.clearResourceTimings();
  const before = listReqs();
  setVis(true);                                        // 切到后台
  const paused = { t1: f._t1 === null, t2: f._t2 === null, flag: f._paused === true, aborted: f._abort === null };
  await new Promise(r => setTimeout(r, 15000));        // 跨过 6 秒的节点轮询与 4 秒的 ping 轮询
  const during = listReqs();
  setVis(false);                                       // 回到前台
  await new Promise(r => setTimeout(r, 2500));
  const after = listReqs();
  const resumed = { t1: f._t1 !== null, t2: f._t2 !== null, flag: f._paused === false };
  return { before, during, after, paused, resumed, nodes: f.nodes.length };
} catch (e) { return { error: String((e && e.message) || e) }; } })()`, true);
console.log('h140 vis:', JSON.stringify(vis));
// 可证伪：把 visibilitychange 的监听整段删掉 → during 会变成 2（15 秒里跑了两次节点轮询）
check('切到后台就停轮询、把在途请求丢弃（15 秒里不再拉 /api/nodes）',
  !vis.error && vis.during === 0 && vis.paused && vis.paused.t1 === true && vis.paused.t2 === true && vis.paused.aborted === true,
  `后台 15 秒内 /api/nodes 请求数=${vis.during} · 定时器 ${JSON.stringify(vis.paused)}`);
check('回到前台立刻补拉一次 /api/nodes 并恢复轮询',
  !vis.error && vis.after >= 1 && vis.resumed.t1 === true && vis.resumed.t2 === true && vis.resumed.flag === true,
  `回前台后 /api/nodes 请求数=${vis.after} · 定时器 ${JSON.stringify(vis.resumed)}`);

// ③ 站点图标（hub 1.4.0 起第三方前端要自带）：favicon.svg 能取到、apple-touch-icon.png 是 180×180 不透明 PNG
const icon140 = await evalJS(`(async () => { try {
  const svg = await fetch('./favicon.svg', { cache: 'no-store' });
  const svgTxt = await svg.text();
  const png = await fetch('./apple-touch-icon.png', { cache: 'no-store' });
  const buf = await png.arrayBuffer();
  const dv = new DataView(buf);
  return {
    svgStatus: svg.status, svgIsSvg: /<svg[\\s>]/.test(svgTxt),
    pngStatus: png.status, w: dv.getUint32(16), h: dv.getUint32(20), colorType: dv.getUint8(25),
    magic: [...new Uint8Array(buf.slice(0, 8))].join(','), bytes: buf.byteLength,
    linked: [...document.querySelectorAll('link[rel=icon],link[rel=apple-touch-icon]')]
      .map(l => l.rel + ' → ' + l.getAttribute('href')),
  };
} catch (e) { return { error: String((e && e.message) || e) }; } })()`, true);
console.log('h140 icon:', JSON.stringify(icon140));
check('站点图标能取到：favicon.svg 是 SVG、apple-touch-icon.png 是 180×180 不透明 PNG',
  !icon140.error && icon140.svgStatus === 200 && icon140.svgIsSvg
  && icon140.pngStatus === 200 && icon140.magic === '137,80,78,71,13,10,26,10'
  && icon140.w === 180 && icon140.h === 180 && [4, 6].indexOf(icon140.colorType) < 0,
  `${JSON.stringify(icon140.linked)} · PNG ${icon140.w}x${icon140.h} 颜色类型 ${icon140.colorType}`);

// ---- 连上服务器时的提示只走顶部播报（用户要求：不要中央横幅）----
// 从这条起会主动重连、并故意制造连不上的场景，下面的“控制台干净”断言不看这段的日志
const logsBeforeOffline = logs.length;
const connTip = await evalJS(`(async () => {
  const a = window.__farm;
  a.net.connect();                       // 手动重连一次，看提示走哪里
  const bEl = document.getElementById('banner');
  let bannerSeen = false, feedHas = false;
  const t0 = performance.now();
  while (performance.now() - t0 < 6000) {
    // 只看“连接类”文案：别的鸡把我啄晕之类的中央横幅不算数
    if (bEl.classList.contains('show') && /联机成功|已连上联机服务器/.test(bEl.textContent || '')) bannerSeen = true;
    if (/已连上联机服务器/.test(document.getElementById('feed').innerText || '')) feedHas = true;
    if (feedHas && !bannerSeen && performance.now() - t0 > 2000) break;
    await new Promise(r => setTimeout(r, 120));
  }
  return JSON.stringify({ bannerSeen, feedHas, mode: a.net.mode,
    visitors: (document.getElementById('visitors') || {}).outerHTML || '' });
})()`, true);
console.log('connTip:', connTip);
try {
  const c = JSON.parse(connTip);
  check('连上服务器只走顶部播报、不弹中央横幅（用户要求）', c.bannerSeen === false && c.feedHas === true, connTip);
  // 访客格在“刚连上”那一刻就该是新文案：以前它是 index.html 里的写死占位，且 setPresence 每秒才跑一次，
  // 所以打开页面后大约 1 秒会看到旧的「访客 1 单机」
  check('访客格显示「访客 N 鸡」、没有「单机」字样（含刚连上的瞬间）',
    /访客 <b>\d+<\/b> 鸡/.test(c.visitors || '') && !/单机/.test(c.visitors || ''),
    (c.visitors || '').slice(0, 90));
} catch { check('连上服务器只走顶部播报、不弹中央横幅（用户要求）', false, connTip); }

// ---- 断线时榜单必须**立刻**清成「只有你」----
// 这条重置之后不会再有快照来触发重绘：若被 500ms 节流吞掉，榜上会一直挂着别人的分数（2026-09-27 复查）
const dropReset = await evalJS(`(() => {
  const a = window.__farm, el = document.getElementById('board-rows'), board = document.getElementById('board');
  // ⚠ 必须展开再测：收起态 renderBoard 按设计只更新标题（不写行），那样测的是空气
  if (board.classList.contains('collapsed')) board.click();
  a.hud.updateBoard([{ id: 'me', name: '我（玩家）', score: 3, me: true }, { id: 4242, name: '别人', score: 9 }], true);
  const before = el.querySelectorAll('.row').length;
  a.net.emit('drop', true);                       // 同一 tick 内掉线 → 重置正好落在 500ms 窗口里
  const after = el.querySelectorAll('.row').length;
  const out = { collapsed: board.classList.contains('collapsed'), before, after, text: el.textContent.replace(/\\s+/g, ' ').trim().slice(0, 60) };
  board.click();                                  // 收起，别影响后面的用例
  return out;
})()`);
console.log('dropReset:', JSON.stringify(dropReset));
check('断线立刻把榜单清成「只有你」（不被 500ms 节流吞掉）',
  dropReset.before === 2 && dropReset.after === 1 && !/别人/.test(dropReset.text), JSON.stringify(dropReset));

// ---- 连不上服务端时：场上没有别的鸡（对齐原站——原站只有服务端一种形态）----
// 用打不通的端口当 ws，等服务端确认连不上后再看场上还剩什么
// 用打不通的端口当 ws，等服务端确认连不上后再看场上还剩什么（原 URL 可能本来就没有 ws 参数，所以要 set 而不是 replace）
await evalJS(`(() => { const u = new URL(location.href); u.searchParams.set('ws', 'ws://127.0.0.1:9'); location.href = u.href; return 1; })()`, true);
await sleep(9000);
const offline = await evalJS(`(() => {
  const a = window.__farm;
  const txt = document.body.innerText.replace(/\\s+/g, ' ');
  return JSON.stringify({ mode: a.net.mode, npcs: a.npcs.size,
    remotes: a.remotes ? a.remotes.size : 0,
    hasModeWord: /单机/.test(txt), visitor: (txt.match(/👤 访客 ?\\d+ ?\\S*/) || [''])[0] });
})()`);
console.log('offline:', offline);
try {
  const o = JSON.parse(offline);
  check('连不上游戏服时场上没有别的鸡（只剩自己的鸡，与原站一致）', o.mode !== 'online' && o.npcs === 0, offline);
  check('顶栏不再出现「单机」字样', o.hasModeWord === false, offline);
} catch { check('连不上游戏服时场上没有别的鸡', false, offline); }

console.log('\n--- 控制台输出 ---');
console.log(logs.slice(0, logsBeforeOffline).length ? logs.slice(0, 25).join('\n') : '(无错误/警告)');
// 控制台报错也当失败：删掉 HUD 元素却留着调用（hud.renderNetBoard is not a function）这类问题只在这里现形
const consoleErrors = logs.slice(0, logsBeforeOffline).filter((l) => /\[console\.error\]|Uncaught|TypeError|ReferenceError/.test(l)
  && !/WebSocket connection to .* failed/.test(l));   // 客户端只有联机一种形态，WS 连不上就是真问题
check('控制台没有 JS 报错', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | ') || '（干净）');
const fails = results.filter((r) => !r.ok);
console.log(`\n=== ${results.length - fails.length}/${results.length} 通过 ===`);
if (fails.length) console.log('失败项:\n' + fails.map((f) => ` - ${f.label} ${f.extra}`).join('\n'));

ws.close(); proc.kill();
await sleep(300);
process.exit(fails.length ? 1 : 0);
