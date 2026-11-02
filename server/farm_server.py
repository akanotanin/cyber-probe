#!/usr/bin/env python3
"""cyber-probe 联机服务端 —— 纯 Python 标准库实现的 WebSocket（RFC6455）游戏服务。

设计取舍（重要）：
  * 移动是**客户端权威**（客户端算好位置，20Hz 上报），服务端只做转发 + 插值用的快照。
  * 战斗是**服务端权威**：谁啄到谁、掉多少血、谁被啄倒，全部由服务端按它自己记录的
    位置/朝向判定，客户端只能发"我要啄"的意图，防止改改前端就无敌。
  * 探针鸡/网站鸡由**服务端演算**（闲逛/暴躁追人/被啄的反应），名单由客户端上报
    （服务端不读 hub：名单与"谁很暴躁"都来自客户端，服务端据此生成 NPC 并保证全服一致）。
  * NPC·大白鹅由**服务端自己放养**（源站 config.json 的 geese，默认 2，可设 0）：它不是探针数据，
    客户端不能增删它；进它的领地会被追/被啄，被啄则掉头就跑，可被玩家打倒（60 血）拿分。
  * 分数系统见下（啄倒榜）。

协议（JSON 文本帧）：
  客户端 → 服务端
    {t:'hi', name?:string, color?:int, cc?:string}  进门（cc=自报国旗码，仅当服务端没拿到 CF-IPCountry 时采纳）
    {t:'p', x,z,y? ,yaw, r?:bool}                   20Hz 位置/朝向/是否疾跑
    {t:'peck', x?,z?,yaw?}                          发起一次啄击（服务端校验距离/朝向/冷却）
    {t:'wing', x?,z?,yaw?}                          扇翅（无方向限制、伤害低、带击退）
    {t:'npcs', list:[{id,name,kind,cpu?}]}          上报探针鸡/网站鸡名单（cpu 用来算体型倍率）
    {t:'hot', ids:[...]}                            上报"哪些鸡很暴躁"（CPU/内存超阈值 或 网络最差）
  服务端 → 客户端
    {t:'welcome', id, tick, ts, cc}                 cc = 你这个访客 IP 所在地的国旗码（可能为空）
    {t:'cc', cc}                                    稍后补发的国旗码（客户端自报时）
    {t:'roster', list:[{id,name,color,hp,cc}]}
    {t:'s', ts, ps:[[id,x,z,y,yaw,hp,ko,score]], ns:[[id,x,z,y,yaw,hp,st,scale,score]], ev:[...]}
                                                     ns = 探针鸡/网站鸡/大白鹅（id: n… / t… / g…）
    {t:'respawn', x, z}
    {t:'err', msg}

状态位 st（与前端 js/chicken.js 一致）：DEAD 1 / PECK 2 / RUN 4 / FLAP 8 / PREEN 16 / FLEE 32 / FIGHT 64
    FLEE = 被攻击后"逃窜"（背对着攻击者跑），FIGHT = 被攻击后"回击"（非暴躁鸡的主动反击）。
    事件 ev 里的 {e:'react', t, k:'fight'|'flee', fn} 就是这次判定，客户端拿它播尘土/羽毛。
"""
import argparse, asyncio, base64, hashlib, json, math, os, random, re, signal, struct, sys, time

GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

# ---- 游戏参数（与前端 js/npc.js、js/main.js 保持一致）----
PECK_RANGE = 1.7          # 啄击距离
PECK_DOT = 0.35           # 前方 ~110° 锥
PECK_DMG = 12
PECK_CD = 0.5             # 客户端也有冷却，这里是服务端强制
WING_RANGE = 1.35         # 扇翅：范围更短、无方向限制、伤害更低、击退更强
WING_DMG = 8
WING_CD = 0.8
WING_KNOCK = 1.5          # 击退位移（米）
KO_TICKS = 3.5            # 被啄晕的秒数
NAME_MAX = 10          # 玩家自己起的名字（限制一下，防刷屏）
NPC_NAME_MAX = 28      # 探针/网站鸡的名字（来自节点名，别截断——截了会跟玩家名牌上的名字对不上）

# ---- 世界（必须与前端 js/world.js 一致：地形高度场、障碍物、场地边界）----
WORLD_HALF = 26
HILL_X, HILL_Z, HILL_H, HILL_S2 = 14.0, 13.0, 2.4, 30.0


def ground_height(x, z):
    dx, dz = x - HILL_X, z - HILL_Z
    return HILL_H * math.exp(-(dx * dx + dz * dz) / HILL_S2)


def _box(t, x, z, w, d, h):
    return {'type': t, 'x': float(x), 'z': float(z), 'w': float(w), 'd': float(d), 'h': float(h)}


def build_obstacles():
    o = []
    t = 0.4
    o.append(_box('fence', 0, -WORLD_HALF, WORLD_HALF * 2 + t, t, 1.1))
    o.append(_box('fence', 0, WORLD_HALF, WORLD_HALF * 2 + t, t, 1.1))
    o.append(_box('fence', -WORLD_HALF, 0, t, WORLD_HALF * 2 + t, 1.1))
    o.append(_box('fence', WORLD_HALF, 0, t, WORLD_HALF * 2 + t, 1.1))
    o.append(_box('coop', -11, -9.65, 5.6, 5.2, 3.6))
    o.append(_box('trough', 9, 11, 2.6, 0.9, 0.55))
    o.append(_box('hay', 6, -12, 1.7, 1.7, 1.5))
    o.append(_box('hay', -15, 10, 1.7, 1.7, 1.5))
    o.append(_box('hay', 13, 3, 1.7, 1.7, 1.5))
    o.append(_box('hay', -17, -12.5, 1.7, 1.7, 1.5))
    o.append(_box('hay', 10.5, 13.5, 1.7, 1.7, 1.5))
    for x, z in [(16, 15), (-18, -15), (19, -7), (-6, 17), (-19, 4)]:
        o.append(_box('tree', x, z, 0.7, 0.7, 2.6))
    o.append(_box('rock', 1, 15, 1.6, 1.4, 0.9))
    o.append(_box('rock', -8, -1, 1.2, 1.1, 0.7))
    o.append(_box('rock', 11, -16, 1.8, 1.5, 1.0))
    # ---- 农场道具（与 js/world.js 的 buildObstacles() 逐条一致）----
    o.append(_box('well', -2, -18, 2.4, 2.4, 1.6))
    o.append(_box('crate', -6.4, -6.2, 1.3, 1.2, 1.3))
    o.append(_box('barrel', -5.4, -7.8, 0.9, 0.9, 0.95))
    for z in (5.6, 8.2, 10.8):
        o.append(_box('garden', 17.5, z, 7, 1.6, 0.32))
    o.append(_box('scarecrow', 12.8, 8.2, 0.6, 0.6, 2.2))
    o.append(_box('barrow', 12.4, 3.3, 1.1, 0.8, 0.9))
    for x, z in [(-21, 12.5), (-18, 15.5), (-22, 18.5), (-24, 15.2), (-19.5, 19.5)]:
        o.append(_box('tree', x, z, 0.7, 0.7, 2.6))
    o.append(_box('pond', 10, -21, 7.0, 7.0, 0.2))
    o.append(_box('beehive', 21.2, -1.2, 2.8, 1.4, 1.0))
    o.append(_box('compost', 12.4, 13.2, 2.2, 1.6, 0.7))
    o.append(_box('shed', -20, -6, 4.0, 3.2, 2.4))
    o.append(_box('tractor', 13.5, -6.5, 3.0, 1.8, 1.9))
    o.append(_box('tower', 17.5, -20, 3.2, 3.2, 6.6))
    o.append(_box('bench', 17.3, 13.7, 1.7, 0.6, 0.9))
    o.append(_box('picnic', 20.6, 16.4, 2.0, 1.8, 0.8))
    o.append(_box('burro', 16.2, -2.6, 1.6, 1.9, 2.0))
    o.append(_box('fenceLow', -20.75, 10.5, 8.5, 0.16, 0.6))
    o.append(_box('fenceLow', -20.75, 21, 8.5, 0.16, 0.6))
    o.append(_box('woodpile', -15.8, -8.6, 1.4, 1.2, 1.0))
    return o


OBSTACLES = build_obstacles()


def resolve_circle(x, z, r):
    """圆对轴对齐盒子的推出（与前端 resolveCollision 同一套算法），并夹回场地内。"""
    for o in OBSTACLES:
        minx, maxx = o['x'] - o['w'] / 2, o['x'] + o['w'] / 2
        minz, maxz = o['z'] - o['d'] / 2, o['z'] + o['d'] / 2
        cx, cz = max(minx, min(x, maxx)), max(minz, min(z, maxz))
        dx, dz = x - cx, z - cz
        d2 = dx * dx + dz * dz
        if d2 > r * r:
            continue
        if d2 > 1e-9:
            d = math.sqrt(d2)
            push = (r - d) / d
            x += dx * push
            z += dz * push
        else:
            px = min(x - minx, maxx - x)
            pz = min(z - minz, maxz - z)
            if px < pz:
                x += (px + r) if x >= (minx + maxx) / 2 else -(px + r)
            else:
                z += (pz + r) if z >= (minz + maxz) / 2 else -(pz + r)
    lim = WORLD_HALF - r - 0.1
    return max(-lim, min(lim, x)), max(-lim, min(lim, z))


def turn_toward(cur, want, max_step):
    """按最短弧把 cur 转向 want，一帧最多转 max_step 弧度。

    NPC 贴身追目标时 atan2(dx, dz) 会因为目标在自己脚边绕圈而一帧一个方向；
    模型朝向直接跟着这种值走，看到的就是"原地来回抽动"。限速后是平滑转身。
    """
    d = (want - cur + math.pi) % (2 * math.pi) - math.pi
    if abs(d) <= max_step:
        return want
    return cur + math.copysign(max_step, d)


def wander_point(x, z, min_r, max_r, radius):
    """挑一个不在障碍物里的漫游点：目标点落在围栏/鸡舍里的话，NPC 会一直顶着它站着不动。

    另外要求“真的走一段路”：如果被障碍推回来的点离原地太近，NPC 会瞬间到达 → 立刻再挑点 →
    看起来就是原地不动（实测有鸡 8 秒只挪了 0.05m）。所以候选里优先挑离家最远的那个。
    """
    best, best_d = None, -1.0
    for _ in range(6):
        ang = random.random() * 6.283
        rad = min_r + random.random() * (max_r - min_r)
        tx = max(-WORLD_HALF + 2, min(WORLD_HALF - 2, x + math.cos(ang) * rad))
        tz = max(-WORLD_HALF + 2, min(WORLD_HALF - 2, z + math.sin(ang) * rad))
        cx, cz = resolve_circle(tx, tz, radius)
        d = math.hypot(cx - x, cz - z)
        free = math.hypot(cx - tx, cz - tz) < 0.4
        if free and d >= 3.0:
            return (cx, cz)                      # 又空又够远 → 直接用
        if d > best_d:
            best, best_d = (cx, cz), d
    return best or (x, z)


# 状态位：与前端 js/chicken.js 的 ST_* 必须一致（同一个位在两边表示同一个动作）
ST_DEAD, ST_PECK, ST_RUN, ST_FLAP, ST_PREEN = 1, 2, 4, 8, 16
ST_FLEE, ST_FIGHT = 32, 64   # 被攻击之后的逃窜 / 回击（客户端据此换动作 + 名牌小标）
ST_JUMP = 128                # 起跳滞空（客户端缩腿扑腾）—— 与 js/chicken.js 的 ST_JUMP 一致



PROBE_IDLE = ['peck', 'flap', 'preen']   # 鸡的闲时动作：啄草 / 振翅 / 理毛
PROBE_HOT_DMG = 9            # 暴躁鸡啄玩家（与前端单机时一致）
PROBE_HOT_CD = 2.2
PROBE_HOT_RANGE = 1.7
PROBE_HP = 100
PROBE_KO = 3.5
PROBE_R = 0.5
PROBE_SPEED = 0.8            # 闲逛速度：按原站实测（移动时约 0.65~0.9 m/s，走得慢但一直在动）
PROBE_RUN = 3.4              # 暴躁追击速度

# ---- 被攻击后的反应（回击 / 逃窜）+ 回血 ----
PROBE_REACT_FIGHT = 6.0      # 挨打后回击的持续时间（追着打你的人啄）
PROBE_REACT_FLEE = 4.5       # 挨打后逃窜的持续时间（掉头跑开）
PROBE_FLEE_CHANCE = 0.45     # 普通鸡挨打时选择"逃窜"的概率（其余选择"回击"）
PROBE_FLEE_SPEED = 4.2       # 逃窜速度：比玩家慢走(2.8)快、比疾跑(5.4)慢 —— 追得上也跑得掉
PROBE_FLEE_GAP = 9.0         # 拉开到这个距离就收工（不再无脑跑）
PROBE_REGEN_DELAY = 6.0      # 多久没挨打就开始缓慢回血（秒）
PROBE_REGEN_RATE = 4.0       # 回血速度（点/秒）——"缓慢"，不是瞬间满血
PLAYER_REGEN_RATE = 5.0      # 玩家回血速度（点/秒）
SPAWN_RMIN, SPAWN_RMAX = 5.0, 18.0   # 访客随机出生点：离场地中心 5~18m

# ---- 暴躁鸡"欺负别的鸡"（用户要求：暴躁鸡偶尔也去啄探针鸡/网站鸡）----
BULLY_SEEK = 14.0            # 附近这个半径内没有玩家时，才可能去欺负别的鸡（不抢"追人"的主业）
BULLY_PICK = 0.2             # 每帧决定"去欺负谁"的概率（20Hz，约 0.3 秒挑一次）
BULLY_DUR = 5.0              # 一次欺负持续多久（到点或目标倒地就收工）
BULLY_CD = 8.0               # 两次欺负之间至少隔这么久（"偶尔"：忙 5 秒、歇 8 秒）
BULLY_RANGE = 22.0           # 目标跑出这个距离就放弃

# ---- 战斗动作不止"啄"（用户要求：鸡打起来也会扇翅、蹦跳、打了就跑）----
# ⚠ 源站 server/game.js 的 NPC 只会「啄 + 挨打后逃/疾跑」，扇翅与跳跃是玩家专属
#   （`lastWing/wingAnim` 只挂在玩家上、`inp.jump` 也只来自玩家消息）—— 下面这三样是我们自己加的。
#   数值特意与玩家侧同款（伤害 8 / 击退 1.5m），这样"被鸡扇一翅膀"和"被人扇一翅膀"手感一致。
PROBE_WING_RANGE = 1.75      # 扇翅够得到的距离
# ⚠ 必须 ≥ 鸡的站定距离（PROBE_HOT_RANGE=1.7，追到 1.7m 就停下来啄），否则它一辈子扇不出来：
#   实测设 1.45 时两只鸡稳定停在 1.6~1.7m，25 秒里一翅膀都没扇（白盒复现）。
#   玩家那侧是 1.35m —— 玩家自己控制距离，所以能贴身才扇；鸡是 AI 停在 1.7m，得给它这个reach。
PROBE_WING_DMG = 8           # 与玩家扇翅同款伤害
PROBE_WING_CD = 3.2          # 扇翅自己的冷却（比啄击 2.2s 长：偶尔扇一下，不是每下都扇）
PROBE_WING_PICK = 0.45       # 够得着时，每次出手改扇一翅膀的概率
PROBE_WING_KNOCK = 1.5       # 击退距离（与玩家扇翅一致）
PROBE_JUMP_VY = 5.0          # 起跳速度（重力 16 → 最高约 0.78m、滞空约 0.6 秒）
PROBE_GRAVITY = 16.0
PROBE_JUMP_RATE = 0.25       # 追人途中每秒起跳概率（约 4 秒蹦一下）
PROBE_DASH_CHANCE = 0.45     # 非暴躁鸡啄/扇中之后"打了就跑"的概率
PROBE_DASH_T = 1.4           # 跑开多久，然后掉头再扑上来

# ---- NPC·大白鹅（对齐源站 server/game.js 的 NPC_TYPE.goose）----
# 源站那条：{ radius: 0.35, walk: 1.3, flee: 3.6, chase: 2.55, chaseRadius: 2.5, color: 2,
#            maxHp: 60, peckDamage: 6, peckKnock: 3.2, peckCd: 1.2 }
# 数量由 config.json 的 geese 决定（默认 2，可设 0）。差别只有三处，都在下面标了。
GOOSE_NAME = 'NPC·大白鹅'
GOOSE_COUNT = 2              # 默认放养 2 只（源站默认值）；--geese N 或安装时的 geese 文件可改
GOOSE_R = 0.35
GOOSE_HP = 60.0              # 60 血：五口啄击（12/口）放倒
GOOSE_WALK = 1.05            # 闲逛 1.05（源站 1.3 —— 我们探针鸡的闲逛速度用的是**实测值** 0.8
                             # 而不是源站的标称 1.0，所以按同一比例折算：1.3 × 0.8 ≈ 1.05）
GOOSE_CHASE = 2.9            # 追人 2.9（源站 2.55 < 玩家慢走 2.8 → 它永远追不上任何在走的人；
                             # 抬到刚好越过慢走这一档：慢走/站定会被咬到，疾跑（5.4）仍能甩掉）
GOOSE_CHASE_R = 2.5          # 领地半径：玩家进到这个圈里才开始追（源站 chaseRadius）
GOOSE_LEASH = 6.5            # 追出这么远就放弃（源站追人分支用的是 chaseRadius + 4 = 2.5 + 4；
                             # 这里写成字面量，好让 tools/ci.sh 逐个核对客户端文案里的同一组数字）
GOOSE_PECK_R = 1.15          # 追到 1.15m 就啄（源站同一个门限）
GOOSE_DMG = 6
GOOSE_CD = 1.2
GOOSE_KNOCK = 1.2            # 击退：源站是 3.2 的**速度冲量**（加在速度上、由摩擦衰减掉），
                             # 我们下发的是位移指令（客户端直接把坐标挪过去），照搬会变成瞬移 3.2m
                             # —— 按同手感折算成一步 1.2m
GOOSE_FLEE = 3.6             # 被啄之后掉头跑的速度（源站 flee）——★ 2026-11-01 起不再使用
GOOSE_FLEE_T = 2.2           # 跑多久（源站被啄时 state='flee' 的 timer）——★ 同上，保留常量只为对外说明

# ---------------- NPC·看门狗（2026-11-01 加） ----------------
# 守院狗：只在鸡舍门口一带溜达，发现「暴躁鸡」或「大白鹅」就冲上去咬（别的鸡、玩家都不咬）。
# 打不倒（玩家啄它不掉血），也不进啄倒榜 —— 它是场景里的守卫，不是可收集的战绩。
DOG_NAME = '🐕 看门狗'
DOG_COUNT = 1                # 固定 1 只
DOG_HOME = (-8.6, -4.2)      # 鸡舍门前的院子（主路边）—— 它只在这一小片活动
DOG_R = 0.42
DOG_WALK = 1.5
DOG_RUN = 4.2                # 比暴躁鸡（3.4）快，否则永远追不上
DOG_SENSE = 8.0              # 发现暴躁鸡 / 大白鹅的距离（它只守鸡舍门口这一片）
DOG_BITE_R = 1.35
DOG_DMG = 9
DOG_CD = 1.1
DOG_LEASH = 5.0              # 离家最远追这么远（再远就放弃追击、自己走回门口；
                             # ⚠ 只按"狗离目标多远"判断会让它跟着暴躁鸡跑遍全图）
DOG_HP = 100.0
DOG_SCARE_T = 4.0            # 被狗咬过之后「逃离狗的范围」持续多久（这是唯一会触发逃跑的情况）
DOG_TURN = 8.0               # 转身速度（rad/s）：不限制的话贴身时一帧就 180° 掉头，看起来在抽动
DOG_RANGE_IN = DOG_BITE_R    # 进入"够得着"的半径
DOG_RANGE_OUT = 2.2          # 退出"够得着"的半径（迟滞：不然贴着边界一帧 run、一帧停，像在原地抖）
DOG_GIVEUP = 3.0             # 放弃目标后多久内不再挑新目标（避免"丢掉 → 下一帧又锁上"逐帧抽动）
DOG_BAN = 8.0                # 被放弃的那一只，这么久内不再追（让它先跑远）

# ---- NPC 之间的软分离（原站 game.js 主循环里的 separation，我们以前完全没有）----
SEP_MIN = PROBE_R * 2        # 目标间距
SEP_RATE = 0.5               # 每帧消掉多少重叠（比例）
SEP_MAX = 0.10               # 每帧最多推开多少米（约 2 m/s，软推不弹）
CPU_SCALE_MAX = 1.35         # 体型随负载缩放上限（原站：1.0 + cpu/100*0.35）

# ---- 输入净化与滥用防护（2026-09-24 加固，对齐原站游戏服的安全基线）----
MAX_CLIENTS = 60            # 同时在场的并发连接硬顶（原站是 200 sockets / 60 players；60 是压测前的保守值）
MAX_PER_IP = 12             # 同一个访客 IP 的并发连接上限（一家人/NAT 共用出口、多开标签页都会叠在同一 IP 上，别误伤）
MAX_NPCS = 64               # 全服探针鸡/网站鸡总数上限（名单由客户端上报，必须设顶）
# 大白鹅/看门狗是服务端自己放养的，但数量也不能由运维随手填：
# 主循环每帧对 NPC 做 O(N²) 软分离（separate_probes），实测 800 只鹅已经 126ms/帧，
# 而 20Hz 的预算是 50ms —— 数量一大联机服就再也追不上帧（表现为全场卡死/掉线）。
MAX_GEESE = 64
MAX_DOGS = 8
NPC_CACHE_MAX = 256         # 回收后暂存状态（位置/血量/战绩）的条数上限：也是客户端能影响的字典
MAX_NPC_PER_CLIENT = 32     # 单个客户端一次能上报的名单条数（= 全局预算的一半；hub 现在 7 只，够用）
MAX_NPC_JUNK_PER_CLIENT = 8 # 单个客户端能塞的「非 n<数字>/t<数字>」id 数：匿名访客不能拿假 id 占满全服名额
REAL_NPC_ID = re.compile(r'^[nt]\d+$')   # 前端上报的真实形态（js/main.js：`n${node.id}` / `t${task.id}`）
MAX_HOT_IDS = 64            # 单个客户端一次能上报的"暴躁"id 数
LEFT_BOARD_MAX = 20         # 啄倒榜上保留多少条离场玩家的记录
# 允许的 WS 路径：安装器可以把站点挂在任意前缀（默认 /chicken/，也能是 /farm/ 或独立域名挂在 /），
# 所以不能写死白名单 —— 规则是「根路径，或者任何以 /ws 结尾的路径」。
WS_PATHS = ('/', '/ws')                      # 兼容老客户端
def is_ws_path(p):
    p = (p or '').split('?')[0]
    return p in WS_PATHS or p.endswith('/ws')
HANDSHAKE_TOTAL_TIMEOUT = 5.0   # 整轮握手的总预算（防 slowloris 慢慢吐字节占住连接）
HANDSHAKE_MAX_HEADERS = 40      # 请求头条数上限
HANDSHAKE_MAX_HEADER_BYTES = 16 * 1024   # 请求头总字节上限（只限条数不限字节，40 条也能塞几 MB）
IDLE_TIMEOUT = 40.0             # 多久没有任何入站消息（含 pong）算掉线
WS_PING_EVERY = 10.0            # 服务端主动发 WS ping 的间隔（浏览器/客户端会自动回 pong）
MAX_STEP = 2.0              # 单次位置上报允许的最大位移（米）—— 正常 20Hz 只有 ~0.27m
MAX_DT_FACTOR = 8.0         # 上报间隔每多 1 秒额外放宽这么多米（网络抖动/切后台回来时别误伤）
POS_LIMIT = WORLD_HALF - 0.2    # 位置夹取范围（顺便挡住"瞬移到围栏外"）
Y_MIN, Y_MAX = -50.0, 50.0      # y 只是视觉量，也夹一下不合理的值


def num_or_none(v):
    """客户端来的数值 → 有限浮点；NaN / Inf / 非数值 / bool 一律 None。

    必须过滤（2026-09-24 修的真洞）：`json.loads` 默认接受 `NaN`，`float(nan)` 也不抛异常，
    于是 nan 会一路进快照 —— `json.dumps` 吐出非法 JSON（`NaN`），所有客户端 `JSON.parse`
    抛错并**静默丢掉整帧快照**（远端鸡/玩家集体定格，不掉线、日志干净）。同一路径还会
    绕过啄击判定：`nan` 参与比较恒为 False，距离/朝向检查全被跳过 → 隔半张地图也能啄中。
    """
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return None
    try:
        f = float(v)
    except OverflowError:
        # 超大整数（JSON 里 400 个 9）：float() 直接抛 OverflowError，会把发送方自己那条连接掐掉
        return None
    return f if math.isfinite(f) else None


def _reject_nonfinite(name):
    """`json.loads` 的 parse_constant：NaN / Infinity / -Infinity 直接判为非法消息。"""
    raise ValueError(f'非法数值常量 {name}')


class Probe:
    """探针鸡（kind='probe'）与网站鸡（kind='web'）。

    位置/血量/倒地/暴躁追击全部在服务端算；名牌上的探针数据仍由各客户端自己从 hub 取
    （那是面板数据，不是游戏状态）。
    """

    def __init__(self, pid, name, kind='probe', x=0.0, z=0.0, scale=1.0):
        self.id = pid
        self.name = name
        self.kind = kind
        self.scale = float(scale)     # 体型倍率（1.0 ~ 1.35，随 CPU 走；名牌尺寸不变）
        self.x, self.z = float(x), float(z)
        self.y = ground_height(self.x, self.z)
        self.yaw = random.random() * 6.283
        self.hp = float(PROBE_HP)
        self.ko_until = 0.0
        self.atk_ready = 0.0
        self.peck_t = 0.0
        self.hot = False              # 由客户端上报（CPU/内存超阈值）
        self.bully_id = None          # 暴躁鸡正在欺负的那只鸡（id）
        self.bully_until = 0.0
        self.bully_cd = 0.0
        self.wx, self.wz = self.x, self.z
        self.retarget = 0.0
        self.idle_kind = ''
        self.idle_t = 0.0
        self.st = 0
        self.pause_t = 0.0            # 到点后的歇脚时间（原站 NPC 是走走停停的）
        self.lx, self.lz = self.x, self.z   # 上一帧位置（判断"真的挪动了吗"）
        self.stuck_t = 0.0
        self.last_hit = 0.0           # 上次挨打的时间（回血用）
        self.scare_until = 0.0        # 被看门狗咬之后「逃出狗的范围」的截止时间（唯一会逃的情况）
        self.scare_x, self.scare_z = 0.0, 0.0
        self.react_mode = ''          # 'fight'（回击）/ 'flee'（逃窜）
        self.react_until = 0.0
        self.react_by = 0             # 打它的那个玩家的 id（回击/逃窜都冲着这个人）
        self.flee_bias = 0.0          # 逃窜时的一个小偏角，免得直愣愣撞围栏
        # ---- 战斗动作：扇翅 / 蹦跳 / 打了就跑 ----
        self.wing_ready = 0.0         # 下一次能扇翅的时间
        self.wing_t = 0.0             # 扇翅动作的表演时长（>0 时置 ST_FLAP）
        self.h = 0.0                  # 离地高度（跳跃时 >0；下发的 y = 地面高度 + h）
        self.jump_vy = 0.0            # 起跳后的竖直速度
        self.dash_until = 0.0         # "打了就跑"跑到什么时候
        self.dash_x, self.dash_z = 0.0, 0.0   # 从哪儿跑开（背对着这里退）
        self.score = 0                # 啄倒榜：这只鸡放倒过多少只（啄倒玩家 / 欺负别的鸡，服务端裁定）

    @property
    def dead(self):
        return now() < self.ko_until

    def state(self):
        # 第 9 项是啄倒数（啄倒榜用）：客户端只做展示，谁被记功完全由服务端裁定
        return [self.id, round(self.x, 2), round(self.z, 2), round(self.y + self.h, 2),
                round(self.yaw, 3), round(self.hp), self.st, round(self.scale, 3), int(self.score)]

    def take_hit(self, dmg, by=None):
        if self.dead:
            return False
        self.hp -= dmg
        self.peck_t = 0.35
        self.last_hit = now()
        if by is not None and getattr(by, 'kind', '') == 'dog':
            # ★ 被看门狗咬：不管是不是暴躁鸡，一律先逃出狗的范围（唯一会触发逃跑的情况）
            self.scare_until = now() + DOG_SCARE_T
            self.scare_x, self.scare_z = by.x, by.z
            self.react_until = 0.0
            self.react_mode = ''
            self.retarget = 0.0
            self.pause_t = 0.0
        elif by is not None:
            # 挨打之后的反应：
            #   * 暴躁鸡**永远回击**（用户要求：暴躁鸡哪怕受到攻击也不会逃窜）
            #   * 普通鸡随机选「回击」或「逃窜」
            if self.hot:
                self.react_mode = 'fight'
            else:
                self.react_mode = 'flee' if random.random() < PROBE_FLEE_CHANCE else 'fight'
            dur = PROBE_REACT_FLEE if self.react_mode == 'flee' else PROBE_REACT_FIGHT
            self.react_until = now() + dur
            self.react_by = getattr(by, 'id', 0) or 0
            self.flee_bias = (random.random() - 0.5) * 0.9
            self.retarget = 0.0
            self.pause_t = 0.0
        if self.hp <= 0:
            self.hp = 0.0
            self.ko_until = now() + PROBE_KO
            self.st = ST_DEAD
            self.react_mode = ''
            self.react_until = 0.0
            self.react_by = 0
            return True
        return False

    def revive(self):
        self.hp = float(PROBE_HP)
        self.ko_until = 0.0
        self.react_mode = ''
        self.react_until = 0.0
        self.react_by = 0
        self.last_hit = 0.0
        ang = random.random() * 6.283
        rad = 5 + random.random() * 17
        self.x, self.z = resolve_circle(math.cos(ang) * rad, math.sin(ang) * rad, PROBE_R)
        self.y = ground_height(self.x, self.z)

    def _pick_attack(self, d):
        """这一下是啄还是扇？（返 True = 这一下改用扇翅）

        够得着扇翅距离、且扇翅冷却好了，才有 PROBE_WING_PICK 的概率改扇一翅膀 ——
        用户要的是"战斗里除了啄也有扇"，但必须**偶尔**扇（有独立的 3.2 秒冷却），
        否则贴脸的时候每一下都是扇，手感就变成"被扇到站不起来"。
        """
        if d <= PROBE_WING_RANGE and now() >= self.wing_ready and random.random() < PROBE_WING_PICK:
            self.wing_ready = now() + PROBE_WING_CD
            self.wing_t = 0.35
            self.st |= ST_FLAP
            return True
        self.peck_t = 0.35
        self.st |= ST_PECK
        return False

    def step(self, dt, players, attack, npcs, attack_npc):
        self.st = 0
        self.peck_t = max(0.0, self.peck_t - dt)
        self.wing_t = max(0.0, self.wing_t - dt)
        if self.dead:
            self.st = ST_DEAD
            self.h, self.jump_vy = 0.0, 0.0        # 倒地就落回地面，别在半空躺下
            return
        # 跳跃：起跳后按重力落回地面（下发的 y = 地面 + h），滞空期间置 ST_JUMP 让客户端缩腿扑腾
        if self.jump_vy != 0.0 or self.h > 0.0:
            self.jump_vy -= PROBE_GRAVITY * dt
            self.h += self.jump_vy * dt
            if self.h <= 0.0:
                self.h, self.jump_vy = 0.0, 0.0
            else:
                self.st |= ST_JUMP
        if self.wing_t > 0:
            self.st |= ST_FLAP
        # 回血：一段时间没挨打就慢慢回上去（任何鸡都一样，玩家在 Game.loop 里同款处理）
        if self.hp < PROBE_HP and now() - self.last_hit > PROBE_REGEN_DELAY:
            self.hp = min(float(PROBE_HP), self.hp + PROBE_REGEN_RATE * dt)
        if self.peck_t > 0:
            self.st |= ST_PECK

        tgt, best = None, 1e9
        for c, px, pz in players:
            d = math.hypot(px - self.x, pz - self.z)
            if d < best:
                tgt, best = c, d

        # 打我的那个人还在场（且没倒地）吗？回击要冲他去、逃窜要躲他跑
        foe = next((c for c, _, _ in players if c.id == self.react_by), None) if self.react_by else None
        if foe is None and self.react_by:
            foe = npcs.get(self.react_by)      # 打我的是别的鸡（暴躁鸡欺负人）→ 冲着那只鸡去
        if foe is not None and getattr(foe, 'dead', False):
            foe = None

        # 行为模式：暴躁鸡永远回击（受击也不逃窜）；普通鸡挨打后一段时间内回击或逃窜
        if self.hot:
            mode = 'fight'
        elif now() < self.react_until:
            mode = self.react_mode
        else:
            mode = ''
        if mode == 'flee':
            if foe is None:
                mode = ''                                  # 打我的人跑了 —— 不逃了
            elif best > PROBE_FLEE_GAP:
                mode = ''                                  # 已经拉开足够远 → 收工回去散步
                self.react_until = 0.0

        # ---- 暴躁鸡也会偶尔欺负别的鸡（用户要求）：附近没有玩家时才考虑，不抢"追人"的主业 ----
        bully = None
        if self.hot:
            if self.bully_id is not None:
                b = npcs.get(self.bully_id)
                if b is None or b.dead or now() > self.bully_until \
                        or math.hypot(b.x - self.x, b.z - self.z) > BULLY_RANGE:
                    self.bully_id = None
                    self.bully_cd = now() + BULLY_CD
                else:
                    bully = b
            elif now() >= self.bully_cd and (tgt is None or best > BULLY_SEEK) and random.random() < BULLY_PICK:
                cand = [(math.hypot(o.x - self.x, o.z - self.z), o) for o in npcs.values()
                        if o is not self and not o.dead]
                cand = [t for t in cand if t[0] <= BULLY_SEEK]
                if cand:
                    cand.sort(key=lambda t: t[0])
                    bully = cand[0][1]
                    self.bully_id = bully.id
                    self.bully_until = now() + BULLY_DUR

        speed = 0.0
        chasing = False        # 这一拍是在追人吗？（只有追人的时候才蹦跳，闲逛时不蹦）
        if now() < self.scare_until and math.hypot(self.x - self.scare_x, self.z - self.scare_z) > DOG_SENSE:
            self.scare_until = 0.0                  # 已经逃出狗的范围 → 收工
        if now() < self.scare_until:
            # ★ 被看门狗咬过：只顾着逃出狗的范围（用户 2026-11-01：只有被狗咬才会逃，
            #   暴躁鸡平时受击也只回击、不逃跑）
            dx, dz = self.x - self.scare_x, self.z - self.scare_z
            if math.hypot(dx, dz) < 1e-4:
                dx, dz = 1.0, 0.0
            self.yaw = math.atan2(dx, dz) + self.flee_bias
            self.st |= ST_RUN | ST_FLEE
            self.idle_t = 0.0
            self.pause_t = 0.0
            speed = PROBE_FLEE_SPEED
        elif bully is not None:
            # 追上去啄它：不记任何战绩，只扣血/放倒（分数系统已按用户要求整体删掉）
            dx, dz = bully.x - self.x, bully.z - self.z
            d = math.hypot(dx, dz)
            self.yaw = math.atan2(dx, dz)
            self.st |= ST_RUN | ST_FIGHT
            self.idle_t = 0.0
            chasing = True
            if d < PROBE_HOT_RANGE:
                if now() >= self.atk_ready:
                    self.atk_ready = now() + PROBE_HOT_CD
                    wing = self._pick_attack(d)
                    attack_npc(bully, self, wing=wing)
            else:
                speed = PROBE_RUN
        elif now() < self.dash_until:
            # 打了就跑：扇/啄中之后背对目标退开一两米，等冷却过去再扑上来（只有普通鸡这么做）
            dx, dz = self.x - self.dash_x, self.z - self.dash_z
            if math.hypot(dx, dz) < 1e-4:
                dx, dz = 1.0, 0.0
            self.yaw = math.atan2(dx, dz) + self.flee_bias
            self.st |= ST_RUN | ST_FLEE
            self.idle_t = 0.0
            speed = PROBE_FLEE_SPEED * 0.75      # 比正经逃窜慢一点：是"撤一步"不是"逃命"
        elif mode == 'fight' and tgt is not None:
            # 回击 / 暴躁：冲过去啄人（暴躁鸡一直如此，普通鸡只在被打之后来这一阵）
            whose = foe if foe is not None else tgt
            if math.hypot(whose.x - self.x, whose.z - self.z) >= 16:
                whose = tgt                                # 打我的那个跑远了 → 就近找一只算账
            if math.hypot(whose.x - self.x, whose.z - self.z) < 16:
                self.yaw = math.atan2(whose.x - self.x, whose.z - self.z)
                self.st |= ST_RUN
                chasing = True
                if mode == 'fight' and not self.hot:
                    self.st |= ST_FIGHT
                self.idle_t = 0.0
                dd = math.hypot(whose.x - self.x, whose.z - self.z)
                if dd < PROBE_HOT_RANGE:
                    if now() >= self.atk_ready:
                        self.atk_ready = now() + PROBE_HOT_CD
                        wing = self._pick_attack(dd)          # 啄 or 扇（近距离偶尔扇一翅膀）
                        if isinstance(whose, Probe):
                            attack_npc(whose, self, wing=wing)     # 回击的对象是鸡不是人
                        else:
                            attack(whose, self, wing=wing)
                            # 打了就跑（用户要求战斗里也有"逃跑"）：普通鸡扇/啄中之后退开一下再扑上来。
                            # ⚠ 暴躁鸡不参与：它的设定是"受击也不逃窜"，一趟咬到底。
                            if not self.hot and random.random() < PROBE_DASH_CHANCE:
                                self.dash_until = now() + PROBE_DASH_T
                                self.dash_x, self.dash_z = whose.x, whose.z
                else:
                    speed = PROBE_RUN
        elif mode == 'flee' and foe is not None:
            # 逃窜：背对着打它的人撒腿就跑（客户端用 ST_FLEE 表现成惊慌扑腾）
            dx, dz = self.x - foe.x, self.z - foe.z
            if math.hypot(dx, dz) < 1e-4:
                dx, dz = 1.0, 0.0
            self.yaw = math.atan2(dx, dz) + self.flee_bias
            self.st |= ST_RUN | ST_FLEE
            self.idle_t = 0.0
            speed = PROBE_FLEE_SPEED
        elif self.pause_t > 0:
            # 到点歇脚：站着不动，偶尔来一下短促的闲时动作
            self.pause_t -= dt
            if self.pause_t <= 0:
                self.retarget = 0.0
            if self.idle_t > 0:
                self.idle_t -= dt
                self.st |= {'peck': ST_PECK, 'flap': ST_FLAP, 'preen': ST_PREEN}.get(self.idle_kind, 0)
        else:
            if self.retarget <= 0:
                self.wx, self.wz = wander_point(self.x, self.z, 3.0, 4.2, PROBE_R)   # 对齐原站：30 秒约 3 段、合计 ~10m
                self.retarget = 1e9            # 挑一次就一路走到，别每帧重挑（否则原地抖）
            dx, dz = self.wx - self.x, self.wz - self.z
            d = math.hypot(dx, dz)
            if d > 0.45:
                self.yaw = math.atan2(dx, dz)
                speed = PROBE_SPEED
            else:
                # 到点后固定歇 4~7 秒（原站实测：移动时间只占 ~45%，不是一直走）；
                # 歇的过程中有 45% 概率做一次短促的闲时动作（啄草/振翅/理毛）
                self.pause_t = 5.5 + random.random() * 1.5
                if random.random() < 0.45:
                    self.idle_kind = random.choice(PROBE_IDLE)
                    self.idle_t = 0.45 + random.random() * 0.5
                self.retarget = 1e9

        # 蹦跳（用户要求）：追人途中偶尔蹦一下 —— 拟人，也让"它在逼近"这件事看得见
        if chasing and self.h <= 0.0 and random.random() < PROBE_JUMP_RATE * dt:
            self.jump_vy = PROBE_JUMP_VY

        if speed > 0:
            self.x, self.z = resolve_circle(
                self.x + math.sin(self.yaw) * speed * dt,
                self.z + math.cos(self.yaw) * speed * dt, PROBE_R)
            self.y = ground_height(self.x, self.z)

        # 卡住保护：想走却连续 2.5 秒几乎没挪动（被围栏/鸡舍顶住、或目标点被判"已到达"），
        # 就立刻丢掉当前目标重挑一个 —— 免得用户看到它"站在原地不动"
        moved = math.hypot(self.x - self.lx, self.z - self.lz)
        self.lx, self.lz = self.x, self.z
        if speed > 0 and moved < 0.02:
            self.stuck_t += dt
            if self.stuck_t > 2.5:
                self.stuck_t = 0.0
                self.retarget = 0.0
        else:
            self.stuck_t = 0.0


class Goose:
    """NPC·大白鹅 —— 服务端权威的巡场鹅（源站 server/game.js 的 NPC_TYPE.goose）。

    与探针鸡的差别（都跟源站一致）：
      * **有领地意识**：玩家进到 GOOSE_CHASE_R（2.5m）里就追、追到 GOOSE_PECK_R（1.15m）就啄；
        追出 GOOSE_LEASH（6.5m）就放弃回去散步。它**只盯玩家**（源站 findPrey 里大鹅不把别的鸡当目标）。
      * **被啄就吓跑**：挨了一下掉头跑 2.2 秒（不还击），跑完再回去巡场。
      * 60 血 —— 玩家五口啄击（12/口）能放倒它，记一个啄倒数（服务端裁定）。

    它**不是探针数据**：由服务端自己按数量放养（源站 config.json 的 geese），
    所以不走"客户端上报 NPC 名单"那条路，客户端也不能增删它。
    """

    def __init__(self, gid, x=0.0, z=0.0):
        self.id = gid
        self.name = GOOSE_NAME
        self.kind = 'goose'
        self.x, self.z = resolve_circle(float(x), float(z), GOOSE_R)
        self.y = ground_height(self.x, self.z)
        self.yaw = random.random() * 6.283
        self.hp = GOOSE_HP
        self.ko_until = 0.0
        self.atk_ready = 0.0
        self.peck_t = 0.0
        self.st = 0
        self.scale = 1.0              # 体型不随负载变（它不属于任何探针）
        self.score = 0                # 啄倒榜：它放倒过多少只（榜上所有大鹅合起来算一行）
        self.last_hit = 0.0
        self.aggro = False            # 已经盯上谁了（领地内发现 → 追到 leash 外才放弃）
        self.flee_until = 0.0         # 被啄之后的逃跑时间
        self.flee_from = None         # 从谁那儿跑（打它的那个：玩家或别的鸡）
        # 闲逛：与探针鸡同一套"走走停停"（挑一次点就一路走到，到点歇一会）
        self.wx, self.wz = self.x, self.z
        self.retarget = 0.0
        self.pause_t = 0.0
        self.idle_kind = ''
        self.idle_t = 0.0
        self.lx, self.lz = self.x, self.z
        self.stuck_t = 0.0

    @property
    def dead(self):
        return now() < self.ko_until

    def state(self):
        return [self.id, round(self.x, 2), round(self.z, 2), round(self.y, 2),
                round(self.yaw, 3), round(self.hp), self.st, round(self.scale, 3), int(self.score)]

    def take_hit(self, dmg, by=None):
        if self.dead:
            return False
        self.hp -= dmg
        self.peck_t = 0.35
        self.last_hit = now()
        # ★ 2026-11-01（用户要求，两轮）：大白鹅平时挨打**不逃跑**（会回头盯着打它的那个人）；
        #   只有被看门狗咬的时候才逃出狗的范围（flee_from 记狗的位置，跑 4 秒或跑出 9m 就收工）。
        if getattr(by, 'kind', '') == 'dog':
            self.flee_until = now() + DOG_SCARE_T
            self.flee_from = (by.x, by.z)
            self.aggro = False
        else:
            self.flee_until = 0.0
            self.flee_from = None
            self.aggro = True
        if self.hp <= 0:
            self.hp = 0.0
            self.ko_until = now() + PROBE_KO
            self.st = ST_DEAD
            self.aggro = False
            return True
        return False

    def revive(self):
        self.hp = GOOSE_HP
        self.ko_until = 0.0
        self.flee_until = 0.0
        self.aggro = False
        self.last_hit = 0.0
        ang = random.random() * 6.283
        rad = 6 + random.random() * 14
        self.x, self.z = resolve_circle(math.cos(ang) * rad, math.sin(ang) * rad, GOOSE_R)
        self.y = ground_height(self.x, self.z)

    def step(self, dt, players, attack):
        self.st = 0
        self.peck_t = max(0.0, self.peck_t - dt)
        if self.dead:
            self.st = ST_DEAD
            return
        if self.peck_t > 0:
            self.st |= ST_PECK
        # 回血：与探针鸡同一套（源站没有回血机制，这是我们自己的收尾规则，两边一致）
        if self.hp < GOOSE_HP and now() - self.last_hit > PROBE_REGEN_DELAY:
            self.hp = min(GOOSE_HP, self.hp + PROBE_REGEN_RATE * dt)

        speed = 0.0
        # ★ 2026-11-01（用户要求）：大白鹅平时挨打**不逃跑**（回头盯着打它的那个人）；
        #   只有被看门狗咬的时候才掉头逃出狗的范围（flee_from = 狗的位置）。
        if now() < self.flee_until:
            fx, fz = self.flee_from if self.flee_from else \
                (self.x - math.sin(self.yaw), self.z - math.cos(self.yaw))
            if math.hypot(self.x - fx, self.z - fz) > DOG_SENSE:
                self.flee_until = 0.0            # 已经逃出狗的范围 → 收工
        if now() < self.flee_until:
            fx, fz = self.flee_from if self.flee_from else (self.x - 1.0, self.z)
            dx, dz = self.x - fx, self.z - fz
            if math.hypot(dx, dz) < 1e-4:
                dx, dz = 1.0, 0.0
            self.yaw = math.atan2(dx, dz)
            self.st |= ST_RUN | ST_FLEE
            self.pause_t = 0.0
            speed = GOOSE_FLEE
        else:
            tgt, best = None, 1e9
            for c, px, pz in players:
                if c.dead:
                    continue                     # 倒地的玩家不是目标（源站 findPrey 同一条件）
                d = math.hypot(px - self.x, pz - self.z)
                if d < best:
                    tgt, best = c, d
            if tgt is not None:
                if best <= GOOSE_CHASE_R:
                    self.aggro = True            # 进领地 → 追
                elif best > GOOSE_LEASH:
                    self.aggro = False           # 追出领地 → 放弃
            if self.aggro and tgt is not None:
                self.pause_t = 0.0
                self.idle_t = 0.0
                self.yaw = math.atan2(tgt.x - self.x, tgt.z - self.z)
                if best > GOOSE_PECK_R:
                    self.st |= ST_RUN
                    speed = GOOSE_CHASE
                elif now() >= self.atk_ready:
                    self.atk_ready = now() + GOOSE_CD
                    self.peck_t = 0.35
                    self.st |= ST_PECK
                    attack(tgt, self)
            elif self.pause_t > 0:
                self.pause_t -= dt
                if self.pause_t <= 0:
                    self.retarget = 0.0
                if self.idle_t > 0:
                    self.idle_t -= dt
                    self.st |= {'peck': ST_PECK, 'flap': ST_FLAP, 'preen': ST_PREEN}.get(self.idle_kind, 0)
            else:
                if self.retarget <= 0:
                    self.wx, self.wz = wander_point(self.x, self.z, 3.0, 4.2, GOOSE_R)
                    self.retarget = 1e9
                dx, dz = self.wx - self.x, self.wz - self.z
                d = math.hypot(dx, dz)
                if d > 0.45:
                    self.yaw = math.atan2(dx, dz)
                    speed = GOOSE_WALK
                else:
                    self.pause_t = 5.5 + random.random() * 1.5
                    if random.random() < 0.45:
                        self.idle_kind = random.choice(PROBE_IDLE)
                        self.idle_t = 0.45 + random.random() * 0.5
                    self.retarget = 1e9

        if speed > 0:
            self.x, self.z = resolve_circle(self.x + math.sin(self.yaw) * speed * dt,
                                            self.z + math.cos(self.yaw) * speed * dt, GOOSE_R)
            self.y = ground_height(self.x, self.z)
        # 卡住保护（与探针鸡同款）
        moved = math.hypot(self.x - self.lx, self.z - self.lz)
        self.lx, self.lz = self.x, self.z
        if speed > 0 and moved < 0.02:
            self.stuck_t += dt
            if self.stuck_t > 2.5:
                self.stuck_t = 0.0
                self.retarget = 0.0
        else:
            self.stuck_t = 0.0


class Dog:
    """NPC·看门狗 —— 服务端权威的守院狗（2026-11-01 加，用户要求）。

    行为：在 DOG_HOME 一带溜达 → 发现 DOG_SENSE 内的**暴躁鸡**或**大白鹅**就冲上去咬
    （DOG_DMG / DOG_CD），咬倒照样记功（但啄倒榜上不显示「看门狗」这一行）；
    追出 DOG_LEASH 就放弃、回门口。它不咬玩家、不咬普通探针鸡/网站鸡，自己也打不倒。
    """

    def __init__(self, did, x=None, z=None):
        self.id = did
        self.name = DOG_NAME
        self.kind = 'dog'
        self.x = DOG_HOME[0] if x is None else float(x)
        self.z = DOG_HOME[1] if z is None else float(z)
        self.x, self.z = resolve_circle(self.x, self.z, DOG_R)
        self.y = ground_height(self.x, self.z)
        self.yaw = random.random() * 6.283
        self.hp = DOG_HP
        self.st = 0
        self.scale = 1.0
        self.score = 0                # 咬倒过几只（榜上不显示，只进事件播报）
        self.bite_t = 0.0
        self.atk_ready = 0.0
        self.target = None            # 正在咬的那只（探针鸡 / 大白鹅）的 id
        self.wx, self.wz = self.x, self.z
        self.retarget = 0.0
        self.pause_t = 0.0
        self.lx, self.lz = self.x, self.z
        self.stuck_t = 0.0
        self.cool = 0.0               # 这个时刻之前不挑新目标（放弃目标后冷静一下）
        self.ban_id = None            # 刚被放弃的那一只（这段时间内不再追它）
        self.ban_until = 0.0
        self.in_range = False         # 咬的判定带迟滞（见 DOG_RANGE_IN / DOG_RANGE_OUT）

    @property
    def dead(self):
        return False                  # 打不倒：它没有倒地状态

    def state(self):
        return [self.id, round(self.x, 2), round(self.z, 2), round(self.y, 2),
                round(self.yaw, 3), round(self.hp), self.st, round(self.scale, 3), int(self.score)]

    def take_hit(self, dmg, by=None):
        """狗不掉血（用户没让它可被讨伐）：挨啄只当没发生，免得玩家靠刷它刷分。"""
        return False

    def _give_up(self, t, ban=True):
        """放弃当前目标：冷静一会儿，并把这一只拉黑（否则下一帧又会锁定它 → 原地抽动）。"""
        if ban and self.target:
            self.ban_id = self.target
            self.ban_until = t + DOG_BAN
        self.target = None
        self.cool = t + DOG_GIVEUP
        self.retarget = 0.0

    def _banned(self, tid, t):
        return tid == self.ban_id and t < self.ban_until

    def step(self, dt, probes, geese, attack):
        self.st = 0
        self.bite_t = max(0.0, self.bite_t - dt)
        if self.bite_t > 0:
            self.st |= ST_PECK
        t = now()
        # 目标还有效吗（活着 / 没跑出 sense / 自己没离门口太远 / 仍然是"该咬的"）
        tgt = None
        if self.target:
            tgt = probes.get(self.target) or geese.get(self.target)
            if tgt is not None:
                far_home = math.hypot(self.x - DOG_HOME[0], self.z - DOG_HOME[1]) > DOG_LEASH
                if tgt.dead or math.hypot(tgt.x - self.x, tgt.z - self.z) > DOG_SENSE * 1.8:
                    self._give_up(t, ban=False)      # 目标没了 → 收工，不拉黑（下一只还能咬）
                    tgt = None
                elif far_home:
                    self._give_up(t, ban=True)       # 自己追得太远 → 收工并拉黑，别在边界来回扑
                    tgt = None
                elif self.target in probes and not getattr(tgt, 'hot', False):
                    tgt = None                       # 已经不是暴躁鸡了 → 放它一马
            if tgt is None:
                self.target = None
        home_d = math.hypot(self.x - DOG_HOME[0], self.z - DOG_HOME[1])
        # ⚠ 迟滞：**挑目标**用 DOG_LEASH*0.8，**放弃**用 DOG_LEASH。两条线不能反过来/相同，
        #   否则狗会在边界上"一帧丢掉、一帧重新锁上"，原地来回抽动（用户报过）。
        if tgt is None and home_d <= DOG_LEASH * 0.8 and t >= self.cool:
            best, bd = None, DOG_SENSE
            for p in probes.values():                      # 只咬暴躁鸡
                if p.dead or not getattr(p, 'hot', False) or self._banned(p.id, t):
                    continue
                d = math.hypot(p.x - self.x, p.z - self.z)
                if d < bd:
                    best, bd = p, d
            for g in geese.values():                       # 大白鹅全咬
                if g.dead or self._banned(g.id, t):
                    continue
                d = math.hypot(g.x - self.x, g.z - self.z)
                if d < bd:
                    best, bd = g, d
            if best is not None:
                tgt = best
                self.target = best.id
                self.in_range = False
        speed = 0.0
        if tgt is not None:
            d = math.hypot(tgt.x - self.x, tgt.z - self.z)
            # 转身限速：贴身时目标绕着自己转，atan2 每帧指向不同方向 → 模型原地抖
            self.yaw = turn_toward(self.yaw, math.atan2(tgt.x - self.x, tgt.z - self.z), DOG_TURN * dt)
            self.pause_t = 0.0
            # 咬的判定也带迟滞：贴着 DOG_BITE_R 时 run/停 会一帧一换
            if d > DOG_RANGE_OUT:
                self.in_range = False
            elif d <= DOG_RANGE_IN:
                self.in_range = True
            if not self.in_range:
                self.st |= ST_RUN
                speed = DOG_RUN
            elif t >= self.atk_ready:
                self.atk_ready = t + DOG_CD
                self.bite_t = 0.3
                self.st |= ST_PECK
                attack(tgt, self, False, DOG_DMG)
        elif self.pause_t > 0:
            self.pause_t -= dt
            if self.pause_t <= 0:
                self.retarget = 0.0
        else:
            if self.retarget <= 0:
                self.wx, self.wz = wander_point(self.x, self.z, 1.2, 2.4, DOG_R)
                self.retarget = 1e9
            if math.hypot(self.x - DOG_HOME[0], self.z - DOG_HOME[1]) > 3.5:
                self.wx, self.wz = DOG_HOME          # 溜达远了就回门口
            dx, dz = self.wx - self.x, self.wz - self.z
            d = math.hypot(dx, dz)
            if d > 0.45:
                self.yaw = turn_toward(self.yaw, math.atan2(dx, dz), DOG_TURN * dt)
                speed = DOG_WALK
            else:
                self.pause_t = 3.0 + random.random() * 3.0
                self.retarget = 1e9

        if speed > 0:
            self.x, self.z = resolve_circle(self.x + math.sin(self.yaw) * speed * dt,
                                            self.z + math.cos(self.yaw) * speed * dt, DOG_R)
            self.y = ground_height(self.x, self.z)
        # 卡住保护（与探针鸡/大白鹅同款）：追人的时候阈值更低，并且**直接放弃这个目标**
        # —— 只把漫游点换一个的话，狗还会顶着围栏/障碍继续推，用户看到的就是"卡住不动"。
        moved = math.hypot(self.x - self.lx, self.z - self.lz)
        self.lx, self.lz = self.x, self.z
        limit = 1.0 if self.target else 2.5
        if speed > 0 and moved < 0.02:
            self.stuck_t += dt
            if self.stuck_t > limit:
                self.stuck_t = 0.0
                if self.target:
                    self._give_up(t, ban=True)
                self.retarget = 0.0
        else:
            self.stuck_t = 0.0


COLORS = [0xfff6e2, 0xffe0b2, 0xe9d5ff, 0xcfe8ff, 0xd6f5c9, 0xffd6e0, 0xd9f0ff, 0xffefc2]
ADJ = ['咕咕', '黄焖', '咖喱', '椒盐', '照烧', '白斩', '盐焗', '芝士', '奥尔良', '三杯']
NOUN = ['小鸡', '战斗鸡', '大公鸡', '仔鸡', '童子鸡', '柴鸡', '土鸡']


def now() -> float:
    return time.time()


def country_from_headers(headers: dict) -> str:
    """访客 IP 所在地的两个字母国旗码。

    站点走 Cloudflare 橙云时，CF 在回源请求里带 CF-IPCountry（反代用
    proxy_set_header 透传过来）—— 这是"访客 IP 所在地"的现成答案，不必自己维护 GeoIP 库。
    拿不到（直连回源 IP 访问 / 本地自测）就返回空串，此时客户端可以在 hi 里自报一个 cc
    （只用于显示自己的国旗，纯外观，不参与任何判定）。
    """
    cc = str(headers.get('cf-ipcountry') or '').strip().upper()
    if len(cc) == 2 and cc.isalpha() and cc not in ('XX', 'T1'):   # CF 文档：XX=未知, T1=Tor
        return cc
    return ''


class Client:
    _next_id = 1

    def __init__(self, reader, writer, headers=None):
        self.reader, self.writer = reader, writer
        # 只留国旗码：整份请求头常驻内存是「40 条 × 单值 64KiB ≈ 2.5MB/连接」，
        # 60 条连接就能顶满 unit 的 MemoryMax=128M（2026-11-03 修）
        self.cc = country_from_headers(headers or {})   # 访客 IP 所在地（国旗码），空=没拿到
        self.id = Client._next_id
        Client._next_id += 1
        self.name = None
        self.color = random.choice(COLORS)
        self.x, self.z, self.y, self.yaw = 0.0, 0.0, 0.0, 0.0
        self.run = False
        self.hp = 100.0
        self.ko_until = 0.0
        self.peck_ready = 0.0
        self.wing_ready = 0.0
        self.last_hit = 0.0           # 上次挨打的时间（回血用）
        self.last_msg = now()
        self.msg_count = 0
        self.msg_window = now()
        self.npc_roster = {}          # 这个客户端上报的 NPC 名单（id → (name, kind)）
        self.hot_ids = set()          # 这个客户端认为"暴躁"的探针鸡 id
        self.alive = True
        self.ip = ''                  # 访客 IP（x-real-ip / CF-Connecting-IP / 对端地址），每 IP 限流用
        self.pos_t = now()            # 上次位置上报的时间（判断"单次位移"是否离谱）
        self.clamped = 0              # 位置被夹取过多少次（debug 日志用）
        self.kicked = False           # 服务端主动踢的（空闲清理），_serve 不记「连接异常」
        self.score = 0                # 啄倒榜：这个访客放倒过多少只（服务端裁定，断线即清零）

    @property
    def dead(self):
        return now() < self.ko_until

    def take_hit(self, dmg, by=None):
        """返回 True 表示这一击把它放倒。"""
        if self.dead:
            return False
        self.hp -= dmg
        self.last_hit = now()
        if self.hp <= 0:
            self.hp = 0.0
            self.ko_until = now() + KO_TICKS
            return True
        return False

    def roster(self):
        return {'id': self.id, 'name': self.name or f'鸡友{self.id}', 'color': self.color,
                'hp': round(self.hp), 'cc': self.cc}

    def send_frame(self, data):
        """直接写一个已编码的 WS 帧（广播时只序列化一次，省 N 次 json.dumps）。"""
        if not self.alive:
            return
        try:
            if self.writer.transport.get_write_buffer_size() > 512 * 1024:
                return            # 客户端跟不上了，丢这一帧，别把服务端拖死
        except Exception:
            pass
        try:
            self.writer.write(data)
        except Exception:
            self.alive = False

    def send(self, obj):
        if not self.alive:
            return
        try:
            # allow_nan=False：宁可这一帧不发，也绝不发出非法 JSON（NaN）——
            # 那种帧会让所有客户端 JSON.parse 抛错、整帧快照被静默丢掉。
            body = json.dumps(obj, separators=(',', ':'), allow_nan=False)
        except ValueError:
            log('!! 快照包含非有限数值，本帧已丢弃（请查上游计算）')
            return
        self.send_frame(frame(body.encode()))

    def ping(self):
        """WS 心跳（opcode 0x9）：浏览器/客户端在网络栈里自动回 pong。

        后台标签页的 rAF 被暂停、不再发位置上报 —— 以前这类连接 40 秒就会被
        「没有位置更新」清理掉，然后 15 秒重连一次，形成永久循环（实测 ~45 MB/小时）。
        pong 会把 last_msg 刷新掉，所以后台页能一直挂着。
        """
        self.send_frame(frame(b'', 0x9))

    def state(self):
        # 第 6 项 = 倒地标志，第 8 项 = 啄倒数（与前端 main.js 的 ps 解构一一对应）
        return [self.id, round(self.x, 2), round(self.z, 2), round(self.y, 2), round(self.yaw, 3),
                round(self.hp),
                0 if not self.dead else 1,
                int(self.score)]


# ---- WebSocket 基础 ----
def frame(payload: bytes, opcode: int = 0x1) -> bytes:
    head = bytearray([0x80 | opcode])
    n = len(payload)
    if n < 126:
        head.append(n)
    elif n < 1 << 16:
        head.append(126); head += struct.pack('>H', n)
    else:
        head.append(127); head += struct.pack('>Q', n)
    return bytes(head) + payload


async def _drain(writer):
    try:
        await writer.drain()
    except Exception:
        pass


def client_ip(headers, writer):
    """访客 IP：优先 nginx 透传的 x-real-ip / CF-Connecting-IP，否则本机对端地址。"""
    for k in ('x-real-ip', 'cf-connecting-ip', 'x-forwarded-for'):
        v = (headers or {}).get(k)
        if v:
            return v.split(',')[0].strip()
    try:
        peer = writer.get_extra_info('peername')
        return str(peer[0]) if peer else '?'
    except Exception:
        return '?'


async def read_handshake(reader, writer):
    """读并校验握手请求；通过返回 headers（键已归一为小写），失败已回错误响应并返回 None。

    ⚠ 这里**不写 101** —— 升级必须在所有准入判定（并发/每 IP 上限）之后再做，
    否则被拒的连接会先收到 101 再收到 503（客户端以为自己连上了）。
    加固（2026-09-24）：整轮握手共用一个总超时 + 请求头条数上限 + 路径白名单。
    """
    deadline = time.monotonic() + HANDSHAKE_TOTAL_TIMEOUT

    def left():
        # ⚠ 不能夹到 0.05：超时后每次 readline 再给 50ms，客户端只要每 <50ms 吐一行
        #   就永远不会超时（slowloris 白名单）。这里返回负数，wait_for 立刻中止。
        return deadline - time.monotonic()

    def fail(status, text):
        try:
            writer.write(f'HTTP/1.1 {status} {text}\r\ncontent-length: 0\r\n\r\n'.encode())
        except Exception:
            pass

    try:
        line = await asyncio.wait_for(reader.readline(), left())
    except Exception:
        return None
    if not line.startswith(b'GET '):
        fail(400, 'Bad Request')
        await _drain(writer)
        return None
    parts = line.split(b' ')
    path = parts[1].decode('latin1', 'replace') if len(parts) > 1 else ''
    if not is_ws_path(path):
        fail(404, 'Not Found')
        await _drain(writer)
        return None
    headers = {}
    total = 0
    try:
        while True:
            # 3.9 的 wait_for 对 <=0 的超时值立刻抛 TimeoutError（不会真的等）
            h = await asyncio.wait_for(reader.readline(), left())
            if h in (b'\r\n', b'\n', b''):
                break
            total += len(h)
            # 条数与总字节都要限：只限条数时，40 条各 64KiB 也能撑爆内存，
            # 而且同名头会被 dict 覆盖 → len(headers) 永远不涨（2026-11-03 修）
            if len(headers) >= HANDSHAKE_MAX_HEADERS or total > HANDSHAKE_MAX_HEADER_BYTES:
                fail(431, 'Request Header Fields Too Large')
                await _drain(writer)
                return None
            k, _, v = h.decode('latin1').partition(':')
            key = k.strip().lower()
            if key and key not in headers:
                headers[key] = v.strip()
    except Exception:
        return None
    key = headers.get('sec-websocket-key')
    if not key or 'websocket' not in headers.get('upgrade', '').lower():
        fail(400, 'Bad Request')
        await _drain(writer)
        return None
    return headers


def accept_ws(writer, headers):
    """准入通过后回 101，把这条连接升级成 WebSocket。"""
    key = headers.get('sec-websocket-key') or ''
    accept = base64.b64encode(hashlib.sha1((key + GUID).encode()).digest()).decode()
    writer.write(('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n'
                  'Connection: Upgrade\r\n'
                  f'Sec-WebSocket-Accept: {accept}\r\n\r\n').encode())


class ClientClosed(Exception):
    """对端正常关闭（收到 close 帧 / 空闲清理）：不算「连接异常」，也不写 journal。"""


async def read_frames(reader, writer):
    """产出客户端发来的文本帧（不处理分片：我们的前端只发单帧）。"""
    while True:
        b1, b2 = await reader.readexactly(2)
        op = b1 & 0x0f
        masked = b2 & 0x80
        ln = b2 & 0x7f
        if ln == 126:
            ln = struct.unpack('>H', await reader.readexactly(2))[0]
        elif ln == 127:
            ln = struct.unpack('>Q', await reader.readexactly(8))[0]
        if ln > 64 * 1024:
            # 超限：先回一个 1009（message too big）再断，别让客户端只看到 1006 猜原因
            try:
                writer.write(frame(struct.pack('>H', 1009), 0x8))
                await writer.drain()
            except Exception:
                pass
            raise ValueError('frame too large')
        mask = await reader.readexactly(4) if masked else b''
        data = await reader.readexactly(ln) if ln else b''
        if masked:
            data = bytes(c ^ mask[i & 3] for i, c in enumerate(data))
        if op == 0x8:
            # 回一个 close 帧（RFC 6455 的关闭握手；以前直接 raise，客户端只看到 1006），
            # 再交给调用方安静收尾 —— 关标签页不该在 journal 里留一条「连接异常」。
            try:
                writer.write(frame(data[:125], 0x8))
                await writer.drain()
            except Exception:
                pass
            raise ClientClosed()
        if op == 0x9:                      # ping → 回 pong
            writer.write(frame(data, 0xA))
            await writer.drain()
            continue
        if op == 0xA:                      # pong → 只用来续命（调用方把 last_msg 刷新掉）
            yield None
            continue
        if op in (0x1, 0x2, 0x0):
            yield data


class Game:
    def __init__(self, tick_hz=20, debug=False, geese=GOOSE_COUNT, dogs=DOG_COUNT):
        self.clients = {}
        self.tick = 0
        self.dt = 1.0 / tick_hz
        self._next_ping = 0.0        # 下一次给全场发 WS ping 的时间
        self.debug = debug
        # 回收过的 NPC：位置 + 血量 + 战绩 + 状态位（同 id 回来时**原地满状态回归**）
        # ⚠ 只留位置的话，任何人只要把某个 id 从名单里摘一下再塞回来，就能把那只鸡刚攒的啄倒数清零
        #   （hub 轮询抖动、节点短暂少一只也会走到这条路上）—— 2026-09-27 复查修。
        self.npc_cache = {}
        self.npc_seen = {}          # 每个 NPC id 最后一次被上报/创建的时间（名额满时按它淘汰）
        self.pending_ev = []        # 这一步产生的命中/啄倒事件，随下一次快照发出去
        # 探针鸡 / 网站鸡：也是服务端权威（名单由客户端上报，见 on_msg 的 'npcs'）
        self.probes = {}
        # NPC·大白鹅：**服务端自己放养**（源站 config.json 的 geese，默认 2，可设 0）——
        # 它不是探针数据，所以不走客户端上报名单那条路，客户端也删不掉它。
        self.geese = {}
        self.spawn_geese(int(geese))
        # 看门狗：固定 DOG_COUNT 只，守在鸡舍门口（2026-11-01 加）
        self.dogs = {}
        self.spawn_dogs(DOG_COUNT if dogs is None else int(dogs))
        self.conns = 0                # 当前连接数（含握手中/已连接），并发上限用
        self.refused = 0              # 累计被拒连接数（日志用）
        self.left_board = []          # 离场玩家的啄倒记录（啄倒榜上灰显，只留分数 > 0 的）

    def spawn_geese(self, count):
        """放养 count 只 NPC·大白鹅（源站是随机位置入栏，id 9001+，我们用自己的 id 段 g1/g2…）。"""
        for i in range(max(0, min(int(count), MAX_GEESE))):
            ang = random.random() * 6.283
            rad = 6 + random.random() * 14
            g = Goose(f'g{i + 1}', math.cos(ang) * rad, math.sin(ang) * rad)
            self.geese[g.id] = g
        if self.geese:
            log(f'已放养 {len(self.geese)} 只 {GOOSE_NAME}')

    def all_npcs(self):
        """全部服务端 NPC（探针鸡 + 网站鸡 + 大白鹅）：AI 目标池 / 软分离 / 快照都用它。

        id 段互不重叠（n… / t… / g…），直接合并即可。
        ⚠ 看门狗**不在**这里：它不是任何鸡的目标（暴躁鸡不会去欺负狗），
        快照与软分离单独把 self.dogs 加进去（见 snapshot / separate_probes）。
        """
        return {**self.probes, **self.geese}

    def spawn_dogs(self, count):
        """放养 count 只看门狗（默认 1 只，守鸡舍门口）。id 段 d1/d2…（客户端 makeNpcFor 按 'd' 建狗）。"""
        for i in range(max(0, min(int(count), MAX_DOGS))):
            d = Dog(f'd{i + 1}')
            self.dogs[d.id] = d
        if self.dogs:
            log(f'已放养 {len(self.dogs)} 只 {DOG_NAME}（守在 {DOG_HOME[0]},{DOG_HOME[1]} 一带）')

    def set_pos(self, c, x, z, y, yaw):
        """写入客户端上报的位置：夹进场地 + 限制单次位移。

        移动仍然是客户端权威的（设计如此），这里只过滤「物理上不可能」的输入：
        出界坐标、以及一次上报就跨半张地图的瞬移。正常 20Hz 上报单次位移 ~0.27m，
        阈值给到 2.0m + 8m/s×间隔 —— 网络抖动、以及被扇翅击退的 1.5m 都不会误伤。
        ⚠ 这只挡"离谱"，不解决"改前端贴脸必中"（判定用的就是客户端坐标，要根治得走服务端权威移动）。
        """
        x = max(-POS_LIMIT, min(POS_LIMIT, x))
        z = max(-POS_LIMIT, min(POS_LIMIT, z))
        y = max(Y_MIN, min(Y_MAX, y))
        t = now()
        gap = max(0.0, t - c.pos_t)
        lim = MAX_STEP + MAX_DT_FACTOR * gap
        dx, dz = x - c.x, z - c.z
        d = math.hypot(dx, dz)
        if d > lim:
            k = lim / d
            x, z = c.x + dx * k, c.z + dz * k
            c.clamped += 1
            if self.debug and c.clamped % 20 == 1:
                log(f'#{c.id} 位置被夹取：单次跳了 {d:.1f}m（上限 {lim:.1f}m，累计 {c.clamped} 次）')
        c.x, c.z, c.y, c.yaw = x, z, y, yaw
        c.pos_t = t

    def _temp_name(self, cid):
        """给刚连上、还没发 hi 的访客一个临时名字。

        ⚠ 以前这里是 None，而暴躁鸡挑人走的是 `if c.name` 过滤 → **没发 hi 的连接对暴躁鸡是透明的**，
        可以站在它旁边安心刷分（2026-09-27 复查点出来的）。
        给临时名字比“放宽追击条件”好：放宽会让刚连上还没握手的正常玩家立刻挨打（体验更差），
        而临时名字顺手修掉“无名玩家在别人的事件流里显示 None”。玩家发 hi 时用他自己的名字覆盖它。
        """
        # ⚠ 必须先 list() 再扫：连接是并发接受的，直接在 self.clients.values() 上迭代，
        #   另一个协程正好在这时插入新客户端 → RuntimeError: dictionary changed size during
        #   iteration → 那条连接当场被 reset（本机实测两个客户端同时进场时就翻过车）。
        taken = {x.name for x in list(self.clients.values())}
        for _ in range(6):
            nm = f'{random.choice(ADJ)}{random.choice(NOUN)}'
            if nm not in taken:
                return nm
        return f'访客{cid}'

    def spawn(self, c):
        """访客随机出生点（用户要求：以前是固定 6 个点循环，所有人都从同一处冒出来）。

        随机取一个离场地中心 5~18m 的点，并用碰撞解算推离障碍物（别生进鸡舍/围栏里）；
        候选里优先挑"离别人最远"的那个，免得一出生就叠在别的鸡身上。
        """
        others = [(o.x, o.z) for o in list(self.clients.values()) + list(self.all_npcs().values()) if o is not c]
        best, best_gap = None, -1.0
        for _ in range(10):
            ang = random.random() * 6.283
            rad = SPAWN_RMIN + random.random() * (SPAWN_RMAX - SPAWN_RMIN)
            x, z = resolve_circle(math.cos(ang) * rad, math.sin(ang) * rad, 0.45)
            gap = min([math.hypot(x - ox, z - oz) for ox, oz in others] or [99.0])
            if gap > best_gap:
                best, best_gap = (x, z), gap
        x, z = best or (0.0, 0.0)
        c.x, c.z, c.y, c.yaw = x, z, ground_height(x, z), random.random() * 6.28

    async def handle(self, reader, writer):
        """连接入口：先判并发上限，再交给 _serve()。

        conns 同时覆盖「握手中 + 已连接 + 正在服务」三种状态 —— 半开连接也占名额，
        否则洪水连接能在握手阶段就吃光内存与文件描述符（2026-09-24 加固）。
        """
        self.conns += 1
        try:
            await self._serve(reader, writer)
        finally:
            self.conns = max(0, self.conns - 1)

    async def _serve(self, reader, writer):
        if self.conns > MAX_CLIENTS:
            self.refused += 1
            log(f'拒绝连接：并发已达上限 {MAX_CLIENTS}（累计拒绝 {self.refused}）')
            writer.write(b'HTTP/1.1 503 Service Unavailable\r\ncontent-length: 0\r\n'
                         b'retry-after: 15\r\n\r\n')
            await _drain(writer)
            writer.close()
            return
        headers = await read_handshake(reader, writer)
        if headers is None:
            writer.close()
            return
        # 准入判定放在"回 101"之前：被拒的连接一条 101 都不该收到（否则客户端以为自己连上了）
        ip = client_ip(headers, writer)
        if sum(1 for o in self.clients.values() if o.ip == ip) >= MAX_PER_IP:
            self.refused += 1
            log(f'拒绝连接：同一 IP 并发已达 {MAX_PER_IP}（{ip}，累计拒绝 {self.refused}）')
            writer.write(b'HTTP/1.1 503 Service Unavailable\r\ncontent-length: 0\r\n'
                         b'retry-after: 15\r\n\r\n')
            await _drain(writer)
            writer.close()
            return
        accept_ws(writer, headers)
        await _drain(writer)
        c = Client(reader, writer, headers)
        c.ip = ip
        c.name = self._temp_name(c.id)      # 见 _temp_name：不给 None，否则没握手的连接免疫暴躁鸡
        self.spawn(c)
        self.clients[c.id] = c
        c.send({'t': 'welcome', 'id': c.id, 'tick': self.tick, 'ts': now(), 'cc': c.cc})
        self.roster()
        if self.debug:
            log(f'#{c.id} 进场（场上 {len(self.clients)} 只，IP={headers.get("x-real-ip") or "?"}，国旗码={c.cc or "无"}）')
        else:
            log(f'#{c.id} 进场（场上 {len(self.clients)} 只）')
        try:
            async for raw in read_frames(reader, writer):
                c.last_msg = now()
                if raw is None:             # pong：只续命，不算业务消息、也不占 60 msg/s 的额度
                    continue
                # 简易限流：每秒最多 60 条
                if now() - c.msg_window > 1:
                    c.msg_window, c.msg_count = now(), 0
                c.msg_count += 1
                if c.msg_count > 60:
                    continue
                try:
                    # parse_constant：NaN / Infinity / -Infinity 直接判为非法消息（整条丢掉）
                    m = json.loads(raw, parse_constant=_reject_nonfinite)
                except Exception:
                    continue
                self.on_msg(c, m)
        except (ClientClosed, asyncio.IncompleteReadError):
            # 对端正常关闭 / 直接断网（EOF）：浏览器关标签页会发 close 帧，断网则是 EOF。
            # 都不该在 journal 里留一条「连接异常」—— 只有真正的异常（协议错、内部错误）才记。
            pass
        except Exception as e:
            if not getattr(c, 'kicked', False):      # 自己被 _reap_idle 关掉的，不算异常
                log(f'#{c.id} 连接异常：{type(e).__name__}: {e}')
        finally:
            c.alive = False
            self.drop_client(c.id)
            try:
                writer.close()
            except Exception:
                pass
            self.roster()
            log(f'#{c.id} 离场（场上 {len(self.clients)} 只）')

    def on_msg(self, c: Client, m: dict):
        if not isinstance(m, dict):
            return          # 非对象消息（数组/字符串/数字）会让 m.get 抛异常、掐掉整条连接
        t = m.get('t')
        if self.debug and t != 'p':
            log(f'#{c.id} ← {t}')
        if t == 'hi':
            name = re.sub(r'[\x00-\x1f\x7f<>]', '', str(m.get('name') or ''))[:NAME_MAX].strip()
            c.name = name or f'{random.choice(ADJ)}{random.choice(NOUN)}'
            if 'color' in m and isinstance(m['color'], int):
                c.color = m['color'] & 0xffffff
            # 客户端自报国旗码：**只在服务端没拿到 CF-IPCountry 时**采纳（本地自测 / 直连回源访问）。
            # 它纯粹是名牌上那个小图标，不参与任何游戏判定，所以自报也无所谓。
            cc = str(m.get('cc') or '').strip().upper()
            if not c.cc and len(cc) == 2 and cc.isalpha():
                c.cc = cc
                c.send({'t': 'cc', 'cc': c.cc})
            self.roster()
        elif t == 'p':
            if c.dead:
                return
            x, z = num_or_none(m.get('x')), num_or_none(m.get('z'))
            if x is None or z is None:
                # NaN / Infinity / 非数值：整条丢掉。放进去会让快照变成非法 JSON，
                # 所有客户端 JSON.parse 抛错并静默丢掉整帧（2026-09-24 修的真洞）
                return
            y, yaw = num_or_none(m.get('y')), num_or_none(m.get('yaw'))
            self.set_pos(c, x, z, c.y if y is None else y, c.yaw if yaw is None else yaw)
            c.run = bool(m.get('r'))
            # 注意：绝不接受客户端上报的战绩（'s'）—— 啄倒榜完全由服务端裁定，
            # 否则客户端每 50ms 上报一次本地分数，会把服务端刚记的啄倒 +1 立刻抹成 0
        elif t == 'peck':
            # 啄击可以带上发起者当前位置：移动本来就是客户端权威的，这样不会因为"差一帧位置"白啄
            if not c.dead:
                x, z = num_or_none(m.get('x')), num_or_none(m.get('z'))
                yaw = num_or_none(m.get('yaw'))
                if x is not None and z is not None:
                    self.set_pos(c, x, z, c.y, c.yaw if yaw is None else yaw)
            self.peck(c)
        elif t == 'wing':
            if not c.dead:
                x, z = num_or_none(m.get('x')), num_or_none(m.get('z'))
                yaw = num_or_none(m.get('yaw'))
                if x is not None and z is not None:
                    self.set_pos(c, x, z, c.y, c.yaw if yaw is None else yaw)
            self.wing(c)
        elif t == 'npcs':
            # 客户端上报探针鸡/网站鸡名单（名称/种类），服务端据此生成或回收 NPC。
            # ⚠ 必须按客户端分别记账、取并集：两个人加载进度不同（某人少几只），
            #   若"以最后一个上报者为准"，服务器的 NPC 会来回被删又重生 —— 两边位置就对不上了
            #   （实测最大差 12.6m，表现为"看不见的鸡在打我"）。
            # 畸形类型（int / dict / 字符串）→ 整条丢掉：当成空名单会把好好的鸡一起回收，
            # 而且切片本身就会抛异常、掐掉发送方自己的连接（2026-09-27 复查）
            raw_list = m.get('list')
            if raw_list is None:
                self.set_npcs(c, [])
            elif isinstance(raw_list, list):
                self.set_npcs(c, raw_list)
            else:
                return
        elif t == 'hot':
            # 客户端上报"哪些探针鸡现在很暴躁"（CPU/内存超阈值），服务端决定谁追人（同样取并集）
            # 畸形类型（dict / int / 字符串）→ 整条丢掉：切片会抛异常掐掉发送方自己的连接（2026-09-27 复查）
            hot_raw = m.get('ids')
            if hot_raw is not None and not isinstance(hot_raw, list):
                return
            c.hot_ids = {str(x)[:32] for x in (hot_raw or [])[:MAX_HOT_IDS]}
            ids = set().union(*[cc.hot_ids for cc in self.clients.values()]) if self.clients else set()
            for pid, p in self.probes.items():
                p.hot = pid in ids
        elif t == 'flap':
            # 这个分支原来会给全场广播一份完整快照。前端只**消费** ev.e==='flap'，
            # 全仓库没有任何地方发 t:'flap' —— 纯攻击面（一条消息 = 一次全场广播，
            # 60 连接 × 60 条/秒 ≈ 3600 次/秒、出口 ~20MB/s），2026-11-03 删除。
            # 扇翅动画走 hit.k==='wing' 或下一帧快照即可。
            return

    # ---- 探针鸡 / 网站鸡名单（客户端播报，服务端据此生成/回收 NPC）----
    def set_npcs(self, c, lst):
        # 类型先过滤：list 位置若来个 int / dict / 字符串，切片就抛异常（掐掉发送方自己的连接）
        if not isinstance(lst, list):
            lst = []
        seen = {}
        junk = 0
        for it in lst[:MAX_NPC_PER_CLIENT]:          # 条数上限：一条消息不能塞出任意多 NPC
            if not isinstance(it, dict):
                continue
            pid = re.sub(r'[^\w.-]', '', str(it.get('id') or ''))[:16]
            if not pid:
                continue
            # 客户端 id 不能冒用服务端自己的编号：d<n> 是看门狗、g<n> 是大白鹅。撞车会让快照里
            # 同一个 id 出现两次（狗在两个位置之间抖），或者留下一只不可见、仍被模拟的幽灵鸡。
            if re.match(r'^[dg]\d+$', pid):
                continue
            if not REAL_NPC_ID.match(pid):
                # 非真实形态的 id（zz00 之类）：单连接最多 8 个。以前一条消息能塞 64 个，
                # 把全服名额一次性占满，所有人的探针鸡/网站鸡都不再生成（2026-11-03 修）。
                if junk >= MAX_NPC_JUNK_PER_CLIENT:
                    continue
                junk += 1
            name = re.sub(r'[\x00-\x1f\x7f<>]', '', str(it.get('name') or ''))[:NPC_NAME_MAX] or pid
            kind = 'web' if it.get('kind') == 'web' else 'probe'
            # cpu → 体型倍率（1.0 ~ 1.35，原站同款）：名牌上的数字仍由各客户端自己取，这里只算体型
            cpu = num_or_none(it.get('cpu')) or 0.0
            scale = 1.0 + max(0.0, min(100.0, cpu)) / 100.0 * (CPU_SCALE_MAX - 1.0)
            seen[pid] = (name, kind, round(min(CPU_SCALE_MAX, max(1.0, scale)), 3))
        c.npc_roster = seen                       # 这个客户端要哪些
        self.sync_npcs()

    def drop_client(self, cid):
        """某人离场：清掉他的名单/暴躁名单，再按剩下的人重算 NPC 集合。

        战绩不跟着人走：分数 > 0 的记进 left_board（榜上灰显），否则一断线榜上就空了。
        """
        c = self.clients.pop(cid, None)
        if c is not None:
            c.npc_roster = {}
            c.hot_ids = set()
            if c.score > 0:
                # ⚠ 同名只留一条（保留最高分）：同一只鸡反复进出、或两个匿名访客撞名时，
                #   榜上会出现同名两行（用户看到的“离场榜同名重复且没有过期”）
                nm = c.name or f'鸡友{c.id}'
                old = max([r['score'] for r in self.left_board if r['name'] == nm and r['id'] != c.id],
                          default=0)
                self.left_board = [r for r in self.left_board
                                   if r['id'] != c.id and r['name'] != nm]
                self.left_board.append({'id': c.id, 'name': nm, 'score': max(c.score, old)})
                self.left_board.sort(key=lambda r: -r['score'])
                del self.left_board[LEFT_BOARD_MAX:]      # 只留前几名，防止无限增长
        self.sync_npcs()
        ids = set().union(*[cc.hot_ids for cc in self.clients.values()]) if self.clients else set()
        for pid, p in self.probes.items():
            p.hot = pid in ids

    def _cache_npc(self, pid, p):
        """回收一只 NPC：位置/血量/战绩/倒地剩余时间一起记住（同 id 回来原样恢复）。"""
        self.npc_cache[pid] = {'x': p.x, 'z': p.z, 'hp': p.hp, 'score': p.score, 'st': p.st,
                               'ko': max(0.0, p.ko_until - now())}
        # 缓存也要封顶：名单由客户端上报，不设顶就是一条无上限的内存增长路径
        # （dict 保序，多出来的都是最早的 → 删最前面几个）
        while len(self.npc_cache) > NPC_CACHE_MAX:
            self.npc_cache.pop(next(iter(self.npc_cache)))

    def sync_npcs(self):
        """按所有连接上报名单的并集维护 NPC：新 id 生成，没人要的才回收（位置记进 npc_cache）。

        ⚠ 名额不能「先到先得」：名单由客户端上报，任何人发一条 64 个假 id 的消息就能把全服
        预算占满，让所有人的真探针鸡/网站鸡消失（2026-11-03 修）。现在的规则：
          1. 真实形态（n<数字>/t<数字>）先建；非真实形态的 id 单连接最多 8 个（见 set_npcs）；
          2. 名额满时，真实 id 可以挤掉一只非真实 id 的 NPC；
          3. 其余情况按「被几个客户端上报」（票数）淘汰，票数相同再看最久没被上报的。
        """
        want, votes = {}, {}
        for cc in self.clients.values():
            for pid, meta in (getattr(cc, 'npc_roster', None) or {}).items():
                want.setdefault(pid, meta)
                votes[pid] = votes.get(pid, 0) + 1
        t = now()
        order = sorted(want.items(), key=lambda kv: 0 if REAL_NPC_ID.match(kv[0]) else 1)
        for pid, (name, kind, scale) in order:
            p = self.probes.get(pid)
            if p:
                p.name, p.kind, p.scale = name, kind, scale
                self.npc_seen[pid] = t
                continue
            if len(self.probes) >= MAX_NPCS:
                victim = None
                if REAL_NPC_ID.match(pid):
                    cand = min(((votes.get(k, 0), self.npc_seen.get(k, 0), k)
                                for k in self.probes if not REAL_NPC_ID.match(k)), default=None)
                    victim = cand[2] if cand else None
                if victim is None:
                    continue          # 全服 NPC 总数上限：超了不再建新的（防一条消息塞一万只）
                self._cache_npc(victim, self.probes.pop(victim))
            cached = self.npc_cache.get(pid)
            if cached:
                x, z = cached['x'], cached['z']
                x, z = resolve_circle(x, z, PROBE_R)      # 可能被谁挤开了，推一下
            else:
                ang = random.random() * 6.283
                rad = 4 + random.random() * 16
                x, z = resolve_circle(math.cos(ang) * rad, math.sin(ang) * rad, PROBE_R)
            p = Probe(pid, name, kind, x, z, scale)
            if cached:
                p.hp = cached['hp']            # 名单抖动不该把它的血量和战绩一起洗掉
                p.score = cached['score']
                p.st = cached.get('st', 0)
                # 倒地剩余时间也要恢复：只恢复 hp=0 却不恢复 ko_until，新建的鸡会立刻被
                # 「hp<=0 且没在倒地」的复活逻辑满血重生 + 随机瞬移（倒地规则被客户端取消）
                p.ko_until = t + cached.get('ko', 0.0)
            self.probes[pid] = p
            self.npc_seen[pid] = t
        for pid in list(self.probes):
            if pid not in want:
                p = self.probes.pop(pid, None)
                if p:
                    self._cache_npc(pid, p)
                    self.npc_seen.pop(pid, None)
        # 位置缓存不再用到的旧格式（元组）就地清掉，免得 get 拿到元组报错
        for k in [k for k, v in self.npc_cache.items() if not isinstance(v, dict)]:
            self.npc_cache.pop(k, None)

    # ---- 命中结算：玩家之间、玩家与探针鸡共用同一套 ----
    def _targets(self, skip_id=None):
        for o in list(self.clients.values()) + list(self.all_npcs().values()):
            if o.id != skip_id:
                yield o

    @staticmethod
    def _credit(attacker):
        """给"补上最后一击"的那个实体记一次啄倒 —— 啄倒榜的唯一记功点。

        玩家与探针鸡/网站鸡共用：玩家啄倒别的玩家/鸡、暴躁鸡啄倒玩家或欺负别的鸡，
        全都走这里 +1。客户端只负责展示，自己上报的任何战绩都无效。
        """
        if attacker is not None:
            attacker.score = getattr(attacker, 'score', 0) + 1

    def _apply_hit(self, attacker, victim, dmg, ev):
        """扣血 + 事件 + 记一次啄倒。"""
        ko = victim.take_hit(dmg, by=attacker)
        ev.append({'e': 'hit', 't': victim.id, 'hp': round(victim.hp), 'fn': attacker.name})
        # 探针鸡/网站鸡被啄之后的反应（回击 / 逃窜）也随快照下发：客户端据此播个尘土/羽毛 + 名牌小标
        if isinstance(victim, Probe) and not ko and victim.react_mode:
            ev.append({'e': 'react', 't': victim.id, 'k': victim.react_mode, 'fn': victim.name})
        if ko:
            self._credit(attacker)
            ev.append({'e': 'ko', 'f': attacker.id, 'to': victim.id, 'fn': attacker.name, 'on': victim.name})
        return ko

    def snapshot(self, ev=None):
        """一帧快照：玩家 + 探针鸡/网站鸡/大白鹅 + 事件。pending_ev 只随一帧发出去。"""
        events = (ev or []) + self.pending_ev
        self.pending_ev = []
        return {'t': 's', 'ts': now(),
                'ps': [c.state() for c in self.clients.values()],
                'ns': [p.state() for p in list(self.all_npcs().values()) + list(self.dogs.values())],
                'ev': events}


    def _probe_attack(self, c, probe, wing=False):
        """暴躁探针鸡/网站鸡打玩家：扣血 + 给对方事件（啄倒记在这一鸡头上）。

        wing=True 是"扇翅"：伤害 8（与玩家扇翅同款）+ 把玩家推开 1.5m。
        ⚠ 玩家的位置是**客户端权威**，服务端改它的坐标会被它自己 20Hz 的位置上报立刻覆盖
        （只抖一帧）—— 所以击退随事件下发（kx/kz），由客户端自己执行。
        """
        if c.dead:
            return
        dmg = PROBE_WING_DMG if wing else PROBE_HOT_DMG
        ko = c.take_hit(dmg)
        ev = {'e': 'hit', 't': c.id, 'hp': round(c.hp), 'fn': probe.name,
              'f': probe.id, 'k': 'wing' if wing else 'peck'}
        if wing:
            dx, dz = c.x - probe.x, c.z - probe.z          # 从鸡指向玩家：往外推
            d = math.hypot(dx, dz) or 1.0
            ev['kx'], ev['kz'] = (dx / d) * PROBE_WING_KNOCK, (dz / d) * PROBE_WING_KNOCK
        self.pending_ev.append(ev)
        if ko:
            self._credit(probe)
            self.pending_ev.append({'e': 'ko', 'f': probe.id, 'to': c.id, 'fn': probe.name, 'on': c.name})
        if self.debug:
            log(f'{probe.name} {"扇" if wing else "啄"} #{c.id}（{c.name}）：hp={c.hp:.0f}{" 啄倒" if ko else ""}')

    def _goose_attack(self, c, goose):
        """NPC·大白鹅啄玩家：6 伤害（探针鸡是 9）+ 把玩家顶开一步。

        击退同样只能下发位移指令（玩家的位置是客户端权威），走 hit 事件的 kx/kz；
        客户端那边 `ev.t === 自己 && ev.kx` 那条分支会自己执行位移。
        """
        if c.dead:
            return
        ko = c.take_hit(GOOSE_DMG)
        dx, dz = c.x - goose.x, c.z - goose.z
        d = math.hypot(dx, dz) or 1.0
        self.pending_ev.append({'e': 'hit', 't': c.id, 'hp': round(c.hp), 'fn': goose.name,
                                'f': goose.id, 'k': 'peck',
                                'kx': (dx / d) * GOOSE_KNOCK, 'kz': (dz / d) * GOOSE_KNOCK})
        if ko:
            self._credit(goose)
            self.pending_ev.append({'e': 'ko', 'f': goose.id, 'to': c.id,
                                    'fn': goose.name, 'on': c.name})
        if self.debug:
            log(f'{goose.name} 啄 #{c.id}（{c.name}）：hp={c.hp:.0f}{" 啄倒" if ko else ""}')

    def _npc_attack(self, victim, attacker, wing=False, dmg=None):
        """暴躁鸡欺负别的鸡（看门狗咬鸡/鹅也走这里）：扣血 + 事件（啄倒记在动手那只头上）。

        wing=True 是"扇翅"：伤害 8，并把对方推开 1.5m（鸡是服务端权威，可以直接改坐标）。
        dmg 显式传入时用它（看门狗用 DOG_DMG）。
        """
        if victim.dead:
            return
        dmg = dmg if dmg is not None else (PROBE_WING_DMG if wing else PROBE_HOT_DMG)
        ko = victim.take_hit(dmg, by=attacker)
        if wing:
            dx, dz = victim.x - attacker.x, victim.z - attacker.z
            d = math.hypot(dx, dz) or 1.0
            victim.x, victim.z = resolve_circle(victim.x + (dx / d) * PROBE_WING_KNOCK,
                                               victim.z + (dz / d) * PROBE_WING_KNOCK, PROBE_R)
            victim.y = ground_height(victim.x, victim.z)
        self.pending_ev.append({'e': 'hit', 't': victim.id, 'hp': round(victim.hp),
                                'fn': attacker.name, 'f': attacker.id,
                                'k': 'wing' if wing else 'peck'})
        if ko:
            self._credit(attacker)
            ev = {'e': 'ko', 'f': attacker.id, 'to': victim.id,
                  'fn': attacker.name, 'on': victim.name}
            if getattr(attacker, 'kind', '') == 'dog':
                ev['drive'] = True          # 看门狗把目标赶跑/咬倒 → 客户端显示「驱逐了」
            self.pending_ev.append(ev)
        if self.debug:
            log(f'{attacker.name} 欺负 {victim.name}：hp={victim.hp:.0f}{" 放倒" if ko else ""}')

    def separate_probes(self):
        """NPC 之间的软分离（探针鸡 / 网站鸡 / 大白鹅）：重叠时按比例互推一点点。

        ⚠ 必须用"软推"而不是硬把位置掰开：硬推会让两只鸡在同一个目标点上互相顶住、谁也走不了
        （用户实测："两只暴躁鸡重叠之后卡在一起了"）。原站在主循环里对所有存活实体做同一件事
        （`game.js` 的 separation 冲量），我们以前完全没有这一步。
        玩家一侧由客户端自己分离（玩家位置是客户端权威），这里只算 NPC 之间。
        """
        alive = [p for p in list(self.all_npcs().values()) + list(self.dogs.values()) if not p.dead]
        for i in range(len(alive)):
            a = alive[i]
            for j in range(i + 1, len(alive)):
                b = alive[j]
                dx, dz = b.x - a.x, b.z - a.z
                d = math.hypot(dx, dz)
                if d >= SEP_MIN:
                    continue
                if d < 1e-6:
                    ang = random.random() * 6.283
                    dx, dz, d = math.cos(ang), math.sin(ang), 1.0
                k = min(SEP_MAX, (SEP_MIN - d) * SEP_RATE * 0.5)
                nx, nz = dx / d, dz / d
                a.x, a.z = resolve_circle(a.x - nx * k, a.z - nz * k, PROBE_R)
                b.x, b.z = resolve_circle(b.x + nx * k, b.z + nz * k, PROBE_R)
                a.y = ground_height(a.x, a.z)
                b.y = ground_height(b.x, b.z)

    def peck(self, c: Client):
        if c.dead or now() < c.peck_ready:
            if self.debug:
                log(f'#{c.id} 啄击被忽略（dead={c.dead} 冷却={max(0, c.peck_ready - now()):.2f}s）')
            return
        c.peck_ready = now() + PECK_CD
        fx, fz = math.sin(c.yaw), math.cos(c.yaw)
        for o in self._targets(skip_id=c.id):
            if o.dead:
                continue
            dx, dz = o.x - c.x, o.z - c.z
            d = (dx * dx + dz * dz) ** 0.5
            dot = ((dx / d) * fx + (dz / d) * fz) if d > 1e-6 else 1.0
            if self.debug:
                log(f'#{c.id} 啄 → {o.id}：距离 {d:.2f}m 点积 {dot:.2f}（要 ≤{PECK_RANGE} 且 ≥{PECK_DOT}）')
            if d > PECK_RANGE or d < 1e-6 or dot < PECK_DOT:
                continue
            ev = [{'e': 'peck', 'f': c.id}]
            self._apply_hit(c, o, PECK_DMG, ev)
            self.broadcast(self.snapshot(ev))
            break

    def wing(self, c: Client):
        """扇翅：无方向限制、范围更短、伤害更低，但把人推开更远。"""
        if c.dead or now() < c.wing_ready:
            return
        c.wing_ready = now() + WING_CD
        for o in self._targets(skip_id=c.id):
            if o.dead:
                continue
            dx, dz = o.x - c.x, o.z - c.z
            d = (dx * dx + dz * dz) ** 0.5
            if d > WING_RANGE or d < 1e-6:
                continue
            ev = [{'e': 'wing', 'f': c.id}]
            self._apply_hit(c, o, WING_DMG, ev)
            # 击退：鸡/鹅是服务端权威 → 直接改坐标；玩家是客户端权威 → 下发指令让它自己执行
            # （以前对玩家也直接改坐标，会被它自己 20Hz 的位置上报立刻覆盖，等于没击退）
            # ⚠ 鹅也必须走直接改坐标：它走 else 分支时，knock 事件只对玩家生效
            #   （前端只处理 ev.t === net.id），结果是「扇翅对鹅只扣血、不击退」。
            if isinstance(o, (Probe, Goose)):
                o.x, o.z = resolve_circle(o.x + (dx / d) * WING_KNOCK,
                                          o.z + (dz / d) * WING_KNOCK, PROBE_R)
                o.y = ground_height(o.x, o.z)
            else:
                self.pending_ev.append({'e': 'knock', 't': o.id, 'fn': c.name,
                                        'kx': (dx / d) * WING_KNOCK, 'kz': (dz / d) * WING_KNOCK})
            self.broadcast(self.snapshot(ev))
            break

    def roster(self):
        # left：离场玩家的啄倒记录（榜上灰显）；在场上的人以实时快照为准，客户端自己过滤
        msg = {'t': 'roster',
               'list': [c.roster() for c in self.clients.values()],
               'left': list(self.left_board)}
        self.broadcast(msg)

    def broadcast(self, msg, skip=None):
        """广播同一份对象：只序列化一次（60 个客户端时省 59 次 json.dumps）。"""
        if not self.clients:
            return
        try:
            body = json.dumps(msg, separators=(',', ':'), allow_nan=False)
        except ValueError:
            log('!! 快照包含非有限数值，本帧已丢弃（请查上游计算）')
            return
        data = frame(body.encode())
        for c in list(self.clients.values()):
            if skip is not None and c.id == skip:
                continue
            c.send_frame(data)

    def _reap_idle(self):
        """清掉超过 IDLE_TIMEOUT 没有任何入站消息（位置 / pong）的连接。

        ⚠ 以前只看位置上报，后台标签页 rAF 暂停后 40 秒必被踢、15 秒后又重连，
        一个挂着的后台页 ≈ 45 MB/小时。现在服务端每 10 秒发 ping，浏览器自动回 pong
        （pong 也刷新 last_msg），这条清理才真正等于「连接已经死了」。
        """
        for c in list(self.clients.values()):
            if now() - c.last_msg > IDLE_TIMEOUT:
                c.alive = False
                c.kicked = True             # 服务端主动踢的：_serve 别把它记成「连接异常」
                self.drop_client(c.id)
                try:
                    c.writer.close()
                except Exception:
                    pass

    async def loop(self):
        while True:
            t0 = now()
            self.tick += 1
            # 复活
            for c in self.clients.values():
                if c.hp <= 0 and not c.dead:
                    c.hp = 100.0
                    self.spawn(c)
                    c.send({'t': 'respawn', 'x': c.x, 'z': c.z})
                elif c.hp < 100.0 and not c.dead and now() - c.last_hit > PROBE_REGEN_DELAY:
                    # 回血：玩家也是一样 —— 一段时间没挨打就慢慢回上去
                    c.hp = min(100.0, c.hp + PLAYER_REGEN_RATE * self.dt)
            # WS 心跳：每 10 秒 ping 一次。后台标签页的 rAF 被暂停、不再发位置上报，
            # 但浏览器/客户端会在网络栈里自动回 pong（read_frames 把 pong 也刷新 last_msg），
            # 所以它们不再被 40 秒清理误杀、也不会 15 秒重连一次。
            if now() >= self._next_ping:
                self._next_ping = now() + WS_PING_EVERY
                for c in list(self.clients.values()):
                    c.ping()
            # 掉线清理：IDLE_TIMEOUT 秒没有任何入站消息（位置 / pong）
            self._reap_idle()
            if self.clients:
                # 探针鸡/网站鸡：服务端演算（闲逛 / 暴躁追人 / 啄击）
                # ⚠ 这里的 `if c.name` 是**兜底**：连上时就会给临时名字（_temp_name），
                #   所以正常情况下没有哪条连接是匿名的 —— 以前留 None 会让“不发 hi”的连接
                #   对暴躁鸡透明（可以站它旁边刷分），别再把 None 当成“还没进门”的状态用。
                players = [(c, c.x, c.z) for c in self.clients.values() if c.name]
                pool = self.all_npcs()          # 暴躁鸡挑目标/记仇时也要能看见大白鹅
                for p in self.probes.values():
                    p.step(self.dt, players, self._probe_attack, pool, self._npc_attack)
                    if p.hp <= 0 and not p.dead:
                        p.revive()
                # 大白鹅：领地意识（追玩家；★ 2026-11-01 起挨打不再逃跑），与探针鸡共用同一套世界与软分离
                for g in self.geese.values():
                    g.step(self.dt, players, self._goose_attack)
                    if g.hp <= 0 and not g.dead:
                        g.revive()
                # 看门狗：只咬「暴躁鸡」和「大白鹅」
                for d in self.dogs.values():
                    d.step(self.dt, self.probes, self.geese, self._npc_attack)
                self.separate_probes()          # NPC 之间软分离：别再叠在一起卡住
                self.broadcast(self.snapshot())
            await asyncio.sleep(max(0.0, self.dt - (now() - t0)))


def log(msg):
    print(f'[farm] {time.strftime("%H:%M:%S")} {msg}', flush=True)


def read_dogs_count(arg=None):
    """看门狗数量：命令行 --dogs > 脚本同目录的 dogs 文件 > 默认 1。

    ★ 自测（server/test_server.py 的黑盒部分）会把狗关掉（--dogs 0）：它有自己的一套
      "暴躁鸡不逃/软分离"黑盒断言，狗在旁边咬鸡会把这些用例搅红；狗的行为由白盒用例覆盖。
    """
    if arg is not None:
        return max(0, int(arg))
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'dogs')
    try:
        with open(path, 'r', encoding='utf-8') as f:
            return max(0, int(f.read().strip()))
    except Exception:
        return DOG_COUNT


def read_geese_count(arg=None):
    """大白鹅数量：命令行 --geese > 脚本同目录的 geese 文件 > 默认 2（源站 config.json 的默认值）。

    geese 文件是给安装/运维用的（一键包的 --geese N 写它；重跑部署不会覆盖已有的值）——
    与站点名字走 .site-name 是同一个套路：服务端不读配置中心，就地读一个小文件。
    """
    if arg is not None:
        return max(0, int(arg))
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'geese')
    try:
        with open(path, 'r', encoding='utf-8') as f:
            return max(0, int(f.read().strip()))
    except Exception:
        return GOOSE_COUNT


async def main(args):
    geese = read_geese_count(args.geese)
    dogs = read_dogs_count(getattr(args, 'dogs', None))
    game = Game(tick_hz=args.tick, debug=args.debug, geese=geese, dogs=dogs)
    server = await asyncio.start_server(game.handle, args.host, args.port, backlog=64)
    log(f'监听 ws://{args.host}:{args.port}  （{args.tick}Hz，{GOOSE_NAME} {len(game.geese)} 只 · '
        f'{DOG_NAME} {len(game.dogs)} 只）')
    asyncio.create_task(game.loop())
    loop = asyncio.get_running_loop()
    stop = loop.create_future()

    def _bye():
        if not stop.done():
            stop.set_result(True)

    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, _bye)
        except (NotImplementedError, RuntimeError):
            pass
    async with server:
        await stop
    log('退出')


if __name__ == '__main__':
    p = argparse.ArgumentParser()
    p.add_argument('--host', default='127.0.0.1')
    p.add_argument('--port', type=int, default=28910)
    p.add_argument('--tick', type=int, default=20)
    p.add_argument('--geese', type=int, default=None,
                   help='NPC·大白鹅数量（默认读脚本同目录的 geese 文件，没有则 2；0 = 不放养）')
    p.add_argument('--dogs', type=int, default=None,
                   help='看门狗数量（默认读脚本同目录的 dogs 文件，没有则 1；0 = 不放养）')
    p.add_argument('--debug', action='store_true', help='打印每次啄击的距离/朝向判定')
    a = p.parse_args()
    try:
        asyncio.run(main(a))
    except KeyboardInterrupt:
        sys.exit(0)
