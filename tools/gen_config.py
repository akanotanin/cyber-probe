#!/usr/bin/env python3
"""从 monitor hub 的 SQLite、Komari 或哪吒监控的公开 API 导出 cyber-probe 的静态信息到 js/config.js。

用法：

  # ① 在 hub 同一台机器上就地读库（一键包的 install 用这个：装完即显示自己那套探针数据）
  python3 gen_config.py --db /opt/monitor/data/monitor.db --out /var/www/cyber-probe/js/config.js

  # ② 从开发机走 ssh 读远端库（本地开发 / 线上部署用）
  python tools/gen_config.py --ssh <你 ssh config 里的别名> --out js/config.js

  # ③ 生成空占位（后端里一个探测任务都没有时，前端也能正常起）
  python tools/gen_config.py --stub --out js/config.js

  # ④ 从 Komari 的公开 API 读 ping 任务清单（不需要数据库/管理员密钥）
  python tools/gen_config.py --komari http://127.0.0.1:25774 --out js/config.js
  python tools/gen_config.py --detect http://127.0.0.1:25774   # 只探测是不是 Komari

  # ⑤ 从哪吒监控（Nezha V2）游客可读的 API 读服务监控清单 + 节点 id（同样不需要密钥）
  python tools/gen_config.py --nezha http://127.0.0.1:8008 --out js/config.js
  python tools/gen_config.py --detect http://127.0.0.1:8008    # 输出 komari / nezha / unknown

★ 隐私约定：**探测任务的目标域名与节点 hostname/IP 一律不导出**（这个站是公开的，
  config.js 谁都能下载 —— 所以是"不落盘"，而不是"下载到了但界面不显示"）。
  Komari 模式也不导出节点 UUID / clients 列表，只留任务 id、名称、间隔与站名。
  哪吒模式同样只导出服务 id / 名称；节点 id 只写进本机 APPDIR 的 NPC 白名单。
★ 国旗（仅 monitor）：网站鸡名牌要显示"这个探测点 IP 所在地"，所以生成时把 target 解析成 IP、
  查一次国家码，只把两个字母的码写进 config.js（域名与 IP 都不落盘）。
  查库用 ip-api.com 的免费批量接口，结果缓存到 flag_cache.json；
  接口不可达或加了 --no-geo 时用缓存/留空（前端退化为 🌐）。
"""
import argparse
import base64
import datetime
import hashlib
import json
import os
import pathlib
import socket
import ssl
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request

HERE = pathlib.Path(__file__).resolve().parent
DEFAULT_CACHE = HERE / 'flag_cache.json'

ROW_SQL = 'select id,name,target,interval from ping_task'
# 有些 hub 版本没有 interval 列；拿不到就用 60s 兜底（只影响前端的轮询节奏）
ROW_SQL_NO_INTERVAL = 'select id,name,target from ping_task'


def read_rows_local(db):
    import sqlite3
    c = sqlite3.connect(f'file:{db}?mode=ro', uri=True)
    try:
        rows = list(c.execute(ROW_SQL))
    except sqlite3.OperationalError:
        rows = [(r[0], r[1], r[2], 60) for r in c.execute(ROW_SQL_NO_INTERVAL)]
    finally:
        c.close()
    return rows


def read_node_ids_local(db):
    """monitor 的 node.id 列表（只写到 APPDIR/npcs-allow，不进公开 config.js）。

    联机服只按这个白名单接受客户端上报的 n<id>/t<id>；没有它时任何访客都能用
    n900001… 这种「长得像真实 id」的假名单占满 64 个名额（2026-11-04 复审）。
    """
    import sqlite3
    try:
        c = sqlite3.connect(f'file:{db}?mode=ro', uri=True)
        try:
            return [str(r[0]) for r in c.execute('select id from node')]
        finally:
            c.close()
    except Exception:
        return []


def read_rows_ssh(host):
    """远端自己找库（hub 的默认位置），把行 JSON 打回来 —— 我们只读，不写。"""
    script = (
        'import sqlite3, json, glob\n'
        f'SQL = {ROW_SQL!r}\n'
        f'SQL2 = {ROW_SQL_NO_INTERVAL!r}\n'
        'paths = glob.glob("/opt/monitor/data/monitor.db") or glob.glob("/opt/*/data/monitor.db")\n'
        'db = paths[0] if paths else "/opt/monitor/data/monitor.db"\n'
        'c = sqlite3.connect(f"file:{db}?mode=ro", uri=True)\n'
        'try:\n'
        '    rows = list(c.execute(SQL))\n'
        'except sqlite3.OperationalError:\n'
        '    rows = [(r[0], r[1], r[2], 60) for r in c.execute(SQL2)]\n'
        'print(json.dumps(rows))\n'
    )
    # ⚠ host 以 '-' 开头会被 ssh 当成选项解析（`-oProxyCommand=…` 能本地执行命令）→ 直接拒绝
    if str(host).startswith('-'):
        print(f'  ✗ --ssh 主机名不能以 - 开头：{host!r}', file=sys.stderr)
        sys.exit(2)
    try:
        out = subprocess.run(['ssh', host, 'python3 -'], input=script,
                             capture_output=True, text=True, timeout=90,
                             encoding='utf-8', errors='replace')
    except subprocess.TimeoutExpired:
        print(f'  ✗ ssh {host} 超时（90s）—— 网络不通或远端的 python3 卡住了', file=sys.stderr)
        sys.exit(1)
    if out.returncode != 0:
        print((out.stderr or '').strip(), file=sys.stderr)
        sys.exit(1)
    return json.loads(out.stdout.strip().splitlines()[-1])


def resolve_host(target):
    """target 形如 host:port / [IPv6]:port（也可能带路径）→ 解析出 IP；解析不了返回空串。

    ⚠ monitor 文档允许 IPv6 目标（`[2606:4700:4700::1111]:443`）。以前这里只去掉
    最后一个 `:port` 就交给 AF_INET，方括号 IPv6 永远解析失败 → 这类探测任务
    的国旗静默退化成 🌐（2026-11-04 复审）。
    """
    raw = str(target or '').strip().split('/')[0]
    if raw.startswith('['):                     # [IPv6]:port
        j = raw.find(']')
        host = raw[1:j] if j > 0 else raw.strip('[]')
    elif ':' in raw:
        head, _, tail = raw.rpartition(':')
        # 只把「数字端口」当端口；`2001:db8::1` 这种裸 IPv6 的 head 以 : 结尾，不能切
        host = head if tail.isdigit() and not head.endswith(':') else raw
    else:
        host = raw
    if not host:
        return ''
    try:
        # 有 A 记录就优先用 IPv4（保持以前的行为：大多数任务/接口按 v4 更稳）；
        # 只有 IPv6 的目标（方括号写法）再走 AF_UNSPEC。
        try:
            infos = socket.getaddrinfo(host, None, socket.AF_INET, socket.SOCK_STREAM)
        except socket.gaierror:
            infos = socket.getaddrinfo(host, None, socket.AF_UNSPEC, socket.SOCK_STREAM)
        return infos[0][4][0] if infos else ''
    except Exception as e:
        print(f'  ! 解析失败 {host}: {e}', file=sys.stderr)
        return ''


def geo_countries(ips):
    """批量查国家码（ip-api.com 免费批量接口，无需 key）。只取 countryCode。

    ⚠ 批量接口上限 100：一次塞更多会被回一个**错误对象**（不是数组），以前那样
    迭代 dict 的键会抛 AttributeError、被外层 except 吞掉 → 所有国旗静默退化成 🌐。
    这里按 100 分块，某一块失败也只影响那一块（2026-11-03 修）。
    """
    ips = sorted({ip for ip in ips if ip})
    if not ips:
        return {}
    out = {}
    for i in range(0, len(ips), 100):
        chunk = ips[i:i + 100]
        req = urllib.request.Request(
            'http://ip-api.com/batch?fields=status,countryCode,query',
            data=json.dumps(chunk).encode(), headers={'Content-Type': 'application/json'})
        try:
            data = json.load(urllib.request.urlopen(req, timeout=25))
        except Exception as e:
            print(f'  ! 国旗查询失败（这批 {len(chunk)} 个点先用 🌐）：{e}', file=sys.stderr)
            continue
        if not isinstance(data, list):
            print(f'  ! 国旗接口返回了非数组（这批 {len(chunk)} 个点先用 🌐）', file=sys.stderr)
            continue
        for r in data:
            if not isinstance(r, dict):
                continue
            cc = str(r.get('countryCode') or '').upper()
            if r.get('status') == 'success' and len(cc) == 2:
                out[r['query']] = cc
    return out


class KomariUrlError(ValueError):
    """--komari 地址格式错误：安装器应直接失败，不能当成临时网络故障写空占位。"""


def fetch_json(url, timeout=20):
    """读一个公开 JSON 接口；失败抛 RuntimeError（调用方决定是 die 还是退回空清单）。"""
    req = urllib.request.Request(url, headers={'accept': 'application/json',
                                               'user-agent': 'cyber-probe-config/1.0'})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode('utf-8', 'replace'))
    except urllib.error.HTTPError as e:
        raise RuntimeError(f'HTTP {e.code}（{url}）') from e
    except Exception as e:
        raise RuntimeError(f'{type(e).__name__}: {e}（{url}）') from e


def unwrap_komari(data):
    """Komari 标准包络 {status,message,data}；/api/me 一类的 raw 接口原样返回。"""
    if isinstance(data, dict) and 'status' in data:
        if data.get('status') != 'success':
            raise RuntimeError(str(data.get('message') or 'Komari API 返回 error'))
        return data.get('data')
    return data


def komari_url(base):
    """校验/规范化 --komari 的地址：只允许 http(s)，去掉末尾斜杠。"""
    base = str(base or '').strip().rstrip('/')
    u = urllib.parse.urlsplit(base)
    if u.scheme not in ('http', 'https') or not u.netloc:
        raise KomariUrlError(f'--komari 要给 http(s)://host[:port]，现在收到 {base!r}')
    if u.username or u.password:
        raise KomariUrlError('--komari 地址里不要带用户名/密码（会把凭据写进命令行历史）')
    if u.query or u.fragment:
        raise KomariUrlError('--komari 地址不要带 query/fragment（给到站点根或反代前缀即可）')
    return base


def probe_komari(base):
    """确认这个地址是 Komari（而不是别的监控面板）。返回 True/False。
    判据是 /api/public 的字段：Komari 一定有 theme / sitename / record_preserve_time。"""
    try:
        d = unwrap_komari(fetch_json(komari_url(base) + '/api/public', timeout=6))
    except Exception:
        return False
    return isinstance(d, dict) and 'theme' in d and 'sitename' in d


def read_komari(base):
    """从 Komari 的公开 API 取探测任务清单 + 站名 + 历史保留天数 + 节点 UUID。

    ★ 隐私：只取任务 id / 名称 / 间隔 / 节点 UUID；**绝不导出** hostname/IP/探测目标
      —— config.js 是公开文件。UUID 只用于本机生成联机服白名单，不写进公开文件。
    """
    base = komari_url(base)
    public = unwrap_komari(fetch_json(base + '/api/public'))
    if not isinstance(public, dict):
        raise RuntimeError('/api/public 返回的不是对象')
    tasks = unwrap_komari(fetch_json(base + '/api/task/ping'))
    if not isinstance(tasks, list):
        raise RuntimeError('/api/task/ping 返回的不是数组')
    try:
        nodes = unwrap_komari(fetch_json(base + '/api/nodes'))
        if not isinstance(nodes, list):
            nodes = []
    except Exception as e:
        # 节点列表只用于联机服白名单；旧版/私有/被限制的 Komari 没有它也不该让整次安装失败
        print(f'  ! 读 /api/nodes 失败（NPC 白名单将缺节点 id）：{e}', file=sys.stderr)
        nodes = []

    probes = {}
    for t in tasks:
        if not isinstance(t, dict) or t.get('id') is None:
            continue
        tid = str(t['id'])
        name = str(t.get('name') or f'#{tid}')
        try:
            interval = int(t.get('interval') or 60)
        except (TypeError, ValueError):
            interval = 60
        probes[tid] = {'name': name, 'interval': max(1, interval)}

    hours = public.get('record_preserve_time')
    try:
        history_days = max(1, round(float(hours) / 24)) if hours else 0
    except (TypeError, ValueError):
        history_days = 0
    return probes, str(public.get('sitename') or ''), history_days, nodes


def komari_npc_ids(nodes):
    """Komari 节点 UUID → 前端 `_komariId()` 的同一个数字 id（联机服白名单用）。

    ⚠ 必须与 js/data.js 的 FNV-1a 32 位哈希逐位一致，否则白名单里的 n<id> 和
      客户端上报的对不上，整站一只探针鸡都建不出来。UUID 只落在本机 APPDIR。
    """
    used, out = set(), []
    for n in nodes or []:
        if not isinstance(n, dict):
            continue
        uuid = str(n.get('uuid') or '')
        if not uuid:
            continue
        h = 2166136261
        for ch in uuid:
            h ^= ord(ch)
            h = (h * 16777619) & 0xffffffff
        nid = (h % 0x7fffffff) or 1
        while nid in used:                 # 与 JS 的线性探测一致（碰撞概率极低）
            nid = (nid % 0x7fffffff) + 1
        used.add(nid)
        out.append('n%d' % nid)
    return out


class NezhaUrlError(ValueError):
    """--nezha 地址格式错误：安装器应直接失败，不能当成临时网络故障写空占位。"""


def nezha_url(base):
    """校验/规范化 --nezha 的地址：只允许 http(s)，去掉末尾斜杠（可以带反代前缀）。"""
    raw = str(base or '').strip().rstrip('/')
    u = urllib.parse.urlsplit(raw)
    if u.scheme not in ('http', 'https') or not u.netloc:
        raise NezhaUrlError(f'--nezha 要给 http(s)://host[:port]，现在收到 {raw!r}')
    if u.username or u.password:
        raise NezhaUrlError('--nezha 地址里不要带用户名/密码（会把凭据写进命令行历史）')
    if u.query or u.fragment:
        raise NezhaUrlError('--nezha 地址不要带 query/fragment（给到站点根或反代前缀即可）')
    return raw


def unwrap_nezha(data):
    """哪吒标准包络 {success,data}；错误在 HTTP 200 里也常见（force_auth 等）。"""
    if isinstance(data, dict) and 'success' in data:
        if data.get('success') is not True:
            raise RuntimeError(str(data.get('error') or 'Nezha API 返回失败'))
        return data.get('data')
    if isinstance(data, dict) and data.get('error'):
        raise RuntimeError(str(data['error']))
    return data


def probe_nezha(base):
    """确认这个地址是（V2 或兼容的 V1）哪吒，而不是别的监控面板。

    首选判据是游客可读的 /api/v1/setting：真实 V2 的 data.config 是**扁平**的
    （model.Setting 内嵌 ConfigForGuests，没有 config_for_guests 这一层），
    典型字段 site_name/language + 顶层 tsdb_enabled。这个判据在「零服务监控」
    的新面板上也成立（此时 /api/v1/service 是 {"success":true,"data":{}}）。
    老版本没有 setting 时，再看 /api/v1/service 的 {services:{...}} 形状。"""
    try:
        d = unwrap_nezha(fetch_json(nezha_url(base) + '/api/v1/setting', timeout=6))
        cfg = d.get('config') if isinstance(d, dict) else None
        if isinstance(cfg, dict) and (
                'site_name' in cfg or 'language' in cfg or 'config_for_guests' in cfg):
            return True
        # 兼容极少见的扁平/旧形状：只要 setting 里明确带 tsdb_enabled 也认。
        if isinstance(d, dict) and 'tsdb_enabled' in d:
            return True
    except Exception:
        pass
    try:
        d = unwrap_nezha(fetch_json(nezha_url(base) + '/api/v1/service', timeout=6))
    except Exception:
        return False
    return isinstance(d, dict) and isinstance(d.get('services'), dict)


class _WSReader:
    """从 socket 读 WebSocket 帧的小工具（只给 gen_config 取节点 id 用，不引第三方库）。"""

    def __init__(self, sock, initial=b''):
        self.sock = sock
        self.buf = initial

    def read(self, n):
        while len(self.buf) < n:
            chunk = self.sock.recv(max(4096, n - len(self.buf)))
            if not chunk:
                raise RuntimeError('WebSocket 提前断开')
            self.buf += chunk
        out, self.buf = self.buf[:n], self.buf[n:]
        return out

    def read_until(self, delim, limit=65536):
        while delim not in self.buf:
            if len(self.buf) > limit:
                raise RuntimeError('WebSocket 握手响应过大')
            chunk = self.sock.recv(4096)
            if not chunk:
                raise RuntimeError('WebSocket 握手没有响应就断开了')
            self.buf += chunk
        i = self.buf.index(delim) + len(delim)
        out, self.buf = self.buf[:i], self.buf[i:]
        return out


def _ws_read_frame(reader):
    b1 = reader.read(1)[0]
    b2 = reader.read(1)[0]
    opcode = b1 & 0x0F
    masked = bool(b2 & 0x80)
    n = b2 & 0x7F
    if n == 126:
        n = int.from_bytes(reader.read(2), 'big')
    elif n == 127:
        n = int.from_bytes(reader.read(8), 'big')
    if n > 8 * 1024 * 1024:                 # 一帧状态快照不该有这么大；挡住恶意/错位长度
        raise RuntimeError(f'WebSocket 帧太大（{n} 字节）')
    mask = reader.read(4) if masked else b''
    payload = reader.read(n) if n else b''
    if masked:
        payload = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
    return opcode, payload


def _ws_send_frame(sock, opcode, payload=b''):
    """客户端帧必须带掩码（RFC 6455）；只用于关连接/回 pong。"""
    mask = os.urandom(4)
    n = len(payload)
    if n < 126:
        head = bytes([0x80 | opcode, 0x80 | n])
    elif n < 65536:
        head = bytes([0x80 | opcode, 0x80 | 126]) + n.to_bytes(2, 'big')
    else:
        head = bytes([0x80 | opcode, 0x80 | 127]) + n.to_bytes(8, 'big')
    body = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
    try:
        sock.sendall(head + mask + body)
    except OSError:
        pass


def ws_server_ids(base, timeout=8):
    """直接连哪吒的 /api/v1/ws/server 读**一帧**，取出服务器 id 列表。

    为什么不用 REST：/api/v1/server 在游客模式下是 401（它挂在 auth 组里），
    而 WS 是 optionalAuth —— 只要面板没开 force_auth，游客就能连。节点 id 只用于
    本机 NPC 白名单，不进公开 config.js。

    ⚠ 不引第三方 websocket 库：这里只用标准库做一次「握手 + 读一帧」，
      部署机不需要 pip install。
    """
    u = urllib.parse.urlsplit(nezha_url(base))
    host = u.hostname
    if not host:
        raise NezhaUrlError(f'--nezha 地址缺少主机名：{base!r}')
    port = u.port or (443 if u.scheme == 'https' else 80)
    path = (u.path.rstrip('/') if u.path else '') + '/api/v1/ws/server'
    kw = {}
    if u.scheme == 'https':
        kw = {'server_hostname': host}
    sock = socket.create_connection((host, port), timeout=timeout)
    try:
        if u.scheme == 'https':
            sock = ssl.create_default_context().wrap_socket(sock, **kw)
        key = base64.b64encode(os.urandom(16)).decode('ascii')
        req = (
            f'GET {path} HTTP/1.1\r\n'
            f'Host: {u.netloc}\r\n'
            'Upgrade: websocket\r\n'
            'Connection: Upgrade\r\n'
            f'Sec-WebSocket-Key: {key}\r\n'
            'Sec-WebSocket-Version: 13\r\n'
            'User-Agent: cyber-probe-config/1.0\r\n'
            '\r\n'
        )
        sock.sendall(req.encode('ascii'))
        reader = _WSReader(sock)
        head = reader.read_until(b'\r\n\r\n').decode('latin-1', 'replace')
        lines = head.split('\r\n')
        if len(lines) < 1 or ' 101' not in lines[0]:
            raise RuntimeError(f'WebSocket 握手失败：{lines[0] if lines else "空响应"}')
        headers = {}
        for ln in lines[1:]:
            if ':' in ln:
                k, v = ln.split(':', 1)
                headers[k.strip().lower()] = v.strip()
        expect = base64.b64encode(hashlib.sha1(
            (key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').encode('ascii')).digest()).decode('ascii')
        if headers.get('sec-websocket-accept') != expect:
            raise RuntimeError('WebSocket 握手的 Sec-WebSocket-Accept 不匹配')
        # 服务端每 2 秒推一帧；最多读 6 帧（跳过 ping），拿到 text 就返回。
        for _ in range(6):
            opcode, payload = _ws_read_frame(reader)
            if opcode == 0x8:
                raise RuntimeError('WebSocket 在收到状态帧前被关闭')
            if opcode == 0x9:               # ping → 回 pong 再继续等
                _ws_send_frame(sock, 0xA, payload)
                continue
            if opcode != 0x1:
                continue
            try:
                data = json.loads(payload.decode('utf-8', 'replace'))
            except Exception:
                continue
            servers = data.get('servers') if isinstance(data, dict) else None
            if not isinstance(servers, list):   # omitempty：一台可见服务器都没有
                return []
            out = []
            for s in servers:
                if not isinstance(s, dict) or s.get('id') is None:
                    continue
                try:
                    out.append(int(s['id']))
                except (TypeError, ValueError):
                    continue
            return out
        raise RuntimeError('WebSocket 连上了但没读到状态帧')
    finally:
        _ws_send_frame(sock, 0x8, b'\x03\xe8')   # 1000 normal closure
        try:
            sock.close()
        except OSError:
            pass


def read_nezha(base):
    """从哪吒的游客可读 API 取服务监控清单 + 站名 + 节点 id。

    ★ 隐私：只取服务 id / 名称与节点 id；**绝不导出**主机名/IP/探测目标
      —— config.js 是公开文件。节点 id 只用于本机生成联机服白名单，不写进公开文件。
    ★ 游客只能读 1 天历史（7d/30d 要登录），所以 HISTORY_DAYS 固定 1。
    """
    base = nezha_url(base)
    try:
        setting = unwrap_nezha(fetch_json(base + '/api/v1/setting'))
    except Exception as e:
        # 老版本 / 反代没放行 setting：站名与 TSDB 标记用默认值，服务清单仍照读。
        print(f'  ! 读哪吒 /api/v1/setting 失败（站名/TSDB 标记用默认值）：{e}', file=sys.stderr)
        setting = {}
    if not isinstance(setting, dict):
        setting = {}
    services_raw = unwrap_nezha(fetch_json(base + '/api/v1/service'))
    if not isinstance(services_raw, dict):
        raise RuntimeError('/api/v1/service 返回的不是对象')
    services = services_raw.get('services')
    if not isinstance(services, dict):
        services = {}

    probes = {}
    for tid, svc in services.items():
        if svc is not None and not isinstance(svc, dict):
            svc = {}
        svc = svc or {}
        name = str(svc.get('service_name') or f'#{tid}')
        # /api/v1/service 不返回探测间隔（duration 在 auth-only 的 /service/list 里）；
        # 不编造 60 秒，留 0 让前端显示「—」。
        probes[str(tid)] = {'name': name, 'interval': 0}

    # 真实 V2 的 config 是扁平的（site_name 直接挂 config 下）；老版本/文档里
    # 可能多一层 config_for_guests，两种都认。
    cfg = setting.get('config') if isinstance(setting.get('config'), dict) else {}
    guests = cfg.get('config_for_guests') if isinstance(cfg.get('config_for_guests'), dict) else cfg
    sitename = str((guests or {}).get('site_name') or '')

    try:
        node_ids = ws_server_ids(base)
        nodes = [{'id': nid} for nid in node_ids]
    except Exception as e:
        # 节点列表只用于联机服白名单；WS 被反代挡住/面板开了 force_auth 也不该让整次安装失败。
        print(f'  ! 读哪吒 /api/v1/ws/server 失败（NPC 白名单将缺节点 id）：{e}', file=sys.stderr)
        nodes = []
    return probes, sitename, 1, nodes


def nezha_npc_ids(nodes):
    """哪吒的节点 id 就是前端的数字 id（不需要哈希）；输出联机服认的 n<id>。"""
    out, used = [], set()
    for n in nodes or []:
        if not isinstance(n, dict):
            continue
        try:
            nid = int(n.get('id'))
        except (TypeError, ValueError):
            continue
        if nid <= 0:
            continue
        key = 'n%d' % nid
        if key in used:
            continue
        used.add(key)
        out.append(key)
    return out



def write_npc_allowlist(path, ids, ts):
    """写联机服白名单（n<id>/t<id>，一行一个）。空列表不写、不删旧文件。

    这个文件不是公开文件：它只放在 APPDIR，服务端启动时读；config.js 里仍然只有
    任务名/间隔/国旗码。安装器每次 install/update 会重新生成。
    """
    if not path or not ids:
        return 0
    out = pathlib.Path(path)
    out.parent.mkdir(parents=True, exist_ok=True)
    body = ('# cyber-probe NPC allowlist（由 tools/gen_config.py 于 %s 生成；删掉它=\n'
            '# 退回“完全相信客户端名单”，不建议在公开站点这么做）\n' % ts
            + '\n'.join(sorted(set(ids))) + '\n')
    tmp = out.with_name(out.name + '.tmp')
    tmp.write_text(body, encoding='utf-8')
    os.chmod(tmp, 0o644)
    os.replace(str(tmp), str(out))
    return len(set(ids))


def write_text_atomic(path, text):
    """同目录 tmp + os.replace：Ctrl-C/磁盘满不会留下半截 ES module 让整站白屏。"""
    path = pathlib.Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + '.tmp-cyberprobe')
    with open(tmp, 'w', encoding='utf-8', newline='') as f:
        f.write(text)
    os.replace(str(tmp), str(path))


def render(probes, ts, origin, site_name='', source='monitor', history_days=0):
    # ☆ SITE_NAME：这个站**自己**叫什么名字（浏览器页签 / 站点名）。
    #   刻意留成安装时的参数而不是写死在 index.html 里 —— 公开仓库与发布包保持中性默认，
    #   每个实例在目标机上用自己的名字（和 PROBES 一个思路：站内数据不进公开包）。
    # ☆ SOURCE：数据源。monitor = monitor hub 的 /api/*（默认）；komari = Komari 公开 API。
    #   HISTORY_DAYS 是后端保留天数（0 = 前端运行时再问 /api/me 或 /api/public）。
    origin_note = str(origin or '')
    return f"""// 由 tools/gen_config.py 于 {ts} 导出（{origin_note}）。
// 只含探测任务的名称与间隔（monitor 模式另有探测点国旗码）；**节点主机名/IP 与探测目标域名刻意不导出**
// （站点公开，谁都能下载这个文件）。monitor 的国旗码 = 该探测点 IP 的所在地（生成时解析 + 查库，只留两个字母）。
// SITE_NAME 是本站自己的名字（安装时用 --site-name 给，空则用页面自带的默认名）。
// SOURCE 是数据源（monitor / komari / nezha）；hub / Komari / 哪吒里增删探测任务后重跑安装即可刷新。
export const GENERATED_AT = {json.dumps(ts)};
export const SOURCE = {json.dumps(source)};
export const HISTORY_DAYS = {int(history_days or 0)};
export const SITE_NAME = {json.dumps(site_name, ensure_ascii=False)};
export const PROBES = {json.dumps(probes, ensure_ascii=False, indent=2)};
"""


def main():
    ap = argparse.ArgumentParser(description='导出监控后端的探测任务清单到 config.js')
    src = ap.add_mutually_exclusive_group()
    src.add_argument('--db', help='本机 monitor.db 路径（与 hub 同机时用）')
    src.add_argument('--ssh', dest='ssh_host', help='从开发机走 ssh 读远端库，参数是 ssh 别名')
    src.add_argument('--komari', help='Komari 地址（如 http://127.0.0.1:25774），从公开 API 读取')
    src.add_argument('--nezha', help='哪吒监控地址（如 http://127.0.0.1:8008），从游客可读 API 读取')
    ap.add_argument('--stub', action='store_true', help='生成空占位（不读库）')
    ap.add_argument('--source', choices=['monitor', 'komari', 'nezha'], default='monitor',
                    help='--stub 时空占位标哪个数据源（默认 monitor）')
    ap.add_argument('--detect', metavar='URL',
                    help='探测 URL 是 Komari / Nezha，打印 komari / nezha / unknown 后退出')
    ap.add_argument('--out', default='js/config.js', help='输出路径（默认 js/config.js）')
    ap.add_argument('--cache', default=str(DEFAULT_CACHE), help='国旗缓存文件路径')
    ap.add_argument('--no-geo', action='store_true', help='不查国旗（离线安装用，前端显示 🌐）')
    ap.add_argument('--site-name', default='', help='本站的名字（显示在浏览器页签；留空则用页面默认名）')
    ap.add_argument('--npc-allow-out', default='',
                    help='联机服 NPC 白名单输出路径（放 APPDIR；不进公开 config.js）')
    a = ap.parse_args()

    ts = datetime.datetime.now().astimezone().isoformat(timespec='seconds')
    out = pathlib.Path(a.out)

    if a.detect:
        if probe_komari(a.detect):
            print('komari')
        elif probe_nezha(a.detect):
            print('nezha')
        else:
            print('unknown')
        return

    if a.stub:
        out.parent.mkdir(parents=True, exist_ok=True)
        write_text_atomic(out, render({}, ts, '空占位：安装时由安装器重新生成', a.site_name,
                                      source=a.source))
        print(f'wrote {out}（空占位，SOURCE={a.source}，PROBES={{}}）')
        return

    if a.komari:
        try:
            probes, sitename, history_days, nodes = read_komari(a.komari)
        except KomariUrlError as e:
            print(f'✗ Komari 地址不合法：{e}', file=sys.stderr)
            sys.exit(2)
        except Exception as e:
            print(f'✗ 读 Komari API 失败：{e}', file=sys.stderr)
            sys.exit(1)
        name = a.site_name or sitename
        out.parent.mkdir(parents=True, exist_ok=True)
        write_text_atomic(out, render(probes, ts, 'Komari 的公开 API', name,
                                      source='komari', history_days=history_days))
        if a.npc_allow_out:
            komari_ids = komari_npc_ids(nodes)
            if komari_ids or not probes:
                ids = komari_ids + ['t%s' % k for k in probes]
                n = write_npc_allowlist(a.npc_allow_out, ids, ts)
                print(f'NPC 白名单：{n} 条 → {a.npc_allow_out}')
            else:
                # /api/nodes 失败但任务列表拿到了：只写 t 部分会让所有探针鸡被白名单挡掉，
                # 宁可不写（退回“相信客户端名单”）也别把站点变成空农场。
                print('⚠ 没拿到 Komari 节点列表 → 这次不写 NPC 白名单（避免探针鸡全被挡）',
                      file=sys.stderr)
        print(f'wrote {out}: {len(probes)} 个探测任务（Komari，不含节点 UUID/主机名/IP/探测目标）@ {ts}')
        print(f'HISTORY_DAYS={history_days or 0}  SITE_NAME={name or "（页面默认）"}')
        return

    if a.nezha:
        try:
            probes, sitename, history_days, nodes = read_nezha(a.nezha)
        except NezhaUrlError as e:
            print(f'✗ 哪吒地址不合法：{e}', file=sys.stderr)
            sys.exit(2)
        except Exception as e:
            print(f'✗ 读哪吒 API 失败：{e}', file=sys.stderr)
            sys.exit(1)
        name = a.site_name or sitename
        out.parent.mkdir(parents=True, exist_ok=True)
        write_text_atomic(out, render(probes, ts, '哪吒监控的公开 API', name,
                                      source='nezha', history_days=history_days))
        if a.npc_allow_out:
            node_ids = nezha_npc_ids(nodes)
            if node_ids or probes:
                ids = node_ids + ['t%s' % k for k in probes]
                n = write_npc_allowlist(a.npc_allow_out, ids, ts)
                print(f'NPC 白名单：{n} 条 → {a.npc_allow_out}')
                if probes and not node_ids:
                    # 只写 t 是安全的：没有 WS 就没有探针鸡，网站鸡照常；别让文件缺失退回完全信任。
                    print('⚠ 没拿到哪吒节点列表 → 白名单只写网站鸡（t）；'
                          '页面上若应出现探针鸡，检查 WS 后重跑 install', file=sys.stderr)
            else:
                print('（没有节点/服务：不更新 NPC 白名单，现有文件保留）', file=sys.stderr)
        print(f'wrote {out}: {len(probes)} 个服务监控（Nezha，不含主机名/IP/探测目标）@ {ts}')
        print(f'HISTORY_DAYS={history_days or 0}  SITE_NAME={name or "（页面默认）"}')
        return

    node_ids = []
    if a.db:
        if not pathlib.Path(a.db).exists():
            print(f'✗ 找不到数据库 {a.db}', file=sys.stderr)
            sys.exit(1)
        rows, origin = read_rows_local(a.db), f'本机 {a.db}'
        node_ids = read_node_ids_local(a.db)
    elif a.ssh_host:
        # ⚠ 注释里不能写 ssh 别名：config.js 是公开文件（谁都能下载），别名往往就是主机名
        rows, origin = read_rows_ssh(a.ssh_host), '从 hub 所在机器读到的库'
    else:
        print('✗ 要给出 --db <路径>、--ssh <别名>、--komari <地址> 或 --nezha <地址>（或 --stub 生成空占位）',
              file=sys.stderr)
        sys.exit(2)

    probes = {str(r[0]): {'name': r[1], 'interval': r[3] if len(r) > 3 else 60} for r in rows}
    targets = {str(r[0]): (r[2] if len(r) > 2 else '') for r in rows}

    # ---- 解析 IP + 查国旗（带本地缓存）----
    cache = {}
    cache_path = pathlib.Path(a.cache)
    if cache_path.exists():
        try:
            cache = json.loads(cache_path.read_text(encoding='utf-8'))
        except Exception:
            cache = {}
    noflag = []
    if not a.no_geo:
        ips = {tid: resolve_host(t) for tid, t in targets.items()}
        try:
            need = [ips[t] for t in probes if ips.get(t) and ips[t] not in cache]
            cache.update(geo_countries(need))
            try:
                write_text_atomic(cache_path, json.dumps(cache, ensure_ascii=False, indent=1, sort_keys=True))
            except Exception as e:
                print(f'  ! 国旗缓存写不进去（不影响结果）：{e}', file=sys.stderr)
        except Exception as e:
            print(f'  ! 国旗查询失败（用缓存兜底）：{e}', file=sys.stderr)
        for tid in probes:
            cc = cache.get(ips.get(tid) or '', '')
            if cc:
                probes[tid]['flag'] = cc
            else:
                noflag.append(probes[tid].get('name') or tid)

    out.parent.mkdir(parents=True, exist_ok=True)
    write_text_atomic(out, render(probes, ts, origin, a.site_name, source='monitor'))
    if a.npc_allow_out:
        if node_ids or probes:
            ids = ['n%s' % i for i in node_ids] + ['t%s' % k for k in probes]
            n = write_npc_allowlist(a.npc_allow_out, ids, ts)
            print(f'NPC 白名单：{n} 条 → {a.npc_allow_out}')
            if probes and not node_ids:
                print('⚠ 读不到 hub 的 node 表 → 白名单只写网站鸡（t）；'
                      '页面上若应出现探针鸡，检查 DB/API 后重跑', file=sys.stderr)
        else:
            print('（没有节点/任务：不更新 NPC 白名单，现有文件保留）', file=sys.stderr)
    print(f'wrote {out}: {len(probes)} 个探测任务（不含主机名/IP/探测目标）@ {ts}')
    print('国旗：' + json.dumps({t: p.get('flag', '—') for t, p in probes.items()}, ensure_ascii=False))
    if noflag:
        print(f'⚠ 没查到国旗（前端显示 🌐）：{noflag}', file=sys.stderr)


if __name__ == '__main__':
    main()
