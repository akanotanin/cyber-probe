// 总装：渲染器、第三人称操控、输入（鼠标/键盘/触屏）、NPC 数据绑定、主循环
import * as THREE from 'three';
import { Farm } from './data.js';
import { buildScene, resolveCollision, BOUNDS, groundHeight } from './world.js';
import { Chicken } from './chicken.js';
import { Npc } from './npc.js';
import { Hud } from './hud.js';
import { Net } from './net.js';
import { Feathers, Dust } from './feathers.js';
import { Sfx } from './sfx.js';

const $ = (id) => document.getElementById(id);
const isTouch = matchMedia('(hover: none) and (pointer: coarse)').matches || 'ontouchstart' in window;

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

const feathers = new Feathers(scene);   // 被啄掉毛的羽毛粒子池
const dust = new Dust(scene);           // 扇翅 / 落地扬尘
const sfx = new Sfx();                  // WebAudio 合成音效（首次点击/按键时才启动）

const farm = new Farm();
const hud = new Hud(farm);
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
const _tmpV = new THREE.Vector3();

// ---------- 输入 ----------
const keys = Object.create(null);
let locked = false;
let dragging = false, dragMoved = 0, lastX = 0, lastY = 0;
const move = { x: 0, y: 0, run: false };

addEventListener('keydown', (e) => {
  keys[e.code] = true;
  if (e.code === 'Tab') { e.preventDefault(); openNearest(); }
  if (e.code === 'KeyM') hud.banner(sfx.toggleMute() ? '🔇 已静音' : '🔊 声音开启', 900);
  if (e.code === 'KeyF') doPeck();
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
addEventListener('wheel', (e) => { camDist = Math.min(9, Math.max(2.4, camDist * (1 + e.deltaY * 0.001))); }, { passive: true });

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
  const hudHit = (t) => t.target?.closest?.('#tbtns, #topbar, #detail, #hint, #banner');

  stick.addEventListener('touchstart', (e) => { stickId = e.changedTouches[0].identifier; setStick(e.changedTouches[0]); e.preventDefault(); }, { passive: false });

  addEventListener('touchstart', (e) => {
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

  // 详情抽屉：从顶部拖动下拉关闭（窄屏整屏都是抽屉，需要给个出口）
  const det = $('detail');
  let dY = null;
  det.addEventListener('touchstart', (e) => {
    const t = e.changedTouches[0];
    if (t.clientY - det.getBoundingClientRect().top < 200) dY = { id: t.identifier, y: t.clientY };
  }, { passive: true });
  addEventListener('touchmove', (e) => {
    if (!dY) return;
    for (const t of e.changedTouches) if (t.identifier === dY.id && t.clientY - dY.y > 70) { hud.hideDetail(); dY = null; }
  }, { passive: true });
  addEventListener('touchend', () => { dY = null; });

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

// 点一下：选中鸡 → 开详情（带一圈反馈环）；点空地 → 关掉已开的抽屉
function tapSelect(cx, cy) {
  const npc = pickChicken(cx, cy) || pickByScreen(cx, cy, PICK_R);
  if (npc) { ripple(npc); openFor(npc); return true; }
  if (!hud.detail.classList.contains('hidden')) { hud.hideDetail(); return true; }
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
  hud.showDetail({ kind: npc.kind, nodeId: npc.nodeId, taskId: npc.taskId });
  if (locked) document.exitPointerLock();
}
function openNearest() {
  let best = null, bd = 1e9;
  for (const npc of npcs.values()) {
    const d = Math.hypot(npc.pos.x - player.pos.x, npc.pos.z - player.pos.z);
    if (d < bd) { bd = d; best = npc; }
  }
  if (best) openFor(best);
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
const remoteColorIdx = (info) => (info?.color ? (Number(info.color) - 1) % 5 : Math.abs(Number(info?.id) || 0) % 5);

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
  scene.remove(r.chicken.group);
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
  hud.updateBoard([{ id: 'me', name: `${myName}（玩家）`, score: 0, me: true }]);
  syncPlayerPlate();
  if (wasOnline) { hud.banner('🔗 连接断了，正在重连…', 2200); hud.feed('🔗 与服务器断开，正在重连'); }
});
net.on('respawn', (m) => {
  player.pos.set(m.x, 0, m.z);
  player.vy = 0;
  playerChicken.revive();
});
// ---------- 啄倒榜的行 ----------
// 服务端只下发数字：ps 第 8 项 = 玩家的啄倒数，ns 第 9 项 = 探针鸡/网站鸡的啄倒数。
// 名字不下发（服务端不存名字），由本端解析：玩家名来自 roster，鸡名来自探针数据
// —— 鸡的前缀与名牌口径一致（探针鸡 / 网站鸡），免得和玩家混在一列里分不清。
function boardNpcName(id) {
  const npc = npcs.get(id);
  if (npc?.info?.title) return { name: npc.info.title, kind: npc.kind };
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
  for (const e of ns) {
    const id = e[0];
    live.add(id);
    const { name, kind } = boardNpcName(id);
    rows.push({ id, name: `${kind === 'web' ? '网站鸡' : '探针鸡'}·${name}`, score: e[8] | 0 });
  }
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
      if (!ko && player.koT > 0 && player.hp > 0) { /* 服务端还没复活，等 respawn */ }
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
      hud.feed(`${ev.fn} 🐔💥 啄倒了 ${ev.on}`);
      if (ev.to === net.id) hud.banner('😵 你被啄晕了！', 2000);
      if (ev.f === net.id) hud.banner(`🎯 啄倒了 ${ev.on}！`, 1400);
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
  for (const task of farm.tasks.values()) list.push({ id: `t${task.id}`, name: task.name, kind: 'web' });
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

/** 按服务端下发的 id 建一只鸡（id 约定与服务端一致：n<节点id> 探针鸡、t<任务id> 网站鸡） */
function makeNpcFor(id) {
  let npc = null;
  if (id[0] === 'n') {
    const node = farm.nodes.find((n) => `n${n.id}` === id);
    if (node) npc = new Npc({ farm, kind: 'probe', node, world });
  } else if (id[0] === 't') {
    const task = farm.tasks.get(Number(id.slice(1)));
    if (task) npc = new Npc({ farm, kind: 'web', task, world });
  }
  if (!npc) return null;
  npc.setRemote(true);                       // 服务端权威：位置/血量/状态全部来自快照
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
  for (const task of f.tasks.values()) {
    const npc = npcs.get(`t${task.id}`);
    if (npc) npc.sync(t);
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
  if (!isTouch || move.x || move.y) {
    if (keys['KeyW'] || keys['ArrowUp']) mz += 1;
    if (keys['KeyS'] || keys['ArrowDown']) mz -= 1;
    if (keys['KeyA'] || keys['ArrowLeft']) mx -= 1;
    if (keys['KeyD'] || keys['ArrowRight']) mx += 1;
  }
  if (isTouch) { mx += move.x; mz += -move.y; }
  const mag = Math.hypot(mx, mz);
  if (mag > 1) { mx /= mag; mz /= mag; }
  const running = keys['ShiftLeft'] || keys['ShiftRight'] || move.run;
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
  if (keys['Space']) { doJump(); keys['Space'] = false; }

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
  const cd = camDist + (player.pos.y - gh > 0.05 ? (player.pos.y - gh) * 0.5 : 0);
  camera.position.set(
    camTarget.x - Math.sin(camYaw) * Math.cos(camPitch) * cd,
    camTarget.y + Math.sin(camPitch) * cd,
    camTarget.z - Math.cos(camYaw) * Math.cos(camPitch) * cd,
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
    r.chicken.update(dt, Math.hypot(b.x - a.x, b.z - a.z) > 0.02, false, y > 0.02);
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
const HINT_DESKTOP = "<b>Esc</b> 释放鼠标 <i>·</i> <b>WASD</b> 移动 <i>·</i> <b>Shift</b> 疾跑 <i>·</i> <b>空格</b> 跳 <i>·</i> <b>左键</b> 啄 <i>·</i> <b>右键</b> 扇翅 <i>·</i> <b>滚轮</b> 缩放 <i>·</i> <b>M</b> 静音";
const HINT_TOUCH = "<b>左摇杆</b> 走路 <i>·</i> <b>拖动</b> 转视角 <i>·</i> <b>轻点鸡</b> 看数据 <i>·</i> <b>双指</b> 缩放";
$('hint').innerHTML = isTouch ? HINT_TOUCH : HINT_DESKTOP;

farm.start();
requestAnimationFrame(tick);

// 等首帧画完再连：页面初始化（解析 three.js + 建场景）会长时间占住主线程，
// 那期间发起的 WebSocket 握手容易失败；画过一帧再连就稳了。
setTimeout(() => { if (net.mode !== 'online') net.connect(); }, 1200);

// 调试钩子：加 ?debug 后可拿到内部对象（自测脚本用，平时无副作用）
const DEBUG = new URLSearchParams(location.search).has('debug');
const evLog = [];                     // 最近的服务端事件（?debug 时给自测脚本看）
let dbgFrames = 0, dbgT = 0, dbgFps = 0, dbgLast = 0;
if (DEBUG) {
  window.__farm = {
    farm, player, npcs, doPeck, doWing, world, scene, camera, renderer, playerChicken, hud,
    feathers, dust, sfx, groundHeight, evLog,
    net, remotes, myName, tapSelect, pickChicken, pickByScreen, input: move, key: keys,
    boardRows,
    get peckCd() { return peckCd; },
    get fps() { return dbgFps; },
    get camDist() { return camDist; },
    set camDist(v) { camDist = v; },
    get camYaw() { return camYaw; },
    set camYaw(v) { camYaw = v; },
    get mode() { return net.online ? 'online' : 'local'; },
    get hotSentSig() { return hotSent; },
    get myCc() { return myCc; },          // 你自己那只鸡的国旗码（服务端按 IP 下发）
    get npcRosterSig() { return npcRosterSent; },
    randomSpawn,
  };
}
