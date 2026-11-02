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
