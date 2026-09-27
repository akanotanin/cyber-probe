// 验收 hub 公开页顶栏的 cyber-probe 入口：位置、尺寸、样式是否与相邻的扳手完全一致，
// 图标是不是那只鸡，点在不在正确的链接上，暗色下是否跟着变色。
// 用法: node tools/verify_hub_entry.mjs [url] [outPrefix]
import { spawn } from 'node:child_process';
import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const URL_ = process.argv[2] || '';
if (!URL_) {
  console.error('用法: node tools/verify_hub_entry.mjs <你的 hub 首页 URL> [截图目录]');
  console.error('例：  node tools/verify_hub_entry.mjs https://hub.example.com shots/hub-entry');
  process.exit(2);
}
const PREFIX = process.argv[3] || 'shots/hub-entry';
const PORT = 9510 + Math.floor(Math.random() * 30);
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe']
  .find((p) => existsSync(p)) || 'chrome';

const proc = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, '--no-first-run', '--no-default-browser-check',
  '--disable-gpu', '--hide-scrollbars', '--window-size=1440,900',
  '--user-data-dir=' + process.env.LOCALAPPDATA + '/Temp/hubent' + PORT, 'about:blank',
], { stdio: 'ignore' });

let id = 0; const pend = new Map();
async function connect() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === 'page');
      if (page) return page.webSocketDebuggerUrl;
    } catch { /* 还没起来 */ }
    await sleep(300);
  }
  throw new Error('Chrome 没起来');
}
const ws = new WebSocket(await connect());
await new Promise((r) => { ws.onopen = r; });
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const evalJS = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) return 'ERR:' + JSON.stringify(r.result.exceptionDetails).slice(0, 200);
  return r.result?.result?.value;
};

let pass = 0, fail = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`); ok ? pass++ : fail++; };

await send('Runtime.enable'); await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: URL_ });
await sleep(7000);

// 1) 入口存在
const info = await evalJS(`(() => {
  const header = document.querySelector('header') || document.body;
  const farm = header.querySelector('a[href="/chicken/"]');
  const wrench = header.querySelector('a[href="/admin/"]');
  if (!farm || !wrench) return JSON.stringify({ farm: !!farm, wrench: !!wrench });
  const f = farm.getBoundingClientRect(), w = wrench.getBoundingClientRect();
  const cs = getComputedStyle(farm), cw = getComputedStyle(wrench);
  const svg = farm.querySelector('svg');
  const sib = [...header.querySelectorAll('a,button')].filter(e => {
    const r = e.getBoundingClientRect(); return r.width > 0;
  }).map(e => e.tagName + ':' + (e.getAttribute('href') || e.getAttribute('title') || '?'));
  return JSON.stringify({
    farm: { x: Math.round(f.x), y: Math.round(f.y), w: Math.round(f.width), h: Math.round(f.height),
            title: farm.getAttribute('title'), tag: farm.tagName,
            cls: (farm.className || '').toString(), radius: cs.borderRadius, pad: cs.padding,
            color: cs.color, font: cs.fontSize, text: (farm.textContent || '').trim() },
    wrench: { x: Math.round(w.x), y: Math.round(w.y), w: Math.round(w.width), h: Math.round(w.height),
              cls: (wrench.className || '').toString(), radius: cw.borderRadius, pad: cw.padding, color: cw.color },
    gap: Math.round(f.x - (w.x + w.width)),
    strokeW: svg ? getComputedStyle(svg).strokeWidth : null,
    paths: svg ? svg.querySelectorAll('path,circle,ellipse,line').length : 0,
    svgSame: svg ? svg.outerHTML.replace(/\\s+/g, ' ').slice(0, 60) : null,
    order: sib,
  });
})()`);
console.log('入口信息:', info);
let d = {};
try { d = JSON.parse(info); } catch { /* 上面会打印 */ }
check('顶栏出现 cyber-probe 入口', !!d.farm, d.farm ? `href=/chicken/ title=${d.farm.title}` : '没找到');
if (d.farm && d.wrench) {
  check('尺寸与扳手一致（36×36 那类方形按钮）', d.farm.w === d.wrench.w && d.farm.h === d.wrench.h,
    `farm ${d.farm.w}×${d.farm.h} / wrench ${d.wrench.w}×${d.wrench.h}`);
  check('圆角/内边距/配色与扳手一致', d.farm.radius === d.wrench.radius && d.farm.pad === d.wrench.pad && d.farm.color === d.wrench.color,
    `radius ${d.farm.radius} vs ${d.wrench.radius} · pad ${d.farm.pad} vs ${d.wrench.pad} · color ${d.farm.color} vs ${d.wrench.color}`);
  check('class 与扳手完全一致（继承同一套样式）', d.farm.cls === d.wrench.cls, d.farm.cls.slice(0, 80));
  check('紧贴扳手右侧、与月亮同间距（12px 量级）', d.gap >= 8 && d.gap <= 20 && d.farm.y === d.wrench.y, `gap=${d.gap}px, y ${d.farm.y} vs ${d.wrench.y}`);
  check('图标是线性描边（stroke-width 2、7 条路径）', String(d.strokeW) === '2px' && d.paths === 7, `stroke=${d.strokeW} paths=${d.paths}`);
  check('按钮不带文字（与相邻图标一致）', d.farm.text === '', JSON.stringify(d.farm.text));
  const oi = d.order.indexOf('A:/admin/');
  check('顶栏顺序 = 扳手 → cyber-probe → 月亮（紧邻扳手之后）', oi >= 0 && d.order[oi + 1] === 'A:/chicken/', JSON.stringify(d.order));
  check('有可读的 title（悬停提示）', /cyber-probe/.test(d.farm.title || ''), d.farm.title);
}

// 2) 截图：顶栏右侧局部（把按钮放大看清）
mkdirSync(dirname(PREFIX), { recursive: true });
let shot = await send('Page.captureScreenshot', { format: 'png' });
writeFileSync(PREFIX + '-full.png', Buffer.from(shot.result.data, 'base64'));
shot = await send('Page.captureScreenshot', { format: 'png', clip: { x: 1160, y: 0, width: 280, height: 62, scale: 3 } });
writeFileSync(PREFIX + '-zoom.png', Buffer.from(shot.result.data, 'base64'));

// 3) 暗色
await evalJS(`document.documentElement.classList.add('dark')`);
await sleep(1200);
const dark = await evalJS(`(() => {
  const a = document.querySelector('a[href="/chicken/"]');
  const w = document.querySelector('a[href="/admin/"]');
  return JSON.stringify({ farm: getComputedStyle(a).color, wrench: getComputedStyle(w).color,
    same: getComputedStyle(a).color === getComputedStyle(w).color });
})()`);
console.log('暗色:', dark);
try { check('暗色下跟随主题变色（与扳手同色）', JSON.parse(dark).same, dark); } catch { check('暗色下跟随主题变色（与扳手同色）', false, dark); }
shot = await send('Page.captureScreenshot', { format: 'png', clip: { x: 1160, y: 0, width: 280, height: 62, scale: 3 } });
writeFileSync(PREFIX + '-zoom-dark.png', Buffer.from(shot.result.data, 'base64'));

// 4) 点进去真的到 cyber-probe
await evalJS(`document.documentElement.classList.remove('dark')`);
await sleep(500);
const nav = await evalJS(`(() => {
  const a = document.querySelector('a[href="/chicken/"]');
  a.click(); return 'clicked';
})()`);
await sleep(7000);
const after = await evalJS(`JSON.stringify({ url: location.href, hasCanvas: !!document.querySelector('canvas'),
  title: document.title, npcs: (window.__farm && window.__farm.npcs) ? window.__farm.npcs.size : null })`);
console.log('点击后:', nav, after);
try {
  const a = JSON.parse(after);
  check('点击后进入 cyber-probe（URL + 有 3D 画布）', /\/chicken\/?/.test(a.url) && a.hasCanvas, after);
} catch { check('点击后进入 cyber-probe（URL + 有 3D 画布）', false, after); }
shot = await send('Page.captureScreenshot', { format: 'png' });
writeFileSync(PREFIX + '-after-click.png', Buffer.from(shot.result.data, 'base64'));

// 5) 手机窄屏：顶栏若折叠了就说明脚本按预期没插（不硬塞）
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await send('Page.navigate', { url: URL_ });
await sleep(7000);
const mob = await evalJS(`(() => {
  const header = document.querySelector('header') || document.body;
  const farm = header.querySelector('a[href="/chicken/"]');
  const wrench = header.querySelector('a[href="/admin/"]');
  const r = farm && farm.getBoundingClientRect();
  return JSON.stringify({ wrenchInDom: !!wrench, wrenchVisible: !!(wrench && wrench.getBoundingClientRect().width),
    farmInDom: !!farm, farmVisible: !!r && r.width > 0, box: r ? [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)] : null });
})()`);
console.log('手机窄屏:', mob);
try {
  const m = JSON.parse(mob);
  check('窄屏下入口不缺位（凡显示扳手就同时显示 cyber-probe）', m.wrenchVisible === m.farmVisible, mob);
  check('窄屏按钮尺寸仍是 36×36 量级', !m.farmVisible || (m.box[2] >= 28 && m.box[2] <= 44), JSON.stringify(m.box));
} catch { check('窄屏下入口不缺位', false, mob); }
const mshot = await send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: 390, height: 90, scale: 3 } });
writeFileSync(PREFIX + '-mobile.png', Buffer.from(mshot.result.data, 'base64'));

console.log(`=== ${pass}/${pass + fail} ===`);
ws.close(); proc.kill();
process.exit(fail ? 1 : 0);
