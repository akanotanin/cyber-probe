// 探针数据层：读 monitor hub 的公开 API，把 7 个节点 + 9 个 ping 探测整理成「鸡」的数据。
// 页面路径形如 /chicken/，同源反代把 /chicken/api/* 转到 hub 的 /api/*（见 nginx 站点块）。

const API = new URL('./api/', document.baseURI.endsWith('/') ? document.baseURI : document.baseURI + '/').href;

export const CONF = {
  hotCpu: 55,        // CPU% 超过它就变「暴躁鸡」
  hotMem: 85,        // 内存% 超过它也变暴躁
  nodeInterval: 6000,   // 节点主数据轮询
  pingInterval: 4000,   // 每个节点 ping 历史的轮询间隔（轮着来）
  maxPingAge: 300,      // ping 样本超过这么久算过期
  netHistMax: 240,      // 每台节点保留多少个平均延迟采样点（网络榜曲线用）
  worstMinGap: 90,      // 网络最差榜易主的最小播报间隔（秒）
};

const now = () => Date.now() / 1000;

export function fmtBytes(v, digits = 1) {
  if (!isFinite(v)) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0, x = Math.abs(v);
  while (x >= 1024 && i < u.length - 1) { x /= 1024; i++; }
  return `${i === 0 ? Math.round(x) : x.toFixed(digits)} ${u[i]}`;
}
export function fmtRate(v) { return `${fmtBytes(v, 1)}/s`; }
export function fmtPct(v) { return `${(v || 0).toFixed(v >= 10 ? 0 : 1)}%`; }
export function fmtUptime(s) {
  s = Math.max(0, Math.round(s || 0));
  const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60);
  if (d) return `${d}天${h}小时`;
  if (h) return `${h}小时${m}分`;
  return `${m}分`;
}
export function fmtAgo(ts) {
  const d = Math.max(0, now() - ts);
  if (d < 60) return `${Math.round(d)}秒前`;
  if (d < 3600) return `${Math.round(d / 60)}分前`;
  if (d < 86400) return `${(d / 3600).toFixed(1)}小时前`;
  return `${Math.round(d / 86400)}天前`;
}
export function shortCpu(name) {
  if (!name) return '—';
  return name
    .replace(/\(R\)|\(TM\)|CPU|Processor|@.*$/gi, '')
    .replace(/\s+/g, ' ').trim();
}

// ---- 数据源 ----
async function getJSON(path) {
  const r = await fetch(API + path, { headers: { accept: 'application/json' } });
  if (!r.ok) throw new Error(`${path} → HTTP ${r.status}`);
  return r.json();
}

export class Farm {
  constructor() {
    this.nodes = [];              // hub 的节点数组（含实时 metrics）
    this.probes = {};             // task_id -> 名称（hub 的 /metrics 会顺带返回）
    this.ping = new Map();        // nodeId -> Map(taskId -> {latency, ts})
    this.lossByNode = new Map();  // nodeId -> {taskId: 丢包百分比}
    this.netHist = new Map();     // nodeId -> [{ts, latency}] 节点平均延迟曲线
    this.tasks = new Map();       // taskId -> {id,name,avg,best,worst,n,loss}（探测目标域名不下发）
    this.netRank = [];            // 网络画像，最差在前
    this.worst = null;            // 当前网络最差的节点画像
    this.worstChange = null;      // {at, from, row} 最近一次易主（由 HUD 消费一次）
    this._lastWorstAt = 0;
    this.lastOk = 0;
    this.error = null;
    this.detailCache = new Map(); // nodeId -> {t, data}
    this._rr = 0;
    this._listeners = new Set();
    this._t1 = null; this._t2 = null;
  }

  onChange(fn) { this._listeners.add(fn); return () => this._listeners.delete(fn); }
  _emit() { for (const fn of this._listeners) { try { fn(this); } catch (e) { console.error(e); } } }

  start() {
    this.refreshNodes();
    this.warmup();
    this._t1 = setInterval(() => this.refreshNodes(), CONF.nodeInterval);
    this._t2 = setInterval(() => this.refreshPing(), CONF.pingInterval);
  }
  stop() { clearInterval(this._t1); clearInterval(this._t2); }

  // 首屏：并行把每个节点的 ping 拉一遍，免得网站鸡的名牌要等 30 秒才齐全
  async warmup() {
    for (let i = 0; i < 30 && !this.nodes.length; i++) await new Promise((r) => setTimeout(r, 500));
    await Promise.all(this.nodes.map((n) => this._fetchPing(n).catch(() => {})));
    this._aggregate();
    this._emit();
  }

  async refreshNodes() {
    try {
      const d = await getJSON('nodes');
      this.nodes = Array.isArray(d) ? d : (d.nodes || []);
      this.lastOk = now();
      this.error = null;
      this._emit();
    } catch (e) {
      this.error = String(e.message || e);
      this._emit();
    }
  }

  // 每 4 秒轮一个节点，取它最近 1 小时的 ping 记录（1 分钟一个桶，够新才敢当"当前值"）
  async refreshPing() {
    if (!this.nodes.length) return;
    const n = this.nodes[this._rr++ % this.nodes.length];
    try {
      await this._fetchPing(n);
      this.lastOk = now();
      this.error = null;
      this._aggregate();
      this._emit();
    } catch (e) {
      this.error = String(e.message || e);
      this._emit();
    }
  }

  async _fetchPing(n) {
    const d = await getJSON(`nodes/${n.id}/metrics?hours=1&points=60&series=ping`);
    if (d.probes) Object.assign(this.probes, d.probes);
    const m = new Map();
    for (const p of (d.ping || [])) {
      const cur = m.get(p.task_id);
      if (!cur || p.ts > cur.ts) m.set(p.task_id, { latency: p.latency, ts: p.ts });
    }
    this.ping.set(n.id, m);
    if (d.loss) this.lossByNode.set(n.id, d.loss);
    // 网络榜的曲线：顺手记一条"这台节点此刻的平均延迟"
    const lats = [];
    for (const v of m.values()) if (now() - v.ts <= CONF.maxPingAge && v.latency != null) lats.push(v.latency);
    if (lats.length) {
      const avg = Math.round(lats.reduce((s, x) => s + x, 0) / lats.length);
      const h = this.netHist.get(n.id) || [];
      h.push({ ts: Math.round(now()), latency: avg });
      while (h.length > CONF.netHistMax) h.shift();
      this.netHist.set(n.id, h);
    }
    return m;
  }

  _aggregate() {
    const online = this.nodes.filter((n) => n.online);
    const fresh = (v) => v && now() - v.ts <= CONF.maxPingAge && v.latency != null;
    const tasks = new Map();

    for (const [tid, name] of Object.entries(this.probes)) {
      const id = Number(tid);
      const per = [];
      for (const n of online) {
        const v = this.ping.get(n.id)?.get(id);
        if (fresh(v)) per.push({ node: n, latency: v.latency });
      }
      per.sort((a, b) => a.latency - b.latency);
      const losses = [];
      for (const n of online) {
        const l = this.lossByNode.get(n.id)?.[tid];
        if (l != null) losses.push(l);
      }
      tasks.set(id, {
        id, name, per, n: per.length,
        avg: per.length ? per.reduce((s, x) => s + x.latency, 0) / per.length : null,
        best: per[0] || null,
        worst: per[per.length - 1] || null,
        loss: losses.length ? losses.reduce((s, x) => s + x, 0) / losses.length : null,
      });
    }
    this.tasks = tasks;
    this._netStats();
  }

  // 每台节点的网络画像：平均延迟 / 丢包 / 曲线；最差的排最前
  _netStats() {
    const rows = [];
    for (const n of this.nodes) {
      if (!n.online) continue;
      const m = this.ping.get(n.id);
      if (!m) continue;
      const lats = [];
      for (const v of m.values()) if (now() - v.ts <= CONF.maxPingAge && v.latency != null) lats.push(v.latency);
      if (!lats.length) continue;
      const avg = lats.reduce((s, x) => s + x, 0) / lats.length;
      const lossMap = this.lossByNode.get(n.id) || {};
      const lv = Object.values(lossMap).filter((x) => x != null);
      const loss = lv.length ? lv.reduce((s, x) => s + x, 0) / lv.length : 0;
      rows.push({
        node: n, name: n.name, avg, loss, n: lats.length,
        hist: this.netHist.get(n.id) || [],
        score: avg * (1 + loss / 100 * 4),        // 复合分：延迟为主、丢包加权
      });
    }
    rows.sort((a, b) => b.score - a.score);        // 最差在前
    rows.forEach((r, i) => { r.rank = i + 1; });
    this.netRank = rows;
    const prev = this.worst;
    this.worst = rows[0] || null;
    const at = now();
    if (this.worst && prev && prev.node.id !== this.worst.node.id) {
      // 易主就播报；同一分半钟内不刷屏，除非新最差确实很糟
      if (at - this._lastWorstAt > CONF.worstMinGap || this.worst.score > 250) {
        this._lastWorstAt = at;
        this.worstChange = { at, from: prev.name, row: this.worst };
      }
    }
    return rows;
  }

  // ---- 便利访问器 ----
  get onlineCount() { return this.nodes.filter((n) => n.online).length; }
  // 暴躁鸡 = CPU/内存超阈值 **或** 网络最差的那台（用户要求：网差的探针鸡也会变成暴躁鸡）
  get hotCount() { return this.nodes.filter((n) => this.isAggressive(n)).length; }
  get worstNodeId() { return this.worst?.node?.id ?? null; }

  isHot(n) {
    if (!n.online || !n.metrics) return false;
    return (n.metrics.cpu || 0) > CONF.hotCpu || this.memPct(n) > CONF.hotMem;
  }
  /** 会主动攻击玩家的鸡（暴躁）：CPU/内存超阈值，或者网络画像最差的那台 */
  isAggressive(n) {
    if (!n.online) return false;
    return this.isHot(n) || (this.worstNodeId != null && n.id === this.worstNodeId);
  }
  memPct(n) {
    const m = n.metrics; if (!m || !m.mem_total) return 0;
    return m.mem_used / m.mem_total * 100;
  }
  diskPct(n) {
    const m = n.metrics; if (!m || !m.disk_total) return 0;
    return m.disk_used / m.disk_total * 100;
  }
  nodeById(id) { return this.nodes.find((n) => n.id === id); }
  netRowById(id) { return this.netRank.find((r) => r.node.id === id) || null; }

  // ---- 详情：抓某节点 24h 历史（资源 + ping），缓存 60s ----
  async nodeDetail(id, { hours = 24, points = 180, force = false } = {}) {
    const c = this.detailCache.get(id);
    if (!force && c && now() - c.t < 60) return c.data;
    const d = await getJSON(`nodes/${id}/metrics?hours=${hours}&points=${points}`);
    if (d.probes) Object.assign(this.probes, d.probes);
    this.detailCache.set(id, { t: now(), data: d });
    return d;
  }
}
