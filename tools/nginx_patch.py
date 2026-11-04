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
import shutil
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
# 数据源：决定 /api 里哪个 WebSocket 需要单独的 Upgrade location。
#   komari（默认，兼容旧调用）/ monitor → /api/clients
#   nezha → /api/v1/ws/server
SOURCE = 'komari'
VALIDATE_CMD = None                # 自检命令；None = 默认（非 --no-reload 时用 `nginx -t`）

_i = 0
while _i < len(ARGS):
    a = ARGS[_i]
    if a in ('--conf', '--ws-port', '--hub-port', '--webroot', '--validate', '--path', '--source') and _i + 1 < len(ARGS):
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
        elif a == '--source':
            SOURCE = v
        else:
            WEBROOT = v
        _i += 2
        continue
    if a in ('--local', '--remove', '--no-reload'):
        _i += 1
        continue
    HOST = a
    _i += 1

if SOURCE not in ('auto', 'monitor', 'komari', 'nezha'):
    print('✗ --source 只接受 auto / monitor / komari / nezha（现在：%r）' % SOURCE, file=sys.stderr)
    sys.exit(2)
# auto/monitor 沿用历史上一直插着的 Komari 块（monitor 模式下它只是没人访问，留着无害）。
if SOURCE in ('auto', 'monitor'):
    SOURCE = 'komari'

if VALIDATE_CMD is None:
    if NO_RELOAD:
        VALIDATE_CMD = ''
    elif shutil.which('nginx'):
        VALIDATE_CMD = 'nginx -t'
    else:
        # 机器上已经没有 nginx 二进制（卸载残留配置时常见）：没法自检，但也不能因此
        # 把要摘的块留在用户配置里。打警告后跳过校验；安装场景会在后续探活里暴露。
        print('WARN  找不到 nginx 命令，跳过 nginx -t（配置仍会写）', file=sys.stderr)
        VALIDATE_CMD = ''

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

KOMARI_CLIENTS = """    # cyber-probe / Komari 的实时数据走 WebSocket /api/clients（monitor 模式不用这段，但留着无害）。
    # exact match 优先级高于下面的 ^~ /chicken/api/；不配 Upgrade 的话 Komari 会回 400。
    location = __PREFIX__api/clients {
        # cyber-probe：Komari 实时数据 WebSocket（卸载按这行认领）
        proxy_pass http://127.0.0.1:__HUB_PORT__/api/clients;
        proxy_http_version 1.1;
        proxy_set_header Upgrade    $http_upgrade;
        proxy_set_header Connection "upgrade";
        # Komari 的 WS 也会校验 Origin 与 Host 同源：$host 会丢 :8080，
        # 非 80/443 端口上必须用 $http_host 原样保留端口。
        proxy_set_header Host              $http_host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For   $remote_addr;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_buffering off;
        proxy_read_timeout 1h;
        proxy_send_timeout 1h;
    }
"""

NEZHA_CLIENTS = """    # cyber-probe / 哪吒监控（Nezha）的实时状态流走 WebSocket /api/v1/ws/server。
    # exact match 优先级高于下面的 ^~ /chicken/api/；不配 Upgrade 的话哪吒会回 400/426。
    location = __PREFIX__api/v1/ws/server {
        # cyber-probe：哪吒实时数据 WebSocket（卸载按这行认领）
        proxy_pass http://127.0.0.1:__HUB_PORT__/api/v1/ws/server;
        proxy_http_version 1.1;
        proxy_set_header Upgrade    $http_upgrade;
        proxy_set_header Connection "upgrade";
        # ⚠ Host 必须保持访客访问的域名**和端口**：哪吒的 upgrader.CheckOrigin 会拿
        #   Origin（如 http://farm.test:8080）和 r.Host 比较。$host 会丢掉 :8080，
        #   在非 80/443 端口上会让同源页面被拒（403/400）；$http_host 原样透传。
        proxy_set_header Host              $http_host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For   $remote_addr;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_buffering off;
        proxy_read_timeout 1h;
        proxy_send_timeout 1h;
    }
"""

API_AND_STATIC = """    # ---- cyber-probe：静态站 + 把 /chicken/api/* 反代到 hub ----
    # 必须排在 catch-all「location /」前面；^~ 前缀匹配优先于 location /，不会落到 hub。
    # 挂载路径由 installer 的 --path 决定（默认 /chicken/）
    location = __PREFIX_NS__ {
        return 301 __PREFIX__;
    }

__API_CLIENTS__
    location ^~ __PREFIX__api/ {
        # cyber-probe：hub API 反代（卸载按这行认领，别误删用户自己的同路径块）
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

KOMARI_CLIENTS = (KOMARI_CLIENTS.replace('__HUB_PORT__', HUB_PORT)
                                 .replace('__PREFIX__', PREFIX))
NEZHA_CLIENTS = (NEZHA_CLIENTS.replace('__HUB_PORT__', HUB_PORT)
                               .replace('__PREFIX__', PREFIX))
API_CLIENTS = NEZHA_CLIENTS if SOURCE == 'nezha' else KOMARI_CLIENTS
# 换数据源时要把上一家的 exact 块摘掉，不能两家同时留着（同一路径不会同时用到，
# 但旧块的 proxy_pass 会指向错的端口/path，卸载也会留下孤儿）。
OTHER_CLIENTS = KOMARI_CLIENTS if SOURCE == 'nezha' else NEZHA_CLIENTS
API_AND_STATIC = (API_AND_STATIC.replace('__API_CLIENTS__', API_CLIENTS)
                                 .replace('__HUB_PORT__', HUB_PORT)
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
conf = pathlib.Path(os.path.realpath(sys.argv[1]))   # 站点常是 sites-enabled/x → sites-available/x 的软链
api_static = base64.b64decode(sys.argv[2]).decode()
ws_block = base64.b64decode(sys.argv[3]).decode()
api_clients = base64.b64decode(sys.argv[4]).decode()
other_clients = base64.b64decode(sys.argv[5]).decode()


def write_text_atomic(path, text):
    """同目录临时文件 + os.replace：中途崩溃/磁盘满不会留下半截配置（截断直写的老做法
    会让下一次 nginx reload 直接炸）。newline="" 表示不翻译换行（3.9 也有这个参数）。"""
    tmp = path.with_name(path.name + ".tmp-cyberprobe")
    with open(tmp, "w", encoding="utf-8", newline="") as f:
        f.write(text)
    os.replace(str(tmp), str(path))


def backup_conf(suffix):
    """备份放到不被 `include sites-enabled/*` 加载的隐藏子目录。

    Debian 的 sites-enabled 是通配 include：同目录留 `<conf>.bak-...` 会被 nginx 当成
    第二份站点加载（conflicting server name），主文件删掉后备份还会顶替它生效。
    """
    d = conf.parent / '.cyber-probe-backups' if os.name != 'nt' else conf.parent
    try:
        d.mkdir(mode=0o700, parents=True, exist_ok=True)
    except OSError:
        d = conf.parent
    bak = d / (conf.name + '.bak-' + datetime.datetime.now().strftime('%Y%m%d-%H%M%S') + suffix)
    try:
        shutil.copy2(conf, bak)
    except OSError:
        # 沙箱/只读隐藏目录：退回旧行为（同目录），至少别让补丁失败
        bak = conf.with_name(conf.name + '.bak-' + datetime.datetime.now().strftime('%Y%m%d-%H%M%S') + suffix)
        shutil.copy2(conf, bak)
    return bak


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


def _catch_all(text, hub_up, alt=''):
    """找 catch-all 的 `location / {`（任意缩进）。

    一个文件里有两个 server（HTTP→HTTPS 跳转 + TLS）时，选**块里含 hub 上游**的那个。
    alt 是旧 hub 端口（换端口时目标 server 还没改到新端口），也作为识别依据。
    以前要求整份文件里这一段唯一且必须 4 空格缩进：tab 缩进的站点、或带跳转 server 的
    站点都会直接 exit 2，把站点留在「静态站装好、反代没配」的半装状态（2026-11-03 修）。
    """
    cands = list(re.finditer(r'(?m)^[ \t]*location[ \t]+/[ \t]*\{', text))
    if not cands:
        return None
    if len(cands) == 1:
        return cands[0]
    servers = [b for b in _blocks(text) if re.match(r'[ \t]*server[ \t]*\{', b[2])]
    needles = [hub_up]
    if alt:
        needles.append("127.0.0.1:" + str(alt))
    needles.append('proxy_pass')
    for needle in needles:
        for s, e, body in servers:
            if needle in body:
                for m in cands:
                    if s <= m.start() < e:
                        return m
    return cands[0]


def _target_bounds(text, hub_up, alt=''):
    """含 hub 上游的 server 块范围；找不到时返回整份文件（保持旧行为）。
    alt 是配置里现有的旧 hub 端口：换 --hub-port 时目标 server 还指着旧端口，
    只按新端口找会退化成全文件搜索，把块插进另一个 vhost。"""
    old = ("127.0.0.1:" + str(alt)) if alt else ""
    for s, e, body in _blocks(text):
        if re.match(r'[ \t]*server[ \t]*\{', body) and (hub_up in body or (old and old in body)):
            return s, e
    return 0, len(text)


def _anchor_pos(text, hub_up, t0, t1, alt=''):
    """在目标 server 内找插入锚点：优先 catch-all，其次本站已有的 ^~ 前缀。"""
    m = _catch_all(text, hub_up, alt)
    if m is not None and t0 <= m.start() < t1:
        return m.start()
    sub = text[t0:t1]
    p = re.search(r'(?m)^[ \t]*location[ \t]+\^~[ \t]+' + re.escape("__PREFIX__") + r'[ \t]*\{', sub)
    if p:
        return t0 + p.start()
    return None


def _indent_at(text, pos):
    line = text[pos:].split('\n', 1)[0]
    return line[:len(line) - len(line.lstrip(' \t'))]


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
# newline=""：保留原文件的换行风格（CRLF 配置被 read_text 默认翻译成 LF，
# 一次 install/remove 就把整份文件的行尾全改了 —— 与「字节一致」的承诺冲突）
with open(conf, encoding="utf-8", newline="") as _f:
    src = _f.read()
changed = []


def _loc_marker(block):
    """从区块模板里取 `location ...` 那一行（不含 `{`），用来判断块在不在。"""
    for ln in block.splitlines():
        s = ln.strip()
        if s.startswith('location'):
            return s.split('{', 1)[0].strip()
    return ''


API_LOC = _loc_marker(api_clients)          # 目标数据源的 exact 块
OTHER_LOC = _loc_marker(other_clients)      # 换源时要摘掉的上一家的 exact 块


def _drop_ours(text, marker):
    """摘掉带 marker 的 exact location 块（只认带 cyber-probe 注释的我们自己的块）。

    换数据源（Komari↔哪吒）时上一家的 exact 块必须清掉：同一个 /chicken/api/ 前缀下
    两个 exact location 不会同时命中，但旧块的 proxy_pass 指向错的 path/端口，回滚时也会
    留下孤儿。返回 (新文本, 摘掉几块)。
    """
    if not marker:
        return text, 0
    lines = text.splitlines(keepends=True)
    out, i, n, dropped = [], 0, len(lines), 0
    while i < n:
        ln = lines[i]
        if ln.lstrip().startswith('location') and marker in ln:
            j, depth, seen = i, 0, False
            while j < n:
                code = re.sub(r'(^|\s)#.*$', '', lines[j])
                for ch in code:
                    if ch == '{':
                        depth += 1
                        seen = True
                    elif ch == '}':
                        depth -= 1
                j += 1
                if seen and depth <= 0:
                    break
            body = ''.join(lines[i:j])
            # 结构不完整/不是我们的块：宁可不动，也绝不误删用户的 location
            if not seen or depth > 0 or 'cyber-probe' not in body:
                out.append(ln)
                i += 1
                continue
            # 只摘「含 cyber-probe」的那几行注释，用户自己写在更上面的注释保留
            c = len(out) - 1
            while c >= 0 and out[c].lstrip().startswith('#'):
                c -= 1
            run = out[c + 1:]
            keep = next((x for x, l in enumerate(run) if 'cyber-probe' in l), None)
            if keep is not None:
                del out[c + 1 + keep:]
            # 我们插入的块尾部自带一个分隔空行：只吃掉这一个，别顺手删用户自己的连续空行
            if j < n and lines[j].strip() == '':
                j += 1
            dropped += 1
            i = j
            continue
        out.append(ln)
        i += 1
    return ''.join(out), dropped


src, _dropped_other = _drop_ours(src, OTHER_LOC)
if _dropped_other:
    changed.append("ws-source")

# 参数从命令行按 --k=v 传进来（位置参数已经给了 b64 载荷，插队会错位）
ws_port_v = hub_port_v = webroot_v = ""
for _a in sys.argv[1:]:
    if _a.startswith("--ws-port="):
        ws_port_v = _a.split("=", 1)[1]
    elif _a.startswith("--hub-port="):
        hub_port_v = _a.split("=", 1)[1]
    elif _a.startswith("--webroot="):
        webroot_v = _a.split("=", 1)[1]

hub_up = "127.0.0.1:" + str(hub_port_v)      # 用来在多 server 文件里认「哪个块才是 hub 站点」
# 目标 server 里现有的 /api/ 块还指着旧 hub 端口：换端口时用它一起认目标 vhost。
# 反代脚本里没有 PREFIX 变量，从 api_static 的 `location ^~ <prefix>api/` 行取。
_m_pfx = re.search(r'location[ \t]+\^~[ \t]+([^ \t{]+api/)', api_static)
_prefix = _m_pfx.group(1) if _m_pfx else ""
_m_old = re.search(r'location[ \t]+\^~[ \t]+' + re.escape(_prefix) + r'[ \t]*\{.*?'
                   r'proxy_pass[ \t]+http://127\.0\.0\.1:(\d+)/api/', src, re.S)
old_hub = _m_old.group(1) if _m_old else ""

if "__WS_LOC__" not in src:
    # ⚠ 必须先在「含 hub 上游的 server」里找锚点，不能全文件搜 `location ^~ <前缀>/`：
    #   同文件里另一个 vhost 也可能有同名路径，旧逻辑会把 ws 块插进别人的 server，
    #   而 api/static 插进 hub vhost，装完一半 404、一半 200（2026-11-04 多 server 复现）。
    tb = _target_bounds(src, hub_up, old_hub)
    pos = _anchor_pos(src, hub_up, tb[0], tb[1], old_hub)
    if pos is None:
        print("ERR  找不到 catch-all「location / {」—— 本文件里没有可插块的 server 块", file=sys.stderr)
        sys.exit(2)
    ind = _indent_at(src, pos)
    src = src[:pos] + _reindent(ws_block, ind) + src[pos:]
    changed.append("ws")

# ⚠ 不能只查子串 "__PREFIX__api/"：新加的 clients exact 块也包含这段，只有 clients 块时
#   会误判“API 块已存在”而整段 SKIP，站点缺 API/静态块。
#   同时只检查**目标 server**：别被同文件另一个 vhost 的同名 location 骗过去。
tb = _target_bounds(src, hub_up, old_hub)
scope = src[tb[0]:tb[1]]
api_exists = "location ^~ __PREFIX__api/" in scope
static_exists = "location ^~ __PREFIX__ {" in scope
if not (api_exists and static_exists):
    pos = _anchor_pos(src, hub_up, tb[0], tb[1], old_hub)
    if pos is None:
        print("ERR  找不到 catch-all「location / {」—— 本文件里没有可插块的 server 块", file=sys.stderr)
        sys.exit(2)
    ind = _indent_at(src, pos)
    api_marker = "    location ^~ __PREFIX__api/ {"
    static_marker = "    location ^~ __PREFIX__ {"
    i, j = api_static.find(api_marker), api_static.find(static_marker)
    if api_exists and not static_exists and i >= 0 and j > i:
        # 只补静态 location；去掉模板尾部的“分隔空行”，否则卸载会在用户块前留一个空格
        chunk = api_static[j:].rstrip('\n') + '\n'
    elif static_exists and not api_exists and i >= 0 and j > i:
        chunk = api_static[i:j].rstrip('\n') + '\n'   # 只补 API location
    else:
        chunk = api_static
    # 只剩 clients 块、API/静态块被手工删掉时：补前缀/静态，但别把 clients 再插一份
    # （nginx 对重复的 exact location 会直接报错）。
    if API_LOC in scope:
        chunk = chunk.replace(api_clients, "")
    # api_static 里已经带着尾部的分隔空行（见调用方传的 API_CHUNK），别再自己补一个
    src = src[:pos] + _reindent(chunk, ind) + src[pos:]
    changed.append("api+static" if (not api_exists and not static_exists) else
                   ("static" if api_exists else "api"))

# 三块都在，但**参数变了**（换过 --hub-port / --ws-port / --webroot）→ 就地更新。
# 以前这里直接 SKIP：用户改了 hub 端口重装，/api 仍指向老端口，装完 502（真机实测）。
# ⚠ 不要再加 `not changed`：换数据源时精确块刚被替换（changed 非空），但 /api/ 前缀块
#   仍可能指着上一家的端口 —— 必须在同一次运行里一起改掉，否则下一次重跑才会补上。
if "__WS_LOC__" in src and "location ^~ __PREFIX__api/" in src and ws_port_v and hub_port_v:
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
        ("nezha-ws-port",
         r"(location = __PREFIX__api/v1/ws/server\s*\{.*?proxy_pass http://127\.0\.0\.1:)\d+/api/v1/ws/server",
         lambda m: m.group(1) + str(hub_port_v) + "/api/v1/ws/server"),
        ("api-clients-port",
         r"(location = __PREFIX__api/clients\s*\{.*?proxy_pass http://127\.0\.0\.1:)\d+/api/clients",
         lambda m: m.group(1) + str(hub_port_v) + "/api/clients"),
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

# 老部署只有 /chicken/api/ 前缀块、没有实时数据 WS 的 exact 块：补插到前缀块前面。
# 目标路径随数据源变（Komari /api/clients、哪吒 /api/v1/ws/server）；新部署的 API_CHUNK
# 里已经带这一块，这里自然跳过；放在参数更新之后，避免挡住 hub/ws 端口更新。
tb = _target_bounds(src, hub_up)
scope = src[tb[0]:tb[1]]
if API_LOC not in scope:
    pos = _anchor_pos(src, hub_up, tb[0], tb[1])
    if pos is not None:
        ind = _indent_at(src, pos)
        # 不额外补空行：单独插 clients 时多出来的空行不属于原文件，卸载会留下空白差异
        chunk = api_clients.rstrip('\n') + '\n'
        src = src[:pos] + _reindent(chunk, ind) + src[pos:]
        changed.append("api-clients")

# 老版本的 Komari / 哪吒 WS 块写的是 Host $host：在非 80/443 端口上会丢掉 :8080，
# 面板的 Origin 校验（两家都有）会直接 403。就地升级为 $http_host（保留端口）。
if 'api/clients' in api_clients or 'api/v1/ws/server' in api_clients:
    # [^{}]* 把匹配限制在这个 exact 块内部：不能越过 `}` 去改后面 generic API 块的 Host。
    pat = re.compile(r'(' + re.escape(API_LOC) + r'\s*\{[^{}]*?proxy_set_header\s+Host\s+)\$host;', re.S)
    src2, n = pat.subn(r'\1$http_host;', src)
    if n:
        src = src2
        changed.append("ws-host")

if not changed:
    print("SKIP  配置里已有这三块（含 CF-IPCountry 透传），未改动")
    sys.exit(0)
# 备份名带动作后缀：install 与 uninstall 若落在同一秒（脚本化验证就是这样），
# 秒级时间戳会让「卸载前备份」把「安装前的原件备份」覆盖掉 —— 那份才是保命的。
bak = backup_conf('-add')
write_text_atomic(conf, src)   # 原子写；newline="" → 不翻译换行（Windows 上跑 --local 也不会改成 CRLF）
# 备份只留最近 8 份：反复 install 会在备份目录里堆一堆 .bak-<时间>-add
try:
    olds = sorted(bak.parent.glob(conf.name + ".bak-*"))
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
conf = pathlib.Path(os.path.realpath(sys.argv[1]))
args = sys.argv[2:]
validate = ''
_keep = []
for _a in args:
    if _a.startswith('--validate='):
        validate = _a.split('=', 1)[1]
    else:
        _keep.append(_a)
literals = [base64.b64decode(x).decode() for x in _keep]
with open(conf, encoding="utf-8", newline="") as _f:      # 同上：保留 CRLF
    src = _f.read()
notes = []


def write_text_atomic(path, text):
    tmp = path.with_name(path.name + ".tmp-cyberprobe")
    with open(tmp, "w", encoding="utf-8", newline="") as f:
        f.write(text)
    os.replace(str(tmp), str(path))


def backup_conf(suffix):
    d = conf.parent / '.cyber-probe-backups' if os.name != 'nt' else conf.parent
    try:
        d.mkdir(mode=0o700, parents=True, exist_ok=True)
    except OSError:
        d = conf.parent
    bak = d / (conf.name + '.bak-' + datetime.datetime.now().strftime('%Y%m%d-%H%M%S') + suffix)
    try:
        shutil.copy2(conf, bak)
    except OSError:
        # 沙箱/只读隐藏目录：退回旧行为（同目录），至少别让补丁失败
        bak = conf.with_name(conf.name + '.bak-' + datetime.datetime.now().strftime('%Y%m%d-%H%M%S') + suffix)
        shutil.copy2(conf, bak)
    return bak

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
    # ⚠ 不要用 /api/ 当指纹：用户自己写的 `location ^~ /chicken/api/` 也含它，
    #   安装时没动用户的块、卸载却会把它删掉（多 server 复现）。只认我们自己的注释/头。
    # Connection "upgrade" 也可能出现在用户自己的 WebSocket location 里；只认更专用的
    # CF-IPCountry（我们插的）、cyber-probe 注释、静态站专属 no-cache 文案。
    sig = ('CF-IPCountry', 'cyber-probe', '站点很小，改了立刻可见')
    lines = text.splitlines(keepends=True)
    out, i, n, dropped = [], 0, len(lines), 0
    while i < n:
        ln = lines[i]
        if ln.lstrip().startswith("location") and needle in ln:
            # 用花括号配对找块尾（从这一行起数），别靠「缩进相同的 }」：单行块、
            # } 缩进不一致、} 后跟注释、块里有嵌套 if —— 老写法都会一路扫到文件尾，
            # 把后面别人的配置整段当成块体删掉（2026-11-03 复审修）。
            j, depth, seen_open = i, 0, False
            while j < n:
                code = re.sub(r'(^|\s)#.*$', '', lines[j])      # 先去掉行内注释，别让 `# {` 干扰
                for ch in code:
                    if ch == '{':
                        depth += 1
                        seen_open = True
                    elif ch == '}':
                        depth -= 1
                j += 1
                if seen_open and depth <= 0:
                    break
            if not seen_open or depth > 0:
                # 结构不完整（未闭合）：宁可不动，也绝不把文件剩余部分当块体删掉
                out.append(ln)
                i += 1
                continue
            body = "".join(lines[i:j])
            # 301 跳转块没有 proxy/注释指纹，但形态很特定：`location = <前缀> { return 301 <前缀>; }`
            ours = any(s in body for s in sig) or (needle.startswith('=') and 'return 301' in body)
            if not ours:
                out.append(ln)          # 不是我们的块（或指纹不明）→ 原样留着，别替用户删配置
                i += 1
                continue
            i = j
            # 上方的连续注释行：只摘「含 cyber-probe」那一行起往下的部分。
            # 以前是「块上方有几行注释就删几行」—— 紧贴补丁块的用户注释会被误删（复审修）。
            if out and out[-1].lstrip().startswith("#"):
                c = len(out) - 1
                while c >= 0 and out[c].lstrip().startswith("#"):
                    c -= 1
                run = out[c + 1:]
                keep = next((x for x, l in enumerate(run) if 'cyber-probe' in l), None)
                if keep is not None:
                    del out[c + 1 + keep:]
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

# ⚠ 不要在这里全局把连续空行压成一个：那会把用户自己有意留的分段空行也改掉
#   （之前是 `while "\n\n\n" in src: ...`，卸载一份配置会顺手重排整份文件）。
#   我们自己插入的块尾部空行由 drop_block 精确吃掉，正常粘贴/摘除已经字节一致。

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
bak = backup_conf('-rm')
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
    """把一段 python 喂给远端（或本机）的 python3 执行；返回它的 stdout 供调用方判断实际做了什么。

    ⚠ 本机执行走「临时脚本文件 + 临时输出文件」而不是 stdin/stdout 管道：
      部分 Windows 沙箱会拒绝 CreatePipe（WinError 5），而这两条路径在 Linux 上行为一致。
    """
    if LOCAL:
        import tempfile
        fd, spath = tempfile.mkstemp(prefix='cyber-probe-patch-', suffix='.py')
        os.close(fd)
        fo_fd, opath = tempfile.mkstemp(prefix='cyber-probe-out-', suffix='.txt')
        os.close(fo_fd)
        fe_fd, epath = tempfile.mkstemp(prefix='cyber-probe-err-', suffix='.txt')
        os.close(fe_fd)
        try:
            with open(spath, 'w', encoding='utf-8') as f:
                f.write(script_text)
            with open(opath, 'w', encoding='utf-8', newline='') as fo, \
                 open(epath, 'w', encoding='utf-8', newline='') as fe:
                r = subprocess.run([sys.executable or 'python3', spath] + extra,
                                   stdout=fo, stderr=fe)
            out = open(opath, encoding='utf-8', errors='replace').read()
            err = open(epath, encoding='utf-8', errors='replace').read()
        finally:
            for p in (spath, opath, epath):
                try:
                    os.unlink(p)
                except OSError:
                    pass
    else:
        import shlex
        # 不 quote 的话 `--validate=nginx -t` 会被拆成两个参数，内层只拿到「--validate=nginx」，
        # 于是执行裸 nginx（不带 -t）—— 配置根本没校验，改坏了也不会回滚。
        cmd = ['ssh', HOST, 'python3 - ' + ' '.join(shlex.quote(x) for x in extra)]
        r = subprocess.run(cmd, input=script_text, capture_output=True, text=True,
                           encoding='utf-8', errors='replace')
        out = r.stdout or ''
        err = r.stderr or ''
    print(out.strip())
    if r.returncode != 0:
        print(err.strip(), file=sys.stderr)
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
    args = [CONF, b64(WS_BLOCK), b64(API_CHUNK), b64(API_CLIENTS)]
    if VALIDATE_CMD:
        args.append('--validate=' + VALIDATE_CMD)
    out = run_py(REMOTE_REMOVE, args)
    if 'REMOVED' not in out:
        # 本来就没块（内层已打印 SKIP）：那就别去碰服务，也别报"已移除"
        print('（配置里没有 cyber-probe 的块，未动服务）')
    elif not NO_RELOAD:
        if shutil.which('nginx'):
            run_cmd('nginx -t && { systemctl is-active --quiet nginx && systemctl reload nginx || echo "（nginx 没在跑，配置已改好，下次启动生效）"; }')
        else:
            print('（找不到 nginx 命令，跳过 reload；配置已改好）')
        print('nginx 配置已改好（已移除 cyber-probe 的三块）')
else:
    args = [CONF, b64(API_CHUNK), b64(WS_BLOCK), b64(API_CLIENTS), b64(OTHER_CLIENTS)]
    # ⚠ 自检命令一律用 `--validate=<命令>` 传：按位置传很容易被以后新增的参数顶掉
    #   （caddy_patch 就因此把 hub 端口当成命令，一路静默回滚；见那边的注释）
    args += ['--ws-port=' + str(WS_PORT), '--hub-port=' + str(HUB_PORT), '--webroot=' + WEBROOT]
    if VALIDATE_CMD:
        args.append('--validate=' + VALIDATE_CMD)
    out = run_py(REMOTE_ADD, args)
    patched = 'PATCHED' in out
    if not NO_RELOAD:
        # 没有 nginx.service（Caddy/手工跑的 nginx 场景）时 restart 会失败；文件已经改好，
        # 不该让整次安装以一个假错误收尾。配置生效与否由上面的 nginx -t 负责。
        run_cmd('(systemctl is-active --quiet nginx && systemctl reload nginx) || '
                '{ systemctl restart nginx && echo "（nginx 本来没在跑，已启动以让配置生效）"; } || '
                'echo "（没有可用的 nginx.service，配置已改好，手动启动后生效）"')
        print('nginx 配置已生效' if patched else 'nginx 配置本来就是目标状态（文件未改动，已 reload 一次确认生效）')
print(f'（目标：{where} {CONF}）')
