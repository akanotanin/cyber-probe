#!/usr/bin/env python3
"""2026-11-04 第三轮复审新增回归（安装脚本 + 反代补丁器）。

覆盖（都是本机可复现的，不需要真的 nginx / caddy）：
  ① caddy_patch：`--domain example.com` 不能因为前面的 www.example.com 等子串而插错 vhost
  ② caddy_patch：站点块用 localhost / [::1] 时兜底也能找到（不能只认 127.0.0.1）
  ③ caddy_patch：片段已丢失 + import 残留时，--remove 也要先备份、可回滚（不能裸写）
  ④ vhost(caddy)：卸载要把自己加的标记注释和空行一起摘掉（Caddyfile 字节还原）
  ⑤ vhost(nginx)：重装要保留 certbot 的 listen [::]:443 TLS 行（IPv6）
  ⑥ nginx_patch：卸载不能重排用户自己的连续空行；CRLF 配置不能被悄悄改成 LF
  ⑦ gen_config：IPv6 目标（[2606:...]:443）也要能解析出地址，别永远显示 🌐
  ⑧ 安装器：Caddyfile 的 `{` 单独一行时也要认得出站点域名；--proxy caddy 缺 Caddyfile 要提前报错
"""
import os
import pathlib
import re
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
PY = sys.executable
NGX = ROOT / 'tools' / 'nginx_patch.py'
CAD = ROOT / 'tools' / 'caddy_patch.py'
VHOST = ROOT / 'tools' / 'vhost.py'
HDR = ROOT / 'tools' / 'run_header.sh'
fails = []


def check(name, cond, detail=''):
    print(('PASS  ' if cond else 'FAIL  ') + name + ('  ' + detail if (detail and not cond) else ''))
    if not cond:
        fails.append(name)


def write_noeol(path, text):
    """原样写（不翻译换行）。⚠ 不用 Path.write_text(newline=)：那个参数 3.10 才有。"""
    path = pathlib.Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, 'w', encoding='utf-8', newline='') as f:
        f.write(text)


def read_raw(path):
    with open(path, encoding='utf-8', newline='') as f:
        return f.read()


def run(args):
    # stdin=DEVNULL：MSYS 的 bash 在纯管道 stdin 下偶尔起不来（本机沙箱），与本项目无关
    return subprocess.run([PY] + [str(a) for a in args],
                          capture_output=True, text=True, encoding='utf-8', errors='replace',
                          stdin=subprocess.DEVNULL)


TMP = pathlib.Path(tempfile.mkdtemp(prefix='cp-r3-'))


def caddy_add(conf, snip, domain, hub_port='28080', path='/chicken'):
    return run([CAD, '--local', '--no-reload', '--conf', conf, '--snippet', snip,
                '--domain', domain, '--hub-port', hub_port, '--ws-port', '28910',
                '--webroot', '/srv/site', '--path', path])


def caddy_rm(conf, snip, extra=()):
    return run([CAD, '--local', '--remove', '--conf', conf, '--snippet', snip,
                '--ws-port', '28910', '--hub-port', '28080', '--webroot', '/srv/site',
                '--path', '/chicken'] + list(extra))


# ---- ① 域名精确匹配：前面的 www.example.com 不能抢走 import ----
d1 = TMP / 'match'
conf1 = d1 / 'Caddyfile'
snip1 = d1 / 'conf.d' / 'cyber-probe.caddy'
write_noeol(conf1,
            'www.example.com {\n\treverse_proxy 127.0.0.1:9999\n}\n\n'
            'example.com {\n\treverse_proxy 127.0.0.1:28080\n}\n')
r = caddy_add(conf1, snip1, 'example.com')
out1 = read_raw(conf1)
www_end = out1.find('}\n', out1.find('www.example.com'))
ex_pos = out1.find('\nexample.com {')
imp = out1.find('import ' + str(snip1))
check('caddy_patch：--domain 精确命中 example.com 块（不是 www 子串）',
      r.returncode == 0 and imp > ex_pos > www_end,
      'rc=%s www_end=%s ex=%s imp=%s\n%s' % (r.returncode, www_end, ex_pos, imp, out1))

# 同义写法：https://example.com:443 也要能精确命中（有 scheme / 端口）
d1b = TMP / 'match-scheme'
conf1b = d1b / 'Caddyfile'
snip1b = d1b / 'conf.d' / 'cyber-probe.caddy'
write_noeol(conf1b,
            'www.example.com {\n\treverse_proxy 127.0.0.1:9999\n}\n\n'
            'https://example.com:443 {\n\treverse_proxy 127.0.0.1:9999\n}\n')
r = caddy_add(conf1b, snip1b, 'example.com')
out1b = read_raw(conf1b)
check('caddy_patch：带 scheme/端口的站点地址也能精确命中',
      r.returncode == 0 and ('https://example.com:443 {\n\timport ' in out1b),
      r.stdout + r.stderr + out1b)

# ---- ② localhost / [::1] 上游兜底 ----
for label, up in (('localhost', 'localhost:28080'), ('[::1]', '[::1]:28080')):
    d = TMP / ('fallback-' + re.sub(r'[^a-z0-9]+', '-', label))
    conf = d / 'Caddyfile'
    snip = d / 'conf.d' / 'cyber-probe.caddy'
    write_noeol(conf, 'example.com {\n\treverse_proxy %s\n}\n' % up)
    r = caddy_add(conf, snip, 'nope.test')
    out = read_raw(conf)
    check('caddy_patch：域不匹配时也能按 %s 上游兜底' % label,
          r.returncode == 0 and ('import ' + str(snip)) in out, r.stdout + r.stderr + out)

# ---- ③ 片段丢失 + import 残留：remove 要备份且校验失败可回滚 ----
d3 = TMP / 'missing-snippet'
conf3 = d3 / 'Caddyfile'
snip3 = d3 / 'conf.d' / 'cyber-probe.caddy'
orig3 = 'example.com {\n\timport %s\n\treverse_proxy 127.0.0.1:28080\n}\n' % snip3
write_noeol(conf3, orig3)
r = caddy_rm(conf3, snip3, extra=('--validate', 'false'))
check('caddy_patch：片段丢失时 --remove 仍会跑校验（失败 exit 4）',
      r.returncode == 4, 'rc=%s %s' % (r.returncode, r.stdout + r.stderr))
check('caddy_patch：片段丢失时的 --remove 失败会回滚原文',
      read_raw(conf3) == orig3, read_raw(conf3))
check('caddy_patch：片段丢失时的 --remove 也留了备份',
      any(p.name.startswith('Caddyfile.bak-') and p.name.endswith('-rm') for p in d3.iterdir()),
      str([p.name for p in d3.iterdir()]))
# 成功路径：--no-reload 也要备份 + 真删 import
r = caddy_rm(conf3, snip3, extra=('--no-reload',))
check('caddy_patch：片段丢失时 --remove 成功会真删 import',
      r.returncode == 0 and 'import ' not in read_raw(conf3),
      r.stdout + r.stderr + read_raw(conf3))

# ③b 用户给 import 加了引号/行尾注释时也要能卸干净
d3b = TMP / 'quoted-import'
conf3b = d3b / 'Caddyfile'
snip3b = d3b / 'conf.d' / 'cyber-probe.caddy'
snip3b.parent.mkdir(parents=True, exist_ok=True)
snip3b.write_text('handle /chicken/* {\n\trespond 1\n}\n', encoding='utf-8')
write_noeol(conf3b, 'example.com {\n\timport "%s"  # 手工备注\n\treverse_proxy 127.0.0.1:28080\n}\n' % snip3b)
r = caddy_rm(conf3b, snip3b, extra=('--no-reload',))
check('caddy_patch：带引号/行尾注释的 import 也能摘掉',
      r.returncode == 0 and 'import' not in read_raw(conf3b), r.stdout + r.stderr + read_raw(conf3b))

# ---- ④ vhost(caddy) 卸载字节还原（标记注释 + 空行一起摘）----
d4 = TMP / 'vhost-caddy'
conf4 = d4 / 'Caddyfile'
orig4 = 'other.test {\n\treverse_proxy 127.0.0.1:1\n}\n'
write_noeol(conf4, orig4)
r = run([VHOST, '--proxy', 'caddy', '--domain', 'farm.test', '--webroot', '/srv/site',
         '--hub-port', '28080', '--ws-port', '28910', '--conf', conf4, '--no-reload'])
r2 = run([VHOST, '--proxy', 'caddy', '--remove', '--domain', 'farm.test',
          '--webroot', '/srv/site', '--hub-port', '28080', '--ws-port', '28910',
          '--conf', conf4, '--no-reload'])
check('vhost(caddy)：卸载后 Caddyfile 字节还原（不留标记注释/空行）',
      r.returncode == 0 and r2.returncode == 0 and read_raw(conf4) == orig4,
      'add=%s rm=%s\n%r' % (r.returncode, r2.returncode, read_raw(conf4)))

# ---- ⑤ vhost(nginx)：certbot 的 IPv6 443 行必须保留 ----
d5 = TMP / 'vhost-nginx'
target5 = d5 / 'cyber-probe-farm.test.conf'
write_noeol(target5,
            'server {\n    listen 80;\n    listen [::]:80;\n    server_name farm.test;\n\n'
            '    listen 443 ssl; # managed by Certbot\n'
            '    listen [::]:443 ssl ipv6only=on; # managed by Certbot\n'
            '    ssl_certificate /etc/letsencrypt/live/farm.test/fullchain.pem;\n'
            '    ssl_certificate_key /etc/letsencrypt/live/farm.test/privkey.pem;\n\n'
            '    root /old;\n    location / { try_files $uri $uri/ =404; }\n}\n')
r = run([VHOST, '--proxy', 'nginx', '--domain', 'farm.test', '--webroot', '/srv/new',
         '--hub-port', '28080', '--ws-port', '28910', '--conf', d5, '--no-reload'])
new5 = read_raw(target5)
check('vhost(nginx)：重装保留 listen [::]:443（IPv6 HTTPS 不再被丢掉）',
      r.returncode == 0 and 'listen [::]:443' in new5 and 'ssl_certificate_key' in new5,
      r.stdout + r.stderr + new5)
check('vhost(nginx)：新 webroot 生效', 'root /srv/new;' in new5, new5)

# ---- ⑥ nginx：连续空行不被重排；CRLF 保持 ----
d6 = TMP / 'nginx-ws'
conf6 = d6 / 'site.conf'
orig6 = ('server {\n    listen 80;\n    # keep\n\n\n    location / {\n'
         '        proxy_pass http://127.0.0.1:28080;\n    }\n}\n')
write_noeol(conf6, orig6)


def ngx_add(conf):
    return run([NGX, '--local', '--no-reload', '--conf', conf, '--hub-port', '28080',
                '--ws-port', '28910', '--webroot', '/srv/site', '--path', '/farm'])


def ngx_rm(conf):
    return run([NGX, '--local', '--no-reload', '--remove', '--conf', conf,
                '--hub-port', '28080', '--ws-port', '28910', '--webroot', '/srv/site',
                '--path', '/farm'])


ngx_add(conf6)
ngx_rm(conf6)
check('nginx_patch：卸载不重排用户自己的连续空行',
      read_raw(conf6) == orig6, repr(read_raw(conf6)))

conf6b = d6 / 'crlf.conf'
orig6b = ('server {\r\n    listen 80;\r\n    location / {\r\n'
          '        proxy_pass http://127.0.0.1:28080;\r\n    }\r\n}\r\n')
write_noeol(conf6b, orig6b)
ngx_add(conf6b)
ngx_rm(conf6b)
check('nginx_patch：CRLF 配置贴→摘后仍是 CRLF（不被 read_text 悄悄转 LF）',
      read_raw(conf6b) == orig6b, repr(read_raw(conf6b)[:80]))

# ⑥b 多 server 文件：另一个 vhost 已有同名 /farm/，ws 必须插到含 hub 上游的 server；
#     目标 server 里用户自己的 /farm/api/ 卸载时不能被误删；贴→摘字节一致。
d6c = TMP / 'nginx-multi'
conf6c = d6c / 'site.conf'
orig6c = ('server {\n    listen 8081;\n    server_name a.test;\n'
          '    location ^~ /farm/ {\n        alias /srv/a/;\n    }\n'
          '    location / { try_files $uri $uri/ =404; }\n}\n\n'
          'server {\n    listen 8082;\n    server_name b.test;\n'
          '    location ^~ /farm/api/ {\n        proxy_pass http://127.0.0.1:28080/api/;\n    }\n'
          '    location / { try_files $uri $uri/ =404; }\n}\n')
write_noeol(conf6c, orig6c)
ngx_add(conf6c)
added = read_raw(conf6c)
b_at = added.find('server_name b.test')
a_at = added.find('server_name a.test')
check('nginx_patch：多 server 时 ws 只插到 hub server（不碰前面的同名 vhost）',
      a_at < added.find('location = /farm/ws') and added.find('location = /farm/ws') > b_at,
      added)
ngx_rm(conf6c)
check('nginx_patch：多 server 贴→摘字节一致（用户自己的 /farm/api/ 保留）',
      read_raw(conf6c) == orig6c, read_raw(conf6c))

# ---- ⑦ gen_config：IPv6 目标可解析 ----
sys.path.insert(0, str(ROOT / 'tools'))
import gen_config  # noqa: E402

check('gen_config：IPv4 host:port 解析', gen_config.resolve_host('127.0.0.1:443') == '127.0.0.1')
check('gen_config：[IPv6]:port 解析（不再永远 🌐）',
      gen_config.resolve_host('[::1]:443') in ('::1', '0:0:0:0:0:0:0:1'),
      gen_config.resolve_host('[::1]:443'))

# ---- ⑧ 安装器：Caddy 大括号换行 + 缺 Caddyfile 提前报错 ----
hdr = HDR.read_text(encoding='utf-8')
try:
    start = hdr.index('caddy_block_head() {')
    end = hdr.index('\ndetect_proxy_conf() {', start)
    func = hdr[start:end]
    d8 = TMP / 'hdr'
    d8.mkdir(parents=True, exist_ok=True)
    (d8 / 'cbh.sh').write_text(func, encoding='utf-8')
    cf = d8 / 'Caddyfile'
    write_noeol(cf, 'a.test {\n\treverse_proxy 127.0.0.1:9999\n}\n\n'
                    'example.com\n{\n\treverse_proxy 127.0.0.1:28080\n}\n')
    # 用 cwd + 相对路径：Windows 的 C:\... 传给 MSYS bash 会被反斜杠吃掉
    got = subprocess.run(['bash', '-c', '. ./cbh.sh; caddy_block_head ./Caddyfile 7'],
                         capture_output=True, text=True, cwd=str(d8),
                         stdin=subprocess.DEVNULL).stdout.strip()
    check('安装器：Caddy 的 `{` 单独一行时能认出 example.com', got == 'example.com', repr(got))
except Exception as e:
    check('安装器：caddy_block_head 可测试', False, repr(e))

check('安装器：PROXY=caddy 但 Caddyfile 不存在时会提前报错（不再 traceback）',
      '找不到要改的 Caddyfile' in hdr and 'check_proxy_conf' in hdr)
check('安装器：--caddyfile 会标记为 CLI 参数',
      'CLI_CADDYFILE=1' in hdr)
check('安装器：成功生成 config.js 时会写 NPC 白名单',
      hdr.count('--npc-allow-out "$APPDIR/npcs-allow"') >= 2)
check('安装器：自定义 Caddyfile / nginx 站点路径会落盘并在探测不到时兜底',
      'PREV_CADDYFILE=' in hdr and 'PREV_NGINX_CONF=' in hdr
      and 'CADDYFILE=$save_caddy' in hdr and 'NGINX_CONF=$save_nginx' in hdr)
check('安装器：静态站统一 chown 到 root（包里的开发机 UID 不落到 /var/www）',
      'chown -R 0:0 "$stage"' in hdr)
check('安装器：--proxy nginx/caddy 时缺对应命令会提前报错',
      '找不到 nginx 命令' in hdr and '找不到 caddy 命令' in hdr)
caddy_src = (ROOT / 'tools' / 'caddy_patch.py').read_text(encoding='utf-8')
vhost_src = (ROOT / 'tools' / 'vhost.py').read_text(encoding='utf-8')
check('caddy：无 caddy 命令时卸载仍能摘（跳过校验）',
      '找不到 caddy 命令，跳过 caddy validate' in caddy_src)
check('caddy：手工进程用 caddy reload --force 让配置真正生效',
      'caddy reload --config %s --adapter caddyfile --force' in caddy_src
      or 'caddy reload --config %s --adapter caddyfile --force' in vhost_src)

# ③c 没有 caddy 二进制（PATH 里没有）时，--remove 仍要摘掉 import + 片段
d3c = TMP / 'no-caddy-bin'
conf3c = d3c / 'Caddyfile'
snip3c = d3c / 'conf.d' / 'cyber-probe.caddy'
snip3c.parent.mkdir(parents=True, exist_ok=True)
snip3c.write_text('handle /chicken/* {\n\trespond 1\n}\n', encoding='utf-8')
write_noeol(conf3c, 'example.com {\n\timport %s\n\treverse_proxy 127.0.0.1:28080\n}\n' % snip3c)
env_nocaddy = os.environ.copy()
emptybin = d3c / 'emptybin'
emptybin.mkdir()
env_nocaddy['PATH'] = str(emptybin)
r = subprocess.run([PY, str(CAD), '--local', '--remove', '--conf', str(conf3c),
                    '--snippet', str(snip3c), '--domain', 'example.com',
                    '--hub-port', '28080', '--ws-port', '28910',
                    '--webroot', '/srv/site', '--path', '/chicken'],
                   capture_output=True, text=True, encoding='utf-8', errors='replace',
                   env=env_nocaddy, stdin=subprocess.DEVNULL)
check('caddy_patch：PATH 里没有 caddy 时 --remove 仍成功（不再回滚残留）',
      r.returncode == 0 and 'import' not in read_raw(conf3c) and not snip3c.exists(),
      'rc=%s\n%s\n%s' % (r.returncode, r.stdout, r.stderr))

# ---- ⑨ 前端几个行为回归（静态门禁；真实浏览器断言在 --with-browser）----
main_js = (ROOT / 'js' / 'main.js').read_text(encoding='utf-8')
css = (ROOT / 'style.css').read_text(encoding='utf-8')
npc_js = (ROOT / 'js' / 'npc.js').read_text(encoding='utf-8')
check('远程玩家 airborne 用“离地高度”，不是世界 Y',
      'y - groundHeight(x, z) > 0.05' in main_js)
check('hudHit 覆盖整个 HUD（touch 不再穿透到 canvas）',
      "'#hud, #errbar, #plist'" in main_js and '#topbar,#me,#hint,#feed,#banner{pointer-events:auto}' in css)
check('removeRemote 会 dispose 远程玩家资源',
      'r.chicken.dispose(scene)' in main_js)
check('Npc.dispose 委托给 Chicken（含 ring 几何体）',
      'this.chicken.dispose(scene)' in npc_js and 'this.ring.geometry.dispose()' in npc_js)
check('isTouch 不再只凭 ontouchstart 判定（触屏笔记本仍可用键盘）',
      "matchMedia('(pointer: coarse)')" in main_js and "|| 'ontouchstart' in window" not in main_js)
check('cachebust 会给 importmap 的 three 打版本号',
      'bump_importmap' in (ROOT / 'tools' / 'cachebust.py').read_text(encoding='utf-8'))
check('?nomodels 不再预取模型',
      "has('nomodels')" in (ROOT / 'js' / 'prewarm.js').read_text(encoding='utf-8')
      and "has('nomodels')" in (ROOT / 'js' / 'models.js').read_text(encoding='utf-8'))

# ---- ⑨b monitor 分支也生成 NPC 白名单（node.id + ping_task.id）----
try:
    import sqlite3
    db = TMP / 'monitor.db'
    con = sqlite3.connect(str(db))
    con.execute('create table node(id integer primary key, name text)')
    con.execute('create table ping_task(id integer primary key, name text, target text, interval integer)')
    con.executemany('insert into node(id,name) values(?,?)', [(1, 'a'), (2, 'b')])
    con.execute("insert into ping_task(id,name,target,interval) values(7,'t7','1.1.1.1:443',60)")
    con.commit(); con.close()
    allow = TMP / 'npcs-allow'
    r = run([ROOT / 'tools' / 'gen_config.py', '--db', db, '--out', TMP / 'monitor.js',
             '--npc-allow-out', allow])
    at = allow.read_text(encoding='utf-8') if allow.exists() else ''
    check('gen_config --db：NPC 白名单含 n1/n2/t7',
          r.returncode == 0 and all(x in at for x in ('n1', 'n2', 't7')), r.stderr + at)
    check('gen_config --db：公开 config.js 不含节点 id 白名单',
          'n1' not in (TMP / 'monitor.js').read_text(encoding='utf-8'))
except Exception as e:
    check('gen_config --db NPC 白名单', False, repr(e))

# ⑧ CF 边缘：X-Real-IP 是 CF 段时才用 CF-Connecting-IP（否则不信任可伪造的 CF 头）
sys.path.insert(0, str(ROOT / 'server'))
import farm_server as farm  # noqa: E402

class _W:
    def get_extra_info(self, _):
        return ('127.0.0.1', 1234)

check('client_ip：普通 X-Real-IP 优先（直连/非 CF 不信任 CF 头）',
      farm.client_ip({'x-real-ip': '198.51.100.7', 'cf-connecting-ip': '203.0.113.9'}, _W()) == '198.51.100.7')
check('client_ip：X-Real-IP 是 CF 边缘时改用 CF-Connecting-IP',
      farm.client_ip({'x-real-ip': '172.64.0.1', 'cf-connecting-ip': '203.0.113.9'}, _W()) == '203.0.113.9')

# ⑨ dog：?nomodels、dispose 几何体、迟到的 loadModel 取消
dog_src = (ROOT / 'js' / 'dog.js').read_text(encoding='utf-8')
check('dog：?nomodels 不再加载精细模型', "has('nomodels')" in dog_src and 'async loadModel' in dog_src)
check('dog：dispose 释放几何体并取消迟到 load', 'this._dead = true' in dog_src and 'o.geometry.dispose()' in dog_src)

# ⑩ Caddy 找不到站点块时是 ERR/exit 3，而不是 NameError traceback
d10 = TMP / 'caddy-nomatch'
conf10 = d10 / 'Caddyfile'
write_noeol(conf10, 'example.com {\n\treverse_proxy 127.0.0.1:9999\n}\n')
r = caddy_add(conf10, d10 / 'conf.d' / 'x.caddy', 'nomatch.test')
check('caddy_patch：找不到站点块时 exit 3（不再 NameError）',
      r.returncode == 3 and 'NameError' not in (r.stdout + r.stderr),
      'rc=%s %s' % (r.returncode, r.stdout + r.stderr))

print()
print('失败 %d 项' % len(fails) if fails else '全部通过')
sys.exit(1 if fails else 0)

# ⑧ CF 边缘：X-Real-IP 是 CF 段时才用 CF-Connecting-IP（否则不信任可伪造的 CF 头）
sys.path.insert(0, str(ROOT / 'server'))
import farm_server as farm  # noqa: E402

class _W:
    def get_extra_info(self, _):
        return ('127.0.0.1', 1234)

check('client_ip：普通 X-Real-IP 优先（直连/非 CF 不信任 CF 头）',
      farm.client_ip({'x-real-ip': '198.51.100.7', 'cf-connecting-ip': '203.0.113.9'}, _W()) == '198.51.100.7')
check('client_ip：X-Real-IP 是 CF 边缘时改用 CF-Connecting-IP',
      farm.client_ip({'x-real-ip': '172.64.0.1', 'cf-connecting-ip': '203.0.113.9'}, _W()) == '203.0.113.9')

