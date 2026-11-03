// Komari → monitor 形状的字段映射单测（不需要浏览器/网络）。
// 跑法：node tools/test_komari.mjs
import assert from 'node:assert/strict';
import {
  unwrap, parseTime, countryCode, mapReport, mapNode,
  mapLoadRecords, mapPingPayload, mapDetail,
} from '../js/komari.js';

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

t('unwrap：标准包络取 data，error 抛 message，raw 原样返回', () => {
  assert.deepEqual(unwrap({ status: 'success', data: [1] }), [1]);
  assert.throws(() => unwrap({ status: 'error', message: '私有站点' }), /私有站点/);
  assert.deepEqual(unwrap({ username: 'Guest', logged_in: false }), { username: 'Guest', logged_in: false });
});

t('parseTime：RFC3339 / 毫秒 / 偏移都能解析；垃圾返回 null', () => {
  assert.equal(parseTime('2026-09-16T08:30:00Z'), Date.UTC(2026, 8, 16, 8, 30) / 1000);
  assert.equal(parseTime('2026-09-16T08:30:00.123456789Z'), Date.UTC(2026, 8, 16, 8, 30, 0, 123) / 1000);
  assert.equal(parseTime('2026-09-16T17:30:00+09:00'), Date.UTC(2026, 8, 16, 8, 30) / 1000);
  assert.equal(parseTime(1758000000123), 1758000000.123);
  assert.equal(parseTime('nope'), null);
  assert.equal(parseTime(null), null);
});

t('countryCode：两位字母才认，其它退化空串', () => {
  assert.equal(countryCode('jp'), 'JP');
  assert.equal(countryCode('JP'), 'JP');
  assert.equal(countryCode('Japan'), '');
  assert.equal(countryCode(''), '');
});

const REPORT = {
  cpu: { usage: 12.5, cores: 4, name: 'AMD EPYC' },
  ram: { total: 8589934592, used: 1073741824 },
  swap: { total: 2147483648, used: 0 },
  disk: { total: 107374182400, used: 21474836480 },
  network: { up: 204800, down: 102400, totalUp: 10737418240, totalDown: 21474836480 },
  connections: { tcp: 25, udp: 3 },
  load: { load1: 0.42, load5: 0.38, load15: 0.31 },
  uptime: 86400,
  process: 132,
  updated_at: '2026-09-16T08:30:00Z',
};

t('mapReport：字段名/数组形状对齐 monitor（load[0..2]、net_rx=down）', () => {
  const m = mapReport(REPORT);
  assert.equal(m.cpu, 12.5);
  assert.equal(m.mem_used, 1073741824);
  assert.equal(m.disk_total, 107374182400);
  assert.equal(m.net_rx, 102400);       // Komari network.down = 下行
  assert.equal(m.net_tx, 204800);
  assert.deepEqual(m.load, [0.42, 0.38, 0.31]);
  assert.equal(m.procs, 132);
  assert.equal(m.tcp, 25);
  assert.equal(m.udp, 3);
  assert.equal(m.updated_at, Date.UTC(2026, 8, 16, 8, 30) / 1000);
  assert.equal(mapReport({}), null);
});

t('mapNode：uuid→数字 id、region→国旗、last_seen_ago 按传入时刻算', () => {
  const now = Date.UTC(2026, 8, 16, 8, 31) / 1000;
  const n = mapNode({
    uuid: 'u-1', name: 'Tokyo-01', region: 'jp', os: 'Ubuntu 24.04',
    virtualization: 'kvm', cpu_name: 'AMD EPYC 7B13', cpu_cores: 4,
    mem_total: 8589934592, disk_total: 107374182400, public_remark: '公开备注',
  }, REPORT, true, 7, now);
  assert.equal(n.id, 7);
  assert.equal(n.uuid, 'u-1');
  assert.equal(n.name, 'Tokyo-01');
  assert.equal(n.country, 'JP');
  assert.equal(n.virt, 'kvm');
  assert.equal(n.cpu_cores, 4);
  assert.equal(n.online, true);
  assert.equal(n.metrics.cpu, 12.5);
  assert.equal(n.last_seen_ago, 60);
  assert.equal(n.public_remark, '公开备注');
});

t('mapLoadRecords：ram/disk/network/connections 映射，按时间升序，Connections 直接当 TCP', () => {
  const rows = mapLoadRecords([
    { time: '2026-09-16T08:32:00Z', cpu: 5, ram: 1, ram_total: 2, disk: 3, disk_total: 4,
      net_in: 10, net_out: 20, connections: 30, connections_udp: 4, process: 40, load: 0.5 },
    { time: '2026-09-16T08:30:00Z', cpu: 1, ram: 1, ram_total: 2, disk: 3, disk_total: 4,
      net_in: 11, net_out: 21, connections_tcp: 9, connections_udp: 2, process: 41 },
    { time: 'bad' },
  ]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].ts, Date.UTC(2026, 8, 16, 8, 30) / 1000);
  assert.equal(rows[1].ts, Date.UTC(2026, 8, 16, 8, 32) / 1000);
  assert.equal(rows[0].tcp, 9);
  assert.equal(rows[0].udp, 2);
  // Komari 的 Record.Connections 本身就是 TCP（不是 TCP+UDP），别再减 UDP。
  assert.equal(rows[1].tcp, 30);
  assert.equal(rows[1].udp, 4);
  assert.equal(rows[1].net_rx, 10);
  assert.equal(rows[1].procs, 40);
});

t('mapPingPayload：value<0 → latency null；loss 优先 tasks[].loss，否则按记录算', () => {
  const p = mapPingPayload({
    tasks: [{ id: 1, name: '东京 → CF', loss: 12.5 }, { id: 2, name: '大阪' },
      { id: 3, name: '还没跑过的任务', loss: 0, total: 0 }],
    records: [
      { task_id: 1, time: '2026-09-16T08:30:00Z', value: 33 },
      { task_id: 1, time: '2026-09-16T08:31:00Z', value: -1 },
      { task_id: 2, time: '2026-09-16T08:30:00Z', value: -1 },
      { task_id: 2, time: '2026-09-16T08:31:00Z', value: 50 },
    ],
  });
  assert.equal(p.probes['1'], '东京 → CF');
  assert.equal(p.probes['2'], '大阪');
  assert.equal(p.loss['1'], 12.5);           // 服务端统计优先
  assert.equal(p.loss['2'], 50);             // 没给 loss → 1/2 条丢包
  assert.equal('3' in p.loss, false);        // total=0 的 loss:0 不是“0% 丢包”，不能采信
  const t1 = p.ping.filter((x) => x.task_id === 1);
  assert.equal(t1.length, 2);
  assert.equal(t1.find((x) => x.ts === Date.UTC(2026, 8, 16, 8, 31) / 1000).latency, null);
});

t('mapDetail：资源 + ping 合成详情结构', () => {
  const d = mapDetail(
    { records: [{ time: '2026-09-16T08:30:00Z', cpu: 1, ram: 2, ram_total: 4 }] },
    { records: [{ task_id: 3, time: '2026-09-16T08:30:00Z', value: 9 }], tasks: [{ id: 3, name: '任务3' }] },
  );
  assert.equal(d.metrics.length, 1);
  assert.equal(d.metrics[0].cpu, 1);
  assert.deepEqual(d.ping, [{ task_id: 3, ts: Date.UTC(2026, 8, 16, 8, 30) / 1000, latency: 9 }]);
  assert.equal(d.probes['3'], '任务3');
});

console.log(`\n${pass} 项通过${process.exitCode ? '（有失败）' : ''}`);
