#!/usr/bin/env python3
"""本地开发/浏览器自测用：静态伺服 cyber-probe，并伪造一套哪吒监控（Nezha V2）的游客 API。

不是哪吒的替代品：只为验证「SOURCE=nezha 时前端能不能把哪吒的字段映射成鸡」。
与 mock/komari.py 不同，这里**真的实现**了 /api/v1/ws/server 的 WebSocket 握手与推送
（哪吒没有 REST 兜底，WS 断了前端就没有节点数据），并用标准库手写帧，不引第三方包。

用法：
  python3 mock/nezha.py 8896
  打开 http://127.0.0.1:8896/chicken/?debug&nomodels
"""
import base64
import datetime
import hashlib
import http.server
import json
import os
import socketserver
import sys
import time
import urllib.parse

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8896
WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'


def iso(sec_ago=0):
    now = datetime.datetime.now(datetime.timezone.utc)
    return (now - datetime.timedelta(seconds=sec_ago)).isoformat(timespec='milliseconds').replace('+00:00', 'Z')


SERVERS = [
    {
        'id': 1, 'name': 'Tokyo-01', 'country_code': 'JP', 'public_note': 'mock 东京节点',
        'host': {
            'platform': 'Ubuntu', 'platform_version': '24.04', 'arch': 'x86_64',
            'cpu': ['AMD EPYC 7B13 64-Core Processor'] * 4,
            'mem_total': 8589934592, 'swap_total': 2147483648, 'disk_total': 107374182400,
            'virtualization': 'kvm', 'boot_time': 1750000000,
        },
        'state': {
            'cpu': 12.5, 'mem_used': 1073741824, 'disk_used': 21474836480,
            'net_in_transfer': 10737418240, 'net_out_transfer': 21474836480,
            'net_in_speed': 102400, 'net_out_speed': 204800, 'uptime': 86400,
            'load_1': 0.42, 'load_5': 0.38, 'load_15': 0.31,
            'tcp_conn_count': 25, 'udp_conn_count': 3, 'process_count': 132,
        },
    },
    {
        'id': 2, 'name': 'Frankfurt-01', 'country_code': 'DE', 'public_note': '',
        'host': {
            'platform': 'Debian GNU/Linux', 'platform_version': '12', 'arch': 'x86_64',
            'cpu': ['Intel Xeon Gold 6338'] * 8,
            'mem_total': 17179869184, 'swap_total': 0, 'disk_total': 214748364800,
            'virtualization': 'kvm', 'boot_time': 1750000000,
        },
        'state': {
            'cpu': 32.5, 'mem_used': 3221225472, 'disk_used': 32212254720,
            'net_in_transfer': 21474836480, 'net_out_transfer': 42949672960,
            'net_in_speed': 204800, 'net_out_speed': 409600, 'uptime': 172800,
            'load_1': 1.42, 'load_5': 1.38, 'load_15': 1.31,
            'tcp_conn_count': 125, 'udp_conn_count': 13, 'process_count': 232,
        },
    },
    {
        # 故意做一台「从未上报」的机器：last_active 是 Go 零值时间，前端应显示离线
        'id': 3, 'name': 'New-Node', 'country_code': '', 'public_note': '',
        'host': {'platform': 'Alpine Linux', 'arch': 'x86_64', 'cpu': ['Virtual CPU']},
        'state': {},
        'last_active': '0001-01-01T00:00:00Z',
    },
]

SERVICES = {
    '1': {
        'service_name': 'Tokyo → Cloudflare', 'current_up': 10, 'current_down': 1,
        'total_up': 240, 'total_down': 3, 'delay': [0] * 29 + [42.5],
        'up': [0] * 29 + [10], 'down': [0] * 29 + [1],
    },
    '2': {
        'service_name': 'Frankfurt → 1.1.1.1', 'current_up': 8, 'current_down': 2,
        'total_up': 200, 'total_down': 20, 'delay': [0] * 29 + [68.2],
        'up': [0] * 29 + [8], 'down': [0] * 29 + [2],
    },
}


def points_for(server_id, metric=None):
    """24 小时、5 分钟一个点（288 个）的假历史；metric 只影响起始值，形状一致。"""
    now = int(time.time())
    base = {'cpu': 10 + server_id * 5, 'memory': 1024 * 1024 * (800 + server_id * 100),
            'swap': 0, 'disk': 21474836480, 'net_in_speed': 1024 * server_id,
            'net_out_speed': 2048 * server_id, 'tcp_conn': 20 + server_id,
            'udp_conn': 2, 'process_count': 100 + server_id}.get(metric or 'cpu', 1)
    out = []
    for i in range(288):
        ts = (now - (287 - i) * 300) * 1000
        v = base + (i % 10) * (1 if metric != 'memory' else 1048576)
        out.append({'ts': ts, 'value': v})
    return out


def service_history(sid):
    sid = int(sid)
    now = int(time.time())
    servers = []
    for s in SERVERS[:2]:
        pts = []
        for i in range(288):
            ts = (now - (287 - i) * 300) * 1000
            # 每 97 个点塞一次失败，验证 status=0 不会被画成 0ms
            down = (i % 97) == 0 and s['id'] == 2
            pts.append({'ts': ts, 'delay': 0 if down else 20 + sid * 10 + (i % 5), 'status': 0 if down else 1})
        servers.append({
            'server_id': s['id'], 'server_name': s['name'],
            'stats': {
                'avg_delay': 22 + sid * 10,
                'up_percent': 97.5 if s['id'] == 1 else 90.0,
                'total_up': 280 if s['id'] == 1 else 240,
                'total_down': 8 if s['id'] == 1 else 48,
                'data_points': pts,
            },
        })
    return {
        'service_id': sid,
        'service_name': SERVICES[str(sid)]['service_name'] if str(sid) in SERVICES else f'#{sid}',
        'servers': servers,
    }


def server_services(server_id):
    now = int(time.time())
    out = []
    for sid in (1, 2):
        created = [(now - (59 - i) * 60) * 1000 for i in range(60)]
        delay = [20 + sid * 10 + (i % 7) for i in range(60)]
        # 第 30 个点模拟一次失败（0 延迟）
        delay[30] = 0
        out.append({
            'monitor_id': sid, 'monitor_name': SERVICES[str(sid)]['service_name'],
            'server_id': server_id, 'server_name': next((s['name'] for s in SERVERS if s['id'] == server_id), ''),
            'created_at': created, 'avg_delay': delay,
        })
    return out


CONFIG_JS = '''// mock/nezha.py 生成的测试配置（不是安装器产物）
export const GENERATED_AT = "mock";
export const SOURCE = "nezha";
export const HISTORY_DAYS = 1;
export const SITE_NAME = "Nezha Mock";
export const PROBES = {
  "1": { "name": "Tokyo → Cloudflare", "interval": 0 },
  "2": { "name": "Frankfurt → 1.1.1.1", "interval": 0 }
};
'''


def envelope(data):
    return {'success': True, 'data': data}


def ws_frame(payload, opcode=0x1):
    n = len(payload)
    if n < 126:
        head = bytes([0x80 | opcode, n])
    elif n < 65536:
        head = bytes([0x80 | opcode, 126]) + n.to_bytes(2, 'big')
    else:
        head = bytes([0x80 | opcode, 127]) + n.to_bytes(8, 'big')
    return head + payload


class H(http.server.SimpleHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def log_message(self, *a):
        pass

    def _json(self, obj, status=200):
        raw = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        self.send_header('content-type', 'application/json; charset=utf-8')
        self.send_header('content-length', str(len(raw)))
        self.send_header('cache-control', 'no-store')
        self.end_headers()
        self.wfile.write(raw)

    def _stream_servers(self):
        now_ms = int(time.time() * 1000)
        servers = []
        for s in SERVERS:
            item = {
                'id': s['id'], 'name': s['name'], 'country_code': s['country_code'],
                'public_note': s.get('public_note', ''),
                'last_active': s.get('last_active') or iso(2),
                'host': s['host'], 'state': s['state'],
            }
            servers.append(item)
        return {'now': now_ms, 'online': 3, 'servers': servers}

    def _ws_server(self):
        key = self.headers.get('Sec-WebSocket-Key', '')
        if not key or 'websocket' not in (self.headers.get('Upgrade') or '').lower():
            return self._json({'success': False, 'error': 'Require WebSocket upgrade'}, 400)
        accept = base64.b64encode(hashlib.sha1((key + WS_GUID).encode()).digest()).decode()
        self.send_response(101, 'Switching Protocols')
        self.send_header('Upgrade', 'websocket')
        self.send_header('Connection', 'Upgrade')
        self.send_header('Sec-WebSocket-Accept', accept)
        self.end_headers()
        self.close_connection = True
        self.connection.settimeout(0.2)
        try:
            for _ in range(300):
                body = json.dumps(self._stream_servers(), ensure_ascii=False).encode('utf-8')
                self.connection.sendall(ws_frame(body))
                deadline = time.time() + 2
                while time.time() < deadline:
                    try:
                        head = self.connection.recv(2)
                    except (TimeoutError, OSError):
                        break
                    if len(head) < 2:
                        return
                    opcode = head[0] & 0x0F
                    n = head[1] & 0x7F
                    if n == 126:
                        n = int.from_bytes(self.connection.recv(2), 'big')
                    elif n == 127:
                        n = int.from_bytes(self.connection.recv(8), 'big')
                    mask = self.connection.recv(4) if head[1] & 0x80 else b''
                    payload = self.connection.recv(n) if n else b''
                    if opcode == 0x8:
                        return
                    if opcode == 0x9 and mask:      # client ping → pong
                        self.connection.sendall(ws_frame(bytes(b ^ mask[i % 4] for i, b in enumerate(payload)), 0xA))
        except OSError:
            return
        finally:
            try:
                self.connection.close()
            except OSError:
                pass

    def _api(self, path):
        # 浏览器请求 /chicken/api/...；也兼容直接 /api/...
        # ⚠ 用 url.path 而不是 self.path：self.path 带 ?period=1d 之类的 query，
        # 直接 split('/') 会把最后一段变成 'service?period=1d'，详情接口全 404。
        u = urllib.parse.urlsplit(self.path)
        p = u.path
        p = p[len('/chicken'):] if p.startswith('/chicken/api/') else p
        q = urllib.parse.parse_qs(u.query)
        if p == '/api/v1/setting':
            # 真实 V2 的形状：model.Setting 内嵌 ConfigForGuests，字段是**扁平**的
            # （没有 config_for_guests 这一层）。旧版本文档里的嵌套形状不再作为主形状。
            return self._json(envelope({
                'config': {'site_name': 'Nezha Mock', 'language': 'zh-CN'},
                'tsdb_enabled': True,
            }))
        if p == '/api/v1/service':
            services = {} if os.environ.get('MOCK_EMPTY') == '1' else SERVICES
            return self._json(envelope({'services': services} if services else {}))
        if p == '/api/v1/ws/server':
            if os.environ.get('MOCK_NO_WS') == '1':
                return self._json({'success': False, 'error': 'mock: WS disabled'}, status=400)
            return self._ws_server()
        m = p.lstrip('/').split('/')
        if len(m) >= 4 and m[:3] == ['api', 'v1', 'server']:
            try:
                sid = int(m[3])
            except (TypeError, ValueError):
                sid = 1
            if len(m) >= 5 and m[4] == 'service':
                return self._json(envelope(server_services(sid)))
            if len(m) >= 5 and m[4] == 'metrics':
                metric = (q.get('metric') or ['cpu'])[0]
                return self._json(envelope({
                    'server_id': sid, 'server_name': '', 'metric': metric,
                    'data_points': points_for(sid, metric),
                }))
        if len(m) >= 5 and m[:3] == ['api', 'v1', 'service']:
            try:
                sid = int(m[3])
            except (TypeError, ValueError):
                sid = 1
            if m[4] == 'history':
                return self._json(envelope(service_history(sid)))
        return self._json({'success': False, 'error': 'not found'}, 404)

    def do_GET(self):
        if self.path.startswith('/chicken/api/') or self.path.startswith('/api/'):
            return self._api(self.path)
        if self.path == '/chicken/js/config.js':
            raw = CONFIG_JS.encode('utf-8')
            self.send_response(200)
            self.send_header('content-type', 'text/javascript; charset=utf-8')
            self.send_header('content-length', str(len(raw)))
            self.send_header('cache-control', 'no-store')
            self.end_headers()
            self.wfile.write(raw)
            return
        if self.path == '/' or self.path == '/chicken':
            self.path = '/chicken/'
        if self.path.startswith('/chicken/'):
            self.path = self.path[len('/chicken'):]
        return super().do_GET()


class TS(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


if __name__ == '__main__':
    with TS(('127.0.0.1', PORT), H) as httpd:
        print(f'serving mock Nezha on http://127.0.0.1:{PORT}/chicken/  (SOURCE=nezha)', flush=True)
        httpd.serve_forever()
