#!/usr/bin/env python3
"""本地自测用：静态伺服 cyber-probe，并把 /chicken/api/* 反代到真 hub（等价线上 nginx 的行为）。"""
import http.server, socketserver, urllib.request, urllib.error, os, sys, json

ROOT = os.environ.get('MOCK_ROOT') or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# 反代目标：默认没有，必须显式给 —— 这样公开仓库里不会写死任何人的 hub 地址。
#   MOCK_UPSTREAM=https://hub.example.com python mock/serve.py 8899
#   MOCK_ROOT=shots/remote-site MOCK_UPSTREAM=http://127.0.0.1:28081 python mock/serve.py 8899（测别处的实例）
UPSTREAM = os.environ.get('MOCK_UPSTREAM')
if not UPSTREAM:
    print('✗ 请用环境变量给出 hub 地址，例如：MOCK_UPSTREAM=https://hub.example.com python mock/serve.py 8899', file=sys.stderr)
    sys.exit(2)
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8899
MOCK_DIR = os.path.join(ROOT, 'mock')


class H(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def log_message(self, *a):
        pass

    def _proxy(self):
        url = UPSTREAM + self.path[len('/chicken'):]
        if os.environ.get('MOCK_API'):
            fn = os.path.join(MOCK_DIR, url.split('/api/')[-1].replace('/', '_').split('?')[0] + '.json')
            if os.path.exists(fn):
                body = open(fn, 'rb').read()
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
        try:
            req = urllib.request.Request(url, headers={'accept': 'application/json', 'User-Agent': 'cyber-probe-dev'})
            with urllib.request.urlopen(req, timeout=20) as r:
                body = r.read()
                self.send_response(r.status)
                self.send_header('Content-Type', r.headers.get('Content-Type', 'application/json'))
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)
        except urllib.error.HTTPError as e:
            self.send_response(e.code)
            self.end_headers()
        except Exception as e:
            self.send_response(502)
            self.end_headers()
            self.wfile.write(str(e).encode())

    def do_GET(self):
        if self.path.startswith('/chicken/api/'):
            return self._proxy()
        if self.path == '/' or self.path == '/chicken':
            self.path = '/index.html'
        elif self.path.startswith('/chicken/'):
            self.path = self.path[len('/chicken'):]
        return super().do_GET()


class TS(socketserver.ThreadingTCPServer):
    allow_reuse_address = True


if __name__ == '__main__':
    with TS(('127.0.0.1', PORT), H) as httpd:
        print(f'serving {ROOT} on http://127.0.0.1:{PORT}/chicken/  (api -> {UPSTREAM})', flush=True)
        httpd.serve_forever()
