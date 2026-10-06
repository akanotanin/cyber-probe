// NPC 鸡：探针鸡（VPS）与网站鸡（ping 探测）的行为 —— 闲逛、暴躁追人、被啄倒
import * as THREE from 'three';
import { Chicken } from './chicken.js';
import { resolveCollision, BOUNDS, groundHeight } from './world.js';
import { sample, push } from './interp.js';
import { CONF, fmtRate, fmtPct, fmtUptime, shortCpu, seenAgo } from './data.js';
import { PROBES } from './config.js';

const PASTEL = [];   // 已废弃：改用 chicken.js 的 5 套写实羽色（保留常量以免外部引用报错）

export class Npc {
  /**
   * @param {object} o {farm, kind:'probe'|'web', node?, task?, world:{obstacles,boxObstacles}}
   */
  constructor({ farm, kind, node = null, task = null, world }) {
    this.farm = farm;
    this.kind = kind;
    this.id = kind === 'probe' ? `n${node.id}` : `t${task.id}`;
    this.nodeId = node?.id ?? null;
    this.taskId = task?.id ?? null;
    this.world = world;
    this.hp = 100;
    this.atkCd = 0;
    this.state = 'walk';            // walk | idle | chase
    this.stateT = 0;
    this.remote = false;            // 联机时：位置/血量由服务端快照驱动（本端不跑 AI、不结算伤害）
    this.buf = [];                  // 远端模式的快照缓冲
    this.st = 0;                    // 状态位（闲时动作/奔跑）
    this.idle = '';                 // 闲时动作：peck(啄地) / flap(振翅) / preen(理毛)
    this.idleT = 0;
    this._ko = false;
    this.yaw = Math.random() * 6.28;
    this.pos = new THREE.Vector3((Math.random() - 0.5) * (BOUNDS * 1.4), 0, (Math.random() - 0.5) * (BOUNDS * 1.4));
    this.wander = this.pos.clone();
    // 隐私：探测目标的域名不下发也不显示（config.js 里也已移除），名牌上只给节点名与统计
    this.speed = 0.75 + Math.random() * 0.2;      // 按原站实测：移动时约 0.65~0.9 m/s

    // 羽色从 5 套写实配色里按 id 固定分配（每只鸡有自己的色，刷新后不变）
    const colorIdx = kind === 'web' ? (task?.id ?? 0) % 5 : ((node?.id ?? 0) * 3 + 1) % 5;
    this.chicken = new Chicken({ colorIdx, kind, scale: 1.18 });
    this.chicken.group.userData.npc = this;
    this.chicken.ref = this;
    this.pos.y = groundHeight(this.pos.x, this.pos.z);
    this.chicken.group.position.copy(this.pos);

    // 网络最差的探针鸡：脚下一圈红环（每帧脉冲）
    this.ring = new THREE.Mesh(
      new THREE.RingGeometry(0.72, 0.96, 28),
      new THREE.MeshBasicMaterial({
        color: 0xff4a2a, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide,
      }),
    );
    this.ring.rotation.x = -Math.PI / 2;
    this.ring.position.y = 0.04;
    this.chicken.group.add(this.ring);
  }

  addTo(scene) { scene.add(this.chicken.group); return this; }

  get group() { return this.chicken.group; }

  /** 从探针数据刷新名牌与状态；由 main 在每次数据更新时调用 */
  sync(now) {
    const info = this.kind === 'probe' ? this.probeInfo(now) : this.webInfo(now);
    this.info = info;
    this.chicken.setInfo(info);
    if (this.chicken.hp !== this.hp) this.chicken.setHp(this.hp);
  }

  probeInfo(nowT) {
    const n = this.farm.nodeById(this.nodeId) || {};
    const m = n.metrics || {};
    const memPct = m.mem_total ? m.mem_used / m.mem_total * 100 : 0;
    const diskPct = m.disk_total ? m.disk_used / m.disk_total * 100 : 0;
    const stale = seenAgo(n);                   // hub 1.4.0 起按 hub 时钟算（访客时钟不准也不会把在线算成离线）
    const online = !!n.online && (stale == null || stale < 300);
    const hot = this.farm.isAggressive(n);      // CPU/内存超阈值，或网络最差（网差也变暴躁鸡）
    return {
      kind: 'probe', online, hot,
      netWorst: this.farm.worstNodeId === this.nodeId,
      title: n.name || `节点${this.nodeId}`,
      code: n.country || '??',
      // 刻意留空：主机名/IP 属于隐私，概不出现在页面上（连 config.js 里都不再有）
      sub: '',
      rings: [
        { label: 'CPU', pct: m.cpu || 0, color: m.cpu > CONF.hotCpu ? '#ff6a4a' : '#7ddc6a' },
        { label: '内存', pct: memPct, color: memPct > CONF.hotMem ? '#ff6a4a' : '#63b6ff' },
      ],
      rows: [
        `↓${fmtRate(m.net_rx || 0)} ↑${fmtRate(m.net_tx || 0)}`,
        `磁盘 ${fmtPct(diskPct)} · 负载 ${(m.load?.[0] ?? 0).toFixed(2)}`,
        `在线 ${fmtUptime(m.uptime)} · 进程 ${m.procs ?? '—'}`,
        `${shortCpu(n.cpu_name)} ×${n.cpu_cores || 1}`,
      ],
    };
  }

  webInfo(nowT) {
    const t = this.farm.tasks.get(this.taskId) || {};
    const cfg = PROBES[String(this.taskId)] || {};
    const lat = t.avg == null ? null : Math.round(t.avg);
    const pctOf = (v, max) => Math.max(0, Math.min(100, (v ?? 0) / max * 100));
    const color = lat == null ? '#8d8b86' : lat < 120 ? '#7ddc6a' : lat < 220 ? '#e8a33d' : '#ff6a4a';
    return {
      kind: 'web', online: t.n > 0, hot: false,
      title: t.name || cfg.name || `探测#${this.taskId}`,
      // 图标 = 这个探测点 IP 所在地的国旗（tools/gen_config.py 在生成时解析 + 查库，只导出两个字母的码）
      code: cfg.flag || '🌐',
      // 只给"在测多少台 / 丢包"这类统计，不给探测目标域名（隐私约定）
      sub: `在测 ${t.n || 0} 台 · 丢包 ${t.loss == null ? '—' : (t.loss < 10 ? t.loss.toFixed(1) : Math.round(t.loss))}%`,
      rings: [
        { label: '延迟ms', pct: pctOf(lat, 400), text: lat == null ? '—' : String(lat), color },
        { label: '丢包%', pct: pctOf(t.loss, 20), text: t.loss == null ? '—' : (t.loss < 10 ? t.loss.toFixed(1) : Math.round(t.loss)), color: (t.loss || 0) > 3 ? '#ff6a4a' : '#63b6ff' },
      ],
      rows: [
        `在测 ${t.n || 0} 台 · 丢包 ${t.loss == null ? '—' : (t.loss < 10 ? t.loss.toFixed(1) : Math.round(t.loss))}%`,
        `最好 ${t.best ? `${t.best.node.name} ${t.best.latency}ms` : '—'}`,
        `最差 ${t.worst ? `${t.worst.node.name} ${t.worst.latency}ms` : '—'}`,
        t.avg == null ? '等待探测数据…' : `平均 ${lat}ms · 间隔 ${cfg.interval || '—'}s`,
      ],
    };
  }

  /** @param {object} player {pos, hp, hurt(dmg, fromName)} */
  /**
   * 每帧更新：**只走服务端快照插值**。
   * 原站没有单机形态（客户端不本地养鸡），所以这里不再有本地漫游/追人/啄人那套 AI；
   * 连不上服务端时场上就只剩玩家自己的鸡（与原站一致）。
   */
  update(dt, player) {
    this.updateRemote(dt);
  }

  /** 联机模式：位置/血量/状态全部按服务端快照插值（本端不跑 AI、不结算伤害） */
  updateRemote(dt) {
    const s = sample(this.buf);
    if (!s) return;
    this.pos.set(s.x, s.y, s.z);
    this.yaw = s.yaw;
    // ⚠ 必须把模型也挪过去：本地 AI 那条路（update）末尾会 group.position.set，
    //   而联机这条路以前只改 pos —— 于是"逻辑在走、模型站着"，就是用户看到的
    //   "联机模式下探针鸡/网站鸡原地不动（单机反而正常）"。别再漏这一行。
    this.group.position.set(s.x, s.y, s.z);
    this.st = s.st;
    this.group.rotation.y = s.yaw;
    if (s.hp !== this.hp) { this.hp = s.hp; this.chicken.setHp(Math.round(s.hp)); }
    if (s.scale != null) this.chicken.setScale(s.scale);      // 体型随负载缩放（服务端下发）
    const ko = !!(s.st & 1);
    if (ko !== this._ko) {
      this._ko = ko;
      if (ko) this.chicken.ko(); else this.chicken.revive();
    } else if (ko) {
      this.chicken.koT = Math.max(this.chicken.koT, 0.2);   // 服务端还没复活就别自己站起来
    }
    // 第 4 个参数是 airborne：服务端起跳时置 ST_JUMP(128)，这里表现成缩腿扑腾
    this.chicken.update(dt, s.speed > 0.15, !!(s.st & 4), !!(s.st & 128), s.st);
    // 网络最差的红环脉冲（这是面板状态，仍由本端数据驱动）
    if (this.ring) {
      const tNow = performance.now() / 1000;
      const want = this.info?.netWorst ? 0.45 + 0.35 * Math.sin(tNow * 4) : 0;
      this.ring.material.opacity += (want - this.ring.material.opacity) * Math.min(1, dt * 6);
      this.ring.scale.setScalar(this.info?.netWorst ? 1 + 0.10 * Math.sin(tNow * 4) : 1);
    }
  }

  /** 标记为服务端权威（现在只有这一种：本地不再跑 AI） */
  setRemote(on) {
    this.remote = !!on;
    this.buf.length = 0;
    this._ko = false;
  }

  /** 服务端快照 -> 缓冲（hp/倒地/体型都用最新值，位置才插值） */
  pushBuf(x, z, y, yaw, hp, st, scale) {
    push(this.buf, x, z, y, yaw, hp, st, scale);
  }

  /** 被玩家啄到；返回 true 表示这次把它啄倒了（联机时伤害归服务端，这里直接不管） */
  hit(dmg) {
    if (this.remote) return false;
    if (this.chicken.koT > 0) return false;
    this.hp -= dmg;
    this.chicken.flash();                 // 中招一下闪红
    this.chicken.flap();
    if (this.hp <= 0) {
      this.hp = 0;
      this.chicken.ko();
      return true;
    }
    this.chicken.setHp(this.hp);
    return false;
  }

  revive() {
    this.hp = 100;
    this.chicken.revive();
    this.chicken.setHp(100);
    // 换个地方站起来
    this.pos.set((Math.random() - 0.5) * BOUNDS * 1.5, 0, (Math.random() - 0.5) * BOUNDS * 1.5);
    this.pos.y = groundHeight(this.pos.x, this.pos.z);
    this.group.position.set(this.pos.x, this.pos.y, this.pos.z);
  }

  dispose(scene) {
    scene.remove(this.group);
    this.group.traverse((o) => { if (o.material?.map?.dispose && o.isSprite) o.material.map.dispose(); });
  }
}
