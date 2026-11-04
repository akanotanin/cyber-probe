#!/usr/bin/env python3
"""gen_config.py 的 Komari 分支回归测试（Windows / Linux 都能跑，不依赖真 Komari）。

覆盖：
  · --detect：靠 /api/public 的 theme/sitename 认出 Komari
  · --komari：从 /api/task/ping 生成 PROBES、从 record_preserve_time 生成 HISTORY_DAYS
  · 隐私：config.js 里不出现节点 UUID / 探测目标 / IP
  · 私有站点（status:error）/ 坏地址：明确失败，不写出半截文件
  · --stub --source komari：API 不可达时的空占位也标对数据源
"""
import http.server
import json
import pathlib
import socketserver
import subprocess
import sys
import tempfile
import threading

ROOT = pathlib.Path(__file__).resolve().parents[1]
GEN = ROOT / 'tools' / 'gen_config.py'
PY = sys.executable
fails = []


def check(name, cond, detail=''):
    print(('PASS  ' if cond else 'FAIL  ') + name + ('  ' + str(detail) if (detail and not cond) else ''))
    if not cond:
        fails.append(name)


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, status, obj):
        raw = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        self.send_header('content-type', 'application/json')
        self.send_header('content-length', str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        if self.server.private:
            return self._send(200, {'status': 'error', 'message': 'Private site is enabled, please login first.'})
        if self.path == '/api/public':
            return self._send(200, {'status': 'success', 'message': '', 'data': {
                'sitename': 'Komari 测试站', 'theme': 'default', 'record_preserve_time': 720,
            }})
        if self.path == '/api/nodes':
            return self._send(200, {'status': 'success', 'message': '', 'data': [
                {'uuid': '11111111-2222-3333-4444-555555555555', 'name': 'Tokyo'},
                {'uuid': 'aaaaaaaa-1111-2222-3333-444444444444', 'name': 'Frankfurt'},
            ]})
        if self.path == '/api/task/ping':
            return self._send(200, {'status': 'success', 'message': '', 'data': [
                {'id': 1, 'name': '东京 → Cloudflare', 'interval': 60,
                 'clients': ['11111111-2222-3333-4444-555555555555'], 'type': 'icmp'},
                {'id': 2, 'name': '大阪 → 备用节点', 'interval': 30, 'clients': [], 'type': 'http'},
            ]})
        return self._send(404, {'status': 'error', 'message': 'not found'})


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


def start(private=False):
    srv = Server(('127.0.0.1', 0), Handler)
    srv.private = private
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, f'http://127.0.0.1:{srv.server_address[1]}'


def run(args):
    return subprocess.run([PY, str(GEN)] + args, capture_output=True, text=True,
                          encoding='utf-8', errors='replace')


tmp = pathlib.Path(tempfile.mkdtemp(prefix='cp-komari-'))

srv, base = start()
r = run(['--detect', base])
check('--detect：认出 Komari', r.returncode == 0 and r.stdout.strip() == 'komari',
      f'rc={r.returncode} out={r.stdout!r} err={r.stderr!r}')

out = tmp / 'config.js'
r = run(['--komari', base, '--out', str(out)])
text = out.read_text(encoding='utf-8') if out.exists() else ''
check('--komari：退出码 0', r.returncode == 0, r.stderr)
check('--komari：SOURCE=komari', 'export const SOURCE = "komari";' in text)
check('--komari：HISTORY_DAYS 从 record_preserve_time 换算（720h→30 天）',
      'export const HISTORY_DAYS = 30;' in text, text[:400])
check('--komari：PROBES 带任务名与间隔', '"name": "东京 → Cloudflare"' in text and '"interval": 60' in text)
check('--komari：SITE_NAME 回退到 Komari sitename', 'export const SITE_NAME = "Komari 测试站";' in text)
check('--komari：隐私（不含节点 UUID / clients 列表）',
      '11111111-2222' not in text and 'clients' not in text)

# NPC 白名单：UUID → 与前端 makeNpcFor 相同的数字 id（不进公开 config.js）
allow = tmp / 'npcs-allow'
r = run(['--komari', base, '--out', str(tmp / 'c2.js'), '--npc-allow-out', str(allow)])
atext = allow.read_text(encoding='utf-8') if allow.exists() else ''
check('--npc-allow-out：白名单写出来了', r.returncode == 0 and allow.exists(), r.stderr)
check('--npc-allow-out：节点 UUID 的哈希与前端一致（n271278042 / n770746609）',
      'n271278042' in atext and 'n770746609' in atext, atext[:200])
check('--npc-allow-out：探测任务 t1/t2 也在白名单', 't1' in atext and 't2' in atext)
check('--npc-allow-out：白名单不含 UUID', '11111111-2222' not in atext)

# 私有站点：/api/public 也返回 status:error → 必须失败，不能写出空名单冒充成功
priv, pbase = start(private=True)
out2 = tmp / 'private.js'
r = run(['--komari', pbase, '--out', str(out2)])
check('私有站点：明确失败（非 0）', r.returncode != 0, f'rc={r.returncode}')
check('私有站点：不留下半截 config.js', not out2.exists() or out2.stat().st_size == 0)

# 坏地址 / 带凭据的地址：直接拒绝（凭据不该进命令行历史）
r = run(['--komari', 'ftp://127.0.0.1:1', '--out', str(tmp / 'x.js')])
check('非 http(s) 地址被拒（退出码 2，安装器必须直接失败）', r.returncode == 2, r.returncode)
r = run(['--komari', 'http://user:pass@127.0.0.1:1', '--out', str(tmp / 'x.js')])
check('带用户名/密码的地址被拒（退出码 2）', r.returncode == 2, r.returncode)
r = run(['--komari', 'http://127.0.0.1:1/api?x=1', '--out', str(tmp / 'x.js')])
check('带 query 的地址被拒（退出码 2）', r.returncode == 2, r.returncode)

# API 不可达时的空占位：安装器用这个兜底，SOURCE 必须仍是 komari
stub = tmp / 'stub.js'
r = run(['--stub', '--source', 'komari', '--out', str(stub)])
st = stub.read_text(encoding='utf-8') if stub.exists() else ''
check('--stub --source komari：退出码 0 且标对数据源', r.returncode == 0 and 'export const SOURCE = "komari";' in st)

# 真 Komari 的 /api/public 不在（随便 404）→ unknown，不能误判
r = run(['--detect', base + '/nope'])
check('--detect：非 Komari 返回 unknown', r.returncode == 0 and r.stdout.strip() == 'unknown', r.stdout)

srv.shutdown()
priv.shutdown()
print()
if fails:
    print('失败 %d 项：%s' % (len(fails), '，'.join(fails)))
    sys.exit(1)
print('全部通过')
