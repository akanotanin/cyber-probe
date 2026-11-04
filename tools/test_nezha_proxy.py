#!/usr/bin/env python3
"""哪吒数据源的反代补丁回归（nginx path / nginx domain）。

覆盖：
  · path 模式：哪吒的 WebSocket 是 /api/v1/ws/server（不是 Komari 的 /api/clients）
  · 换源：先按 Komari 装、再按哪吒装 → 旧 Komari 块被替换，只留哪吒块且端口跟着变
  · 幂等：同一数据源重跑 SKIP
  · 卸载：贴→摘字节一致（换源后也一样）
  · 域名模式：vhost 里出现 = /api/v1/ws/server，默认 monitor 仍是 /api/clients
"""
import os
import pathlib
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
PY = sys.executable
fails = []


def check(name, cond, detail=''):
    print(('PASS  ' if cond else 'FAIL  ') + name + ('  ' + str(detail) if (detail and not cond) else ''))
    if not cond:
        fails.append(name)


def run(args):
    """跑工具并把 stdout/stderr 收进临时文件（Windows 沙箱会拒绝 CreatePipe）。"""
    fd_o, po = tempfile.mkstemp(prefix='cp-nzproxy-', suffix='.out')
    fd_e, pe = tempfile.mkstemp(prefix='cp-nzproxy-', suffix='.err')
    os.close(fd_o)
    os.close(fd_e)
    try:
        with open(po, 'w', encoding='utf-8') as fo, open(pe, 'w', encoding='utf-8') as fe:
            p = subprocess.run([PY] + args, stdout=fo, stderr=fe)
        out = pathlib.Path(po).read_text(encoding='utf-8', errors='replace')
        err = pathlib.Path(pe).read_text(encoding='utf-8', errors='replace')
    finally:
        for f in (po, pe):
            try:
                os.unlink(f)
            except OSError:
                pass
    return p.returncode, out, err


tmp = ROOT / 'build' / 'ci' / ('nezha-proxy-%d' % os.getpid())
tmp.mkdir(parents=True, exist_ok=True)
site = tmp / 'site.conf'
site.write_text("""server {
    listen 443 ssl;
    server_name t.test;
    location / {
        proxy_pass http://127.0.0.1:28080;
    }
}
""", encoding='utf-8')
orig = site.read_text(encoding='utf-8')

patch = str(ROOT / 'tools' / 'nginx_patch.py')
base = [patch, '--local', '--no-reload', '--conf', str(site), '--ws-port', '28910',
        '--webroot', '/srv/site', '--path', '/farm']

rc, out, err = run(base + ['--hub-port', '28080', '--source', 'komari'])
text = site.read_text(encoding='utf-8')
check('Komari：插 /farm/api/clients', rc == 0 and 'location = /farm/api/clients' in text,
      f'rc={rc} err={err!r}')
check('Komari：不插哪吒的 WS 块', 'ws/server' not in text)

rc, out, err = run(base + ['--hub-port', '8008', '--source', 'nezha'])
text = site.read_text(encoding='utf-8')
check('哪吒：插 /farm/api/v1/ws/server', rc == 0 and 'location = /farm/api/v1/ws/server' in text,
      f'rc={rc} err={err!r}')
check('哪吒：旧 Komari 块被替换（不会两家同时留着）', 'location = /farm/api/clients' not in text)
check('哪吒：proxy_pass 跟 --hub-port 走（8008）', '127.0.0.1:8008/api/v1/ws/server' in text)

rc, out, err = run(base + ['--hub-port', '8008', '--source', 'nezha'])
check('哪吒：重跑幂等（SKIP）', 'SKIP' in out, f'rc={rc} out={out!r} err={err!r}')

rc, out, err = run([patch, '--local', '--no-reload', '--remove', '--conf', str(site),
                    '--ws-port', '28910', '--hub-port', '8008', '--webroot', '/srv/site',
                    '--path', '/farm', '--source', 'nezha'])
check('哪吒：贴→摘字节一致', rc == 0 and site.read_text(encoding='utf-8') == orig,
      f'rc={rc} err={err!r}')

# 域名模式：vhost.py 写自己的 server 块，哪吒的 exact location 是 /api/v1/ws/server。
vhost = str(ROOT / 'tools' / 'vhost.py')
rc, out, err = run([vhost, '--proxy', 'nginx', '--domain', 'farm.test', '--webroot', '/srv/site',
                    '--hub-port', '8008', '--source', 'nezha', '--dry-run'])
check('域名模式（哪吒）：vhost 带 /api/v1/ws/server',
      rc == 0 and 'location = /api/v1/ws/server' in out and '/api/clients' not in out,
      f'rc={rc} err={err!r}')
check('域名模式（哪吒）：/api/ 反代仍透传（不 strip 前缀）', 'proxy_pass http://127.0.0.1:8008/api/;' in out)

rc, out, err = run([vhost, '--proxy', 'nginx', '--domain', 'farm.test', '--webroot', '/srv/site',
                    '--hub-port', '28080', '--dry-run'])
check('域名模式（默认 monitor）：仍插 Komari 的 /api/clients',
      rc == 0 and 'location = /api/clients' in out and 'ws/server' not in out,
      f'rc={rc} err={err!r}')

print()
if fails:
    print('失败 %d 项：%s' % (len(fails), '，'.join(fails)))
    sys.exit(1)
print('全部通过')
