// 哪吒监控（Nezha）公开 API 适配层（https://nezha.wiki/developer/api.html）：
// 把 Nezha V2 的实时状态流 / 服务监控 / 历史记录映射成 monitor hub 的数据形状，
// js/data.js 的其余部分（聚合、暴躁鸡、详情图）因此完全不用改。
//
// 只在 config.js 的 SOURCE === 'nezha' 时启用；默认仍是 monitor。
//
// 数据来源（全部是**游客**可读的接口；站点必须关闭「强制认证」，服务器不能「对游客隐藏」）：
//   WS  /api/v1/ws/server                        每 2 秒一帧 {now, online, servers[]}（含 Host/State）
//   GET /api/v1/setting                          站名 + tsdb_enabled（游客可读的那部分配置）
//   GET /api/v1/service                          服务监控当前状态：近 15 分钟成功/失败次数 + 今日均值
//   GET /api/v1/service/<id>/history?period=1d   某服务在各节点上的历史延迟（游客只能 1d）
//   GET /api/v1/server/<id>/service?period=1d    某节点上各服务的历史延迟
//   GET /api/v1/server/<id>/metrics?metric=..&period=1d   资源历史（要面板启用 TSDB，否则空数组）
//
// 隐私：这里只做字段映射，不缓存、不落盘任何 IP/密钥。Nezha 的公开 API 本来就不返回节点 IP；
// 节点名与公开备注是对外展示字段（哪吒自己的前台也显示），照常映射。
//
// ⚠ 与 monitor/Komari 的差异（数据层已按此适配，UI 会显示「—」而不是假数据）：
//   · 没有「每节点实时延迟」这种轻量接口：服务级统计只有近 15 分钟的样本计数与今日均值；
//     每节点的延迟曲线要点开详情时按需读 /server/<id>/service（游客 1 天窗口）。
//   · 游客只能查 1d；7d/30d 需要登录（本前端不假设访客已登录哪吒）。

const FIN = (v) => (typeof v === 'number' && isFinite(v) ? v : null);
const INT = (v) => {
  const n = Number(v);
  return isFinite(n) ? Math.round(n) : null;
};
const POS = (v) => {
  const n = FIN(v);
  return n != null && n >= 0 ? n : null;
};
const arr = (v) => (Array.isArray(v) ? v : []);

/** 节点「在线」的判定窗口（秒）：哪吒自己的在线历史接口用「最近 30 秒有上报」，
 *  这里放宽到 60 秒 —— Agent 上报间隔大的机器不会在页面上反复躺下又站起来。 */
export const ONLINE_MAX_AGE = 60;

/** Nezha 的 `{success, data}` 包络解包。错误在 HTTP 200 里也常见，不能只靠 r.ok。 */
export function unwrap(json) {
  if (json && typeof json === 'object' && 'success' in json) {
    if (json.success !== true) throw new Error(String(json.error || 'Nezha API 返回失败'));
    return json.data;
  }
  // 少数错误页只有 {error}（没有 success 字段）：别把它当数据往下传。
  if (json && typeof json === 'object' && typeof json.error === 'string' && json.error) {
    throw new Error(json.error);
  }
  return json;
}

/** RFC3339 / ISO 时间 → Unix 秒；解析不了返回 null。
 *  Go 的零值时间 `0001-01-01T00:00:00Z` 也解析得出来，调用方按「<= 0 / 年份太早」当没上报过。 */
export function parseTime(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return v > 1e12 ? v / 1000 : v; // 兼容毫秒时间戳
  const s = String(v).trim();
  let t = Date.parse(s);
  if (!isFinite(t)) {
    // Go time.Time 的纳秒小数位让部分浏览器 Date.parse 直接 NaN：截到毫秒再试一次。
    const m = s.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/);
    if (m) t = Date.parse(m[1] + (m[2] ? m[2].slice(0, 4) : '') + (m[3] || 'Z'));
  }
  return isFinite(t) ? t / 1000 : null;
}

/** 国家码：Nezha 的 country_code 正常是两位字母；其它写法退化成空（前端显示 🌐）。 */
export function countryCode(code) {
  const s = String(code || '').trim();
  return /^[A-Za-z]{2}$/.test(s) ? s.toUpperCase() : '';
}

/** 实时状态（WS 帧里的 state）→ 前端 metrics。缺字段保持 null，让 UI 显示「—」而不是 0。
 *  ⚠ Nezha 的 HostState 字段都带 omitempty：0 值会被省略，和「没有这个指标」不可区分，
 *  所以 cpu=0% 的机器这里也是 null —— 宁可显示「—」也不编一个 0。 */
export function mapState(state) {
  const s = state && typeof state === 'object' ? state : {};
  const m = {
    cpu: FIN(s.cpu),
    mem_used: POS(s.mem_used),
    swap_used: POS(s.swap_used),
    disk_used: POS(s.disk_used),
    net_rx: POS(s.net_in_speed),        // 与 monitor 的网速口径一致：rx = 下行
    net_tx: POS(s.net_out_speed),
    net_total_rx: POS(s.net_in_transfer),
    net_total_tx: POS(s.net_out_transfer),
    uptime: POS(s.uptime),
    procs: POS(s.process_count),
    tcp: POS(s.tcp_conn_count),
    udp: POS(s.udp_conn_count),
    // npc.js / 图表都按 monitor 的 load[0..2]（1/5/15 分钟）取值
    load: [FIN(s.load_1), FIN(s.load_5), FIN(s.load_15)],
  };
  const values = [m.cpu, m.mem_used, m.swap_used, m.disk_used, m.net_rx, m.net_tx,
    m.net_total_rx, m.net_total_tx, m.uptime, m.procs, m.tcp, m.udp, ...m.load];
  return values.some((v) => v != null) ? m : null;
}

/** 一帧 WS 里的 server → monitor hub 的节点形状。
 *  @param s       StreamServer
 *  @param nowSec  **服务器**当前时间（帧里的 now/1000）；访客时钟不准时也不会算错在线时长。
 */
export function mapServer(s, nowSec) {
  const v = s && typeof s === 'object' ? s : {};
  const host = v.host && typeof v.host === 'object' ? v.host : {};
  // V2 的 Host.CPU 是 []string；个别旧版本/主题给单个字符串时也认。
  const cpus = typeof host.cpu === 'string' ? [host.cpu] : arr(host.cpu);
  const id = INT(v.id);
  const lastActive = parseTime(v.last_active);
  // Go 的零值时间（从未上报）是 0001 年：当成「没上报过」，别算成上线了 2000 年。
  const seen = lastActive != null && lastActive > 1e9 ? lastActive : null;
  const age = seen != null && nowSec != null && isFinite(nowSec)
    ? Math.max(0, Math.round(nowSec - seen)) : null;
  const m = mapState(v.state);
  if (m) {
    // 容量在 Host 里（state 只有 used）：补到 metrics 上，详情图轴顶/内存百分比直接用。
    m.mem_total = POS(host.mem_total);
    m.disk_total = POS(host.disk_total);
    m.swap_total = POS(host.swap_total);
    m.updated_at = seen;
  }
  return {
    id,
    uuid: '',
    name: String(v.name || (id != null ? `#${id}` : '未命名')),
    // 在线看「最近一次上报距今多少秒」，不看 state 里有没有字段（离线机器的缓存 state 还在）。
    online: age != null && age <= ONLINE_MAX_AGE,
    country: countryCode(v.country_code),
    // 游客拿到的 Host 会滤掉 platform_version / version / GPU（见哪吒 serverStream 的 Filter）；
    // 能拿到就拼上，拿不到只显示 platform。
    os: [host.platform, host.platform_version].filter(Boolean).join(' '),
    virt: host.virtualization || '',
    arch: host.arch || '',
    kernel: '',                       // Nezha 的 Host 没有内核版本字段
    cpu_name: cpus[0] || '',
    cpu_cores: cpus.length || 0,
    mem_total: POS(host.mem_total) || 0,
    swap_total: POS(host.swap_total) || 0,
    disk_total: POS(host.disk_total) || 0,
    public_remark: v.public_note || '',
    group: '',
    tags: '',
    metrics: m,
    last_seen: seen,
    // 在线一律按 0：哪吒服务器时钟与浏览器时钟可能有偏差，npc.js 用 >300 判失联，
    // 拿浏览器时间减服务器 last_active 会在时钟快的访客上把在线鸡判成躺尸。
    last_seen_ago: age,
    // Nezha 没有「今日流量」字段：留 null，卡片显示「—」，不要拿累计流量冒充。
    day_rx: null,
    day_tx: null,
  };
}

/** 一帧 WS 正文 → { now, servers, nodes }。`servers` 缺失按空列表处理：
 *  Go 的 omitempty 会把「一台可见服务器都没有」发成不带的字段（游客可见性过滤后很常见）。 */
export function parseStream(json, fallbackNowSec = Date.now() / 1000) {
  const d = json && typeof json === 'object' ? json : {};
  const nowMs = Number(d.now);
  // 正常是毫秒（Go: Unix()*1000）；个别老版本/反代给秒就按秒认，免得把「现在」解析成 1970。
  const now = Number.isFinite(nowMs) && nowMs > 0
    ? (nowMs > 1e12 ? nowMs / 1000 : nowMs)
    : fallbackNowSec;
  const servers = arr(d.servers);
  const nodes = servers
    .filter((s) => s && typeof s === 'object' && s.id != null && isFinite(Number(s.id)))
    .map((s) => mapServer(s, now));
  return { now, nodes };
}

/** /api/v1/service 的 services 映射 → 网站鸡的任务统计。
 *  · current_up / current_down = **最近 15 分钟**内的成功/失败上报次数（不是台数）
 *  · delay[29] = 今日平均延迟（30 天数组的最后一位；老版本数组短就取最后一项）
 *  · total_up / total_down = 30 天累计
 *  所以这里 n 的单位是「次」，UI 用 nUnit 区分；per/best/worst 留空（游客拿不到每节点实时值）。 */
export function mapServiceStats(services) {
  const out = [];
  const src = services && typeof services === 'object' ? services : {};
  for (const [key, raw] of Object.entries(src)) {
    const id = Number(key);
    const s = raw && typeof raw === 'object' ? raw : {};
    const currentUp = POS(s.current_up) || 0;
    const currentDown = POS(s.current_down) || 0;
    const totalUp = POS(s.total_up) || 0;
    const totalDown = POS(s.total_down) || 0;
    const samples = currentUp + currentDown;
    const total = totalUp + totalDown;
    const delays = arr(s.delay).map((v) => FIN(v));
    // 只认最后一个非 null 的日平均值：数组前面是历史，最后一位才是「今天」。
    let today = null;
    for (let i = delays.length - 1; i >= 0; i--) {
      if (delays[i] != null) { today = delays[i]; break; }
    }
    out.push({
      id,
      name: String(s.service_name || `#${id}`),
      per: [],
      best: null,
      worst: null,
      // n = 近 15 分钟的探测样本数；样本为 0 但有 30 天累计时，n 仍是 0（不编台数）
      n: samples,
      nUnit: '次',
      avg: today != null && today > 0 ? today : null,
      // 丢包优先用近 15 分钟样本占比；没有新鲜样本时退回 30 天累计比例。
      loss: samples > 0 ? currentDown / samples * 100
        : (total > 0 ? totalDown / total * 100 : null),
      currentUp,
      currentDown,
      totalUp,
      totalDown,
    });
  }
  return out;
}

/** /api/v1/service/<id>/history 的 response → 详情/曲线用的数据。
 *  Nezha 的 DataPoint: {ts(ms), delay, status}，status=0 表示这次探测失败（delay 不可信）。 */
export function mapServiceHistory(d) {
  const body = d && typeof d === 'object' ? d : {};
  const serviceId = INT(body.service_id);
  const tasks = [];
  const servers = [];
  for (const raw of arr(body.servers)) {
    if (!raw || typeof raw !== 'object') continue;
    const sid = INT(raw.server_id);
    const name = String(raw.server_name || (sid != null ? `节点 ${sid}` : '节点'));
    const stats = raw.stats && typeof raw.stats === 'object' ? raw.stats : {};
    const points = [];
    for (const p of arr(stats.data_points)) {
      const ts = parseTime(p && p.ts);
      if (ts == null || ts <= 0) continue;
      const st = p && p.status != null ? Number(p.status) : 1;
      const delay = p && p.delay != null ? Number(p.delay) : NaN;
      // status=0 是失败：不能把 0ms 当成功延迟画进曲线
      const latency = st !== 0 && isFinite(delay) && delay >= 0 ? delay : null;
      points.push({ ts, latency });
    }
    points.sort((a, b) => a.ts - b.ts);
    const totalUp = POS(stats.total_up) || 0;
    const totalDown = POS(stats.total_down) || 0;
    const denom = totalUp + totalDown;
    servers.push({
      id: sid,
      name,
      points,
      avg: FIN(stats.avg_delay),
      loss: denom > 0 ? totalDown / denom * 100 : (FIN(stats.up_percent) != null ? 100 - stats.up_percent : null),
    });
    for (const p of points) tasks.push({ task_id: serviceId, ts: p.ts, latency: p.latency });
  }
  return {
    serviceId,
    serviceName: String(body.service_name || ''),
    servers,
    ping: tasks,
    probes: serviceId != null && body.service_name ? { [serviceId]: String(body.service_name) } : {},
  };
}

/** /api/v1/server/<id>/service 的数组 → 某节点上各服务的历史延迟（网络延迟页签）。
 *  ServiceInfos: {monitor_id, monitor_name, server_id, created_at[], avg_delay[], packet_loss[]?} */
export function mapServerServices(list) {
  const ping = [];
  const probes = {};
  const loss = {};
  for (const raw of arr(list)) {
    if (!raw || typeof raw !== 'object') continue;
    const tid = INT(raw.monitor_id != null ? raw.monitor_id : raw.service_id);
    if (tid == null) continue;
    const name = String(raw.monitor_name || raw.service_name || `#${tid}`);
    probes[tid] = name;
    const tsArr = arr(raw.created_at);
    const latArr = arr(raw.avg_delay);
    const lossArr = arr(raw.packet_loss);
    let n = 0, down = 0;
    for (let i = 0; i < tsArr.length; i++) {
      const ts = parseTime(tsArr[i]);
      if (ts == null || ts <= 0) continue;
      const rawLat = latArr[i];
      const lat = rawLat == null ? NaN : Number(rawLat);
      // 旧接口不带 status：0/空值按失败处理（与 service/history 的 status=0 口径一致）
      const latency = isFinite(lat) && lat > 0 ? lat : null;
      ping.push({ task_id: tid, ts, latency });
      n++;
      if (latency == null) down++;
    }
    const pl = FIN(lossArr[lossArr.length - 1]);
    loss[tid] = pl != null ? Math.max(0, Math.min(100, pl)) : (n > 0 ? down / n * 100 : null);
  }
  return { ping, probes, loss };
}

const METRIC_FIELD = {
  cpu: 'cpu',
  memory: 'mem_used',
  swap: 'swap_used',
  disk: 'disk_used',
  net_in_speed: 'net_rx',
  net_out_speed: 'net_tx',
  net_in_transfer: 'net_total_rx',
  net_out_transfer: 'net_total_tx',
  load1: 'load1',
  load5: 'load5',
  load15: 'load15',
  tcp_conn: 'tcp',
  udp_conn: 'udp',
  process_count: 'procs',
  uptime: 'uptime',
};

/** /api/v1/server/<id>/metrics?metric=... 的多份响应 → 按时间合并的行（详情资源页用）。
 *  Nezha 一次只能查一个指标（data_points: [{ts(ms), value}]），这里按 ts 合并成 monitor 的行形状。 */
export function mergeMetrics(responses) {
  const rows = new Map();
  for (const res of arr(responses)) {
    if (!res || typeof res !== 'object') continue;
    const metric = String(res.metric || '');
    const field = METRIC_FIELD[metric];
    if (!field) continue;
    for (const p of arr(res.data_points)) {
      const ts = parseTime(p && p.ts);
      const value = p && p.value != null ? Number(p.value) : NaN;
      if (ts == null || ts <= 0 || !isFinite(value)) continue;
      const key = Math.round(ts);
      let row = rows.get(key);
      if (!row) { row = { ts: key }; rows.set(key, row); }
      if (field === 'load1') (row.load = row.load || [null, null, null])[0] = value;
      else if (field === 'load5') (row.load = row.load || [null, null, null])[1] = value;
      else if (field === 'load15') (row.load = row.load || [null, null, null])[2] = value;
      else row[field] = value;
    }
  }
  return [...rows.values()].sort((a, b) => a.ts - b.ts);
}

/** 按时间窗口截取（ts 单位秒）。nowSec 用**服务器时钟**（WS 帧的 now），别用访客时钟。 */
export function inWindow(rows, hours, nowSec) {
  const cut = (nowSec || Date.now() / 1000) - Math.max(1, Number(hours) || 1) * 3600;
  return arr(rows).filter((r) => r && Number(r.ts) >= cut);
}

/** 均匀抽稀到约 points 个点（详情图 760px 宽，不用把 2880 个分钟点全画出来）。
 *  取每个桶的**最后一个**点：曲线形状与真实值都保留，不引入平均造成的假峰值。 */
export function downsample(rows, points) {
  const list = arr(rows);
  const n = Math.max(2, Math.min(4000, Math.round(Number(points) || 0) || 2));
  if (list.length <= n) return list;
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push(list[Math.min(list.length - 1, Math.floor(i * list.length / n))]);
  }
  return out;
}

/** 哪吒的实时状态流是服务端每 2 秒**推送**一帧，不需要客户端发订阅消息。
 *  断线按 3s → 15s 退避重连；页面切后台时 data.js 会 stop()（不空跑连接）。 */
export class NezhaLive {
  constructor(url, { onData, onState, onFail } = {}) {
    this.url = url;
    this.onData = onData;
    this.onState = onState;
    this.onFail = onFail;
    this.ws = null;
    this.stopped = false;
    this.timer = null;
    this.fails = 0;
  }

  start() {
    if (!this.stopped && this.ws) return;
    this.stopped = false;
    this._connect();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.timer = null;
    const ws = this.ws;
    this.ws = null;
    try { ws?.close(); } catch { /* 已经在关的路上，忽略 */ }
    this.onState?.(false);
  }

  _connect() {
    if (this.stopped) return;
    let ws;
    try {
      ws = new WebSocket(this.url);
    } catch (e) {
      this._later();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.fails = 0;
      this.onState?.(true);
    };
    ws.onmessage = (ev) => {
      if (this.ws !== ws) return;
      let d;
      try { d = JSON.parse(ev.data); } catch { return; }   // 半帧/坏帧：跳过，别停掉连接
      this.onData?.(d);
    };
    ws.onerror = () => { /* 浏览器随后会触发 close，不在这里重复重连 */ };
    ws.onclose = () => {
      if (this.ws !== ws) return;                        // 旧连接迟到的 close 不能动新连接
      this.ws = null;
      this.onState?.(false);
      this._later();
    };
  }

  _later() {
    if (this.stopped) return;
    const n = Math.min(6, this.fails++);
    const ms = Math.min(15000, 3000 * Math.pow(1.5, n));
    this.onFail?.(this.fails);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this._connect(), ms);
  }
}
