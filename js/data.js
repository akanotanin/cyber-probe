// 探针数据层：读监控后端的公开 API，把节点 + ping 探测整理成「鸡」的数据。
// 默认后端是 monitor hub；config.js 的 SOURCE === 'komari' 时字段映射走 js/komari.js（Komari
// 的公开 API 与 monitor 不同，但映射后聚合/暴躁鸡/详情图都不用改）。
// 页面路径形如 /chicken/，同源反代把 /chicken/api/* 转到后端的 /api/*（见 nginx 站点块）。
import * as CFG from './config.js';
import * as Komari from './komari.js';
import * as Nezha from './nezha.js';

const API = new URL('./api/', document.baseURI.replace(/[^/]*$/, ''))   // index.html 直开也要落到它的目录，不是 index.html/api/.href;

// 站点玩法选项（js/site-options.js 由一键安装器写入；没有就用下面这套默认值）
const OPT = (typeof window !== 'undefined' && window.CP_OPTIONS) || {};
const num = (v, d) => (typeof v === 'number' && isFinite(v) && v >= 0 ? v : d);
// 数据源：monitor（默认，monitor hub 的 /api/*）、komari（Komari 公开 API）或 nezha（哪吒监控公开 API）。
// site-options 里的 source 只给本地自测/手动覆盖用（安装器不会写它；生产看 config.js 的 SOURCE）。
const SRC_OPT = OPT.source === 'komari' || OPT.source === 'nezha' ? OPT.source : null;
const SRC_CFG = CFG.SOURCE === 'komari' || CFG.SOURCE === 'nezha' ? CFG.SOURCE : null;

export const CONF = {
  source: SRC_OPT || SRC_CFG || 'monitor',
  hotCpu: num(OPT.hotCpu, 55),      // CPU% 超过它就变「暴躁鸡」
  hotMem: num(OPT.hotMem, 85),      // 内存% 超过它也变暴躁
  hotMax: num(OPT.hotMax, 0),       // 最多几只暴躁鸡（0 = 不限）
  showWeb: OPT.showWeb !== false,   // 是否出现「网站鸡」
  nodeInterval: 6000,   // 节点主数据轮询
  pingInterval: 4000,   // 每个节点 ping 历史的轮询间隔（轮着来）
  maxPingAge: 300,      // ping 样本超过这么久算过期
  netHistMax: 240,      // 每台节点保留多少个平均延迟采样点（网络榜曲线用）
  worstMinGap: 90,      // 网络最差榜易主的最小播报间隔（秒）
  // hub 1.3.2 起 /api/me 会给 history_days（保留天数，1~365、默认 30），
  // 匿名查历史的 hours 上限也从写死的 168 改成它；拿不到这个字段（旧 hub）时按 7 天算。
  // Komari 的历史保留天数由 /api/public 的 record_preserve_time（小时）换算。
  // Nezha 的游客只能查 1d（指标/服务历史都是），所以固定按 1 天。
  fallbackHistoryDays: 7,
};

const now = () => Date.now() / 1000;

export function fmtBytes(v, digits = 1) {
  // 注意 `isFinite(null)` 是 true（全局 isFinite 会先转数字）—— 必须显式挡 null，
  // 否则缺字段的指标会打印成「0 B」而不是「—」（2026-11-03 复审）。
  if (v == null || !isFinite(v)) return '—';
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
/** 把「秒数」直接格式化成中文时长（服务端/hub 算好的秒数用这个，别再减浏览器时钟）。
 *  hub 1.4.0 起节点数据带 last_seen_ago —— 单元格见 seenAgo()。 */
export function fmtAgoSec(sec) {
  const s = Math.max(0, Math.round(sec || 0));
  if (s < 60) return `${s}秒前`;
  if (s < 3600) return `${Math.round(s / 60)}分前`;
  if (s < 86400) return `${(s / 3600).toFixed(1)}小时前`;
  return `${Math.round(s / 86400)}天前`;
}
/** 「这台节点上次上报距今多少秒」。★优先用 hub 1.4.0 的 last_seen_ago（按 **hub 的时钟**算出来的秒数）：
 *  拿 last_seen 减浏览器时间在访客时钟不准时会把在线的机器算成「离线 8 小时」；
 *  字段缺失/为 null（旧 hub、或这台从未上报过）才退回浏览器时钟，都没有就返回 null。 */
export function seenAgo(n) {
  if (!n) return null;
  const v = Number(n.last_seen_ago);
  if (n.last_seen_ago !== null && n.last_seen_ago !== undefined && isFinite(v) && v >= 0) return v;
  if (n.last_seen) return Math.max(0, now() - n.last_seen);
  return null;
}
export function shortCpu(name) {
  if (!name) return '—';
  return name
    .replace(/\(R\)|\(TM\)|CPU|Processor|@.*$/gi, '')
    .replace(/\s+/g, ' ').trim();
}

// ---- 数据源 ----
// signal 用来在「页面切到后台」时把在途请求一并丢弃（hub 1.4.0 起的推荐做法）。
async function getJSON(path, signal) {
  const r = await fetch(API + path, { headers: { accept: 'application/json' }, signal });
  // 错误会显示在公开页面上：把 uuid 查询值脱敏，别把节点 UUID 带进 UI。
  const safePath = path.replace(/([?&]uuid=)[^&]*/gi, '$1…');
  if (!r.ok) throw new Error(`${safePath} → HTTP ${r.status}`);
  const d = await r.json();
  // Komari 的错误也可能是 HTTP 200 + {status:"error"}（例如私有站点模式），别当成数据往下传。
  if (CONF.source === 'komari' && d && typeof d === 'object' && d.status === 'error') {
    throw new Error(d.message || `${safePath} → Komari error`);
  }
  return d;
}
/** 切后台时被打断的请求会抛 AbortError —— 那不是数据错误，别显示成「探针数据读取失败」。 */
const isAbort = (e) => !!e && (e.name === 'AbortError' || /abort/i.test(String(e.message || '')));
const abortErr = () => { const e = new Error('paused'); e.name = 'AbortError'; return e; };

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
    this.detailCache = new Map(); // `${nodeId}:${hours}:${points}` -> {t, data}
    this._rr = 0;
    this._pingSkew = 0;           // 浏览器时钟 - hub 服务器时钟（秒）；避免访客时钟偏快把样本全判过期
    // 保留天数：monitor 由 /api/me 的 history_days 给出；Komari 先读 config.js 的
    // HISTORY_DAYS（安装时按 /api/public 的 record_preserve_time 写好），运行时再刷新。
    const cfgDays = Number(CFG.HISTORY_DAYS);
    this.historyDays = isFinite(cfgDays) && cfgDays >= 1
      ? Math.min(365, Math.round(cfgDays)) : CONF.fallbackHistoryDays;
    this.me = null;
    this._listeners = new Set();
    this._t1 = null; this._t2 = null;
    this._abort = null;           // 在途请求的取消器（切后台时 abort）
    this._paused = false;         // 页面在后台 → 轮询停着
    this._nodesBusy = false;      // 节点刷新单飞：慢请求不叠加
    this._vis = null;             // visibilitychange 监听器引用
    // ---- Komari 专用状态（monitor 模式下这些字段不参与任何逻辑）----
    this._uuidIds = new Map();    // uuid -> 数字 id（前端/联机服都按数字 id 认鸡）
    this._live = null;            // KomariLive / NezhaLive（两者的 start/stop/回调形状相同）
    this._liveConnected = false;
    this._liveOnline = new Set(); // Komari WS 给的在线 uuid 列表
    this._liveReports = new Map();// Komari：uuid -> 最近一次上报（实时指标）
    // ---- Nezha 专用状态 ----
    this._services = {};          // /api/v1/service 的 services 映射（id -> ServiceResponseItem）
    this._serviceRows = [];       // mapServiceStats 的产物（给 _aggregateNezha 用）
    this.tsdbEnabled = null;      // 哪吒是否启用 TSDB（null = 还没问到 / 游客读不到 setting）
    this.siteName = '';           // 哪吒站点名（config.js 的 SITE_NAME 兜底）
    this._nzNow = 0;              // WS 帧里的服务器时间（秒）：详情窗口按它截，不信访客时钟
    this._nzSkew = 0;             // 浏览器时钟 - 服务器时钟（秒）
    this._nzFails = 0;            // WS 连续失败次数（给用户一句可行动的提示）
    this._nzLastFrameAt = 0;      // 最后一次收到 WS 帧的浏览器时刻（ms）
    this._nzStale = false;        // 已经因为长时间没帧把节点标成离线了
  }

  /** 数据源（hud 用；'monitor' | 'komari' | 'nezha'） */
  get source() { return CONF.source; }

  onChange(fn) { this._listeners.add(fn); return () => this._listeners.delete(fn); }
  _emit() { for (const fn of this._listeners) { try { fn(this); } catch (e) { console.error(e); } } }

  start() {
    this._abort = new AbortController();
    // hub 1.4.0 起第三方前端的推荐做法：页面看不到时停止轮询、丢弃在途请求，回到前台立刻拉一次。
    if (typeof document !== 'undefined' && !this._vis) {
      this._vis = () => (document.hidden ? this.pause() : this.resume());
      document.addEventListener('visibilitychange', this._vis);
    }
    // 后台标签页打开/恢复：在发任何请求之前就停，不然 start 会先拉一轮再 abort
    if (typeof document !== 'undefined' && document.hidden) {
      this.pause();
      return;
    }
    if (CONF.source === 'komari' || CONF.source === 'nezha') this._startLive();
    this.refreshMe();          // 先问后端的保留天数，详情抽屉的时间范围按它生成
    this.refreshNodes();
    this.warmup();
    this._startTimers();
  }
  _startTimers() {
    clearInterval(this._t1); clearInterval(this._t2);
    this._t1 = setInterval(() => this.refreshNodes(), CONF.nodeInterval);
    this._t2 = setInterval(() => this.refreshPing(), CONF.pingInterval);
  }
  /** 切到后台：停掉两个轮询并把在途请求丢弃（手机上不再空跑请求；Chrome 本来也会把后台定时器掐到 1 分钟一跳）。 */
  pause() {
    if (this._paused) return;
    this._paused = true;
    clearInterval(this._t1); clearInterval(this._t2);
    this._t1 = this._t2 = null;
    this._stopLive();
    try { this._abort?.abort(); } catch { /* 已经在关的路上，忽略 */ }
    this._abort = null;
  }
  /** 回到前台：立刻重拉一次节点（并顺手重问保留天数），然后恢复两个轮询。 */
  resume() {
    if (!this._paused) return;
    this._paused = false;
    this._abort = new AbortController();
    if (CONF.source === 'komari' || CONF.source === 'nezha') this._startLive();
    this.refreshMe();
    this.refreshNodes();
    this.refreshPing();
    this._startTimers();
  }
  stop() {
    clearInterval(this._t1); clearInterval(this._t2);
    this._t1 = this._t2 = null;
    if (this._vis && typeof document !== 'undefined') document.removeEventListener('visibilitychange', this._vis);
    this._vis = null;
    this._stopLive();
    try { this._abort?.abort(); } catch { /* 同上 */ }
    this._abort = null;
  }

  // ---- 实时数据（Komari 的 WS /api/clients / 哪吒的 WS /api/v1/ws/server）----
  _startLive() {
    if (this._live || (CONF.source !== 'komari' && CONF.source !== 'nezha')) return;
    if (CONF.source === 'komari') {
      const url = new URL('clients', API);
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      this._live = new Komari.KomariLive(url.href, {
        onData: (d) => this._applyLive(d),
        onState: (ok) => { this._liveConnected = !!ok; },
      });
    } else {
      // 哪吒的 WS 在 /api/v1/ws/server（同源反代把 /chicken/api/* 转到后端的 /api/*）
      const url = new URL('v1/ws/server', API);
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      this._live = new Nezha.NezhaLive(url.href, {
        onData: (d) => this._applyNezhaStream(d),
        onState: (ok) => { this._liveConnected = !!ok; },
        onFail: (n) => this._onNezhaFail(n),
      });
    }
    this._live.start();
  }

  _stopLive() {
    if (this._live) this._live.stop();
    this._live = null;
    this._liveConnected = false;
  }

  /** 哪吒 WS 一帧：{now(ms), online, servers[]}。每帧就是完整快照，直接替换节点列表。
   *  `servers` 缺失 = 游客看不到任何服务器（God 侧 omitempty），按空列表处理，
   *  否则「服务器被设成对游客隐藏」后旧鸡会一直留在场上。 */
  _applyNezhaStream(d) {
    const t = now();
    const { now: srvNow, nodes } = Nezha.parseStream(d, t);
    this._nzNow = srvNow;
    this._nzSkew = t - srvNow;         // 浏览器 - 服务器：详情窗口按服务器时钟截
    this._nzLastFrameAt = Date.now();
    this._nzStale = false;
    this.nodes = nodes;
    this._pruneNodeState();
    this._nzFails = 0;
    this.lastOk = t;
    this.error = null;
    this._aggregate();
    this._emit();
  }

  /** WS 连续失败：连不上的最常见原因是面板开了「强制认证」，或反代没给 Upgrade。
   *  连失败 3 次（约十几秒）才提示，避免一次瞬时断线就弹错误条。 */
  _onNezhaFail(n) {
    this._nzFails = n;
    if (n < 3) return;
    this.error = '连不上哪吒实时状态流（/api/v1/ws/server）：面板可能开启了「强制认证」，或反代没有透传 WebSocket';
    this._emit();
  }

  /** WS 超过 15 秒没有新帧（半开/被反代缓冲）：把还在"在线"的节点标离线。
   *  只关 socket 不够 —— 节点数据是上一帧的快照，不标就会一直显示成在线（假监控）。 */
  _checkNezhaStale() {
    if (!this._nzLastFrameAt || this._nzStale) return;
    const silent = (Date.now() - this._nzLastFrameAt) / 1000;
    if (silent < 15) return;
    this._nzStale = true;
    let changed = false;
    for (const n of this.nodes) {
      if (!n.online) continue;
      n.online = false;
      n.last_seen_ago = Math.round((Number(n.last_seen_ago) || 0) + silent);
      changed = true;
    }
    if (changed) {
      this._aggregate();
      this._emit();
    }
  }

  _friendlyNezhaError(e) {
    const msg = String((e && e.message) || e || '');
    if (/HTTP 401|HTTP 403/.test(msg)) {
      return '哪吒面板要求登录（force_auth 开启）：关掉后游客才能看到探针数据';
    }
    if (/HTTP 404/.test(msg)) {
      return '这个地址不像哪吒监控（/api/v1/service 返回 404）——确认 --hub-port / --nezha-url';
    }
    return msg;
  }

  /** WS 快照：在线的 uuid 列表 + 每台最近一次上报。刷新节点时不丢实时指标。 */
  _applyLive(d) {
    const reports = d && d.data && typeof d.data === 'object' ? d.data : {};
    this._liveReports = new Map(Object.entries(reports));
    this._liveOnline = new Set(Array.isArray(d && d.online) ? d.online : []);
    const t = now();
    for (const n of this.nodes) {
      const r = this._liveReports.get(n.uuid);
      if (r) {
        n.metrics = Komari.mapReport(r);
        n.last_seen = Komari.parseTime(r.updated_at);
      }
      n.online = this._liveOnline.has(n.uuid);
      // 在线就用 0，别拿浏览器时钟减 Komari 的 updated_at：访客时钟偏 8 小时时，
      // npc.js 会把「在线」的鸡按 last_seen_ago>300 判成失联而躺尸。
      n.last_seen_ago = n.online ? 0
        : (n.last_seen != null ? Math.max(0, Math.round(t - n.last_seen)) : null);
    }
    this.lastOk = t;
    this.error = null;
    this._aggregate();
    this._emit();
  }

  _komariId(uuid) {
    let id = this._uuidIds.get(uuid);
    if (id) return id;
    // 由 UUID 确定性哈希，而不是按 /api/nodes 的返回顺序编号：
    // 管理员看得到 hidden 节点、访客看不到，两边都从 1 数会让同一个 n<id> 指向不同 UUID，
    // 联机服的 NPC 缓存就会串鸡。哈希后同一 UUID 在任何客户端都得到同一个数字 id。
    let h = 2166136261;
    for (let i = 0; i < uuid.length; i++) {
      h ^= uuid.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    id = (h >>> 0) % 0x7fffffff || 1;
    const used = new Set(this._uuidIds.values());
    while (used.has(id)) id = (id % 0x7fffffff) + 1;   // 极小概率碰撞：线性找下一个空位
    this._uuidIds.set(uuid, id);
    return id;
  }

  _komariNode(client, t) {
    const uuid = String((client && client.uuid) || '');
    const report = this._liveReports.get(uuid) || null;
    // WS 正常时以在线列表为准；WS 断了时，_liveReports 里的报告来自 /api/recent
    // （服务端只返回最近约 1 分钟的记录），所以“有报告”本身就足以判定在线。
    // 不再用浏览器 Date.now() 和服务器 updated_at 相减 —— 访客时钟快/慢 90 秒会误判离线。
    const online = this._liveOnline.has(uuid) || (!this._liveConnected && !!report);
    const node = Komari.mapNode(client, report, online, this._komariId(uuid), t);
    if (node.online) node.last_seen_ago = 0;   // 同上：在线不信浏览器时钟
    return node;
  }

  /** WS /api/clients 不可用时的兜底：逐台读 /api/recent/<uuid>（最近 1 分钟的上报数组）。
   *  3 个 worker 限并发；WS 一旦连上就立刻停掉，不跟实时快照抢。 */
  async _komariRecentFallback(nodes, t) {
    const queue = nodes.slice();
    const stats = { ok: 0, fail: 0 };
    const worker = async () => {
      while (queue.length) {
        if (this._liveConnected) return;
        const n = queue.shift();
        if (!n.uuid) continue;
        try {
          const list = Komari.unwrap(await getJSON(`recent/${encodeURIComponent(n.uuid)}`, this._abort?.signal));
          if (this._liveConnected) return;   // 请求期间 WS 连上了：别拿旧的 recent 覆盖实时快照
          const reports = Array.isArray(list) ? list : [];
          let latest = null;
          for (const r of reports) {
            const ts = Komari.parseTime(r && r.updated_at);
            if (ts != null && (!latest || ts > latest.ts)) latest = { ts, r };
          }
          if (latest) {
            this._liveReports.set(n.uuid, latest.r);
            n.metrics = Komari.mapReport(latest.r);
            n.last_seen = latest.ts;
            // /api/recent 服务端只返回最近约 1 分钟的记录；数组非空就证明在线。
            n.online = true;
            n.last_seen_ago = 0;
          } else {
            n.online = false;
          }
          stats.ok++;
        } catch (e) {
          if (isAbort(e)) return;
          n.online = false;
          stats.fail++;
        }
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    return stats;
  }

  // hub 1.3.2 起 /api/me 多给一个 history_days（保留天数）。只影响「能看多久的历史」，
  // 拿不到（旧 hub / 请求失败）就沿用兜底值 —— 不把它当成数据源错误。
  async refreshMe() {
    if (CONF.source === 'komari') {
      try {
        // Komari 的 /api/public 是 Guest 可读的：record_preserve_time 是历史保留小时数。
        // 不拿它当数据源错误：拿不到就用 config.js 里安装时写好的 HISTORY_DAYS。
        const d = Komari.unwrap(await getJSON('public', this._abort?.signal));
        const hours = Number(d && d.record_preserve_time);
        if (isFinite(hours) && hours > 0) {
          this.historyDays = Math.min(365, Math.max(1, Math.round(hours / 24)));
        }
        this.me = d && typeof d === 'object' ? d : null;
      } catch { /* 静默：私有站点 / 旧版本没有这个字段也照常跑 */ }
      return;
    }
    if (CONF.source === 'nezha') {
      try {
        // 哪吒的 /api/v1/setting 游客可读（只会返回 config_for_guests 那一部分）。
        // tsdb_enabled 决定详情页要不要去拉资源历史（没开 TSDB 时接口成功但 data_points 为空）。
        const d = Nezha.unwrap(await getJSON('v1/setting', this._abort?.signal));
        this.tsdbEnabled = !!(d && d.tsdb_enabled === true);
        // 真实 V2 的 config 是扁平的（site_name 直接挂 config 下）；老版本文档里
        // 可能多一层 config_for_guests。两种都认，别把站名丢了。
        const cfg = d && d.config && typeof d.config === 'object' ? d.config : {};
        const guests = cfg.config_for_guests && typeof cfg.config_for_guests === 'object'
          ? cfg.config_for_guests : cfg;
        this.siteName = String((guests && guests.site_name) || '');
        // 游客只能查 1d（7d/30d 要登录）；历史窗口由 ranges() 固定成 1 小时内三档。
        this.historyDays = 1;
        this.me = d && typeof d === 'object' ? d : null;
      } catch { /* 静默：站点设置接口拿不到也不影响实时状态流 */ }
      return;
    }
    try {
      const d = await getJSON('me', this._abort?.signal);
      const hd = Number(d && d.history_days);
      if (isFinite(hd) && hd >= 1) this.historyDays = Math.min(365, Math.round(hd));
      this.me = d && typeof d === 'object' ? d : null;
    } catch { /* 静默：旧 hub 没有这个接口也照常跑 */ }
  }

  /** 详情抽屉可选的时间范围。按 hub 的保留天数生成，别写死几枚：
   *  hub 1.3.2 起匿名查历史的 hours 上限就是 history_days（旧版是 168），
   *  超过 168 小时的窗口由 hub 读小时汇总（每个点至少 1 小时），所以点数不必再放大。
   *  ⚠ history_days 的单位是「天」，接口要的 hours 是「小时」—— 别直接比（比过一次，7 天那档被自己筛掉）。 */
  ranges() {
    // 哪吒的游客只能查 1d（service/<id>/history、server/<id>/service、server/<id>/metrics 都是）；
    // 1h/6h/24h 三档都从同一份 1d 数据里按时间截，不额外发请求。
    if (CONF.source === 'nezha') {
      return [
        { label: '1 小时', hours: 1, points: 60 },
        { label: '6 小时', hours: 6, points: 120 },
        { label: '24 小时', hours: 24, points: 180 },
      ];
    }
    let maxHours = Math.max(1, Math.round(this.historyDays)) * 24;
    // Komari 的 /api/records/* 在 1.6.1 的 HTTP 桥里会丢掉 max_count（只透传 hours），
    // 长窗口会把全量分钟记录一次性取回。先按 7 天封顶，避免「全部 N 天」把页面拖死。
    if (CONF.source === 'komari') maxHours = Math.min(maxHours, 168);
    const list = [
      { label: '1 小时', hours: 1, points: 60 },
      { label: '6 小时', hours: 6, points: 120 },
      { label: '24 小时', hours: 24, points: 180 },
      { label: '7 天', hours: 168, points: 168 },
    ];
    if (maxHours > 168) {
      list.push({ label: `全部 ${this.historyDays} 天`, hours: maxHours, points: 240 });
    }
    const ok = list.filter((r) => r.hours <= maxHours);
    return ok.length ? ok : [{ label: '24 小时', hours: 24, points: 180 }];
  }

  // 首屏：并行把每个节点的 ping 拉一遍，免得网站鸡的名牌要等 30 秒才齐全
  async warmup() {
    // 哪吒的节点由 WS 推送：连上了但一台可见服务器都没有（全被隐藏）也算「首屏到了」，
    // 别为了等 nodes 空等 15 秒；monitor/Komari 仍按原来的「等节点列表」逻辑。
    const waiting = () => !this.nodes.length
      && !(CONF.source === 'nezha' && this._liveConnected);
    for (let i = 0; i < 30 && waiting(); i++) {
      if (this._paused) return;                 // 切到后台就别再空等/拉取了
      await new Promise((r) => setTimeout(r, 500));
    }
    if (this._paused) return;
    // 哪吒：节点来自 WS 推送，网站鸡来自 /api/v1/service（服务级统计）；
    // 没有再逐台拉 ping 这种轻量接口 —— 每节点延迟只在打开详情时按需读。
    if (CONF.source === 'nezha') {
      await this.refreshNodes();
      this._aggregate();
      this._emit();
      return;
    }
    // hub 1.5.0 起历史查询有并发上限（实测 4）：以前 `Promise.all(nodes.map(...))` 一次并发
    // 7 个，会有 3 个吃 503「查询历史的请求太多」，首屏网络榜就少 3 台节点。
    // 改成 3 个 worker 消费队列 —— 给详情抽屉留 1 个额度，也避开 503。
    const queue = this.nodes.slice();
    const worker = async () => {
      while (queue.length && !this._paused) {
        const n = queue.shift();
        try { await this._fetchPing(n); } catch { /* 单台失败不影响其它节点 */ }
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    this._aggregate();
    this._emit();
  }

  async refreshNodes() {
    if (this._paused || this._nodesBusy) return;  // 后台窗口 / 上一轮还没跑完：不叠加请求
    if (CONF.source === 'nezha') this._checkNezhaStale();
    this._nodesBusy = true;
    try {
      let recentStats = null;
      if (CONF.source === 'nezha') {
        // 节点由 WS 推送（每 2 秒一帧），这里只刷新服务监控的统计（网站鸡）。
        // 站点开了 force_auth 时这里会 401：给出可行动的提示，别只留一座空农场。
        const data = Nezha.unwrap(await getJSON('v1/service', this._abort?.signal));
        const services = data && typeof data.services === 'object' && data.services ? data.services : {};
        this._services = services;
        // 任务名也给 probes（详情页的图例/名称用）；interval 只有 auth-only 的 /service/list 才有，
        // 公开接口拿不到就留 null，UI 显示「—」而不是编一个 60。
        this.probes = {};
        for (const [tid, svc] of Object.entries(services)) {
          const name = svc && svc.service_name ? String(svc.service_name) : `#${tid}`;
          this.probes[tid] = name;
        }
        this._aggregate();
      } else if (CONF.source === 'komari') {
        const list = Komari.unwrap(await getJSON('nodes', this._abort?.signal));
        const t = now();
        this.nodes = (Array.isArray(list) ? list : [])
          .filter((c) => c && c.uuid)
          .map((c, i) => {
            const n = this._komariNode(c, t);
            // 数字 id 用 UUID 哈希（协议稳定），显示顺序仍跟 /api/nodes 一致。
            if (n.sort == null) n.sort = i;
            return n;
          });
        this._pruneNodeState();
        // WS 还没连上（老反代没配 /api/clients 的 Upgrade、或 Komari 刚重启）→
        // 退回逐台拉 /api/recent/<uuid>，别让整页一直显示离线。WS 连上后自动停。
        if (!this._liveConnected) recentStats = await this._komariRecentFallback(this.nodes, t);
        // 兜底拿到在线/指标后立刻重算网络榜与网站鸡，不等到下一轮 ping 轮询。
        this._aggregate();
      } else {
        const d = await getJSON('nodes', this._abort?.signal);
        // monitor 的 /api/nodes 正常是数组；d.nodes 也兼容。**必须逐项过滤**：
        // 一个 null/非对象条目会让 _pruneNodeState / onlineCount / HUD 抛异常，
        // 而 main.js 的 tick 没有 try/catch → 一次坏响应就永久停掉整个 3D 循环。
        const raw = Array.isArray(d) ? d : (d && Array.isArray(d.nodes) ? d.nodes : []);
        this.nodes = raw.filter((n) => n && typeof n === 'object');
        this._pruneNodeState();
      }
      this.lastOk = now();
      if (CONF.source === 'nezha') {
        // 服务接口成功不代表实时流通了：只在 WS 真的连着时清错误；
        // WS 断着时保留 _onNezhaFail 的提示，别让一条成功的 /service 请求把它抹掉。
        if (this._liveConnected) this.error = null;
      } else {
        // 所有 recent 都失败、WS 又没连上：给个非致命提示，别让用户只看到空农场。
        this.error = (recentStats && recentStats.fail > 0 && recentStats.ok === 0 && !this._liveConnected)
          ? 'Komari /api/recent 读取失败' : null;
      }
      this._emit();
    } catch (e) {
      if (isAbort(e)) return;
      this.error = CONF.source === 'nezha' ? this._friendlyNezhaError(e) : String(e.message || e);
      this._emit();
    } finally {
      this._nodesBusy = false;
    }
  }

  // 每 4 秒轮一个节点，取它最近 1 小时的 ping 记录（1 分钟一个桶，够新才敢当"当前值"）
  async refreshPing() {
    if (this._paused) return;
    // 哪吒没有「每节点最近一段 ping」的轻量接口：网站鸡用服务级统计，
    // 每节点延迟只在打开详情时按需查（游客 1d）。这里不发请求。
    if (CONF.source === 'nezha') return;
    if (!this.nodes.length) return;
    const n = this.nodes[this._rr++ % this.nodes.length];
    try {
      await this._fetchPing(n);
      this.lastOk = now();
      this.error = null;
      this._aggregate();
      this._emit();
    } catch (e) {
      if (isAbort(e)) return;
      this.error = String(e.message || e);
      this._emit();
    }
  }

  async _fetchPing(n) {
    if (CONF.source === 'komari') return this._fetchKomariPing(n);
    // hub 1.5.0 对历史查询有并发上限（实测 4），偶发 503「查询历史的请求太多，稍后再试」。
    // 单台失败不该让首屏缺一格：遇到 503 退避 800ms 再试一次，其它错误照旧抛出。
    let d;
    for (let attempt = 0; ; attempt++) {
      try {
        d = await getJSON(`nodes/${n.id}/metrics?hours=1&points=60&series=ping`, this._abort?.signal);
        break;
      } catch (e) {
        if (attempt >= 1 || !/HTTP 503/.test(String(e && e.message))) throw e;
        await new Promise((r) => setTimeout(r, 800));
        if (this._paused) throw abortErr();
      }
    }
    if (d.probes) Object.assign(this.probes, d.probes);
    const m = new Map();
    for (const p of (d.ping || [])) {
      if (!p || p.task_id == null) continue;
      // hub 返回的数值也做一次类型净化：字符串延迟会让 avg 变成字符串拼接，
      // 甚至把未转义的值拼进详情页 HTML（2026-11-04 复审）。
      const lat = Number(p.latency);
      const ts = Number(p.ts);
      if (!Number.isFinite(ts)) continue;
      const cur = m.get(p.task_id);
      if (!cur || ts > cur.ts) {
        m.set(p.task_id, { latency: Number.isFinite(lat) && lat >= 0 ? lat : null, ts });
      }
    }
    this._updatePingSkew(m);
    this.ping.set(n.id, m);
    if (d.loss) {
      const loss = {};
      for (const [tid, v] of Object.entries(d.loss)) {
        const nv = Number(v);
        loss[tid] = Number.isFinite(nv) ? nv : null;
      }
      this.lossByNode.set(n.id, loss);
    }
    this._netHistPush(n.id, m);
    return m;
  }

  /** Komari：一次请求就够（/records/ping 同时给 records 和 tasks 的丢包统计）。
   *  value < 0 表示这次探测丢包 —— 映射成 latency=null；丢包率优先用 tasks[].loss。 */
  async _fetchKomariPing(n) {
    if (!n.uuid) return new Map();          // /api/nodes 缺 uuid 的异常节点：没有可查的历史
    const q = encodeURIComponent(n.uuid);
    let d;
    for (let attempt = 0; ; attempt++) {
      try {
        // max_count 是 Komari 的采样上限（按任务等比例抽点），1 小时通常用不满；
        // 老版本会忽略未知 query 参数，不会报错。
        d = await getJSON(`records/ping?uuid=${q}&hours=1&max_count=600`, this._abort?.signal);
        break;
      } catch (e) {
        if (attempt >= 1 || !/HTTP (503|429)/.test(String(e && e.message))) throw e;
        await new Promise((r) => setTimeout(r, 800));
        if (this._paused) throw abortErr();
      }
    }
    const body = Komari.unwrap(d);
    const { ping, loss, probes } = Komari.mapPingPayload(body);
    Object.assign(this.probes, probes);
    const m = new Map();
    for (const p of ping) {
      const ts = Number(p.ts);
      if (!Number.isFinite(ts)) continue;
      const cur = m.get(p.task_id);
      if (!cur || ts > cur.ts) m.set(p.task_id, { latency: p.latency, ts });
    }
    this._updatePingSkew(m);
    this.ping.set(n.id, m);
    this.lossByNode.set(n.id, loss);
    this._netHistPush(n.id, m);
    return m;
  }

  /** 把服务器时间戳归一到浏览器时钟：p.ts 是 hub/Komari 的时钟，直接和 Date.now 比会受访客时钟偏差影响。 */
  _age(ts) {
    return now() - (Number(ts) + this._pingSkew);
  }
  _updatePingSkew(m) {
    let newest = 0;
    for (const v of m.values()) {
      const t = Number(v.ts);
      if (Number.isFinite(t) && t > newest) newest = t;
    }
    if (newest > 0) this._pingSkew = now() - newest;
  }

  /** 网络榜的曲线：顺手记一条"这台节点此刻的平均延迟"。 */
  _netHistPush(id, m) {
    const lats = [];
    for (const v of m.values()) if (this._age(v.ts) <= CONF.maxPingAge && v.latency != null) lats.push(v.latency);
    if (!lats.length) return;
    const avg = Math.round(lats.reduce((s, x) => s + x, 0) / lats.length);
    const h = this.netHist.get(id) || [];
    h.push({ ts: Math.round(now()), latency: avg });
    while (h.length > CONF.netHistMax) h.shift();
    this.netHist.set(id, h);
  }

  _aggregate() {
    if (CONF.source === 'nezha') { this._aggregateNezha(); return; }
    const online = this.nodes.filter((n) => n.online);
    // 新鲜样本 = 最近一次探测发生在窗口内，**不管这次是成功还是丢包**。
    // 100% 丢包的节点也要算“在测”，否则网站鸡会显示“在测 0 台”。
    const fresh = (v) => v && this._age(v.ts) <= CONF.maxPingAge;
    const tasks = new Map();

    for (const [tid, name] of Object.entries(this.probes)) {
      const id = Number(tid);
      const per = [];                 // 只放成功样本（avg/best/worst 用）
      let freshCount = 0;             // 含丢包样本
      for (const n of online) {
        const v = this.ping.get(n.id)?.get(id);
        if (!fresh(v)) continue;
        freshCount++;
        if (v.latency != null) per.push({ node: n, latency: v.latency });
      }
      per.sort((a, b) => a.latency - b.latency);
      const losses = [];
      for (const n of online) {
        const l = this.lossByNode.get(n.id)?.[tid];
        if (l != null) losses.push(l);
      }
      if (!freshCount && !losses.length) {
        delete this.probes[tid];       // 任务已从 Komari 删除 / 所有节点都没数据：别留幽灵鸡
        continue;
      }
      tasks.set(id, {
        id, name, per, n: freshCount,
        avg: per.length ? per.reduce((s, x) => s + x.latency, 0) / per.length : null,
        best: per[0] || null,
        worst: per[per.length - 1] || null,
        loss: losses.length ? losses.reduce((s, x) => s + x, 0) / losses.length : null,
      });
    }
    this.tasks = tasks;
    this._netStats();
  }

  /** 哪吒：网站鸡的统计全部来自 /api/v1/service（服务级），没有每节点实时延迟。
   *  · n = 近 15 分钟成功+失败的上报次数（nUnit='次'，不是节点数）
   *  · loss = 近 15 分钟失败占比（没有新鲜样本时退回 30 天累计）
   *  · avg = 今日平均延迟（Nezha 的 delay[29]）
   *  · per/best/worst 留空：游客接口不提供每节点当前值，UI 显示「—」；
   *    点开详情时才按需读 /service/<id>/history 画各节点曲线。
   *  网络榜/暴躁鸡的「网络最差」维度因此不可用（netRank 为空），CPU/内存阈值照常生效。 */
  _aggregateNezha() {
    this._serviceRows = Nezha.mapServiceStats(this._services);
    const tasks = new Map();
    for (const row of this._serviceRows) {
      if (!Number.isFinite(row.id)) continue;
      tasks.set(row.id, row);
    }
    this.tasks = tasks;
    this.netRank = [];
    this.worst = null;
    this.worstChange = null;
    this._pickHotTop();
  }

  _pruneNodeState() {
    const ids = new Set(this.nodes.map((n) => n.id));
    for (const k of [...this.ping.keys()]) {
      if (ids.has(k)) continue;
      this.ping.delete(k);
      this.lossByNode.delete(k);
      this.netHist.delete(k);
    }
  }

  // 每台节点的网络画像：平均延迟 / 丢包 / 曲线；最差的排最前
  _netStats() {
    const rows = [];
    for (const n of this.nodes) {
      if (!n.online) continue;
      const m = this.ping.get(n.id);
      if (!m) continue;
      const lats = [];
      let freshCount = 0;
      for (const v of m.values()) {
        if (this._age(v.ts) > CONF.maxPingAge) continue;
        freshCount++;
        if (v.latency != null) lats.push(v.latency);
      }
      if (!freshCount) continue;
      const avg = lats.length ? lats.reduce((s, x) => s + x, 0) / lats.length : null;
      const lossMap = this.lossByNode.get(n.id) || {};
      const lv = Object.values(lossMap).filter((x) => x != null);
      const loss = lv.length ? lv.reduce((s, x) => s + x, 0) / lv.length : 0;
      rows.push({
        node: n, name: n.name, avg, loss, n: freshCount,
        hist: this.netHist.get(n.id) || [],
        // 全丢包没有 avg：给一个很高的惩罚分，让它仍能成为“网络最差/暴躁鸡”。
        score: (avg == null ? 9999 : avg) * (1 + loss / 100 * 4),
      });
    }
    rows.sort((a, b) => b.score - a.score);        // 最差在前
    rows.forEach((r, i) => { r.rank = i + 1; });
    this.netRank = rows;
    const prev = this.worst;
    this.worst = rows[0] || null;
    this._pickHotTop();          // hotMax 生效：只让压力最大的前 N 只当暴躁鸡
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

  /** hotMax>0 时，挑出「压力最大」的前 N 只当暴躁鸡；=0 时不限（null 表示不启用上限） */
  _pickHotTop() {
    const cap = CONF.hotMax;
    if (!cap) { this._hotTop = null; return; }
    const load = (n) => Math.max(n.metrics?.cpu || 0, this.memPct(n));
    const worstId = this.worst?.node?.id ?? null;
    const cand = this.nodes.filter((n) => n.online && n.metrics && (this.isHot(n) || n.id === worstId));
    cand.sort((a, b) => load(b) - load(a));
    this._hotTop = new Set(cand.slice(0, cap).map((n) => n.id));
  }

  isHot(n) {
    if (!n.online || !n.metrics) return false;
    return (n.metrics.cpu || 0) > CONF.hotCpu || this.memPct(n) > CONF.hotMem;
  }
  /** 会主动攻击玩家的鸡（暴躁）：CPU/内存超阈值，或者网络画像最差的那台 */
  isAggressive(n) {
    if (!n.online) return false;
    if (this._hotTop) return this._hotTop.has(n.id);      // 设了上限：只认名单里的那几只
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

  // ---- 详情：抓某节点历史（资源 + ping），按「节点+窗口+点数」缓存 60s ----
  async nodeDetail(id, { hours = 24, points = 180, force = false } = {}) {
    if (CONF.source === 'nezha') return this._nezhaNodeDetail(id, { hours, points, force });
    // 窗口不能超过 hub 的保留天数（1.3.2 起匿名上限就是它，超了会被拒/截断）；history_days 是「天」
    hours = Math.max(1, Math.min(Math.round(hours), Math.round(this.historyDays) * 24));
    if (CONF.source === 'komari') hours = Math.min(hours, 168);   // 与 ranges() 的 7 天封顶一致
    const key = `${id}:${hours}:${points}`;
    const c = this.detailCache.get(key);
    if (!force && c && now() - c.t < 60) return c.data;
    let d;
    if (CONF.source === 'komari') {
      const n = this.nodeById(id);
      if (!n) throw new Error('节点不在列表里');
      const q = encodeURIComponent(n.uuid || '');
      // 资源和 ping 各一次；ping 的 max_count 按图表点数放大（服务端会按任务等比采样，
      // 统计值仍按全量记录算）。历史窗口已经按 historyDays 夹过，不会越界。
      const cap = Math.max(120, Math.min(4000, Math.round(points) * 8));
      const signal = this._abort?.signal;
      const [load, ping] = await Promise.all([
        getJSON(`records/load?uuid=${q}&load_type=all&hours=${hours}`, signal),
        getJSON(`records/ping?uuid=${q}&hours=${hours}&max_count=${cap}`, signal),
      ]);
      d = Komari.mapDetail(Komari.unwrap(load), Komari.unwrap(ping));
    } else {
      // 历史查询有并发上限（实测 4），撞上 503 就退避重试；其它错误照旧抛出。
      // 详情页一次要拉多台，没有退避时被拒的那几台会静默少线（子代理审查指出）。
      for (let attempt = 0; ; attempt++) {
        try {
          d = await getJSON(`nodes/${id}/metrics?hours=${hours}&points=${points}`, this._abort?.signal);
          break;
        } catch (e) {
          if (attempt >= 2 || !/HTTP 503/.test(String(e && e.message))) throw e;
          await new Promise((r) => setTimeout(r, 600 * (attempt + 1)));
          if (this._paused) throw abortErr();
        }
      }
      if (d.probes) Object.assign(this.probes, d.probes);
    }
    if (CONF.source === 'komari' && d.probes) Object.assign(this.probes, d.probes);
    this._cacheDetail(key, d);
    return d;
  }

  /** 详情缓存封顶：节点 × 时间档 × 长历史，一直开着面板会越积越大（Map 保序 → 删最旧）。
   *  cache key 带数据源前缀，切数据源时不会串数据。 */
  _cacheDetail(key, data) {
    this.detailCache.set(key, { t: now(), data });
    while (this.detailCache.size > 24) {
      this.detailCache.delete(this.detailCache.keys().next().value);
    }
  }

  /** 服务器时钟（秒）：哪吒的 WS 帧每 2 秒带一次 now，用「浏览器 + 固定偏差」换算，
   *  访客时钟偏 8 小时也不会把 24 小时窗口截成空的。 */
  _serverNow() { return this._nzNow ? now() - this._nzSkew : now(); }

  /** 详情窗口的参考时刻：优先服务器时钟；WS 没连上（例如反代没透传 Upgrade）时
   *  退回「数据里最新的时间戳」—— 访客时钟偏几小时也不会把 1h/6h 窗口截空；
   *  两者都没有才用浏览器时钟。 */
  _refNow(points) {
    // 只信「最近还在推」的服务器时钟；帧已经停了就用数据里最新的时间戳。
    if (this._nzNow && this._nzLastFrameAt && Date.now() - this._nzLastFrameAt < 30000) {
      return this._serverNow();
    }
    let max = 0;
    for (const p of points || []) {
      const ts = Number(p && p.ts);
      if (isFinite(ts) && ts > max) max = ts;
    }
    return max > 0 ? max : now();
  }

  /** 哪吒节点详情：
   *  · 网络延迟页签 ← /api/v1/server/<id>/service?period=1d（一次拿全部服务，游客 1d）
   *  · 资源页签 ← /api/v1/server/<id>/metrics?metric=..&period=1d（每个指标一次，要 TSDB）
   *  资源接口失败不连累延迟页签：两边各自有数据就各自画，缺的在 note 里说清楚。
   *  ⚠ 必须等所有请求都结束（allSettled）再判断，否则先到的失败会覆盖已经拿到的数据。
   *
   *  ★ 缓存的是**未截窗口的 1d 原始数据**（nzraw:<id>），不是每个时间档各存一份：
   *    哪吒游客只有 period=1d，1h/6h/24h 都是客户端截同一份数据 —— 以前把 hours
   *    放进 cache key，切一次档位就把同样的 10 个请求（含 9 个 TSDB 查询）重发一遍。 */
  async _nezhaNodeDetail(id, { hours = 24, points = 180, force = false } = {}) {
    hours = Math.max(1, Math.min(24, Math.round(hours)));
    const raw = await this._nezhaNodeRaw(id, force);
    const svc = raw.svc;

    // 延迟：按 task 分组抽稀（同一张图里每条线最多 points 个点）
    const srvNow = this._refNow([...svc.ping, ...raw.rows]);
    const byTask = new Map();
    for (const p of Nezha.inWindow(svc.ping, hours, srvNow)) {
      const list = byTask.get(p.task_id) || [];
      list.push(p);
      byTask.set(p.task_id, list);
    }
    const ping = [];
    for (const list of byTask.values()) ping.push(...Nezha.downsample(list, points));
    ping.sort((a, b) => a.ts - b.ts);

    const rows = Nezha.downsample(Nezha.inWindow(raw.rows, hours, srvNow), points);
    let note = '';
    if (this.tsdbEnabled === false) note = '哪吒面板未启用 TSDB：历史资源曲线不可用（实时数据正常）';
    else if (raw.metricFails && !rows.length) note = '哪吒的资源历史读取失败（实时数据正常）';
    return { metrics: rows, ping, probes: svc.probes, loss: svc.loss, note };
  }

  /** 抓某台哪吒节点的 1d 原始资源/延迟数据并缓存 60s。窗口截取在调用方做。 */
  async _nezhaNodeRaw(id, force = false) {
    const key = `nzraw:${id}`;
    const c = this.detailCache.get(key);
    if (!force && c && now() - c.t < 60) return c.data;
    const signal = this._abort?.signal;
    const metrics = this.tsdbEnabled === false
      ? []   // 没开 TSDB：接口会成功但 data_points 为空，别白发 9 个请求
      : ['cpu', 'memory', 'swap', 'disk', 'net_in_speed', 'net_out_speed', 'tcp_conn', 'udp_conn', 'process_count'];
    const reqs = [getJSON(`v1/server/${id}/service?period=1d`, signal)];
    for (const m of metrics) reqs.push(getJSON(`v1/server/${id}/metrics?metric=${m}&period=1d`, signal));
    const settled = await Promise.allSettled(reqs);
    if (isAbort(settled[0].reason)) throw settled[0].reason;

    let svc = { ping: [], probes: {}, loss: {} };
    if (settled[0].status === 'fulfilled') {
      try { svc = Nezha.mapServerServices(Nezha.unwrap(settled[0].value)); } catch { /* 坏响应按空处理 */ }
    }
    Object.assign(this.probes, svc.probes);

    const raw = [];
    let metricFails = 0;
    for (let i = 1; i < settled.length; i++) {
      const r = settled[i];
      if (r.status !== 'fulfilled') { if (!isAbort(r.reason)) metricFails++; continue; }
      try { raw.push(Nezha.unwrap(r.value)); } catch { metricFails++; }
    }
    const data = {
      svc,
      rows: Nezha.mergeMetrics(raw),   // 未截窗口：1h/6h/24h 共用这一份
      metricFails,
      fetchedAt: now(),
    };
    this._cacheDetail(key, data);
    return data;
  }

  /** 哪吒网站鸡详情：一次 /api/v1/service/<id>/history?period=1d 就拿到**所有节点**的曲线，
   *  不用像 monitor 那样逐台节点查（那会按节点数放大请求与流量）。
   *  同样缓存未截窗口的原始 1d 数据（nztraw:<id>），切时间档不重发请求。 */
  async taskHistory(id, { hours = 24, points = 180, force = false } = {}) {
    hours = Math.max(1, Math.min(24, Math.round(hours)));
    const raw = await this._nezhaTaskRaw(id, force);
    const hist = raw.hist;
    const all = [];
    for (const s of hist.servers) all.push(...s.points);
    // 只有 WS 还在推时才敢把「服务器当前时间 - 15 分钟」当当前值；
    // WS 没连上时窗口退回最新历史点，但不把一小时前的点冒充「当前」。
    const liveClock = !!(this._nzNow && this._nzLastFrameAt
      && Date.now() - this._nzLastFrameAt < 30000);
    const srvNow = liveClock ? this._serverNow() : this._refNow(all);
    const series = [];
    const latest = [];
    for (const s of hist.servers) {
      const pts = Nezha.downsample(Nezha.inWindow(s.points, hours, srvNow), points)
        .map((p) => [p.ts, p.latency]);
      if (!pts.length) continue;
      series.push({ id: s.id, name: s.name, points: pts });
      // 当前值只认最近 15 分钟内的最后一个采样；太久以前的不叫「当前」
      let last = null;
      if (liveClock) {
        for (const p of s.points) {
          if (p.latency != null && p.ts >= srvNow - 15 * 60) last = p;
        }
      }
      latest.push({ id: s.id, name: s.name, latency: last ? last.latency : null, loss: s.loss });
    }
    return { series, latest, probes: hist.probes, serviceName: hist.serviceName };
  }

  async _nezhaTaskRaw(id, force = false) {
    const key = `nztraw:${id}`;
    const c = this.detailCache.get(key);
    if (!force && c && now() - c.t < 60) return c.data;
    const body = Nezha.unwrap(await getJSON(
      `v1/service/${id}/history?period=1d`, this._abort?.signal));
    const hist = Nezha.mapServiceHistory(body);
    Object.assign(this.probes, hist.probes);
    const data = { hist, fetchedAt: now() };
    this._cacheDetail(key, data);
    return data;
  }
}
