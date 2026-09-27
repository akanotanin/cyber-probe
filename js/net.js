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
  }

  on(evt, fn) {
    if (!this.handlers.has(evt)) this.handlers.set(evt, new Set());
    this.handlers.get(evt).add(fn);
    return () => this.handlers.get(evt)?.delete(fn);
  }
  emit(evt, data) { for (const fn of this.handlers.get(evt) || []) { try { fn(data); } catch (e) { console.error(e); } } }

  get online() { return this.mode === 'online' && this.ws?.readyState === 1; }

  connect(path = this.path) {
    this.path = path;
    clearTimeout(this.retryT);
    try { this.ws?.close(); } catch { /* 忽略 */ }
    const proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
    let url;
    try { url = new URL(path, document.baseURI).href.replace(/^http/, 'ws'); }
    catch { url = proto + location.host + '/chicken/ws'; }

    let ws;
    try { ws = new WebSocket(url); } catch (e) { this.lastError = String(e); this._retry(); return; }
    this.ws = ws;

    ws.onopen = () => {
      this.mode = 'online';
      this.everConnected = true;
      this.lastError = null;
      this.lastClose = null;
      this.emit('open');
    };
    ws.onmessage = (e) => {
      let m;
      try { m = JSON.parse(e.data); } catch { return; }
      this._route(m);
    };
    ws.onclose = (e) => {
      const was = this.mode;
      this.mode = 'local';
      this.ws = null;
      this.lastClose = { code: e.code, reason: String(e.reason || '').slice(0, 80) };
      this.emit('drop', was);
      this._retry();
    };
    ws.onerror = () => { this.lastError = '连接失败'; };
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
    this.retryT = setTimeout(() => { if (this.mode !== 'online') this.connect(); }, this.retryMs);
  }
  stop() { clearTimeout(this.retryT); try { this.ws?.close(); } catch { /* 忽略 */ } }
}
