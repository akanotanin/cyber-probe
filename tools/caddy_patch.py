#!/usr/bin/env python3
"""给 Caddy 站点块加/删 cyber-probe 的反代与静态块（幂等；改前自动备份）。

做法：把三块写进一个独立片段文件（默认 /etc/caddy/conf.d/cyber-probe.caddy），
再在站点块的大括号里插一行 `import <片段路径>` —— 卸载时删片段 + 删那一行，其余配置不碰。

片段里：
   /chicken/api/*  → 剥掉 /chicken 前缀后反代 hub（同源，hub 没有 CORS 头，只能这么接）
   /chicken/ws     → 反代联机游戏服（Caddy 的 reverse_proxy 自带 WebSocket 升级）
   /chicken/*      → 静态站（handle_path 会剥掉 /chicken 前缀）
   /chicken        → 301 到 /chicken/

用法:
  python tools/caddy_patch.py --local --conf /etc/caddy/Caddyfile
                                                       # 在本机直接改文件（一键包 install/uninstall 用）
  python tools/caddy_patch.py <ssh别名> --conf /etc/caddy/Caddyfile
                                                       # 从开发机 ssh 过去改（别名用你 ssh config 里的名字）
  python tools/caddy_patch.py <ssh别名> --remove       # 摘掉片段与 import 行（卸载用）
  python tools/caddy_patch.py --no-reload              # 只改文件、不 caddy validate / reload（自测用）
  python tools/caddy_patch.py --local --domain hub.example.com \
      --ws-port 28910 --hub-port 28080 --webroot /var/www/cyber-probe
"""
import base64
import os
import shlex
import subprocess
import sys

ARGS = list(sys.argv[1:])
LOCAL = '--local' in ARGS
REMOVE = '--remove' in ARGS
NO_RELOAD = '--no-reload' in ARGS
CONF = '/etc/caddy/Caddyfile'
HOST = os.environ.get('PATCH_HOST') or ''   # ssh 别名（--local 时不用）
DOMAIN = ''                # 空 = 认第一个含 hub 上游的站点块
WS_PORT = '28910'          # /chicken/ws 反代到的联机服端口
HUB_PORT = '28080'         # /chicken/api/* 反代到的 hub 端口
WEBROOT = '/var/www/cyber-probe'
SNIPPET = '/etc/caddy/conf.d/cyber-probe.caddy'
VALIDATE_CMD = None        # 自检命令；None = 默认（非 --no-reload 时用 `caddy validate --config <CONF>`）

_i = 0
while _i < len(ARGS):
    a = ARGS[_i]
    if a in ('--conf', '--ws-port', '--hub-port', '--webroot', '--snippet', '--domain',
             '--validate') and _i + 1 < len(ARGS):
        v = ARGS[_i + 1]
        if a == '--conf':
            CONF = v
        elif a == '--ws-port':
            WS_PORT = v
        elif a == '--hub-port':
            HUB_PORT = v
        elif a == '--webroot':
            WEBROOT = v
        elif a == '--snippet':
            SNIPPET = v
        elif a == '--validate':
            VALIDATE_CMD = v
        else:
            DOMAIN = v
        _i += 2
        continue
    if a in ('--local', '--remove', '--no-reload'):
        _i += 1
        continue
    HOST = a
    _i += 1

if VALIDATE_CMD is None:
    VALIDATE_CMD = '' if NO_RELOAD else 'caddy validate --config %s' % CONF

# 站点块里的三块。注意 handle 是「按书写顺序、互斥」的，api 必须排在静态前面。
SNIPPET_BODY = """# cyber-probe—— 由安装器生成，请勿手改。
# 卸载：跑 cyber-probe-*.run uninstall（会删掉本文件与 Caddyfile 里对应的 import 行）。
handle /chicken/api/* {
\turi strip_prefix /chicken
\treverse_proxy 127.0.0.1:__HUB_PORT__
}
handle /chicken/ws {
\treverse_proxy 127.0.0.1:__WS_PORT__
}
handle_path /chicken/* {
\troot * __WEBROOT__
\tfile_server
}
handle /chicken {
\tredir /chicken/ 301
}
"""
SNIPPET_BODY = SNIPPET_BODY.replace('__HUB_PORT__', HUB_PORT) \
                           .replace('__WS_PORT__', WS_PORT) \
                           .replace('__WEBROOT__', WEBROOT)

IMPORT_LINE = 'import ' + SNIPPET

REMOTE_ADD = r'''
import sys, shutil, datetime, pathlib, base64
conf = pathlib.Path(sys.argv[1])
snippet_path = pathlib.Path(sys.argv[2])
body = base64.b64decode(sys.argv[3]).decode()
import_line = sys.argv[4]
domain = sys.argv[5]
hub_up = "127.0.0.1:" + sys.argv[6]
# 自检命令：显式用 --validate=<cmd> 传。
# ⚠⚠ 以前是按位置取 argv[6]，而 argv[6] 其实是 hub 端口 → `bash -c "28080"` → command not found
#    → 每次都「补完就回滚」，Caddy 路径的一键安装从来没成功过（2026-09-27 在测试机上抓到）。
#    纯数字一律当作用户传错了，当场报错 —— 宁可失败也不要静默回滚。
validate = ''
for _a in sys.argv[1:]:
    if _a.startswith('--validate='):
        validate = _a.split('=', 1)[1]
        break
if validate.strip().isdigit():
    print("ERR  自检命令像是个端口号（%s）—— 参数按位置传错了，未改动任何文件" % validate, file=sys.stderr)
    sys.exit(5)
src = conf.read_text(encoding="utf-8")
notes = []

if not snippet_path.parent.exists():
    snippet_path.parent.mkdir(parents=True, exist_ok=True)
    if not snippet_path.parent.exists():
        print("ERR  建不出目录：%s" % snippet_path.parent, file=sys.stderr); sys.exit(2)

# 自愈：早期版本把 import 行连引号一起写进去了（本地执行时 argv 不该带引号），
# 那种行 Caddy 会报 unrecognized directive。见到就清掉。
bad_lines = {"'" + import_line + "'", '"' + import_line + '"'}
lines = src.splitlines(keepends=True)
cleaned = [ln for ln in lines if ln.strip() not in bad_lines]
if len(cleaned) != len(lines):
    notes.append("清掉 %d 行带引号的坏 import" % (len(lines) - len(cleaned)))
    lines = cleaned
    src = "".join(lines)

if import_line not in src:
    # 找站点块：优先「地址里含 --domain」，其次「块里出现 hub 上游」
    candidates = []
    for i, ln in enumerate(lines):
        s = ln.strip()
        if not s or s.startswith("#"):
            continue
        if s.endswith("{") or s == "{":
            head = s[:-1].strip()
            if head:
                candidates.append((i, head))
    pick = None
    for i, head in candidates:
        if domain and domain in head:
            pick = i; break
    if pick is None:
        for i, head in candidates:
            depth = 0
            for j in range(i, len(lines)):
                depth += lines[j].count("{") - lines[j].count("}")
                if hub_up in lines[j] and depth > 0:
                    pick = i; break
            if pick is not None:
                break
    if pick is None:
        print("ERR  在 %s 里找不到站点块（试过按域名 %r 与按 hub 上游 %r 匹配）。\n"
              "     请手动在这一行所属的大括号里加一行：%s" % (conf, domain, hub_up, import_line), file=sys.stderr)
        sys.exit(3)
    lines.insert(pick + 1, "\t" + import_line + "\n")
    src = "".join(lines)
    notes.append("插入 import 行（站点块第 %d 行）" % (pick + 1))

if snippet_path.exists() and snippet_path.read_text(encoding="utf-8") == body and not notes:
    print("SKIP  Caddyfile 与片段都已是目标状态，未改动")
    sys.exit(0)
had_snip = snippet_path.exists()
stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
bak_conf = conf.with_name(conf.name + ".bak-" + stamp)
bak_snip = snippet_path.with_name(snippet_path.name + ".bak-" + stamp)
shutil.copy2(conf, bak_conf)
if had_snip:
    shutil.copy2(snippet_path, bak_snip)
snippet_path.write_text(body, encoding="utf-8", newline="")
conf.write_text(src, encoding="utf-8", newline="")
print("PATCHED  " + ("；".join(notes) if notes else "只刷新片段") + "  片段 -> " + str(snippet_path))

# 写完先自检：不过就**回滚**（Caddyfile 坏了会让整站起不来，绝不能留着）
if validate:
    import subprocess
    p = subprocess.run(['bash', '-c', validate], capture_output=True, text=True)
    if p.returncode != 0:
        shutil.copy2(bak_conf, conf)
        if had_snip and bak_snip.exists():
            shutil.copy2(bak_snip, snippet_path)
        elif not had_snip and snippet_path.exists():
            snippet_path.unlink()      # 本来没这个片段 → 回滚也得把它删掉，别留孤儿文件
        print((p.stderr or p.stdout or '').strip()[:900], file=sys.stderr)
        print("ERR  「%s」没过 → 已回滚到改动前（%s 保持原样）" % (validate, conf), file=sys.stderr)
        sys.exit(4)
    print("    自检通过：" + validate)
'''

REMOTE_REMOVE = r'''
import sys, shutil, datetime, pathlib, glob
conf = pathlib.Path(sys.argv[1])
snippet_path = pathlib.Path(sys.argv[2])
import_line = sys.argv[3]
src = conf.read_text(encoding="utf-8")
notes = []
bad_lines = {import_line, "'" + import_line + "'", '"' + import_line + '"'}
lines = src.splitlines(keepends=True)
cleaned = [ln for ln in lines if ln.strip() not in bad_lines]
if len(cleaned) != len(lines):
    src = "".join(cleaned)
    notes.append("删掉 import 行 ×%d" % (len(lines) - len(cleaned)))
for f in glob.glob(str(snippet_path) + "*"):
    pathlib.Path(f).unlink()
    notes.append("删除 " + pathlib.Path(f).name)
if not notes:
    print("SKIP  配置里没有 cyber-probe 的片段与 import 行，无需移除")
    sys.exit(0)
shutil.copy2(conf, conf.with_name(conf.name + ".bak-" + datetime.datetime.now().strftime("%Y%m%d-%H%M%S")))
conf.write_text(src, encoding="utf-8", newline="")
print("REMOVED  " + "；".join(notes))
'''


def run_py(script_text, extra):
    """把一段 python 喂给远端（或本机）的 python3 执行。

    ⚠ 本机执行走 argv 列表、远端执行拼 shell 字符串 —— 两种情况下参数**都不能自带引号**：
      早期版本为了迁就 ssh 分支给参数套了单引号，结果本机执行时那对引号被原样写进
      Caddyfile（`unrecognized directive: 'import`）。远端分支改由 shlex.quote 负责转义。
    """
    if LOCAL:
        cmd = [sys.executable or 'python3', '-'] + extra
    else:
        cmd = ['ssh', HOST, 'python3 - ' + ' '.join(shlex.quote(x) for x in extra)]
    r = subprocess.run(cmd, input=script_text, capture_output=True, text=True)
    print((r.stdout or '').strip())
    if r.returncode != 0:
        print((r.stderr or '').strip(), file=sys.stderr)
        sys.exit(r.returncode)


def run_cmd(cmd, ignore_fail=False):
    if LOCAL:
        r = subprocess.run(['bash', '-c', cmd], capture_output=True, text=True)
    else:
        r = subprocess.run(['ssh', HOST, cmd], capture_output=True, text=True)
    print((r.stdout or '').strip())
    if r.returncode != 0:
        print((r.stderr or '').strip(), file=sys.stderr)
        if not ignore_fail:
            sys.exit(r.returncode)


b64 = lambda s: base64.b64encode(s.encode()).decode()
where = '本机' if LOCAL else HOST

if not LOCAL and not HOST:
    print('✗ 请给出 ssh 别名（或用 --local 在本机改文件；也可设环境变量 PATCH_HOST）', file=sys.stderr)
    sys.exit(2)

if REMOVE:
    run_py(REMOTE_REMOVE, [CONF, SNIPPET, IMPORT_LINE])
    if not NO_RELOAD:
        run_cmd('caddy validate --config %s && (systemctl reload caddy || systemctl restart caddy)' % CONF)
        print('Caddy 配置已生效（已移除 cyber-probe 的片段与 import 行）')
else:
    args = [CONF, SNIPPET, b64(SNIPPET_BODY), IMPORT_LINE, DOMAIN, HUB_PORT]
    # ⚠ 自检命令一律用 `--validate=<命令>` 传：以前它是位置参数 argv[6]，
    #   而位置 6 早被 hub 端口占了 → 每次都拿 "28080" 去 bash -c（详见 REMOTE_ADD 里的注释）
    if VALIDATE_CMD:
        args.append('--validate=' + VALIDATE_CMD)
    run_py(REMOTE_ADD, args)
    if not NO_RELOAD:
        run_cmd('systemctl reload caddy || systemctl restart caddy')
        print('Caddy 配置已生效')
print(f'（目标：{where} {CONF}，片段 {SNIPPET}）')
