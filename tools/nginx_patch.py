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
PREFIX = '/chicken/'       # 对外挂载路径（用户可用 --path 改成 /farm/ 之类；必须以 / 开头）
WS_PORT = '28910'          # <前缀>ws 反代到的联机服端口
HUB_PORT = '28080'         # /chicken/api/ 反代到的 hub 端口
WEBROOT = '/var/www/cyber-probe'   # 静态站目录（location 里用 alias 指过来，目录名任意）
DOMAIN = ''                        # 只用于日志，不确定就不填
VALIDATE_CMD = None                # 自检命令；None = 默认（非 --no-reload 时用 `nginx -t`）

_i = 0
while _i < len(ARGS):
    a = ARGS[_i]
    if a in ('--conf', '--ws-port', '--hub-port', '--webroot', '--validate', '--path') and _i + 1 < len(ARGS):
        v = ARGS[_i + 1]
        if a == '--conf':
            CONF = v
        elif a == '--ws-port':
            WS_PORT = v
        elif a == '--hub-port':
            HUB_PORT = v
        elif a == '--validate':
            VALIDATE_CMD = v
        elif a == '--path':
            PREFIX = v
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

# 挂载路径规范化：'chicken' → '/chicken/'；'/' 表示独立域名挂在根（installer 会走 vhost 模式）
PREFIX = '/' + PREFIX.strip('/') + '/'
if PREFIX == '//':
    print('✗ --path / 表示「独立域名挂在根」，请用 installer 的 domain 模式；本工具只负责往已有站点里挂子路径', file=sys.stderr)
    sys.exit(2)
PREFIX_NS = PREFIX.rstrip('/')          # '/chicken'
NGINX_ROOT = WEBROOT.rsplit('/', 1)[0] or '/'

if not CONF:
    print('✗ 请用 --conf 指定 nginx 站点配置文件（例如 /etc/nginx/conf.d/your-site.conf）', file=sys.stderr)
    sys.exit(2)
if not LOCAL and not HOST:
    print('✗ 请给出 ssh 别名（或用 --local 在本机改文件；也可设环境变量 PATCH_HOST）', file=sys.stderr)
    sys.exit(2)

API_AND_STATIC = """    # ---- cyber-probe：静态站 + 把 /chicken/api/* 反代到 hub ----
    # 必须排在 catch-all「location /」前面；^~ 前缀匹配优先于 location /，不会落到 hub。
    # 挂载路径由 installer 的 --path 决定（默认 /chicken/）
    location = __PREFIX_NS__ {
        return 301 __PREFIX__;
    }

    location ^~ __PREFIX__api/ {
        proxy_pass http://127.0.0.1:__HUB_PORT__/api/;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For   $remote_addr;
        proxy_set_header X-Real-IP         $remote_addr;
        add_header Cache-Control "no-store" always;      # 探针数据不缓存
    }

    location ^~ __PREFIX__ {
        alias __WEBROOT__/;
        index index.html;
        add_header Cache-Control "no-cache" always;      # 站点很小，改了立刻可见
    }
"""

WS_BLOCK = """    # cyber-probe 联机游戏服（Python asyncio，systemd: cyber-probe.service，只监听回环）
    # Connection 用字面量 "upgrade"、客户端 IP 用 $remote_addr：**不引用任何需要自定义 map 的
    # 变量**（如 $connection_upgrade / $real_client_ip）。引用未定义变量会让 nginx -t 直接失败，
    # 而别人的机器不一定有那份 map。CF 橙云在前面时真正的访客 IP 靠 CF-IPCountry 透传取国旗。
    location = __PREFIX__ws {
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

API_AND_STATIC = (API_AND_STATIC.replace('__HUB_PORT__', HUB_PORT)
                                 .replace('__WEBROOT__', WEBROOT)
                                 .replace('__PREFIX_NS__', PREFIX_NS)
                                 .replace('__PREFIX__', PREFIX))
WS_BLOCK = WS_BLOCK.replace('__WS_PORT__', WS_PORT).replace('__PREFIX__', PREFIX)

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

# 参数从命令行按 --k=v 传进来（位置参数已经给了 b64 载荷，插队会错位）
ws_port_v = hub_port_v = webroot_v = ""
for _a in sys.argv[1:]:
    if _a.startswith("--ws-port="):
        ws_port_v = _a.split("=", 1)[1]
    elif _a.startswith("--hub-port="):
        hub_port_v = _a.split("=", 1)[1]
    elif _a.startswith("--webroot="):
        webroot_v = _a.split("=", 1)[1]

if "__WS_LOC__" not in src:
    anchor = "    location ^~ __PREFIX__ {" if "    location ^~ __PREFIX__ {" in src else "    location / {"
    if src.count(anchor) != 1:
        print("ERR  找不到唯一锚点，需人工确认", file=sys.stderr); sys.exit(2)
    src = src.replace(anchor, ws_block + anchor)
    changed.append("ws")

if "__PREFIX__api/" not in src:
    anchor = "    location / {"
    if src.count(anchor) != 1:
        print("ERR  找不到唯一 catch-all 锚点，需人工确认", file=sys.stderr); sys.exit(2)
    # api_static 里已经带着尾部的分隔空行（见调用方传的 API_CHUNK），别再自己补一个
    src = src.replace(anchor, api_static + anchor)
    changed.append("api+static")

# 三块都在，但**参数变了**（换过 --hub-port / --ws-port / --webroot）→ 就地更新。
# 以前这里直接 SKIP：用户改了 hub 端口重装，/api 仍指向老端口，装完 502（真机实测）。
if not changed and "__WS_LOC__" in src and "__PREFIX__api/" in src and ws_port_v and hub_port_v:
    # ⚠ 这两个占位符在脚本下发前会被替换成实际前缀（见文件末尾 .replace('__WS_LOC__', PREFIX+'ws')），
    #   所以这里写"在"才是"块已存在"。第一版写成 not in，分支永远不成立（selftest 抓到）。
    import re as _re
    for _label, _pat, _rep in (
        ("ws-port",
         r"(location = __PREFIX__ws\s*\{.*?proxy_pass http://127\.0\.0\.1:)\d+",
         lambda m: m.group(1) + str(ws_port_v)),
        ("hub-port",
         r"(location \^~ __PREFIX__api/\s*\{.*?proxy_pass http://127\.0\.0\.1:)\d+/api/",
         lambda m: m.group(1) + str(hub_port_v) + "/api/"),
        ("webroot",
         r"(location \^~ __PREFIX__\s*\{[^}]*?alias\s+)\S+?/;",
         lambda m: m.group(1) + str(webroot_v or "").rstrip("/") + "/;"),
    ):
        new_src, n = _re.subn(_pat, _rep, src, count=1, flags=_re.S)
        if n and new_src != src:
            src = new_src
            changed.append(_label)

if not changed and "CF-IPCountry" not in src:
    # /chicken/ws 早就存在（老部署）→ 单独把 CF 国家码头补进去（幂等：有就跳过）
    i = src.find("location = __PREFIX__ws")
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
# 备份只留最近 8 份：反复 install 会在配置目录里堆一堆 .bak-<时间>-add
try:
    olds = sorted(conf.parent.glob(conf.name + ".bak-*"))
    for f in olds[:-8]:
        f.unlink()
except Exception:
    pass
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
            # 我们插入的块尾部自带一个分隔空行（WS_BLOCK / API_CHUNK 都以空行结尾）：
            # ① 逐字删除会连它一起删掉，走兜底时得手动吃掉 —— 否则每次摘块都在原地留一个孤零零的空行，
            # 「贴→摘 字节一致」就破了（真机上切 path→domain 时实测踩到）。
            while i < n and lines[i].strip() == "":
                i += 1
            dropped += 1
            continue
        out.append(ln)
        i += 1
    return "".join(out), dropped

for needle in ("__PREFIX__ws", "__PREFIX__api/", "__PREFIX__"):
    src, k = drop_block(src, needle)
    if k:
        notes.append("按路径摘 " + needle)
src, k = drop_block(src, "= __PREFIX_NS__")
if k:
    notes.append("按路径摘 = /chicken")

while "\n\n\n" in src:
    src = src.replace("\n\n\n", "\n\n")

# ③ 兜底：清掉**孤立的 cyber-probe 注释段**（块被摘掉后，头顶那几行注释会跟着空行漂在配置里）。
#    判据：连续注释行里提到 cyber-probe，且紧接着是空行 —— 说明下面已经没有属于它的 location 了。
_lines = src.splitlines(keepends=True)
_out, _i, _dropped = [], 0, 0
while _i < len(_lines):
    _ln = _lines[_i]
    if _ln.lstrip().startswith('#') and 'cyber-probe' in _ln:
        _j = _i
        while _j < len(_lines) and _lines[_j].lstrip().startswith('#'):
            _j += 1
        if _j < len(_lines) and _lines[_j].strip() == '':
            _i = _j
            while _i < len(_lines) and _lines[_i].strip() == '':
                _i += 1
            _dropped += 1
            continue
    _out.append(_ln)
    _i += 1
if _dropped:
    src = ''.join(_out)
    notes.append('清掉 %d 段孤立注释' % _dropped)

if not notes:
    print("SKIP  配置里没有 cyber-probe 的 location 块，无需移除")
    sys.exit(0)
bak = conf.with_name(conf.name + ".bak-" + datetime.datetime.now().strftime("%Y%m%d-%H%M%S") + "-rm")
shutil.copy2(conf, bak)
conf.write_text(src, encoding="utf-8", newline="")   # newline="" → 不翻译换行
print("REMOVED " + "; ".join(notes) + "  备份 -> " + str(bak))
'''


# 把占位符换成实际前缀（远程脚本是字符串模板，替换后再 b64/直传）
REMOTE_ADD = (REMOTE_ADD.replace('__PREFIX_NS__', PREFIX_NS).replace('__PREFIX__', PREFIX)
                        .replace('__WS_LOC__', PREFIX + 'ws'))
REMOTE_REMOVE = (REMOTE_REMOVE.replace('__PREFIX_NS__', PREFIX_NS).replace('__PREFIX__', PREFIX))


def run_py(script_text, extra):
    """把一段 python 喂给远端（或本机）的 python3 执行；返回它的 stdout 供调用方判断实际做了什么"""
    if LOCAL:
        cmd = [sys.executable or 'python3', '-'] + extra
    else:
        cmd = ['ssh', HOST, 'python3 - ' + ' '.join(extra)]
    r = subprocess.run(cmd, input=script_text, capture_output=True, text=True)
    out = r.stdout or ''
    print(out.strip())
    if r.returncode != 0:
        print((r.stderr or '').strip(), file=sys.stderr)
        sys.exit(r.returncode)
    return out


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
    out = run_py(REMOTE_REMOVE, [CONF, b64(WS_BLOCK), b64(API_CHUNK)])
    if 'REMOVED' not in out:
        # 本来就没块（内层已打印 SKIP）：那就别去碰服务，也别报"已移除"
        print('（配置里没有 cyber-probe 的块，未动服务）')
    elif not NO_RELOAD:
        run_cmd('nginx -t && { systemctl is-active --quiet nginx && systemctl reload nginx || echo "（nginx 没在跑，配置已改好，下次启动生效）"; }')
        print('nginx 配置已改好（已移除 cyber-probe 的三块）')
else:
    args = [CONF, b64(API_CHUNK), b64(WS_BLOCK)]
    # ⚠ 自检命令一律用 `--validate=<命令>` 传：按位置传很容易被以后新增的参数顶掉
    #   （caddy_patch 就因此把 hub 端口当成命令，一路静默回滚；见那边的注释）
    args += ['--ws-port=' + str(WS_PORT), '--hub-port=' + str(HUB_PORT), '--webroot=' + WEBROOT]
    if VALIDATE_CMD:
        args.append('--validate=' + VALIDATE_CMD)
    out = run_py(REMOTE_ADD, args)
    patched = 'PATCHED' in out
    if not NO_RELOAD:
        run_cmd('(systemctl is-active --quiet nginx && systemctl reload nginx) || { systemctl restart nginx && echo "（nginx 本来没在跑，已启动以让配置生效）"; }')
        print('nginx 配置已生效' if patched else 'nginx 配置本来就是目标状态（文件未改动，已 reload 一次确认生效）')
print(f'（目标：{where} {CONF}）')
