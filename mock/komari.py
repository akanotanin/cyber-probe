#!/usr/bin/env python3
"""本地开发/浏览器自测用：静态伺服 cyber-probe，并伪造一套 Komari 公开 API。

不是 Komari 的替代品：只为验证「SOURCE=komari 时前端能不能把 Komari 的字段映射成鸡」。
实时指标走 HTTP 的 /api/recent/<uuid> 兜底（真正的 WebSocket /api/clients 在这里直接回 400，
前端会自动退到 recent 轮询）。

用法：
  python3 mock/komari.py 8898
  打开 http://127.0.0.1:8898/chicken/?debug&nomodels
"""
import datetime
import http.server
import json
import os
import socketserver
import sys
import urllib.parse

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8898


def iso(sec_ago=0):
    now = datetime.datetime.now(datetime.timezone.utc)
    return (now - datetime.timedelta(seconds=sec_ago)).isoformat(timespec='milliseconds').replace('+00:00', 'Z')


NODES = [
    {
        'uuid': 'aaaaaaaa-1111-2222-3333-444444444444',
        'name': 'Tokyo-01', 'cpu_name': 'AMD EPYC 7B13', 'virtualization': 'kvm',
        'arch': 'x86_64', 'cpu_cores': 4, 'os': 'Ubuntu 24.04', 'kernel_version': '6.8.0',
        'region': 'JP', 'public_remark': 'mock 东京节点',
        'mem_total': 8589934592, 'swap_total': 2147483648, 'disk_total': 107374182400,
    },
    {
        'uuid': 'bbbbbbbb-1111-2222-3333-444444444444',
        'name': 'Frankfurt-01', 'cpu_name': 'Intel Xeon Gold 6338', 'virtualization': 'kvm',
        'arch': 'x86_64', 'cpu_cores': 8, 'os': 'Debian GNU/Linux 12', 'kernel_version': '6.1.0',
        'region': 'DE', 'public_remark': '',
        'mem_total': 17179869184, 'swap_total': 0, 'disk_total': 214748364800,
    },
]


def report(i):
    n = NODES[i]
    return {
        'cpu': {'name': n['cpu_name'], 'cores': n['cpu_cores'], 'arch': n['arch'], 'usage': 12.5 + i * 20},
        'ram': {'total': n['mem_total'], 'used': 1073741824 + i * 2147483648},
        'swap': {'total': n['swap_total'], 'used': 0},
        'load': {'load1': 0.42 + i, 'load5': 0.38 + i, 'load15': 0.31 + i},
        'disk': {'total': n['disk_total'], 'used': 21474836480 + i * 10737418240},
        'network': {'up': 204800 + i, 'down': 102400 + i, 'totalUp': 10737418240, 'totalDown': 21474836480},
        'connections': {'tcp': 25 + i, 'udp': 3},
        'uptime': 86400 + i * 3600,
        'process': 132 + i,
        'updated_at': iso(2),
    }


def envelope(data):
    return {'status': 'success', 'message': '', 'data': data}


def ping_payload(uuid):
    task_id = 1 + (1 if uuid == NODES[1]['uuid'] else 0)
    return {
        'count': 3,
        'records': [
            {'task_id': task_id, 'time': iso(120), 'value': 22, 'client': uuid},
            {'task_id': task_id, 'time': iso(60), 'value': -1, 'client': uuid},
            {'task_id': task_id, 'time': iso(2), 'value': 31, 'client': uuid},
        ],
        'tasks': [{'id': task_id, 'name': 'Tokyo → Cloudflare' if task_id == 1 else 'Frankfurt → 1.1.1.1',
                   'type': 'icmp', 'interval': 60, 'default_on': True,
                   'loss': 33.33, 'min': 22, 'max': 31, 'avg': 26, 'total': 3}],
        'basic_info': [{'client': uuid, 'loss': 33.33, 'min': 22, 'max': 31}],
    }


def load_payload(uuid):
    i = 0 if uuid == NODES[0]['uuid'] else 1
    base = NODES[i]['mem_total']
    rows = []
    for k in range(6):
        rows.append({
            'client': uuid,
            'time': iso((5 - k) * 600),
            'cpu': 10 + k * 5 + i * 10,
            'ram': 1073741824 + k * 104857600,
            'ram_total': base,
            'swap': 0, 'swap_total': NODES[i]['swap_total'],
            'load': 0.1 * k, 'temp': 40,
            'disk': 21474836480, 'disk_total': NODES[i]['disk_total'],
            'net_in': 1024 * (k + 1), 'net_out': 2048 * (k + 1),
            'net_total_up': 10737418240, 'net_total_down': 21474836480,
            'process': 100 + k, 'connections': 20 + k, 'connections_udp': 2,
        })
    return {'records': rows, 'count': len(rows)}


CONFIG_JS = '''// mock/komari.py 生成的测试配置（不是安装器产物）
export const GENERATED_AT = "mock";
export const SOURCE = "komari";
export const HISTORY_DAYS = 7;
export const SITE_NAME = "Komari Mock";
export const PROBES = {
  "1": { "name": "Tokyo → Cloudflare", "interval": 60 },
  "2": { "name": "Frankfurt → 1.1.1.1", "interval": 60 }
};
'''


class H(http.server.SimpleHTTPRequestHandler):
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

    def _api(self, path):
        # 浏览器请求 /chicken/api/...；也兼容直接 /api/...
        p = path[len('/chicken'):] if path.startswith('/chicken/api/') else path
        if p == '/api/public':
            return self._json(envelope({
                'sitename': 'Komari Mock', 'description': 'mock', 'theme': 'default',
                'record_preserve_time': 168, 'ping_record_preserve_time': 168,
                'private_site': False,
            }))
        if p == '/api/nodes':
            return self._json(envelope(NODES))
        if p == '/api/task/ping':
            return self._json(envelope([
                {'id': 1, 'name': 'Tokyo → Cloudflare', 'type': 'icmp', 'interval': 60,
                 'default_on': True, 'clients': [NODES[0]['uuid']]},
                {'id': 2, 'name': 'Frankfurt → 1.1.1.1', 'type': 'icmp', 'interval': 60,
                 'default_on': True, 'clients': [NODES[1]['uuid']]},
            ]))
        if p.startswith('/api/recent/'):
            uuid = urllib.parse.unquote(p.rsplit('/', 1)[-1])
            i = next((k for k, n in enumerate(NODES) if n['uuid'] == uuid), -1)
            return self._json(envelope([report(i)] if i >= 0 else []))
        if p.startswith('/api/records/ping'):
            q = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query)
            uuid = (q.get('uuid') or [''])[0]
            return self._json(envelope(ping_payload(uuid)))
        if p.startswith('/api/records/load'):
            q = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query)
            uuid = (q.get('uuid') or [''])[0]
            return self._json(envelope(load_payload(uuid)))
        if p == '/api/clients':
            # 真 Komari 这里是 WebSocket；mock 故意回 400，让前端走 /api/recent 兜底。
            return self._json({'status': 'error', 'message': 'Require WebSocket upgrade'}, 400)
        return self._json({'status': 'error', 'message': 'not found'}, 404)

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
        print(f'serving mock Komari on http://127.0.0.1:{PORT}/chicken/  (SOURCE=komari)', flush=True)
        httpd.serve_forever()
