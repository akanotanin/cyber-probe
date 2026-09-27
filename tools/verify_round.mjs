// 一次浏览器搞定三件事，避免多开（本机 Chrome 多开会把网关挤掉线）：
//   1) 拍一张场地全景
//   2) 拍一张带底部操作说明条的全景
//   3) 量 8 秒里每只鸡走了多少米（用户反馈"探针鸡/网站鸡在原地不动"）
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const URL_ = process.argv[2] || 'http://127.0.0.1:8899/chicken/?debug&ws=ws://127.0.0.1:28910';
const PREFIX = process.argv[3] || 'shots/verify';
const PORT = 9840 + Math.floor(Math.random() * 30);
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe'].find((p) => existsSync(p)) || 'chrome';
const proc = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, '--no-first-run', '--disable-gpu',
  '--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--hide-scrollbars', '--window-size=1440,900',
  '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
  '--user-data-dir=' + process.env.LOCALAPPDATA + '/Temp/gp' + PORT, 'about:blank'], { stdio: 'ignore' });

let id = 0; const pend = new Map();
async function conn() {
  for (let i = 0; i < 40; i++) {
    try { const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); const p = l.find((t) => t.type === 'page'); if (p) return p.webSocketDebuggerUrl; } catch { /* wait */ }
    await sleep(300);
  }
  throw new Error('no chrome');
}
const ws = new WebSocket(await conn());
await new Promise((r) => { ws.onopen = r; });
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (x, a = false) => {
  const r = await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: a });
  if (r.result?.exceptionDetails) return 'ERR ' + JSON.stringify(r.result.exceptionDetails).slice(0, 240);
  return r.result?.result?.value;
};
const shot = async (name) => {
  const s = await send('Page.captureScreenshot', { format: 'png' });
  mkdirSync('shots', { recursive: true });
  writeFileSync(`${PREFIX}-${name}.png`, Buffer.from(s.result.data, 'base64'));
  return `${PREFIX}-${name}.png`;
};

await send('Runtime.enable'); await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false });
await send('Page.navigate', { url: URL_ });
await send('Page.bringToFront').catch(() => {});
await sleep(7000);

// ---- 1) 走动统计（先量，别被后面挪相机影响）----
const walk = await ev(`(async () => {
  const a = window.__farm;
  const list = [...a.npcs.values()];
  const start = new Map(list.map(n => [n.id, { x: n.pos.x, z: n.pos.z }]));
  await new Promise(r => setTimeout(r, 8000));
  const rows = list.map(n => {
    const s = start.get(n.id);
    return { id: n.id, kind: n.kind, d: +Math.hypot(n.pos.x - s.x, n.pos.z - s.z).toFixed(2), remote: !!n.remote };
  }).sort((p, q) => p.d - q.d);
  const walked = rows.filter(r => r.d >= 1.5).length;
  return { total: rows.length, walked, min: rows[0], max: rows[rows.length - 1], remote: rows[0].remote };
})()`, true);
console.log('walk8s:', JSON.stringify(walk));

// ---- 2) 带底部说明条的全景 ----
console.log('shot:', await shot('field'));
console.log('hint:', await ev(`(() => { const h = document.getElementById('hint'); const r = h.getBoundingClientRect();
  return JSON.stringify({ text: h.textContent, cx: Math.round(r.left + r.width / 2), vw: innerWidth, bottom: Math.round(innerHeight - r.bottom),
    bg: getComputedStyle(h).backgroundColor }); })()`));

ws.close(); proc.kill(); process.exit(0);
