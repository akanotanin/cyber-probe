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
check('Komari：Host 用 $http_host（WS Origin 校验要带端口）',
      'proxy_set_header Host              $http_host;' in text)
check('Komari：不插哪吒的 WS 块', 'ws/server' not in text)

rc, out, err = run(base + ['--hub-port', '8008', '--source', 'nezha'])
text = site.read_text(encoding='utf-8')
check('哪吒：插 /farm/api/v1/ws/server', rc == 0 and 'location = /farm/api/v1/ws/server' in text,
      f'rc={rc} err={err!r}')
check('哪吒：全新插入不应误报 ws-host（不能越过块尾改 generic API 的 Host）',
      'ws-host' not in out, out)
check('哪吒：旧 Komari 块被替换（不会两家同时留着）', 'location = /farm/api/clients' not in text)
check('哪吒：proxy_pass 跟 --hub-port 走（8008）', '127.0.0.1:8008/api/v1/ws/server' in text)
check('哪吒：Host 用 $http_host（带端口，Origin 校验才不会 403）',
      'proxy_set_header Host              $http_host;' in text)

rc, out, err = run(base + ['--hub-port', '8008', '--source', 'nezha'])
check('哪吒：重跑幂等（SKIP）', 'SKIP' in out, f'rc={rc} out={out!r} err={err!r}')

rc, out, err = run([patch, '--local', '--no-reload', '--remove', '--conf', str(site),
                    '--ws-port', '28910', '--hub-port', '8008', '--webroot', '/srv/site',
                    '--path', '/farm', '--source', 'nezha'])
check('哪吒：贴→摘字节一致', rc == 0 and site.read_text(encoding='utf-8') == orig,
      f'rc={rc} err={err!r}')

# 老版本的哪吒块用 Host $host；非 80/443 端口会丢 :8080，哪吒 CheckOrigin 会 403。
# 重装时必须就地升级，不能因为「块已存在」就 SKIP 留下坏配置。
old_block = """    location = /farm/api/v1/ws/server {
        # cyber-probe：哪吒实时数据 WebSocket（卸载按这行认领）
        proxy_pass http://127.0.0.1:8008/api/v1/ws/server;
        proxy_http_version 1.1;
        proxy_set_header Upgrade    $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host              $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For   $remote_addr;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_buffering off;
        proxy_read_timeout 1h;
        proxy_send_timeout 1h;
    }

"""
site.write_text(orig.replace('    location / {', old_block + '    location / {'), encoding='utf-8')
rc, out, err = run(base + ['--hub-port', '8008', '--source', 'nezha'])
text = site.read_text(encoding='utf-8')
check('哪吒：旧 $host 块重装时就地升级为 $http_host',
      rc == 0 and 'proxy_set_header Host              $http_host;' in text and 'ws-host' in out,
      f'rc={rc} out={out!r} err={err!r}')

# 老 Komari 块同样的问题：$host 丢端口，Komari 的 WS Origin 校验会 403。
old_k_block = """    location = /farm/api/clients {
        # cyber-probe：Komari 实时数据 WebSocket（卸载按这行认领）
        proxy_pass http://127.0.0.1:25774/api/clients;
        proxy_http_version 1.1;
        proxy_set_header Upgrade    $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host              $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For   $remote_addr;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_buffering off;
        proxy_read_timeout 1h;
        proxy_send_timeout 1h;
    }

"""
ksite = tmp / 'komari-old.conf'
ksite.write_text(orig.replace('    location / {', old_k_block + '    location / {'), encoding='utf-8')
rc, out, err = run([patch, '--local', '--no-reload', '--conf', str(ksite),
                    '--ws-port', '28910', '--hub-port', '25774', '--webroot', '/srv/site',
                    '--path', '/farm', '--source', 'komari'])
kt = ksite.read_text(encoding='utf-8')
check('Komari：旧 $host 块重装时就地升级为 $http_host',
      rc == 0 and 'proxy_set_header Host              $http_host;' in kt and 'ws-host' in out,
      f'rc={rc} out={out!r} err={err!r}')

# 多 vhost + 换 hub 端口：目标 vhost 的 /api/ 块还指着旧端口 28080，不能因为按新端口
# 找不到就退化成全文件搜索、把块插进第一个 vhost（decoy）。
multi = tmp / 'multi.conf'
multi.write_text("""server {
    listen 80;
    server_name decoy.test;
    location / {
        proxy_pass http://127.0.0.1:9999;
    }
}
server {
    listen 80;
    server_name farm.test;
    location ^~ /farm/api/ {
        proxy_pass http://127.0.0.1:28080/api/;
    }
    location / {
        proxy_pass http://127.0.0.1:28080;
    }
}
""", encoding='utf-8')
rc, out, err = run([patch, '--local', '--no-reload', '--conf', str(multi),
                    '--ws-port', '28910', '--hub-port', '8008', '--webroot', '/srv/site',
                    '--path', '/farm', '--source', 'nezha'])
mt = multi.read_text(encoding='utf-8')
decoy, farm = mt.split('server_name farm.test;', 1)
check('多 vhost 换端口：WS/API/静态块只插进 farm.test，不碰 decoy',
      rc == 0 and 'location = /farm/api/v1/ws/server' not in decoy
      and 'location = /farm/api/v1/ws/server' in farm
      and 'alias /srv/site/' not in decoy and 'alias /srv/site/' in farm,
      f'rc={rc} out={out!r} err={err!r}')

# 域名模式：vhost.py 写自己的 server 块，哪吒的 exact location 是 /api/v1/ws/server。
vhost = str(ROOT / 'tools' / 'vhost.py')
rc, out, err = run([vhost, '--proxy', 'nginx', '--domain', 'farm.test', '--webroot', '/srv/site',
                    '--hub-port', '8008', '--source', 'nezha', '--dry-run'])
check('域名模式（哪吒）：vhost 带 /api/v1/ws/server',
      rc == 0 and 'location = /api/v1/ws/server' in out and '/api/clients' not in out,
      f'rc={rc} err={err!r}')
check('域名模式（哪吒）：/api/ 反代仍透传（不 strip 前缀）', 'proxy_pass http://127.0.0.1:8008/api/;' in out)
check('域名模式（哪吒）：WS 的 Host 也保留端口', 'proxy_set_header Host              $http_host;' in out)

rc, out, err = run([vhost, '--proxy', 'nginx', '--domain', 'farm.test', '--webroot', '/srv/site',
                    '--hub-port', '28080', '--dry-run'])
check('域名模式（默认 monitor）：仍插 Komari 的 /api/clients',
      rc == 0 and 'location = /api/clients' in out and 'ws/server' not in out,
      f'rc={rc} err={err!r}')
check('域名模式（默认 monitor）：Komari WS 的 Host 也保留端口',
      'proxy_set_header Host              $http_host;' in out)

print()
if fails:
    print('失败 %d 项：%s' % (len(fails), '，'.join(fails)))
    sys.exit(1)
print('全部通过')
