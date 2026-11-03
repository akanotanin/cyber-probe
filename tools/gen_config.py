#!/usr/bin/env python3
"""从 monitor hub 的 SQLite 或 Komari 的公开 API 导出 cyber-probe 的静态信息到 js/config.js。

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

★ 隐私约定：**探测任务的目标域名与节点 hostname/IP 一律不导出**（这个站是公开的，
  config.js 谁都能下载 —— 所以是"不落盘"，而不是"下载到了但界面不显示"）。
  Komari 模式也不导出节点 UUID / clients 列表，只留任务 id、名称、间隔与站名。
★ 国旗（仅 monitor）：网站鸡名牌要显示"这个探测点 IP 所在地"，所以生成时把 target 解析成 IP、
  查一次国家码，只把两个字母的码写进 config.js（域名与 IP 都不落盘）。
  查库用 ip-api.com 的免费批量接口，结果缓存到 flag_cache.json；
  接口不可达或加了 --no-geo 时用缓存/留空（前端退化为 🌐）。
"""
import argparse
import datetime
import json
import pathlib
import socket
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
    """target 形如 host:port（也可能带路径）→ 解析出 IPv4；解析不了返回空串。"""
    host = str(target or '').split('/')[0]
    if ':' in host:
        host = host.rsplit(':', 1)[0]
    try:
        infos = socket.getaddrinfo(host, None, socket.AF_INET)
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
    """从 Komari 的公开 API 取探测任务清单 + 站名 + 历史保留天数。

    ★ 隐私：只取任务 id / 名称 / 间隔；**绝不导出** clients（节点 UUID）、type 细节或任何
      探测目标 —— config.js 是公开文件。Komari 的 API 本身也不暴露 ping 目标。
    """
    base = komari_url(base)
    public = unwrap_komari(fetch_json(base + '/api/public'))
    if not isinstance(public, dict):
        raise RuntimeError('/api/public 返回的不是对象')
    tasks = unwrap_komari(fetch_json(base + '/api/task/ping'))
    if not isinstance(tasks, list):
        raise RuntimeError('/api/task/ping 返回的不是数组')

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
    return probes, str(public.get('sitename') or ''), history_days


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
// SOURCE 是数据源（monitor / komari）；hub 或 Komari 里增删探测任务后重跑安装即可刷新。
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
    ap.add_argument('--stub', action='store_true', help='生成空占位（不读库）')
    ap.add_argument('--source', choices=['monitor', 'komari'], default='monitor',
                    help='--stub 时空占位标哪个数据源（默认 monitor）')
    ap.add_argument('--detect', metavar='URL', help='探测 URL 是不是 Komari，打印 komari/unknown 后退出')
    ap.add_argument('--out', default='js/config.js', help='输出路径（默认 js/config.js）')
    ap.add_argument('--cache', default=str(DEFAULT_CACHE), help='国旗缓存文件路径')
    ap.add_argument('--no-geo', action='store_true', help='不查国旗（离线安装用，前端显示 🌐）')
    ap.add_argument('--site-name', default='', help='本站的名字（显示在浏览器页签；留空则用页面默认名）')
    a = ap.parse_args()

    ts = datetime.datetime.now().astimezone().isoformat(timespec='seconds')
    out = pathlib.Path(a.out)

    if a.detect:
        print('komari' if probe_komari(a.detect) else 'unknown')
        return

    if a.stub:
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(render({}, ts, '空占位：安装时由安装器重新生成', a.site_name,
                              source=a.source), encoding='utf-8')
        print(f'wrote {out}（空占位，SOURCE={a.source}，PROBES={{}}）')
        return

    if a.komari:
        try:
            probes, sitename, history_days = read_komari(a.komari)
        except KomariUrlError as e:
            print(f'✗ Komari 地址不合法：{e}', file=sys.stderr)
            sys.exit(2)
        except Exception as e:
            print(f'✗ 读 Komari API 失败：{e}', file=sys.stderr)
            sys.exit(1)
        name = a.site_name or sitename
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(render(probes, ts, 'Komari 的公开 API', name,
                              source='komari', history_days=history_days), encoding='utf-8')
        print(f'wrote {out}: {len(probes)} 个探测任务（Komari，不含节点 UUID/主机名/IP/探测目标）@ {ts}')
        print(f'HISTORY_DAYS={history_days or 0}  SITE_NAME={name or "（页面默认）"}')
        return

    if a.db:
        if not pathlib.Path(a.db).exists():
            print(f'✗ 找不到数据库 {a.db}', file=sys.stderr)
            sys.exit(1)
        rows, origin = read_rows_local(a.db), f'本机 {a.db}'
    elif a.ssh_host:
        # ⚠ 注释里不能写 ssh 别名：config.js 是公开文件（谁都能下载），别名往往就是主机名
        rows, origin = read_rows_ssh(a.ssh_host), '从 hub 所在机器读到的库'
    else:
        print('✗ 要给出 --db <路径>、--ssh <别名> 或 --komari <地址>（或 --stub 生成空占位）', file=sys.stderr)
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
                cache_path.write_text(json.dumps(cache, ensure_ascii=False, indent=1, sort_keys=True),
                                      encoding='utf-8')
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
    out.write_text(render(probes, ts, origin, a.site_name, source='monitor'), encoding='utf-8')
    print(f'wrote {out}: {len(probes)} 个探测任务（不含主机名/IP/探测目标）@ {ts}')
    print('国旗：' + json.dumps({t: p.get('flag', '—') for t, p in probes.items()}, ensure_ascii=False))
    if noflag:
        print(f'⚠ 没查到国旗（前端显示 🌐）：{noflag}', file=sys.stderr)


if __name__ == '__main__':
    main()
