// HUD：顶栏、啄倒榜、播报、自身状态、详情抽屉（纯 canvas 画图，不引图表库）
import { fmtBytes, fmtRate, fmtPct, fmtUptime, fmtAgo, shortCpu, CONF } from './data.js';
import { PROBES } from './config.js';
import { GOOSE } from './goose.js';

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
    this.detail = $('detail'); this.dTitle = $('d-title'); this.dBody = $('d-body');
    this.errbar = $('errbar');
    this.collapsed = true;            // 啄倒榜默认收起（点标题展开）
    this.rows = [];                   // 榜单行（main.js 每次快照喂进来）
    this.leftBoard = [];              // 离场玩家的啄倒记录（服务端 roster.left 下发）
    this._boardSig = '';              // 差量签名：内容没变就不碰 DOM
    this._boardAt = 0;                // 上次写 DOM 的时间（节流上限）
    this.myId = 'me';
    this.onSelect = null;
    $('d-close').addEventListener('click', () => this.hideDetail());
    this.feedEl = $('feed');
    this._detailToken = 0;
    this._worstSeen = 0;
  }

  // ---------- 顶栏 ----------
  updateCounters() {
    const f = this.farm;
    const webTasks = [...f.tasks.values()];
    const webOk = webTasks.filter((t) => t.n > 0).length;
    this.online.textContent = f.onlineCount;
    this.onlineTotal.textContent = f.nodes.length;
    this.webOnline.textContent = webOk;
    this.webTotal.textContent = webTasks.length;
    this.hot.textContent = f.hotCount;
    if (f.error) this.showError(`探针数据读取失败：${f.error}`);
    else this.hideError();
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
    if (koLeft > 0) this.banner('😵 你被啄晕了！', 2000);   // 中央横幅
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
    const sig = `${this.collapsed}|` + top.map((r) => `${r.id}:${r.score}:${r.name}`).join(',');
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
    this.feed(`⚠️ ${r.name} 网络最差：平均 ${Math.round(r.avg)}ms${r.loss >= 0.5 ? ` · 丢包 ${r.loss.toFixed(1)}%` : ''}`);
    if (r.score > 250) this.banner(`📶 ${r.name} 网络劣化`, 2400);
  }

  // ---------- 详情抽屉 ----------
  hideDetail() { this.detail.classList.add('hidden'); }
  async showDetail(target) {
    const token = ++this._detailToken;
    this.detail.classList.remove('hidden');
    this.dBody.innerHTML = '<p class="note">正在读探针数据…</p>';
    try {
      if (target.kind === 'probe') await this.renderNodeDetail(target, token);
      else if (target.kind === 'web') await this.renderTaskDetail(target, token);
      else if (target.kind === 'goose') this.renderGooseDetail(target);
    } catch (e) {
      if (token === this._detailToken) this.dBody.innerHTML = `<p class="note">读取失败：${escapeHtml(String(e.message || e))}</p>`;
    }
  }


  async renderNodeDetail({ nodeId }, token) {
    const n = this.farm.nodeById(nodeId);
    if (!n) throw new Error('节点不在当前列表里');
    this.dTitle.textContent = `🐔 ${n.name}`;
    const m = n.metrics || {};
    const limits = { mem: n.mem_total || m.mem_total, disk: n.disk_total || m.disk_total };
    const net = this.farm.netRowById(nodeId);

    // 只列与运行状态有关的项：主机名/IP 一律不展示（隐私）
    const facts = [
      ['状态', n.online ? `在线 · ${fmtAgo(n.last_seen)}看到过` : '离线'],
      ['位置', `${n.country || '—'} · ${n.virt || '—'}`],
      ['网络', net ? `第 ${net.rank}/${this.farm.netRank.length} 差 · 平均 ${Math.round(net.avg)}ms${net.loss >= 0.5 ? ` · 丢包 ${net.loss.toFixed(1)}%` : ''}` : '—'],
      ['系统', `${n.os || '—'}`],
      ['内核', `${n.kernel || '—'} · ${n.arch || '—'}`],
      ['CPU', `${shortCpu(n.cpu_name)} ×${n.cpu_cores || 1}`],
      ['负载', (m.load || []).map((v) => v.toFixed(2)).join(' / ') || '—'],
      ['内存', `${fmtBytes(m.mem_used)} / ${fmtBytes(m.mem_total || limits.mem)}`],
      ['磁盘', `${fmtBytes(m.disk_used)} / ${fmtBytes(m.disk_total || limits.disk)}`],
      ['月流量', `↓${fmtBytes(n.month_rx)} ↑${fmtBytes(n.month_tx)}`],
      ['到期', n.expires_at || '—'],
    ];
    // hub 1.3.2 起节点的公开视图多了一行 public_remark（站长写给访客的说明，可为空），有才显示
    if (n.public_remark) facts.push(['备注', n.public_remark]);

    const ranges = this.farm.ranges();
    const idx = this._pickRange(ranges);

    this.dBody.innerHTML = `
      <h4>节点信息</h4>
      <dl class="facts">${facts.map(([k, v]) => `<dt>${k}</dt><dd>${escapeHtml(String(v))}</dd>`).join('')}</dl>
      ${rangeBar(ranges, idx)}
      <h4 id="h-c1">CPU / 内存</h4>
      <canvas id="c1" width="760" height="200"></canvas>
      <h4 id="h-c2">网络 ↓ / ↑</h4>
      <canvas id="c2" width="760" height="200"></canvas>
      <h4 id="h-c4">磁盘使用率</h4>
      <canvas id="c4" width="760" height="160"></canvas>
      <h4 id="h-c3">各探测点延迟</h4>
      <canvas id="c3" width="760" height="260"></canvas>
      <div class="chips" id="legend"></div>
      <h4>当前各探测点</h4>
      <div class="bars" id="cur"></div>`;

    await this._drawNode(n, limits, ranges[idx], token, true);
    // 切时间范围：只重画图与标题，节点信息那几行不重拉
    this._bindRanges(ranges, (r) => this._drawNode(n, limits, r, token, false));
  }

  // 节点详情的四张图 + 图例 + 当前值（时间范围可变，画法与文案都在这里）
  async _drawNode(n, limits, range, token, force) {
    const d = await this.farm.nodeDetail(n.id, { hours: range.hours, points: range.points, force });
    if (token !== this._detailToken) return;
    const metrics = d.metrics || [];
    const ping = d.ping || [];
    const probes = { ...this.farm.probes, ...(d.probes || {}) };
    const long = spanSec(metrics, ping) > 86400;      // 跨天就把 x 轴标成日期，别只写时分

    h4Text('h-c1', `CPU / 内存（${range.label}）`);
    h4Text('h-c2', `网络 ↓ / ↑（${range.label}）`);
    h4Text('h-c4', `磁盘使用率（${range.label}）`);
    h4Text('h-c3', `各探测点延迟（${range.label}，共 ${Object.keys(probes).length} 条）`);

    // 峰值线（cpu_max / net_rx_max / net_tx_max）刻意不画：实测同一窗口里峰值/均值常差几十上百倍
    // （线上 7 台 24h 实测 CPU 最高 134×、网速最高 338×），同轴画上去会把均值线压成贴底的一条。
    drawLine($('c1'), [
      { name: 'CPU', color: '#7ddc6a', pts: metrics.map((x) => [x.ts, x.cpu]) },
      { name: '内存', color: '#63b6ff', pts: metrics.map((x) => [x.ts, x.mem_used / (limits.mem || 1) * 100]) },
    ], { unit: '%', max: 100, long });

    drawLine($('c2'), [
      { name: '下载', color: '#4dd0e1', pts: metrics.map((x) => [x.ts, x.net_rx]) },
      { name: '上传', color: '#ff8f6b', pts: metrics.map((x) => [x.ts, x.net_tx]) },
    ], { unit: '/s', long });

    drawLine($('c4'), [
      { name: '磁盘', color: '#ffd166', pts: metrics.map((x) => [x.ts, x.disk_used / (limits.disk || 1) * 100]) },
    ], { unit: '%', max: 100, long });

    const tasks = [...new Set(ping.map((p) => p.task_id))].sort((a, b) => a - b);
    drawLine($('c3'), tasks.map((tid, i) => ({
      name: probes[tid] || `#${tid}`,
      color: PALETTE[i % PALETTE.length],
      pts: ping.filter((p) => p.task_id === tid).map((p) => [p.ts, p.latency]),
    })), { unit: 'ms', long });

    $('legend').innerHTML = tasks.map((tid, i) =>
      `<span class="chip" style="box-shadow:inset 0 0 0 2px ${PALETTE[i % PALETTE.length]}44">
         <b style="color:${PALETTE[i % PALETTE.length]}">■</b> ${escapeHtml(probes[tid] || '#' + tid)}</span>`).join('');

    const cur = tasks.map((tid) => {
      const arr = ping.filter((p) => p.task_id === tid);
      const last = arr[arr.length - 1];
      return { tid, name: probes[tid] || `#${tid}`, lat: last?.latency ?? null, loss: (d.loss || {})[String(tid)] ?? null };
    }).sort((a, b) => (a.lat ?? 1e9) - (b.lat ?? 1e9));
    $('cur').innerHTML = cur.map((r) => `
      <div class="bar"><span>${escapeHtml(r.name)}</span>
        <div class="track"><div class="fill" style="width:${Math.min(100, (r.lat || 0) / 3)}%;background:${latColor(r.lat)}"></div></div>
        <span class="v">${r.lat == null ? '丢包' : r.lat + 'ms'}</span></div>`).join('');
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
    this.dTitle.textContent = `🦢 ${GOOSE.name}`;
    const live = Number(hp) > 0;
    const facts = [
      ['是什么', '场上的巡场大白鹅（源站里也有的那种 NPC）'],
      ['状态', live ? `站着 · ${Math.round(hp)} / ${maxHp} 血` : '被啄倒了 · 3.5 秒后满血复活'],
      ['领地', `走进 ${GOOSE.chaseR} m 就追你，追到 ${GOOSE.peckR} m 就啄；追出 ${GOOSE.leash} m 放弃`],
      ['伤害', `一口 ${GOOSE.dmg} 点（冷却 ${GOOSE.cd} 秒），还会把你顶开一步`],
      ['打法', `${maxHp} 血：五口啄击放倒它，榜上「${GOOSE.name}」那一行 +1（场上几只大鹅合起来算一行）`],
      ['反应', `被啄就掉头跑 ${GOOSE.fleeT} 秒，不还击（跑完再回来巡场）`],
    ];
    this.dBody.innerHTML = `
      <h4>大白鹅</h4>
      <dl class="facts">${facts.map(([k, v]) => `<dt>${k}</dt><dd>${escapeHtml(String(v))}</dd>`).join('')}</dl>
      <p class="note">它是服务端自己放养的 NPC，不由探针数据生成，也不带主机名/IP 一类的信息。</p>`;
  }

  async renderTaskDetail({ taskId }, token) {
    const t = this.farm.tasks.get(taskId);
    if (!t) throw new Error('探测任务不在列表里');
    this.dTitle.textContent = `🌐 ${t.name}`;

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
    this.dBody.innerHTML = `
      <h4>探测信息</h4>
      <dl class="facts">${facts.map(([k, v]) => `<dt>${k}</dt><dd>${escapeHtml(String(v))}</dd>`).join('')}</dl>
      ${rangeBar(ranges, idx)}
      <h4 id="h-t1">各节点延迟</h4>
      <canvas id="c1" width="760" height="260"></canvas>
      <div class="chips" id="legend"></div>
      <h4>当前各节点延迟</h4>
      <div class="bars">${per.slice().reverse().map((p) => `
        <div class="bar"><span>${escapeHtml(p.node.name)}</span>
          <div class="track"><div class="fill" style="width:${Math.min(100, p.latency / 3)}%;background:${latColor(p.latency)}"></div></div>
          <span class="v">${p.latency}ms</span></div>`).join('') || '<p class="note">暂时没有数据</p>'}
      </div>`;

    await this._drawTask(taskId, ranges[idx], token, true);
    this._bindRanges(ranges, (r) => this._drawTask(taskId, r, token, false));
  }

  // 网站鸡详情：各节点在这条探测任务上的延迟曲线（时间范围可变）
  async _drawTask(taskId, range, token, force) {
    const results = await Promise.all(this.farm.nodes.map(async (n) => {
      try {
        const d = await this.farm.nodeDetail(n.id, { hours: range.hours, points: range.points, force });
        return { n, pts: (d.ping || []).filter((p) => p.task_id === taskId).map((p) => [p.ts, p.latency]) };
      } catch { return null; }
    }));
    if (token !== this._detailToken) return;
    const series = [];
    for (const r of results) if (r && r.pts.length) series.push({ name: r.n.name, color: PALETTE[series.length % PALETTE.length], pts: r.pts });

    h4Text('h-t1', `各节点延迟（${range.label}）`);
    $('legend').innerHTML = series.map((s) => `<span class="chip"><b style="color:${s.color}">■</b> ${escapeHtml(s.name)}</span>`).join('');
    drawLine($('c1'), series, { unit: 'ms', long: spanSec(...series.map((s) => s.pts)) > 86400 });
  }
}

// ---------------- canvas 画图 ----------------
function latColor(l) {
  if (l == null) return '#8d8b86';
  if (l < 120) return '#3fbf5f';
  if (l < 220) return '#e8a33d';
  return '#ff5a3c';
}

function drawLine(canvas, series, { unit = '', max = null, dual = false, long = false } = {}) {
  if (!canvas) return;
  const W = canvas.width, H = canvas.height;
  const c = canvas.getContext('2d');
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.clearRect(0, 0, W, H);
  const padL = 46, padR = 12, padT = 14, padB = 22;
  const iw = W - padL - padR, ih = H - padT - padB;

  const all = series.flatMap((s) => s.pts);
  const clean = all.filter((p) => p[1] != null && isFinite(p[1]));
  c.font = '11px ui-monospace,Consolas,monospace';
  if (!clean.length) {
    c.fillStyle = 'rgba(255,255,255,.45)';
    c.fillText('暂无数据', padL, H / 2);
    return;
  }
  const ts0 = Math.min(...all.map((p) => p[0])), ts1 = Math.max(...all.map((p) => p[0]));
  const vals = clean.map((p) => p[1]);
  const vMax = max != null ? max : Math.max(...vals) * 1.15 || 1;
  const yScale = (v) => padT + ih * (1 - Math.max(0, Math.min(1, v / vMax)));
  const xScale = (t) => padL + iw * (ts1 === ts0 ? 0.5 : (t - ts0) / (ts1 - ts0));

  // 网格 + y 轴
  c.strokeStyle = 'rgba(255,255,255,.10)';
  c.fillStyle = 'rgba(255,255,255,.5)';
  for (let i = 0; i <= 4; i++) {
    const y = padT + ih * i / 4;
    c.beginPath(); c.moveTo(padL, y); c.lineTo(W - padR, y); c.stroke();
    const v = vMax * (1 - i / 4);
    c.fillText(dual ? shortNum(v) : `${shortNum(v)}${unit}`, 6, y + 4);
  }
  // x 轴时间：窗口跨天就标日期（7 天/30 天窗口里「14:20」读不出是哪天）
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
    if (!isFinite(t)) continue;
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
