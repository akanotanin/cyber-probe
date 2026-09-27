#!/usr/bin/env python3
"""从 monitor hub 的 SQLite 导出 cyber-probe 前端需要的静态信息到 js/config.js。

三种用法：

  # ① 在 hub 同一台机器上就地读库（一键包的 install 用这个：装完即显示自己那套探针数据）
  python3 gen_config.py --db /opt/monitor/data/monitor.db --out /var/www/cyber-probe/js/config.js

  # ② 从开发机走 ssh 读远端库（本地开发 / 线上部署用）
  python tools/gen_config.py --ssh <你 ssh config 里的别名> --out js/config.js

  # ③ 生成空占位（hub 里一个探测任务都没有时，前端也能正常起）
  python tools/gen_config.py --stub --out js/config.js

★ 隐私约定：**探测任务的目标域名与节点 hostname/IP 一律不导出**（这个站是公开的，
  config.js 谁都能下载 —— 所以是"不落盘"，而不是"下载到了但界面不显示"）。
★ 国旗：网站鸡名牌上要显示"这个探测点 IP 所在地"，所以生成时把 target 解析成 IP、
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
    out = subprocess.run(['ssh', host, 'python3 -'], input=script,
                         capture_output=True, text=True, timeout=90)
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
    """批量查国家码（ip-api.com 免费批量接口，无需 key）。只取 countryCode。"""
    ips = sorted({ip for ip in ips if ip})
    if not ips:
        return {}
    req = urllib.request.Request(
        'http://ip-api.com/batch?fields=status,countryCode,query',
        data=json.dumps(ips).encode(), headers={'Content-Type': 'application/json'})
    out = {}
    for r in json.load(urllib.request.urlopen(req, timeout=25)):
        cc = str(r.get('countryCode') or '').upper()
        if r.get('status') == 'success' and len(cc) == 2:
            out[r['query']] = cc
    return out


def render(probes, ts, origin, site_name=''):
    # ☆ SITE_NAME：这个站**自己**叫什么名字（浏览器页签 / 站点名）。
    #   刻意留成安装时的参数而不是写死在 index.html 里 —— 公开仓库与发布包保持中性默认，
    #   每个实例在目标机上用自己的名字（和 PROBES 一个思路：站内数据不进公开包）。
    return f"""// 由 tools/gen_config.py 于 {ts} 从 hub 数据库导出（{origin}）。
// 只含探测任务的名称、间隔与国旗码；**节点主机名/IP 与探测目标域名刻意不导出**（站点公开，谁都能下载这个文件）。
// 国旗码 = 该探测点 IP 的所在地（生成时解析 + 查库，只留两个字母）。
// SITE_NAME 是本站自己的名字（安装时用 --site-name 给，空则用页面自带的默认名）。
// hub 里增删探测任务后重跑安装即可刷新。
export const GENERATED_AT = {json.dumps(ts)};
export const SITE_NAME = {json.dumps(site_name, ensure_ascii=False)};
export const PROBES = {json.dumps(probes, ensure_ascii=False, indent=2)};
"""


def main():
    ap = argparse.ArgumentParser(description='导出 hub 的探测任务清单到 config.js')
    ap.add_argument('--db', help='本机 monitor.db 路径（与 hub 同机时用）')
    ap.add_argument('--ssh', dest='ssh_host', help='从开发机走 ssh 读远端库，参数是 ssh 别名')
    ap.add_argument('--stub', action='store_true', help='生成空占位（不读库）')
    ap.add_argument('--out', default='js/config.js', help='输出路径（默认 js/config.js）')
    ap.add_argument('--cache', default=str(DEFAULT_CACHE), help='国旗缓存文件路径')
    ap.add_argument('--no-geo', action='store_true', help='不查国旗（离线安装用，前端显示 🌐）')
    ap.add_argument('--site-name', default='', help='本站的名字（显示在浏览器页签；留空则用页面默认名）')
    a = ap.parse_args()

    ts = datetime.datetime.now().astimezone().isoformat(timespec='seconds')
    out = pathlib.Path(a.out)

    if a.stub:
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(render({}, ts, '空占位：安装时由安装器就地读 hub 数据库重新生成', a.site_name),
                       encoding='utf-8')
        print(f'wrote {out}（空占位，PROBES={{}}）')
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
        print('✗ 要给出 --db <路径> 或 --ssh <别名>（或 --stub 生成空占位）', file=sys.stderr)
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
    out.write_text(render(probes, ts, origin, a.site_name), encoding='utf-8')
    print(f'wrote {out}: {len(probes)} 个探测任务（不含主机名/IP/探测目标）@ {ts}')
    print('国旗：' + json.dumps({t: p.get('flag', '—') for t, p in probes.items()}, ensure_ascii=False))
    if noflag:
        print(f'⚠ 没查到国旗（前端显示 🌐）：{noflag}', file=sys.stderr)


if __name__ == '__main__':
    main()
