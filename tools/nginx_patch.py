#!/usr/bin/env python3
"""给 nginx 站点块加/删 cyber-probe 的 location（幂等；改前自动备份）。

加的块：
   /chicken/api/ → 反代 hub 的 /api/（探针数据，同源，无 CORS）
   /chicken/ws   → 反代联机游戏服（WebSocket 升级）
   /chicken/     → 静态站（alias 到 --webroot，所以站点目录叫什么名字都行）

用法:
  python tools/nginx_patch.py --local --conf /etc/nginx/conf.d/<你的站点>.conf
                                                  # 在本机直接改文件（一键部署包 install/uninstall 用）
  python tools/nginx_patch.py <ssh别名> --conf /etc/nginx/conf.d/<你的站点>.conf
                                                  # 从开发机 ssh 过去改（别名用你 ssh config 里的名字）
  python tools/nginx_patch.py <ssh别名> --conf ... --remove     # 摘掉这三块（卸载用）
  python tools/nginx_patch.py --no-reload          # 只改文件、不 nginx -t / reload（自测用）
  python tools/nginx_patch.py --ws-port 28910 --hub-port 28080 --webroot /var/www/cyber-probe
                                                  # 覆盖端口与站点目录（默认值就是这套）
"""
import base64
import os
import subprocess
import sys

ARGS = list(sys.argv[1:])
LOCAL = '--local' in ARGS
REMOVE = '--remove' in ARGS
NO_RELOAD = '--no-reload' in ARGS
CONF = ''                  # 没给就报错：公开工具不该猜别人的站点文件名
HOST = os.environ.get('PATCH_HOST') or ''   # ssh 别名（--local 时不用）
WS_PORT = '28910'          # /chicken/ws 反代到的联机服端口
HUB_PORT = '28080'         # /chicken/api/ 反代到的 hub 端口
WEBROOT = '/var/www/cyber-probe'   # 静态站目录（location 里用 alias 指过来，目录名任意）
DOMAIN = ''                        # 只用于日志，不确定就不填
VALIDATE_CMD = None                # 自检命令；None = 默认（非 --no-reload 时用 `nginx -t`）

_i = 0
while _i < len(ARGS):
    a = ARGS[_i]
    if a in ('--conf', '--ws-port', '--hub-port', '--webroot', '--validate') and _i + 1 < len(ARGS):
        v = ARGS[_i + 1]
        if a == '--conf':
            CONF = v
        elif a == '--ws-port':
            WS_PORT = v
        elif a == '--hub-port':
            HUB_PORT = v
        elif a == '--validate':
            VALIDATE_CMD = v
        else:
            WEBROOT = v
        _i += 2
        continue
    if a in ('--local', '--remove', '--no-reload'):
        _i += 1
        continue
    HOST = a
    _i += 1

if VALIDATE_CMD is None:
    VALIDATE_CMD = '' if NO_RELOAD else 'nginx -t'

NGINX_ROOT = WEBROOT.rsplit('/', 1)[0] or '/'

if not CONF:
    print('✗ 请用 --conf 指定 nginx 站点配置文件（例如 /etc/nginx/conf.d/your-site.conf）', file=sys.stderr)
    sys.exit(2)
if not LOCAL and not HOST:
    print('✗ 请给出 ssh 别名（或用 --local 在本机改文件；也可设环境变量 PATCH_HOST）', file=sys.stderr)
    sys.exit(2)

API_AND_STATIC = """    # ---- cyber-probe：静态站 + 把 /chicken/api/* 反代到 hub ----
    # 必须排在 catch-all「location /」前面；^~ 前缀匹配优先于 location /，不会落到 hub。
    # ⚠ 公开路径固定是 /chicken/：主题 jikasei 的入口按这个路径自动认（见 README）。
    location = /chicken {
        return 301 /chicken/;
    }

    location ^~ /chicken/api/ {
        proxy_pass http://127.0.0.1:__HUB_PORT__/api/;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For   $remote_addr;
        proxy_set_header X-Real-IP         $remote_addr;
        add_header Cache-Control "no-store" always;      # 探针数据不缓存
    }

    location ^~ /chicken/ {
        alias __WEBROOT__/;
        index index.html;
        add_header Cache-Control "no-cache" always;      # 站点很小，改了立刻可见
    }
"""

WS_BLOCK = """    # cyber-probe 联机游戏服（Python asyncio，systemd: cyber-probe.service，只监听回环）
    # Connection 用字面量 "upgrade"、客户端 IP 用 $remote_addr：**不引用任何需要自定义 map 的
    # 变量**（如 $connection_upgrade / $real_client_ip）。引用未定义变量会让 nginx -t 直接失败，
    # 而别人的机器不一定有那份 map。CF 橙云在前面时真正的访客 IP 靠 CF-IPCountry 透传取国旗。
    location = /chicken/ws {
        proxy_pass http://127.0.0.1:__WS_PORT__;
        proxy_http_version 1.1;
        proxy_set_header Upgrade    $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host              $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For   $remote_addr;
        proxy_set_header X-Real-IP         $remote_addr;
        # 访客鸡的国旗 = 访客 IP 所在地：CF 橙云会在回源请求里带 CF-IPCountry，透传给游戏服
        proxy_set_header CF-IPCountry      $http_cf_ipcountry;
        proxy_buffering off;
        proxy_read_timeout 1h;
        proxy_send_timeout 1h;
    }

"""

API_AND_STATIC = API_AND_STATIC.replace('__HUB_PORT__', HUB_PORT) \
                               .replace('__WEBROOT__', WEBROOT)
WS_BLOCK = WS_BLOCK.replace('__WS_PORT__', WS_PORT)

# ⚠ api 块尾部这个空行是**插入时补的分隔**，它也是「改动」的一部分：
#   摘除时若按不含空行的字面量去找，每次贴→摘都会在原地留下一个孤零零的空行，
#   「贴→摘 字节一致」这条承诺就破了（nginx 路径实测踩到过）。所以这里是**同一份字节**：插入用它、摘除也用它。
API_CHUNK = API_AND_STATIC + "\n"


REMOTE_ADD = r'''
import sys, shutil, datetime, pathlib, base64, subprocess
conf = pathlib.Path(sys.argv[1])
api_static = base64.b64decode(sys.argv[2]).decode()
ws_block = base64.b64decode(sys.argv[3]).decode()
validate = ''
for _a in sys.argv[1:]:
    if _a.startswith('--validate='):
        validate = _a.split('=', 1)[1]
        break
if validate.strip().isdigit():
    # 防呆：命令位置被端口类参数顶掉时，别拿它去 bash -c（caddy_patch 曾因此静默回滚）
    print("ERR  自检命令像是个端口号（%s）—— 参数按位置传错了，未改动任何文件" % validate, file=sys.stderr)
    sys.exit(5)
src = conf.read_text(encoding="utf-8")
changed = []

if "/chicken/ws" not in src:
    anchor = "    location ^~ /chicken/ {" if "    location ^~ /chicken/ {" in src else "    location / {"
    if src.count(anchor) != 1:
        print("ERR  找不到唯一锚点，需人工确认", file=sys.stderr); sys.exit(2)
    src = src.replace(anchor, ws_block + anchor)
    changed.append("ws")

if "/chicken/api/" not in src:
    anchor = "    location / {"
    if src.count(anchor) != 1:
        print("ERR  找不到唯一 catch-all 锚点，需人工确认", file=sys.stderr); sys.exit(2)
    # api_static 里已经带着尾部的分隔空行（见调用方传的 API_CHUNK），别再自己补一个
    src = src.replace(anchor, api_static + anchor)
    changed.append("api+static")

if not changed and "CF-IPCountry" not in src:
    # /chicken/ws 早就存在（老部署）→ 单独把 CF 国家码头补进去（幂等：有就跳过）
    i = src.find("location = /chicken/ws")
    j = src.find("\n    }\n", i) if i >= 0 else -1
    if i >= 0 and j > i:
        block = src[i:j]
        anchor = None
        for cand in ("        proxy_set_header X-Real-IP         $real_client_ip;",
                     "        proxy_set_header X-Real-IP         $remote_addr;"):
            if cand in block:
                anchor = cand
                break
        if anchor:
            nb = block.replace(anchor, anchor + "\n        # 访客鸡的国旗 = 访客 IP 所在地：CF 橙云会在回源请求里带 CF-IPCountry，透传给游戏服\n        proxy_set_header CF-IPCountry      $http_cf_ipcountry;", 1)
            src = src[:i] + nb + src[j:]
            changed.append("cf-ipcountry")

if not changed:
    print("SKIP  配置里已有这三块（含 CF-IPCountry 透传），未改动")
    sys.exit(0)
# 备份名带动作后缀：install 与 uninstall 若落在同一秒（脚本化验证就是这样），
# 秒级时间戳会让「卸载前备份」把「安装前的原件备份」覆盖掉 —— 那份才是保命的。
bak = conf.with_name(conf.name + ".bak-" + datetime.datetime.now().strftime("%Y%m%d-%H%M%S") + "-add")
shutil.copy2(conf, bak)
conf.write_text(src, encoding="utf-8", newline="")   # newline="" → 不翻译换行（在 Windows 上跑 --local 也不会把整份配置改成 CRLF）
print("PATCHED " + "+".join(changed) + "  备份 -> " + str(bak))

# 写完先自检：不过就**回滚**——绝不能把别人的 web 服务留在坏配置上（reload 后整站 502）。
if validate:
    p = subprocess.run(['bash', '-c', validate], capture_output=True, text=True)
    if p.returncode != 0:
        shutil.copy2(bak, conf)
        print((p.stderr or p.stdout or '').strip()[:900], file=sys.stderr)
        print("ERR  「%s」没过 → 已回滚到改动前（%s 保持原样）" % (validate, conf), file=sys.stderr)
        sys.exit(4)
    print("    自检通过：" + validate)
'''

REMOTE_REMOVE = r'''
import sys, shutil, datetime, pathlib, base64, re
conf = pathlib.Path(sys.argv[1])
literals = [base64.b64decode(x).decode() for x in sys.argv[2:]]
src = conf.read_text(encoding="utf-8")
notes = []

# ① 先按"当年插入时的原文"整段摘掉（我们的补丁是逐字插入的，正常情况这一刀就够了）
for lit in literals:
    if lit in src:
        src = src.replace(lit, "", 1)
        notes.append(lit.strip().splitlines()[0][:34])

# ② 兜底/主力：按 location 路径摘块（对付手工改过/老版本留下的形态），只认 /chicken 自己的
def drop_block(text, needle):
    """摘掉匹配 needle 的 location 块，并连带摘掉它正上方的连续注释行"""
    lines = text.splitlines(keepends=True)
    out, i, n, dropped = [], 0, len(lines), 0
    while i < n:
        ln = lines[i]
        if ln.lstrip().startswith("location") and needle in ln:
            indent = len(ln) - len(ln.lstrip())
            i += 1
            while i < n:
                cur = lines[i]
                if cur.strip() == "}" and (len(cur) - len(cur.lstrip())) == indent:
                    i += 1
                    break
                i += 1
            # 上方的连续注释行也一并摘掉（注释随块走；遇到空行就停，不会吃到别人家的注释）
            while out and out[-1].lstrip().startswith("#"):
                out.pop()
            dropped += 1
            continue
        out.append(ln)
        i += 1
    return "".join(out), dropped

for needle in ("/chicken/ws", "/chicken/api/", "/chicken/"):
    src, k = drop_block(src, needle)
    if k:
        notes.append("按路径摘 " + needle)
src, k = drop_block(src, "= /chicken")
if k:
    notes.append("按路径摘 = /chicken")

while "\n\n\n" in src:
    src = src.replace("\n\n\n", "\n\n")

if not notes:
    print("SKIP  配置里没有 cyber-probe 的 location 块，无需移除")
    sys.exit(0)
bak = conf.with_name(conf.name + ".bak-" + datetime.datetime.now().strftime("%Y%m%d-%H%M%S") + "-rm")
shutil.copy2(conf, bak)
conf.write_text(src, encoding="utf-8", newline="")   # newline="" → 不翻译换行
print("REMOVED " + "; ".join(notes) + "  备份 -> " + str(bak))
'''


def run_py(script_text, extra):
    """把一段 python 喂给远端（或本机）的 python3 执行"""
    if LOCAL:
        cmd = [sys.executable or 'python3', '-'] + extra
    else:
        cmd = ['ssh', HOST, 'python3 - ' + ' '.join(extra)]
    r = subprocess.run(cmd, input=script_text, capture_output=True, text=True)
    print((r.stdout or '').strip())
    if r.returncode != 0:
        print((r.stderr or '').strip(), file=sys.stderr)
        sys.exit(r.returncode)


def run_cmd(cmd):
    if LOCAL:
        r = subprocess.run(['bash', '-c', cmd], capture_output=True, text=True)
    else:
        r = subprocess.run(['ssh', HOST, cmd], capture_output=True, text=True)
    print((r.stdout or '').strip())
    if r.returncode != 0:
        print((r.stderr or '').strip(), file=sys.stderr)
        sys.exit(r.returncode)


b64 = lambda s: base64.b64encode(s.encode()).decode()
where = '本机' if LOCAL else HOST

if REMOVE:
    run_py(REMOTE_REMOVE, [CONF, b64(WS_BLOCK), b64(API_CHUNK)])
    if not NO_RELOAD:
        run_cmd('nginx -t && { systemctl is-active --quiet nginx && systemctl reload nginx || echo "（nginx 没在跑，配置已改好，下次启动生效）"; }')
        print('nginx 配置已改好（已移除 cyber-probe 的三块）')
else:
    args = [CONF, b64(API_CHUNK), b64(WS_BLOCK)]
    # ⚠ 自检命令一律用 `--validate=<命令>` 传：按位置传很容易被以后新增的参数顶掉
    #   （caddy_patch 就因此把 hub 端口当成命令，一路静默回滚；见那边的注释）
    if VALIDATE_CMD:
        args.append('--validate=' + VALIDATE_CMD)
    run_py(REMOTE_ADD, args)
    if not NO_RELOAD:
        run_cmd('(systemctl is-active --quiet nginx && systemctl reload nginx) || { systemctl restart nginx && echo "（nginx 本来没在跑，已启动以让配置生效）"; }')
        print('nginx 配置已生效')
print(f'（目标：{where} {CONF}）')
