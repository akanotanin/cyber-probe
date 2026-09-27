// 低多边形方块鸡：建模（基本几何体拼装）、5 套写实羽色、动作（走路摇摆 / 啄击 / 滞空 / 疾跑 / 扇翅 / 被啄倒）、
// 头顶数据名牌（国旗 + 名称 + CPU/内存圆环 + 运行指标 + 徽章 + 血条）。
// 几何比例、配色、动画曲线对齐参考站观感；名牌内容为本项目的探针数据（不含主机名/IP）。

import * as THREE from 'three';

// 5 套写实羽色：白羽 / 黄褐 / 乌骨 / 油鸡金 / 麻鸡
export const PALETTES = [
  { body: 0xf5f0e6, wing: 0xe8e0d0, tail: 0xd8cfc0 },
  { body: 0xb5793a, wing: 0xa3682c, tail: 0x8a5522 },
  { body: 0x3a3a3a, wing: 0x2c2c2c, tail: 0x1f1f1f },
  { body: 0xe0b34a, wing: 0xd0a038, tail: 0xb98a2c },
  { body: 0x8a6a52, wing: 0x7a5a44, tail: 0x6a4a38 },
];
const ORANGE = 0xd98a2b, RED = 0xc93434, DARK = 0x1a1a1a;

export const PECK_ANIM = 0.35;   // 啄击动作时长
export const MAX_HP = 100;
const WALK_REF = 3.5;            // 玩家的参考步速（用于步态幅度归一）

// ---- 名牌小标的画法与配色（对齐源站名牌「离线」胶囊的实际数值）----
// 源站：bold 17px / 宽 = 文字宽 + 22 / 高 25 / 圆角 8 / 白字居中 / rgba(200,70,70,0.9)
const CHIP_FONT = 'bold 17px "Microsoft YaHei","PingFang SC",sans-serif';
const CHIP_H = 25, CHIP_R = 8, CHIP_PAD = 22;
const CHIP_BAD = 'rgba(200,70,70,0.9)';     // 暴躁 / 离线 —— 源站原色
const CHIP_WARN = 'rgba(198,124,40,0.9)';   // 网差（我们自己的一档，取同族琥珀色）
const CHIP_FIGHT = 'rgba(178,52,52,0.9)';   // 回击
const CHIP_FLEE = 'rgba(150,99,26,0.9)';    // 逃窜
// 状态位：与 server/farm_server.py 的 ST_* 必须一致
const ST_DEAD = 1, ST_PECK = 2, ST_RUN = 4, ST_FLAP = 8, ST_PREEN = 16;
const ST_FLEE = 32, ST_FIGHT = 64;   // 被攻击之后：逃窜 / 回击（服务端判定，客户端只表现）
const ST_JUMP = 128;                 // 起跳滞空（服务端下发时缩腿扑腾 + 翅膀扑腾）

const mat = (c) => new THREE.MeshLambertMaterial({ color: c });

// 几何体缓存：几十只鸡共用同一批几何体，减少显存与 GC
const GEO = {};
const g = (k, make) => (GEO[k] ||= make());

function shade(hex, k) {
  const r = Math.round(((hex >> 16) & 255) * k);
  const gg = Math.round(((hex >> 8) & 255) * k);
  const b = Math.round((hex & 255) * k);
  return (r << 16) | (gg << 8) | b;
}

// ---- 国旗图片缓存（flagcdn.com 带 CORS 头；加载失败退化为文字/表情）----
const flagCache = new Map();
function flagEntry(code, onReady) {
  if (!code || !/^[A-Za-z]{2}$/.test(code)) return null;
  let e = flagCache.get(code);
  if (!e) {
    const img = new Image();
    e = { img, ok: false, done: false, cbs: [] };
    img.crossOrigin = 'anonymous';
    const finish = (ok) => { e.ok = ok; e.done = true; e.cbs.forEach((f) => f()); e.cbs = []; };
    img.onload = () => finish(true);
    img.onerror = () => finish(false);
    img.src = `https://flagcdn.com/w40/${code.toLowerCase()}.png`;
    flagCache.set(code, e);
  }
  if (!e.done && onReady) e.cbs.push(onReady);
  return e;
}

function roundRect(c, x, y, w, h, r) {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}

const loadColor = (p) => (p > 0.8 ? '#e05252' : p > 0.5 ? '#e8b23a' : '#7ec850');

// 圆环进度（环内写数值/文字）
function ring(c, cx, cy, r, pct, color, label) {
  c.lineWidth = 7;
  c.strokeStyle = 'rgba(255,255,255,0.18)';
  c.beginPath(); c.arc(cx, cy, r, 0, Math.PI * 2); c.stroke();
  c.strokeStyle = color;
  c.beginPath();
  c.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + Math.min(1, Math.max(0, pct)) * Math.PI * 2);
  c.stroke();
  c.fillStyle = '#fff';
  c.font = 'bold 12px Consolas,monospace';
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  c.fillText(label, cx, cy + 1);
  c.textAlign = 'left';
}

// 名牌尺寸：探针鸡（大号数据牌）/ 网站鸡（紧凑卡片）/ 玩家
const PLATE = {
  probe: { w: 380, h: 170, sw: 2.9, sh: 1.3, y: 1.45 },
  web: { w: 280, h: 110, sw: 2.2, sh: 0.86, y: 1.3 },
  player: { w: 256, h: 76, sw: 1.5, sh: 0.45, y: 1.16 },
};

export class Chicken {
  /**
   * @param {object} o
   *   kind   'player' | 'probe' | 'web'   —— 决定体量与名牌样式
   *   color   十六进制羽色（省略则用 colorIdx 或随机抽一套写实羽色）
   *   colorIdx 直接指定羽色编号 0-4
   *   scale  整体缩放（默认 1.18，与参考站一致）
   */
  constructor({ color, colorIdx, kind = 'probe', scale = 1.18 } = {}) {
    this.kind = kind;
    this.t = Math.random() * 10;
    this.walkPhase = 0;
    this.speed = 0;
    this.peckT = 0;
    this.flapT = 0;
    this.flashT = 0;
    this.idlePeckIn = 2 + Math.random() * 4;   // 闲逛时随机啄地
    this.hp = MAX_HP;
    this.koT = 0;
    this.info = null;
    this._sig = '';

    // 选羽色：指定色号 > 指定色值（派生深浅）> 随机
    if (colorIdx == null) colorIdx = color == null ? Math.floor(Math.random() * PALETTES.length) : null;
    this.pal = colorIdx != null && PALETTES[colorIdx]
      ? PALETTES[colorIdx]
      : { body: color, wing: shade(color, 0.92), tail: shade(color, 0.8) };

    this.group = new THREE.Group();
    this.group.scale.setScalar(scale);
    this.scaleApplied = 1;          // 体型随负载缩放：记住上一次下发的倍率（避免每帧 setScalar）
    this.buildBody();
    // 不可见的碰撞球：射线点选与手机加大点击范围都靠它
    this.hit = new THREE.Mesh(
      g('hit', () => new THREE.SphereGeometry(0.78, 10, 8)),
      new THREE.MeshBasicMaterial({ visible: false }),
    );
    this.hit.position.y = 0.75;
    this.hit.userData.chicken = this;
    this.group.add(this.hit);
    this.buildPlate();
  }

  // ---------- 建模：躯干/尾羽/颈/头/冠/喙/肉垂/眼/双翅/双腿 ----------
  buildBody() {
    const p = this.pal;
    this.bodyMat = mat(p.body);
    const wingMat = mat(p.wing);
    const tailMat = mat(p.tail);
    const orangeMat = mat(ORANGE), redMat = mat(RED), darkMat = mat(DARK);

    const box = (w, h, d, m, x, y, z, parent) => {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
      mesh.position.set(x, y, z);
      mesh.castShadow = true;
      (parent || this.bodyG).add(mesh);
      return mesh;
    };

    this.bodyG = new THREE.Group();
    this.bodyG.position.y = 0.42;
    this.group.add(this.bodyG);

    box(0.5, 0.42, 0.62, this.bodyMat, 0, 0, 0);                       // 躯干
    for (const [dx, rz] of [[0, 0], [0.06, 0.3], [-0.06, -0.3]]) {      // 尾羽三片
      const t = box(0.06, 0.26, 0.04, tailMat, 0, 0.16, -0.34);
      t.position.x = dx * 0.9;
      t.rotation.x = -0.55; t.rotation.z = rz;
    }

    // 头颈（啄击时整组前倾）
    this.headG = new THREE.Group();
    this.headG.position.set(0, 0.16, 0.28);
    this.bodyG.add(this.headG);
    box(0.14, 0.18, 0.14, this.bodyMat, 0, 0.05, 0.03, this.headG);     // 颈
    box(0.24, 0.22, 0.24, this.bodyMat, 0, 0.22, 0.05, this.headG);     // 头
    box(0.06, 0.1, 0.18, redMat, 0, 0.37, 0.03, this.headG);            // 鸡冠
    const beak = new THREE.Mesh(g('beak', () => new THREE.ConeGeometry(0.05, 0.18, 4)), orangeMat);
    beak.rotation.x = Math.PI / 2;
    beak.position.set(0, 0.2, 0.24);
    beak.castShadow = true;
    this.headG.add(beak);
    box(0.05, 0.08, 0.05, redMat, 0, 0.12, 0.2, this.headG);            // 肉垂
    box(0.035, 0.05, 0.035, darkMat, 0.125, 0.26, 0.1, this.headG);     // 眼
    box(0.035, 0.05, 0.035, darkMat, -0.125, 0.26, 0.1, this.headG);

    // 翅膀（几何体先下移，枢轴落在肩部）
    const wingGeo = g('wing', () => {
      const wg = new THREE.BoxGeometry(0.06, 0.28, 0.42);
      wg.translate(0, -0.14, 0);
      return wg;
    });
    this.wingL = new THREE.Mesh(wingGeo, wingMat);
    this.wingL.position.set(-0.27, 0.1, -0.02);
    this.wingR = new THREE.Mesh(wingGeo, wingMat);
    this.wingR.position.set(0.27, 0.1, -0.02);
    for (const w of [this.wingL, this.wingR]) { w.castShadow = true; this.bodyG.add(w); }

    // 腿（枢轴在髋部）+ 脚
    const legGeo = g('leg', () => {
      const lg = new THREE.BoxGeometry(0.055, 0.24, 0.055);
      lg.translate(0, -0.12, 0);
      return lg;
    });
    const footGeo = g('foot', () => new THREE.BoxGeometry(0.1, 0.03, 0.14));
    this.legL = new THREE.Group(); this.legL.position.set(-0.11, -0.2, 0.02);
    this.legR = new THREE.Group(); this.legR.position.set(0.11, -0.2, 0.02);
    for (const [leg, side] of [[this.legL, -1], [this.legR, 1]]) {
      const thigh = new THREE.Mesh(legGeo, orangeMat);
      thigh.castShadow = true;
      const foot = new THREE.Mesh(footGeo, orangeMat);
      foot.position.set(0, -0.235, 0.04);
      leg.add(thigh, foot);
      this.bodyG.add(leg);
    }
  }

  // ---------- 名牌 ----------
  buildPlate() {
    const P = PLATE[this.kind] || PLATE.probe;
    this.plate = P;
    const c = document.createElement('canvas');
    c.width = P.w; c.height = P.h;
    this.plateCanvas = c;
    this.plateCtx = c.getContext('2d');
    this.tex = new THREE.CanvasTexture(c);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    this.sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.tex, transparent: true }));
    this.sprite.scale.set(P.sw, P.sh, 1);
    this.sprite.position.y = P.y;
    this.group.add(this.sprite);
    this.drawPlate();
  }

  setInfo(info) {
    // 数据没变就不重画 canvas（每帧重绘会拖帧率）
    const sig = JSON.stringify(info);
    if (sig === this._sig) return;
    this._sig = sig;
    this.info = info;
    this.drawPlate();
  }

  setHp(hp) {
    if (hp === this.hp) return;
    this.hp = hp;
    this.drawPlate();
  }

  // 名牌上的小标（可以同时挂几个）：
  //   「离线 / 📶网差 / 🔥暴躁」= 它是只什么鸡（来自探针数据）
  //   「⚔️回击 / 💨逃窜」    = 它此刻在干什么（来自服务端的 ST_* 状态位）
  // 画法与配色对齐源站名牌的「离线」胶囊（bold 17px / 高 25 / 圆角 8 / 内边距 22 / 白字居中）。
  chips() {
    const i = this.info;
    if (!i) return [];
    const out = [];
    if (i.kind === 'probe' && i.online === false) out.push({ text: '离线', bg: CHIP_BAD });
    if (i.netWorst) out.push({ text: '📶 网差', bg: CHIP_WARN });
    if (i.hot) out.push({ text: '🔥 暴躁', bg: CHIP_BAD });
    if (this.st & ST_FIGHT) out.push({ text: '⚔️ 回击', bg: CHIP_FIGHT });
    if (this.st & ST_FLEE) out.push({ text: '💨 逃窜', bg: CHIP_FLEE });
    return out;
  }

  /**
   * 体型随负载缩放（服务端在快照里下发 scale，1.0 ~ 1.35）。
   * 与参考站一模一样的做法：`group.scale = 1.18 * scale`，名牌尺寸不变。
   */
  setScale(s) {
    const v = Math.max(0.8, Math.min(1.4, Number(s) || 1));
    if (this.scaleApplied === v) return;
    this.scaleApplied = v;
    this.group.scale.setScalar(1.18 * v);
  }

  hpBar(c, x, y, w, h) {
    c.fillStyle = 'rgba(255,255,255,0.22)';
    roundRect(c, x, y, w, h, 4); c.fill();
    const pct = Math.max(0, this.hp) / MAX_HP;
    c.fillStyle = pct > 0.5 ? '#7ec850' : pct > 0.25 ? '#e8b23a' : '#e05252';
    if (pct > 0.01) { roundRect(c, x, y, Math.max(h, w * pct), h, 4); c.fill(); }
  }

  /** 画一排小标（右对齐），返回这一排的总宽度 */
  chipRow(c, right, y, list) {
    if (!list || !list.length) return 0;
    c.font = CHIP_FONT;
    const w = list.map((b) => c.measureText(b.text).width + CHIP_PAD);
    const gap = 6;
    const total = w.reduce((s, x) => s + x, 0) + (list.length - 1) * gap;
    let x = right - total;
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    list.forEach((b, k) => {
      c.fillStyle = b.bg;
      roundRect(c, x, y - CHIP_H / 2, w[k], CHIP_H, CHIP_R); c.fill();
      c.fillStyle = '#fff';
      c.fillText(b.text, x + w[k] / 2, y + 1);
      x += w[k] + gap;
    });
    c.textAlign = 'left';
    return total;
  }

  drawFlag(c, code, x, y, w, h, emoji) {
    const e = flagEntry(code, () => this.drawPlate());
    if (e && e.ok) {
      c.save();
      roundRect(c, x, y, w, h, 5); c.clip();
      c.drawImage(e.img, x, y, w, h);
      c.restore();
      c.strokeStyle = 'rgba(255,255,255,0.5)'; c.lineWidth = 1.5;
      roundRect(c, x, y, w, h, 5); c.stroke();
      return;
    }
    c.fillStyle = '#fff';
    c.textBaseline = 'middle';
    if (/^[A-Za-z]{2}$/.test(code || '')) {
      c.font = 'bold 19px Consolas,sans-serif';
      c.fillText(code.toUpperCase(), x + 4, y + h / 2);
    } else {
      c.font = '20px "Segoe UI Emoji",sans-serif';
      c.fillText(emoji || '🌐', x + 2, y + h / 2);
    }
  }

  drawPlate() {
    const kind = this.kind;
    if (kind === 'web') return this.drawWebPlate();
    if (kind === 'player') return this.drawPlayerPlate();
    return this.drawProbePlate();
  }

  // 探针鸡：国旗 + 名称 + CPU/内存圆环 + 运行指标三行 + 机型行 + 徽章 + 血条
  drawProbePlate() {
    const c = this.plateCtx, W = this.plate.w, H = this.plate.h;
    const i = this.info || {};
    c.clearRect(0, 0, W, H);
    // 底卡色与参考站完全一致（探针鸡/网站鸡 0.6）
    c.fillStyle = 'rgba(15,25,10,0.6)';
    roundRect(c, 2, 2, W - 4, H - 4, 16); c.fill();

    this.drawFlag(c, i.code, 14, 12, 42, 28, '🌐');

    // 名称（超长截断，留出右侧圆环位置）
    c.fillStyle = '#fff';
    c.font = 'bold 22px "Microsoft YaHei","PingFang SC",sans-serif';
    c.textBaseline = 'middle';
    let name = String(i.title || '');
    while (name.length > 4 && c.measureText(name).width > 246) name = name.slice(0, -2);
    c.fillText(name, 66, 26);

    // 右侧两个圆环进度（CPU / 内存 或 延迟 / 丢包）
    c.font = 'bold 22px "Microsoft YaHei",sans-serif';
    const rings = i.rings || [];
    const ringY = [40, 108];
    rings.slice(0, 2).forEach((r, k) => {
      const cy = ringY[k];
      const txt = r.text != null ? String(r.text) : `${Math.round(r.pct || 0)}%`;
      ring(c, W - 44, cy, 16, (r.pct || 0) / 100, r.color || loadColor((r.pct || 0) / 100), txt);
      c.font = '13px "Microsoft YaHei",sans-serif';
      c.fillStyle = '#9db884';
      c.textAlign = 'center';
      c.fillText(String(r.label || '').replace(/ms|%/g, ''), W - 44, cy + 32);
      c.textAlign = 'left';
    });

    // 左侧三行数据 + 底部机型行（灰色小字）
    const rows = i.rows || [];
    c.font = '17px Consolas,"Microsoft YaHei",monospace';
    c.fillStyle = '#cfe8b0';
    c.fillText(String(rows[0] || ''), 16, 56);
    c.fillText(String(rows[1] || ''), 16, 86);
    c.fillText(String(rows[2] || ''), 16, 116);
    const b = this.chips();
    const used = this.chipRow(c, W - 60, 140.5, b);
    let typeLine = String(rows[3] || '');
    c.font = '14px "Microsoft YaHei",sans-serif';
    c.fillStyle = '#9db884';
    const maxW = W - 32 - (used ? used + 10 : 0);
    while (typeLine.length > 4 && c.measureText(typeLine).width > maxW) typeLine = typeLine.slice(0, -2);
    if (typeLine) c.fillText(typeLine, 16, 142);

    this.hpBar(c, 14, H - 19, W - 28, 7);
    this.tex.needsUpdate = true;
  }

  // 网站鸡：国旗 + 名称 + 在测数量与平均延迟 + 探测目标域名 + 徽章 + 血条
  drawWebPlate() {
    const c = this.plateCtx, W = this.plate.w, H = this.plate.h;
    const i = this.info || {};
    c.clearRect(0, 0, W, H);
    // 底卡色与参考站完全一致（探针鸡/网站鸡 0.6）
    c.fillStyle = 'rgba(15,25,10,0.6)';
    roundRect(c, 2, 2, W - 4, H - 4, 16); c.fill();

    this.drawFlag(c, i.code, 14, 12, 42, 28, '🌐');

    c.fillStyle = '#fff';
    c.font = 'bold 22px "Microsoft YaHei","PingFang SC",sans-serif';
    c.textBaseline = 'middle';
    let name = String(i.title || '');
    while (name.length > 4 && c.measureText(name).width > W - 80) name = name.slice(0, -2);
    c.fillText(name, 66, 26);

    const rings = i.rings || [];
    const lat = rings[0];
    c.font = 'bold 21px "Microsoft YaHei",sans-serif';
    c.fillStyle = lat && lat.text != null ? (lat.color || '#cfe8b0') : '#9db884';
    c.fillText(lat && lat.text != null ? `平均 ${lat.text} ms` : '检测中…', 16, 62);

    const b = this.chips();
    const used = this.chipRow(c, W - 14, 60.5, b);
    let sub = String(i.sub || '');
    c.font = '13px Consolas,monospace';
    c.fillStyle = '#9db884';
    const maxW = W - 32 - (used ? used + 8 : 0);
    while (sub.length > 6 && c.measureText(sub).width > maxW) sub = sub.slice(0, -2);
    if (sub) c.fillText(sub, 16, 88);

    this.hpBar(c, 14, H - 17, W - 28, 6);
    this.tex.needsUpdate = true;
  }

  // 玩家：国旗/表情 + 名字 + 战绩 + 血条
  drawPlayerPlate() {
    const c = this.plateCtx, W = this.plate.w, H = this.plate.h;
    const i = this.info || {};
    c.clearRect(0, 0, W, H);
    c.fillStyle = 'rgba(15,25,10,0.55)';      // 玩家牌：与参考站 Chicken 牌一致
    roundRect(c, 2, 2, W - 4, H - 4, 14); c.fill();

    this.drawFlag(c, i.code, 12, 10, 40, 27, '🐔');

    c.fillStyle = '#fff';
    c.font = 'bold 21px "Microsoft YaHei","PingFang SC",sans-serif';
    c.textBaseline = 'middle';
    let name = String(i.title || '');
    while (name.length > 3 && c.measureText(name).width > W - 130) name = name.slice(0, -2);
    c.fillText(name, 62, 24);

    this.hpBar(c, 14, H - 20, W - 28, 9);
    this.tex.needsUpdate = true;
  }

  // ---------- 动作触发 ----------
  peck() { this.peckT = PECK_ANIM; }
  flap() { this.flapT = 0.45; }
  flash() { this.flashT = 0.18; }
  ko() { this.koT = 4.5; }
  revive() { this.koT = 0; this.group.rotation.z = 0; }

  /**
   * 每帧动画。
   * @param {number} dt 帧间隔
   * @param {boolean} moving 是否有移动输入（腿停下来的判据）
   * @param {boolean} running 是否疾跑（翅膀微张）
   * @param {boolean} airborne 是否滞空（缩腿扑腾）
   */
  update(dt, moving = false, running = false, airborne = false, st = 0) {
    this.t += dt;
    this.st = st;
    // 名牌小标里「⚔️回击 / 💨逃窜」跟着状态位变 → 变了才重画一次名牌（只关心这两位，不会每帧重绘）
    const stSig = st & (ST_FLEE | ST_FIGHT);
    if (stSig !== this._chipSig) { this._chipSig = stSig; this.drawPlate(); }
    const fleeing = !!(st & ST_FLEE);
    const isNpc = this.kind !== 'player';
    const dead = this.koT > 0;
    if (dead) this.koT = Math.max(0, this.koT - dt);

    // 速度估计：用“这一帧实际走过的距离”而不是输入，远端快照的量化噪声会被平滑掉
    const lx = this._lastX ?? this.group.position.x;
    const lz = this._lastZ ?? this.group.position.z;
    const moved = moving ? Math.min(1, Math.hypot(this.group.position.x - lx, this.group.position.z - lz)) : 0;
    this._lastX = this.group.position.x;
    this._lastZ = this.group.position.z;
    const inst = moved / Math.max(1e-3, dt);
    this.speed += (inst - this.speed) * Math.min(1, dt * 8);
    const speed = this.speed;
    this.moveAmp = Math.min(1, speed / (isNpc ? 1.6 : WALK_REF));

    this.peckT = Math.max(0, this.peckT - dt);
    this.flapT = Math.max(0, this.flapT - dt);
    this.flashT = Math.max(0, this.flashT - dt);
    if (this.bodyMat.emissive) this.bodyMat.emissive.setHex(this.flashT > 0 ? 0x882222 : 0x000000);

    // 被啄倒：整体侧翻 + 身体下沉
    const targetZ = dead ? 1.45 : 0;
    this.group.rotation.z += (targetZ - this.group.rotation.z) * Math.min(1, dt * 8);
    this.bodyG.position.y = 0.42 - (dead ? 0.1 : 0);

    if (!dead) {
      const amp = this.moveAmp;
      // 迈步相位按实际路程推进（与地面同步，不随帧率漂移）
      this.walkPhase += moved * (isNpc ? 9 : 3.6);
      const swing = Math.sin(this.walkPhase) * (isNpc ? 0.85 : 0.75) * amp;
      this.legL.rotation.x = swing;
      this.legR.rotation.x = -swing;
      this.bodyG.rotation.z = Math.sin(this.walkPhase * 0.5) * (isNpc ? 0.15 : 0.09) * amp;
      this.bodyG.rotation.x = amp * (isNpc ? 0.1 : 0.08) + (fleeing ? 0.14 : 0);   // 逃窜时身子压更低

      // 翅膀：扇翅攻击 > 振翅(闲时) > 逃窜扑腾 > 滞空扑腾 > 疾跑微张 > 收拢
      if (this.flapT > 0 || (this.st & ST_FLAP)) {
        const flap = Math.sin(this.t * 40) * 0.85 + 0.8;
        this.wingL.rotation.z = -flap;
        this.wingR.rotation.z = flap;
      } else if (fleeing) {
        const flap = Math.sin(this.t * 34) * 0.7 + 0.75;   // 半张着狂扑腾：惊慌逃跑的样子
        this.wingL.rotation.z = -flap;
        this.wingR.rotation.z = flap;
      } else if (airborne) {
        const flap = Math.sin(this.t * 24) * 0.55 + 0.75;
        this.wingL.rotation.z = -flap;
        this.wingR.rotation.z = flap;
        this.legL.rotation.x = this.legR.rotation.x = -0.9;   // 缩腿
      } else if (running) {
        const flap = Math.sin(this.t * 18) * 0.18 + 0.22;
        this.wingL.rotation.z = -flap;
        this.wingR.rotation.z = flap;
      } else {
        this.wingL.rotation.z += (0 - this.wingL.rotation.z) * Math.min(1, dt * 10);
        this.wingR.rotation.z += (0 - this.wingR.rotation.z) * Math.min(1, dt * 10);
      }

      // 头部：啄击 > 闲时啄地(st) > 走路点头 > 闲逛随机啄地
      let headX = 0;
      if (this.peckT > 0) {
        const p = 1 - this.peckT / PECK_ANIM;
        headX = Math.sin(Math.min(1, Math.max(0, p)) * Math.PI) * 1.15;
      } else if (this.st & ST_PECK) {
        headX = (1 - Math.cos(this.t * 3.4)) * 0.5;               // 低头—抬头慢慢来回
      } else if (speed > 0.3) {
        headX = Math.abs(Math.sin(this.walkPhase)) * (isNpc ? 0.2 : 0.12);
      } else {
        this.idlePeckIn -= dt;
        if (this.idlePeckIn < 0) {
          if (this.idlePeckIn < -PECK_ANIM) this.idlePeckIn = 2.5 + Math.random() * 4;
          else headX = Math.sin((-this.idlePeckIn / PECK_ANIM) * Math.PI) * 1.0;
        }
      }
      this.headG.rotation.x += (headX - this.headG.rotation.x) * Math.min(1, dt * 14);
      if (fleeing) this.headG.rotation.x = Math.max(this.headG.rotation.x, 0.22);   // 逃窜时脖子往前伸（撅着跑）
      // 理毛：头扭向侧面（闲时动作之一）
      const preening = !!(this.st & ST_PREEN);
      this.headG.rotation.y += ((preening ? 0.95 : 0) - this.headG.rotation.y) * Math.min(1, dt * 5);
      this.headG.position.y = 0.16 + Math.sin(this.walkPhase) * (isNpc ? 0.03 : 0.02) * amp;
      // 走路时上下颠 + 站着时的呼吸起伏
      this.bodyG.position.y += Math.abs(Math.sin(this.walkPhase)) * (isNpc ? 0.045 : 0) * amp
        + Math.sin(this.t * 2.2) * 0.012 * (1 - amp);
    }
  }

  /** 把身体也换成别的羽色（联机时按玩家 id 分配） */
  setPalette(colorIdx) {
    const p = PALETTES[colorIdx % PALETTES.length];
    if (!p) return;
    this.pal = p;
    this.bodyMat.color.setHex(p.body);
    this.wingL.material.color.setHex(p.wing);
    this.wingR.material.color.setHex(p.wing);
  }

  dispose(scene) {
    scene?.remove(this.group);
    this.group.traverse((o) => {
      if (o.material && o.material.map) o.material.map.dispose();
      if (o.material) o.material.dispose();
    });
    this.tex?.dispose();
  }
}
