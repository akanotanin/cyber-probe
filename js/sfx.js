// WebAudio 合成音效：啄空 / 命中 / 扇翅 / 啄倒 / 自己被啄。零音频文件依赖。
// 浏览器要求音频在用户手势里启动，所以 init() 挂在第一次点击或按键上；M 键静音。

export class Sfx {
  constructor() {
    this.ctx = null;
    this.muted = false;
    this.noiseBuf = null;
  }

  init() {
    if (this.ctx) return;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AC();
      const len = Math.floor(this.ctx.sampleRate * 0.12);
      this.noiseBuf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const d = this.noiseBuf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    } catch {
      this.ctx = null;    // 没有音频设备就静默降级
    }
  }

  toggleMute() {
    this.muted = !this.muted;
    return this.muted;
  }

  // 指数包络（音量先冲上去再衰减），比线性听着更“实”
  env(node, t0, peak, dur) {
    const gp = node.gain;
    gp.setValueAtTime(0.0001, t0);
    gp.exponentialRampToValueAtTime(peak, t0 + 0.012);
    gp.exponentialRampToValueAtTime(0.0001, t0 + dur);
  }

  // 啄空：短促的“哒”
  peck() {
    if (!this.ctx || this.muted) return;
    const t0 = this.ctx.currentTime;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'bandpass'; filter.frequency.value = 2400; filter.Q.value = 1.2;
    const gain = this.ctx.createGain();
    this.env(gain, t0, 0.18, 0.09);
    src.connect(filter).connect(gain).connect(this.ctx.destination);
    src.start(t0); src.stop(t0 + 0.1);
  }

  // 命中：闷“咚”，按距离衰减
  hit(dist = 0) {
    if (!this.ctx || this.muted) return;
    const vol = Math.min(0.5, 0.42 / (1 + dist * 0.25));
    const t0 = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(320, t0);
    osc.frequency.exponentialRampToValueAtTime(120, t0 + 0.1);
    const gain = this.ctx.createGain();
    this.env(gain, t0, vol, 0.12);
    osc.connect(gain).connect(this.ctx.destination);
    osc.start(t0); osc.stop(t0 + 0.13);
  }

  // 扇翅：两下气流“呼呼”
  flap() {
    if (!this.ctx || this.muted) return;
    for (const offset of [0, 0.13]) {
      const t0 = this.ctx.currentTime + offset;
      const src = this.ctx.createBufferSource();
      src.buffer = this.noiseBuf;
      const filter = this.ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(900, t0);
      filter.frequency.exponentialRampToValueAtTime(300, t0 + 0.12);
      const gain = this.ctx.createGain();
      this.env(gain, t0, 0.22, 0.12);
      src.connect(filter).connect(gain).connect(this.ctx.destination);
      src.start(t0); src.stop(t0 + 0.14);
    }
  }

  // 击倒：下滑音
  ko(dist = 0) {
    if (!this.ctx || this.muted) return;
    const vol = Math.min(0.5, 0.4 / (1 + dist * 0.25));
    const t0 = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    osc.type = 'square';
    osc.frequency.setValueAtTime(520, t0);
    osc.frequency.exponentialRampToValueAtTime(90, t0 + 0.42);
    const gain = this.ctx.createGain();
    this.env(gain, t0, vol * 0.7, 0.45);
    osc.connect(gain).connect(this.ctx.destination);
    osc.start(t0); osc.stop(t0 + 0.5);
  }

  // 自己被啄：一声惊叫
  cluck() {
    if (!this.ctx || this.muted) return;
    const t0 = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(660, t0);
    osc.frequency.exponentialRampToValueAtTime(380, t0 + 0.08);
    const gain = this.ctx.createGain();
    this.env(gain, t0, 0.12, 0.09);
    osc.connect(gain).connect(this.ctx.destination);
    osc.start(t0); osc.stop(t0 + 0.1);
  }
}
