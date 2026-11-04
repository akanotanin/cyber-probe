#!/usr/bin/env python3
"""gen_config.py 的哪吒（Nezha）分支回归测试（Windows / Linux 都能跑，不依赖真哪吒）。

覆盖：
  · --detect：靠 /api/v1/setting 的 config.config_for_guests 认出 Nezha
  · --nezha：从 /api/v1/service 生成 PROBES、站名、HISTORY_DAYS=1（游客只能查 1d）
  · NPC 白名单：用 /api/v1/ws/server 的节点 id 生成 n<id>（不是 UUID 哈希），任务 t<id> 也在
  · 隐私：config.js 里不出现节点名 / IP / 探测目标
  · WS 不可用时：仍写 config.js（网站鸡可用），但不写半截白名单
  · 坏地址：明确失败（退出码 2），不写出半截文件
  · --stub --source nezha：API 不可达时的空占位也标对数据源
"""
import http.server
import json
import os
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

# Windows 的默认控制台是 GBK：断言里的中文/替换字符可能编不出来。统一按 UTF-8 打印
# （Linux/CI 本来就是 UTF-8），避免测试自己因为 print 挂掉。
try:
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')
except Exception:
    pass

# 直接用仓库里的 mock/nezha.py：它已经实现了 /api/v1/ws/server 的握手与推送。
sys.path.insert(0, str(ROOT / 'mock'))
import nezha as mock  # noqa: E402


def check(name, cond, detail=''):
    print(('PASS  ' if cond else 'FAIL  ') + name + ('  ' + str(detail) if (detail and not cond) else ''))
    if not cond:
        fails.append(name)


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


def start_server(handler):
    srv = Server(('127.0.0.1', 0), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, f'http://127.0.0.1:{srv.server_address[1]}'


def run(args):
    # 用临时文件而不是管道收输出：某些 Windows 沙箱会拒 CreatePipe（WinError 5），
    # 而 CI/服务器是 Linux —— 两种环境都能跑。
    fd_o, po = tempfile.mkstemp(prefix='cp-nezha-', suffix='.out')
    fd_e, pe = tempfile.mkstemp(prefix='cp-nezha-', suffix='.err')
    os.close(fd_o)
    os.close(fd_e)
    try:
        with open(po, 'w', encoding='utf-8') as fo, open(pe, 'w', encoding='utf-8') as fe:
            p = subprocess.run([PY, str(GEN)] + args, stdout=fo, stderr=fe)
        out = pathlib.Path(po).read_text(encoding='utf-8', errors='replace')
        err = pathlib.Path(pe).read_text(encoding='utf-8', errors='replace')
        return subprocess.CompletedProcess(p.args, p.returncode, out, err)
    finally:
        for f in (po, pe):
            try:
                os.unlink(f)
            except OSError:
                pass


tmp = ROOT / 'build' / 'ci' / ('nezha-config-%d' % os.getpid())
tmp.mkdir(parents=True, exist_ok=True)

srv, base = start_server(mock.H)

r = run(['--detect', base])
check('--detect：认出 Nezha', r.returncode == 0 and r.stdout.strip() == 'nezha',
      f'rc={r.returncode} out={r.stdout!r} err={r.stderr!r}')

out = tmp / 'config.js'
r = run(['--nezha', base, '--out', str(out)])
text = out.read_text(encoding='utf-8') if out.exists() else ''
check('--nezha：退出码 0', r.returncode == 0, r.stderr)
check('--nezha：SOURCE=nezha', 'export const SOURCE = "nezha";' in text)
check('--nezha：HISTORY_DAYS=1（游客只能查 1d）', 'export const HISTORY_DAYS = 1;' in text, text[:400])
check('--nezha：PROBES 带服务名、interval 不编造（0）',
      '"name": "Tokyo → Cloudflare"' in text and '"interval": 0' in text)
check('--nezha：SITE_NAME 回退到哪吒 config_for_guests.site_name',
      'export const SITE_NAME = "Nezha Mock";' in text)
check('--nezha：隐私（不含节点名 / target 字段；服务名本身是公开的）',
      'Tokyo-01' not in text and 'Frankfurt-01' not in text and '127.0.0.1' not in text
      and '"target"' not in text and '"host"' not in text and 'Cloudflare' in text, text[:500])

allow = tmp / 'npcs-allow'
out2 = tmp / 'config2.js'
r = run(['--nezha', base, '--out', str(out2), '--npc-allow-out', str(allow)])
atext = allow.read_text(encoding='utf-8') if allow.exists() else ''
check('--npc-allow-out：白名单写出来了', r.returncode == 0 and allow.exists(), r.stderr)
check('--npc-allow-out：节点 id 直接用哪吒的 n1/n2/n3（不做 UUID 哈希）',
      all(k in atext for k in ('n1', 'n2', 'n3')), atext[:300])
check('--npc-allow-out：服务监控 t1/t2 也在白名单', 't1' in atext and 't2' in atext)
check('--npc-allow-out：白名单不含节点名/IP', 'Tokyo-01' not in atext and '127.0.0.1' not in atext)

# 反代只放行了 REST、没配 WebSocket：节点 id 拿不到。此时**不能**只写 t 部分
# （会让所有探针鸡被白名单挡掉），宁可不写、退回“相信客户端名单”。
class RestOnly(http.server.BaseHTTPRequestHandler):
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
        if self.path.startswith('/api/v1/setting'):
            return self._send(200, {'success': True, 'data': {
                'config': {'config_for_guests': {'site_name': 'REST only'}}, 'tsdb_enabled': False}})
        if self.path.startswith('/api/v1/service'):
            return self._send(200, {'success': True, 'data': {'services': {
                '1': {'service_name': 'Web', 'current_up': 1, 'current_down': 0},
            }}})
        if self.path.startswith('/api/v1/ws/server'):
            return self._send(400, {'success': False, 'error': 'Require WebSocket upgrade'})
        return self._send(404, {'success': False, 'error': 'not found'})


rest, rbase = start_server(RestOnly)
out3 = tmp / 'rest.js'
allow3 = tmp / 'rest-allow'
r = run(['--nezha', rbase, '--out', str(out3), '--npc-allow-out', str(allow3)])
text3 = out3.read_text(encoding='utf-8') if out3.exists() else ''
check('WS 不可用：仍写出 config.js（网站鸡照常）',
      r.returncode == 0 and 'export const SOURCE = "nezha";' in text3, r.stderr)
check('WS 不可用：不写半截白名单（否则探针鸡全被挡）', not allow3.exists(),
      allow3.read_text(encoding='utf-8') if allow3.exists() else '')
check('WS 不可用：stderr 有可读告警', 'NPC' in r.stderr or 'ws/server' in r.stderr, r.stderr)

# 老版本（V1 风格）没有 /api/v1/setting，但 /api/v1/service 还是那个形状：
# --detect 不能因此判成 unknown，--nezha 也要能写出服务清单（站名/TSDB 用默认值）。
class V1Only(RestOnly):
    def do_GET(self):
        if self.path.startswith('/api/v1/setting'):
            return self._send(404, {'success': False, 'error': 'not found'})
        return super().do_GET()


v1, v1base = start_server(V1Only)
r = run(['--detect', v1base])
check('--detect：setting 404 但 /service 形状对 → 仍认出哪吒（V1 兼容）',
      r.returncode == 0 and r.stdout.strip() == 'nezha', f'rc={r.returncode} out={r.stdout!r}')
out_v1 = tmp / 'v1.js'
r = run(['--nezha', v1base, '--out', str(out_v1)])
text_v1 = out_v1.read_text(encoding='utf-8') if out_v1.exists() else ''
check('--nezha：setting 读不到也照写服务清单（站名用默认值）',
      r.returncode == 0 and 'export const SOURCE = "nezha";' in text_v1
      and 'export const SITE_NAME = "";' in text_v1, f'rc={r.returncode} err={r.stderr!r}')
v1.shutdown()

# 坏地址 / 带凭据的地址：直接拒绝（凭据不该进命令行历史）
for bad in ('ftp://127.0.0.1:1', 'http://user:pass@127.0.0.1:1', 'http://127.0.0.1:1/api?x=1'):
    r = run(['--nezha', bad, '--out', str(tmp / 'x.js')])
    check(f'非法地址被拒（退出码 2）：{bad}', r.returncode == 2, f'rc={r.returncode}')

# --source 只接受三种；未知值由 argparse 拒绝
r = run(['--stub', '--source', 'prometheus', '--out', str(tmp / 'x.js')])
check('--source 不接受未知数据源', r.returncode == 2, f'rc={r.returncode}')

stub = tmp / 'stub.js'
r = run(['--stub', '--source', 'nezha', '--out', str(stub)])
st = stub.read_text(encoding='utf-8') if stub.exists() else ''
check('--stub --source nezha：退出码 0 且标对数据源',
      r.returncode == 0 and 'export const SOURCE = "nezha";' in st)

# 真 Komari / 随便一个 404 的地址：不能误判成 Nezha
r = run(['--detect', base + '/nope'])
check('--detect：非 Nezha 返回 unknown', r.returncode == 0 and r.stdout.strip() == 'unknown', r.stdout)

# 405/404 的 WS 不能把 --detect 弄挂（setting 也不存在）
r = run(['--detect', 'http://127.0.0.1:1'])
check('--detect：连不上返回 unknown 而不是 traceback', r.returncode == 0 and r.stdout.strip() == 'unknown',
      f'rc={r.returncode} err={r.stderr!r}')

srv.shutdown()
rest.shutdown()
print()
if fails:
    print('失败 %d 项：%s' % (len(fails), '，'.join(fails)))
    sys.exit(1)
print('全部通过')
