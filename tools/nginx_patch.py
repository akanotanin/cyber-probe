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
import sys, os, shutil, datetime, pathlib, base64, subprocess, re
conf = pathlib.Path(sys.argv[1])
api_static = base64.b64decode(sys.argv[2]).decode()
ws_block = base64.b64decode(sys.argv[3]).decode()


def write_text_atomic(path, text):
    """同目录临时文件 + os.replace：中途崩溃/磁盘满不会留下半截配置（截断直写的老做法
    会让下一次 nginx reload 直接炸）。newline="" 表示不翻译换行（3.9 也有这个参数）。"""
    tmp = path.with_name(path.name + ".tmp-cyberprobe")
    with open(tmp, "w", encoding="utf-8", newline="") as f:
        f.write(text)
    os.replace(str(tmp), str(path))


def _blocks(text):
    """粗切出所有「xxx { ... }」块（按花括号配对）：[(start, end, body)]"""
    out = []
    for m in re.finditer(r'(?m)^[ \t]*[^\s#][^\n{]*\{', text):
        depth, i = 1, m.end()
        while i < len(text) and depth > 0:
            c = text[i]
            if c == '{':
                depth += 1
            elif c == '}':
                depth -= 1
            i += 1
        out.append((m.start(), i, text[m.start():i]))
    return out


def _catch_all(text, hub_up):
    """找 catch-all 的 `location / {`（任意缩进）。

    一个文件里有两个 server（HTTP→HTTPS 跳转 + TLS）时，选**块里含 hub 上游**的那个。
    以前要求整份文件里这一段唯一且必须 4 空格缩进：tab 缩进的站点、或带跳转 server 的
    站点都会直接 exit 2，把站点留在「静态站装好、反代没配」的半装状态（2026-11-03 修）。
    """
    cands = list(re.finditer(r'(?m)^[ \t]*location[ \t]+/[ \t]*\{', text))
    if not cands:
        return None
    if len(cands) == 1:
        return cands[0]
    servers = [b for b in _blocks(text) if re.match(r'[ \t]*server[ \t]*\{', b[2])]
    for needle in (hub_up, 'proxy_pass'):
        for s, e, body in servers:
            if needle in body:
                for m in cands:
                    if s <= m.start() < e:
                        return m
    return cands[0]


def _match_indent(m):
    """正则命中行首的缩进。⚠ m 的模式以 `^[ \\t]*` 开头 → m.start() 已经在行首，
    不能再往前找行首（那样永远得到空串，插入的块会顶格）。"""
    s = m.group(0)
    return s[:len(s) - len(s.lstrip(' \t'))]


def _reindent(block, ind):
    """把插入块开头的 4 空格缩进换成锚点所在的缩进（tab 缩进的站点看着才整齐）"""
    if ind == '    ':
        return block
    return '\n'.join((ind + ln[4:]) if ln.startswith('    ') else ln for ln in block.split('\n'))

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
    hub_up = "127.0.0.1:" + str(hub_port_v)      # 用来在多 server 文件里认「哪个块才是 hub 站点」
    # 优先贴在站点自己的 `location ^~ <前缀> {` 前面；没有就贴 catch-all 前面（缩进任意）
    m = re.search(r'(?m)^[ \t]*location[ \t]+\^~[ \t]+' + re.escape("__PREFIX__") + r'[ \t]*\{', src)
    if m is None:
        m = _catch_all(src, hub_up)
    if m is None:
        print("ERR  找不到 catch-all「location / {」—— 本文件里没有可插块的 server 块", file=sys.stderr)
        sys.exit(2)
    ind = _match_indent(m)
    src = src[:m.start()] + _reindent(ws_block, ind) + src[m.start():]
    changed.append("ws")

if "__PREFIX__api/" not in src:
    hub_up = "127.0.0.1:" + str(hub_port_v)
    m = _catch_all(src, hub_up)
    if m is None:
        print("ERR  找不到 catch-all「location / {」—— 本文件里没有可插块的 server 块", file=sys.stderr)
        sys.exit(2)
    ind = _match_indent(m)
    # api_static 里已经带着尾部的分隔空行（见调用方传的 API_CHUNK），别再自己补一个
    src = src[:m.start()] + _reindent(api_static, ind) + src[m.start():]
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
    j = -1
    if i >= 0:
        k, depth = src.find("{", i), 0
        while 0 <= k < len(src):
            if src[k] == '{':
                depth += 1
            elif src[k] == '}':
                depth -= 1
                if depth == 0:
                    j = k
                    break
            k += 1
    if i >= 0 and j > i:
        block = src[i:j]
        mline = None
        for pat in (r'(?m)^[ \t]*proxy_set_header[ \t]+X-Real-IP[ \t]+\$real_client_ip;[ \t]*$',
                    r'(?m)^[ \t]*proxy_set_header[ \t]+X-Real-IP[ \t]+\$remote_addr;[ \t]*$'):
            mline = re.search(pat, block)
            if mline:
                break
        if mline:
            ind = _match_indent(mline)
            ins = ("\n" + ind + "# 访客鸡的国旗 = 访客 IP 所在地：CF 橙云会在回源请求里带 CF-IPCountry，透传给游戏服"
                   + "\n" + ind + "proxy_set_header CF-IPCountry      $http_cf_ipcountry;")
            nb = block[:mline.end()] + ins + block[mline.end():]
            src = src[:i] + nb + src[j:]
            changed.append("cf-ipcountry")

if not changed:
    print("SKIP  配置里已有这三块（含 CF-IPCountry 透传），未改动")
    sys.exit(0)
# 备份名带动作后缀：install 与 uninstall 若落在同一秒（脚本化验证就是这样），
# 秒级时间戳会让「卸载前备份」把「安装前的原件备份」覆盖掉 —— 那份才是保命的。
bak = conf.with_name(conf.name + ".bak-" + datetime.datetime.now().strftime("%Y%m%d-%H%M%S") + "-add")
shutil.copy2(conf, bak)
write_text_atomic(conf, src)   # 原子写；newline="" → 不翻译换行（Windows 上跑 --local 也不会改成 CRLF）
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
    p = subprocess.run(['bash', '-c', validate], capture_output=True, text=True,
                       encoding='utf-8', errors='replace')
    if p.returncode != 0:
        shutil.copy2(bak, conf)
        print((p.stderr or p.stdout or '').strip()[:900], file=sys.stderr)
        print("ERR  「%s」没过 → 已回滚到改动前（%s 保持原样）" % (validate, conf), file=sys.stderr)
        sys.exit(4)
    print("    自检通过：" + validate)
'''

REMOTE_REMOVE = r'''
import sys, os, shutil, datetime, pathlib, base64, re, subprocess
conf = pathlib.Path(sys.argv[1])
args = sys.argv[2:]
validate = ''
_keep = []
for _a in args:
    if _a.startswith('--validate='):
        validate = _a.split('=', 1)[1]
    else:
        _keep.append(_a)
literals = [base64.b64decode(x).decode() for x in _keep]
src = conf.read_text(encoding="utf-8")
notes = []


def write_text_atomic(path, text):
    tmp = path.with_name(path.name + ".tmp-cyberprobe")
    with open(tmp, "w", encoding="utf-8", newline="") as f:
        f.write(text)
    os.replace(str(tmp), str(path))

# ① 先按"当年插入时的原文"整段摘掉（我们的补丁是逐字插入的，正常情况这一刀就够了）
for lit in literals:
    if lit in src:
        src = src.replace(lit, "", 1)
        notes.append(lit.strip().splitlines()[0][:34])

# ② 兜底/主力：按 location 路径摘块（对付手工改过/老版本留下的形态），只认 /chicken 自己的
def drop_block(text, needle):
    """摘掉匹配 needle 的 location 块，并连带摘掉它正上方的连续注释行。

    ⚠ 只摘「我们插的」块：判据是块体里有本工具的指纹（CF-IPCountry / Connection "upgrade" /
    cyber-probe 注释 / 反代 /api/）。以前只按路径匹配 —— 用户自己写的 location /chicken/
    会被当成补丁静默删掉（2026-11-03 复查）。
    """
    sig = ('CF-IPCountry', 'Connection "upgrade"', 'cyber-probe', '/api/', '站点很小，改了立刻可见')
    lines = text.splitlines(keepends=True)
    out, i, n, dropped = [], 0, len(lines), 0
    while i < n:
        ln = lines[i]
        if ln.lstrip().startswith("location") and needle in ln:
            indent = len(ln) - len(ln.lstrip())
            j = i + 1
            while j < n:
                cur = lines[j]
                if cur.strip() == "}" and (len(cur) - len(cur.lstrip())) == indent:
                    j += 1
                    break
                j += 1
            body = "".join(lines[i:j])
            # 301 跳转块没有 proxy/注释指纹，但形态很特定：`location = <前缀> { return 301 <前缀>; }`
            ours = any(s in body for s in sig) or (needle.startswith('=') and 'return 301' in body)
            if not ours:
                out.append(ln)          # 不是我们的块（或指纹不明）→ 原样留着，别替用户删配置
                i += 1
                continue
            i = j
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
write_text_atomic(conf, src)   # 原子写；newline="" → 不翻译换行
print("REMOVED " + "; ".join(notes) + "  备份 -> " + str(bak))

# 卸载同样「自检不过就回滚」：以前只校验不回滚，改坏了别人的 nginx，现场连原件都没了
if validate:
    p = subprocess.run(['bash', '-c', validate], capture_output=True, text=True,
                       encoding='utf-8', errors='replace')
    if p.returncode != 0:
        shutil.copy2(bak, conf)
        print((p.stderr or p.stdout or '').strip()[:900], file=sys.stderr)
        print("ERR  「%s」没过 → 已回滚（配置恢复成卸载前）" % validate, file=sys.stderr)
        sys.exit(4)
    print("    自检通过：" + validate)
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
        import shlex
        # 不 quote 的话 `--validate=nginx -t` 会被拆成两个参数，内层只拿到「--validate=nginx」，
        # 于是执行裸 nginx（不带 -t）—— 配置根本没校验，改坏了也不会回滚。
        cmd = ['ssh', HOST, 'python3 - ' + ' '.join(shlex.quote(x) for x in extra)]
    r = subprocess.run(cmd, input=script_text, capture_output=True, text=True,
                       encoding='utf-8', errors='replace')
    out = r.stdout or ''
    print(out.strip())
    if r.returncode != 0:
        print((r.stderr or '').strip(), file=sys.stderr)
        sys.exit(r.returncode)
    return out


def run_cmd(cmd):
    if LOCAL:
        r = subprocess.run(['bash', '-c', cmd], capture_output=True, text=True,
                           encoding='utf-8', errors='replace')
    else:
        r = subprocess.run(['ssh', HOST, cmd], capture_output=True, text=True,
                           encoding='utf-8', errors='replace')
    print((r.stdout or '').strip())
    if r.returncode != 0:
        print((r.stderr or '').strip(), file=sys.stderr)
        sys.exit(r.returncode)


b64 = lambda s: base64.b64encode(s.encode()).decode()
where = '本机' if LOCAL else HOST

if REMOVE:
    args = [CONF, b64(WS_BLOCK), b64(API_CHUNK)]
    if VALIDATE_CMD:
        args.append('--validate=' + VALIDATE_CMD)
    out = run_py(REMOTE_REMOVE, args)
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
