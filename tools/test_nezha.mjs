// 哪吒监控（Nezha）→ monitor 形状的字段映射单测（不需要浏览器/网络）。
// 样例字段照抄 Nezha V2 的 model/host.go、model/service_api.go 与 /api/v1/ws/server。
// 跑法：node tools/test_nezha.mjs
import assert from 'node:assert/strict';
import {
  unwrap, parseTime, countryCode, mapState, mapServer, parseStream,
  mapServiceStats, mapServiceHistory, mapServerServices, mergeMetrics,
  inWindow, downsample, ONLINE_MAX_AGE,
} from '../js/nezha.js';

let pass = 0;
const t = (name, fn) => {
  try {
    fn();
    pass += 1;
    console.log(`PASS  ${name}`);
  } catch (e) {
    console.log(`FAIL  ${name}\n      ${e.message}`);
    process.exitCode = 1;
  }
};

const TS = Date.UTC(2026, 8, 16, 8, 30) / 1000;
const iso = (sec) => new Date(sec * 1000).toISOString();

t('unwrap：{success,data} 取 data，success:false 抛 error，raw 原样返回', () => {
  assert.deepEqual(unwrap({ success: true, data: { a: 1 } }), { a: 1 });
  assert.throws(() => unwrap({ success: false, error: 'unauthorized' }), /unauthorized/);
  assert.throws(() => unwrap({ error: 'force_auth' }), /force_auth/);
  assert.deepEqual(unwrap({ now: 1, servers: [] }), { now: 1, servers: [] });
});

t('parseTime：RFC3339 / 毫秒 / Go 零值都能解析', () => {
  assert.equal(parseTime('2026-09-16T08:30:00Z'), TS);
  assert.equal(parseTime('2026-09-16T08:30:00.123456789Z'), TS + 0.123);
  assert.equal(parseTime('2026-09-16T17:30:00+09:00'), TS);
  assert.equal(parseTime(1760000000123), 1760000000.123);
  assert.equal(parseTime('0001-01-01T00:00:00Z') < 0, true);   // 调用方按「从未上报」处理
  assert.equal(parseTime('nope'), null);
  assert.equal(parseTime(null), null);
});

t('countryCode：两位字母才认，其它退化空串', () => {
  assert.equal(countryCode('jp'), 'JP');
  assert.equal(countryCode('DE'), 'DE');
  assert.equal(countryCode('Japan'), '');
  assert.equal(countryCode(''), '');
});

const HOST = {
  platform: 'Ubuntu', platform_version: '24.04', arch: 'x86_64',
  cpu: ['AMD EPYC 7B13 64-Core Processor', 'AMD EPYC 7B13 64-Core Processor'],
  mem_total: 8589934592, disk_total: 107374182400, swap_total: 2147483648,
  virtualization: 'kvm', boot_time: 1750000000, version: '2.0.0',
};
const STATE = {
  cpu: 12.5, mem_used: 1073741824, disk_used: 21474836480,
  net_in_transfer: 10737418240, net_out_transfer: 21474836480,
  net_in_speed: 102400, net_out_speed: 204800, uptime: 86400,
  load_1: 0.42, load_5: 0.38, load_15: 0.31,
  tcp_conn_count: 25, udp_conn_count: 3, process_count: 132,
};

t('mapState：网速/流量/连接/负载字段对齐 monitor（swap_used=0 被 omitempty 抹掉）', () => {
  const m = mapState(STATE);
  assert.equal(m.cpu, 12.5);
  assert.equal(m.mem_used, 1073741824);
  assert.equal(m.net_rx, 102400);          // net_in_speed = 下行
  assert.equal(m.net_tx, 204800);
  assert.equal(m.net_total_rx, 10737418240);
  assert.equal(m.load[0], 0.42);
  assert.equal(m.procs, 132);
  assert.equal(m.tcp, 25);
  assert.equal(m.udp, 3);
  assert.equal(m.swap_used, null);         // omitempty 的 0 → null，不编造 0 字节
  assert.equal(mapState({}), null);
});

t('mapServer：在线按服务器时钟算；游客 Host 缺版本字段也不炸', () => {
  const srv = {
    id: 3, name: 'Tokyo-01', country_code: 'jp',
    last_active: iso(TS), host: HOST, state: STATE,
  };
  const online = mapServer(srv, TS + 5);
  assert.equal(online.id, 3);
  assert.equal(online.name, 'Tokyo-01');
  assert.equal(online.country, 'JP');
  assert.equal(online.online, true);
  assert.equal(online.last_seen_ago, 5);
  assert.equal(online.metrics.mem_total, 8589934592);   // Host 的容量补到 metrics
  assert.equal(online.metrics.disk_total, 107374182400);
  assert.equal(online.cpu_cores, 2);
  assert.equal(online.cpu_name, 'AMD EPYC 7B13 64-Core Processor');
  assert.equal(online.os, 'Ubuntu 24.04');

  const stale = mapServer(srv, TS + ONLINE_MAX_AGE + 1);
  assert.equal(stale.online, false);

  // 游客拿到的 Host.Filter() 会去掉 platform_version：只显示 platform
  const guest = mapServer({ ...srv, host: { ...HOST, platform_version: undefined } }, TS);
  assert.equal(guest.os, 'Ubuntu');

  // Go 零值时间 = 从未上报：不能算成上线，也不能显示「2000 年前」
  const never = mapServer({ id: 4, name: 'new', last_active: '0001-01-01T00:00:00Z' }, TS);
  assert.equal(never.online, false);
  assert.equal(never.last_seen, null);
  assert.equal(never.last_seen_ago, null);
});

t('parseStream：缺 servers 按空列表（游客看不到任何服务器时 God 会 omitempty）', () => {
  const frame = { now: TS * 1000, online: 2, servers: [
    { id: 1, name: 'A', last_active: iso(TS - 2), host: HOST, state: STATE, country_code: 'JP' },
    { id: 2, name: 'B', last_active: iso(TS - 999), host: HOST, state: STATE },
  ] };
  const out = parseStream(frame, 0);
  assert.equal(out.now, TS);
  assert.equal(out.nodes.length, 2);
  assert.equal(out.nodes[0].online, true);
  assert.equal(out.nodes[1].online, false);
  assert.deepEqual(out.nodes.map((n) => n.sort), [0, 1]);   // 保留 WS 的展示顺序
  assert.deepEqual(parseStream({ now: TS * 1000 }, 0).nodes, []);
  assert.equal(parseStream({ now: TS }, 0).now, TS);      // 秒级 now 也认（老版本/反代）
  assert.equal(parseStream({}, 1234).now, 1234);       // 没有 now 时用调用方给的兜底
});

t('mapServiceStats：n=近 15 分钟样本数、loss=失败占比、avg=今日均值（delay[29]）', () => {
  const delays = Array(30).fill(0);
  delays[29] = 42.5;
  const rows = mapServiceStats({
    1: { service_name: 'Web', current_up: 10, current_down: 5, total_up: 100, total_down: 20, delay: delays },
    2: { service_name: 'Dead', current_up: 0, current_down: 0, total_up: 10, total_down: 10, delay: Array(30).fill(0) },
  });
  const web = rows.find((r) => r.id === 1);
  assert.equal(web.name, 'Web');
  assert.equal(web.n, 15);
  assert.equal(web.nUnit, '次');
  assert.equal(web.avg, 42.5);
  assert.equal(Math.round(web.loss * 100) / 100, 33.33);
  assert.equal(web.best, null);
  assert.equal(web.worst, null);

  const dead = rows.find((r) => r.id === 2);
  assert.equal(dead.n, 0);
  assert.equal(dead.avg, null);            // 0 是「没有数据」的哨兵，不是 0ms
  assert.equal(dead.loss, null);           // 没有近 15 分钟样本：不能拿 30 天比例冒充
  assert.equal(dead.loss30d, 50);
});

t('mapServiceHistory：status=0 的点是失败，不能画成 0ms；服务名进 probes', () => {
  const d = mapServiceHistory({
    service_id: 1, service_name: 'Web',
    servers: [{
      server_id: 2, server_name: 'Osaka',
      stats: { avg_delay: 30, up_percent: 90, total_up: 9, total_down: 1, data_points: [
        { ts: TS * 1000, delay: 30, status: 1 },
        { ts: (TS + 10) * 1000, delay: 0, status: 0 },
      ] },
    }],
  });
  assert.equal(d.servers.length, 1);
  assert.equal(d.servers[0].points.length, 2);
  assert.equal(d.servers[0].points[0].latency, 30);
  assert.equal(d.servers[0].points[1].latency, null);
  assert.equal(d.servers[0].loss, 10);
  assert.equal(d.ping.length, 2);
  assert.equal(d.ping[1].task_id, 1);
  assert.equal(d.probes['1'], 'Web');
});

t('INT：null/空串不变成 0（否则 history 里 service_id:null 会生成 #0 任务）', () => {
  const d = mapServiceHistory({ service_id: null, service_name: '', servers: [] });
  assert.equal(d.serviceId, null);
  assert.deepEqual(d.probes, {});
  assert.equal(d.ping.length, 0);
});

t('mapServerServices：created_at/avg_delay 平行数组；0/空值按失败处理', () => {
  const out = mapServerServices([{
    monitor_id: 7, monitor_name: '东京 → CF', server_id: 2,
    created_at: [TS * 1000, (TS + 60) * 1000, (TS + 120) * 1000],
    avg_delay: [12, 0, 33],
  }]);
  assert.equal(out.probes['7'], '东京 → CF');
  assert.equal(out.ping.length, 3);
  assert.equal(out.ping[0].latency, 12);
  assert.equal(out.ping[1].latency, null);
  assert.equal(out.ping[2].latency, 33);
  assert.equal(Math.round(out.loss['7'] * 100) / 100, 33.33);
});

t('mergeMetrics：多个指标按时间合并成行（ms→s），load1/5/15 回填 load[0..2]', () => {
  const ms = (sec) => sec * 1000;
  const rows = mergeMetrics([
    { metric: 'cpu', data_points: [{ ts: ms(TS), value: 12 }, { ts: ms(TS + 30), value: 15 }] },
    { metric: 'memory', data_points: [{ ts: ms(TS), value: 1024 }] },
    { metric: 'load1', data_points: [{ ts: ms(TS), value: 0.1 }] },
    { metric: 'load5', data_points: [{ ts: ms(TS), value: 0.2 }] },
    { metric: 'load15', data_points: [{ ts: ms(TS), value: 0.3 }] },
    { metric: 'tcp_conn', data_points: [{ ts: ms(TS + 30), value: 8 }] },
    { metric: 'unknown_metric', data_points: [{ ts: ms(TS), value: 999 }] },
  ]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].ts, TS);
  assert.equal(rows[0].cpu, 12);
  assert.equal(rows[0].mem_used, 1024);
  assert.deepEqual(rows[0].load, [0.1, 0.2, 0.3]);
  assert.equal(rows[1].cpu, 15);
  assert.equal(rows[1].tcp, 8);
  assert.equal('unknown_metric' in rows[0], false);
});

t('inWindow / downsample：按服务器时钟截窗口、均匀抽稀且保留末点', () => {
  const rows = Array.from({ length: 100 }, (_, i) => ({ ts: TS + i * 60, v: i }));
  const win = inWindow(rows, 1, TS + 99 * 60);      // 只留最近 1 小时
  assert.equal(win.length, 61);                    // 0..60 共 61 个整点
  const thin = downsample(rows, 10);
  assert.equal(thin.length, 10);
  assert.equal(thin[0].v, 0);
  assert.equal(thin[9].v, 99);                     // 必须保留最新点（曾经丢到 90）
  assert.deepEqual(downsample(rows, 500), rows);   // 点数够多不抽
});
