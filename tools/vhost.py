#!/usr/bin/env python3
"""给 cyber-probe 装一个「独立域名的站点」（而不是挂在别人站点的 /chicken/ 子路径下）。

和 nginx_patch.py / caddy_patch.py 的区别：
  · 那两个是**往已有站点里插 location**（路径模式，默认 /chicken/）
  · 这个是**自己写一个完整的 server / site 块**（域名模式，挂在 / 根路径）
    自己写的文件由安装器全权拥有：删文件即卸载，不用去改别人的配置。

用法:
  python3 vhost.py --proxy nginx --domain farm.example.com --webroot /var/www/cyber-probe \
                   --ws-port 28910 --hub-port 28080
  python3 vhost.py --proxy caddy --domain farm.example.com --webroot ... 
  python3 vhost.py --proxy nginx --remove --domain farm.example.com
  python3 vhost.py ... --no-reload        # 只写文件，不做 nginx -t / reload（自测用）

nginx：写 /etc/nginx/conf.d/cyber-probe-<slug>.conf（conf.d/*.conf 自动被 include）
       —— 证书要自己签：写完会打印 certbot 命令，不替你跑（ACME 失败率高，得看得见输出）。
Caddy：写 /etc/caddy/conf.d/cyber-probe-<slug>.caddy，并在 Caddyfile 末尾加一行顶层 import
       —— Caddy 会自己申请证书。
"""
import argparse
import base64
import os
import re
import shlex
import shutil
import subprocess
import sys
from datetime import datetime

NGINX_DIR = '/etc/nginx/conf.d'
CADDY_CONF = '/etc/caddy/Caddyfile'
CADDY_DIR = '/etc/caddy/conf.d'


def run(cmd, check=True):
    p = subprocess.run(['bash', '-c', cmd], capture_output=True, text=True)
    out = (p.stdout or '').strip()
    err = (p.stderr or '').strip()
    if check and p.returncode != 0:
        print(err or out, file=sys.stderr)
        sys.exit(p.returncode)
    return p.returncode, out, err


def slug(domain):
    return re.sub(r'[^A-Za-z0-9.-]', '-', domain).strip('-')


def nginx_body(a):
    host = a.domain
    return f"""# cyber-probe —— 「{host}」的独立站点（由安装器生成，勿手改）
# 静态站直接由 nginx 发，/api/ 与 /ws 反代到 hub 与联机服。
server {{
    listen 80;
    listen [::]:80;
    server_name {host};

    root {a.webroot};
    index index.html;
    charset utf-8;

    # 探针数据（同源，避免 CORS）：/api/xxx → hub 的 /api/xxx
    location ^~ /api/ {{
        proxy_pass http://127.0.0.1:{a.hub_port}/api/;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For   $remote_addr;
        proxy_set_header X-Real-IP         $remote_addr;
        add_header Cache-Control "no-store" always;
    }}

    # 内置后台（hub 的 /admin）：前台首页那枚 ⚙ 入口指的就是这里。
    # 不想让公网点进后台，就在这个块里加来源白名单（allow ...; deny all;）。
    location ^~ /admin {{
        proxy_pass http://127.0.0.1:{a.hub_port};
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For   $remote_addr;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_buffering off;
        proxy_read_timeout 1h;
        proxy_send_timeout 1h;
    }}

    # 联机游戏服（WebSocket）
    location = /ws {{
        proxy_pass http://127.0.0.1:{a.ws_port};
        proxy_http_version 1.1;
        proxy_set_header Upgrade    $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host              $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For   $remote_addr;
        proxy_set_header X-Real-IP         $remote_addr;
        # 访客鸡的国旗 = 访客 IP 所在地（Cloudflare 橙云时会带这个头）
        proxy_set_header CF-IPCountry      $http_cf_ipcountry;
        proxy_buffering off;
        proxy_read_timeout 1h;
        proxy_send_timeout 1h;
    }}

    # 静态资源：带版本号查不到就回 index（单页，没有路由，404 也无所谓）
    location / {{
        try_files $uri $uri/ =404;
        add_header Cache-Control "no-cache" always;
    }}
}}
"""


def caddy_body(a):
    host = a.domain
    # ⚠ /api 不能 strip：hub 自己就伺服在 /api/xxx 下（nginx 分支与 mock 都是直接透传整条路径）。
    #   以前这里写了 `uri strip_prefix /api`，GET /api/nodes 到 hub 变成 GET /nodes → 面板接口全 404。
    return f"""# cyber-probe —— 「{host}」的独立站点（由安装器生成，勿手改）
{host} {{
\thandle /api/* {{
\t\treverse_proxy 127.0.0.1:{a.hub_port}
\t}}
\thandle /admin* {{
\t\treverse_proxy 127.0.0.1:{a.hub_port}
\t}}
\thandle /ws {{
\t\treverse_proxy 127.0.0.1:{a.ws_port}
\t}}
\thandle {{
\t\troot * {a.webroot}
\t\tfile_server
\t}}
}}
"""


def atomic_write(path, text):
    """同目录临时文件 + os.replace：崩溃/磁盘满不会留下半截配置。newline='' 不翻译换行。"""
    tmp = path + '.tmp-cyberprobe'
    with open(tmp, 'w', encoding='utf-8', newline='') as f:
        f.write(text)
    os.replace(tmp, path)


def main():
    ap = argparse.ArgumentParser(add_help=True)
    ap.add_argument('--proxy', choices=['nginx', 'caddy'], required=True)
    ap.add_argument('--domain', required=True)
    ap.add_argument('--webroot', default='/var/www/cyber-probe')
    ap.add_argument('--ws-port', default='28910')
    ap.add_argument('--hub-port', default='28080')
    ap.add_argument('--conf', default='')          # nginx: conf.d 目录；caddy: Caddyfile
    ap.add_argument('--remove', action='store_true')
    ap.add_argument('--no-reload', action='store_true')
    ap.add_argument('--dry-run', action='store_true')
    a = ap.parse_args()

    if not re.match(r'^[A-Za-z0-9.-]+$', a.domain):
        print(f'✗ 域名不合法：{a.domain!r}', file=sys.stderr)
        return 2
    tag = f'cyber-probe-{slug(a.domain)}'

    if a.proxy == 'nginx':
        d = a.conf or NGINX_DIR
        path = os.path.join(d, tag + '.conf')
        body = nginx_body(a)
        validate = 'nginx -t'
        reload_cmd = 'systemctl is-active --quiet nginx && systemctl reload nginx || echo "（nginx 没在跑，配置已写好，下次启动生效）"'
    else:
        # --conf 的语义按帮助来：Caddy 这边给的是 **Caddyfile 路径**（不是目录）。
        # 兼容旧用法：给一个已存在的目录时仍当目录（片段写进去，顶层 Caddyfile 用默认）。
        caddy_conf = CADDY_CONF
        if a.conf and not os.path.isdir(a.conf):
            caddy_conf = a.conf
        d = os.path.dirname(caddy_conf) if a.conf and not os.path.isdir(a.conf) else (a.conf or CADDY_DIR)
        path = os.path.join(d, tag + '.caddy')
        body = caddy_body(a)
        validate = 'caddy validate --config ' + shlex.quote(caddy_conf)
        reload_cmd = 'systemctl is-active --quiet caddy && systemctl reload caddy || echo "（caddy 没在跑，配置已写好，下次启动生效）"'

    print(f'· 目标文件 {path}')
    if a.dry_run:
        print(body)
        print('（--dry-run：没有落盘）')
        return 0

    stamp = datetime.now().strftime('%Y%m%d-%H%M%S')

    if a.remove:
        removed, tmp_moved, caddy_bak = [], None, None
        if os.path.exists(path):
            # 先挪到 .rm-<stamp>：校验不过就挪回来。以前是直接 unlink —— 卸载把配置改坏了
            # 连站点文件都没了（2026-11-03 修）。
            tmp_moved = path + '.rm-' + stamp
            os.replace(path, tmp_moved)
            removed.append(path)
        if a.proxy == 'caddy' and os.path.exists(caddy_conf):
            src = open(caddy_conf, encoding='utf-8').read()
            line = 'import ' + path
            if line in src:
                caddy_bak = caddy_conf + '.bak-' + stamp + '-rm'     # 卸载前先备份 Caddyfile
                shutil.copy2(caddy_conf, caddy_bak)
                src = src.replace(line + '\n', '').replace(line, '')
                atomic_write(caddy_conf, src)
                removed.append(caddy_conf + ' 的 import 行')
        if not removed:
            print('SKIP  没有找到这个域名的站点文件（可能本来就没装）')
            return 0
        print('REMOVED  ' + '；'.join(removed))
        if not a.no_reload:
            code, out, err = run(validate, check=False)
            if code != 0:
                # 卸载同样要回滚：绝不把别人的 web 服务留在坏配置上
                if caddy_bak:
                    shutil.copy2(caddy_bak, caddy_conf)
                if tmp_moved:
                    os.replace(tmp_moved, path)
                print((out + '\n' + err).strip(), file=sys.stderr)
                print('✗ 配置校验没过 → 已取消卸载并回滚', file=sys.stderr)
                return 4
            run(reload_cmd, check=False)
        if tmp_moved:
            os.unlink(tmp_moved)
        for f in os.listdir(d) if os.path.isdir(d) else []:      # 校验通过后才清自己留的备份
            if f.startswith(tag + '.') and '.bak-' in f:
                os.unlink(os.path.join(d, f))
        print('已移除（TLS 证书不删，需要的话自己 certbot delete）')
        return 0

    os.makedirs(d, exist_ok=True)
    bak = None
    if os.path.exists(path):
        bak = path + '.bak-' + stamp
        shutil.copy2(path, bak)
    atomic_write(path, body)
    print('  写好站点文件')

    if a.proxy == 'caddy' and os.path.exists(caddy_conf):
        src = open(caddy_conf, encoding='utf-8').read()
        line = 'import ' + path
        if line not in src:
            if not src.endswith('\n'):
                src += '\n'
            src += f'\n# cyber-probe 独立站点（{a.domain}）\n{line}\n'
            sbak = caddy_conf + '.bak-' + stamp
            shutil.copy2(caddy_conf, sbak)
            atomic_write(caddy_conf, src)
            print(f'  Caddyfile 加了一行顶层 import（备份 {sbak}）')
        else:
            print('  Caddyfile 已有 import 行（幂等）')

    if a.no_reload:
        print('（--no-reload：没有做语法检查，也没 reload）')
        return 0
    code, out, err = run(validate, check=False)
    print((out + '\n' + err).strip())
    if code != 0:
        # 校验失败 → 回滚，绝不把别人的 web 服务留在坏配置上
        if bak and os.path.exists(bak):
            shutil.copy2(bak, path)
        else:
            os.unlink(path)
        print('✗ 配置校验没过 → 已回滚', file=sys.stderr)
        return 4
    run(reload_cmd, check=False)
    print('  配置已生效')
    if a.proxy == 'nginx':
        print('\n下一步（给这个域名签证书，二选一）：')
        print(f'  certbot --nginx -d {a.domain}          # 已有 certbot')
        print(f'  # 或者在 Cloudflare 开橙云，源站用 CF 的 15 年证书')
    return 0


if __name__ == '__main__':
    sys.exit(main())
