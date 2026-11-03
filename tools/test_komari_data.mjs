// js/data.js 的 Komari 分支集成测试（不依赖浏览器/网络）：用假的 fetch + WebSocket
// 把 Komari 的 nodes / recent / ping / load 喂进去，验证 Farm 真的把字段映射、聚合、详情串起来。
// 跑法：node tools/test_komari_data.mjs
import assert from 'node:assert/strict';
import { KomariLive } from '../js/komari.js';

const PORT = 8898;
const BASE = `http://127.0.0.1:${PORT}/chicken/`;
const nowSec = () => Date.now() / 1000;
const iso = (ago) => new Date((nowSec() - ago) * 1000).toISOString();

// data.js 在模块顶层读 document.baseURI / window.CP_OPTIONS —— 先摆好再 import。
globalThis.window = { CP_OPTIONS: { source: 'komari' } };
globalThis.document = {
  baseURI: BASE + 'index.html',
  hidden: false,
  addEventListener() {},
  removeEventListener() {},
};
// WebSocket 可手动控制：先验证 /api/recent 兜底，再模拟「连上并收到快照」。
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

const NODES = [
  {
    uuid: 'aaaaaaaa-1111-2222-3333-444444444444', name: 'Tokyo-01',
    cpu_name: 'AMD EPYC 7B13', virtualization: 'kvm', arch: 'x86_64', cpu_cores: 4,
    os: 'Ubuntu 24.04', kernel_version: '6.8.0', region: 'JP', public_remark: 'mock 东京节点',
    mem_total: 8589934592, swap_total: 2147483648, disk_total: 107374182400,
  },
  {
    uuid: 'bbbbbbbb-1111-2222-3333-444444444444', name: 'Frankfurt-01',
    cpu_name: 'Intel Xeon Gold 6338', virtualization: 'kvm', arch: 'x86_64', cpu_cores: 8,
    os: 'Debian GNU/Linux 12', kernel_version: '6.1.0', region: 'DE', public_remark: '',
    mem_total: 17179869184, swap_total: 0, disk_total: 214748364800,
  },
];

const report = (i) => ({
  cpu: { name: NODES[i].cpu_name, cores: NODES[i].cpu_cores, arch: 'x86_64', usage: 12.5 + i * 20 },
  ram: { total: NODES[i].mem_total, used: 1073741824 + i * 2147483648 },
  swap: { total: NODES[i].swap_total, used: 0 },
  load: { load1: 0.42 + i, load5: 0.38 + i, load15: 0.31 + i },
  disk: { total: NODES[i].disk_total, used: 21474836480 + i * 10737418240 },
  network: { up: 204800 + i, down: 102400 + i, totalUp: 10737418240, totalDown: 21474836480 },
  connections: { tcp: 25 + i, udp: 3 },
  uptime: 86400 + i * 3600, process: 132 + i, updated_at: iso(2),
});

const env = (data) => ({ status: 'success', message: '', data });
const ok = (obj) => ({ ok: true, status: 200, json: async () => obj });
const notFound = () => ({ ok: false, status: 404, json: async () => ({}) });

globalThis.fetch = async (url) => {
  const u = new URL(String(url));
  const p = u.pathname;
  if (p.endsWith('/api/public')) {
    return ok(env({ sitename: 'Komari Mock', theme: 'default', record_preserve_time: 168, private_site: false }));
  }
  if (p.endsWith('/api/nodes')) return ok(env(NODES));
  if (p.includes('/api/recent/')) {
    const uuid = decodeURIComponent(p.split('/api/recent/')[1]);
    const i = NODES.findIndex((n) => n.uuid === uuid);
    return ok(env(i >= 0 ? [report(i)] : []));
  }
  if (p.endsWith('/api/records/ping')) {
    const uuid = u.searchParams.get('uuid');
    const i = NODES.findIndex((n) => n.uuid === uuid);
    return ok(env({
      count: 3,
      records: [
        { task_id: i + 1, time: iso(120), value: 22, client: uuid },
        { task_id: i + 1, time: iso(60), value: -1, client: uuid },
        { task_id: i + 1, time: iso(2), value: 31, client: uuid },
      ],
      tasks: [{ id: i + 1, name: `任务${i + 1}`, type: 'icmp', interval: 60,
        loss: 33.33, min: 22, max: 31, avg: 26, total: 3 }],
    }));
  }
  if (p.endsWith('/api/records/load')) {
    const i = NODES.findIndex((n) => n.uuid === u.searchParams.get('uuid'));
    const rows = Array.from({ length: 6 }, (_, k) => ({
      client: NODES[i].uuid, time: iso((5 - k) * 600),
      cpu: 10 + k * 5 + i * 10, ram: 1073741824 + k * 104857600, ram_total: NODES[i].mem_total,
      swap: 0, swap_total: NODES[i].swap_total, load: 0.1 * k, temp: 40,
      disk: 21474836480, disk_total: NODES[i].disk_total,
      net_in: 1024 * (k + 1), net_out: 2048 * (k + 1),
      net_total_up: 10737418240, net_total_down: 21474836480,
      process: 100 + k, connections: 20 + k, connections_udp: 2,
    }));
    return ok(env({ records: rows, count: rows.length }));
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
  await farm.refreshMe();
  await farm.refreshNodes();
  await farm.warmup();

  await t('数据源是 komari（site-options.source 覆盖或 config.js SOURCE）', () => {
    assert.equal(CONF.source, 'komari');
  });

  await t('refreshMe：record_preserve_time(168h) → historyDays 7', () => {
    assert.equal(farm.historyDays, 7);
  });

  await t('refreshNodes：uuid → 数字 id、region → 国旗、recent 兜底指标', () => {
    assert.equal(farm.nodes.length, 2);
    const n = farm.nodes[0];
    assert.ok(Number.isFinite(n.id) && n.id > 0);
    assert.equal(n.uuid, NODES[0].uuid);
    assert.equal(n.name, 'Tokyo-01');
    assert.equal(n.country, 'JP');
    assert.equal(n.online, true);
    assert.equal(n.metrics.cpu, 12.5);
    assert.equal(n.metrics.mem_used, 1073741824);
    assert.equal(n.metrics.disk_used, 21474836480);
    assert.deepEqual(n.metrics.load, [0.42, 0.38, 0.31]);
    assert.equal(n.metrics.procs, 132);
    assert.ok(n.last_seen_ago == null || n.last_seen_ago <= 5);
  });

  await t('warmup/_fetchPing：任务名、丢包率、延迟最新值（丢掉的是 null）', () => {
    assert.equal(farm.tasks.size, 2);
    const t1 = farm.tasks.get(1);
    assert.equal(t1.name, '任务1');
    assert.equal(t1.n, 1);
    assert.equal(t1.avg, 31);
    assert.equal(t1.loss, 33.33);
    const latest = farm.ping.get(farm.nodes[0].id).get(1);
    assert.equal(latest.latency, 31);
  });

  await t('WS /api/clients：在线列表 + 快照覆盖 metrics（在线不信浏览器时钟）', async () => {
    farm._startLive();
    await new Promise((r) => setTimeout(r, 30));
    const ws = FakeWS.last;
    assert.ok(ws && ws.readyState === 1, 'fake WebSocket 没打开');
    const liveReport = report(0);
    liveReport.cpu.usage = 99;
    ws.onmessage({ data: JSON.stringify({ status: 'success', data: {
      online: [NODES[0].uuid],
      data: { [NODES[0].uuid]: liveReport },
    } }) });
    assert.equal(farm.nodes[0].online, true);
    assert.equal(farm.nodes[0].metrics.cpu, 99);
    assert.equal(farm.nodes[0].last_seen_ago, 0);
    assert.equal(farm.nodes[1].online, false);
  });

  await t('数字 id 由 UUID 确定性哈希（不同页面/可见性下不串鸡）', () => {
    const f2 = new Farm();
    assert.equal(f2._komariId(NODES[0].uuid), farm._komariId(NODES[0].uuid));
    assert.equal(f2._komariId(NODES[1].uuid), farm._komariId(NODES[1].uuid));
    assert.notEqual(f2._komariId(NODES[0].uuid), f2._komariId(NODES[1].uuid));
  });

  await t('recent 非空即在线：服务器 updated_at 很旧也不受访客时钟影响', async () => {
    const f3 = new Farm();
    const saved = globalThis.fetch;
    globalThis.fetch = async (url) => {
      if (String(url).includes('/api/recent/')) {
        const old = report(0);
        old.updated_at = '2000-01-01T00:00:00Z';
        return ok(env([old]));
      }
      return saved(url);
    };
    try {
      const n = { uuid: NODES[0].uuid, online: false, last_seen_ago: null };
      const stats = await f3._komariRecentFallback([n], nowSec());
      assert.deepEqual(stats, { ok: 1, fail: 0 });
      assert.equal(n.online, true);
      assert.equal(n.last_seen_ago, 0);
    } finally {
      globalThis.fetch = saved;
    }
  });

  await t('全丢包节点仍算“在测”，并进入网络最差榜', () => {
    const f4 = new Farm();
    f4.nodes = [{ id: 7, name: 'loss-only', online: true, metrics: {} }];
    f4.probes = { 9: '全丢包任务' };
    f4.ping = new Map([[7, new Map([[9, { latency: null, ts: nowSec() - 1 }]])]]);
    f4.lossByNode = new Map([[7, { 9: 100 }]]);
    f4._aggregate();
    const task = f4.tasks.get(9);
    assert.equal(task.n, 1);                  // 有新鲜样本（虽然没延迟）
    assert.equal(task.avg, null);             // 没有成功样本
    assert.equal(f4.netRank.length, 1);
    assert.equal(f4.worst.node.id, 7);
    // 任务/节点没数据后不能留下幽灵网站鸡
    f4.ping = new Map();
    f4.lossByNode = new Map();
    f4._aggregate();
    assert.equal(Object.keys(f4.probes).length, 0);
  });

  await t('WS 打开但没收到快照不算 live；收到第一条快照才 onState(true)', async () => {
    const states = [];
    const datas = [];
    const live = new KomariLive('ws://fake/clients', {
      interval: 100,
      onState: (ok) => states.push(ok),
      onData: (d) => datas.push(d),
    });
    live.start();
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(states, []);             // 只 open、没 payload：不能把兜底关掉
    FakeWS.last.onmessage({ data: JSON.stringify({ status: 'success', data: {
      online: [NODES[0].uuid], data: { [NODES[0].uuid]: report(0) },
    } }) });
    assert.deepEqual(states, [true]);
    assert.equal(datas.length, 1);
    live.stop();
    FakeWS.last.onmessage({ data: JSON.stringify({ status: 'success', data: {
      online: [], data: {},
    } }) });
    assert.equal(datas.length, 1);            // stop 后的迟到帧忽略
  });

  await t('nodeDetail：load 6 行 + ping 3 条 + probes 名称', async () => {
    const d = await farm.nodeDetail(farm.nodes[0].id, { hours: 1, points: 60, force: true });
    assert.equal(d.metrics.length, 6);
    assert.equal(d.metrics[0].cpu, 10);
    assert.equal(d.metrics[0].net_rx, 1024);
    assert.equal(d.metrics[0].procs, 100);
    assert.equal(d.metrics[0].tcp, 20);
    assert.equal(d.ping.length, 3);
    assert.ok(d.ping.some((p) => p.latency === null));
    assert.equal(d.probes['1'], '任务1');
  });
} catch (e) {
  console.log('FAIL  集成流程异常\n      ' + (e && e.stack ? e.stack : e));
  process.exitCode = 1;
} finally {
  farm.stop();
}

console.log(`\n${pass} 项通过${process.exitCode ? '（有失败）' : ''}`);
