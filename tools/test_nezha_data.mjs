// js/data.js 的哪吒（Nezha）分支集成测试（不依赖浏览器/网络）：用假的 fetch + WebSocket
// 把 /api/v1/ws/server、/api/v1/service、/api/v1/server/<id>/service、/api/v1/server/<id>/metrics
// 喂进去，验证 Farm 真的把实时状态、服务统计、详情历史串起来了。
// 跑法：node tools/test_nezha_data.mjs
import assert from 'node:assert/strict';

const PORT = 8897;
const BASE = `http://127.0.0.1:${PORT}/chicken/`;
const nowSec = () => Date.now() / 1000;
const iso = (sec) => new Date(sec * 1000).toISOString();

// data.js 在模块顶层读 document.baseURI / window.CP_OPTIONS —— 先摆好再 import。
globalThis.window = { CP_OPTIONS: { source: 'nezha' } };
globalThis.document = {
  baseURI: BASE + 'index.html',
  hidden: false,
  addEventListener() {},
  removeEventListener() {},
};
// WebSocket 可手动控制：先连上，再由测试喂一帧。
class FakeWS {
  constructor() {
    this.readyState = 0;
    FakeWS.last = this;
    setTimeout(() => {
      this.readyState = 1;
      if (this.onopen) this.onopen();
    }, 0);
  }
  send() {}
  close() {
    this.readyState = 3;
    setTimeout(() => this.onclose && this.onclose(), 0);
  }
}
FakeWS.last = null;
globalThis.WebSocket = FakeWS;

const T0 = Math.floor(nowSec());
const HOST = {
  platform: 'Ubuntu', platform_version: '24.04', arch: 'x86_64',
  cpu: ['AMD EPYC 7B13', 'AMD EPYC 7B13'], mem_total: 8589934592,
  disk_total: 107374182400, swap_total: 2147483648, virtualization: 'kvm',
};
const state = (i) => ({
  cpu: 12.5 + i * 20, mem_used: 1073741824 + i * 2147483648, disk_used: 21474836480,
  net_in_transfer: 10737418240, net_out_transfer: 21474836480,
  net_in_speed: 102400 + i, net_out_speed: 204800 + i, uptime: 86400 + i * 3600,
  load_1: 0.42 + i, load_5: 0.38 + i, load_15: 0.31 + i,
  tcp_conn_count: 25 + i, udp_conn_count: 3, process_count: 132 + i,
});
const SERVERS = [1, 2].map((id) => ({
  id, name: id === 1 ? 'Tokyo-01' : 'Frankfurt-01', country_code: id === 1 ? 'JP' : 'DE',
  last_active: iso(T0 - 2), host: HOST, state: state(id - 1),
}));
const delays = Array(30).fill(0);
delays[29] = 42.5;

const env = (data) => ({ success: true, data });
const ok = (obj) => ({ ok: true, status: 200, json: async () => obj });
const notFound = () => ({ ok: false, status: 404, json: async () => ({}) });

const METRICS = {
  cpu: [[-3600, 11], [-1800, 12], [-60, 13]],
  memory: [[-3600, 1024 * 1024 * 100], [-1800, 1024 * 1024 * 110], [-60, 1024 * 1024 * 120]],
  disk: [[-60, 21474836480]],
  net_in_speed: [[-60, 2048]],
  net_out_speed: [[-60, 4096]],
  tcp_conn: [[-60, 12]],
  udp_conn: [[-60, 2]],
  process_count: [[-60, 120]],
};

globalThis.fetch = async (url) => {
  const u = new URL(String(url));
  const p = u.pathname.replace(/^\/chicken\/api\//, '');
  if (p === 'v1/setting') {
    return ok(env({
      config: { config_for_guests: { site_name: 'Nezha Mock', language: 'zh-CN' } },
      tsdb_enabled: true,
    }));
  }
  if (p === 'v1/service') {
    return ok(env({ services: {
      1: { service_name: 'Web', current_up: 10, current_down: 5, total_up: 100, total_down: 20, delay: delays },
      2: { service_name: 'DNS', current_up: 0, current_down: 0, total_up: 10, total_down: 10, delay: Array(30).fill(0) },
    } }));
  }
  let m = p.match(/^v1\/server\/(\d+)\/service$/);
  if (m) {
    return ok(env([{
      monitor_id: 1, monitor_name: 'Web', server_id: Number(m[1]),
      created_at: [(T0 - 600) * 1000, (T0 - 60) * 1000],
      avg_delay: [20, 21],
    }]));
  }
  m = p.match(/^v1\/server\/(\d+)\/metrics$/);
  if (m) {
    const metric = u.searchParams.get('metric');
    const pts = METRICS[metric] || [];
    return ok(env({
      server_id: Number(m[1]), metric,
      data_points: pts.map(([ago, value]) => ({ ts: (T0 + ago) * 1000, value })),
    }));
  }
  m = p.match(/^v1\/service\/(\d+)\/history$/);
  if (m) {
    return ok(env({
      service_id: Number(m[1]), service_name: 'Web',
      servers: [1, 2].map((sid) => ({
        server_id: sid, server_name: sid === 1 ? 'Tokyo-01' : 'Frankfurt-01',
        stats: { avg_delay: 20, up_percent: 95, total_up: 19, total_down: 1, data_points: [
          { ts: (T0 - 600) * 1000, delay: 20, status: 1 },
          { ts: (T0 - 30) * 1000, delay: 22, status: 1 },
        ] },
      })),
    }));
  }
  return notFound();
};

let pass = 0;
const t = async (name, fn) => {
  try {
    await fn();
    pass += 1;
    console.log(`PASS  ${name}`);
  } catch (e) {
    console.log(`FAIL  ${name}\n      ${e.message}`);
    process.exitCode = 1;
  }
};

const { Farm, CONF } = await import('../js/data.js');
const farm = new Farm();

try {
  await t('数据源是 nezha（site-options.source 覆盖 config.js 的占位 SOURCE）', () => {
    assert.equal(CONF.source, 'nezha');
    assert.equal(farm.source, 'nezha');
  });

  await farm.refreshMe();

  await t('refreshMe：tsdb_enabled / 游客站名 / historyDays=1（游客只能查 1d）', () => {
    assert.equal(farm.tsdbEnabled, true);
    assert.equal(farm.siteName, 'Nezha Mock');
    assert.equal(farm.historyDays, 1);
  });

  farm._startLive();
  await new Promise((r) => setTimeout(r, 30));

  await t('WS 帧：servers → 节点（在线/国旗/指标/服务器时钟算在线时长）', () => {
    const ws = FakeWS.last;
    assert.ok(ws && ws.readyState === 1, 'fake WebSocket 没打开');
    ws.onmessage({ data: JSON.stringify({ now: (T0 + 5) * 1000, online: 3, servers: SERVERS }) });
    assert.equal(farm.nodes.length, 2);
    const n = farm.nodes[0];
    assert.equal(n.id, 1);
    assert.equal(n.name, 'Tokyo-01');
    assert.equal(n.country, 'JP');
    assert.equal(n.online, true);
    assert.equal(n.last_seen_ago, 7);            // 帧里 now 比 last_active 晚 5 秒 + 2 秒
    assert.equal(n.metrics.cpu, 12.5);
    assert.equal(n.metrics.net_rx, 102400);
    assert.equal(n.metrics.load[0], 0.42);
    assert.equal(farm.onlineCount, 2);
    assert.equal(farm.error, null);
  });

  await farm.refreshNodes();

  await t('refreshNodes：/v1/service → 网站鸡（n=样本数、loss、今日均值、nUnit=次）', () => {
    assert.equal(farm.tasks.size, 2);
    const web = farm.tasks.get(1);
    assert.equal(web.name, 'Web');
    assert.equal(web.n, 15);
    assert.equal(web.nUnit, '次');
    assert.equal(web.avg, 42.5);
    assert.equal(Math.round(web.loss * 100) / 100, 33.33);
    assert.deepEqual(web.per, []);
    assert.equal(farm.probes['1'], 'Web');
    assert.equal(farm.tasks.get(2).avg, null);
    // 哪吒没有每节点实时延迟 → 网络榜为空，但 CPU/内存判定照常
    assert.deepEqual(farm.netRank, []);
    assert.equal(farm.worstNodeId, null);
  });

  await t('ranges：哪吒只给 1h/6h/24h（游客 1d 窗口内截）', () => {
    const r = farm.ranges();
    assert.deepEqual(r.map((x) => x.hours), [1, 6, 24]);
    assert.equal(r[2].label, '24 小时');
  });

  await t('nodeDetail：资源历史多指标合并 + 网络延迟（server/<id>/service）', async () => {
    const d = await farm.nodeDetail(1, { hours: 24, points: 180, force: true });
    assert.equal(d.note, '');
    assert.ok(d.metrics.length >= 1);
    const last = d.metrics[d.metrics.length - 1];
    assert.equal(last.cpu, 13);
    assert.equal(last.mem_used, 1024 * 1024 * 120);
    assert.equal(last.net_rx, 2048);
    assert.equal(last.tcp, 12);
    assert.equal(d.ping.length, 2);
    assert.equal(d.ping[0].task_id, 1);
    assert.equal(d.probes['1'], 'Web');
  });

  await t('nodeDetail：TSDB 关闭时不发 9 个指标请求，只留延迟 + 说明', async () => {
    farm.tsdbEnabled = false;
    const d = await farm.nodeDetail(2, { hours: 24, points: 180, force: true });
    assert.deepEqual(d.metrics, []);
    assert.match(d.note, /TSDB/);
    assert.equal(d.ping.length, 2);
    farm.tsdbEnabled = true;
  });

  await t('taskHistory：一次 service/<id>/history 拿全部节点曲线 + 当前值', async () => {
    const d = await farm.taskHistory(1, { hours: 24, points: 180, force: true });
    assert.equal(d.series.length, 2);
    assert.equal(d.series[0].name, 'Tokyo-01');
    assert.equal(d.series[0].points.length, 2);
    assert.equal(d.latest.length, 2);
    assert.equal(d.latest[0].latency, 22);
  });

  await t('负面：WS 连不上 3 次给出可行动提示；401 归因到 force_auth', () => {
    farm._onNezhaFail(1);
    farm._onNezhaFail(3);
    assert.match(farm.error, /ws\/server/);
    assert.match(farm._friendlyNezhaError(new Error('v1/service → HTTP 401')), /force_auth|强制认证/);
    assert.match(farm._friendlyNezhaError(new Error('v1/service → HTTP 404')), /hub-port/);
  });

  await t('servers 缺字段 = 游客看不到任何服务器 → 节点清空（不留旧鸡）', () => {
    const ws = FakeWS.last;
    ws.onmessage({ data: JSON.stringify({ now: (T0 + 6) * 1000 }) });
    assert.equal(farm.nodes.length, 0);
    assert.equal(farm.onlineCount, 0);
  });
} finally {
  farm.stop();
}

console.log(`\n${pass} 项通过${process.exitCode ? '（有失败）' : ''}`);
