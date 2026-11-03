// HUD：顶栏、啄倒榜、播报、自身状态、详情抽屉（纯 canvas 画图，不引图表库）
import { fmtBytes, fmtRate, fmtPct, fmtUptime, fmtAgoSec, seenAgo, shortCpu, CONF } from './data.js';
import { PROBES } from './config.js';
import { GOOSE } from './goose.js';
import { DOG } from './dog.js';

const $ = (id) => document.getElementById(id);
const PALETTE = ['#63b6ff', '#7ddc6a', '#ffd166', '#ff8f6b', '#c792ea', '#4dd0e1', '#f06292', '#aed581', '#fff176'];

export class Hud {
  constructor(farm) {
    this.farm = farm;
    this.online = $('online'); this.onlineTotal = $('online-total');
    this.webOnline = $('web-online'); this.webTotal = $('web-total');
    this.hot = $('hot');
    // 右上啄倒榜 + 左下自身卡片（行数据由 main.js 从快照 ps/ns 里算好再喂进来）
    this.boardEl = $('board'); this.boardTitle = $('board-title'); this.boardRows = $('board-rows');
    this.meName = $('me-name'); this.hpfill = $('hpfill'); this.scoreEl = $('score');
    this.boardEl.addEventListener('click', () => { this.collapsed = !this.collapsed; this.renderBoard(true); });
    this.feedEl = $('feed'); this.bannerEl = $('banner');
    this.errbar = $('errbar');
    // 探针列表悬浮层：列表 + 服务器详情 + 管理后台入口都在这一个面板里（右侧详情抽屉已删）
    this.plist = $('plist'); this.plistBody = $('plist-body'); this.plistSum = $('plist-sum');
    this.plistDetail = $('plist-detail'); this.plistTitle = $('plist-title');
    this.plistBack = $('plist-back'); this.plistNote = $('plist-note');
    this.probesOpen = false;
    this.view = 'list';               // 'list' | 'detail'
    this._plistSig = '';
    this._detailToken = 0;
    $('btn-probes')?.addEventListener('click', () => this.toggleProbes());
    this.plistBack?.addEventListener('click', () => this.backToList());
    $('plist-close')?.addEventListener('click', () => this.hideProbes());
    // 点遮罩关掉；点卡片 → 在同一个面板里换成这台机器的详情
    this.plist?.addEventListener('click', (e) => { if (e.target === this.plist) this.hideProbes(); });
    this.plistBody?.addEventListener('click', (e) => {
      const b = e.target.closest?.('.pcard');
      if (!b) return;
      const id = Number(b.dataset.id);
      if (Number.isFinite(id)) this.showDetail({ kind: 'probe', nodeId: id });
    });
    this.collapsed = true;            // 啄倒榜默认收起（点标题展开）
    this.rows = [];                   // 榜单行（main.js 每次快照喂进来）
    this.leftBoard = [];              // 离场玩家的啄倒记录（服务端 roster.left 下发）
    this._boardSig = '';              // 差量签名：内容没变就不碰 DOM
    this._boardAt = 0;                // 上次写 DOM 的时间（节流上限）
    this.myId = 'me';
    this.onSelect = null;
    this.feedEl = $('feed');
    this._worstSeen = 0;
  }

  // ---------- 顶栏 ----------
  updateCounters() {
    const f = this.farm;
    const webTasks = [...f.tasks.values()];
    const webOk = webTasks.filter((t) => t.n > 0).length;
    this.online.textContent = f.onlineCount;
    this.onlineTotal.textContent = f.nodes.length;
    // showWeb=false 时网站鸡根本不会被上报/生成；这一格再显示「在线 n/n」就自相矛盾 → 直接隐藏
    const webStat = this.webOnline?.closest?.('.stat');
    if (webStat) webStat.classList.toggle('hidden', !CONF.showWeb);
    this.webOnline.textContent = webOk;
    this.webTotal.textContent = webTasks.length;
    this.hot.textContent = f.hotCount;
    if (f.error) this.showError(`探针数据读取失败：${f.error}`);
    else this.hideError();
    // 悬浮层开着才跟着刷新（只刷列表视图；详情视图有自己的渲染流程）
    if (this.probesOpen && this.view === 'list') this.renderProbes();
  }

  // ---------- 探针列表悬浮层：列表 / 详情两态，都在同一个面板里 ----------
  toggleProbes() { if (this.probesOpen) this.hideProbes(); else this.showProbes(); }
  showProbes() {
    if (!this.plist) return;
    this.probesOpen = true;
    this.view = 'list';
    this._detailToken++;               // 让在途的详情渲染作废
    this.plist.classList.remove('is-detail');
    this.plist.classList.remove('hidden');
    this.plistBody.classList.remove('hidden');
    this.plistDetail.classList.add('hidden');
    this.plistNote.classList.remove('hidden');
    this.plistBack.classList.add('hidden');
    this.plistTitle.textContent = '🖥 探针列表';
    this._plistSig = '';
    this.renderProbes(true);
    // 指针锁定时点不到按钮，但 Tab 也走这条路 —— 统一解锁
    if (document.pointerLockElement) document.exitPointerLock?.();
  }
  hideProbes() {
    if (!this.plist) return;
    this.probesOpen = false;
    this.view = 'list';
    this._detailToken++;
    this.plist.classList.remove('is-detail');
    this.plist.classList.add('hidden');
  }
  /** Esc 的语义：详情 → 回列表；列表 → 关面板（Tab 则是直接开关） */
  escProbes() {
    if (!this.probesOpen) return;
    if (this.view === 'detail') this.backToList();
    else this.hideProbes();
  }
  backToList() {
    if (!this.plist) return;
    this.view = 'list';
    this._detailToken++;
    this.plist.classList.remove('is-detail');
    this.plistDetail.classList.add('hidden');
    this.plistBody.classList.remove('hidden');
    this.plistNote.classList.remove('hidden');
    this.plistBack.classList.add('hidden');
    this.plistTitle.textContent = '🖥 探针列表';
    this._plistSig = '';               // 回列表按最新数据重画
    this.renderProbes(true);
  }
  /** 重画列表。数据每 6 秒一轮，所以只在数值真变了才重建（并保住滚动位置）。 */
  renderProbes(force = false) {
    if (!this.plist || !this.probesOpen) return;
    const f = this.farm;
    // 顺序跟后台一致（hub 的 sort，其次 id）
    const nodes = f.nodes.slice().sort((a, b) => (Number(a.sort) || 0) - (Number(b.sort) || 0) || a.id - b.id);
    const netOf = (n) => f.netRowById(n.id);
    const sig = nodes.map((n) => {
      const m = n.metrics || {}, r = netOf(n);
      return [n.id, n.online ? 1 : 0, n.name, n.public_remark, m.cpu, m.mem_used, m.disk_used,
        m.net_rx, m.net_tx, m.uptime, n.day_rx, n.day_tx, r && r.avg != null ? Math.round(r.avg) : '',
        Math.floor((seenAgo(n) ?? -1) / 60)].join(',');   // 离线时长变了也要重画
    }).join('|');
    if (!force && sig === this._plistSig) return;
    this._plistSig = sig;

    const total = nodes.length;
    const on = nodes.filter((n) => n.online).length;
    const avgs = nodes.map(netOf).filter(Boolean).map((r) => r.avg).filter((x) => x != null);
    const avg = avgs.length ? Math.round(avgs.reduce((s, x) => s + x, 0) / avgs.length) : null;
    this.plistSum.textContent = `共 ${total} 台 · 在线 ${on}` + (avg == null ? '' : ` · 平均延迟 ${avg} ms`);

    const keep = this.plistBody.scrollTop;      // 重建 innerHTML 会把滚动位置打回顶部，先存着
    this.plistBody.innerHTML = nodes.length
      ? nodes.map((n) => probeCard(n, netOf(n))).join('')
      : '<p class="note">监控后端里还没有节点（Monitor hub / Komari）</p>';
    this.plistBody.scrollTop = keep;
  }

  showError(msg) { this.errbar.textContent = msg; this.errbar.classList.remove('hidden'); }
  hideError() { this.errbar.classList.add('hidden'); }

  // ---------- 自身（左下卡片：名字 / 血量 / 啄倒数）----------
  setMe(name) { if (this.meName) this.meName.textContent = name; }
  setSelfState(hp, koLeft, score = 0) {
    if (this.hpfill) {
      this.hpfill.style.width = `${Math.max(0, Math.min(100, hp))}%`;
      this.hpfill.classList.toggle('low', hp <= 30);
    }
    if (this.scoreEl) {
      // 被啄晕时这一行让位给复活倒计时（参考站同款文案）
      this.scoreEl.textContent = koLeft > 0
        ? `😵 被啄晕了，${Math.ceil(koLeft)} 秒后满血复活…`
        : `🏆 啄倒 ${score | 0} 只鸡`;
    }
    // 只在「刚被啄晕」那一次提示：这函数每帧都调，无条件 banner 会让 2s 定时器被无限重置
    if (koLeft > 0 && !(this._koPrev > 0)) this.banner('😵 你被啄晕了！', 2000);
    this._koPrev = koLeft;   // 中央横幅
  }
  bindPlayer(chicken) { this._playerChicken = chicken; }

  // ---------- 啄倒榜（右上，默认收起）----------
  // rows: [{id, name, score, me?}]，由 main.js 从快照算好（服务端不下发名字）。
  // 快照 20Hz 都会调进来：先比签名、再按 500ms 节流，收起时只更新标题。
  updateBoard(rows, force = false) {
    this.rows = Array.isArray(rows) ? rows : [];
    // force=true：一次性调用（断线重置、初始化）用 —— 这种调用之后**不会**再有快照来触发重绘，
    // 被 500ms 节流吞掉就永远停着旧内容（2026-09-27 复查：断线后榜上一直挂着别人的分数）
    this.renderBoard(!!force);
  }
  // 离场玩家的记录（roster.left）：只存着给 boardRows 拼行用
  setLeftBoard(list) { this.leftBoard = Array.isArray(list) ? list : []; }
  renderBoard(force = false) {
    if (!this.boardEl) return;
    const now = performance.now();
    const top = this.rows.slice(0, 20);        // 只展示前 20（参考站一样）
    const sig = `${this.collapsed}|` + top.map((r) => `${r.id}:${r.score}:${r.name}:${r.off ? 1 : 0}${r.me ? 1 : 0}`).join(',');
    if (!force) {
      if (sig === this._boardSig) return;
      if (now - this._boardAt < 500) return;
    }
    this._boardSig = sig;
    this._boardAt = now;
    this.boardTitle.textContent = this.collapsed ? '🐔 啄倒榜' : '🐔 啄倒榜（点击收起）';
    this.boardEl.classList.toggle('collapsed', this.collapsed);
    if (this.collapsed) return;
    // 名字来自节点名/访客名，必须转义（innerHTML 拼串）
    this.boardRows.innerHTML = top.map((r) =>
      `<div class="row${r.me ? ' me' : ''}${r.off ? ' off' : ''}"><span>${escapeHtml(String(r.name))}</span><b>${r.score | 0}</b></div>`
    ).join('');
  }


  // 顶栏「访客」格：显示 1+N（原站就是「访客 N 鸡」，没有模式字样）
  setPresence(online, remoteCount) {
    const sig = `${online}:${remoteCount}`;
    if (sig === this._presenceSig) return;
    this._presenceSig = sig;
    const el = $('visitors');
    if (!el) return;
    el.innerHTML = `👤 访客 <b>${1 + (online ? remoteCount : 0)}</b> 鸡`;
    el.title = online ? `场上共 ${1 + remoteCount} 只鸡` : '还没连上游戏服（连上后才会出现别的鸡）';
  }
  feed(text) {
    const el = document.createElement('div');
    el.className = 'feed-item';
    el.textContent = text;
    this.feedEl.appendChild(el);
    while (this.feedEl.children.length > 5) this.feedEl.firstChild.remove();
    setTimeout(() => el.remove(), 5000);
  }
  banner(text, ms = 1600) {
    this.bannerEl.textContent = text;
    this.bannerEl.classList.add('show');
    clearTimeout(this._bt);
    this._bt = setTimeout(() => this.bannerEl.classList.remove('show'), ms);
  }

  // ---------- 网络榜（用 ping 曲线给节点网络质量排名，最差的飘红）----------

  // 网络最差易主 → 播报（farm.worstChange 每次只消费一次）
  consumeWorstChange() {
    const wc = this.farm.worstChange;
    if (!wc || wc.at === this._worstSeen) return;
    this._worstSeen = wc.at;
    const r = wc.row;
    this.feed(`⚠️ ${r.name} 网络最差：平均 ${r.avg == null ? '—' : `${Math.round(r.avg)}ms`}${r.loss >= 0.5 ? ` · 丢包 ${r.loss.toFixed(1)}%` : ''}`);
    if (r.score > 250) this.banner(`📶 ${r.name} 网络劣化`, 2400);
  }

  // ---------- 详情（就在探针列表悬浮层里显示；右侧抽屉已删）----------
  /** 打开面板并切到详情视图。target: {kind:'probe',nodeId} / {kind:'web',taskId} / {kind:'goose'|'dog'} */
  async showDetail(target) {
    if (!this.plist) return;
    this._rangeIdx = null;        // 每次打开都回到默认档位（24 小时），别沿用上一条的
    if (!this.probesOpen) this.showProbes();          // 从场地上点鸡进来：先把面板打开（顺带解锁指针）
    if (!this.probesOpen) return;
    this.view = 'detail';
    this.plist.classList.add('is-detail');
    this.plistBody.classList.add('hidden');
    this.plistNote.classList.add('hidden');
    this.plistDetail.classList.remove('hidden');
    this.plistBack.classList.remove('hidden');
    this.plistSum.textContent = '';
    this.plistTitle.textContent = '…';
    this.plistDetail.innerHTML = '<p class="note">正在读探针数据…</p>';
    this._nodeTab = 'res';             // 每次打开详情都落在「资源」页签
    const token = ++this._detailToken;
    try {
      if (target.kind === 'probe') await this.renderNodeDetail(target, token);
      else if (target.kind === 'web') await this.renderTaskDetail(target, token);
      else if (target.kind === 'goose') this.renderGooseDetail(target);
      else if (target.kind === 'dog') this.renderDogDetail(target);
    } catch (e) {
      if (token === this._detailToken) {
        this.plistTitle.textContent = '读取失败';
        this.plistDetail.innerHTML = `<p class="note">读取失败：${escapeHtml(String(e.message || e))}</p>`;
      }
    }
  }


  // 节点详情：照搬 kanso 的详情页 —— 九格信息格 + 「资源 / 网络延迟」两个页签。
  //   信息格：系统 / 架构 / 负载 / CPU / 内存·交换分区 / 硬盘 / TCP·UDP 连接 / 今日流量 / 在线时间
  //   资源页：网络速率 / TCP·UDP 连接 / 进程 / CPU / 内存 / 硬盘 六张图（两列三排）
  //   延迟页：各探测点延迟一张多线图 + 图例
  // 主机名/IP/探测目标一律不出现（隐私口径）；到期、月流量这类「后台才关心的」也不放了。
  async renderNodeDetail({ nodeId }, token) {
    const n = this.farm.nodeById(nodeId);
    if (!n) throw new Error('节点不在当前列表里');
    this.plistTitle.textContent = `🐔 ${n.name}`;
    const m = n.metrics || {};
    const memTotal = Number(m.mem_total || n.mem_total) || 0;
    const diskTotal = Number(m.disk_total || n.disk_total) || 0;
    const swapTotal = (m.swap_total ?? (typeof n.swap_total === 'number' ? n.swap_total : null));

    // kanso 的九格（顺序也一致）：身份 → 容量 → 动态。值为空的那格整格隐身。
    const facts = [
      ['系统', [shortOs(n.os), n.kernel].filter(Boolean).join(' · ')],
      ['架构', [n.arch, n.virt && n.virt !== 'none' ? n.virt : '', (m.procs > 0 ? `${m.procs} 进程` : '')].filter(Boolean).join(' · ')],
      ['负载', Array.isArray(m.load) && m.load.length ? Number(m.load[0]).toFixed(2) : null,
        Array.isArray(m.load) && m.load.length ? `1 / 5 / 15 分钟：${m.load.map((v) => Number(v).toFixed(2)).join(' ')}` : ''],
      ['CPU', cpuLine(n)],
      // 没配 swap 的机器只写「内存」（旧口径：swap 为 0 时整格不出现「交换」字样）
      [swapTotal > 0 ? '内存 / 交换分区' : '内存',
        memTotal > 0 ? (swapTotal > 0 ? `${fmtBytes(memTotal)} / ${fmtBytes(swapTotal)}` : fmtBytes(memTotal)) : null],
      ['硬盘', diskTotal > 0 ? fmtBytes(diskTotal) : null],
      ['TCP / UDP 连接', (m.tcp != null && m.udp != null) ? `${m.tcp} / ${m.udp}` : null],
      // Komari 没有「今日流量」字段（day_rx/day_tx 为 null）：整格隐身，不印两个「—」。
      ['今日流量', (n.day_rx != null || n.day_tx != null) ? `↓ ${fmtBytes(n.day_rx)} · ↑ ${fmtBytes(n.day_tx)}` : null],
      ['在线时间', onlineFor(n)],
    ];

    const ranges = this.farm.ranges();
    const idx = this._pickRange(ranges);
    this._nodeTab = this._nodeTab || 'res';
    this.plistDetail.innerHTML = `
      <dl class="pgrid">${facts.filter(([, v]) => v != null && v !== '')
        .map(([k, v, title]) => `<div class="cell"><dt>${escapeHtml(k)}</dt><dd title="${escapeHtml(String(title || v))}">${escapeHtml(String(v))}</dd></div>`).join('')}</dl>
      <div class="tabs" id="dtabs">
        <button type="button" class="tab${this._nodeTab === 'res' ? ' on' : ''}" data-tab="res" aria-pressed="${this._nodeTab === 'res'}">资源</button>
        <button type="button" class="tab${this._nodeTab === 'lat' ? ' on' : ''}" data-tab="lat" aria-pressed="${this._nodeTab === 'lat'}">网络延迟</button>
      </div>
      ${rangeBar(ranges, idx)}
      <div id="dcharts"></div>`;

    $('dtabs').addEventListener('click', (e) => {
      const b = e.target.closest?.('.tab');
      if (!b || b.dataset.tab === this._nodeTab) return;
      this._nodeTab = b.dataset.tab;
      for (const el of $('dtabs').children) {
        el.classList.toggle('on', el === b);
        el.setAttribute('aria-pressed', String(el === b));
      }
      this._drawNode(n, ranges[this._pickRange(ranges)], token, false);
    });

    await this._drawNode(n, ranges[idx], token, true);
    // 切时间范围：只重画图，信息格不重拉
    if (token !== this._detailToken) return;      // 请求回来时用户已经切到别的详情了
    this._bindRanges(ranges, (r) => this._drawNode(n, r, token, false));
  }

  async _drawNode(n, range, token, force) {
    const d = await this.farm.nodeDetail(n.id, { hours: range.hours, points: range.points, force });
    if (token !== this._detailToken) return;
    const rows = d.metrics || [];
    const ping = d.ping || [];
    const probes = { ...this.farm.probes, ...(d.probes || {}) };
    const long = spanSec(rows, ping) > 12 * 3600;   // 半日以上的窗口两端只写时分就分不清了（24h 窗口两端是同一个点钟）
    const box = $('dcharts');
    if (!box) return;
    if (this._nodeTab === 'lat') this._drawLatency(box, ping, probes, range, long);
    else this._drawResources(box, rows, n, long);
  }

  // 资源页：六张图，两列三排（kanso 的次序：网络速率 → TCP/UDP → 进程 → CPU → 内存 → 硬盘）
  _drawResources(box, rows, n, long) {
    const m = n.metrics || {};
    const memTotal = Number(m.mem_total || n.mem_total) || 0;
    const diskTotal = Number(m.disk_total || n.disk_total) || 0;
    const peak = (pick) => rows.reduce((hi, x) => Math.max(hi, Number(pick(x)) || 0), 0);
    // 轴顶：CPU 至少 4%、最多 100%；速率按 1 KiB 取整；计数类（连接 / 进程）补到 4 的倍数
    const nice = (v, step, cap = Infinity) => Math.min(cap, Math.max(step, Math.ceil(v * 1.15 / step) * step));
    const round4 = (v) => { const t = Math.max(4, Math.ceil(v * 1.15)); return t + ((4 - (t % 4)) % 4); };
    const cpuTop = nice(peak((x) => x.cpu), 10, 100);
    const netTop = nice(peak((x) => Math.max(x.net_rx || 0, x.net_tx || 0)), 1024);
    const connTop = round4(peak((x) => Math.max(x.tcp || 0, x.udp || 0)));
    const procTop = round4(peak((x) => x.procs || 0));
    // 两条线的图在标题右侧给一行小图例（否则看不出哪根是下行 / TCP）
    // ⚠ 每项是 [名字, 颜色, 取值函数] —— 解构别写错位，否则会把函数印到图例上
    const lg = (items) => items.length < 2 ? ''
      : `<span class="cl">${items.map(([name2, color]) => `<i style="background:${color}"></i>${escapeHtml(name2)}`).join('')}</span>`;
    // 浮框里怎么打印这个值（kanso 的 tooltip 口径）
    const fRate = (v) => (v == null || !isFinite(v) ? '—' : fmtRate(v));
    const fNum = (v) => (v == null || !isFinite(v) ? '—' : String(v));
    const fPct = (v) => (v == null || !isFinite(v) ? '—' : `${Number(v).toFixed(1)}%`);
    const fBytes = (v) => (v == null || !isFinite(v) ? '—' : fmtBytes(v));
    const panels = [
      ['网络速率', [['下行', '#3fbf5f', (x) => x.net_rx], ['上行', '#63b6ff', (x) => x.net_tx]], netTop, '', fRate],
      ['TCP / UDP 连接', [['TCP', '#63b6ff', (x) => x.tcp], ['UDP', '#f06292', (x) => x.udp]], connTop, '', fNum],
      [m.procs != null ? `进程 · ${m.procs}` : '进程', [['进程', '#c792ea', (x) => x.procs]], procTop, '', fNum],
      ['CPU', [['CPU', '#63b6ff', (x) => x.cpu]], cpuTop, '%', fPct],
      [memTotal > 0 ? `内存 · ${fmtBytes(memTotal)}` : '内存', [['内存', '#ffd166', (x) => x.mem_used]], memTotal || null, '', fBytes],
      [diskTotal > 0 ? `硬盘 · ${fmtBytes(diskTotal)}` : '硬盘', [['硬盘', '#7ddc6a', (x) => x.disk_used]], diskTotal || null, '', fBytes],
    ];
    box.innerHTML = `<div class="chart-grid">${panels.map(([title, ss], i) =>
      `<section class="cpanel"><h5><span>${escapeHtml(title)}</span>${lg(ss)}</h5><canvas id="ch${i}" width="760" height="170"></canvas></section>`).join('')}</div>`;
    panels.forEach(([, ss, top, unit, fmtv], i) => {
      drawLine($(`ch${i}`), ss.map(([name, color, pick]) => ({ name, color, pts: rows.map((x) => [x.ts, pick(x)]) })),
        { unit, max: top || null, long, hover: true, format: fmtv });
    });
  }

  // 网络延迟页：各探测点一张多线图 + 图例（kanso 的「网络延迟」页签）
  _drawLatency(box, ping, probes, range, long) {
    const tasks = [...new Set(ping.map((p) => p.task_id))].sort((a, b) => a - b);
    box.innerHTML = `<section class="cpanel"><h5>网络延迟（${escapeHtml(range.label)}，共 ${tasks.length} 条）</h5>
        <canvas id="ch-lat" width="760" height="300"></canvas></section>
      <div class="chips" id="legend">${tasks.map((tid, i) =>
        `<span class="chip"><b style="color:${PALETTE[i % PALETTE.length]}">■</b> ${escapeHtml(probes[tid] || '#' + tid)}</span>`).join('')}</div>`;
    drawLine($('ch-lat'), tasks.map((tid, i) => ({
      name: probes[tid] || `#${tid}`,
      color: PALETTE[i % PALETTE.length],
      pts: ping.filter((p) => p.task_id === tid).map((p) => [p.ts, p.latency]),
    })), { unit: 'ms', long, hover: true, format: (v) => (v == null || !isFinite(v) ? '无响应' : `${Math.round(v)} ms`) });
  }

  // 时间范围那一排按钮：默认落在「24 小时」，档位由 farm.ranges() 按 hub 的保留天数给
  _pickRange(ranges) {
    if (this._rangeIdx != null && this._rangeIdx >= 0 && this._rangeIdx < ranges.length) return this._rangeIdx;
    const i = ranges.findIndex((r) => r.hours === 24);
    return i >= 0 ? i : ranges.length - 1;
  }
  _bindRanges(ranges, onPick) {
    const bar = $('ranges');
    if (!bar) return;
    bar.addEventListener('click', (e) => {
      const b = e.target.closest('.rng');
      if (!b) return;
      const i = Number(b.dataset.i);
      if (!(i >= 0 && i < ranges.length)) return;
      this._rangeIdx = i;
      for (const el of bar.children) el.classList.toggle('on', el === b);
      const p = onPick(ranges[i]);
      if (p && p.catch) p.catch((err) => console.error(err));
    });
  }

  // NPC·大白鹅：它不是探针，没有历史曲线可拉 —— 只把"它是谁、怎么打、现在什么状态"说清楚。
  // 数值来自 js/goose.js 的 GOOSE（与 server/farm_server.py 的 GOOSE_* 一一对应，ci 会核对）。
  renderGooseDetail({ hp = GOOSE.maxHp, maxHp = GOOSE.maxHp } = {}) {
    this.plistTitle.textContent = `🦢 ${GOOSE.name}`;
    const live = Number(hp) > 0;
    const facts = [
      ['是什么', '场上的巡场大白鹅（源站里也有的那种 NPC）'],
      ['状态', live ? `站着 · ${Math.round(hp)} / ${maxHp} 血` : '被啄倒了 · 3.5 秒后满血复活'],
      ['领地', `走进 ${GOOSE.chaseR} m 就追你，追到 ${GOOSE.peckR} m 就啄；追出 ${GOOSE.leash} m 放弃`],
      ['伤害', `一口 ${GOOSE.dmg} 点（冷却 ${GOOSE.cd} 秒），还会把你顶开一步`],
      ['打法', `${maxHp} 血：五口啄击放倒它，榜上「${GOOSE.name}」那一行 +1（场上几只大鹅合起来算一行）`],
      ['反应', '挨啄不逃跑：你打它，它就回头盯着你、够得着就啄回来；只有被看门狗咬才会被赶跑'],
    ];
    this.plistDetail.innerHTML = `
      <h4>大白鹅</h4>
      <dl class="facts">${facts.map(([k, v]) => `<dt>${k}</dt><dd>${escapeHtml(String(v))}</dd>`).join('')}</dl>
      <p class="note">它是服务端自己放养的 NPC，不由探针数据生成，也不带主机名/IP 一类的信息。</p>`;
  }

  // NPC·看门狗（2026-11-01 加）：守在鸡舍门口，只咬暴躁鸡与大白鹅
  renderDogDetail() {
    this.plistTitle.textContent = DOG.name;
    const facts = [
      ['是什么', '守院狗：鸡舍门口那只（服务端自己放养的 NPC）'],
      ['会咬', `只在鸡舍门口 ${DOG.sense} m 内转悠，发现「暴躁鸡」或「大白鹅」就追上去咬 ${DOG.dmg} 点/口（冷却 ${DOG.cd} 秒）`],
      ['不咬', '玩家、普通探针鸡、网站鸡 —— 它只认这两类目标'],
      ['打法', '打不倒：你啄它不掉血，它也不进啄倒榜'],
      ['跑动', `溜达不快，追起来有 ${DOG.run} m/s（比暴躁鸡快）`],
    ];
    this.plistDetail.innerHTML = `
      <h4>看门狗</h4>
      <dl class="facts">${facts.map(([k, v]) => `<dt>${k}</dt><dd>${escapeHtml(String(v))}</dd>`).join('')}</dl>
      <p class="note">它的位置与状态都由服务端算，和探针数据无关。</p>`;
  }

  async renderTaskDetail({ taskId }, token) {
    const t = this.farm.tasks.get(taskId);
    if (!t) throw new Error('探测任务不在列表里');
    this.plistTitle.textContent = `🌐 ${t.name}`;

    const per = t.per || [];
    const cfg = PROBES[String(taskId)] || {};
    const facts = [
      // 隐私：探测目标域名不展示（config.js 里也已移除），这里只给统计
      ['探测点', '已隐藏（隐私约定）'],
      ['探测间隔', cfg.interval ? `${cfg.interval} 秒` : '—'],
      ['在测节点', `${t.n || 0} / ${this.farm.nodes.length}`],
      ['平均延迟', t.avg == null ? '—' : `${Math.round(t.avg)} ms`],
      ['最快', t.best ? `${t.best.node.name} ${t.best.latency} ms` : '—'],
      ['最慢', t.worst ? `${t.worst.node.name} ${t.worst.latency} ms` : '—'],
      ['丢包率', t.loss == null ? '—' : `${t.loss.toFixed(2)}%`],
    ];

    const ranges = this.farm.ranges();
    const idx = this._pickRange(ranges);
    this.plistDetail.innerHTML = `
      <h4>探测信息</h4>
      <dl class="facts">${facts.map(([k, v]) => `<dt>${k}</dt><dd>${escapeHtml(String(v))}</dd>`).join('')}</dl>
      ${rangeBar(ranges, idx)}
      <h4 id="h-t1">各节点延迟</h4>
      <section class="cpanel"><canvas id="c1" width="760" height="260"></canvas></section>
      <div class="chips" id="legend"></div>
      <h4>当前各节点延迟</h4>
      <div class="bars">${per.slice().reverse().map((p) => `
        <div class="bar"><span>${escapeHtml(p.node.name)}</span>
          <div class="track"><div class="fill" style="width:${Math.min(100, p.latency / 3)}%;background:${latColor(p.latency)}"></div></div>
          <span class="v">${p.latency}ms</span></div>`).join('') || '<p class="note">暂时没有数据</p>'}
      </div>`;

    await this._drawTask(taskId, ranges[idx], token, true);
    if (token !== this._detailToken) return;
    this._bindRanges(ranges, (r) => this._drawTask(taskId, r, token, false));
  }

  // 网站鸡详情：各节点在这条探测任务上的延迟曲线（时间范围可变）
  async _drawTask(taskId, range, token, force) {
    // hub 的历史查询并发上限实测是 4（data.js 里首屏只用 3 个 worker 就是为这个）：
    // 这里以前 Promise.all 一次并发全部节点，超出的吃 503、被下面的 catch 吞掉，图上静默少线。
    const nodes = this.farm.nodes;
    const results = new Array(nodes.length);
    let next = 0;
    const worker = async () => {
      while (next < nodes.length) {
        const i = next++;
        const n = nodes[i];
        try {
          const d = await this.farm.nodeDetail(n.id, { hours: range.hours, points: range.points, force });
          results[i] = { n, pts: (d.ping || []).filter((p) => p.task_id === taskId).map((p) => [p.ts, p.latency]) };
        } catch { results[i] = null; }
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    if (token !== this._detailToken) return;
    const series = [];
    for (const r of results) if (r && r.pts.length) series.push({ name: r.n.name, color: PALETTE[series.length % PALETTE.length], pts: r.pts });

    h4Text('h-t1', `各节点延迟（${range.label}）`);
    $('legend').innerHTML = series.map((s) => `<span class="chip"><b style="color:${s.color}">■</b> ${escapeHtml(s.name)}</span>`).join('');
    drawLine($('c1'), series, {
      unit: 'ms', long: spanSec(...series.map((s) => s.pts)) > 12 * 3600,
      hover: true, format: (v) => (v == null || !isFinite(v) ? '无响应' : `${Math.round(v)} ms`),
    });
  }
}

// ---------------- canvas 画图 ----------------
function latColor(l) {
  if (l == null) return '#8d8b86';
  if (l < 120) return '#3fbf5f';
  if (l < 220) return '#e8a33d';
  return '#ff5a3c';
}

// 折线图（canvas 手绘）。opts.hover=true 时挂上「竖线 + 数值浮框」（kanso 那种）。
//   format(v) 决定浮框里怎么打印这个值（默认 shortNum + unit）
function drawLine(canvas, series, { unit = '', max = null, dual = false, long = false, hover = false, format = null } = {}) {
  if (!canvas) return;
  const W = canvas.width, H = canvas.height;
  const c = canvas.getContext('2d');
  const padL = 46, padR = 12, padT = 14, padB = 22;
  const iw = W - padL - padR, ih = H - padT - padB;

  const all = series.flatMap((s) => s.pts);
  // `isFinite(null)` 是 true —— 时间/数值都得显式挡 null，否则 Math.min 会算出 NaN、整张图空白
  const clean = all.filter((p) => p[0] != null && p[1] != null && isFinite(p[0]) && isFinite(p[1]));
  const ts0 = clean.length ? Math.min(...clean.map((p) => p[0])) : 0;
  const ts1 = clean.length ? Math.max(...clean.map((p) => p[0])) : 0;
  const vals = clean.map((p) => p[1]);
  const vMax = max != null ? max : (Math.max(...vals) * 1.15 || 1);
  const yScale = (v) => padT + ih * (1 - Math.max(0, Math.min(1, v / vMax)));
  const xScale = (t) => padL + iw * (ts1 === ts0 ? 0.5 : (t - ts0) / (ts1 - ts0));

  // 浮框要按时间戳回查每一行，先建一次索引（点数最多几千，一次就够）
  const rows = new Map();
  if (hover) {
    for (const [i, s] of series.entries()) {
      for (const [t, v] of s.pts) {
        let r = rows.get(t);
        if (!r) { r = {}; rows.set(t, r); }
        r[i] = v;
      }
    }
  }
  const tss = hover ? [...rows.keys()].sort((a, b) => a - b) : [];
  const fmt = format || ((v) => (v == null || !isFinite(v) ? '—' : `${shortNum(v)}${unit}`));
  let cursor = null;

  const paint = () => {
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, W, H);
    c.font = '11px ui-monospace,Consolas,monospace';
    if (!clean.length) {
      c.fillStyle = 'rgba(255,255,255,.55)';
      c.fillText('暂无数据', padL, H / 2);
      return;
    }
    // 网格 + y 轴（六张图并排时轴标签更小，对比度给足一点）
    c.strokeStyle = 'rgba(255,255,255,.12)';
    c.fillStyle = 'rgba(255,255,255,.72)';
    for (let i = 0; i <= 4; i++) {
      const y = padT + ih * i / 4;
      c.beginPath(); c.moveTo(padL, y); c.lineTo(W - padR, y); c.stroke();
      const v = vMax * (1 - i / 4);
      c.fillText(dual ? shortNum(v) : `${shortNum(v)}${unit}`, 6, y + 4);
    }
    const label1 = axisTime(ts0, long), label2 = axisTime(ts1, long);
    c.fillText(label1, padL, H - 6);
    c.fillText(label2, W - padR - c.measureText(label2).width, H - 6);

    for (const s of series) {
      if (!s.pts.length) continue;
      c.strokeStyle = s.color;
      c.lineWidth = dual ? 1.4 : 1.9;
      c.beginPath();
      let started = false;
      for (const [t, v] of s.pts) {
        if (v == null || !isFinite(v)) { started = false; continue; }
        const x = xScale(t), y = yScale(v);
        if (!started) { c.moveTo(x, y); started = true; } else c.lineTo(x, y);
      }
      c.stroke();
    }

    if (cursor != null) {
      // 光标竖线 + 每条线在该时刻的点
      const x = xScale(cursor);
      c.strokeStyle = 'rgba(255,255,255,.30)';
      c.lineWidth = 1;
      c.setLineDash([3, 3]);
      c.beginPath(); c.moveTo(x, padT); c.lineTo(x, padT + ih); c.stroke();
      c.setLineDash([]);
      const row = rows.get(cursor) || {};
      series.forEach((s, i) => {
        const v = row[i];
        if (v == null || !isFinite(v)) return;
        c.fillStyle = s.color;
        c.beginPath(); c.arc(x, yScale(v), 2.6, 0, Math.PI * 2); c.fill();
      });
    }
  };

  // 浮框（DOM，绝对定位在 .cpanel 里）
  let tip = null;
  if (hover) {
    const host = canvas.parentElement;
    if (host) {
      // 同一张 canvas 会被反复重画（切时间档 / 重开详情）：先拆掉上一次挂的监听与浮框，
      // 否则监听器和 .ctip 节点会一次次叠加（浮框叠影子、旧闭包常驻）。
      if (canvas.__ctipCleanup) { try { canvas.__ctipCleanup(); } catch { /* 旧节点早没了也无妨 */ } }
      tip = document.createElement('div');
      tip.className = 'ctip hidden';
      host.appendChild(tip);
      const onMove = (e) => {
        if (!tss.length) return;
        const r = canvas.getBoundingClientRect();
        const px = (e.clientX - r.left) / (r.width || 1) * W;
        // 找离光标最近的时间戳
        let lo = 0, hi = tss.length - 1;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if (xScale(tss[mid]) < px) lo = mid + 1; else hi = mid;
        }
        const cands = [tss[lo], tss[Math.max(0, lo - 1)]];
        const best = cands.sort((a, b) => Math.abs(xScale(a) - px) - Math.abs(xScale(b) - px))[0];
        cursor = best;
        paint();
        const row = rows.get(best) || {};
        tip.innerHTML = `<div class="ct">${fmtTipTime(best)}</div>` + series.map((s, i) =>
          `<div class="cr"><i style="background:${s.color}"></i><span>${escapeHtml(s.name)}</span><b>${escapeHtml(String(fmt(row[i])))}</b></div>`).join('');
        tip.classList.remove('hidden');
        // 水平跟随光标，别越出图表卡片
        const hostW = host.clientWidth || 1;
        const tw = tip.offsetWidth || 0;
        const cx = e.clientX - host.getBoundingClientRect().left;
        tip.style.left = `${Math.max(4, Math.min(hostW - tw - 4, cx - tw / 2))}px`;
        tip.style.top = '6px';
      };
      const onLeave = () => {
        cursor = null;
        paint();
        tip.classList.add('hidden');
      };
      canvas.addEventListener('mousemove', onMove);
      canvas.addEventListener('mouseleave', onLeave);
      canvas.__ctipCleanup = () => {
        canvas.removeEventListener('mousemove', onMove);
        canvas.removeEventListener('mouseleave', onLeave);
        tip.remove();
      };
    }
  }
  paint();
}

// 浮框的时间：2026/11/2 16:52:00（kanso 的写法）
function fmtTipTime(ts) {
  const d = new Date(ts * 1000);
  const p = (v) => String(v).padStart(2, '0');
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// 详情抽屉的时间范围按钮：档位个数随 hub 的保留天数变，所以是生成的而不是写死的
function rangeBar(ranges, idx) {
  return `<div class="ranges" id="ranges">${ranges.map((r, i) =>
    `<button type="button" class="chip rng${i === idx ? ' on' : ''}" data-i="${i}">${escapeHtml(r.label)}</button>`).join('')}</div>`;
}
function h4Text(id, text) { const el = $(id); if (el) el.textContent = text; }
// 一组点里最早/最晚隔了多久（秒）：x 轴标时分还是标日期就看它。
// 接受 {ts} 对象或 [ts, v] 数组两种形状（历史点是对象、曲线点是数组）。
function spanSec(...groups) {
  let lo = Infinity, hi = -Infinity;
  for (const g of groups) for (const x of (g || [])) {
    const t = Array.isArray(x) ? x[0] : (x && x.ts);
    if (t == null || !isFinite(t)) continue;
    if (t < lo) lo = t;
    if (t > hi) hi = t;
  }
  return hi > lo ? hi - lo : 0;
}
function axisTime(ts, long) {
  const d = new Date(ts * 1000);
  const p = (v) => String(v).padStart(2, '0');
  return long ? `${d.getMonth() + 1}/${d.getDate()}` : `${p(d.getHours())}:${p(d.getMinutes())}`;
}

// 网络榜每行的小曲线（近 2 小时的节点平均延迟采样）

function shortNum(v) {
  if (Math.abs(v) >= 1073741824) return (v / 1073741824).toFixed(1) + 'G';
  if (Math.abs(v) >= 1048576) return (v / 1048576).toFixed(1) + 'M';
  if (Math.abs(v) >= 1024) return (v / 1024).toFixed(0) + 'K';
  return v >= 10 ? v.toFixed(0) : v.toFixed(1);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}

// ---------------- 探针列表的节点卡片 ----------------
// 列的是「hub 里加进监控的每一台服务器」，字段全部来自 /api/nodes 的公开视图：
// 名字/国旗/系统/虚拟化/核数 + CPU·内存·磁盘 + 实时网速 + 今日流量 + 延迟 + 在线时长 + 公开备注。
// 主机名/IP/探测目标一律不在这里出现（和详情抽屉同一条隐私口径）。
function probeCard(n, net) {
  const m = n.metrics || {};
  const live = n.online && !!n.metrics;          // 离线 / 还没上报过指标 → 数值栏一律给「—」，别显示成 0%
  const memTotal = Number(n.mem_total || m.mem_total) || 0;
  const diskTotal = Number(n.disk_total || m.disk_total) || 0;
  const memP = memTotal ? Math.min(100, (Number(m.mem_used) || 0) / memTotal * 100) : 0;
  const diskP = diskTotal ? Math.min(100, (Number(m.disk_used) || 0) / diskTotal * 100) : 0;
  const cc = String(n.country || '').toLowerCase();
  // 国旗走本地 vendor/flags/<cc>.png（安装/部署时下好）；没有就用两字母代码兜底
  const flag = /^[a-z]{2}$/.test(cc)
    ? `<img class="fl" src="./vendor/flags/${cc}.png" alt="${escapeHtml(cc.toUpperCase())}" loading="lazy">`
    : `<span class="fl emoji">${escapeHtml((cc || '🌐').toUpperCase())}</span>`;
  const ago = seenAgo(n);
  const state = n.online ? '在线' : (ago == null ? '离线' : `离线 ${fmtAgoSec(ago)}`);
  const sys = [shortOs(n.os), n.virt ? String(n.virt).toUpperCase() : '', n.cpu_cores ? `${n.cpu_cores} 核` : '']
    .filter(Boolean).join(' · ');
  const lat = net && net.avg != null ? `${Math.round(net.avg)} ms` : '—';
  // 离线/无指标时这些数字都是「没有」，别拿 undefined 去格式化（会得到「—/s」「0分」这种怪值）
  const rate = (v) => (live && v != null && isFinite(v) ? fmtRate(v) : '—');
  const bytes = (v) => (live && v != null && isFinite(v) ? fmtBytes(v) : '—');
  const up = live && m.uptime != null && isFinite(m.uptime) ? fmtUptime(m.uptime) : '—';

  const bar = (label, pct) => `<span class="pbar"><span>${label}</span>`
    + `<span class="track"><i class="fill" style="width:${live ? pct.toFixed(0) : 0}%;background:${pctColor(pct)}"></i></span>`
    + `<em>${live ? `${Math.round(pct)}%` : '—'}</em></span>`;

  return `<button class="pcard${n.online ? '' : ' off'}" type="button" data-id="${Number(n.id)}" `
    + `title="点开 ${escapeHtml(String(n.name || ''))} 的详情">`
    + `<span class="phead">${flag}<b class="pname">${escapeHtml(String(n.name || '未命名'))}</b>`
    + `<span class="pon">${escapeHtml(state)}</span></span>`
    + `<span class="psub">${escapeHtml(sys || '—')}</span>`
    + bar('CPU', Math.max(0, Math.min(100, Number(m.cpu) || 0)))
    + bar('内存', memP)
    + bar('磁盘', diskP)
    + `<span class="pfoot"><span>↓ ${rate(m.net_rx)}</span><span>↑ ${rate(m.net_tx)}</span></span>`
    + `<span class="pfoot"><span>今日 ↓${bytes(n.day_rx)} ↑${bytes(n.day_tx)}</span><span class="hi">${escapeHtml(lat)}</span></span>`
    + `<span class="pfoot"><span>在线 ${up}</span></span>`
    + (n.public_remark ? `<span class="pre" title="${escapeHtml(String(n.public_remark))}">${escapeHtml(String(n.public_remark))}</span>` : '')
    + '</button>';
}

function pctColor(p) {
  if (p >= 85) return '#ff5a3c';
  if (p >= 60) return '#e8a33d';
  return '#7ec850';
}

// 'Debian GNU/Linux 12 (bookworm)' → 'Debian 12'（卡面一行放得下就行，别把代号也塞进去）
function shortOs(s) {
  if (!s) return '—';
  return String(s)
    .replace(/\s*\([^)]*\)\s*/g, ' ')
    .replace(/GNU\/Linux/gi, '')
    .replace(/\s+/g, ' ')
    .trim() || '—';
}

// CPU 那格：型号 × 核数（缺一个就只写有的那截，两个都缺就整格隐身）
function cpuLine(n) {
  const cores = Number(n.cpu_cores) || 0;
  const name = shortCpu(n.cpu_name || '');
  if (name && cores > 0) return `${name} × ${cores}`;
  return name || (cores > 0 ? `${cores} 核` : '');
}

// 在线时间（kanso 的口径）：在线给运行时长；离线写清楚离线多久；从没上报过 = 未接入
function onlineFor(n) {
  const m = n.metrics;
  if (n.online) return (m && m.uptime != null && isFinite(m.uptime)) ? fmtUptime(m.uptime) : '—';
  const ago = seenAgo(n);
  if (ago == null) return '未接入';
  return ago >= 60 ? `离线 ${fmtUptime(ago)}` : '离线';
}
