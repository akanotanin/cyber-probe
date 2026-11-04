#!/usr/bin/env python3
"""服务端侧（审查报告 BUG-04/07/21/23/24/25）的白盒回归。不起网络，直接驱动 Game。"""
import pathlib
import sys
import time
from types import SimpleNamespace

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'server'))
import farm_server as farm   # noqa: E402

fails = []


def check(name, cond, detail=''):
    print(('PASS  ' if cond else 'FAIL  ') + name + ('  ' + detail if (detail and not cond) else ''))
    if not cond:
        fails.append(name)


def client(cid, roster=None):
    c = SimpleNamespace(id=cid, npc_roster=dict(roster or {}), hot_ids=set(), name=f'c{cid}',
                        score=0, cc='', x=0.0, z=0.0, y=0.0, yaw=0.0, hp=100.0, ko_until=0.0,
                        dead=False, msg_count=0, msg_window=0.0, last_msg=farm.now(), ip='1.1.1.1',
                        kicked=False, alive=True, pos_t=farm.now(), clamped=0)
    return c


# ---- BUG-04：64 个 junk id 不能把全服名额占满 ----
g = farm.Game(geese=0, dogs=0)
a, b = client(1), client(2)
g.clients = {1: a, 2: b}
junk = [{'id': f'zz{i:02d}', 'name': f'junk{i}'} for i in range(64)]
g.set_npcs(a, junk)
check('junk 名单：单连接最多 8 个', len(g.probes) <= farm.MAX_NPC_JUNK_PER_CLIENT,
      'probes=%d' % len(g.probes))
g.set_npcs(b, [{'id': 'n1', 'name': 'real1'}, {'id': 'n2', 'name': 'real2'}])
check('后上报的真实探针鸡仍然建得出来（n1）', 'n1' in g.probes, str(sorted(g.probes)))
check('后上报的真实探针鸡仍然建得出来（n2）', 'n2' in g.probes)
check('junk 没挤掉真实鸡', len([k for k in g.probes if k.startswith('zz')]) <= farm.MAX_NPC_JUNK_PER_CLIENT)

# 名额被 junk 占满时，真实 id 也能挤进来（8 条连接 × 8 个 junk = 64，正好顶满）
g2 = farm.Game(geese=0, dogs=0)
g2.clients = {}
for i in range(8):
    ci = client(10 + i)
    g2.clients[ci.id] = ci
    g2.set_npcs(ci, [{'id': f'j{i}{k}', 'name': 'j'} for k in range(8)])
check('8 条连接能把 64 个名额占满', len(g2.probes) == farm.MAX_NPCS, 'probes=%d' % len(g2.probes))
c9 = client(99)
g2.clients[99] = c9
g2.set_npcs(c9, [{'id': 'n9', 'name': 'real9'}])
check('名额满（全是 junk）时真实 id 能挤进来',
      'n9' in g2.probes and len(g2.probes) == farm.MAX_NPCS, 'probes=%d' % len(g2.probes))

# ---- BUG-21：客户端不能冒用 d<n>/g<n> ----
g3 = farm.Game(geese=2, dogs=1)
c3 = client(3)
g3.clients = {3: c3}
g3.set_npcs(c3, [{'id': 'd1', 'name': 'fake-dog'}, {'id': 'g1', 'name': 'fake-goose'},
                 {'id': 'n3', 'name': 'ok'}])
check('客户端 id=d1 被拒（不跟看门狗撞 id）', 'd1' not in g3.probes)
check('客户端 id=g1 被拒（不跟大白鹅撞 id）', 'g1' not in g3.probes)
check('正常 id 照旧', 'n3' in g3.probes)

# ---- BUG-23：回收缓存保留倒地剩余时间 ----
g4 = farm.Game(geese=0, dogs=0)
c4 = client(4, {'n7': ('x', 'probe', 1.0)})
g4.clients = {4: c4}
g4.sync_npcs()
p = g4.probes['n7']
p.hp = 0.0
p.ko_until = farm.now() + 3.0
c4.npc_roster = {}
g4.sync_npcs()                      # 摘掉 → 进回收缓存
c4.npc_roster = {'n7': ('x', 'probe', 1.0)}
g4.sync_npcs()                      # 同 id 回来 → 应该还在倒地
p2 = g4.probes['n7']
check('回收再回来仍在倒地（ko_until 一起缓存）', p2.ko_until > farm.now() + 2.0,
      'ko_until-now=%.2f' % (p2.ko_until - farm.now()))
check('回收再回来血量还是 0（没被满血复活）', p2.hp == 0.0, 'hp=%s' % p2.hp)

# ---- BUG-07：t:'flap' 不再广播整场快照 ----
g5 = farm.Game(geese=0, dogs=0)
c5 = client(5)
g5.clients = {5: c5}
sent = []
g5.broadcast = lambda msg, skip=None: sent.append(msg)
g5.on_msg(c5, {'t': 'flap'})
check('t=flap 不再触发全场广播', not sent, 'broadcasts=%d' % len(sent))

# ---- 2026-11-04：重复 hi / 进场 / 离场 的 roster 必须合并，不能每条消息全场广播 ----
g5b = farm.Game(geese=0, dogs=0)
c5b = client(55)
g5b.clients = {55: c5b}
roster_calls = []
g5b.roster = lambda: roster_calls.append(1)
for _ in range(60):
    g5b.on_msg(c5b, {'t': 'hi', 'name': 'spam', 'color': 2})
check('重复 hi 先标脏、不立即广播', len(roster_calls) == 0, 'roster_calls=%d' % len(roster_calls))
g5b.flush_roster(force=True)
check('60 条 hi 合并成 1 次 roster 广播', len(roster_calls) == 1,
      'roster_calls=%d' % len(roster_calls))
check('第一条 hi 的名字仍然生效', c5b.name == 'spam', repr(c5b.name))
# 连续 60 次标记（模拟 connect/close churn）→ 强制 flush 只发一份
g5b.roster_dirty = False
for _ in range(60):
    g5b.mark_roster()
g5b.flush_roster(force=True)
check('60 次进场/离场标记合并成 1 次 roster 广播', len(roster_calls) == 2,
      'roster_calls=%d' % len(roster_calls))

# ---- 2026-11-04：热状态在 NPC 被回收再创建后不能丢（客户端不会重发 hot）----
g5c = farm.Game(geese=0, dogs=0)
c5c = client(56)
g5c.clients = {56: c5c}
g5c.set_npcs(c5c, [{'id': 'n1', 'name': 'node1', 'kind': 'probe'}])
g5c.on_msg(c5c, {'t': 'hot', 'ids': ['n1']})
check('hot：先建出来并标热', g5c.probes['n1'].hot is True)
g5c.set_npcs(c5c, [])                       # hub 抖动：名单暂时为空
g5c.set_npcs(c5c, [{'id': 'n1', 'name': 'node1', 'kind': 'probe'}])
check('hot：回收再重建后仍是暴躁鸡（不用客户端重发）', g5c.probes['n1'].hot is True,
      'hot=%s' % g5c.probes['n1'].hot)

# ---- 2026-11-04：0 血但 KO 计时刚到期的空档不能再次被 KO/重复记功 ----
g5d = farm.Game(geese=0, dogs=0)
c5d = farm.Client(None, None, {})          # 真 Client：dead/take_hit 是属性/方法
c5d.hp = 0.0
c5d.ko_until = farm.now() - 0.01
check('0 血 + KO 到期 → dead 仍为 True', c5d.dead is True)
check('0 血 + KO 到期 → take_hit 不再记一次 KO', c5d.take_hit(10) is False)
p5d = farm.Probe('n57', 'victim')
p5d.hp = 0.0
p5d.ko_until = farm.now() - 0.01
check('探针鸡 0 血 + KO 到期 → dead 仍为 True', p5d.dead is True)
check('探针鸡 0 血 + KO 到期 → take_hit 不再记一次 KO', p5d.take_hit(10) is False)

# ---- 2026-11-04：客户端不能冒用 g*/d* 前缀（前端按首字母分派模型）----
g5e = farm.Game(geese=1, dogs=1)
c5e = client(58)
g5e.clients = {58: c5e}
g5e.set_npcs(c5e, [{'id': 'g1x', 'name': 'fake-goose'}, {'id': 'd1x', 'name': 'fake-dog'},
                   {'id': 'n1', 'name': 'real'}])
check('g1x/d1x 被拒（前端会按首字母当鹅/狗）',
      'g1x' not in g5e.probes and 'd1x' not in g5e.probes and 'n1' in g5e.probes,
      str(sorted(g5e.probes)))

# ---- 2026-11-04：安装器白名单存在时，假 n…/t… 一律不建 ----
g5f = farm.Game(geese=0, dogs=0, npc_allow={'n1', 't1'})
c5f = client(59)
g5f.clients = {59: c5f}
g5f.set_npcs(c5f, [{'id': 'n1', 'name': 'node1'}, {'id': 'n900001', 'name': 'fake'},
                   {'id': 't1', 'name': 'task1', 'kind': 'web'}, {'id': 't999', 'name': 'fake-web'}])
check('NPC 白名单：只创建 n1/t1，假 id 被忽略',
      set(g5f.probes) == {'n1', 't1'}, str(sorted(g5f.probes)))
# 黑盒自测的 x1 假鸡不能被白名单误伤（否则线上 `run test` 会红）
g5f.set_npcs(c5f, [{'id': 'n1', 'name': 'node1'}, {'id': 'x1', 'name': '测试鸡'}])
check('NPC 白名单：x* 测试 id 仍可创建（run test 依赖）', 'x1' in g5f.probes,
      str(sorted(g5f.probes)))

# ---- BUG-25：Client 不再常驻整份请求头 ----
hdr = {'x-real-ip': '9.9.9.9', 'cf-ipcountry': 'jp', 'user-agent': 'x' * 5000}
cl = farm.Client(None, None, hdr)
check('Client 不保留整份 headers', not hasattr(cl, 'headers'))
check('国旗码仍然算得出来', cl.cc == 'JP', cl.cc)

# ---- 大白鹅/看门狗数量上限：手滑多打一个 0 不能把 20Hz 主循环拖死 ----
# 主循环每帧对 NPC 做 O(N²) 软分离，实测 800 只鹅 = 126ms/帧（预算 50ms）。
g6 = farm.Game(geese=10 ** 6, dogs=10 ** 6)
check('大白鹅数量被夹到上限', len(g6.geese) == farm.MAX_GEESE, 'geese=%d' % len(g6.geese))
check('看门狗数量被夹到上限', len(g6.dogs) == farm.MAX_DOGS, 'dogs=%d' % len(g6.dogs))
check('上限本身足够小（64 只鹅仍在 20Hz 预算内）', farm.MAX_GEESE <= 64 and farm.MAX_DOGS <= 8)

print()
print('失败 %d 项' % len(fails) if fails else '全部通过')
sys.exit(1 if fails else 0)
