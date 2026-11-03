// Komari 公开 API 适配层（https://www.komari.wiki/dev/api）：
// 把 Komari 的节点 / 实时上报 / 历史记录映射成 monitor hub 的数据形状，
// js/data.js 的其余部分（聚合、暴躁鸡、详情图）因此完全不用改。
//
// 只在 config.js 的 SOURCE === 'komari' 时启用；默认仍是 monitor。
// 隐私：这里只做字段映射，不缓存、不落盘任何主机名/IP/探测目标 —— Komari 的公开 API
// 已经会为 Guest 清空 ipv4/ipv6/remark/token，前端也从不显示这些字段。
//
// 数据来源（全部是 Guest 可读的公开接口）：
//   GET /api/nodes                       节点静态信息
//   WS  /api/clients  发 "get"            在线列表 + 每台节点最近一次上报（含实时指标）
//   GET /api/records/ping?uuid=&hours=    ping 历史（value < 0 表示丢包）
//   GET /api/records/load?uuid=&hours=    资源历史
//   GET /api/public                      record_preserve_time（保留小时数）与站名

const FIN = (v) => (typeof v === 'number' && isFinite(v) ? v : null);
const INT = (v) => {
  const n = Number(v);
  return isFinite(n) ? Math.round(n) : null;
};
const POS = (v) => {
  const n = FIN(v);
  return n != null && n >= 0 ? n : null;
};

/** Komari 的 `{status,message,data}` 包络解包；raw 接口（如 /api/me）原样返回。 */
export function unwrap(json) {
  if (json && typeof json === 'object' && 'status' in json) {
    if (json.status !== 'success') throw new Error(json.message || `Komari API 返回 ${json.status}`);
    return json.data;
  }
  return json;
}

/** RFC3339 / ISO 时间（Komari 的 time、updated_at）→ Unix 秒；解析不了返回 null。 */
export function parseTime(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return v > 1e12 ? v / 1000 : v;   // 兼容毫秒时间戳
  const s = String(v).trim();
  let t = Date.parse(s);
  if (!isFinite(t)) {
    // Go time.Time 的纳秒小数位让部分浏览器 Date.parse 直接 NaN：截到毫秒再试一次。
    const m = s.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/);
    if (m) t = Date.parse(m[1] + (m[2] ? m[2].slice(0, 4) : '') + (m[3] || 'Z'));
  }
  return isFinite(t) ? t / 1000 : null;
}

/** 国家码：Komari 的 region 正常是两位字母；其它写法退化成空（前端显示 🌐）。 */
export function countryCode(region) {
  const s = String(region || '').trim();
  return /^[A-Za-z]{2}$/.test(s) ? s.toUpperCase() : '';
}

/** Komari 实时上报（/api/clients 的 data[uuid]）→ 前端用的 metrics。
 *  字段全部从公开 API 来；缺的保持 null，让 UI 显示「—」而不是 0。 */
export function mapReport(report) {
  if (!report || typeof report !== 'object') return null;
  const cpu = report.cpu || {};
  const ram = report.ram || {};
  const swap = report.swap || {};
  const disk = report.disk || {};
  const network = report.network || {};
  const conn = report.connections || {};
  const load = report.load || {};
  const m = {
    cpu: FIN(cpu.usage),
    mem_used: POS(ram.used), mem_total: POS(ram.total),
    swap_used: POS(swap.used), swap_total: POS(swap.total),
    disk_used: POS(disk.used), disk_total: POS(disk.total),
    net_rx: POS(network.down), net_tx: POS(network.up),
    net_total_rx: POS(network.totalDown), net_total_tx: POS(network.totalUp),
    uptime: POS(report.uptime),
    procs: POS(report.process),
    tcp: POS(conn.tcp), udp: POS(conn.udp),
    // npc.js / 图表都按 monitor 的 load[0..2]（1/5/15 分钟）取值
    load: [FIN(load.load1), FIN(load.load5), FIN(load.load15)],
    updated_at: parseTime(report.updated_at),
  };
  const values = [m.cpu, m.mem_used, m.mem_total, m.swap_used, m.swap_total, m.disk_used, m.disk_total,
    m.net_rx, m.net_tx, m.net_total_rx, m.net_total_tx, m.uptime, m.procs, m.tcp, m.udp, ...m.load];
  return values.some((v) => v != null) ? m : null;
}

/** Komari Client + 最近上报 → monitor hub 的节点形状（id 由 data.js 分配成稳定的数字）。 */
export function mapNode(client, report, online, id, nowSec = Date.now() / 1000) {
  const c = client || {};
  const m = mapReport(report);
  const updated = m && m.updated_at != null ? m.updated_at : null;
  return {
    id,
    uuid: c.uuid || '',
    name: c.name || c.uuid || '未命名',
    online: !!online,
    country: countryCode(c.region),
    os: c.os || '',
    virt: c.virtualization || '',
    arch: c.arch || '',
    kernel: c.kernel_version || '',
    cpu_name: c.cpu_name || '',
    cpu_cores: INT(c.cpu_cores) || 0,
    mem_total: POS(c.mem_total) || 0,
    swap_total: POS(c.swap_total) || 0,
    disk_total: POS(c.disk_total) || 0,
    public_remark: c.public_remark || '',
    group: c.group || '',
    tags: c.tags || '',
    metrics: m,
    last_seen: updated,
    last_seen_ago: updated != null ? Math.max(0, Math.round(nowSec - updated)) : null,
    // Komari 没有 monitor 的「今日流量」字段：留 null，卡片显示「—」，不要拿累计流量冒充。
    day_rx: null,
    day_tx: null,
  };
}

/** /api/records/load 的 records → 详情图表用的行（字段名对齐 monitor 的 metrics 历史）。 */
export function mapLoadRecords(records) {
  return (Array.isArray(records) ? records : []).map((r) => {
    if (!r || typeof r !== 'object') return null;
    const ts = parseTime(r.time);
    if (ts == null) return null;
    const conn = POS(r.connections);
    const udp = POS(r.connections_udp);
    // ⚠ Komari 的 Record.Connections 存的就是 TCP 数（metricstore/report_mapping.go
    // 写的是 report.Connections.TCP），不是 TCP+UDP 总数 —— 不能再减 connections_udp。
    const tcp = r.connections_tcp != null ? POS(r.connections_tcp) : conn;
    return {
      ts,
      cpu: FIN(r.cpu),
      mem_used: POS(r.ram), mem_total: POS(r.ram_total),
      swap_used: POS(r.swap), swap_total: POS(r.swap_total),
      disk_used: POS(r.disk), disk_total: POS(r.disk_total),
      net_rx: POS(r.net_in), net_tx: POS(r.net_out),
      tcp, udp,
      procs: POS(r.process),
      load: FIN(r.load),
    };
  }).filter(Boolean).sort((a, b) => a.ts - b.ts);
}

/** /api/records/ping 的响应 → {ping, loss, probes}：
 *  · ping: [{task_id, ts, latency}]，latency=null 表示这次探测超时/丢包（value < 0）
 *  · loss: task_id -> 丢包百分比（优先用服务端 tasks[].loss；缺了才按记录自己算）
 *  · probes: task_id -> 任务名
 */
export function mapPingPayload(d) {
  const probes = {};
  const loss = {};
  const tasks = Array.isArray(d && d.tasks) ? d.tasks : [];
  for (const t of tasks) {
    if (t == null || t.id == null) continue;
    const tid = String(t.id);
    if (t.name) probes[tid] = String(t.name);
    const l = FIN(t.loss);
    const total = FIN(t.total);
    // Komari 对“适用但还没跑过”的任务也会返回 loss:0,total:0；这不是 0% 丢包，
    // 直接采信会把新节点的丢包平均拉低。没有样本时留给记录回退计算。
    if (l != null && (total == null || total > 0)) loss[tid] = Math.max(0, Math.min(100, l));
  }

  const ping = [];
  const counts = new Map();
  const records = Array.isArray(d && d.records) ? d.records : [];
  for (const r of records) {
    if (r == null || r.task_id == null) continue;
    const ts = parseTime(r.time);
    if (ts == null) continue;
    const tid = String(r.task_id);
    const value = r.value == null ? NaN : Number(r.value);
    const latency = isFinite(value) && value >= 0 ? value : null;
    ping.push({ task_id: Number(r.task_id), ts, latency });
    const c = counts.get(tid) || { n: 0, loss: 0 };
    c.n += 1;
    if (latency == null) c.loss += 1;
    counts.set(tid, c);
  }

  // tasks[].loss 是服务端按整个窗口聚合的（与记录条数无关）；没给才用本地统计兜底。
  for (const [tid, c] of counts) {
    if (loss[tid] == null && c.n) loss[tid] = c.loss / c.n * 100;
  }
  return { ping, loss, probes };
}

/** 详情页一次要资源 + 延迟两份数据：合成 data.js 期望的 {metrics, ping, probes, loss}。 */
export function mapDetail(loadData, pingData) {
  const p = mapPingPayload(pingData);
  return {
    metrics: mapLoadRecords(loadData && loadData.records),
    ping: p.ping,
    probes: p.probes,
    loss: p.loss,
  };
}

/** Komari 的实时数据是「发一次 get 回一次快照」，不是推送：
 *  连上后立刻取一次，之后每 interval 毫秒再取一次；断了按 3s → 15s 退避重连。
 *  页面切后台时 data.js 会 stop()（不空跑请求）。 */
export class KomariLive {
  constructor(url, { onData, onState, interval = 3000 } = {}) {
    this.url = url;
    this.onData = onData;
    this.onState = onState;
    this.interval = interval;
    this.ws = null;
    this.timer = null;
    this.watchdog = null;
    this.retry = null;
    this.delay = 3000;
    this.stopped = true;
    this.gotData = false;
    this.lastDataAt = 0;
  }

  get connected() {
    return !!this.ws && this.ws.readyState === 1;
  }

  start() {
    if (!this.stopped) return;
    if (typeof WebSocket === 'undefined') return;   // 非浏览器环境（Node 单测）不连
    this.stopped = false;
    this._connect();
  }

  _connect() {
    if (this.stopped) return;
    let ws;
    try {
      ws = new WebSocket(this.url);
    } catch (e) {
      this._scheduleRetry();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      if (this.stopped || this.ws !== ws) {
        try { ws.close(); } catch (e) { /* ignore */ }
        return;
      }
      this.delay = 3000;
      this.gotData = false;
      this.lastDataAt = Date.now();
      // ⚠ 不要在这里 onState(true)：反代可能升级成功但根本不转发帧（或 Komari 卡死），
      //   只有收到第一条有效快照才算“实时已就绪”，否则 /api/recent 兜底会被永久关掉。
      this._send();
      this.timer = setInterval(() => this._send(), this.interval);
      clearInterval(this.watchdog);
      this.watchdog = setInterval(() => this._checkAlive(), Math.max(2000, this.interval));
    };
    ws.onmessage = (ev) => {
      if (this.stopped || this.ws !== ws) return;  // stop()/换连接后的迟到帧不能再改页面状态
      let d;
      try {
        d = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
      } catch (e) {
        return;
      }
      if (d && d.status === 'error') {
        if (this.onState) this.onState(false, d.error || d.message || 'error');
        // 协议错误不要留着半开连接：关掉走 onclose 重连，期间 data.js 会启用 recent 兜底。
        try { ws.close(); } catch (e) { /* ignore */ }
        return;
      }
      const payload = d && d.data ? d.data : d;
      if (payload && Array.isArray(payload.online) && payload.data && typeof payload.data === 'object') {
        this.lastDataAt = Date.now();
        if (!this.gotData) {
          this.gotData = true;
          if (this.onState) this.onState(true);
        }
        if (this.onData) this.onData(payload);
      }
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;        // 旧连接的 close 不能清掉新连接的定时器
      this._cleanup();
      if (!this.stopped) {
        if (this.onState) this.onState(false);
        this._scheduleRetry();
      }
    };
    // onerror 之后浏览器一定会跟一个 onclose，重连逻辑只放 onclose，避免连开两条。
    ws.onerror = () => {};
  }

  _send() {
    if (this.ws && this.ws.readyState === 1) {
      try { this.ws.send('get'); } catch (e) { /* 等 onclose 重连 */ }
    }
  }

  _checkAlive() {
    if (this.stopped) return;
    // 3 个 get 周期都没收到快照 → 视为半开连接，主动关掉让 onclose 重连/启用兜底。
    if (this.ws && this.ws.readyState === 1
        && Date.now() - this.lastDataAt > Math.max(10000, this.interval * 3)) {
      try { this.ws.close(); } catch (e) { /* ignore */ }
    }
  }

  _cleanup() {
    clearInterval(this.timer);
    this.timer = null;
    clearInterval(this.watchdog);
    this.watchdog = null;
    this.gotData = false;
    this.ws = null;
  }

  _scheduleRetry() {
    clearTimeout(this.retry);
    if (this.stopped) return;
    this.retry = setTimeout(() => this._connect(), this.delay);
    this.delay = Math.min(15000, Math.round(this.delay * 1.5));
  }

  stop() {
    this.stopped = true;
    clearInterval(this.timer);
    this.timer = null;
    clearInterval(this.watchdog);
    this.watchdog = null;
    clearTimeout(this.retry);
    this.retry = null;
    const ws = this.ws;
    this.ws = null;
    try { if (ws) ws.close(); } catch (e) { /* ignore */ }
  }
}
