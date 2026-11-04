#!/usr/bin/env python3
"""2026-11-03 复审修复的回归测试（Windows / Linux 都能跑，不依赖 nginx/caddy 真身）。

覆盖：
  ① vhost.py：Caddy 独立域名安装校验失败时，Caddyfile 里的 import 行必须一起回滚
  ② caddy_patch.py：片段已不存在但 import 还在时，--remove 必须真的把 import 写掉
  ③ nginx_patch.py：单行 location 块只能删它自己，不能把后面的用户配置一起吞掉
  ④ farm_server.py：npc_seen 不能因为「垃圾 id 被淘汰」而无上限增长
  ⑤ 安装器静态门禁：domain+Caddy 传 --caddyfile、探测排除自己的 vhost、config 拒绝安装参数
"""
import math
import pathlib
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
PY = sys.executable
VHOST = ROOT / 'tools' / 'vhost.py'
CADDY = ROOT / 'tools' / 'caddy_patch.py'
NGX = ROOT / 'tools' / 'nginx_patch.py'
HDR = ROOT / 'tools' / 'run_header.sh'

fails = []


def check(name, cond, detail=''):
    print(('PASS  ' if cond else 'FAIL  ') + name + ('  ' + detail if (detail and not cond) else ''))
    if not cond:
        fails.append(name)


def run(args):
    return subprocess.run([PY] + [str(a) for a in args],
                          capture_output=True, text=True, encoding='utf-8', errors='replace')


tmp = pathlib.Path(tempfile.mkdtemp(prefix='cp-r2-'))

# ① vhost.py：Caddy 安装失败 → Caddyfile 保持原样（import 行必须撤销）
d1 = tmp / 'vhost'
d1.mkdir()
caddyfile = d1 / 'Caddyfile'
original = 'hub.test {\n\treverse_proxy 127.0.0.1:28080\n}\n'
# 故意写一条非法指令：caddy 在不在本机都会校验失败，回滚路径是确定的
caddyfile.write_text(original + 'this_is_not_a_caddy_directive\n', encoding='utf-8')
before = caddyfile.read_text(encoding='utf-8')
r = run([VHOST, '--proxy', 'caddy', '--domain', 'farm.test', '--webroot', str(d1 / 'site'),
         '--ws-port', '28910', '--hub-port', '28080', '--conf', caddyfile])
check('vhost(caddy)：校验失败返回 4', r.returncode == 4, f'rc={r.returncode} {r.stderr[-200:]}')
check('vhost(caddy)：Caddyfile 回滚成原文（import 行没留下）',
      caddyfile.read_text(encoding='utf-8') == before,
      caddyfile.read_text(encoding='utf-8'))
check('vhost(caddy)：片段文件不会留下孤儿',
      not (d1 / 'cyber-probe-farm.test.caddy').exists())

# ② caddy_patch.py：片段缺失 + import 残留 → --remove 必须把 import 写掉
d2 = tmp / 'caddy'
d2.mkdir()
conf2 = d2 / 'Caddyfile'
snip2 = d2 / 'conf.d' / 'cyber-probe.caddy'
snip2.parent.mkdir()
conf2.write_text('t.test {\n\treverse_proxy 127.0.0.1:28080\n}\n' +
                 f'import {snip2}\n', encoding='utf-8')
r = run([CADDY, '--local', '--no-reload', '--remove', '--conf', conf2,
         '--snippet', snip2, '--domain', 't.test'])
txt2 = conf2.read_text(encoding='utf-8')
check('caddy_patch：片段缺失时 remove 返回 0', r.returncode == 0, f'rc={r.returncode} {r.stderr[-200:]}')
check('caddy_patch：import 行真的从 Caddyfile 里删掉了', 'import ' not in txt2, txt2)
check('caddy_patch：remove 后 Caddyfile 可解析（t.test 块还在）', 't.test {' in txt2)

# ②b Caddy 片段：/chicken 的 301 必须显式写 matcher
#    `redir /chicken/ 301` 会被 Caddy 解析成「匹配 /chicken/、跳到字面量 301」，
#    /chicken（无斜杠）返回 200 空页（真 caddy 2.6 复现）。必须是 `redir * /chicken/ 301`。
d2b = tmp / 'caddy-redir'
d2b.mkdir()
conf2b = d2b / 'Caddyfile'
conf2b.write_text('t.test {\n\treverse_proxy 127.0.0.1:28080\n}\n', encoding='utf-8')
snip2b = d2b / 'conf.d' / 'cyber-probe.caddy'
run([CADDY, '--local', '--no-reload', '--conf', conf2b, '--snippet', snip2b,
     '--domain', 't.test', '--hub-port', '28080', '--ws-port', '28910',
     '--webroot', str(d2b / 'www'), '--path', '/chicken/'])
body2b = snip2b.read_text(encoding='utf-8') if snip2b.exists() else ''
check('caddy_patch：/chicken 的 301 带显式 matcher（redir * /chicken/ 301）',
      'redir * /chicken/ 301' in body2b, body2b[-300:])

# ③ nginx_patch.py：单行块只删自己
d3 = tmp / 'nginx'
d3.mkdir()
conf3 = d3 / 'site.conf'
user_block = 'server {\n    listen 443 ssl;\n    server_name t.test;\n'
our_line = ('    location = /chicken/ws { proxy_pass http://127.0.0.1:28910; '
            'proxy_set_header Connection "upgrade"; '
            'proxy_set_header CF-IPCountry $http_cf_ipcountry; }\n')
user_rest = ('    location / {\n        proxy_pass http://127.0.0.1:28080;\n    }\n'
             '    # keep me\n    add_header X-Thing "yes";\n}\n')
conf3.write_text(user_block + our_line + user_rest, encoding='utf-8')
r = run([NGX, '--local', '--no-reload', '--remove', '--conf', conf3,
         '--hub-port', '28080', '--ws-port', '28910', '--webroot', '/srv/site', '--path', '/chicken/'])
after3 = conf3.read_text(encoding='utf-8')
check('nginx_patch：单行 location 块能被摘掉', 'chicken' not in after3, after3)
check('nginx_patch：用户的 location / 与后续配置还在', 'location / {' in after3 and 'add_header X-Thing' in after3, after3)

# ④ farm_server：npc_seen 有界
sys.path.insert(0, str(ROOT / 'server'))
import farm_server as farm  # noqa: E402

g = farm.Game(tick_hz=20, debug=False, geese=0, dogs=0)


class _C:
    def __init__(self, cid):
        self.id = cid
        self.npc_roster = {}
        self.hot_ids = set()
        self.score = 0
        self.name = 'x'


a, b = _C(1), _C(2)
g.clients = {1: a, 2: b}


def set_roster(c, ids):
    g.set_npcs(c, [{'id': i, 'name': i, 'kind': 'probe', 'cpu': 1} for i in ids])


set_roster(b, [f'n{i}' for i in range(100, 132)])
base = [f'n{i}' for i in range(1, 25)]
for k in range(30):
    set_roster(a, base + [f'x{k}_{i}' for i in range(8)])      # 24 真实 + 8 垃圾，塞满 64
    set_roster(a, [f'n{10000 + k * 32 + i}' for i in range(32)])  # 新真实 id 挤掉垃圾
    set_roster(a, [])
cap = farm.MAX_NPCS + farm.NPC_CACHE_MAX
check('farm_server：npc_seen 不会随垃圾 id 淘汰无限增长', len(g.npc_seen) <= cap,
      f'len={len(g.npc_seen)} cap={cap}')
check('farm_server：npc_seen 只保留仍在场的 id', set(g.npc_seen) == set(g.probes),
      f'seen={len(g.npc_seen)} probes={len(g.probes)}')

# ④b 场上没有玩家（全倒地/没人）时，被另一只鸡欺负也要回击 —— 以前 tgt is None 直接跳过
p1 = farm.Probe('n1', '欺负者')
p1.x, p1.z = 0.0, 0.0
p2 = farm.Probe('n2', '受害者')
p2.x, p2.z = 1.5, 0.0
p2.react_mode = 'fight'
p2.react_until = farm.now() + 5
p2.react_by = 'n1'
p2.step(0.05, [], lambda *a, **k: None, {'n1': p1, 'n2': p2}, lambda *a, **k: True)
want = math.atan2(p1.x - p2.x, p1.z - p2.z)
check('farm_server：没有玩家时被另一只鸡欺负也会回击（面向攻击者）',
      abs(((p2.yaw - want + math.pi) % (2 * math.pi)) - math.pi) < 0.05,
      f'yaw={p2.yaw:.3f} want={want:.3f}')

# ⑤ 安装器静态门禁
hdr = HDR.read_text(encoding='utf-8')
check('installer：domain+Caddy 会传 --conf "$CADDYFILE"',
      '--hub-port "$HUB_PORT" --conf "$CADDYFILE"' in hdr)
check('installer：探测 nginx 配置时排除自己的 cyber-probe vhost',
      "'/cyber-probe-[^/]*\\.conf$'" in hdr or '/cyber-probe-[^/]*\\.conf$' in hdr)
check('installer：上游探测接受 localhost / [::1]',
      'localhost' in hdr and '\\[::1\\]' in hdr)
check('installer：config 模式拒绝安装类参数',
      'config 只改玩法参数' in hdr)
check('installer：install 在动静态站之前先把设置落盘',
      hdr.index('设置已写入 $SETTINGS') < hdr.index('say "-- 1/6 静态站 --"'))
check('installer：接管警告在写设置之前（否则永远比不出旧服务）',
      hdr.index('  warn_service_takeover\n') < hdr.index('  save_settings\n'))
check('installer：接管警告只调用一次（装单元前不许重复）',
      hdr.count('  warn_service_takeover\n') == 1)

print()
if fails:
    print(f'失败 {len(fails)} 项：' + '，'.join(fails))
    sys.exit(1)
print('全部通过')
