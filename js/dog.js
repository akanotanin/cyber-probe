// NPC·看门狗（2026-11-01 加）：服务端权威的守院狗 —— 守在鸡舍门口，发现**暴躁鸡**或**大白鹅**
// 就冲上去咬（它不咬玩家、也不咬普通的探针鸡/网站鸡；自己打不倒）。
//
// 模型是本地 vendor/models/farm-dog-723730.js（安装时下载，与 js/models.js 同一条规矩：
// 许可不允许再分发本体，所以仓库里只有 id）。缺文件就退化成方块狗，玩法不受影响。
//
// 对外接口与 Goose/Npc 一致（pos / st / update / pushBuf / setRemote / dispose / addTo），
// 模型挂在 `chicken` 上：main.js 里 npc.chicken.* 的老路径（射线点选、名牌淡出、手机点击球）直接可用。
import * as THREE from 'three';
import { sample, push } from './interp.js';
import { importModel } from './model-base.js';

// 与 server/farm_server.py 的 DOG_* 必须一致（tools/ci.sh 第 2 步会点名核对）
export const DOG = {
  name: '🐕 看门狗',
  sense: 8.0,      // 发现暴躁鸡 / 大白鹅的距离（它只守鸡舍门口这一片）
  biteR: 1.35,     // 咬的距离
  dmg: 9,          // 每口伤害
  cd: 1.1,         // 咬的冷却
  run: 4.2,        // 追的速度
};

const DOG_ID = 'farm-dog-723730';   // 本地优先、缺了回落远端（见 js/model-base.js）
const LOAD_TIMEOUT = 7000;

// 状态位：与 server/farm_server.py、js/chicken.js 三处必须一致
const ST_PECK = 2, ST_RUN = 4, ST_JUMP = 128;

const PLATE = { w: 256, h: 76, sw: 1.5, sh: 0.45, y: 1.55 };
const BODY_Y = 0.34;
// 模型原始肩高只有 0.55m（比场上的鸡还矮，用户说"没有鸡大"）→ 整体放大 1.5 倍，
// 站高约 1.2m、体长 1.8m，比鸡明显大一号
const DOG_SCALE = 1.5;

function roundRect(c, x, y, w, h, r) {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}

/** 看门狗的模型与动作（外部由 Dog 驱动） */
export class DogBody {
  constructor() {
    this.t = Math.random() * 10;
    this.walkPhase = 0;
    this.speed = 0;
    this.biteT = 0;
    this.st = 0;
    this.info = null;
    this._sig = '';
    this._dead = false;            // dispose 后迟到的 loadModel 不能再往已摘除的 group 里 add

    this.group = new THREE.Group();
    this.bodyG = new THREE.Group();
    this.bodyG.position.y = 0;
    this.bodyG.scale.setScalar(DOG_SCALE);   // 以脚底（原点）为基准放大，脚不会陷进地里
    this.group.add(this.bodyG);

    this.buildFallback();
    this.loadModel();          // 异步：拿到 精细模型 的狗就替换掉方块版

    // 不可见的碰撞球（射线点选 / 手机加大点击范围，与鸡、鹅同一套约定）
    this.hit = new THREE.Mesh(
      new THREE.SphereGeometry(0.8, 10, 8),
      new THREE.MeshBasicMaterial({ visible: false }),
    );
    this.hit.position.y = 0.62;
    this.hit.userData.chicken = this;
    this.group.add(this.hit);

    this.buildPlate();
  }

  // ---------- 兜底：方块狗（断网 / CDN 被墙时也不至于什么都没有） ----------
  buildFallback() {
    const dark = new THREE.MeshLambertMaterial({ color: 0x2f2f2c });
    const white = new THREE.MeshLambertMaterial({ color: 0xf3efe6 });
    const box = (w, h, d, m, x, y, z, parent) => {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
      mesh.position.set(x, y + BODY_Y, z);          // bodyG 的原点在脚底
      mesh.castShadow = true;
      (parent || this.bodyG).add(mesh);
      return mesh;
    };
    const g = new THREE.Group();
    box(0.28, 0.26, 0.78, dark, 0, 0.02, 0, g);            // 躯干
    box(0.24, 0.2, 0.26, white, 0, 0.08, 0.1, g);          // 白胸
    const head = new THREE.Group();
    head.position.set(0, 0.14 + BODY_Y, 0.42);
    box(0.2, 0.18, 0.22, dark, 0, 0, 0, head);             // 头
    box(0.12, 0.08, 0.16, white, 0, -0.03, 0.14, head);    // 口鼻
    box(0.05, 0.12, 0.06, dark, -0.08, 0.12, -0.02, head); // 耳朵
    box(0.05, 0.12, 0.06, dark, 0.08, 0.12, -0.02, head);
    g.add(head);
    this.headG = head;
    const tail = box(0.07, 0.07, 0.34, white, 0, 0.14, -0.5, g);
    tail.rotation.x = -0.5;
    this.tailG = tail;
    this.legs = [];
    for (const [lx, lz] of [[-0.09, 0.26], [0.09, 0.26], [-0.09, -0.26], [0.09, -0.26]]) {
      const leg = box(0.07, 0.3, 0.07, lx < 0 && lz > 0 ? white : dark, lx, -0.2, lz, g);
      this.legs.push(leg);
    }
    this.fallback = g;
    this.bodyG.add(g);
  }

  // ---------- 精细模型（骨架上色，能摆腿/摇尾巴） ----------
  async loadModel() {
    // ?nomodels 是省流/AB 开关：方块狗已经建好，别再去下载精细狗模型
    if (typeof location !== 'undefined' && new URLSearchParams(location.search).has('nomodels')) return;
    try {
      const mod = await Promise.race([
        importModel(DOG_ID),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), LOAD_TIMEOUT)),
      ]);
      const make = mod.createAsset || mod.default;
      if (typeof make !== 'function') throw new Error('no createAsset');
      if (this._dead) return;
      const g = make();
      g.position.y = 0;                     // 模型原点就在地面（bodyG 也以脚底为原点）
      g.traverse((m) => { if (m.isMesh) { m.castShadow = true; m.receiveShadow = true; } });
      g.userData.pf = 'farm-dog';
      this.bodyG.add(g);
      this.model = g;
      const bone = (n) => g.getObjectByName(n) || null;
      this.bones = {
        head: bone('Head'), tail: bone('Tail'),
        fl: bone('LeftFrontUpLeg'), fr: bone('RightFrontUpLeg'),
        hl: bone('LeftHindUpLeg'), hr: bone('RightHindUpLeg'),
      };
      for (const b of Object.values(this.bones)) if (b) b.userData.rest = b.rotation.x;
      if (this.fallback) this.fallback.visible = false;
      window.__pfModels = (window.__pfModels || 0) + 1;
    } catch { /* 静默：保留方块狗 */ }
  }

  // ---------- 名牌：名字 + 血条（与鹅同款） ----------
  buildPlate() {
    const c = document.createElement('canvas');
    c.width = PLATE.w; c.height = PLATE.h;
    this.plateCanvas = c;
    this.plateCtx = c.getContext('2d');
    this.tex = new THREE.CanvasTexture(c);
    // ⚠ 关掉 mipmap：名牌贴图是“圆角黑卡 + 四角全透明”，mip 链会把圆角轮廓糊成一块
    //   满幅的低透明度矩形 —— 在浅色地面（土路/沙地）上看就是卡片外面多一层“透明膜”
    //   （用户 2026-11-01 截图报过）。代价是远距离文字略糙，用各向异性补一点。
    this.tex.generateMipmaps = false;
    this.tex.minFilter = THREE.LinearFilter;
    this.tex.anisotropy = 4;
    this.tex.colorSpace = THREE.SRGBColorSpace;
    // ⚠ depthWrite 必须关：SpriteMaterial 默认 depthWrite=true，名牌四角虽是全透明，却照样写深度。
    //   土路/场院/接触阴影这些“贴花”都是 transparent + depthWrite:false，排序稍一变（真机/手机上很常见）
    //   就会被名牌的透明四角挡掉 → 露出一块**直角矩形**的底色（草地上就是一块浅绿色膜，用户截图报过）。
    //   alphaTest 0.01 顺手把贴图里近乎全透明的像素丢掉，边缘不会糊成一层膜。
    this.sprite = new THREE.Sprite(new THREE.SpriteMaterial({
      map: this.tex, transparent: true, depthWrite: false,
    }));
    // ⚠ 名牌必须在透明队列里**最后**画：土路/场院/接触阴影都是巨大的透明贴花，
    //   它们的排序是按到相机的距离（巨大平面很容易被判成“更近”），
    //   一旦排在名牌后面就会**盖住名牌**（用户截图：土路纹理压在名牌上）。
    //   十 是随便挑的“排在所有场景装饰之后”的数，比自己大的只有别的名牌。
    this.sprite.renderOrder = 10;
    this.sprite.scale.set(PLATE.sw, PLATE.sh, 1);
    this.sprite.position.y = PLATE.y;
    this.group.add(this.sprite);
    this.drawPlate();
  }

  drawPlate() {
    const c = this.plateCtx, W = PLATE.w, H = PLATE.h;
    const i = this.info || {};
    c.clearRect(0, 0, W, H);
    c.fillStyle = 'rgba(15,25,10,0.55)';
    roundRect(c, 2, 2, W - 4, H - 4, 14); c.fill();
    c.fillStyle = '#fff';
    c.font = 'bold 21px "Microsoft YaHei","PingFang SC",sans-serif';
    c.textBaseline = 'middle';
    c.fillText(String(i.title || DOG.name), 18, 24);
    const bx = 14, by = H - 20, bw = W - 28, bh = 9;
    c.fillStyle = 'rgba(255,255,255,0.22)';
    roundRect(c, bx, by, bw, bh, 4); c.fill();
    c.fillStyle = '#7ec850';
    roundRect(c, bx, by, bw, bh, 4); c.fill();
    this.tex.needsUpdate = true;
  }

  setInfo(info) {
    const sig = JSON.stringify(info);
    if (sig === this._sig) return;
    this._sig = sig;
    this.info = info;
    this.drawPlate();
  }

  bite() { this.biteT = 0.35; }

  /** 每帧动画（st 是服务端状态位） */
  update(dt, st = 0) {
    this.t += dt;
    this.st = st;
    const lx = this._lastX ?? this.group.position.x;
    const lz = this._lastZ ?? this.group.position.z;
    const moved = Math.min(1, Math.hypot(this.group.position.x - lx, this.group.position.z - lz));
    this._lastX = this.group.position.x;
    this._lastZ = this.group.position.z;
    const inst = moved / Math.max(1e-3, dt);
    this.speed += (inst - this.speed) * Math.min(1, dt * 8);
    const amp = Math.min(1, this.speed / 2.2);

    this.biteT = Math.max(0, this.biteT - dt);
    this.walkPhase += moved * 14;      // 狗腿短、步频快

    const sw = Math.sin(this.walkPhase) * 0.75 * amp;
    if (this.bones) {
      const b = this.bones;
      // 对角步态：左前 + 右后 一组，右前 + 左后 一组
      if (b.fl) b.fl.rotation.x = (b.fl.userData.rest || 0) + sw;
      if (b.hr) b.hr.rotation.x = (b.hr.userData.rest || 0) + sw;
      if (b.fr) b.fr.rotation.x = (b.fr.userData.rest || 0) - sw;
      if (b.hl) b.hl.rotation.x = (b.hl.userData.rest || 0) - sw;
      if (b.tail) b.tail.rotation.y = Math.sin(this.t * (amp > 0.3 ? 9 : 4.5)) * 0.35;
      if (b.head) b.head.rotation.x = (b.head.userData.rest || 0) + (st & ST_PECK ? 0.45 : Math.abs(Math.sin(this.walkPhase)) * 0.08 * amp);
    }
    if (this.fallback && this.fallback.visible) {
      const legs = this.legs || [];
      legs[0].rotation.x = sw; legs[3].rotation.x = sw;
      legs[1].rotation.x = -sw; legs[2].rotation.x = -sw;
      this.tailG.rotation.y = Math.sin(this.t * 6) * 0.3;
      this.bodyG.position.y = Math.abs(Math.sin(this.walkPhase)) * 0.025 * amp;
    }
    if (this.model) {
      this.model.position.y = Math.abs(Math.sin(this.walkPhase)) * 0.02 * amp;
    }
    if (st & ST_JUMP) this.bodyG.position.y = 0.14;
  }

  dispose() {
    this._dead = true;
    this.group.traverse((o) => {
      if (o.geometry) o.geometry.dispose();       // 方块狗每块 BoxGeometry 都是独享的
      if (o.material && o.material.map) o.material.map.dispose();
      if (o.material) o.material.dispose();
    });
    this.tex?.dispose();
  }
}

/** NPC·看门狗 —— 与 Goose/Npc 同接口的控制器：位置/状态全部来自服务端快照。 */
export class Dog {
  constructor() {
    this.kind = 'dog';
    this.nodeId = null;
    this.taskId = null;
    this.id = null;
    this.st = 0;
    this.yaw = 0;
    this.remote = true;
    this.buf = [];
    this.pos = new THREE.Vector3();
    this.info = { kind: 'dog', title: DOG.name, code: '', online: true };

    this.chicken = new DogBody();      // main.js 里所有 npc.chicken.* 都指向它
    this.chicken.ref = this;
    this.chicken.group.userData.npc = this;
    this.chicken.setInfo(this.info);
  }

  addTo(scene) { scene.add(this.chicken.group); return this; }
  get group() { return this.chicken.group; }
  sync() { this.chicken.setInfo(this.info); }
  setRemote(on) { this.remote = !!on; this.buf.length = 0; }
  pushBuf(x, z, y, yaw, hp, st, scale) { push(this.buf, x, z, y, yaw, hp, st, scale); }
  update(dt) { this.updateRemote(dt); }

  updateRemote(dt) {
    const s = sample(this.buf);
    if (!s) return;
    this.pos.set(s.x, s.y, s.z);
    this.yaw = s.yaw;
    // ⚠ 逻辑坐标与模型位置两条都要写（只改 pos 会「逻辑在走、模型站着」）
    this.group.position.set(s.x, s.y, s.z);
    this.group.rotation.y = s.yaw;
    if (s.st & ST_PECK && !(this.st & ST_PECK)) this.chicken.bite();
    this.st = s.st;
    this.chicken.update(dt, s.st);
  }

  dispose(scene) {
    scene.remove(this.group);
    this.chicken.dispose();
  }
}
