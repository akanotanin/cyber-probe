// NPC·大白鹅：服务端权威的巡场鹅 —— 有领地意识（走近就追、追上就啄）、被啄就掉头跑，
// 60 血，被玩家啄倒照样记一个啄倒数（榜上所有大鹅合起来算一行）。
//
// 模型按源站 public/js/npc.js 的 buildGoose() 移植（方块拼装：白身子 + 长脖子 + 橙喙 + 橙脚），
// 名牌沿用我们这个站玩家牌那一套（名字 + 血条）—— 源站的大白鹅牌也只有这两样。
//
// 对外接口与 js/npc.js 的 Npc 一致（pos / st / update / pushBuf / setRemote / dispose / addTo），
// 并且把模型挂在 `chicken` 上：main.js 里那些 npc.chicken.* 的老路径（射线点选、羽毛颜色、
// 名牌远处淡出、手机上放大点击球）不用改就能用。
import * as THREE from 'three';
import { sample, push } from './interp.js';

// 与 server/farm_server.py 的 GOOSE_* 必须一致（tools/ci.sh 第 2 步会点名核对）——
// 客户端只在"详情卡片给玩家看的说明文字"里用它们，判定全在服务端。
export const GOOSE = {
  name: 'NPC·大白鹅',
  maxHp: 60,
  chaseR: 2.5,     // 领地半径：走进这个圈才会被追
  leash: 6.5,      // 追出这么远就放弃
  peckR: 1.15,     // 追到这么近就啄
  dmg: 6,          // 每口伤害
  cd: 1.2,         // 啄击冷却
  fleeT: 2.2,      // 被啄之后跑多久
  baseScale: 1.25, // 源站大白鹅的 group.scale（鸡是 1.18）
};

const WHITE = 0xfafafa, ORANGE = 0xe08a2b, DARK = 0x1a1a1a;
const PECK_ANIM = 0.35;        // 啄击动作时长（与鸡一致）
const KO_T = 4.5;              // 被啄倒后本地侧翻的时长（服务端 3.5 秒后下发复活）
const BODY_Y = 0.42;           // 躯干离地高度
const WALK_REF = 1.4;          // 步态幅度归一用的参考速度（鹅比鸡快一点）

// 状态位：与 server/farm_server.py、js/chicken.js 三处必须一致
const ST_DEAD = 1, ST_PECK = 2, ST_RUN = 4, ST_FLAP = 8, ST_PREEN = 16;
const ST_FLEE = 32, ST_FIGHT = 64, ST_JUMP = 128;

// 几何体缓存：几十只鹅共用同一批几何体（白身材质不能共享 —— 受击闪红是逐只改 emissive 的）
const GEO = {};
const g = (k, make) => (GEO[k] ||= make());
const ORANGE_MAT = new THREE.MeshLambertMaterial({ color: ORANGE });
const DARK_MAT = new THREE.MeshLambertMaterial({ color: DARK });

function roundRect(c, x, y, w, h, r) {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}

// 名牌：与玩家牌同尺寸（256×76 / sprite 1.5×0.45 / y1.25 —— 源站大白鹅就是这套）
const PLATE = { w: 256, h: 76, sw: 1.5, sh: 0.45, y: 1.25 };

/**
 * 大白鹅的模型与动作（外部由 Goose 驱动）。
 *
 * 动作接口与 js/chicken.js 的 Chicken 对齐：setInfo / setHp / setScale / ko / revive /
 * peck / flap / flash / update(dt, st)，另外多一个 st 状态位（服务端下发）。
 */
export class GooseBody {
  constructor() {
    this.t = Math.random() * 10;
    this.walkPhase = 0;
    this.speed = 0;
    this.peckT = 0;
    this.flapT = 0;
    this.flashT = 0;
    this.hp = GOOSE.maxHp;
    this.koT = 0;
    this.st = 0;
    this.info = null;
    this._sig = '';

    this.group = new THREE.Group();
    this.group.scale.setScalar(GOOSE.baseScale);
    this.buildBody();
    // 不可见的碰撞球：射线点选与手机加大点击范围都靠它（与鸡同一套约定）
    this.hit = new THREE.Mesh(
      g('goose-hit', () => new THREE.SphereGeometry(0.78, 10, 8)),
      new THREE.MeshBasicMaterial({ visible: false }),
    );
    this.hit.position.y = 0.75;
    this.hit.userData.chicken = this;
    this.group.add(this.hit);
    this.buildPlate();
  }

  // ---------- 建模：躯干 / 尾 / 长脖子 + 头 + 橙喙 + 眼 / 双翅 / 双腿 ----------
  buildBody() {
    const white = new THREE.MeshLambertMaterial({ color: WHITE });   // 逐只一份：受击闪红要改它
    this.bodyMat = white;
    this.bodyG = new THREE.Group();
    this.bodyG.position.y = BODY_Y;
    this.group.add(this.bodyG);

    const box = (w, h, d, m, x, y, z, parent) => {
      const mesh = new THREE.Mesh(g(`g${w},${h},${d}`, () => new THREE.BoxGeometry(w, h, d)), m);
      mesh.position.set(x, y, z);
      mesh.castShadow = true;
      (parent || this.bodyG).add(mesh);
      return mesh;
    };
    const limb = (w, h, m) => {                                        // 枢轴在顶端（摆动用）
      const geo = g(`gl${w},${h}`, () => {
        const bg = new THREE.BoxGeometry(w, h, w);
        bg.translate(0, -h / 2, 0);
        return bg;
      });
      const mesh = new THREE.Mesh(geo, m);
      mesh.castShadow = true;
      return mesh;
    };

    box(0.34, 0.30, 0.52, white, 0, 0, 0);                             // 躯干
    const tail = box(0.16, 0.10, 0.14, white, 0, 0.10, -0.30);         // 尾巴（翘起）
    tail.rotation.x = -0.5;

    // 长脖子 + 头（啄击时整组前倾）
    this.headG = new THREE.Group();
    this.headG.position.set(0, 0.12, 0.22);
    this.bodyG.add(this.headG);
    box(0.10, 0.40, 0.10, white, 0, 0.20, 0.02, this.headG);           // 脖子
    box(0.15, 0.15, 0.20, white, 0, 0.44, 0.05, this.headG);           // 头
    const beak = new THREE.Mesh(g('goose-beak', () => new THREE.ConeGeometry(0.045, 0.16, 4)), ORANGE_MAT);
    beak.rotation.x = Math.PI / 2;
    beak.position.set(0, 0.43, 0.20);
    beak.castShadow = true;
    this.headG.add(beak);
    box(0.035, 0.035, 0.035, DARK_MAT, 0.08, 0.47, 0.08, this.headG);  // 两只眼睛
    box(0.035, 0.035, 0.035, DARK_MAT, -0.08, 0.47, 0.08, this.headG);

    // 翅膀（追人的时候狂扇）
    const wingGeo = g('goose-wing', () => {
      const wg = new THREE.BoxGeometry(0.05, 0.20, 0.34);
      wg.translate(0, -0.10, 0);
      return wg;
    });
    this.wingL = new THREE.Mesh(wingGeo, white);
    this.wingL.position.set(-0.20, 0.10, 0);
    this.wingR = new THREE.Mesh(wingGeo, white);
    this.wingR.position.set(0.20, 0.10, 0);
    for (const w of [this.wingL, this.wingR]) { w.castShadow = true; this.bodyG.add(w); }

    // 腿（橙色，源站只有腿没有脚掌）
    this.legs = [];
    for (const lx of [-0.09, 0.09]) {
      const leg = limb(0.05, 0.28, ORANGE_MAT);
      leg.position.set(lx, -0.14, 0);
      this.bodyG.add(leg);
      this.legs.push(leg);
    }
  }

  // ---------- 名牌：名字 + 血条 ----------
  buildPlate() {
    const c = document.createElement('canvas');
    c.width = PLATE.w; c.height = PLATE.h;
    this.plateCanvas = c;
    this.plateCtx = c.getContext('2d');
    this.tex = new THREE.CanvasTexture(c);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    this.sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.tex, transparent: true }));
    this.sprite.scale.set(PLATE.sw, PLATE.sh, 1);
    this.sprite.position.y = PLATE.y;
    this.group.add(this.sprite);
    this.drawPlate();
  }

  drawPlate() {
    const c = this.plateCtx, W = PLATE.w, H = PLATE.h;
    const i = this.info || {};
    c.clearRect(0, 0, W, H);
    // 底卡与名称样式跟玩家牌一致（源站大白鹅牌也是 rgba(15,25,10,.55) r14 / bold 21px）
    c.fillStyle = 'rgba(15,25,10,0.55)';
    roundRect(c, 2, 2, W - 4, H - 4, 14); c.fill();
    c.fillStyle = '#fff';
    c.font = 'bold 21px "Microsoft YaHei","PingFang SC",sans-serif';
    c.textBaseline = 'middle';
    c.fillText(String(i.title || GOOSE.name), 18, 24);

    // 血条（槽浅、填充亮 —— 与鸡的血条同一套画法）
    const bx = 14, by = H - 20, bw = W - 28, bh = 9;
    c.fillStyle = 'rgba(255,255,255,0.22)';
    roundRect(c, bx, by, bw, bh, 4); c.fill();
    const pct = Math.max(0, Math.min(1, this.hp / GOOSE.maxHp));
    c.fillStyle = pct > 0.5 ? '#7ec850' : pct > 0.25 ? '#e8b23a' : '#e05252';
    if (pct > 0.01) { roundRect(c, bx, by, Math.max(bh, bw * pct), bh, 4); c.fill(); }
    this.tex.needsUpdate = true;
  }

  setInfo(info) {
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

  /** 体型倍率：服务端对大白鹅固定下发 1.0（它不属于任何探针，不随负载变） */
  setScale(s) {
    const v = Math.max(0.8, Math.min(1.4, Number(s) || 1));
    if (this.scaleApplied === v) return;
    this.scaleApplied = v;
    this.group.scale.setScalar(GOOSE.baseScale * v);
  }

  peck() { this.peckT = PECK_ANIM; }
  flap() { this.flapT = 0.45; }
  flash() { this.flashT = 0.18; }
  ko() { this.koT = KO_T; }
  revive() { this.koT = 0; this.group.rotation.z = 0; }

  /**
   * 每帧动画。
   * @param {number} dt 帧间隔
   * @param {number} st 服务端下发的状态位
   * @param {boolean} [moving] 服务端说它这一拍在动（不传就按模型实际位移自己判）
   */
  update(dt, st = 0, moving = null) {
    this.t += dt;
    this.st = st;
    const dead = this.koT > 0;
    if (dead) this.koT = Math.max(0, this.koT - dt);
    const fleeing = !!(st & ST_FLEE);

    // 步态按"这一帧实际走过的米数"推进（远端快照有量化噪声，用速度会抽腿）
    const lx = this._lastX ?? this.group.position.x;
    const lz = this._lastZ ?? this.group.position.z;
    const moved = (moving === false) ? 0 : Math.min(1, Math.hypot(this.group.position.x - lx, this.group.position.z - lz));
    this._lastX = this.group.position.x;
    this._lastZ = this.group.position.z;
    const inst = moved / Math.max(1e-3, dt);
    this.speed += (inst - this.speed) * Math.min(1, dt * 8);
    const amp = Math.min(1, this.speed / WALK_REF);

    this.peckT = Math.max(0, this.peckT - dt);
    this.flapT = Math.max(0, this.flapT - dt);
    this.flashT = Math.max(0, this.flashT - dt);
    if (this.bodyMat.emissive) this.bodyMat.emissive.setHex(this.flashT > 0 ? 0x882222 : 0x000000);

    // 被啄倒：整体侧翻（与鸡一致）
    const targetZ = dead ? 1.45 : 0;
    this.group.rotation.z += (targetZ - this.group.rotation.z) * Math.min(1, dt * 8);

    if (dead) return;

    this.walkPhase += moved * 9;
    const swing = Math.sin(this.walkPhase) * 0.8 * amp;
    this.legs[0].rotation.x = swing;
    this.legs[1].rotation.x = -swing;
    this.bodyG.rotation.z = Math.sin(this.walkPhase * 0.5) * 0.1 * amp;
    this.bodyG.rotation.x = amp * 0.06 + (fleeing ? 0.16 : 0);          // 逃窜时头压低往前冲
    this.bodyG.position.y = BODY_Y + Math.abs(Math.sin(this.walkPhase)) * 0.04 * amp;

    // 头：啄击 > 闲时啄地 > 走路点头
    let headX = 0;
    if (this.peckT > 0) {
      const p = 1 - this.peckT / PECK_ANIM;
      headX = Math.sin(Math.min(1, Math.max(0, p)) * Math.PI) * 1.0;
    } else if (st & ST_PECK) {
      headX = (1 - Math.cos(this.t * 3.4)) * 0.5;
    } else if (this.speed > 0.3) {
      headX = Math.abs(Math.sin(this.walkPhase)) * 0.16;
    }
    this.headG.rotation.x += (headX - this.headG.rotation.x) * Math.min(1, dt * 12);
    if (fleeing) this.headG.rotation.x = Math.max(this.headG.rotation.x, 0.24);   // 撅着脖子跑
    if (st & ST_PREEN) this.headG.rotation.y += (0.9 - this.headG.rotation.y) * Math.min(1, dt * 5);
    else this.headG.rotation.y += (0 - this.headG.rotation.y) * Math.min(1, dt * 5);

    // 翅膀：扇翅/振翅 > 逃窜扑腾 > 奔跑半张 > 收拢
    let flap = 0.1;
    if (this.flapT > 0 || (st & ST_FLAP)) flap = Math.sin(this.t * 40) * 0.85 + 0.8;
    else if (fleeing) flap = Math.sin(this.t * 34) * 0.7 + 0.75;
    else if (st & ST_RUN) flap = Math.sin(this.t * 26) * 0.6 + 0.7;
    else if (st & ST_JUMP) flap = Math.sin(this.t * 30) * 0.7 + 0.9;
    this.wingL.rotation.z += (-flap - this.wingL.rotation.z) * Math.min(1, dt * 12);
    this.wingR.rotation.z += (flap - this.wingR.rotation.z) * Math.min(1, dt * 12);
  }

  dispose() {
    this.group.traverse((o) => {
      if (o.material && o.material.map) o.material.map.dispose();
      if (o.material && o.material !== ORANGE_MAT && o.material !== DARK_MAT) o.material.dispose();
    });
  }
}

/**
 * NPC·大白鹅 —— 和 js/npc.js 的 Npc 同接口的控制器：位置/血量/状态全部来自服务端快照。
 *
 * 它由服务端自己放养（不是探针数据），所以没有 farm/节点/任务可同步：名牌内容固定，
 * 唯一会变的是血量与动作。
 */
export class Goose {
  constructor() {
    this.kind = 'goose';
    this.nodeId = null;
    this.taskId = null;
    this.id = null;                       // 由 main.js 按服务端下发的 id（g1/g2…）写进来
    this.hp = GOOSE.maxHp;
    this.st = 0;
    this.yaw = Math.random() * 6.28;
    this.remote = true;                   // 只有服务端权威这一种形态（与鸡一致）
    this.buf = [];                        // 快照缓冲（110ms 延迟插值）
    this._ko = false;
    this.pos = new THREE.Vector3();
    this.info = { kind: 'goose', title: GOOSE.name, code: '', online: true };

    this.chicken = new GooseBody();       // main.js 里所有 npc.chicken.* 都指向它
    this.chicken.ref = this;
    this.chicken.group.userData.npc = this;
    this.chicken.setInfo(this.info);
  }

  addTo(scene) { scene.add(this.chicken.group); return this; }
  get group() { return this.chicken.group; }

  /** 大白鹅没有探针数据可同步：保证名牌上是它的名字就行 */
  sync() { this.chicken.setInfo(this.info); }

  setRemote(on) {
    this.remote = !!on;
    this.buf.length = 0;
    this._ko = false;
  }

  pushBuf(x, z, y, yaw, hp, st, scale) {
    push(this.buf, x, z, y, yaw, hp, st, scale);
  }

  update(dt) { this.updateRemote(dt); }

  /** 位置/血量/倒地/状态全部按服务端快照插值（客户端不跑 AI、不结算伤害） */
  updateRemote(dt) {
    const s = sample(this.buf);
    if (!s) return;
    this.pos.set(s.x, s.y, s.z);
    this.yaw = s.yaw;
    // ⚠ 逻辑坐标与模型位置**两条都要写**：只改 pos 会出现"逻辑在走、模型站着"
    this.group.position.set(s.x, s.y, s.z);
    this.group.rotation.y = s.yaw;
    this.st = s.st;
    if (s.hp !== this.hp) { this.hp = s.hp; this.chicken.setHp(Math.round(s.hp)); }
    if (s.scale != null) this.chicken.setScale(s.scale);
    const ko = !!(s.st & 1);
    if (ko !== this._ko) {
      this._ko = ko;
      if (ko) this.chicken.ko(); else this.chicken.revive();
    } else if (ko) {
      this.chicken.koT = Math.max(this.chicken.koT, 0.2);   // 服务端还没复活就别自己站起来
    }
    this.chicken.update(dt, s.st);
  }

  dispose(scene) {
    scene.remove(this.group);
    this.chicken.dispose();
  }
}
