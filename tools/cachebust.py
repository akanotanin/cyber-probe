#!/usr/bin/env python3
"""给部署到服务器上的 cyber-probe 静态文件做「版本号后缀」处理（cache busting）。

背景：这个站挂在 Cloudflare 橙云后面，CF 的 Browser Cache TTL 默认 4 小时，
会把 nginx 的 `Cache-Control: no-cache` 改写成 `max-age=14400` —— 于是用户浏览器
（和 CF 边缘）会拿着**旧版 JS** 跑半天，表现为「我改的界面没生效」「看不见的鸡在打我」。
没有 CF token 改不了那个设置，所以改用 URL 版本号：index.html 里的入口、
以及每个 js 模块内部相对 import 的路径都带上 ?v=<stamp>，
CF 边缘没见过这个 URL → 一定回源，浏览器也一定拿新文件。

在服务器上跑（幂等：每次都先把旧的 ?v= 去掉再加新的）：
    python3 cachebust.py /var/www/cyber-probe <stamp>
"""
import os
import re
import sys

ROOT = sys.argv[1] if len(sys.argv) > 1 else '/var/www/cyber-probe'
STAMP = sys.argv[2] if len(sys.argv) > 2 else '1'

# 已经带过的版本号先摘掉，避免 ?v=1?v=2 这种堆积
STRIP = re.compile(r'(\S+?\.(?:js|css))\?v=[\w.-]+')

# index.html：src="js/main.js" / href="style.css"
HTML_URL = re.compile(r'((?:src|href)="(?:\./)?[\w./-]+\.(?:js|css))(")')


def bump_html(text: str) -> str:
    text = STRIP.sub(r'\1', text)
    return HTML_URL.sub(lambda m: f'{m.group(1)}?v={STAMP}{m.group(2)}', text)


# js 模块：from './npc.js' / from "./interp.js"
JS_IMPORT = re.compile(r"""(from\s+['"])(\.{1,2}/[\w./-]+\.js)(['"])""")
JS_DYNAMIC = re.compile(r"""(import\(\s*['"])(\.{1,2}/[\w./-]+\.js)(['"]\s*\))""")


def bump_js(text: str) -> str:
    text = STRIP.sub(r'\1', text)
    text = JS_IMPORT.sub(lambda m: f'{m.group(1)}{m.group(2)}?v={STAMP}{m.group(3)}', text)
    return JS_DYNAMIC.sub(lambda m: f'{m.group(1)}{m.group(2)}?v={STAMP}{m.group(3)}', text)


changed = []
for dirpath, _dirs, files in os.walk(ROOT):
    for fn in files:
        p = os.path.join(dirpath, fn)
        if fn.endswith('.html'):
            fn_bump = bump_html
        elif fn.endswith('.js'):
            fn_bump = bump_js
        else:
            continue
        try:
            src = open(p, encoding='utf-8').read()
        except (UnicodeDecodeError, OSError):
            continue          # 二进制/第三方大文件（vendor/three.module.js 是单文件，无 import 无需处理）
        out = fn_bump(src)
        if out != src:
            open(p, 'w', encoding='utf-8', newline='\n').write(out)
            changed.append(os.path.relpath(p, ROOT))

print(f'cachebust: {len(changed)} 个文件打上 v={STAMP}')
for c in sorted(changed):
    print('  ', c)
