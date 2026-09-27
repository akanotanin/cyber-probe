#!/usr/bin/env python3
"""联机服务端自测（纯 stdlib WS 客户端，不需要浏览器）：
   两个假客户端互相啄，断言掉血/啄倒/计分都由服务端裁定。

用法: python server/test_server.py [host] [port]
"""
import base64, json, math, os, socket, struct, sys, time

HOST = sys.argv[1] if len(sys.argv) > 1 else '127.0.0.1'
PORT = int(sys.argv[2]) if len(sys.argv) > 2 else 28910
MAX_PER_IP = 12          # 必须与 server/farm_server.py 的 MAX_PER_IP 一致（同一 IP 的并发上限）
SEP_MIN_EXPECT = 1.0     # 必须与 server/farm_server.py 的 SEP_MIN 一致（NPC 之间目标间距 = PROBE_R*2）
PASS, FAIL = [], []


def check(label, ok, extra=''):
    (PASS if ok else FAIL).append(label)
    print(f'{"PASS" if ok else "FAIL"}  {label}' + (f' — {extra}' if extra else ''))


def _exact(s, n):
    buf = b''
    while len(buf) < n:
        chunk = s.recv(n - len(buf))
        if not chunk:
            raise ConnectionError('closed')
        buf += chunk
    return buf


class WS:
    """裸 WebSocket 连接（自测用）。

    ⚠ 握手响应的**同一个 TCP 段里可能已经带着 welcome/roster/快照**（服务端一口气写完时），
    所以收完 HTTP 头后剩下的字节必须留着继续用，不能丢 —— 丢掉的话在低延迟的远端机器上
    第一条断言就会莫名失败（Windows 本机两个包分开到达，才侥幸没暴露）。
    """

    def __init__(self, s, pending=b''):
        self.s, self.pending = s, pending

    def __getattr__(self, name):                 # close / settimeout / sendall … 透传
        return getattr(self.s, name)

    def read(self, n):
        out = b''
        if self.pending:
            out, self.pending = self.pending[:n], self.pending[n:]
            n -= len(out)
        return out + (_exact(self.s, n) if n else b'')


def ws_connect(path='/ws', headers=None):
    s = socket.create_connection((HOST, PORT), 5)
    key = base64.b64encode(os.urandom(16)).decode()
    extra = ''.join(f'{k}: {v}\r\n' for k, v in (headers or {}).items())
    s.sendall(f'GET {path} HTTP/1.1\r\nHost: {HOST}:{PORT}\r\nUpgrade: websocket\r\n'
              f'Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\n'
              f'Sec-WebSocket-Version: 13\r\n{extra}\r\n'.encode())
    buf = b''
    while b'\r\n\r\n' not in buf:
        buf += s.recv(4096)
    head, _, rest = buf.partition(b'\r\n\r\n')
    head = head.split(b'\r\n')[0].decode()
    assert '101' in head, f'握手失败: {head}'
    return WS(s, rest)


def send(s, obj):
    data = json.dumps(obj).encode()
    mask = os.urandom(4)
    n = len(data)
    head = bytearray([0x81])
    if n < 126:
        head.append(0x80 | n)
    elif n < 65536:
        head.append(0x80 | 126); head += struct.pack('>H', n)
    else:
        head.append(0x80 | 127); head += struct.pack('>Q', n)
    head += mask
    s.sendall(bytes(head) + bytes(c ^ mask[i & 3] for i, c in enumerate(data)))


class Conn:
    def __init__(self, path='/ws', headers=None):
        self.s = ws_connect(path, headers)
        self.buf = []
        self.msg = []

    def pump(self, seconds=0.6):
        """读一段时间内的所有消息，返回最后一份快照。"""
        end = time.time() + seconds
        snap = None
        self.s.settimeout(0.2)
        while time.time() < end:
            try:
                b1 = self.s.read(1)[0]
                b2 = self.s.read(1)[0]
                ln = b2 & 0x7f
                if ln == 126:
                    ln = struct.unpack('>H', self.s.read(2))[0]
                elif ln == 127:
                    ln = struct.unpack('>Q', self.s.read(8))[0]
                payload = self.s.read(ln) if ln else b''
                if b1 & 0x0f != 0x1:
                    continue
                m = json.loads(payload)
                self.msg.append(m)
                if m['t'] == 's':
                    snap = m
            except socket.timeout:
                continue
            except (ConnectionError, OSError):
                break
        return snap

    def evs(self, mark=0, kind=None):
        """取 mark 之后收到的所有事件。

        ⚠ 别只看 pump() 返回的那份快照：事件是**跟着某一帧**发出来的（服务端 pending_ev 只随一帧走），
        而 pump 只留最后一份快照 —— 0.5 秒里到 10 帧，事件所在的帧极大概率被覆盖掉。
        症状就是断言明明成立却打出"（没抓到事件）"。
        """
        out = []
        for m in self.msg[mark:]:
            if m.get('t') == 's':
                for e in m.get('ev') or []:
                    if kind is None or e.get('e') == kind:
                        out.append(e)
        return out

    def send(self, o):
        send(self.s, o)

    def close(self):
        try:
            self.s.close()
        except OSError:
            pass


def find(snap, pid):
    for e in (snap or {}).get('ps', []):
        if e[0] == pid:
            return e
    return None


def place(conn, cid, x, z, yaw=0.0, tries=12, wait=0.4):
    """把某只鸡挪到 (x,z)。

    ⚠ 服务端现在有"单次位移夹取"（防瞬移）：一步跳半张地图会被拉回，所以分几次挪
    （位移预算随上报间隔累积，每次上报允许 2m + 8m/s×间隔）。返回最后读到的快照条目。
    """
    last = None
    for _ in range(tries):
        conn.send({'t': 'p', 'x': x, 'z': z, 'y': 0, 'yaw': yaw})
        time.sleep(wait)
        last = find(conn.pump(0.15), cid)
        if last and math.hypot(last[1] - x, last[2] - z) <= 0.8:
            break
    return last


def main():
    a, b = Conn(), Conn()
    a.pump(0.4); b.pump(0.4)
    a.send({'t': 'hi', 'name': '测试甲'})
    b.send({'t': 'hi', 'name': '测试乙'})
    snap_a = a.pump(0.5)
    snap_b = b.pump(0.5)
    welcome = next((m for m in a.msg if m['t'] == 'welcome'), None)
    check('服务端握手 + welcome', welcome is not None, json.dumps(welcome, ensure_ascii=False) if welcome else '')
    if not welcome:
        return report()
    id_a, id_b = welcome['id'], next((m['id'] for m in b.msg if m['t'] == 'welcome'), None)
    # ⚠ 线上可能还有别的访客（自测要能在生产实例上跑）——只要求"包含"甲乙，不要求全场只有他俩
    roster = next((m for m in reversed(a.msg)
                   if m['t'] == 'roster' and {id_a, id_b} <= {c['id'] for c in m['list']}), None)
    check('双方都进了名单（roster 含甲乙）', roster is not None,
          json.dumps(roster['list'], ensure_ascii=False) if roster else '')
    check('名单里带着玩家自报的名字',
          bool(roster) and {'测试甲', '测试乙'} <= {c['name'] for c in roster['list']},
          str([c['name'] for c in (roster or {'list': []})['list']]))

    # 甲站在乙左边 1.2m，朝向 +x（yaw=π/2）→ 正对乙
    for _ in range(3):
        a.send({'t': 'p', 'x': 0, 'z': 0, 'y': 0, 'yaw': 1.5708, 'r': False, 's': 2})
        b.send({'t': 'p', 'x': 1.2, 'z': 0, 'y': 0, 'yaw': -1.5708, 'r': False, 's': 0})
        time.sleep(0.06)
    snap = a.pump(0.5)
    ea, eb = find(snap, id_a), find(snap, id_b)
    check('位置被服务端接收并在快照里互见', ea and eb and abs(eb[1] - 1.2) < 0.01, f'甲={ea} 乙={eb}')
    check('客户端自报的战绩不被采纳（ps 第 8 项是服务端账本，此刻仍为 0）',
          bool(ea) and len(ea) >= 8 and ea[7] == 0,
          f'甲快照={ea}（上报了 s=2，服务端应忽略）')

    # 甲连啄：9 次 × 12 伤害 = 108 → 乙被啄倒
    hp_seq = []
    for i in range(12):
        a.send({'t': 'p', 'x': 0, 'z': 0, 'y': 0, 'yaw': 1.5708, 'r': False, 's': 2})
        b.send({'t': 'p', 'x': 1.2, 'z': 0, 'y': 0, 'yaw': -1.5708, 'r': False, 's': 0})
        a.send({'t': 'peck'})
        s = a.pump(0.55)          # 服务端啄击冷却 0.5s，得等它走完这一发才算数
        e = find(s, id_b)
        if e:
            hp_seq.append(e[5])
        if e and e[6] == 1:
            break
    check('服务端按自己的位置判定掉血', len(set(hp_seq)) >= 2 and min(hp_seq) < 100, f'乙的血量序列 {hp_seq}')
    snap = b.pump(0.8)
    eb, ea = find(snap, id_b), find(snap, id_a)
    check('被啄倒的一方血量归零并进入倒地状态', eb and eb[5] == 0 and eb[6] == 1, f'乙={eb}')
    check('啄倒记在动手的人头上（玩家快照 8 项，第 8 项 = 啄倒数）',
          bool(ea) and len(ea) == 8 and ea[7] >= 1,
          f'甲的玩家快照 {ea} = [id,x,z,y,yaw,hp,ko,score]')
    ko = [e for m in b.msg for e in m.get('ev', []) if e.get('e') == 'ko']
    check('ko 事件带双方名字（给播报用）', bool(ko) and ko[0].get('fn') and ko[0].get('on'),
          json.dumps(ko[0], ensure_ascii=False) if ko else '')

    # 等乙复活（服务端 3.5 秒后满血 + 换出生点）
    hp_after = None
    for _ in range(30):
        e = find(b.pump(0.3), id_b)
        if e and e[5] > 0 and e[6] == 0:
            hp_after = e[5]
            break
    check('被啄倒 3.5 秒后自动满血复活', hp_after and hp_after >= 90, f'复活血量 {hp_after}（刚站起来可能被路过的 NPC 补一口）')

    # 隔开距离就打不到（服务端校验距离）：乙站到最远的角、甲站到离乙最远的角
    # （否则别的 NPC 会替甲把乙啄了，血量就不是 100 了）
    after = None
    for _ in range(6):
        snap = a.pump(0.3)
        others_now = (snap or {}).get('ns') or []
        corners = [(-24, -24), (24, -24), (-24, 24), (24, 24)]
        bx, bz = max(corners, key=lambda p: min([math.hypot(e[1] - p[0], e[2] - p[1]) for e in others_now] or [99]))
        ax, az = max(corners, key=lambda p: math.hypot(p[0] - bx, p[1] - bz))
        a.send({'t': 'p', 'x': ax, 'z': az, 'y': 0, 'yaw': 1.5708, 'r': False, 's': 2})
        b.send({'t': 'p', 'x': bx, 'z': bz, 'y': 0, 'yaw': 0, 'r': False, 's': 0})
        time.sleep(0.35)
        a.send({'t': 'peck'})
        after = find(a.pump(0.45), id_b)
        if after and after[5] == 100 and not (after[6] or 0):
            break
    check('超出距离的啄击无效（服务端有距离校验）', after and after[5] == 100 and not (after[6] or 0),
          f'血量 {after[5] if after else None}')

    # ---------- 探针鸡 / 网站鸡（服务端权威：两个人能一起啄同一只）----------
    def nfind(s, nid):
        for e in (s or {}).get('ns', []):
            if e[0] == nid:
                return e
        return None

    roster = [{'id': 'n1', 'name': '测试鸡A', 'kind': 'probe'},
              {'id': 't1', 'name': '测试鸡B', 'kind': 'web'}]
    a.send({'t': 'npcs', 'list': roster})
    snap = a.pump(0.8)
    ns = (snap or {}).get('ns') or []
    check('客户端上报名单后服务端生成探针鸡/网站鸡', {'n1', 't1'} <= {e[0] for e in ns},
          json.dumps(ns, ensure_ascii=False))
    n = nfind(snap, 'n1')
    check('探针鸡满血且带体型字段（第 8 项）', bool(n) and n[5] == 100 and len(n) >= 8, str(n))

    # 甲贴上去连啄：服务端扣血
    # ⚠ 不能一步跳到鸡身边（服务端有防瞬移夹取）——用 place() 分几步挪过去再啄
    hp_seq = []
    for _ in range(4):
        snap = a.pump(0.6)
        n = nfind(snap, 'n1')
        if not n or n[5] <= 0:
            break
        px, pz = n[1] - 1.1, n[2]
        yaw = math.atan2(n[1] - px, n[2] - pz)
        place(a, id_a, px, pz, yaw)
        a.send({'t': 'peck', 'x': px, 'z': pz, 'y': 0, 'yaw': yaw})
        hp_seq.append(n[5])
    snap = a.pump(0.4)
    n = nfind(snap, 'n1')
    nb = nfind(b.pump(0.6), 'n1')
    check('玩家能啄掉服务端探针鸡的血', bool(n) and n[5] < 100,
          f'探针鸡血量 {hp_seq} → {n[5] if n else None}')
    check('两个玩家看到同一只探针鸡的血量（服务端权威）',
          bool(n) and bool(nb) and abs(nb[5] - n[5]) <= 1,
          f'甲看到 {n[5] if n else None} / 乙看到 {nb[5] if nb else None}')

    # 暴躁探针鸡追击 + 啄人：把乙支到角落（免得它成为"最近的玩家"），甲站在 6m 外等它冲过来
    # 选点要离暴躁鸡远一点，否则它会先把甲啄晕（倒地就收不到啄击事件）
    a.msg.clear()
    snap = a.pump(0.5)
    n = nfind(snap, 'n1')
    nx, nz = (n[1], n[2]) if n else (0.0, 0.0)
    bx, bz = -nx, -nz
    # 甲站在离暴躁鸡 6m 的点，且尽量离别处的 NPC 远（免得别的 NPC 抢了这口）
    best, best_d = (nx + 6.0, nz), -1.0
    for k in range(16):
        ang = k / 16 * 6.283
        cx, cz = nx + math.cos(ang) * 6.0, nz + math.sin(ang) * 6.0
        if abs(cx) > 24 or abs(cz) > 24:
            continue
        gd = min([math.hypot(cx - o[1], cz - o[2]) for o in ((snap or {}).get('ns') or []) if o[0] != 'n1'] or [99])
        if gd > best_d:
            best_d, best = gd, (cx, cz)
    px, pz = best
    a.send({'t': 'hot', 'ids': ['n1']})
    d0 = 6.0
    closed = False
    d_last = d0
    for _ in range(40):
        b.send({'t': 'p', 'x': bx, 'z': bz, 'y': 0, 'yaw': 0, 'r': False})
        a.send({'t': 'p', 'x': px, 'z': pz, 'y': 0, 'yaw': 0, 'r': False})
        snap = a.pump(0.3)
        n = nfind(snap, 'n1')
        if n:
            d_last = math.hypot(n[1] - px, n[2] - pz)
            if d_last <= 1.9 or d_last < d0 - 0.8:
                closed = True
    hits = [e for m in a.msg for e in m.get('ev', []) if e.get('e') == 'hit' and e.get('fn') == '测试鸡A']
    check('被标成暴躁的探针鸡会追过来', closed, f'与玩家距离 {d0:.2f}m → {d_last:.2f}m（选点离暴躁鸡 {best_d:.1f}m）')
    check('暴躁探针鸡能啄到玩家（服务端事件）', bool(hits),
          json.dumps(hits[:2], ensure_ascii=False) if hits else '没收到命中事件')

    # 啄倒探针鸡 → 它进倒地状态，且自己榜上的数 +1（分数由服务端裁定）
    n = nfind(a.pump(0.4), 'n1')
    e0 = find(a.pump(0.3), id_a)
    score_before = e0[7] if e0 and len(e0) > 7 else 0
    low, down = 100.0, False
    for _ in range(12):
        snap = a.pump(0.45)
        n = nfind(snap, 'n1')
        if not n:
            break
        low = min(low, n[5])
        if n[5] <= 0:
            down = True
            break
        # 自己倒地时服务端会拒收啄击（前面的暴躁鸡可能把你啄晕了），先站着再打
        for _ in range(20):
            e = find(a.pump(0.3), id_a)
            if e and e[5] > 0:
                break
        px, pz = n[1] - 1.1, n[2]
        yaw = math.atan2(n[1] - px, n[2] - pz)
        a.send({'t': 'peck', 'x': px, 'z': pz, 'y': 0, 'yaw': yaw})
    check('探针鸡会被啄倒（血量归零）', down, f'n1 最低血量 {low:.0f}')
    e1 = find(a.pump(0.4), id_a)
    check('啄倒探针鸡 → 啄倒榜给自己 +1（服务端裁定，客户端说了不算）',
          down and bool(e1) and len(e1) == 8 and e1[7] == score_before + 1,
          f'甲 {score_before} → {e1[7] if e1 and len(e1) > 7 else None}（n1 最低血量 {low:.0f}）')
    # 位置上报不会把它顺手复活（以前有过"s 上报连带重置状态"的坑）
    a.send({'t': 'p', 'x': 1.0, 'z': 1.0, 'y': 0, 'yaw': 0, 'r': False})
    a.send({'t': 'p', 'x': 1.2, 'z': 1.2, 'y': 0, 'yaw': 0, 'r': False})
    nd = nfind(a.pump(0.6), 'n1')
    check('倒地期间的位置上报不会让它立刻站起来（要等 3.5 秒冷却）',
          bool(nd) and nd[5] <= 0, f'n1={nd}')

    # 只有"所有人都不要了"才回收：甲一个人不要不算 —— 否则乙那边还在跟着走的鸡会被删掉再随机重生，两边位置立刻对不上
    pos_before = nfind(a.pump(0.3), 'n1')
    b.send({'t': 'npcs', 'list': roster})          # 乙：两只都要
    a.send({'t': 'npcs', 'list': [roster[1]]})     # 甲：只要 t1
    ns = (a.pump(0.6) or {}).get('ns') or []
    check('两人名单不同时取并集（甲不要但乙还要 → 不回收）', {e[0] for e in ns} == {'n1', 't1'},
          json.dumps([e[0] for e in ns], ensure_ascii=False))
    b.send({'t': 'npcs', 'list': [roster[1]]})
    ns = (a.pump(0.5) or {}).get('ns') or []
    check('两人都不要时才回收该 NPC', {e[0] for e in ns} == {'t1'},
          json.dumps([e[0] for e in ns], ensure_ascii=False))
    # 同 id 的鸡再加回来：必须留在原地（回收时服务端记了位置），否则会凭空瞬移
    a.send({'t': 'npcs', 'list': roster})
    b.send({'t': 'npcs', 'list': roster})
    again = nfind(a.pump(0.6), 'n1')
    d_back = math.hypot(again[1] - pos_before[1], again[2] - pos_before[2]) if (again and pos_before) else None
    # 注意：这中间它自己也在走（2.05 m/s），所以"原地"只能给个宽容差 —— 随机重生会跑到场子另一头
    check('同 id 的鸡回来时没被丢到随机点', d_back is not None and d_back < 5.0,
          f'回来时偏离 {None if d_back is None else round(d_back, 2)}m（其中含它自己走的距离）')

    # 用户要求"探针鸡/网站鸡走来走去，不要原地不动"：30 秒窗口内每只都该真的挪动
    a.send({'t': 'hot', 'ids': []})           # 先清暴躁：追着站着不动的人会看起来"没动"
    a.send({'t': 'npcs', 'list': roster})
    # ⚠ 两点：① 逐段采样累计**路程**而不是只看首尾净位移 —— "走走停停"的鸡可能绕回原处附近，
    #   净位移会接近 0（实测某次 t1 净位移只有 0.36m 但确实在走）；② 被打倒在地的鸡本来就走不动
    #   （暴躁鸡之间会互殴；线上还有真实客户端持续上报暴躁名单），不能算成"杵着不动"。
    prev, path, downed = {}, {}, set()
    end = time.time() + 30
    while time.time() < end:
        ns_now = (a.pump(3.0) or {}).get('ns') or []
        if not ns_now:
            continue
        downed |= {e[0] for e in ns_now if e[6] & 1}
        for e in ns_now:
            nid, nx, nz = e[0], e[1], e[2]
            if nid in prev:
                path[nid] = path.get(nid, 0.0) + math.hypot(nx - prev[nid][0], nz - prev[nid][1])
            prev[nid] = (nx, nz)
    moves = {k: round(v, 2) for k, v in path.items()}
    idle = {k: v for k, v in moves.items() if v < 2.0 and k not in downed}
    check('探针鸡/网站鸡 30 秒内都真的走过（走走停停，不是杵着不动）', bool(moves) and not idle,
          f'30 秒路程 {moves}' + (f' · 没走的 {idle}' if idle else '')
          + (f' · 期间被打倒过（豁免）{sorted(downed)}' if downed else ''))

    # ================= 本次新增功能 =================
    # ---- 1) 访客鸡的国旗：CF-IPCountry 透传 / 客户端自报兜底 ----
    f1 = Conn(headers={'CF-IPCountry': 'JP'})
    f2 = Conn()
    f1.pump(0.4); f2.pump(0.4)
    w1 = next((m for m in f1.msg if m['t'] == 'welcome'), None)
    w2 = next((m for m in f2.msg if m['t'] == 'welcome'), None)
    check('CF-IPCountry 透传 → welcome 里带上访客 IP 所在地的国旗码', bool(w1) and w1.get('cc') == 'JP',
          json.dumps(w1, ensure_ascii=False) if w1 else '没收到 welcome')
    check('没有 CF 头时 welcome 的国旗码为空（前端退化成 🐔）', bool(w2) and not w2.get('cc'),
          json.dumps(w2, ensure_ascii=False) if w2 else '')
    f1.send({'t': 'hi', 'name': '国旗甲', 'cc': 'ru'})     # 带 CF 头：自报不该被采纳
    f2.send({'t': 'hi', 'name': '国旗乙', 'cc': 'de'})     # 没 CF 头：自报兜底
    snap = f1.pump(0.7)
    ros = next((m for m in reversed(f1.msg) if m['t'] == 'roster' and len(m['list']) >= 2), None)
    cc_map = {c.get('name'): c.get('cc') for c in (ros or {'list': []})['list']}
    check('名单里每个访客都带自己的国旗码（CF 真值优先于自报）',
          cc_map.get('国旗甲') == 'JP' and cc_map.get('国旗乙') == 'DE', str(cc_map))
    f2.pump(0.7)                                    # 把服务端补发的那条 cc 也读出来
    ccmsg = next((m for m in f2.msg if m['t'] == 'cc'), None)
    check('没拿到 CF 头时服务端补发 {t:cc} 给该客户端', bool(ccmsg) and ccmsg.get('cc') == 'DE',
          json.dumps(ccmsg or {}, ensure_ascii=False))
    check('带 CF 真值时不采纳自报（不会被 ?cc= 覆盖掉真实 IP 所在地）',
          not any(m['t'] == 'cc' for m in f1.msg), f'额外 cc 消息 {[m for m in f1.msg if m["t"] == "cc"]}')

    # ---- 2) 访客出生点随机 ----
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import farm_server as FS       # 用同一份障碍物表校验"没生进鸡舍/围栏里"

    def in_obstacle(x, z, r=0.44):
        for o in FS.OBSTACLES:
            minx, maxx = o['x'] - o['w'] / 2, o['x'] + o['w'] / 2
            minz, maxz = o['z'] - o['d'] / 2, o['z'] + o['d'] / 2
            cx, cz = max(minx, min(x, maxx)), max(minz, min(z, maxz))
            if math.hypot(x - cx, z - cz) < r:
                return True
        return False

    old_spawns = {(3, 12), (-6, -4), (10, 6), (-12, 8), (14, -8), (-9, -14)}
    born = []
    extra_conns = []
    for i, cc in enumerate(['JP', 'DE', 'US', 'SG', 'GB']):
        c = Conn(headers={'CF-IPCountry': cc})
        extra_conns.append(c)
        s0 = c.pump(0.4)
        w = next((m for m in c.msg if m['t'] == 'welcome'), None)
        e = find(s0, w['id']) if w else None
        if e:
            born.append((round(e[1], 2), round(e[2], 2)))
    dists = [round(math.hypot(x, z), 2) for x, z in born]
    uniq = len({(round(x, 1), round(z, 1)) for x, z in born})
    check('访客出生点是随机的（5 个连接的出生点基本各不相同）', len(born) == 5 and uniq >= 4,
          f'出生点 {born}')
    check('访客出生点不在旧的固定 6 点上', not any((x, z) in old_spawns for x, z in born), f'{born}')
    check('出生点在场地里、离中心 4~20m（没生进鸡舍/围栏）',
          all(4.0 <= d <= 20.0 for d in dists) and not any(in_obstacle(x, z) for x, z in born),
          f'离中心距离 {dists}')
    for c in extra_conns:
        c.close()

    # ---- 3) 被攻击后的「回击 / 逃窜」 ----
    a.send({'t': 'hot', 'ids': []})           # 先清掉暴躁名单：这一组要测普通鸡
    a.send({'t': 'npcs', 'list': roster})
    a.pump(0.5)

    def peck_and_watch(target_id, watch=3.0):
        """贴到目标 1.1m 处啄一口，收 3 秒内的「反应」证据。返回 None 表示这次没打成。"""
        for _ in range(40):
            snap = a.pump(0.35)
            n = nfind(snap, target_id)
            me = find(snap, id_a)
            if not n or not me:
                return None
            if n[5] <= 0 or me[5] <= 0 or (me[6] or 0):
                time.sleep(0.5)              # 鸡倒地 / 我被啄晕：等站起来再来
                continue
            px, pz = n[1] - 1.1, n[2]
            yaw = math.atan2(n[1] - px, n[2] - pz)
            a.msg.clear()
            a.send({'t': 'p', 'x': px, 'z': pz, 'y': 0, 'yaw': yaw, 'r': False})
            time.sleep(0.05)
            a.send({'t': 'peck', 'x': px, 'z': pz, 'y': 0, 'yaw': yaw})
            res = {'kind': None, 'st': set(), 'd0': None, 'd_end': None, 'hitback': False, 'hp0': None}
            end = time.time() + watch
            while time.time() < end:
                snap = a.pump(0.3)
                for m in a.msg:
                    for e in m.get('ev', []):
                        if e.get('e') == 'react' and e.get('t') == target_id:
                            res['kind'] = e.get('k')
                nn = nfind(snap, target_id)
                if nn:
                    res['st'].add(nn[6])
                    if res['hp0'] is None:
                        res['hp0'] = nn[5]
                    d = math.hypot(nn[1] - px, nn[2] - pz)
                    if res['d0'] is None:
                        res['d0'] = d
                    res['d_end'] = d
                mm = find(snap, id_a)
                if mm and mm[5] < 100:
                    res['hitback'] = True
            if res['kind']:
                return res
        return None

    ST_FLEE, ST_FIGHT = 32, 64
    seen = {}
    got = []
    for i in range(26):
        r = peck_and_watch('n1' if i % 2 == 0 else 't1')
        if not r:
            continue
        got.append(r['kind'])
        seen.setdefault(r['kind'], r)
        if 'fight' in seen and 'flee' in seen:
            break
    fle, fig = seen.get('flee'), seen.get('fight')
    check('被攻击的鸡会「回击」或「逃窜」（两种都出现过）', fle is not None and fig is not None, f'反应序列 {got}')
    check('选「逃窜」的鸡真的掉头跑开（3 秒内拉开 ≥2.0m）',
          bool(fle) and fle['d0'] is not None and (fle['d_end'] - fle['d0']) > 2.0,
          f'{fle["d0"]:.2f}m → {fle["d_end"]:.2f}m' if fle and fle['d0'] is not None else '没测到')
    check('逃窜时快照状态位带 ST_FLEE（客户端据此换惊慌动作+名牌小标）',
          bool(fle) and any(x & ST_FLEE for x in fle['st']), f'状态位 {[hex(x) for x in (fle["st"] if fle else [])]}')
    check('选「回击」的鸡会冲上来啄我（我掉血）', bool(fig) and fig['hitback'],
          f'血量证据 hitback={fig["hitback"] if fig else None}')
    check('回击时快照状态位带 ST_FIGHT（客户端据此挂「⚔️回击」小标）',
          bool(fig) and any(x & ST_FIGHT for x in fig['st']), f'状态位 {[hex(x) for x in (fig["st"] if fig else [])]}')

    # ---- 4) 暴躁鸡哪怕被打也不逃窜 ----
    a.send({'t': 'hot', 'ids': ['n1', 't1']})
    a.send({'t': 'npcs', 'list': roster})
    a.pump(0.5)
    hot_kinds, hot_st = [], set()
    for i in range(8):
        r = peck_and_watch('n1' if i % 2 == 0 else 't1', watch=2.4)
        if not r:
            continue
        hot_kinds.append(r['kind'])
        hot_st |= r['st']
    check('暴躁鸡被打也不会逃窜（永远回击）', hot_kinds and set(hot_kinds) == {'fight'}, f'反应序列 {hot_kinds}')
    check('暴躁鸡被打时快照里从不出现 ST_FLEE', not any(x & ST_FLEE for x in hot_st),
          f'状态位 {[hex(x) for x in hot_st]}')
    a.send({'t': 'hot', 'ids': []})
    a.pump(0.4)

    # ---- 5) 回血：一段时间没挨打就缓慢回血（鸡） ----
    def damage_probe(target_id):
        """啄它一口，返回（啄之前的血, 之后每 1 秒采样一次的血）"""
        # ⚠ 2026-09-24：暴躁鸡现在会互相啄、被啄的还会回击。采样回血前必须先"静场"：
        # 清掉暴躁名单 + 等上一段里已经打起来的"鸡斗鸡"收尾，否则 9 秒采样窗口
        # 里会混进别的鸡的啄击，血量忽上忽下（那就不是"没挨打"了）。
        a.send({'t': 'hot', 'ids': []})
        time.sleep(6.0)
        for _ in range(30):
            snap = a.pump(0.35)
            n = nfind(snap, target_id)
            me = find(snap, id_a)
            if not n or not me or n[5] <= 20 or me[5] <= 0 or (me[6] or 0):
                time.sleep(0.5)
                continue
            px, pz = n[1] - 1.1, n[2]
            yaw = math.atan2(n[1] - px, n[2] - pz)
            a.msg.clear()
            a.send({'t': 'p', 'x': px, 'z': pz, 'y': 0, 'yaw': yaw, 'r': False})
            time.sleep(0.05)
            a.send({'t': 'peck', 'x': px, 'z': pz, 'y': 0, 'yaw': yaw})
            hp = None
            for _ in range(4):
                nn = nfind(a.pump(0.3), target_id)
                if nn and nn[5] < n[5]:
                    hp = nn[5]
                    break
            if hp is None:
                continue
            # 之后只有甲一个人在场、且不再啄它 → 采样 9 秒
            series = []
            for _ in range(9):
                nn = nfind(a.pump(1.0), target_id)
                series.append(nn[5] if nn else None)
            return hp, series
        return None, []

    hp0, series = damage_probe('n1')
    if hp0 is None:
        check('探针鸡 6 秒不挨打就开始回血', False, '没能打中它（环境太嘈杂）')
    else:
        no_regen_yet = series[2]                       # ~3 秒时（还没到 6 秒的等待）
        later = [v for v in series[6:] if v is not None]
        check('受击后 6 秒内不回血（等待期）', no_regen_yet is not None and no_regen_yet <= hp0,
              f'{hp0} → 3 秒时 {no_regen_yet}')
        check('6 秒后开始缓慢回血（不挨打就慢慢涨回来）', bool(later) and max(later) >= hp0 + 8,
              f'{hp0} → 9 秒采样 {series}')

    # ---- 6) 回血：玩家（访客鸡）同样如此 ----
    # 用一对新连接来测：前面的小节把 a/b 摆来摆去、还常被啄晕，这里换干净的连接，
    # 并且每次读快照前都把位置报一遍（40 秒没动静会被服务端当成掉线踢掉，踩过）
    p1, p2 = Conn(), Conn()
    p1.pump(0.4); p2.pump(0.4)
    p1.send({'t': 'hi', 'name': '回血甲'}); p2.send({'t': 'hi', 'name': '回血乙'})
    p1.pump(0.5)
    id_p1 = next(m['id'] for m in p1.msg if m['t'] == 'welcome')
    id_p2 = next(m['id'] for m in p2.msg if m['t'] == 'welcome')
    p1.send({'t': 'npcs', 'list': [{'id': 'n1', 'name': '鸡A', 'kind': 'probe'},
                                   {'id': 't1', 'name': '鸡B', 'kind': 'web'}]})
    p1.pump(0.6)
    pos1, pos2 = [0.0, 0.0], [0.0, 0.0]

    def alive2(conn, cid, pos, secs=14):
        """等这个玩家站起来；顺手把位置报一遍，免得被当成掉线踢掉"""
        end = time.time() + secs
        while time.time() < end:
            conn.send({'t': 'p', 'x': pos[0], 'z': pos[1], 'y': 0, 'yaw': 0, 'r': False})
            e = find(conn.pump(0.4), cid)
            if e and e[5] > 50 and not (e[6] or 0):
                return True
        return False

    def player_regen_try():
        # 先确保双方都站着（前面可能在打架）
        alive2(p1, id_p1, pos1); alive2(p2, id_p2, pos2)
        # 再挑一个"离所有鸡最远"的角落，免得测回血时被路过的鸡补刀
        snap = p1.pump(0.4)
        ns_now = (snap or {}).get('ns') or []
        corners = [(-22.0, -22.0), (22.0, -22.0), (-22.0, 22.0), (22.0, 22.0)]
        bx, bz = max(corners, key=lambda p: min([math.hypot(e[1] - p[0], e[2] - p[1]) for e in ns_now] or [99.0]))
        pos2[:] = [bx, bz]
        pos1[:] = [bx + 1.2, bz]
        p2.send({'t': 'p', 'x': bx, 'z': bz, 'y': 0, 'yaw': 0, 'r': False})
        p1.send({'t': 'p', 'x': bx + 1.2, 'z': bz, 'y': 0, 'yaw': 4.712, 'r': False})
        time.sleep(0.3)
        p1.msg.clear()
        p1.send({'t': 'peck', 'x': bx + 1.2, 'z': bz, 'y': 0, 'yaw': 4.712})
        hp = None
        for _ in range(4):
            e = find(p1.pump(0.3), id_p2)
            if e and e[5] < 100:
                hp = e[5]
                break
        if hp is None:
            return None
        series = []
        for _ in range(11):
            p2.send({'t': 'p', 'x': bx, 'z': bz, 'y': 0, 'yaw': 0, 'r': False})
            pos1[:] = [bx + 2.6, bz]
            p1.send({'t': 'p', 'x': bx + 2.6, 'z': bz, 'y': 0, 'yaw': 4.712, 'r': False})
            e = find(p1.pump(1.0), id_p2)
            series.append(e[5] if e else None)
        hurt = [e for m in p1.msg for e in m.get('ev', []) if e.get('e') == 'hit' and e.get('t') == id_p2]
        return hp, series, len(hurt), (bx, bz)

    got_regen = None
    why = []
    for attempt in range(3):
        r = player_regen_try()
        if not r:
            why.append('没打中乙（位置/距离不对）')
            continue
        hp, series, hurt, corner = r
        ok = hurt == 1 and series[0] is not None and series[0] <= hp
        why.append(f'第{attempt + 1}次：角落{corner} 起始{hp} 采样{series} 被打{hurt}次')
        if ok:
            got_regen = (hp, series)
            break
        time.sleep(1.0)
    check('玩家（访客鸡）也会缓慢回血（前几秒不动，之后慢慢涨）',
          bool(got_regen) and max(v for v in got_regen[1] if v is not None) >= got_regen[0] + 8
          and got_regen[1][1] is not None and got_regen[1][1] <= got_regen[0] + 1,
          (' / '.join(why)) if not got_regen else f'{got_regen[0]} → {got_regen[1]}')
    p1.close(); p2.close()

    a.close(); b.close()
    for c in (f1, f2):
        c.close()
    abuse_tests()
    whitebox_tests()
    feature_tests()
    return report()


# ---------------------------------------------------------------------------
# 输入净化 / 滥用防护的回归用例（2026-09-24 加固；都是"不会有人手动测"的路径）
# ---------------------------------------------------------------------------

def read_frame(sock, timeout=2.0):
    """读一个 WS 帧 → (opcode, payload)；超时或连接关闭 → (None, b'')。"""
    sock.settimeout(timeout)
    try:
        b1 = sock.read(1)[0]
        b2 = sock.read(1)[0]
        ln = b2 & 0x7f
        if ln == 126:
            ln = struct.unpack('>H', sock.read(2))[0]
        elif ln == 127:
            ln = struct.unpack('>Q', sock.read(8))[0]
        return b1 & 0x0f, (sock.read(ln) if ln else b'')
    except Exception:
        return None, b''


def read_until(sock, opcode, timeout=3.0):
    """跳到指定 opcode 的帧（中间的数据帧丢掉）。"""
    end = time.time() + timeout
    while time.time() < end:
        op, payload = read_frame(sock, max(0.1, end - time.time()))
        if op is None:
            return None, b''
        if op == opcode:
            return op, payload
    return None, b''


def send_raw(sock, payload: bytes):
    """发一个掩码文本帧（支持 >64KiB）—— send() 的 16 位长度分支装不下超大帧。"""
    mask = os.urandom(4)
    n = len(payload)
    head = bytearray([0x81])
    if n < 126:
        head.append(0x80 | n)
    elif n < 65536:
        head.append(0x80 | 126); head += struct.pack('>H', n)
    else:
        head.append(0x80 | 127); head += struct.pack('>Q', n)
    head += mask
    sock.sendall(bytes(head) + bytes(c ^ mask[i & 3] for i, c in enumerate(payload)))


def try_connect(path='/ws', headers=None):
    """握手并返回 (状态行, socket)：用来断言"被拒"（ws_connect 会 assert 101，测不了失败）。"""
    s = socket.create_connection((HOST, PORT), 5)
    key = base64.b64encode(os.urandom(16)).decode()
    extra = ''.join(f'{k}: {v}\r\n' for k, v in (headers or {}).items())
    s.sendall(f'GET {path} HTTP/1.1\r\nHost: {HOST}:{PORT}\r\nUpgrade: websocket\r\n'
              f'Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\n'
              f'Sec-WebSocket-Version: 13\r\n{extra}\r\n'.encode())
    s.settimeout(5)
    buf = b''
    try:
        while b'\r\n\r\n' not in buf:
            chunk = s.recv(4096)
            if not chunk:
                break
            buf += chunk
    except Exception:
        pass
    head, _, rest = buf.partition(b'\r\n\r\n')
    return head.split(b'\r\n')[0].decode('latin1', 'replace'), WS(s, rest)


def nfind(snap, nid):
    """ns（探针鸡/网站鸡）里的条目：[id,x,z,y,yaw,hp,st,scale]"""
    for e in (snap or {}).get('ns', []):
        if e[0] == nid:
            return e
    return None


def cluster_npcs(c, my, ids, center, want=3.2, timeout=45):
    """把指定的鸡引到玩家跟前（它们会追过来），返回是否都到位。

    ⚠ 黑盒 AI 用例必须先"聚一次"：同一 id 的鸡被回收后位置是**留着**的（服务端 npc_cache），
    所以在一个跑过一轮的实例上，两只测试鸡可能隔着二十几米 —— 而暴躁鸡挑欺负对象要求
    对方在 BULLY_SEEK=14m 内，于是"欺负别的鸡""两只挤到一起"都永远不会发生
    （实测：同一个实例连跑，第一遍 57/57、第二遍这几条就假红）。
    """
    for _ in range(4):                                       # 让玩家站稳在中心（会被夹取，多送几次）
        c.send({'t': 'p', 'x': center[0], 'z': center[1], 'y': 0, 'yaw': 0})
        c.pump(0.2)
    end = time.time() + timeout
    while time.time() < end:
        c.send({'t': 'p', 'x': center[0], 'z': center[1], 'y': 0, 'yaw': 0})
        snap = c.pump(0.5)
        got = [nfind(snap, i) for i in ids]
        if all(g for g in got) and all(math.hypot(g[1] - center[0], g[2] - center[1]) <= want for g in got):
            return True
    return False


class FakeClient:
    """白盒用的假玩家：只提供 Probe.step() 与 _probe_attack() 会用到的那几个字段。

    这样就能在没有真连接的情况下测"鸡打人"有关的战斗动作（扇翅/打了就跑），
    条件完全可控（真客户端会走位、会掉线，测起来全是抖动）。
    """

    def __init__(self, cid, x, z):
        self.id = cid
        self.x, self.z = float(x), float(z)
        self.name = f'假玩家{cid}'
        self.hp = 100.0
        self.dead = False
        self.hits = []

    def take_hit(self, dmg):
        self.hp -= dmg
        self.hits.append(round(dmg, 2))
        return self.hp <= 0


def install_sim_clock(fs):
    """把 farm_server 的 now() 换成可控时钟（白盒专用），返回带 tick()/restore() 的对象。

    ⚠⚠ 不换会得到**假结论**：鸡的所有冷却（啄击 2.2s / 扇翅 3.2s / 欺负 8s / 回血 6s…）都是按
    `now()`（墙钟）算的，而白盒循环一眨眼就跑完几百拍（不 sleep）→ 冷却永远不到期。
    实测症状："25 秒里只出了 1 手""扇翅 0 次"（装上时钟后是 6~7 手、扇 2~3 次）。
    """
    class Clock:
        def __init__(self):
            self.orig = fs.now
            self.t = fs.now()
            fs.now = lambda: self.t

        def tick(self, dt):
            self.t += dt

        def restore(self):
            fs.now = self.orig

    return Clock()


def sim_step(clk, p, dt, players, g):
    """跑一拍：先推进白盒时钟再 step()（顺序不能反，冷却判定用的是 now()）。"""
    clk.tick(dt)
    p.step(dt, players, g._probe_attack, g.probes, g._npc_attack)


def whitebox_tests():
    """白盒：直接跑服务端的 AI 代码 —— 软分离 + 暴躁鸡欺负别的鸡。

    为什么要白盒：黑盒那两条（两只暴躁鸡扑同一个玩家、玩家站远角时 n1 去啄 n2）依赖
    两只鸡当时离得够近（BULLY_SEEK=14m 内才会挑目标）和随机时机，在"跑过一轮的服务端实例上"
    会偶发空转（实测：同一实例连跑，第一遍 57/57、第二遍这几条就假红）。白盒跑的是同一份代码，
    条件可控，能证明逻辑本身成立。
    """
    import importlib.util
    here = os.path.dirname(os.path.abspath(__file__))
    spec = importlib.util.spec_from_file_location('farm_server_sep', os.path.join(here, 'farm_server.py'))
    fs = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(fs)
    g = fs.Game(tick_hz=20, debug=False)
    a = fs.Probe('a', '甲', 'probe', 0.0, 0.0)
    b = fs.Probe('b', '乙', 'probe', 0.02, 0.0)          # 几乎完全重叠（用户看到的就是这个）
    g.probes = {'a': a, 'b': b}
    d0 = math.hypot(a.x - b.x, a.z - b.z)
    for _ in range(40):                                  # 40 拍 @20Hz = 2 秒
        g.separate_probes()
    d1 = math.hypot(a.x - b.x, a.z - b.z)
    check('软分离（白盒）：完全重叠的两只鸡会被推开到目标间距附近，不会一直叠着',
          d0 < 0.1 and abs(d1 - SEP_MIN_EXPECT) < 0.3,
          f'重叠 {d0:.2f}m → {d1:.2f}m（目标 {SEP_MIN_EXPECT:.2f}m，40 拍）')
    # 反过来：本来就有 3m 的两只不该被"拉近"（分离只推开、不吸附）
    c = fs.Probe('c', '丙', 'probe', 6.0, 0.0)
    d = fs.Probe('d', '丁', 'probe', 9.0, 0.0)
    g.probes = {'c': c, 'd': d}
    for _ in range(40):
        g.separate_probes()
    d2 = math.hypot(c.x - d.x, c.z - d.z)
    check('软分离只推开、不吸附（本来隔 3m 的两只保持 3m）', abs(d2 - 3.0) < 0.05,
          f'3.00m → {d2:.2f}m')

    # ④ 暴躁鸡欺负别的鸡：白盒跑真实 step()（黑盒那条要等随机时机 + 两只鸡离得够近，偶尔会空转）
    clk = install_sim_clock(fs)
    g2 = fs.Game(tick_hz=20, debug=False)
    n1 = fs.Probe('n1', '大鸡', 'probe', 0.0, 0.0); n1.hot = True
    n2 = fs.Probe('n2', '小鸡', 'probe', 3.0, 0.0)
    g2.probes = {'n1': n1, 'n2': n2}
    hits = []
    for _ in range(20 * 20):                      # 20 秒 @20Hz
        for p in (n1, n2):
            sim_step(clk, p, 1 / 20, [], g2)          # 场上没有玩家
        g2.separate_probes()
        for e in g2.pending_ev:
            if e.get('e') == 'hit':
                hits.append((e.get('fn'), e.get('t')))
        g2.pending_ev.clear()
    check('暴躁鸡会欺负别的鸡（白盒）：场上没有玩家时暴躁的 n1 会去啄 n2，且 n2 会记仇',
          bool(hits) and hits[0][0] == '大鸡' and hits[0][1] == 'n2'
          and n2.react_by == 'n1' and n2.hp < 100,
          f'命中 {hits[:2]} · n2 血量 {n2.hp:.0f} · 记仇对象 {n2.react_by}')

    # ⑤ 战斗动作不止"啄"：扇翅（伤害 8 + 击退 1.5m）
    #    白盒跑真的 step()：乙是暴躁鸡会主动扑甲，25 秒里必然扇出好几翅膀。
    g5 = fs.Game(tick_hz=20, debug=False)
    a5 = fs.Probe('a', '甲', 'probe', 0.0, 0.0)
    b5 = fs.Probe('b', '乙', 'probe', 1.1, 0.0)
    b5.hot = True
    g5.probes = {'a': a5, 'b': b5}
    wings, wdmg, knock = 0, [], []
    for _ in range(20 * 25):
        hb, db = a5.hp, math.hypot(a5.x - b5.x, a5.z - b5.z)
        for p in (a5, b5):
            sim_step(clk, p, 1 / 20, [], g5)
        g5.separate_probes()
        for e in g5.pending_ev:
            if e.get('k') == 'wing':
                wings += 1
                wdmg.append(round(hb - a5.hp, 2))
                knock.append(round(math.hypot(a5.x - b5.x, a5.z - b5.z) - db, 2))
        g5.pending_ev.clear()
    check('战斗里不只会啄：暴躁鸡会扇翅（伤害 = 玩家扇翅同款 8 点）',
          wings >= 1 and all(abs(d - fs.PROBE_WING_DMG) < 0.7 for d in wdmg),
          f'25 秒里扇了 {wings} 次 · 每次造成 {wdmg}')
    check('被扇的鸡会被推开（同帧拉开 ≥1.0m，目标击退 1.5m）',
          wings >= 1 and all(k >= 1.0 for k in knock),
          f'每扇一次的间距变化 {knock}')

    # ⑥ 蹦跳：追人途中会起跳（离地 > 0.25m 且置 ST_JUMP 位）
    g6 = fs.Game(tick_hz=20, debug=False)
    a6 = fs.Probe('a', '甲', 'probe', 0.0, 0.0)
    b6 = fs.Probe('b', '乙', 'probe', 12.0, 0.0)     # 离得远：乙会一路跑过来（追人途中才蹦）
    b6.hot = True
    g6.probes = {'a': a6, 'b': b6}
    peak, bits = 0.0, 0
    for _ in range(20 * 25):
        for p in (a6, b6):
            sim_step(clk, p, 1 / 20, [], g6)
        g6.separate_probes()
        g6.pending_ev.clear()
        peak = max(peak, b6.h)
        if b6.st & fs.ST_JUMP:
            bits += 1
    check('战斗里会蹦跳：追人途中会起跳（离地 >0.25m，并置 ST_JUMP 位给客户端演）',
          peak > 0.25 and bits >= 1
          and abs(fs.PROBE_JUMP_VY ** 2 / (2 * fs.PROBE_GRAVITY) - peak) < 0.35,
          f'跳起来最高 {peak:.2f}m（理论 {fs.PROBE_JUMP_VY ** 2 / (2 * fs.PROBE_GRAVITY):.2f}m）· 滞空帧 {bits}')

    # ⑦ 打了就跑：普通鸡啄/扇中之后退开几米，再掉头扑回来（暴躁鸡不参与）
    g7 = fs.Game(tick_hz=20, debug=False)
    c7 = fs.Probe('c', '丙', 'probe', 0.0, 0.0)
    g7.probes = {'c': c7}
    pc = FakeClient(77, 1.0, 0.0)                    # 站在 1.0m 处不动（够得着啄）
    c7.react_by, c7.react_mode, c7.react_until = 77, 'fight', fs.now() + 30.0
    gaps, fled, back = [], False, False
    for _ in range(20 * 30):
        sim_step(clk, c7, 1 / 20, [(pc, pc.x, pc.z)], g7)
        g7.pending_ev.clear()
        d = math.hypot(c7.x - pc.x, c7.z - pc.z)
        gaps.append(d)
        if c7.st & fs.ST_FLEE:
            fled = True
        elif fled and d <= 1.75:
            back = True
    check('战斗里会"打了就跑"：普通鸡出手后先退开 ≥1.5m，再掉头扑回攻击距离内',
          fled and max(gaps) >= 1.5 and back and not c7.hot and pc.hits,
          f'最远退到 {max(gaps):.2f}m · 出现过逃窜状态位 {fled} · 又回到 1.75m 内 {back}'
          f' · 它打了假玩家 {len(pc.hits)} 下（每次 {pc.hits[:3]} 伤害）')
    clk.restore()          # 时钟只借用一会儿，还回去别影响后面的用例

    # ⑧ 啄倒榜的记功点：只有"补上最后一击"的那个实体 +1，玩家与鸡共用同一套（_credit）
    g8 = fs.Game(tick_hz=20, debug=False)
    hunter = FakeClient(88, 0.0, 0.0)
    prey = fs.Probe('n1', '靶子', 'probe', 0.6, 0.0)
    g8._apply_hit(hunter, prey, 12, [])
    check('打鸡但没放倒 → 不计分', getattr(hunter, 'score', 0) == 0,
          f'靶子血量 {prey.hp:.0f} · 猎手 score={getattr(hunter, "score", None)}')
    g8._apply_hit(hunter, prey, 500, [])
    check('放倒了 → 动手的人 +1（_apply_hit 是玩家记功的唯一入口）',
          getattr(hunter, 'score', 0) == 1 and prey.score == 0,
          f'猎手 score={getattr(hunter, "score", None)} · 靶子 score={prey.score}')
    g8._apply_hit(hunter, prey, 500, [])
    check('已经倒地的鸡再挨打不会重复记功', getattr(hunter, 'score', 0) == 1,
          f'猎手 score={getattr(hunter, "score", None)}')

    bully = fs.Probe('n2', '凶鸡', 'probe', 1.0, 0.0)
    victim2 = fs.Probe('n3', '倒霉鸡', 'probe', 0.0, 0.0)
    victim2.hp = 5.0
    g8._npc_attack(victim2, bully, wing=False)
    check('鸡欺负鸡把对方放倒 → 动手那只 +1', bully.score == 1 and victim2.dead,
          f'凶鸡 score={bully.score} · 倒霉鸡血量 {victim2.hp:.0f}')
    eater = fs.Probe('n4', '暴躁鸡', 'probe', 1.0, 0.0)
    victim_player = FakeClient(99, 0.0, 0.0)
    # ⚠ 假玩家没有"倒地"状态（dead 是固定 False），被放倒后还能继续挨打 ——
    #   所以这里一放倒就停手，否则会连记好几次功（真 Client 有 ko_until 挡着，不会）
    for _ in range(20):
        g8._probe_attack(victim_player, eater, wing=False)
        if victim_player.hp <= 0:
            break
    check('暴躁鸡把玩家啄倒 → 这只鸡 +1（榜上鸡也会记功）',
          eater.score == 1 and victim_player.hp <= 0,
          f'暴躁鸡 score={eater.score} · 假玩家血量 {victim_player.hp:.0f}')


def feature_tests():
    """2026-09-24 的新玩法与修复：战绩计分（啄倒榜）/ 体型随负载缩放 / NPC 软分离 / 暴躁鸡欺负别的鸡。"""
    c = Conn()
    c.pump(0.4)
    c.send({'t': 'hi', 'name': '特性甲'})
    my = next((m['id'] for m in c.msg if m['t'] == 'welcome'), None)

    # ---- ① 战绩走快照（ps 第 8 项 / ns 第 9 项），roster 里不带 score（原站也是这么分的）----
    ros = next((m for m in reversed(c.msg) if m['t'] == 'roster'), None)
    check('roster 不带 score（啄倒数随快照下发，名单消息不必每帧重发）',
          bool(ros) and all('score' not in e for e in ros['list']),
          json.dumps(ros['list'][:1], ensure_ascii=False) if ros else '')
    check('roster 带离场玩家战绩存档 left（啄倒榜上灰显用）',
          bool(ros) and isinstance(ros.get('left'), list),
          json.dumps((ros or {}).get('left'), ensure_ascii=False))

    # ---- ② 体型随负载缩放：cpu=100 → 1.35；cpu=0 → 1.0（ns 第 8 项）----
    c.send({'t': 'npcs', 'list': [{'id': 'n1', 'name': '大鸡', 'kind': 'probe', 'cpu': 100},
                                  {'id': 'n2', 'name': '小鸡', 'kind': 'probe', 'cpu': 0}]})
    snap = c.pump(1.0)
    big, small = nfind(snap, 'n1'), nfind(snap, 'n2')
    check('体型随负载缩放（cpu=100 → 1.35、cpu=0 → 1.0）',
          bool(big) and bool(small) and abs(big[7] - 1.35) < 0.01 and abs(small[7] - 1.0) < 0.01,
          f'n1.scale={big[7] if big else None} n2.scale={small[7] if small else None}')
    check('探针鸡快照第 9 项是啄倒数（初始 0）',
          bool(big) and len(big) == 9 and big[8] == 0,
          f'n1={big} = [id,x,z,y,yaw,hp,st,scale,score]')

    # ---- ③ NPC 软分离：两只暴躁鸡追同一个玩家时不能叠在一起（用户实测过"卡在一起"）----
    # 站位很讲究（错站位都实测过假红）：
    #   ① 先让两只都变暴躁、把玩家放在它们中间 → 两只自己走过来挤到一起（cluster_npcs）；
    #   ② 玩家再跳到两只**同一条线**的外侧 6m 处 → 两只从同一侧一起扑过来，才会真的挤到一起。
    #   · 站两只中间就不动：两只从相反方向各停在 ~1.7m 攻击距离上，互相永远 ≥3m（实测 24 秒 0 次逼近）
    #   · 不先聚拢：跑过一轮的实例上两只可能隔二十几米，远的那个压根不追（实测收尾 19.71m）
    c.send({'t': 'hot', 'ids': ['n1', 'n2']})
    best = {'near': 0, 'mind': 9e9, 'lastd': None, 'lhp': ('?', '?'), 'rounds': 0}
    for rnd in range(2):                      # 两轮：第一轮没凑够样本就再聚一次重来（鸡会互相打到 / 走散）
        snap = c.pump(0.5)
        p1, p2 = nfind(snap, 'n1'), nfind(snap, 'n2')
        if not (p1 and p2):
            break
        mid = (max(-20.0, min(20.0, (p1[1] + p2[1]) / 2)), max(-20.0, min(20.0, (p1[2] + p2[2]) / 2)))
        if not cluster_npcs(c, my, ['n1', 'n2'], mid):
            continue
        best['rounds'] = rnd + 1
        snap = c.pump(0.5)
        q1, q2 = nfind(snap, 'n1'), nfind(snap, 'n2')
        if not (q1 and q2):
            break
        dx, dz = q2[1] - q1[1], q2[2] - q1[2]
        seg = math.hypot(dx, dz) or 1.0
        mx = max(-24.0, min(24.0, q2[1] + dx / seg * 6.0))        # 两只连线的同向延长线上 6m
        mz = max(-24.0, min(24.0, q2[2] + dz / seg * 6.0))
        place(c, my, mx, mz, tries=14)
        near, mind, lastd, lhp = 0, 9e9, None, ('?', '?')
        end = time.time() + 20
        while time.time() < end:
            c.send({'t': 'p', 'x': mx, 'z': mz, 'y': 0, 'yaw': 0})    # 站定，别把它们甩开
            snap = c.pump(0.4)
            a1, a2 = nfind(snap, 'n1'), nfind(snap, 'n2')
            if not a1 or not a2:
                continue
            d = math.hypot(a1[1] - a2[1], a1[2] - a2[2])
            lastd, lhp = d, (a1[5], a2[5])
            if d < 2.4:                                            # 两只都挤到玩家跟前了
                mind = min(mind, d)
                near += 1
            if near >= 12:
                break
        if near > best['near']:
            best = {'near': near, 'mind': mind, 'lastd': lastd, 'lhp': lhp, 'rounds': rnd + 1}
        if best['near'] >= 6:
            break
    check('两只暴躁鸡扑同一个玩家时被软分离推开（不叠在一起、也没卡死）',
          best['near'] >= 6 and best['mind'] >= 0.55,
          f'逼近采样 {best["near"]} 次 · 最近距离 {best["mind"]:.2f}m（目标间距 {SEP_MIN_EXPECT:.2f}m）'
          f' · 用了 {best["rounds"]} 轮'
          f' · 收尾间距 {"?" if best["lastd"] is None else round(best["lastd"], 2)}m'
          f' · 收尾血量 {best["lhp"][0]}/{best["lhp"][1]}')

    # ---- ④ 暴躁鸡也会欺负别的鸡：玩家站在远角（>14m）时，n1 去啄 n2 ----
    c.send({'t': 'hot', 'ids': ['n1']})
    c.send({'t': 'npcs', 'list': [{'id': 'n1', 'name': '大鸡', 'kind': 'probe', 'cpu': 100},
                                  {'id': 'n2', 'name': '小鸡', 'kind': 'probe', 'cpu': 0}]})
    snap = c.pump(0.5)
    p1, p2 = nfind(snap, 'n1'), nfind(snap, 'n2')
    far = (24.0, 24.0)
    if p1 and p2:
        cands = [(24, 24), (-24, 24), (24, -24), (-24, -24), (0, 26), (0, -26)]
        far = max(cands, key=lambda q: min(math.hypot(q[0] - p1[1], q[1] - p1[2]),
                                          math.hypot(q[0] - p2[1], q[1] - p2[2])))
        place(c, my, float(far[0]), float(far[1]), tries=20)
    hit_by = None
    low = 100.0
    mark = len(c.msg)                     # 事件要从全量消息里捞（见 evs 的说明）
    end = time.time() + 26
    while time.time() < end:
        c.send({'t': 'p', 'x': float(far[0]), 'z': float(far[1]), 'y': 0, 'yaw': 0})
        snap = c.pump(0.5)
        v = nfind(snap, 'n2')
        if v:
            low = min(low, v[5])
        for e in c.evs(mark, 'hit'):
            if e.get('t') == 'n2':
                hit_by = e.get('fn')
        if hit_by:
            break
    check('暴躁鸡会偶尔欺负别的鸡（玩家不在跟前时去啄探针鸡）',
          bool(hit_by) or low < 99.5,
          f'欺负者 {hit_by or "（没抓到事件）"} · n2 最低血量 {low:.0f}')
    c.close()
    time.sleep(0.4)


def abuse_tests():
    # ---- ① NaN / Infinity 位置必须被丢弃，且不能污染快照 ----
    c = Conn()
    c.pump(0.4)
    c.send({'t': 'hi', 'name': '净化甲'})
    my = next((m['id'] for m in c.msg if m['t'] == 'welcome'), None)
    for _ in range(3):
        c.send({'t': 'p', 'x': 3.0, 'z': 4.0, 'y': 0, 'yaw': 0})
        time.sleep(0.06)
    before = find(c.pump(0.5), my)
    # json.dumps 默认就会把 nan/inf 写成非法 JSON 字面量 —— 正好拿来当攻击载荷
    send_raw(c.s, json.dumps({'t': 'p', 'x': float('nan'), 'z': float('nan')}).encode())
    send_raw(c.s, json.dumps({'t': 'p', 'x': float('inf'), 'z': 0.0}).encode())
    send_raw(c.s, json.dumps({'t': 'peck', 'x': float('nan'), 'z': float('nan'), 'yaw': float('nan')}).encode())
    time.sleep(0.4)
    snap2 = c.pump(0.6)
    after = find(snap2, my)
    check('NaN/Infinity 位置被丢弃（快照仍合法、我自己的位置没被污染）',
          before is not None and after is not None and after[1] == before[1] and after[2] == before[2],
          f'({before[1]},{before[2]}) → ({after[1] if after else None},{after[2] if after else None})，'
          f'未掉线={snap2 is not None}')

    # ---- ② 非对象消息不能掐掉连接（以前 m.get 抛 AttributeError → 整条连接被断）----
    send_raw(c.s, b'[1,2,3]')
    send_raw(c.s, b'"just a string"')
    send_raw(c.s, b'42')
    c.send({'t': 'p', 'x': -6.0, 'z': 7.0, 'y': 0, 'yaw': 0})
    time.sleep(0.3)
    me3 = find(c.pump(0.6), my)
    check('非对象 JSON（数组/字符串/数字）不会掐掉连接，后续位置照常生效',
          me3 is not None and abs(me3[1] + 6.0) <= 3.0 and abs(me3[2] - 7.0) <= 3.0,
          f'位置 {me3[1:3] if me3 else None}')

    # ---- ③ 瞬移：单次上报跨半张地图会被夹取；反复冲也出不了场地 ----
    for _ in range(2):
        c.send({'t': 'p', 'x': -6.0, 'z': 7.0, 'y': 0, 'yaw': 0})
        time.sleep(0.06)
    st = find(c.pump(0.15), my)
    pos0 = st[1:3] if st else (-6.0, 7.0)
    c.send({'t': 'p', 'x': 1000.0, 'z': -1000.0, 'y': 0, 'yaw': 0})   # 紧接着上一帧发（间隔很小）
    me4 = find(c.pump(0.4), my)
    d = math.hypot(me4[1] - pos0[0], me4[2] - pos0[1]) if me4 else None
    check('瞬移到 (1000,-1000) 被夹取（单次位移不超过阈值，而不是一步到 1414m 外）',
          d is not None and d <= 6.0, f'单次跳了 {d:.2f}m' if d is not None else '读不到位置')
    for _ in range(14):
        c.send({'t': 'p', 'x': 1000.0, 'z': -1000.0, 'y': 0, 'yaw': 0})
        time.sleep(0.08)
    me5 = find(c.pump(0.4), my)
    check('反复冲出界也到不了围栏外（位置被夹在场地内）',
          me5 is not None and abs(me5[1]) <= 25.85 and abs(me5[2]) <= 25.85,
          f'终点 ({me5[1]},{me5[2]})' if me5 else '读不到位置')

    # ---- ④ 超长帧：回 1009 再断，而不是硬吃下去 ----
    send_raw(c.s, b'"' + b'x' * (64 * 1024 + 16) + b'"')
    op, payload = read_until(c.s, 0x8, 3.0)
    code = struct.unpack('>H', payload[:2])[0] if len(payload) >= 2 else None
    check('超过 64KiB 的帧被拒（服务端回 close 1009）', op == 0x8 and code == 1009,
          f'opcode={op} code={code}')
    c.close()

    # ---- ⑤ 洪水消息：限流是"丢弃"而不是"断开" ----
    f = Conn()
    f.pump(0.3)
    f.send({'t': 'hi', 'name': '洪水'})
    fid = next((m['id'] for m in f.msg if m['t'] == 'welcome'), None)
    for _ in range(400):
        send(f.s, {'t': 'p', 'x': 1.0, 'z': 1.0, 'y': 0, 'yaw': 0})
    snap6 = f.pump(0.8)
    check('一秒内 400 条消息不会掐掉连接（超限只丢弃）',
          snap6 is not None and find(snap6, fid) is not None,
          f'仍在收快照={snap6 is not None}')
    f.close()

    # ---- ⑥ 路径白名单：线上反代路径必须通，乱写路径必须拒 ----
    line_ok, s_ok = try_connect('/chicken/ws')
    check('线上反代路径 /chicken/ws 能握手（别把线上掐了）', '101' in line_ok, line_ok)
    s_ok.close()
    line_bad, s_bad = try_connect('/whatever')
    check('未知路径被拒（404，白名单之外）', '404' in line_bad, line_bad)
    s_bad.close()

    # ---- ⑦ 同一 IP 并发上限（用 x-real-ip 模拟两个访客）----
    # 注意：101 是在 handshake 里回的，早于服务端把连接登记进 clients —— 每次连完
    # 等一下再连下一个，否则测的是"登记延迟"而不是上限
    keep = []
    for _ in range(MAX_PER_IP):
        line, s = try_connect('/ws', {'x-real-ip': '10.9.9.9'})
        keep.append(s if '101' in line else None)
        time.sleep(0.12)
    check(f'同一 IP 允许 {MAX_PER_IP} 个并发连接', all(s is not None for s in keep),
          str([s is not None for s in keep]))
    line5, s5 = try_connect('/ws', {'x-real-ip': '10.9.9.9'})
    check(f'第 {MAX_PER_IP + 1} 个同 IP 连接被拒（503）', '503' in line5, line5)
    s5.close()
    line6, s6 = try_connect('/ws', {'x-real-ip': '10.9.9.10'})
    check('换一个 IP 照样能连（限流按 IP 算，不误伤别人）', '101' in line6, line6)
    s6.close()
    for s in keep:
        if s:
            s.close()
    time.sleep(0.3)

    # ---- ⑧ 名单条数上限：一条消息塞 100 只，全服总数也不超上限 ----
    n1 = Conn()
    n1.pump(0.3)
    n1.send({'t': 'hi', 'name': '名单甲'})
    n1.send({'t': 'npcs', 'list': [{'id': f'a{i}', 'name': f'鸡{i}', 'kind': 'probe'} for i in range(100)]})
    n2 = Conn()
    n2.pump(0.3)
    n2.send({'t': 'hi', 'name': '名单乙'})
    n2.send({'t': 'npcs', 'list': [{'id': f'b{i}', 'name': f'网{i}', 'kind': 'web'} for i in range(60)]})
    snap7 = n1.pump(0.8)
    n_npc = len((snap7 or {}).get('ns', []))
    check('NPC 数量被上限卡住（塞 160 只只出 64）', 0 < n_npc <= 64, f'场上 NPC = {n_npc}')
    n1.close(); n2.close()


def report():
    print(f'\n=== {len(PASS)}/{len(PASS) + len(FAIL)} 通过 ===')
    if FAIL:
        print('失败：' + '，'.join(FAIL))
    return 1 if FAIL else 0


if __name__ == '__main__':
    sys.exit(main())
