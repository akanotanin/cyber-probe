// 羽毛粒子池：被啄中/被啄倒时从身上炸出一撮羽毛，旋转飘落淡出。
// 80 个精灵循环复用，没有就绪的粒子时静默丢弃（不新建对象，避免 GC 抖动）。

import * as THREE from 'three';

function featherTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 32;
  const g = c.getContext('2d');
  g.fillStyle = '#fff';
  g.beginPath();
  g.ellipse(16, 16, 5, 13, 0, 0, Math.PI * 2);
  g.fill();
  g.strokeStyle = 'rgba(200,190,170,0.9)';
  g.beginPath(); g.moveTo(16, 4); g.lineTo(16, 28); g.stroke();
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export class Feathers {
  constructor(scene) {
    this.scene = scene;
    this.pool = [];
    const tex = featherTexture();
    this.tex = tex;
    for (let i = 0; i < 80; i++) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({
        map: tex, transparent: true, depthWrite: false,
      }));
      s.scale.setScalar(0.14);
      s.visible = false;
      scene.add(s);
      this.pool.push({ s, vel: new THREE.Vector3(), spin: 0, life: 0 });
    }
  }

  /** @param {THREE.Vector3} pos 炸毛位置 @param {number} n 数量 @param {number} tint 颜色 */
  burst(pos, n = 9, tint = 0xffffff) {
    let used = 0;
    for (const f of this.pool) {
      if (f.life > 0) continue;
      f.life = 0.9 + Math.random() * 0.5;
      f.s.visible = true;
      f.s.position.set(
        pos.x + (Math.random() - 0.5) * 0.4,
        pos.y + 0.45 + Math.random() * 0.3,
        pos.z + (Math.random() - 0.5) * 0.4,
      );
      f.vel.set((Math.random() - 0.5) * 2.4, 1.4 + Math.random() * 1.6, (Math.random() - 0.5) * 2.4);
      f.spin = (Math.random() - 0.5) * 8;
      f.s.material.color.setHex(tint);
      f.s.material.rotation = Math.random() * 6.28;
      f.s.material.opacity = 1;
      if (++used >= n) break;
    }
  }

  update(dt) {
    for (const f of this.pool) {
      if (f.life <= 0) continue;
      f.life -= dt;
      if (f.life <= 0) { f.s.visible = false; continue; }
      f.vel.y -= 2.6 * dt;                    // 羽毛慢慢往下飘
      f.vel.multiplyScalar(1 - 1.4 * dt);     // 空气阻力
      f.s.position.addScaledVector(f.vel, dt);
      if (f.s.position.y < 0.03) { f.s.position.y = 0.03; f.vel.set(0, 0, 0); }
      f.s.material.rotation += f.spin * dt;
      f.s.material.opacity = Math.min(1, f.life * 2.2);
    }
  }

  dispose() {
    for (const f of this.pool) { this.scene.remove(f.s); f.s.material.dispose(); }
    this.tex.dispose();
    this.pool = [];
  }
}

// ---------------------------------------------------------------------------
// 扬尘：扇翅、落地时脚边炸开一圈土雾（比羽毛更"重"，用径向渐变贴图）。
// 独立于羽毛池，因为两者的运动规律不同（尘是向外炸开、慢慢升腾淡出）。
// ---------------------------------------------------------------------------
function dustTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(32, 32, 2, 32, 32, 30);
  grd.addColorStop(0, 'rgba(226,214,186,0.95)');
  grd.addColorStop(0.55, 'rgba(206,192,160,0.45)');
  grd.addColorStop(1, 'rgba(200,186,152,0)');
  g.fillStyle = grd;
  g.beginPath(); g.arc(32, 32, 30, 0, Math.PI * 2); g.fill();
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export class Dust {
  constructor(scene) {
    this.scene = scene;
    this.pool = [];
    const tex = dustTexture();
    this.tex = tex;
    for (let i = 0; i < 48; i++) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({
        map: tex, transparent: true, depthWrite: false, opacity: 0,
      }));
      s.scale.setScalar(0.5);
      s.visible = false;
      scene.add(s);
      this.pool.push({ s, vel: new THREE.Vector3(), life: 0, max: 1, grow: 1 });
    }
  }

  /** @param {THREE.Vector3} pos 起尘位置（脚边） @param {number} n 数量 @param {number} power 力度（1=扇翅，0.6=落地） */
  puff(pos, n = 7, power = 1) {
    let used = 0;
    for (const d of this.pool) {
      if (d.life > 0) continue;
      d.max = 0.55 + Math.random() * 0.45;
      d.life = d.max;
      d.grow = (1.4 + Math.random() * 1.2) * power;
      d.s.visible = true;
      d.s.position.set(
        pos.x + (Math.random() - 0.5) * 0.7,
        pos.y + 0.06 + Math.random() * 0.1,
        pos.z + (Math.random() - 0.5) * 0.7,
      );
      const a = Math.random() * Math.PI * 2, sp = (0.6 + Math.random() * 0.9) * power;
      d.vel.set(Math.cos(a) * sp, 0.25 + Math.random() * 0.35 * power, Math.sin(a) * sp);
      d.s.scale.setScalar(0.35 + Math.random() * 0.25);
      d.s.material.opacity = 0.55 * power;
      if (++used >= n) break;
    }
  }

  update(dt) {
    for (const d of this.pool) {
      if (d.life <= 0) continue;
      d.life -= dt;
      if (d.life <= 0) { d.s.visible = false; continue; }
      d.vel.multiplyScalar(1 - 2.2 * dt);          // 很快被空气拖住
      d.s.position.addScaledVector(d.vel, dt);
      const k = d.life / d.max;
      d.s.scale.setScalar(d.s.scale.x + d.grow * dt);
      d.s.material.opacity = 0.55 * k * k;         // 尾巴淡得快
    }
  }

  dispose() {
    for (const d of this.pool) { this.scene.remove(d.s); d.s.material.dispose(); }
    this.tex.dispose();
    this.pool = [];
  }
}
