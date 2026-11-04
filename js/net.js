// 联机层：连上能连就联机，连不上就退回单机（失败不打扰用户，后台每 15 秒重试一次）
export class Net {
  /**
   * @param {string} path 相对页面的 WS 路径，默认 './ws'（同源反代到游戏服）
   */
  constructor(path = './ws') {
    this.path = path;
    this.ws = null;
    this.mode = 'local';
    this.id = null;
    this.handlers = new Map();
    this.retryT = null;
    this.retryMs = 15000;
    this.everConnected = false;
    this.lastError = null;
    this.lastClose = null;      // {code, reason} 便于排查
    this.stopped = false;
  }

  on(evt, fn) {
    if (!this.handlers.has(evt)) this.handlers.set(evt, new Set());
    this.handlers.get(evt).add(fn);
    return () => this.handlers.get(evt)?.delete(fn);
  }
  emit(evt, ...args) { for (const fn of this.handlers.get(evt) || []) { try { fn(...args); } catch (e) { console.error(e); } } }

  get online() { return this.mode === 'online' && this.ws?.readyState === 1; }

  connect(path = this.path) {
    this.path = path;
    this.stopped = false;
    clearTimeout(this.retryT);
    try { this.ws?.close(); } catch { /* 忽略 */ }
    const proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
    let url;
    try { url = new URL(path, document.baseURI).href.replace(/^http/, 'ws'); }
    catch { url = proto + location.host + '/chicken/ws'; }

    let ws;
    try { ws = new WebSocket(url); } catch (e) { this.lastError = String(e); this._retry(); return; }
    this.ws = ws;

    // ⚠ 所有回调都先认 this.ws === ws：connect() 会先关旧 socket 再建新的，而旧 socket 的
    //   onclose 是异步到达的。不认领就会把刚建好的新连接置空（online 永远 false、send 全丢）、
    //   并留下一条没人管的孤儿连接。比这更早的版本在「首连尚未 open 又触发一次 connect」时必现。
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.mode = 'online';
      this.everConnected = true;
      this.lastError = null;
      this.lastClose = null;
      this.emit('open');
    };
    ws.onmessage = (e) => {
      if (this.ws !== ws) return;
      let m;
      try { m = JSON.parse(e.data); } catch { return; }
      this._route(m);
    };
    ws.onclose = (e) => {
      if (this.ws !== ws) return;      // 旧连接迟到的 close：别碰新连接
      const was = this.mode;
      this.mode = 'local';
      this.ws = null;
      this.lastClose = { code: e.code, reason: String(e.reason || '').slice(0, 80) };
      this.emit('drop', was);
      this._retry();
    };
    ws.onerror = () => { if (this.ws === ws) this.lastError = '连接失败'; };
  }

  _route(m) {
    switch (m.t) {
      case 'welcome': this.id = m.id; this.emit('welcome', m); break;
      case 'cc': this.emit('cc', m); break;                 // 服务端补发的国旗码（本机自报时）
      case 'roster': this.emit('roster', m.list || [], m); break;
      case 's': this.emit('snapshot', m); break;
      case 'respawn': this.emit('respawn', m); break;
      default: break;
    }
  }

  send(obj) {
    if (this.ws && this.ws.readyState === 1) {
      try { this.ws.send(JSON.stringify(obj)); return true; } catch { /* 忽略 */ }
    }
    return false;
  }

  _retry() {
    clearTimeout(this.retryT);
    if (this.stopped) return;
    this.retryT = setTimeout(() => { if (!this.stopped && this.mode !== 'online') this.connect(); }, this.retryMs);
  }
  stop() {
    // 先置 stopped 再 close：否则 onclose 会照常 _retry()，页面都关了还在 15 秒后重连
    this.stopped = true;
    clearTimeout(this.retryT);
    const ws = this.ws;
    this.ws = null;
    this.mode = 'local';
    try { ws?.close(); } catch { /* 忽略 */ }
  }
}
