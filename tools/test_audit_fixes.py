#!/usr/bin/env python3
"""针对 2026-11-03 审查报告里工具链问题的回归测试（Windows 本机可跑）。"""
import os
import shutil
import subprocess
import sys
import tempfile
import pathlib

ROOT = pathlib.Path(__file__).resolve().parents[1]
PY = sys.executable
NGX = ROOT / 'tools' / 'nginx_patch.py'
CAD = ROOT / 'tools' / 'caddy_patch.py'
CB = ROOT / 'tools' / 'cachebust.py'

fails = []


def check(name, cond, detail=''):
    print(('PASS  ' if cond else 'FAIL  ') + name + ('  ' + detail if (detail and not cond) else ''))
    if not cond:
        fails.append(name)


def write_noeol(path, text):
    """原样写文件（不翻译换行）。⚠ 别改用 Path.write_text(newline=...)：
    那个参数 3.10 才有，而项目对外承诺 python3.9+（README）。"""
    with open(path, 'w', encoding='utf-8', newline='') as f:
        f.write(text)


def run(args, **kw):
    return subprocess.run([PY] + args, capture_output=True, text=True,
                          encoding='utf-8', errors='replace', **kw)


def ngx_patch(conf, prefix='/farm', extra=()):
    return run([str(NGX), '--local', '--no-reload', '--conf', str(conf), '--hub-port', '28080',
                '--ws-port', '28910', '--webroot', '/srv/site', '--path', prefix] + list(extra))


def ngx_remove(conf, prefix='/farm', extra=()):
    return run([str(NGX), '--local', '--no-reload', '--remove', '--conf', str(conf),
                '--hub-port', '28080', '--ws-port', '28910', '--webroot', '/srv/site',
                '--path', prefix] + list(extra))


TMP = pathlib.Path(tempfile.mkdtemp(prefix='cp-reg-'))

# ---- 1) tab 缩进的站点（报告 BUG-06）----
tab = TMP / 'tab.conf'
tab_src = ('server {\n\tlisten 443 ssl;\n\tserver_name y.test;\n\n\tlocation / {\n'
           '\t\tproxy_pass http://127.0.0.1:28080;\n\t}\n}\n')
write_noeol(tab, tab_src)
r = ngx_patch(tab)
out = tab.read_text(encoding='utf-8')
check('tab 缩进：补丁成功', r.returncode == 0, r.stdout + r.stderr)
check('tab 缩进：三块都在', ('location ^~ /farm/api/' in out and 'location = /farm/ws' in out
                             and 'alias /srv/site/' in out))
check('tab 缩进：缩进跟随锚点（不是硬编码 4 空格）', '\tlocation = /farm/ws' in out)
r = ngx_remove(tab)
check('tab 缩进：卸载零残留', tab.read_text(encoding='utf-8') == tab_src,
      repr(tab.read_text(encoding='utf-8')[:200]))

# ---- 2) 两个 server（80 跳转 + 443 反代），补丁要落在含 hub 上游的那个块（BUG-06）----
dual = TMP / 'dual.conf'
dual_src = ('server {\n    listen 80;\n    server_name y.test;\n'
            '    location / {\n        return 301 https://$host$request_uri;\n    }\n}\n\n'
            'server {\n    listen 443 ssl;\n    server_name y.test;\n'
            '    location / {\n        proxy_pass http://127.0.0.1:28080;\n    }\n}\n')
write_noeol(dual, dual_src)
r = ngx_patch(dual)
out = dual.read_text(encoding='utf-8')
check('双 server：补丁成功', r.returncode == 0, r.stdout + r.stderr)
first = out.find('location ^~ /farm/api/')
ssl_pos = out.find('listen 443')
check('双 server：插进 443 那个块（不是 80 跳转块）', 0 < ssl_pos < first,
      'ssl=%d first=%d' % (ssl_pos, first))
r = ngx_remove(dual)
check('双 server：卸载字节一致', dual.read_text(encoding='utf-8') == dual_src)

# ---- 3) 用户自己写的 location /chicken/ 不能被卸载误删（BUG-12）----
own = TMP / 'own.conf'
own_src = ('server {\n    listen 443 ssl;\n    server_name y.test;\n\n'
           '    # 用户自己的反代\n    location /chicken/ {\n        alias /srv/own-app/;\n    }\n\n'
           '    location / {\n        proxy_pass http://127.0.0.1:28080;\n    }\n}\n')
write_noeol(own, own_src)
ngx_patch(own, prefix='/chicken')
r = ngx_remove(own, prefix='/chicken')
out = own.read_text(encoding='utf-8')
check('用户自有 location：没被删', 'alias /srv/own-app/;' in out, out)
check('用户自有 location：我们插的块已摘掉', 'cyber-probe' not in out, out)
check('用户自有 location：卸载后字节一致', out == own_src)

# ---- 3b) 只剩 /api/clients 块（API/静态块被手工删过）时，补块不能重复 clients ----
only = TMP / 'clients-only.conf'
only_src = ('server {\n    listen 443 ssl;\n    server_name y.test;\n\n'
            '    location = /farm/api/clients {\n'
            '        proxy_pass http://127.0.0.1:28080/api/clients;\n'
            '        proxy_set_header Connection "upgrade";\n'
            '    }\n\n'
            '    location / {\n        proxy_pass http://127.0.0.1:28080;\n    }\n}\n')
write_noeol(only, only_src)
r = ngx_patch(only)
out = only.read_text(encoding='utf-8')
check('clients-only：补丁成功', r.returncode == 0, r.stdout + r.stderr)
check('clients-only：API/静态块补回来了',
      'location ^~ /farm/api/' in out and 'alias /srv/site/' in out)
check('clients-only：/api/clients 没有重复（nginx 会报 duplicate location）',
      out.count('location = /farm/api/clients') == 1, out)

# ---- 4) 自检失败要回滚（BUG-09）----
rb = TMP / 'rollback.conf'
write_noeol(rb, dual_src)
r = ngx_patch(rb, extra=('--validate', 'false'))
check('安装：自检失败 → exit 4', r.returncode == 4, str(r.returncode))
check('安装：自检失败 → 已回滚', rb.read_text(encoding='utf-8') == dual_src)
# 先正常打上补丁，再让卸载自检失败
ngx_patch(rb)
before = rb.read_text(encoding='utf-8')
r = ngx_remove(rb, extra=('--validate', 'false'))
check('卸载：自检失败 → exit 4', r.returncode == 4, str(r.returncode))
check('卸载：自检失败 → 配置恢复成卸载前', rb.read_text(encoding='utf-8') == before)

# ---- 5) cachebust 幂等且能换版本号（BUG-08）----
site = TMP / 'site'
(site / 'js').mkdir(parents=True)
(site / 'index.html').write_text(
    '<script src="js/main.js?v=111"></script>\n<link href="style.css?v=111">\n'
    '<script type="module" src="js/app.js"></script>\n', encoding='utf-8')
(site / 'js' / 'main.js').write_text("import x from './npc.js?v=111';\nimport './util.js';\n", encoding='utf-8')
(site / 'js' / 'app.js').write_text("import { a } from './main.js?v=111';\n", encoding='utf-8')
(site / 'style.css').write_text('body{}', encoding='utf-8')
run([str(CB), str(site), '111'])
h1 = (site / 'index.html').read_text(encoding='utf-8')
run([str(CB), str(site), '222'])
h2 = (site / 'index.html').read_text(encoding='utf-8')
m2 = (site / 'js' / 'main.js').read_text(encoding='utf-8')
a2 = (site / 'js' / 'app.js').read_text(encoding='utf-8')
check('cachebust：第二次也真的换版本号（index）', '?v=222' in h2 and '?v=111' not in h2, h2)
check('cachebust：模块 import 也换（main.js）', "npc.js?v=222" in m2 and "util.js?v=222" in m2, m2)
check('cachebust：app.js 引用 main 换版本', "main.js?v=222" in a2, a2)
check('cachebust：不堆积 ?v=', '?v=222?v=' not in h2 + m2 + a2)

# importmap 里的 three 也要版本号（稳定文件名，CF 缓存 4 小时）；addons 前缀不能乱加
im = TMP / 'site-importmap'
(im / 'js').mkdir(parents=True)
(im / 'index.html').write_text(
    '<script type="importmap">{"imports":{"three":"./vendor/three.module.js",'
    '"three/addons/":"./vendor/addons/"}}</script>\n<script type="module" src="./js/main.js"></script>\n',
    encoding='utf-8')
run([str(CB), str(im), '111'])
run([str(CB), str(im), '222'])
imtext = (im / 'index.html').read_text(encoding='utf-8')
check('cachebust：importmap 的 three 打上 ?v=222', 'three.module.js?v=222' in imtext, imtext)
check('cachebust：importmap 的 addons 前缀保持原样', '"./vendor/addons/"' in imtext, imtext)
check('cachebust：importmap 不堆积 ?v=', '?v=222?v=' not in imtext, imtext)

# ---- 6) vhost caddy 域名模式不该 strip /api（BUG-05）----
vh = run([str(ROOT / 'tools' / 'vhost.py'), '--proxy', 'caddy', '--domain', 'farm.test',
          '--webroot', '/srv/site', '--hub-port', '28080', '--ws-port', '28910', '--dry-run'])
check('vhost caddy：dry-run 能跑', vh.returncode == 0, vh.stderr)
check('vhost caddy：不再 strip /api', 'strip_prefix' not in vh.stdout, vh.stdout)
check('vhost caddy：ws 覆盖 X-Real-IP（防伪造绕限流）',
      'header_up X-Real-IP {remote_host}' in vh.stdout, vh.stdout)

shutil.rmtree(TMP, ignore_errors=True)
print()
print('失败 %d 项' % len(fails) if fails else '全部通过')
sys.exit(1 if fails else 0)
