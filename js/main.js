// 总装：渲染器、第三人称操控、输入（鼠标/键盘/触屏）、NPC 数据绑定、主循环
import * as THREE from 'three';
import { Farm, CONF } from './data.js';
import { buildScene, resolveCollision, BOUNDS, groundHeight } from './world.js';
import { Chicken } from './chicken.js';
import { Npc } from './npc.js';
import { Goose, GOOSE } from './goose.js';
import { Dog, DOG } from './dog.js';
import { Hud } from './hud.js';
import { Net } from './net.js';
import { Feathers, Dust } from './feathers.js';
import { Sfx } from './sfx.js';
import { decorate } from './models.js';
import * as CFG from './config.js';

const $ = (id) => document.getElementById(id);
// 触屏笔记本的 Chrome/Edge 也常暴露 ontouchstart（但主指针仍是鼠标）：
// 不能只看这个属性，否则 W/A/S/D 会被当成触屏模式禁用（2026-11-04 复审）。
const isTouch = matchMedia('(pointer: coarse)').matches
  || (matchMedia('(hover: none)').matches && 'ontouchstart' in window);

// 站名：config.js 里带了本站自己的名字就换上（安装时 --site-name 给），没带就保留 index.html 的默认名。
// 这样公开仓库/发布包里不会有任何人的站名（和探测清单的隐私约定同一个思路）。
// ⚠ 用命名空间导入：`import { SITE_NAME }` 在**旧的 config.js（还没这一项）**上会直接抛
//   SyntaxError「does not provide an export named」→ 整个页面白屏。缺项也要能活。
if (CFG.SITE_NAME) document.title = CFG.SITE_NAME;

// ---------- 渲染 ----------
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(2, devicePixelRatio || 1));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
$('app').appendChild(renderer.domElement);
const canvas = renderer.domElement;

const world = buildScene(renderer);
const { scene, camera } = world;

// 光照预设：?light=dusk 直接进黄昏；按 L 在「白天 / 黄昏」之间切（纯观感，不影响任何判定）
let lightMode = new URLSearchParams(location.search).get('light') === 'dusk' ? 'dusk' : 'day';
world.setLighting(lightMode);

const feathers = new Feathers(scene);   // 被啄掉毛的羽毛粒子池
const dust = new Dust(scene);           // 扇翅 / 落地扬尘
const sfx = new Sfx();                  // WebAudio 合成音效（首次点击/按键时才启动）

const farm = new Farm();
const hud = new Hud(farm);
// 管理后台入口：前端不假设「这站一定挂在 monitor hub 上」—— 探测一次同域 /admin，
// 404 就把它藏掉（挂到没有后台的站点上时别给人一个死链）；403/401 说明后台在、只是不让进，照常显示。
(async () => {
  const a = $('plist-admin');
  if (!a) return;
  try {
    const r = await fetch(a.getAttribute('href'), { method: 'HEAD', cache: 'no-store' });
    if (r.status === 404) a.classList.add('hidden');
  } catch { /* 探测失败就保留：多半是网络问题，不代表没有后台 */ }
})();
const net = new Net(new URLSearchParams(location.search).get('ws') || './ws');
const remotes = new Map();       // 联机时其他玩家: id -> {chicken, buf, name, hp, score, ko}

// 你的鸡名：?name= > 每次进来随机（原站那样随机一只；不再记 localStorage，否则永远是同一只）
const myName = (() => {
  const q = new URLSearchParams(location.search).get('name');
  const a = ['咕咕', '黄焖', '咖喱', '椒盐', '照烧', '白斩', '盐焗', '芝士', '奥尔良', '三杯'];
  const b = ['小鸡', '战斗鸡', '大公鸡', '仔鸡', '柴鸡', '土鸡'];
  const rand = a[Math.floor(Math.random() * a.length)] + b[Math.floor(Math.random() * b.length)];
  const name = String(q || rand).replace(/[<>\r\n]/g, '').slice(0, 10) || rand;
  return name;
})();
// 你的羽色也随机（和名字一样每次进来随机一只，跟原站一致）；上报给服务端，别人看到的也是这套
const myColorIdx = Math.floor(Math.random() * 5);

// 你的国旗 = 你这个访客 IP 的所在地。服务端走 Cloudflare 的 CF-IPCountry 拿（welcome/cc 里下发）；
// 拿不到时（本地自测、直连回源 IP 访问）可以用 ?cc=JP 自报一个 —— 纯外观，不参与任何判定。
let myCc = (() => {
  const q = String(new URLSearchParams(location.search).get('cc') || '').toUpperCase();
  return /^[A-Z]{2}$/.test(q) ? q : '';
})();

// 访客鸡的出生点：**随机**（用户要求。以前是所有人都在 (3,12) 那一个点冒出来）
function randomSpawn() {
  for (let i = 0; i < 12; i++) {
    const ang = Math.random() * Math.PI * 2, rad = 5 + Math.random() * 13;
    const x = Math.cos(ang) * rad, z = Math.sin(ang) * rad;
    const [cx, cz] = resolveCollision(x, z, 0.45, world.obstacles, world.boxObstacles);
    if (Math.hypot(cx - x, cz - z) < 0.5) return { x: cx, z: cz };    // 没被障碍顶开 → 是个空位
  }
  return { x: (Math.random() - 0.5) * (BOUNDS - 4) * 2, z: (Math.random() - 0.5) * (BOUNDS - 4) * 2 };
}
const spawn0 = randomSpawn();

// ---------- 玩家 ----------
const player = {
  pos: new THREE.Vector3(spawn0.x, groundHeight(spawn0.x, spawn0.z), spawn0.z),
  vy: 0, yaw: Math.random() * Math.PI * 2,
  hp: 100, koT: 0, score: 0,
  // 血量/倒地/啄倒数都只由服务端裁定（对齐原站：这里不再有本地结算分支）
};
function syncPlayerPlate() {
  hud.setSelfState(player.hp, player.koT, player.score);
  playerChicken.setHp(player.hp);
  playerChicken.setInfo({ title: myName, code: myCc || '🐔' });
}

const playerChicken = new Chicken({ colorIdx: myColorIdx, kind: 'player' });   // 每次进来随机一套羽色
playerChicken.group.position.copy(player.pos);
scene.add(playerChicken.group);
hud.bindPlayer(playerChicken);
hud.setMe(myName);
hud.updateBoard([{ id: 'me', name: `${myName}（玩家）`, score: 0, me: true }]);   // 连上之前榜上先只有你
syncPlayerPlate();

// ---------- 相机 ----------
let camYaw = Math.PI, camPitch = 0.42, camDist = 5;
const camTarget = new THREE.Vector3();
const _camWant = new THREE.Vector3();
let camDistCur = camDist;          // 实际机位距离（遇到障碍会被推近，松开再慢慢拉回）
let camPitchEff = camPitch;        // 实际俯角（相机辅助会把镜头抬到障碍上方，之后慢慢落回玩家设定的角度）
let camBoxStamp = -1;              // 遮挡体是按哪一版模型量的（换装完成会变）
let camBlockers = [];              // 相机遮挡盒：[minx,miny,minz,maxx,maxy,maxz]，重建于换装前后各一次

// 相机遮挡体从**场景网格实际包围盒**里取：精细模型通常比碰撞盒更大更高
// （鸡舍碰撞盒 5.6×3.6×5.2，模型却是 5.8×4.5×5.8 —— 只按碰撞盒扫，镜头会钻进屋顶）。
// 太大的网格（地面、天空、合并后的树）跳过，那些由 boxObstacles 兜底；太矮的（围栏）两边都不算。
function rebuildCamBlockers() {
  camBlockers = [];
  const bb = new THREE.Box3(), sz = new THREE.Vector3();
  scene.traverse((o) => {
    if (!o.isMesh || !o.geometry || !o.visible) return;
    if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
    o.geometry.boundingBox.getSize(sz);
    // 只认"够高够宽"的：木桶/木箱/干草卷这类小件不进列表 —— 走过它们时镜头会被反复推拉，
    // 而它们本身挡住镜头也不明显（相机在 2~4m 高）。地面/天空（超大网格）也跳过。
    if (sz.y < 1.7 || sz.x > 30 || sz.z > 30) return;
    if (Math.max(sz.x, sz.z) < 1.2) return;
    bb.setFromObject(o);
    // 记下"根节点"：polyfork 的模型是 Group（鸡舍=一面墙一个 mesh），只淡一片墙很奇怪，
    // 所以整组一起淡。根 = scene 的直接子节点。
    let root = o;
    while (root.parent && root.parent !== scene) root = root.parent;
    camBlockers.push([bb.min.x, bb.min.y, bb.min.z, bb.max.x, bb.max.y, bb.max.z, root]);
  });
  // 碰撞盒只补"没被任何模型盒覆盖"的部分：鸡舍/草料棚这些既有模型盒又有碰撞盒，
  // 两份都留的话离得稍近的那份会抢到命中，`root=null` 就退化成"拉近镜头"——正是要避免的那种跳。
  for (const o of world.boxObstacles) {
    if (o.h < 1.2) continue;
    const covered = camBlockers.some((b) => b[6]
      && o.x > b[0] - 0.4 && o.x < b[3] + 0.4 && o.z > b[2] - 0.4 && o.z < b[5] + 0.4);
    if (covered) continue;
    const gy = groundHeight(o.x, o.z);
    camBlockers.push([o.x - o.hx, gy - 0.2, o.z - o.hz, o.x + o.hx, gy + o.h, o.z + o.hz, null]);
  }
}

// 挡住视线的模型：不挪镜头，改成**半透明**（0.25）。这样走路时视野一点都不会跳，
// 只有"合批网格/围栏"这种没法单独淡出的，才退回把机位拉近。
const _faded = new Map();          // root -> { orig: Map<mesh, material>, now: number, want: number }
const FADE_MIN = 0.25, FADE_RATE = 6;
function fadeRoot(root, want) {
  let e = _faded.get(root);
  if (!e) {
    e = { orig: new Map(), now: 1, want: 1 };
    root.traverse((m) => {
      if (!m.isMesh || !m.material) return;
      const orig = m.material;
      const clone = orig.clone();
      clone.transparent = true;
      clone.opacity = 1;
      clone.depthWrite = true;
      m.material = clone;
      e.orig.set(m, orig);
    });
    _faded.set(root, e);
  }
  e.want = want;
  return e;
}
function updateFades(dt, keep) {
  for (const [root, e] of _faded) {
    if (keep !== root && e.want !== 1) e.want = 1;
    e.now += (e.want - e.now) * Math.min(1, dt * FADE_RATE);
    if (Math.abs(e.now - e.want) < 0.01) e.now = e.want;
    for (const [m, orig] of e.orig) {
      if (!m.material) continue;
      m.material.opacity = e.now;
      // 半透明时别写深度，否则自己内部会互相挡出硬边
      m.material.depthWrite = e.now > 0.98;
    }
    if (e.now === 1 && e.want === 1) {
      for (const [m, orig] of e.orig) m.material = orig;   // 恢复原材质（不留下半透明状态）
      _faded.delete(root);
    }
  }
}

// 从注视点朝机位扫一条线段，命中的第一块遮挡就把机位拉到它前面。
// 返回 0~1：1 = 一路畅通，<1 = 在 wantDist 的这个比例处就撞上了。
let camHitRoot = null;             // 这一帧挡在镜头前的那个"根"（能淡出就淡出，不能才拉近）
function camSweep(ox, oy, oz, dx, dy, dz) {
  let tmin = 1;
  camHitRoot = null;
  for (const b of camBlockers) {
    const p = [ox, oy, oz], d = [dx, dy, dz];
    const mn = [b[0] - 0.22, b[1], b[2] - 0.22];
    const mx = [b[3] + 0.22, b[4] + 0.25, b[5] + 0.22];   // 屋顶边缘给一点余量
    let t0 = 0, t1 = 1, ok = true;
    for (let i = 0; i < 3; i++) {
      if (Math.abs(d[i]) < 1e-6) { if (p[i] < mn[i] || p[i] > mx[i]) { ok = false; break; } continue; }
      let a = (mn[i] - p[i]) / d[i], b2 = (mx[i] - p[i]) / d[i];
      if (a > b2) { const t = a; a = b2; b2 = t; }
      if (a > t0) t0 = a;
      if (b2 < t1) t1 = b2;
      if (t0 > t1) { ok = false; break; }
    }
    if (ok && t0 > 0.02 && t0 < tmin) { tmin = t0; camHitRoot = b[6] || null; }
  }
  return tmin;
}
const _tmpV = new THREE.Vector3();

// ---------- 输入 ----------
const keys = Object.create(null);
let locked = false;
let dragging = false, dragMoved = 0, lastX = 0, lastY = 0;
const move = { x: 0, y: 0, run: false };

addEventListener('keydown', (e) => {
  // 悬浮层开着时 Esc 先关它（再按一次才轮到浏览器的指针解锁/其它行为）
  // 悬浮层打开时 Esc：详情 → 回列表，列表 → 关面板（Tab 是直接开关）
  if (e.code === 'Escape' && hud.probesOpen) { hud.escProbes(); return; }
  // Tab：探针列表（列表、服务器详情、管理后台都在这个面板里）
  // ⚠ 站长要的是「按 Tab 就显示悬浮层」，所以面板开着时也照旧 toggle（关闭靠 Esc / ✕）。
  //   代价是面板内不能靠 Tab 走焦点（键盘可达性的取舍，子代理审查提过，这里按站长口径保留）。
  if (e.code === 'Tab') { e.preventDefault(); hud.toggleProbes(); }
  // ⚠ 面板开着时不要先写 keys：以前 keys[e.code]=true 在 return 之前，WASD 会在面板
  //   背后继续移动；开面板时按下的键也不会被后续 keyup 清掉（子代理复审）。
  if (hud.probesOpen && e.code !== 'KeyM') {
    if (e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault();
    return;
  }
  keys[e.code] = true;
  // 空格/方向键的默认行为压掉：点过 🖥 之后焦点还在按钮上，空格会在 keyup 补一次 click（把面板关掉）
  if (e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault();
  if (e.code === 'KeyM') hud.banner(sfx.toggleMute() ? '🔇 已静音' : '🔊 声音开启', 900);
  if (e.code === 'KeyF') doPeck();
  if (e.code === 'KeyL') {
    lightMode = lightMode === 'day' ? 'dusk' : 'day';
    world.setLighting(lightMode);
    hud.banner(lightMode === 'dusk' ? '🌇 黄昏' : '☀️ 白天', 900);
  }
});
// 浏览器要求音频在用户手势里启动
const initAudio = () => sfx.init();
addEventListener('pointerdown', initAudio, { once: true });
addEventListener('keydown', initAudio, { once: true });
addEventListener('keyup', (e) => { keys[e.code] = false; });
addEventListener('blur', () => { for (const k in keys) keys[k] = false; });

canvas.addEventListener('mousedown', (e) => {
  if (!locked) {
    // 未锁定指针时：鼠标点 = 选中（鸡/抽屉），点空地 = 锁定指针开始玩
    if (e.button === 0 && !tapSelect(e.clientX, e.clientY)) lockPointer();
    return;
  }
  if (e.button === 0) doPeck();
  else if (e.button === 2) doWing();
});
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
document.addEventListener('pointerlockchange', () => {
  locked = document.pointerLockElement === canvas;
});
addEventListener('mousemove', (e) => {
  if (locked) {
    camYaw -= e.movementX * 0.0026;
    camPitch = Math.min(1.25, Math.max(0.06, camPitch + e.movementY * 0.0022));
  } else if (dragging) {
    dragMoved += Math.abs(e.clientX - lastX) + Math.abs(e.clientY - lastY);
    camYaw -= (e.clientX - lastX) * 0.005;
    camPitch = Math.min(1.25, Math.max(0.06, camPitch + (e.clientY - lastY) * 0.004));
    lastX = e.clientX; lastY = e.clientY;
  }
});
canvas.addEventListener('mousedown', (e) => { if (!locked && e.button === 2) { dragging = true; lastX = e.clientX; lastY = e.clientY; } });
addEventListener('mouseup', () => { dragging = false; });
// 滚轮：面板里是滚详情（不该顺手把相机缩放也改了）—— 目标是 #plist 里的内容就直接放过
addEventListener('wheel', (e) => {
  if (e.target?.closest?.('#plist')) return;
  camDist = Math.min(9, Math.max(2.4, camDist * (1 + e.deltaY * 0.001)));
}, { passive: true });

// 触屏：左摇杆 / 空白处拖动转视角 / 轻点鸡开详情 / 双指缩放 / 下拉关抽屉
if (isTouch) {
  document.body.classList.add('touch');
  $('touch').classList.remove('hidden');
  const stick = $('stick'), knob = $('stick-knob');
  let stickId = null, runOn = false;
  let tap = null;                     // {id, x0,y0, px,py, t0, moved, mode:'tap'|'look'}
  const pinch = { active: false, dist: 0 };
  const TAP_MOVE = 15, TAP_MS = 400;

  const setStick = (t) => {
    const r = stick.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    let dx = (t.clientX - cx) / (r.width / 2), dy = (t.clientY - cy) / (r.height / 2);
    const d = Math.hypot(dx, dy);
    if (d > 1) { dx /= d; dy /= d; }
    move.x = dx; move.y = dy;
    knob.style.transform = `translate(${dx * 34}px,${dy * 34}px)`;
  };
  const inStick = (t) => {
    const r = stick.getBoundingClientRect();
    return t.clientX >= r.left - 26 && t.clientX <= r.right + 26 && t.clientY >= r.top - 34 && t.clientY <= r.bottom + 26;
  };
  // HUD 里的可交互/信息卡（#topbar/#board/#me/#hint/#feed/#banner）在 CSS 里给了
  // pointer-events:auto，事件 target 会落在 #hud 内；用 #hud 一把覆盖，别再逐个列 ID
  // （以前列的 #topbar 等 pointer-events:none，target 永远是 canvas，永远匹配不到）。
  const hudHit = (t) => t.target?.closest?.('#hud, #errbar, #plist');

  stick.addEventListener('touchstart', (e) => { stickId = e.changedTouches[0].identifier; setStick(e.changedTouches[0]); e.preventDefault(); }, { passive: false });

  addEventListener('touchstart', (e) => {
    if (e.target?.closest?.('#plist')) return;      // 面板里的手势归面板（滚动/点击），不转视角、不缩放
    if (e.touches.length >= 2) return startPinch(e.touches);
    const t = e.changedTouches[0];
    if (stickId !== null || inStick(t) || hudHit(t)) return;
    tap = { id: t.identifier, x0: t.clientX, y0: t.clientY, px: t.clientX, py: t.clientY, t0: performance.now(), moved: 0, mode: 'tap' };
  }, { passive: true });

  const startPinch = (touches) => {
    if (touches.length < 2) return;
    pinch.active = true;
    pinch.dist = Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY);
    tap = null;
  };

  addEventListener('touchmove', (e) => {
    if (pinch.active) {
      const [a, b] = e.touches;
      if (a && b) {
        const d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
        if (pinch.dist > 0 && d > 0) camDist = Math.min(9, Math.max(2.4, camDist * (pinch.dist / d)));
        pinch.dist = d;
        e.preventDefault();
      }
      return;
    }
    for (const t of e.changedTouches) {
      if (t.identifier === stickId) { setStick(t); e.preventDefault(); continue; }
      if (!tap || t.identifier !== tap.id) continue;
      const dx = t.clientX - tap.px, dy = t.clientY - tap.py;
      tap.moved += Math.hypot(dx, dy);
      if (tap.mode === 'tap' && tap.moved > TAP_MOVE) tap.mode = 'look';   // 手一动就转视角，不算点击
      if (tap.mode === 'look') {
        camYaw -= dx * 0.006;
        camPitch = Math.min(1.25, Math.max(0.06, camPitch + dy * 0.005));
        e.preventDefault();
      }
      tap.px = t.clientX; tap.py = t.clientY;
    }
  }, { passive: false });

  const endTouch = (e) => {
    if (pinch.active && e.touches.length < 2) { pinch.active = false; pinch.dist = 0; }
    for (const t of e.changedTouches) {
      if (t.identifier === stickId) { stickId = null; move.x = move.y = 0; knob.style.transform = ''; }
      if (tap && t.identifier === tap.id) {
        const held = performance.now() - tap.t0;
        if (tap.mode === 'tap' && tap.moved <= TAP_MOVE && held < TAP_MS) tapSelect(tap.x0, tap.y0);
        tap = null;
      }
    }
  };
  addEventListener('touchend', endTouch);
  addEventListener('touchcancel', endTouch);

  $('t-peck').addEventListener('touchstart', (e) => { doPeck(); e.preventDefault(); }, { passive: false });
  $('t-jump').addEventListener('touchstart', (e) => { doJump(); e.preventDefault(); }, { passive: false });
  $('t-run').addEventListener('touchstart', (e) => {
    runOn = !runOn; move.run = runOn;
    $('t-run').classList.toggle('on', runOn);
    e.preventDefault();
  }, { passive: false });
}

function lockPointer() {
  try {
    const p = canvas.requestPointerLock?.();
    if (p && typeof p.catch === 'function') p.catch(() => {});
  } catch { /* 某些环境（无用户手势/headless）会拒绝，忽略即可 */ }
}

function doJump() {
  if (player.koT > 0) return;
  if (player.pos.y <= groundHeight(player.pos.x, player.pos.z) + 0.01) {
    player.vy = 6.2;
    playerChicken.flap();
  }
}
function doPeck() {
  if (player.koT > 0 || peckCd > 0) return;
  peckCd = 0.5;                       // 啄击间隔（与参考站/服务端一致），防手速党一键清场
  playerChicken.peck();
  sfx.peck();
  if (net.online) {
    // 把自己的位置随啄击一起发过去：移动是客户端权威的，服务端据此判定范围/朝向
    net.send({ t: 'peck', x: +player.pos.x.toFixed(2), z: +player.pos.z.toFixed(2), yaw: +player.yaw.toFixed(3) });
  }
  const fx = Math.sin(player.yaw), fz = Math.cos(player.yaw);
  // 只做表演（羽毛/音效）：伤害、倒地、记分全部由服务端裁定（原站同款）
  for (const npc of npcs.values()) {
    if (npc.chicken.koT > 0) continue;
    const dx = npc.pos.x - player.pos.x, dz = npc.pos.z - player.pos.z;
    const d = Math.hypot(dx, dz);
    if (d > 1.7) continue;
    const dot = (dx / (d || 1)) * fx + (dz / (d || 1)) * fz;
    if (dot < 0.35) continue;                        // 只啄正前方 ~110°
    feathers.burst(npc.chicken.group.position, 8, npc.chicken.pal?.body ?? 0xffffff);
    sfx.hit(d);
  }
}

// 扇翅：范围更短但无方向限制，伤害低、击退强（把人/鸡推开）
function doWing() {
  if (player.koT > 0 || wingCd > 0) return;
  wingCd = 0.8;
  playerChicken.flap();
  sfx.flap();
  dust.puff(player.pos, 9, 1);          // 扇翅扬起一圈土
  if (net.online) {
    net.send({ t: 'wing', x: +player.pos.x.toFixed(2), z: +player.pos.z.toFixed(2), yaw: +player.yaw.toFixed(3) });
  }
  // 同上：只做羽毛/音效表演，击退与伤害都由服务端裁定（本地自己推会和权威打架）
  for (const npc of npcs.values()) {
    if (npc.chicken.koT > 0) continue;
    const dx = npc.pos.x - player.pos.x, dz = npc.pos.z - player.pos.z;
    const d = Math.hypot(dx, dz);
    if (d > 1.35) continue;                          // 扇翅范围更短，但没有方向限制
    feathers.burst(npc.chicken.group.position, 6, npc.chicken.pal?.body ?? 0xffffff);
    sfx.hit(d);
  }
}

// ---------- 点选 / 详情 ----------
const ray = new THREE.Raycaster();
const _proj = new THREE.Vector3();
function pickChicken(cx, cy) {
  const ndc = new THREE.Vector2((cx / innerWidth) * 2 - 1, -(cy / innerHeight) * 2 + 1);
  ray.setFromCamera(ndc, camera);
  const hits = ray.intersectObjects([...npcs.values()].map((n) => n.chicken.hit), false);
  return hits.length ? hits[0].object.userData.chicken.ref : null;
}
// 屏幕空间的兜底：手指点在鸡附近（而不是精确砸在它身上）也算选中
function pickByScreen(cx, cy, radius = 58) {
  let best = null, bd = radius;
  for (const npc of npcs.values()) {
    _proj.set(npc.pos.x, 0.9, npc.pos.z).project(camera);
    if (_proj.z > 1) continue;
    const sx = (_proj.x + 1) / 2 * innerWidth, sy = (1 - _proj.y) / 2 * innerHeight;
    const d = Math.hypot(sx - cx, sy - cy);
    if (d < bd) { bd = d; best = npc; }
  }
  return best;
}
const PICK_R = isTouch ? 58 : 40;

// 点一下：选中鸡 → 打开悬浮层里的详情（带一圈反馈环）
function tapSelect(cx, cy) {
  const npc = pickChicken(cx, cy) || pickByScreen(cx, cy, PICK_R);
  if (npc) { ripple(npc); openFor(npc); return true; }
  // 点空地 = 关面板（右侧抽屉时代的行为；触屏上也是唯一的「点外面收起」手势）
  if (hud.probesOpen) hud.hideProbes();
  return false;
}

// 选中反馈：脚下一圈金环扩散淡出
const selRing = new THREE.Mesh(
  new THREE.RingGeometry(0.55, 0.78, 30),
  new THREE.MeshBasicMaterial({ color: 0xffe08a, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide }),
);
selRing.rotation.x = -Math.PI / 2;
selRing.visible = false;
scene.add(selRing);
let rippleT = 0;
const RIPPLE_DUR = 0.7;
function ripple(npc) {
  selRing.position.set(npc.pos.x, 0.06, npc.pos.z);
  selRing.scale.setScalar(1);
  selRing.material.opacity = 0.9;
  selRing.visible = true;
  rippleT = RIPPLE_DUR;
}

function openFor(npc) {
  // hp 也带上：大白鹅的详情卡片要显示"现在多少血"（它不是探针，没有历史曲线可拉）
  hud.showDetail({ kind: npc.kind, nodeId: npc.nodeId, taskId: npc.taskId, hp: npc.hp, maxHp: GOOSE.maxHp });
  if (locked) document.exitPointerLock();
}
hud.onSelect = (id) => {
  if (id === 'me') { hud.banner('这是你自己 🐔', 1200); return; }
  if (String(id).startsWith('r')) {
    const r = remotes.get(Number(String(id).slice(1)));
    if (r) hud.banner(`${r.name} 是别的玩家 🐔`, 1500);
    return;
  }
  const npc = npcs.get(id);
  if (npc) openFor(npc);
};

// ---------- 联机（客户端只有这一种形态：连不上就清场，后台每 15 秒重试）----------
const REMOTE_DELAY = 110;        // 别人的鸡渲染在 110ms 之前，用两帧快照插值，动作才顺
// 联机时别人的羽色：优先用他自己上报的（1-5，见 hi 消息），没有就按 id 派生一套（同一人稳定）
const remoteColorIdx = (info) => {
  let n = info?.color ? Number(info.color) - 1 : Math.abs(Number(info?.id) || 0);
  if (!Number.isFinite(n)) n = 0;
  return ((Math.trunc(n) % 5) + 5) % 5;     // color:0 / 负数不能变成 PALETTES[-1]
};

function ensureRemote(info) {
  let r = remotes.get(info.id);
  if (!r) {
    const chicken = new Chicken({ colorIdx: remoteColorIdx(info), kind: 'player' });
    scene.add(chicken.group);
    r = { id: info.id, chicken, buf: [], name: info.name, hp: 100, ko: false, _ko: false, _key: '', color: info.color, cc: info.cc || '' };
    remotes.set(info.id, r);
    hud.feed(`🐣 ${info.name} 进场了`);
  }
  if (info.name && info.name !== r.name) r.name = info.name;
  if (info.color && info.color !== r.color) {      // 他自己上报了羽色就换成他的
    r.color = info.color;
    r.chicken.setPalette?.(remoteColorIdx(info));
  }
  if (info.cc && info.cc !== r.cc) r.cc = String(info.cc).toUpperCase();   // 他的国旗 = 他那个 IP 的所在地
  r.hp = info.hp ?? r.hp;
  const key = `${r.name}|${Math.round(r.hp)}|${r.cc || ''}`;
  if (key !== r._key) {
    r._key = key;
    r.chicken.setInfo({ title: r.name, code: r.cc || '🐔' });
    r.chicken.setHp(r.hp);
  }
  return r;
}
function removeRemote(id) {
  const r = remotes.get(id);
  if (!r) return;
  hud.feed(`👋 ${r.name} 走了`);
  // 只 scene.remove 会漏掉名牌 canvas 贴图、材质和每只鸡自己的几何体：
  // 访客反复进出时显存会一路涨（2026-11-04 复审）。
  r.chicken.dispose(scene);
  remotes.delete(id);
}

net.on('open', () => {
  // 自报国旗码只有"服务端拿不到 CF-IPCountry"时才会被采纳（见 farm_server.country_from_headers）
  net.send({ t: 'hi', name: myName, color: myColorIdx + 1, cc: myCc || undefined });   // 颜色 +1：0 在服务端等于"没上报"
  // 用户要求：连上服务器这个提示只走顶部播报，不弹中央横幅
  hud.feed('🔗 已连上联机服务器');
  hud.setPresence(true, remotes.size);      // 立刻更新，不等每秒一次的节流（否则首秒会看到 index.html 里的占位文案）
  // 探针鸡/网站鸡改为服务端权威：名单上报给服务端，本地不再跑 AI
  for (const npc of npcs.values()) if (npc.setRemote) npc.setRemote(true);
  npcRosterSent = '';
  hotSent = '';
  sendNpcRoster();
  sendHot();          // ⚠ 暴躁名单也要重发：服务端每个连接各存一份，重连后不重发就永远是"没人暴躁"
});
net.on('welcome', (m) => {
  // 出生点由服务端决定（welcome 带 x/z）：以前两边各自 randomSpawn，服务端会把前 ~1 秒的
  // 位置上报当成“瞬移”夹住，别人看到的是从别处滑过来，NPC 也可能在你看不到的位置咬到你。
  if (m && Number.isFinite(m.x) && Number.isFinite(m.z)) {
    player.pos.set(m.x, groundHeight(m.x, m.z), m.z);
    player.vy = 0;
    playerChicken.group.position.copy(player.pos);
  }
  if (m && m.cc) { myCc = String(m.cc).toUpperCase(); syncPlayerPlate(); }   // 访客鸡的国旗 = 你这个 IP 的所在地
});
net.on('cc', (m) => {
  if (m && m.cc) { myCc = String(m.cc).toUpperCase(); syncPlayerPlate(); }
});
net.on('roster', (list, msg) => {
  hud.setLeftBoard(msg && msg.left);        // 离场玩家的啄倒记录（榜上灰显）
  const seen = new Set();
  for (const info of list) {
    if (info.id === net.id) continue;
    seen.add(info.id);
    ensureRemote(info);
  }
  for (const id of [...remotes.keys()]) if (!seen.has(id)) removeRemote(id);
});
net.on('drop', (wasOnline) => {
  for (const id of [...remotes.keys()]) removeRemote(id);
  // 掉线就清场：探针鸡/网站鸡全部消失，只剩你自己的鸡
  // （对齐原站——原站只有服务端一种形态，没有单机兜底）
  for (const npc of npcs.values()) npc.dispose(scene);
  npcs.clear();
  npcRosterSent = '';
  hud.setPresence(false, 0);                // 掉线立刻把访客格改成 1（不等节流）
  // 战绩在服务端：断线后本地不再有权威值（重连是一条新连接，分数从 0 重新累计），
  // 所以榜上先只留你自己、卡片也归零，免得摆着过期分数骗人
  player.score = 0;
  hud.setLeftBoard([]);
  hud.updateBoard([{ id: 'me', name: `${myName}（玩家）`, score: 0, me: true }], true);   // 强制重画：这之后没有快照了，被节流吞掉就一直是别人的分数
  syncPlayerPlate();
  if (wasOnline) { hud.banner('🔗 连接断了，正在重连…', 2200); hud.feed('🔗 与服务器断开，正在重连'); }
});
net.on('respawn', (m) => {
  player.pos.set(m.x, 0, m.z);
  player.vy = 0;
  player.koT = 0;      // 服务端权威复活点已下发 → 本地倒计时到此为止
  playerChicken.revive();
});
// ---------- 啄倒榜的行 ----------
// 服务端只下发数字：ps 第 8 项 = 玩家的啄倒数，ns 第 9 项 = 探针鸡/网站鸡的啄倒数。
// 名字不下发（服务端不存名字），由本端解析：玩家名来自 roster，鸡名来自探针数据
// —— 鸡的前缀与名牌口径一致（探针鸡 / 网站鸡），免得和玩家混在一列里分不清。
function boardNpcName(id) {
  const npc = npcs.get(id);
  if (npc?.info?.title) return { name: npc.info.title, kind: npc.kind };
  if (id[0] === 'g') return { name: GOOSE.name, kind: 'goose' };
  if (id[0] === 'd') return { name: DOG.name, kind: 'dog' };
  if (id[0] === 'n') { const n = farm.nodeById(Number(id.slice(1))); return { name: n?.name || id, kind: 'probe' }; }
  if (id[0] === 't') { const t = farm.tasks.get(Number(id.slice(1))); return { name: t?.name || id, kind: 'web' }; }
  return { name: id, kind: 'probe' };
}
function boardRows(ps, ns) {
  const rows = [];
  const live = new Set();
  for (const e of ps) {
    const id = e[0];
    live.add(id);
    const me = id === net.id;
    const name = me ? myName : (remotes.get(id)?.name || `鸡友${id}`);
    rows.push({ id, name: `${name}（玩家）`, score: e[7] | 0, me });
  }
  // NPC·大白鹅：场上几只**合并成一行**（对齐源站：都是同一队鹅），分数按队累加
  let gooseScore = 0, gooseAlive = 0;
  for (const e of ns) {
    const id = e[0];
    live.add(id);
    if (String(id)[0] === 'g') { gooseAlive++; gooseScore += e[8] | 0; continue; }
    if (String(id)[0] === 'd') continue;        // 看门狗：不进啄倒榜（它打不倒、也不参与计分）
    const { name, kind } = boardNpcName(id);
    rows.push({ id, name: `${kind === 'web' ? '网站鸡' : '探针鸡'}·${name}`, score: e[8] | 0 });
  }
  if (gooseAlive) rows.push({ id: 'goose-team', name: GOOSE.name, score: gooseScore });
  // 已离场的玩家（服务端 roster.left 存档，只在榜上灰显）
  for (const rec of hud.leftBoard || []) {
    if (rec && !live.has(rec.id)) rows.push({ id: rec.id, name: `${rec.name}（玩家）`, score: rec.score | 0, off: true });
  }
  rows.sort((a, b) => b.score - a.score);
  return rows;
}

net.on('snapshot', (m) => {
  const evs = m.ev || [];
  if (DEBUG && evs.length) {           // 自测用：留存最近的服务端事件（谁啄了谁）
    for (const e of evs) evLog.push({ at: Date.now(), ...e });
    while (evLog.length > 60) evLog.shift();
  }
  // 服务端权威的探针鸡/网站鸡：按快照插值（联机时"同一只鸡"血量全服一致）
  if (m.ns) {
    for (const e of m.ns) {
      const [nid, nx, nz, ny, nyaw, nhp, nst, nscale] = e;
      const npc = npcs.get(nid) || makeNpcFor(nid);   // 鸡只由服务端名单创建（原站同款）
      if (!npc) continue;                             // 本地数据里还没这只鸡，下一拍再建
      npc._seenAt = performance.now();
      npc.pushBuf(nx, nz, ny, nyaw, nhp, nst, nscale);
    }
  }
  for (const e of m.ps) {
    const [id, x, z, y, yaw, hp, ko, score] = e;
    if (id === net.id) {
      // 自己的血量以服务端为准
      if (hp < player.hp) hud.banner(`🩸 被啄了 -${Math.round(player.hp - hp)}`, 900);
      player.hp = hp;
      player.score = score | 0;                       // 啄倒数也只认服务端（客户端不上报）
      if (ko && player.koT <= 0) { player.koT = 3.5; playerChicken.ko(); hud.banner('😵 你被啄晕了！', 2000); }
      // 服务端说「没晕、血还 > 0」= 它已经复活了 → 立刻停掉本地倒计时。
      // 否则本地倒计时会在服务端复活之后自己再放一次随机复活点，把服务端选的位置顶掉（2026-09-27 复查）
      if (!ko && player.koT > 0 && player.hp > 0) player.koT = 0;
      playerChicken.setHp(hp);
      hud.setSelfState(hp, player.koT, player.score);
      continue;
    }
    const r = remotes.get(id);
    if (!r) continue;
    r.buf.push({ t: performance.now(), x, z, y, yaw, hp, ko });
    while (r.buf.length > 8) r.buf.shift();
    r.hp = hp; r.ko = !!ko;
    const key = `${r.name}|${Math.round(hp)}|${r.cc || ''}`;
    if (key !== r._key) {
      r._key = key;
      r.chicken.setInfo({ title: r.name, code: r.cc || '🐔' });
      r.chicken.setHp(hp);
    }
  }
  // 啄倒榜：每帧重算行（行数 ~20，代价可忽略；HUD 内部还有差量比较 + 500ms 节流）
  hud.updateBoard(boardRows(m.ps, m.ns || []));
  for (const ev of evs) {
    // 被扇飞的推力：服务端只对鸡直接改坐标，对玩家只能下发位移指令（玩家的位置是客户端权威，
    // 服务端改了会被这里 20Hz 的上报立刻覆盖 = 只抖一帧）。所以由客户端自己执行这一下。
    if (ev.t === net.id && (ev.kx || ev.kz)) {
      const [nx, nz] = resolveCollision(player.pos.x + (ev.kx || 0), player.pos.z + (ev.kz || 0),
                                        PLAYER_R, world.obstacles, world.boxObstacles);
      player.pos.x = nx; player.pos.z = nz; player.vy = 0;
      dust.puff(player.pos, 6, 0.8);
    }
    if (ev.e === 'ko') {
      // 看门狗的击杀事件带 drive 标记 → 它不是"啄倒"，是把目标「驱逐」出院子
      hud.feed(ev.drive ? `${ev.fn} 🐕💨 驱逐了 ${ev.on}` : `${ev.fn} 🐔💥 啄倒了 ${ev.on}`);
      if (ev.to === net.id) hud.banner('😵 你被啄晕了！', 2000);
      if (ev.f === net.id) hud.banner(ev.drive ? `🐕💨 看门狗驱逐了 ${ev.on}！` : `🎯 啄倒了 ${ev.on}！`, 1400);
    } else if (ev.e === 'hit') {
      // 命中表现：掉羽毛 + 声音（自己被啄时再来一声惊叫）；被"扇"中时额外扇一下翅膀
      if (ev.k === 'wing') {
        const w = remotes.get(ev.f) || npcs.get(ev.f);
        if (w) w.chicken.flap();
        // 声音只在附近播：鸡之间互扇也会走到这条分支，远处的别吵到玩家
        const wp = w ? w.chicken.group.position : null;
        if (!wp || Math.hypot(wp.x - player.pos.x, wp.z - player.pos.z) < 18) sfx.flap();
      }
      if (ev.t === net.id) {
        feathers.burst(player.pos, 8, 0xffffff);
        sfx.cluck(); sfx.hit(0);
      } else {
        const tgt = remotes.get(ev.t) || npcs.get(ev.t);
        if (tgt) {
          const p = tgt.chicken.group.position;
          feathers.burst(p, 8, tgt.chicken.pal?.body ?? 0xffffff);
          sfx.hit(Math.hypot(p.x - player.pos.x, p.z - player.pos.z));
        }
      }
    } else if (ev.e === 'react') {
      // 探针鸡/网站鸡被啄之后的反应：回击 / 逃窜（服务端判定）。
      // 表现：脚下扬一圈土 + 就近来一声（名牌上的「⚔️回击 / 💨逃窜」小标由状态位驱动）
      const npc = npcs.get(ev.t);
      if (npc) {
        const p = npc.chicken.group.position;
        dust.puff(p, ev.k === 'flee' ? 8 : 5, ev.k === 'flee' ? 1 : 0.7);
        if (Math.hypot(p.x - player.pos.x, p.z - player.pos.z) < 18) {
          if (ev.k === 'flee') sfx.flap(); else sfx.peck();
        }
        npc._react = ev.k;                       // 自测脚本要能读到"它这次选了什么"
        npc._reactAt = Date.now();
      }
    } else if (ev.e === 'peck') {
      remotes.get(ev.f)?.chicken.peck();
    } else if (ev.e === 'wing') {
      remotes.get(ev.f)?.chicken.flap();
      sfx.flap();
    } else if (ev.e === 'flap') {
      remotes.get(ev.f)?.chicken.flap();
    }
  }
});

// ---------- NPC 与数据绑定 ----------
const npcs = new Map();          // id -> Npc（探针鸡/网站鸡）
let synced = false;

// ---------- 探针鸡/网站鸡：名单与"暴躁"上报 ----------
// 服务端不读 hub 数据，所以由客户端把名单（id/名称/种类）报上去，服务端据此生成 NPC；
// "谁很暴躁"（CPU/内存超阈值）同理由客户端上报，服务端决定让谁追人 —— 这样全服一致。
let npcRosterSent = '', hotSent = '';
function sendNpcRoster() {
  if (!net.online) return;
  // ⚠ 名单必须由探针/探测任务数据生成，**不能**遍历本地 npcs ——
  //   鸡模型现在只由服务端下发（原站同款），首帧本地还没有鸡，遍历 npcs 会送出空名单，
  //   服务端于是永远不知道场上该有哪些鸡（死锁）。
  const list = [];
  // cpu 也带上：服务端按它算体型倍率（1.0 ~ 1.35，对齐原站），再随快照下发
  for (const n of farm.nodes) list.push({ id: `n${n.id}`, name: n.name, kind: 'probe', cpu: Math.round(n.metrics?.cpu ?? 0) });
  // 玩法选项 showWeb=false：不把网站鸡报给服务端 → 场上就没有它们（榜单/详情也一起消失）
  if (CONF.showWeb) for (const task of farm.tasks.values()) list.push({ id: `t${task.id}`, name: task.name, kind: 'web' });
  // 服务端单连接只收 32 条（MAX_NPC_PER_CLIENT）；别静默超发，至少让开发者看见被截断
  if (list.length > 32) {
    console.warn(`[cyber-probe] NPC 名单 ${list.length} 条，超过服务端单连接上限 32，尾部会被忽略`);
    list.length = 32;
  }
  const sig = JSON.stringify(list);
  if (sig === npcRosterSent) return;
  npcRosterSent = sig;
  net.send({ t: 'npcs', list });
}
function sendHot() {
  if (!net.online) return;
  const ids = [...npcs.values()].filter((n) => n.info?.hot).map((n) => n.id).sort();
  const sig = ids.join(',');
  if (sig === hotSent) return;
  hotSent = sig;
  net.send({ t: 'hot', ids });
}

/**
 * 按服务端下发的 id 建一只鸡（id 约定与服务端一致：n<节点id> 探针鸡、t<任务id> 网站鸡、
 * g<序号> NPC·大白鹅 —— 大白鹅由服务端自己放养，不看探针数据，所以直接就能建）。
 */
function makeNpcFor(id) {
  let npc = null;
  if (id[0] === 'g') {
    npc = new Goose();
    npc.id = id;
  } else if (id[0] === 'd') {
    npc = new Dog();                        // 看门狗：服务端放养，id d1/d2…
    npc.id = id;
  } else if (id[0] === 'n') {
    const node = farm.nodes.find((n) => `n${n.id}` === id);
    if (node) npc = new Npc({ farm, kind: 'probe', node, world });
  } else if (id[0] === 't') {
    const task = farm.tasks.get(Number(id.slice(1)));
    if (task) npc = new Npc({ farm, kind: 'web', task, world });
  }
  if (!npc) return null;
  npc.setRemote(true);                       // 服务端权威：位置/血量/状态全部来自快照
  // 立刻把名牌文案填上：鸡是"由服务端名单创建"的，而数据同步只发生在 farm.onChange（最长 6 秒一次）
  // —— 不补这一下，新建的鸡会先挂一段空名牌（自测里表现为 plate 载荷拿不到 info）
  if (npc.sync) npc.sync(Date.now() / 1000);
  npc.addTo(scene);
  if (isTouch) npc.chicken.hit.scale.setScalar(1.55);   // 手机上放大可点区域
  npc._seenAt = performance.now();
  npcs.set(id, npc);
  return npc;
}

farm.onChange((f) => {
  hud.updateCounters();
  const t = Date.now() / 1000;
  // 探针鸡 / 网站鸡：模型**只由服务端名单创建**（见 makeNpcFor 与 snapshot 处理）。
  // 这里只把数据和已有模型对一次账（名牌文案），不再本地造鸡、也不再按本地数据删鸡。
  for (const n of f.nodes) {
    const npc = npcs.get(`n${n.id}`);
    if (npc) npc.sync(t);
  }
  if (CONF.showWeb) {
    for (const task of f.tasks.values()) {
      const npc = npcs.get(`t${task.id}`);
      if (npc) npc.sync(t);
    }
  }
  hud.consumeWorstChange();
  sendNpcRoster();          // 名单有变化就同步给服务端（联机时它是权威）
  sendHot();
  if (!synced && npcs.size) synced = true;
});

function spawnKillFeed(from, to) {
  hud.feed(`${from} 🐔💥 啄倒了 ${to}`);
}

// ---------- 实体间软分离 ----------
// 以前只有场地道具参与碰撞，实体之间可以互相穿模。
// 参考站用 separation=30 的速度冲量做同一件事；这里用位置分离 + 每帧限幅，
// 手感更稳（不会哆嗦），而且被推开的一方还要再过一遍障碍物解算，免得被挤进鸡舍里。
const PLAYER_R = 0.45, CHICK_R = 0.5;
function separateEntities() {
  const bodies = [{ p: player.pos, r: PLAYER_R, mine: true }];
  for (const npc of npcs.values()) {
    // 服务端权威的实体本地不能推：把它当"固定的墙"，只把玩家自己推开，
    // 否则位置会跟服务端快照打架（表现成抖动）。
    bodies.push({ p: npc.pos, r: CHICK_R, npc, fixed: !!npc.remote });
  }
  for (const r of remotes.values()) bodies.push({ p: r.chicken.group.position, r: PLAYER_R, fixed: true });

  let touched = false;
  for (let i = 0; i < bodies.length; i++) {
    const a = bodies[i];
    for (let j = i + 1; j < bodies.length; j++) {
      const b = bodies[j];
      let dx = b.p.x - a.p.x, dz = b.p.z - a.p.z;
      let d = Math.hypot(dx, dz);
      const min = a.r + b.r;
      if (d >= min) continue;
      if (d < 1e-4) { dx = 1; dz = 0; d = 1e-4; }       // 完全重合：给个确定方向；d 要留成"极小值"（填 1 会让重叠量算成 0，永远推不开）
      if (a.fixed && b.fixed) continue;
      const push = Math.min(0.12, (min - d) * 0.55);    // 每帧最多推 12cm：够快，又不会来回抖
      const ux = (dx / d) * push, uz = (dz / d) * push;
      if (a.fixed) { b.p.x += ux * 2; b.p.z += uz * 2; }
      else if (b.fixed) { a.p.x -= ux * 2; a.p.z -= uz * 2; }
      else { a.p.x -= ux; a.p.z -= uz; b.p.x += ux; b.p.z += uz; }
      touched = true;
    }
  }
  if (!touched) return;

  // 玩家：重新贴地（在空中就别动 y）+ 不许被挤进障碍物
  const py = player.pos.y;
  const [pcx, pcz] = resolveCollision(player.pos.x, player.pos.z, PLAYER_R, world.obstacles, world.boxObstacles);
  player.pos.x = pcx; player.pos.z = pcz;
  const gh2 = groundHeight(pcx, pcz);
  if (player.vy === 0 && Math.abs(py - groundHeight(player.pos.x, player.pos.z)) < 0.2) player.pos.y = gh2;

  // 鸡：贴地 + 过障碍物 + 把位置同步回模型（服务端管的那只不动）
  for (const npc of npcs.values()) {
    if (npc.remote) continue;
    const [cx, cz] = resolveCollision(npc.pos.x, npc.pos.z, CHICK_R,
      world.obstacles, world.boxObstacles);
    npc.pos.x = cx; npc.pos.z = cz;
    npc.pos.y = groundHeight(cx, cz);
    npc.group.position.set(cx, npc.pos.y, cz);
  }
}

// ---------- 主循环 ----------
// 状态位（与 server/farm_server.py、js/chicken.js 三处必须一致）：DEAD 1 / PECK 2 / RUN 4 / FLAP 8 / PREEN 16
const ST_FLEE = 32, ST_FIGHT = 64;
let lastT = performance.now(), hudT = 0, peckCd = 0, wingCd = 0, netT = 0;
function tick(now) {
  const dt = Math.min(0.05, (now - lastT) / 1000);
  lastT = now;
  peckCd = Math.max(0, peckCd - dt);
  wingCd = Math.max(0, wingCd - dt);

  // ---- 玩家移动 ----
  let mx = 0, mz = 0;
  // 面板是模态的：摇杆/残留的 keys 都不能在背后驱动玩家（触屏第二根手指点 🖥 的场景）
  if (hud.probesOpen) { move.x = 0; move.y = 0; move.run = false; }
  if (!hud.probesOpen) {
    // 键盘永远生效：触屏本/平板外接键盘时不能因为 pointer:coarse 就把 WASD 关掉
    if (keys['KeyW'] || keys['ArrowUp']) mz += 1;
    if (keys['KeyS'] || keys['ArrowDown']) mz -= 1;
    if (keys['KeyA'] || keys['ArrowLeft']) mx -= 1;
    if (keys['KeyD'] || keys['ArrowRight']) mx += 1;
  }
  if (isTouch) { mx += move.x; mz += -move.y; }
  const mag = Math.hypot(mx, mz);
  if (mag > 1) { mx /= mag; mz /= mag; }
  const running = !hud.probesOpen && (keys['ShiftLeft'] || keys['ShiftRight'] || move.run);
  const speed = running ? 5.4 : 2.8;      // 与参考站一致：慢走 2.8 / 疾跑 5.4 m/s

  if (player.koT > 0) {
    player.koT = Math.max(0, player.koT - dt);
    if (player.koT === 0) {
      player.hp = 100;
      // 复活点也随机（联机时以服务端 respawn 下发的点为准，这里只是本地兜底）
      const sp = randomSpawn();
      player.pos.set(sp.x, groundHeight(sp.x, sp.z), sp.z);
      playerChicken.revive();
      syncPlayerPlate();
      hud.banner('🥚 复活了，继续啄！', 1400);
    }
  } else if (mag > 0.05) {
    const cy = camYaw;
    // 相机在玩家身后 (sin,cos) 的反侧、视线朝 +(sin,cos)：前方 = (sin y, cos y)，右方 = (-cos y, sin y)
    const dirX = Math.sin(cy) * mz - Math.cos(cy) * mx;
    const dirZ = Math.cos(cy) * mz + Math.sin(cy) * mx;
    const nx = player.pos.x + dirX * speed * dt;
    const nz = player.pos.z + dirZ * speed * dt;
    const [cx, cz] = resolveCollision(nx, nz, 0.45, world.obstacles, world.boxObstacles);
    player.pos.x = cx; player.pos.z = cz;
    const wantYaw = Math.atan2(dirX, dirZ);
    let diff = ((wantYaw - player.yaw + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
    player.yaw += diff * Math.min(1, dt * 12);
  }
  // 跳/重力
  // 跳/重力：地面高度跟着地形起伏（山坡上也能正常起跳落地）
  const gh = groundHeight(player.pos.x, player.pos.z);
  if (player.pos.y > gh + 0.001 || player.vy > 0) {
    player.vy -= 16 * dt;
    player.pos.y += player.vy * dt;
    if (player.pos.y <= gh) {
      // 落地扬尘：从高处砸下来才明显
      if (player.vy < -4) dust.puff(_tmpV.set(player.pos.x, gh, player.pos.z), 6, 0.7);
      player.pos.y = gh;
      player.vy = 0;
    }
  } else {
    player.pos.y = gh;
    player.vy = 0;
  }
  if (!hud.probesOpen && keys['Space']) { doJump(); keys['Space'] = false; }

  playerChicken.group.position.copy(player.pos);
  playerChicken.group.rotation.y = player.yaw;
  playerChicken.update(dt, mag > 0.05 && player.koT <= 0, running, player.pos.y > gh + 0.05);

  // ---- NPC ----
  for (const npc of npcs.values()) {
    npc.update(dt, player);                       // 服务端权威：只走快照插值那条路
    // 逃窜的鸡脚后跟拖一串土（一眼看得出它是在"撒腿跑"，而不是照常散步）
    if ((npc.st & ST_FLEE) && Math.hypot(npc.pos.x - player.pos.x, npc.pos.z - player.pos.z) < 42) {
      npc._dustT = (npc._dustT || 0) - dt;
      if (npc._dustT <= 0) {
        npc._dustT = 0.14;
        dust.puff(_tmpV.set(npc.pos.x, npc.pos.y + 0.05, npc.pos.z), 2, 0.6);
      }
    }
    // 服务端连续 3 秒不再下发这只鸡 → 它已经不在名单里了，收掉模型
    if (npc._seenAt && performance.now() - npc._seenAt > 3000) { npc.dispose(scene); npcs.delete(npc.id); }
  }

  // ---- 实体间软分离：玩家 / 鸡 / 其他玩家不许叠在一起 ----
  separateEntities();

  // ---- 名牌远处淡出：鸡群扎堆时不再糊住半个屏幕 ----
  for (const npc of npcs.values()) {
    const s = npc.chicken.sprite;
    if (!s) continue;
    const d = camera.position.distanceTo(npc.chicken.group.position);
    const o = d <= 24 ? 1 : d >= 38 ? 0 : 1 - (d - 24) / 14;
    if (Math.abs(s.material.opacity - o) > 0.01) {
      s.material.opacity = o;
      s.visible = o > 0.02;
    }
  }

  // ---- 相机：参考站的手感（距离默认 5，目标点抬到胸口高度，机位不穿地） ----
  camTarget.lerp(
    _camWant.set(player.pos.x, player.pos.y + 0.9, player.pos.z),
    Math.min(1, dt * 14),
  );
  // 模型换装完成后（__pfSwapMs 变了）重量一次遮挡体：之前量到的是自建旧道具，尺寸对不上
  const _stamp = window.__pfSwapMs || 0;
  if (_stamp !== camBoxStamp) { camBoxStamp = _stamp; rebuildCamBlockers(); }
  const cd = camDist + (player.pos.y - gh > 0.05 ? (player.pos.y - gh) * 0.5 : 0);
  // 方向向量（与下面旧写法一致：camTarget 指向机位）
  // 镜头解算：从注视点朝机位扫一段，撞到东西就把机位收到命中点前面。
  // 关键是**别瞬跳**：玩家贴着鸡舍走时，目标距离会在 5.5m 和 0.6m 之间来回跳，
  // 直接赋值就是"镜头猛地一缩再弹回"，看着晕。这里用限速插值：推近 6 m/s、拉回 3.5 m/s，
  // 再加 12% 死区（只是擦到边就不动），走过木桶/树干这类细物件时完全不会抽。
  const _dx0 = -Math.sin(camYaw) * Math.cos(camPitch);
  const _dy0 = Math.sin(camPitch);
  const _dz0 = -Math.cos(camYaw) * Math.cos(camPitch);
  const _t = camSweep(camTarget.x, camTarget.y, camTarget.z, _dx0 * cd, _dy0 * cd, _dz0 * cd);
  const _hitRoot = camHitRoot;
  let _wantCd = cd;
  let _fadeRoot = null;
  if (_t < 1 && _t * cd < cd * 0.88) {          // 只是擦到边（12% 死区）就当没挡
    if (_hitRoot) _fadeRoot = _hitRoot;          // 能单独淡出的模型 → 不动机位，只淡它
    else _wantCd = Math.max(1.1, _t * cd - 0.3); // 合批网格/围栏 → 只能轻轻拉近
  }
  const _maxStep = dt * (_wantCd < camDistCur ? 4 : 3);
  camDistCur += Math.max(-_maxStep, Math.min(_maxStep, _wantCd - camDistCur));
  if (_fadeRoot) fadeRoot(_fadeRoot, FADE_MIN);
  updateFades(dt, _fadeRoot);
  camPitchEff = camPitch;
  const _pdx = _dx0; const _pdy = _dy0; const _pdz = _dz0;
  camera.position.set(
    camTarget.x + _pdx * camDistCur,
    camTarget.y + _pdy * camDistCur,
    camTarget.z + _pdz * camDistCur,
  );
  if (camera.position.y < 0.35) camera.position.y = 0.35;
  camera.lookAt(camTarget);

  // ---- 联机：上报自己 + 插值画出别人的鸡 ----
  netT += dt;
  if (net.online && netT >= 0.05) {
    netT = 0;
    net.send({
      t: 'p', x: +player.pos.x.toFixed(2), z: +player.pos.z.toFixed(2), y: +player.pos.y.toFixed(2),
      yaw: +player.yaw.toFixed(3), r: running,
      // 不再上报本地战绩：联机时"啄倒榜分数"完全由服务端裁定（以前每帧上报会把服务端刚加的分又抹平成 0 —— 踩过）
    });
  }
  const rNow = performance.now();
  for (const r of remotes.values()) {
    const buf = r.buf;
    if (!buf.length) continue;
    const target = rNow - REMOTE_DELAY;
    let a = buf[0], b = buf[buf.length - 1];
    for (let i = 0; i < buf.length - 1; i++) {
      if (buf[i].t <= target && buf[i + 1].t >= target) { a = buf[i]; b = buf[i + 1]; break; }
    }
    const span = Math.max(1, b.t - a.t);
    const k = Math.max(0, Math.min(1, (target - a.t) / span));
    const x = a.x + (b.x - a.x) * k, z = a.z + (b.z - a.z) * k, y = a.y + (b.y - a.y) * k;
    const dyaw = ((b.yaw - a.yaw + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
    r.chicken.group.position.set(x, y, z);
    r.chicken.group.rotation.y = a.yaw + dyaw * k;
    // ⚠ 第 4 个参数是「离地高度」，不是世界 Y：以前传 y > 0.02，站在小山坡上
    //   （地面本身就有 0~2.4m）的远程玩家会永远缩腿扑腾，看起来一直在飞。
    const airborne = y - groundHeight(x, z) > 0.05;
    r.chicken.update(dt, Math.hypot(b.x - a.x, b.z - a.z) > 0.02, false, airborne);
    if (r.ko !== r._ko) { r._ko = r.ko; if (r.ko) r.chicken.ko(); else r.chicken.revive(); }
  }

  // ---- 玩家名牌血量节流 ----
  hudT += dt;
  if (hudT > 1) {
    hudT = 0;
    hud.setPresence(net.online, remotes.size);
    hud.updateCounters();
  }
  if (DEBUG) {
    dbgFrames++;
    const dtReal = (now - (dbgLast || now)) / 1000;
    dbgT += dtReal;
    dbgLast = now;
    if (dbgT >= 1) { dbgFps = dbgFrames / dbgT; dbgFrames = 0; dbgT = 0; }
  }

  // ---- 选中反馈环 ----
  if (rippleT > 0) {
    rippleT = Math.max(0, rippleT - dt);
    const k = 1 - rippleT / RIPPLE_DUR;
    selRing.scale.setScalar(1 + k * 2.0);
    selRing.material.opacity = 0.9 * (1 - k) * (1 - k);
    if (rippleT === 0) selRing.visible = false;
  }

  feathers.update(dt);
  dust.update(dt);
  world.update(dt, player.pos);   // 云飘 / 风车水车转 / 栅栏门开合（纯装饰，不影响逻辑）
  renderer.render(scene, camera);
  requestAnimationFrame(tick);
}

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// ---------- 操作说明（底部中置一条，桌面/手机文案不同）----------
// 不拦遮罩：打开就进场地（数据在后台读，读不到会在底部提示）。
$('hud').classList.remove('hidden');
const HINT_DESKTOP = "<b>Esc</b> 释放鼠标 <i>·</i> <b>WASD</b> 移动 <i>·</i> <b>Shift</b> 疾跑 <i>·</i> <b>空格</b> 跳 <i>·</i> <b>左键</b> 啄 <i>·</i> <b>右键</b> 扇翅 <i>·</i> <b>滚轮</b> 缩放 <i>·</i> <b>L</b> 光照 <i>·</i> <b>M</b> 静音 <i>·</i> <b>Tab</b> 探针";
const HINT_TOUCH = "<b>左摇杆</b> 走路 <i>·</i> <b>拖动</b> 转视角 <i>·</i> <b>轻点鸡</b> 看数据 <i>·</i> <b>双指</b> 缩放 <i>·</i> <b>🖥</b> 探针";
$('hint').innerHTML = isTouch ? HINT_TOUCH : HINT_DESKTOP;

farm.start();
requestAnimationFrame(tick);

// 等首帧画完再连：页面初始化（解析 three.js + 建场景）会长时间占住主线程，
// 那期间发起的 WebSocket 握手容易失败；画过一帧再连就稳了。
setTimeout(() => { if (net.mode !== 'online') net.connect(); }, 1200);

// 精细低模装饰：首帧之后再拉（不拖慢首屏）；?nomodels 可关掉做 A/B 对照。
// 拉不到就保留 world.js 里的自建道具，静默降级。
// ---- 首屏：精细模型到位前不显示 3D 画布（用户要求：不要先看到自建道具再被替换）----
// 画布 opacity 在 style.css 里默认 0；模型换完（或兜底超时）再淡入，期间显示 #boot 的等待条。
// 模型模块从 index.html 的 prewarm.js 起就在下载，所以正常情况下这段等待只有几百毫秒（有缓存时几乎为零）。
const bootEl = $('boot');
let canvasShown = false;
const showWorld = () => {
  if (canvasShown) return;
  canvasShown = true;
  canvas.style.opacity = '1';
  if (bootEl) {
    bootEl.classList.add('done');
    setTimeout(() => bootEl.remove(), 420);
  }
};
if (new URLSearchParams(location.search).has('nomodels')) {
  // 不开精细模型：自建版在 buildScene 里是藏着的（为了不让人先看到"旧模型"），这里直接全放出来
  world.showAllFallbacks();
  showWorld();
} else {
  // ⚠ 不要延迟：模型模块从 prewarm.js 起就在下载，首帧画完立刻换（原来 setTimeout 1400ms
  //   会让"自建道具"多挂一秒多，用户看到的就是"先进来是旧模型、过几秒才变新的"）。
  const run = () => decorate(world, scene, groundHeight).then((n) => {
    if (n) console.info(`[models] ${n} 个精细模型已替换自建道具`);
    showWorld();
  }).catch(() => { world.showAllFallbacks(); showWorld(); });
  requestAnimationFrame(() => requestAnimationFrame(run));
  // 兜底：CDN 慢/被墙时也别一直挡着 —— 到点先放出自建版（已经换好的不会变），画布一起淡入
  setTimeout(() => { world.showAllFallbacks(); showWorld(); }, 6000);
}

// 调试钩子：加 ?debug 后可拿到内部对象（自测脚本用，平时无副作用）
const DEBUG = new URLSearchParams(location.search).has('debug');
const evLog = [];                     // 最近的服务端事件（?debug 时给自测脚本看）
let dbgFrames = 0, dbgT = 0, dbgFps = 0, dbgLast = 0;
if (DEBUG) {
  window.__farm = {
    farm, player, npcs, doPeck, doWing, world, scene, camera, renderer, playerChicken, hud, THREE,
    feathers, dust, sfx, groundHeight, evLog,
    net, remotes, myName, tapSelect, pickChicken, pickByScreen, input: move, key: keys,
    boardRows,
    get peckCd() { return peckCd; },
    get fps() { return dbgFps; },
    get camDist() { return camDist; },
    set camDist(v) { camDist = v; },
    get camDistCur() { return camDistCur; },
    get camPitchEff() { return camPitchEff; },
    get camBlockers() { return camBlockers; },
    rebuildCamBlockers,
    get camYaw() { return camYaw; },
    set camYaw(v) { camYaw = v; },
    get mode() { return net.online ? 'online' : 'local'; },
    get hotSentSig() { return hotSent; },
    get myCc() { return myCc; },          // 你自己那只鸡的国旗码（服务端按 IP 下发）
    get npcRosterSig() { return npcRosterSent; },
    randomSpawn,
  };
}
