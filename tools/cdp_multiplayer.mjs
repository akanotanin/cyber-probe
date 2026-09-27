// 联机端到端自测：开**两个独立 Chrome 实例**（各一只鸡，甲、乙），互相啄，断言服务端裁定生效。
// 注意：同一个 Chrome 里开两个标签页时，非活动页会被浏览器暂停 rAF（主循环不动），
//       所以这里必须两个实例，每个页面都是"前台页"。
// 用法: node tools/cdp_multiplayer.mjs [基地址] [ws地址] [截图前缀]
import { spawn, spawnSync } from 'node:child_process';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const BASE = process.argv[2] || 'http://127.0.0.1:8899/chicken/?ws=ws://127.0.0.1:28910';
// ws 地址：不传 → 本地默认；传 '-' → 不带 ws 参数（走页面自带的 ./ws，用来测线上）
const WSS_ARG = process.argv[3];
const WSS = WSS_ARG === undefined ? 'ws://127.0.0.1:28910/' : (WSS_ARG === '-' ? '' : WSS_ARG);
const OUT = process.argv[4] || 'shots/mp';

// 预清理：Windows 上强杀 Chrome 主进程不会带走渲染进程，上一轮的 headless 实例会继续跑页面、
// 继续向联机服上报，变成占着玩家位的“幽灵”——测试就会打到幽灵身上（血量不掉、掉线断言失败）。
// 开工前按 profile 前缀清一遍，保证场上只有本轮这两只鸡。
if (process.platform === 'win32') {
  try {
    spawnSync('powershell', ['-NoProfile', '-Command',
      "Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | Where-Object { $_.CommandLine -like '*cdp-mp-*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"],
      { stdio: 'ignore', timeout: 25000 });
  } catch { /* 清不掉也继续，最多被幽灵干扰 */ }
  await sleep(1500);
}
const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
].find(existsSync);
if (!CHROME) { console.error('no chrome'); process.exit(1); }
mkdirSync('shots', { recursive: true });

const results = [];
function check(label, ok, extra = '') {
  results.push({ label, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? ' — ' + extra : ''}`);
}

/** 起一个独立 Chrome，开一个页面，返回操作句柄 */
async function launch(name, port) {
  const proc = spawn(CHROME, [
    '--headless=new', '--remote-debugging-port=' + port, '--remote-allow-origins=*',
    `--user-data-dir=${process.env.LOCALAPPDATA}/Temp/cdp-mp-${port}-${Date.now()}`, '--no-first-run',
    '--no-default-browser-check', '--enable-unsafe-swiftshader', '--use-angle=swiftshader',
    '--hide-scrollbars', '--window-size=1000,700', '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
  ], { stdio: 'ignore' });

  let wsUrl = null;
  for (let i = 0; i < 80 && !wsUrl; i++) {
    await sleep(300);
    try { wsUrl = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()).webSocketDebuggerUrl; } catch { }
  }
  if (!wsUrl) throw new Error('chrome 调试端口没起来 ' + port);
  const ws = new WebSocket(wsUrl);
  await new Promise((r) => ws.addEventListener('open', r));
  let id = 0;
  const pend = new Map();
  const errors = [];
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); return; }
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  });
  const send = (method, params = {}, sid = null) => {
    const msg = { id: ++id, method, params };
    if (sid) msg.sessionId = sid;
    ws.send(JSON.stringify(msg));
    return new Promise((r) => pend.set(msg.id, (m) => { if (m.error) errors.push(`${method}: ${JSON.stringify(m.error)}`); r(m); }));
  };
  const t = await send('Target.createTarget', { url: 'about:blank' });
  const sid = (await send('Target.attachToTarget', { targetId: t.result.targetId, flatten: true })).result.sessionId;
  await send('Runtime.enable', {}, sid);
  await send('Page.enable', {}, sid);
  await send('Network.enable', {}, sid);
  const netLog = [];
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (!m.method || !m.method.startsWith('Network.webSocket')) return;
    if (m.method === 'Network.webSocketCreated') netLog.push(`created ${m.params.url}`);
    else if (m.method === 'Network.webSocketWillSendHandshakeRequest') netLog.push('handshake → ' + JSON.stringify(m.params.request.headers).slice(0, 400));
    else if (m.method === 'Network.webSocketHandshakeResponseReceived') netLog.push(`handshake ${m.params.response.status} ${m.params.response.statusText}`);
    else if (m.method === 'Network.webSocketFrameError') netLog.push('frameError ' + m.params.errorMessage);
    else if (m.method === 'Network.webSocketClosed') netLog.push('closed');
  });
  const ev = async (expr, awaitPromise = false) => {
    // 带看门狗：页面万一被节流/渲染进程卡住，`awaitPromise` 会永远不 resolve（实测挂过两次）。
    // 宁可报一条明确的“页面无响应”，也不要整个测试静默卡死。注意：对战/啄击那几段 eval 自己最长跑 2~4 分钟，看门狗必须比它们宽。
    const r = await Promise.race([
      send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise }, sid),
      sleep(260000).then(() => ({ __timeout: true })),
    ]);
    if (r.__timeout) {
      errors.push('页面 260 秒没响应（可能被节流或渲染进程卡住）：' + String(expr).slice(0, 60));
      return { error: 'eval-timeout' };
    }
    if (r.result?.exceptionDetails) return { error: r.result.exceptionDetails.text + ' ' + (r.result.exceptionDetails.exception?.description || '') };
    return r.result?.result?.value;
  };
  const url = `${BASE}?debug&name=${encodeURIComponent(name)}` + (WSS ? `&ws=${encodeURIComponent(WSS)}` : '');
  await send('Page.navigate', { url }, sid);
  // headless 后台页会被节流（rAF/timer 变慢甚至停摆），交互前把页面唤醒并置前台
  try { await send('Page.bringToFront', {}, sid); } catch { /* 老版本没有这个命令 */ }
  try { await send('Page.setWebLifecycleState', { state: 'active' }, sid); } catch { /* 同上 */ }
  // 等页面 JS 起来（探针数据到位、window.__farm 挂上）。
  // 注意：页面**没有**进场遮罩了（用户要求删掉了 #intro / #btn-enter），别再点不存在的按钮。
  for (let i = 0; i < 60; i++) {
    const ready = await ev(`!!(window.__farm && window.__farm.mode)`);
    if (ready === true) break;
    await sleep(500);
  }
  return {
    name, ev, errors, proc, ws, netLog,
    shot: async (suffix) => {
      const r = await send('Page.captureScreenshot', { format: 'png' }, sid);
      const p = `shots/${OUT.replace(/^shots\//, '')}-${suffix}.png`;
      writeFileSync(p, Buffer.from(r.result.data, 'base64'));
      console.log('screenshot ->', p);
    },
    // 关掉这个客户端：先导航到空白页让 WS 正常收尾（等价于用户关标签页），再杀进程树。
    // 只 kill() 主进程在 Windows 上杀不掉渲染进程，页面会残留继续上报，服务端就永远不判它离线（踩过）。
    async close() {
      try { await send('Page.navigate', { url: 'about:blank' }, sid); } catch { /* 已经关了 */ }
      await sleep(600);
      try { ws.close(); } catch { /* 已关 */ }
      try { proc.kill(); } catch { /* 已退出 */ }
      if (process.platform === 'win32' && proc.pid) {
        try { spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* 已退出 */ }
      }
    },
  };
}

const A = await launch('甲鸡', 9413);
const B = await launch('乙鸡', 9415);

// 等两边都联机并互相看见
let sA, sB;
for (let i = 0; i < 40; i++) {
  sA = await A.ev(`({ mode: window.__farm.mode, id: window.__farm.net.id, remotes: window.__farm.remotes.size, visitors: document.getElementById('visitors').innerText, fps: +window.__farm.fps.toFixed(0), err: window.__farm.net.lastError, ws: window.__farm.net.ws ? window.__farm.net.ws.readyState : 'null' })`);
  sB = await B.ev(`({ mode: window.__farm.mode, id: window.__farm.net.id, remotes: window.__farm.remotes.size, visitors: document.getElementById('visitors').innerText, fps: +window.__farm.fps.toFixed(0), err: window.__farm.net.lastError, ws: window.__farm.net.ws ? window.__farm.net.ws.readyState : 'null' })`);
  if (sA?.mode === 'online' && sB?.mode === 'online' && sA.remotes === 1 && sB.remotes === 1
      && /2/.test(sA.visitors || '') && /2/.test(sB.visitors || '')) break;
  await sleep(700);
}
console.log('A:', JSON.stringify(sA), '\nB:', JSON.stringify(sB));
console.log('A 的 WS 网络事件:\n  ' + A.netLog.slice(0, 8).join('\n  '));
console.log('B 的 WS 网络事件:\n  ' + B.netLog.slice(0, 8).join('\n  '));
check('两个页面都读到了 window.__farm（?debug 生效、页面没卡在数据加载）',
  !sA?.error && !sB?.error, (sA?.error || sB?.error || '').slice(0, 120));
check('两边都进入联机模式', sA?.mode === 'online' && sB?.mode === 'online');
check('甲能看到乙、乙能看到甲（各自场景多出一只别人的鸡）', sA?.remotes === 1 && sB?.remotes === 1,
  `甲看到 ${sA?.remotes} / 乙看到 ${sB?.remotes}`);
// 顶栏格式已按原站改成「👤 访客 N 鸡」（不再有"联机/单机"字样）
check('顶栏「访客」= 2 只鸡（原站格式，没有模式字样）',
  /访客\s*2\s*鸡/.test(sA?.visitors || '') && !/联机|单机/.test(sA?.visitors || ''), sA?.visitors);
await A.shot('0-a');
await B.shot('0-b');

// ---- 两边看到的鸡位置一致（服务端权威；这条守着"看不见的鸡在打我"这类不同步）----
// ⚠ 先等两边**名单收敛**再比：网站鸡的名单是各自客户端按 ping 数据轮询出来的（每 4 秒轮一台、
//   9 个任务要 36 秒才轮完一圈），两个页面是先后启动的 —— 实测刚起来时甲 17 只、乙只有 8 只
//   （缺的全是网站鸡），这时候比"谁有几只"只会得到假红。
for (let i = 0; i < 60; i++) {
  const [cA, cB] = await Promise.all([A.ev('window.__farm.npcs.size'), B.ev('window.__farm.npcs.size')]);
  if (cA >= 15 && cB >= 15) break;
  if (i % 5 === 0) console.log(`  等名单收敛… 甲 ${cA} 只 / 乙 ${cB} 只`);
  await sleep(2000);
}
const nposExp = `(async () => {
  const a = window.__farm; const o = {};
  // 用模型位置（group.position）而不是逻辑坐标 pos：正是不动模型这个 bug 让"看不见的鸡"类问题漏过测试
  for (const n of a.npcs.values()) o[n.id] = { x: +n.group.position.x.toFixed(1), z: +n.group.position.z.toFixed(1) };
  return o;
})()`;
// ⚠ 两边必须**同时**取样：串行取（先 A 后 B）会隔着几百毫秒，鸡一直在走 —— 暴躁鸡追打/被欺负时
//   0.5 秒就能拉开 5m，于是"位置不一致"是假红（实测 t8 = 5.9m、n7 = 4.8m，串行取时必现）。
const [nposA, nposB] = await Promise.all([A.ev(nposExp, true), B.ev(nposExp, true)]);
// ⚠ 也不能要求"两个集合完全相等"：**网站鸡的名单是各自客户端按 ping 数据算出来的**
//   （每 4 秒轮一台 + 有"太旧就不算"的门槛），两边的轮询时刻不同 → 会短暂差 1~2 只。
//   这不是"看不见的鸡"，是各自算出来的名单；真正要守的是"两边都有的那些，位置必须对得上"。
const idsA = Object.keys(nposA || {}), idsB = Object.keys(nposB || {});
const shared = idsA.filter((id) => nposB && nposB[id]);
const onlyA = idsA.filter((id) => !(nposB && nposB[id]));
const onlyB = idsB.filter((id) => !(nposA && nposA[id]));
const ndiffs = shared.map((id) => ({ id, d: Math.hypot(nposA[id].x - nposB[id].x, nposA[id].z - nposB[id].z) }))
  .sort((a, b) => b.d - a.d);
console.log('npc pos diff:', JSON.stringify(ndiffs.slice(0, 3)),
  `共 ${shared.length} 只两边都有（甲 ${idsA.length} / 乙 ${idsB.length}；只有甲 ${onlyA.length} · 只有乙 ${onlyB.length}）`);
check('两边看到的探针鸡/网站鸡位置一致（服务端权威，不会出现"看不见的鸡"）',
  shared.length >= 14 && ndiffs[0].d <= 3.0 && onlyA.length <= 2 && onlyB.length <= 2,
  `最大差 ${ndiffs[0] ? ndiffs[0].d.toFixed(1) : '?'}m（${ndiffs[0] ? ndiffs[0].id : '?'}）· 两边都有 ${shared.length} 只 · 只有甲 ${onlyA.length} 只有乙 ${onlyB.length}`);

// 甲贴到乙旁边连啄（服务端按自己记录的位置 + 啄击里带的位置判定）
// 计分归服务端：把玩家分的变化读回来（场上没有第三方 NPC 抢最后一击）
// 乙也得先站起来：他在前面的测试里可能已被啄晕，血量为 0 开局的话这一轮一下就打完了（踩过）
await B.ev(`(async () => {
  const a = window.__farm;
  const t0 = performance.now();
  while (performance.now() - t0 < 15000 && (a.player.koT > 0 || a.player.hp <= 0)) await new Promise(r => setTimeout(r, 200));
  return Math.round(a.player.hp);
})()`, true);
// 分数系统已按用户要求整体删除：一条都不再打分，这里改为断言"分数真的不存在了"
const scoreGone = await A.ev(`({
  playerScore: window.__farm.player.score,
  playerServerScore: window.__farm.player.serverScore,
  remoteHasScore: [...window.__farm.remotes.values()].some((r) => 'score' in r),
  rosterSig: window.__farm.npcRosterSig || '',
  trophyInDom: /🏆/.test(document.body.innerText)
})`, false);
const fight = await A.ev(`(async () => {
  const A = window.__farm;
  const other = [...A.remotes.values()][0];
  if (!other) return { error: '看不到乙' };
  const seq = []; let ko = false, hits = 0;
  const t0 = performance.now();
  // 乙可能在前面的对抗里已经躺着了 —— 等它自己站起来，否则序列一开始就是 0，断言白红
  while (performance.now() - t0 < 20000 && (other.ko || other.hp <= 0)) await new Promise(r => setTimeout(r, 300));
  while (performance.now() - t0 < 120000 && !other.ko && hits < 30) {
    // 自己倒地时打不出伤害（服务端拒绝死人的啄击）：等复活再打，这段不算一遍
    const ta = performance.now();
    while (performance.now() - ta < 12000 && (A.player.koT > 0 || A.player.hp <= 0)) await new Promise(r => setTimeout(r, 150));
    const p = other.chicken.group.position;      // 每轮重新贴上去（对方也在动/插值在变）
    A.player.pos.set(p.x - 1.2, 0, p.z);
    A.player.yaw = Math.atan2(p.x - A.player.pos.x, p.z - A.player.pos.z);
    // ⚠ 先等 20Hz 的位置上报把"我在这"送到服务端：瞬移完立刻啄，服务端还按旧坐标做距离校验 → 白啄
    await new Promise(r => setTimeout(r, 200));
    A.doPeck();
    hits++;
    // 等这次啄击的冷却在"模拟时间"里走完再打下一发：headless 帧率低，固定 sleep 会大量漏击
    const tw = performance.now();
    while (A.peckCd > 0 && performance.now() - tw < 6000) await new Promise(r => setTimeout(r, 80));
    await new Promise(r => setTimeout(r, 150));
    seq.push(Math.round(other.hp));
    if (other.ko) ko = true;
  }
  return { seq, ko, hits, targetHp: Math.round(other.hp), name: other.name, myName: A.myName };
})()`, true);
console.log('fight:', JSON.stringify(fight));
check('甲的啄击经由服务端扣血（血量只能被服务端往下打）',
  Array.isArray(fight.seq) && fight.seq.length >= 2 && new Set(fight.seq).size >= 2 && Math.min(...fight.seq) === 0,
  `乙的血量序列 ${fight.seq}（起点可能已经掉过血，所以只要求"在掉 + 归零"）`);
check('服务端裁定把乙啄倒（倒地状态同步回甲这边）', fight.ko === true, `末次血量 ${fight.targetHp}`);
check('分数系统已整体删除（玩家/别的玩家都没有分数、名单不再上报分数、界面里没有奖杯）',
  !scoreGone.error                                    // ← 少了这条：页面读不到 __farm 时（全 undefined）会"空过"
  && scoreGone.playerScore === undefined && scoreGone.playerServerScore === undefined
  && !scoreGone.remoteHasScore && !/score/.test(scoreGone.rosterSig) && !scoreGone.trophyInDom,
  JSON.stringify(scoreGone).slice(0, 200));

const victim = await B.ev(`({ hp: window.__farm.player.hp, koT: +window.__farm.player.koT.toFixed(1),
  feed: document.getElementById('feed').innerText })`);
console.log('victim:', JSON.stringify(victim));
check('被啄的一方自己页面血量同步下降 / 被啄晕', victim.hp < 100 || victim.koT > 0, `hp=${victim.hp} koT=${victim.koT}`);
check('被啄方看到播报', /啄倒|被啄|晕/.test(victim.feed || '') || victim.koT > 0, (victim.feed || '').replace(/\n/g, ' / ').slice(0, 80));

await B.shot('1-victim');
await A.shot('2-attacker');

// 甲退出 → 乙这边应该清掉那只鸡
// 注意：服务端判掉线的规则是「40 秒没有位置上报」（被硬杀的浏览器不会发 FIN，socket 不会立刻关闭），
// 所以这里要轮询等过整个超时窗口，不能只 sleep 几秒（否则会误报成产品 bug）。
await A.close();
let after = { remotes: -1, visitors: '' };
for (let i = 0; i < 12; i++) {
  await sleep(1500);
  after = await B.ev(`({ remotes: window.__farm.remotes.size, visitors: document.getElementById('visitors').innerText })`);
  if (after.remotes === 0) break;
}
console.log('after A leaves:', JSON.stringify(after));
check('对方关掉页面后本地会清掉那只鸡', after.remotes === 0, `剩 ${after.remotes} 只，顶栏 ${after.visitors}`);
B.close();

console.log('\n--- 页面异常 ---');
console.log([...A.errors, ...B.errors].slice(0, 10).join('\n') || '(无)');
const fails = results.filter((r) => !r.ok);
console.log(`\n=== ${results.length - fails.length}/${results.length} 通过 ===`);
if (fails.length) console.log('失败：' + fails.map((f) => f.label).join('，'));
await sleep(300);
process.exit(fails.length ? 1 : 0);
