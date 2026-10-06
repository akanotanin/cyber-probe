#!/usr/bin/env bash
# cyber-probe 全量自检（P1-7）：把散在各处的断言串成一条命令，本地改完跑它就行。
#
#   bash tools/ci.sh                 服务端协议自测 + JS/静态检查（约 5 分钟）
#   bash tools/ci.sh --fast          只跑静态/工具门禁（1~3 步，秒级；改工具链时用它，或做变异测试）
#   bash tools/ci.sh --with-browser  额外跑 headless 浏览器断言（要 node + Chrome，很吃资源）
#
# 退出码 0 = 全绿；非 0 = 有失败（会指出是哪一步）。
set -uo pipefail
cd "$(dirname "$0")/.."

# 站长的 tools/common.sh（不进公开库）里有机器别名/域名等本地设定；没有就用中性默认值。
if [ -f tools/common.sh ]; then
  # shellcheck disable=SC1091
  . tools/common.sh
else
  PY="${PY:-python3}"
  say() { printf '%s\n' "$*"; }
fi

WITH_BROWSER=0
FAST=0
for a in "$@"; do
  [ "$a" = "--with-browser" ] && WITH_BROWSER=1
  [ "$a" = "--fast" ] && FAST=1
done

# 临时文件统一放仓库里的 build/ci（.gitignore 里有 build/）。
# ⚠ 路径要给**原生**程序（python/node）一个 Windows 风格的绝对路径：MSYS 的 /tmp、/c/... 到它们眼里
#   会变成 \tmp\...、\c\... 而找不到 —— `pwd -W` 在 MSYS 下给 C:/...，在 Linux 上回退到 `pwd`。
mkdir -p build/ci
CIT="$(pwd -W 2>/dev/null || pwd)/build/ci"

FAILED=()
step() { say ""; say "──────── $* ────────"; }
ok()   { say "✓ $*"; }
bad()  { say "✗ $*"; FAILED+=("$*"); }

# ── 1) python 语法与符号点名（防"删一个类顺手删掉另一个"）───────────────────
step "1/5 Python 语法 + 关键符号点名"
if $PY - <<'EOF'
import ast, sys
src = open('server/farm_server.py', encoding='utf-8').read()
tree = ast.parse(src)
ast.parse(open('server/test_server.py', encoding='utf-8').read())
names = {n.name for n in ast.walk(tree)
         if isinstance(n, (ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef))}   # ⚠ async 函数走 AsyncFunctionDef，漏了会假报「缺少符号」
need = {'Probe', 'Game', 'Client', 'separate_probes', '_npc_attack', '_probe_attack',
        'read_handshake', 'accept_ws', 'set_npcs', 'sync_npcs', 'num_or_none'}
missing = sorted(need - names)
if missing:
    print('缺少符号：', missing)
    sys.exit(1)
print('OK')
EOF
then ok "两个 .py 语法 OK、关键符号齐全"; else bad "Python 语法/符号检查"; fi

# ── 2) JS 模块能否被解析（模块级重复 const 会让整页静默失效）─────────────────
step "2/5 JS 模块解析 + 记分口径"
JSERR=$(node --experimental-vm-modules -e "
const fs=require('fs'),vm=require('vm');
let bad=0;
for (const f of fs.readdirSync('js')) if (f.endsWith('.js')) {
  try { new vm.SourceTextModule(fs.readFileSync('js/'+f,'utf8')); }
  catch (e) { console.log('ERR '+f+' '+e.message); bad=1; }
}
process.exit(bad);
" 2>&1)
if [ -z "$JSERR" ]; then ok "js/*.js 全部可解析"; else bad "JS 解析：$JSERR"; fi

# 自测工具自己也要能解析：cdp_*.mjs 里塞着大段模板字符串（evalJS 的载荷），
# 注释里手滑写一个反引号就会提前结束模板串 → 整份文件语法错（真踩过）。node --check 一秒就查出来。
MJSERR=""
for f in tools/*.mjs; do
  [ -f "$f" ] || continue
  if ! node --check "$f" >/dev/null 2>&1; then
    MJSERR="$MJSERR $f"
    node --check "$f" 2>&1 | sed -n '2,3p' | sed 's/^/      /'
  fi
done
if [ -z "$MJSERR" ]; then ok "tools/*.mjs 全部可解析（含模板串里的反引号那种坑）"; else bad "自测脚本语法错：$MJSERR"; fi

# 啄倒榜（2026-09-27 加回，★分数现在是有的）：记分只能由服务端裁定，回退了就红
if grep -q "_credit" server/farm_server.py && grep -q "left_board" server/farm_server.py; then
  ok "服务端有 _credit 记功点 + left_board 离场存档"
else
  bad "服务端缺 _credit / left_board（啄倒榜被回退了？）"
fi
if grep -q "score" js/hud.js && grep -q "score" js/main.js; then
  ok "前端在渲染啄倒数（hud.js / main.js 里有 score）"
else
  bad "前端 hud.js/main.js 里没有 score（啄倒榜被回退了？）"
fi
# 客户端不许上报战绩（服务端会忽略，但留着就是骗人的 —— 历史上它把服务端刚记的 +1 抹成 0）
if grep -n "t: 'p'" js/main.js | grep -q "s:"; then
  bad "客户端又在 {t:'p'} 里带 s 上报战绩"
else
  ok "客户端不上报战绩（分数只认服务端 ps[7]）"
fi

# NPC·大白鹅：客户端只在"详情卡片的说明文字"里用这组数值，判定全在服务端 ——
# 两边一旦漂移，卡片就会骗人。所以逐个点名核对（数字按数值比：60 与 60.0 算一致）。
GOOSEOUT="$($PY - <<'PYEOF'
import re
js = open('js/goose.js', encoding='utf-8').read()
sv = open('server/farm_server.py', encoding='utf-8').read()
pairs = [('maxHp', 'GOOSE_HP'), ('chaseR', 'GOOSE_CHASE_R'), ('leash', 'GOOSE_LEASH'),
         ('peckR', 'GOOSE_PECK_R'), ('dmg', 'GOOSE_DMG'), ('cd', 'GOOSE_CD'), ('fleeT', 'GOOSE_FLEE_T')]
bad = []
for k, const in pairs:
    m = re.search(r'^\s*%s:\s*([0-9.]+)' % k, js, re.M)          # js/goose.js 的 GOOSE.<k>
    s = re.search(r'^%s\s*=\s*([0-9.]+)' % const, sv, re.M)   # server 的常量（必须是字面量）
    if not m or not s or float(m.group(1)) != float(s.group(1)):
        bad.append('%s(%s/%s)' % (k, m and m.group(1), s and s.group(1)))
if 'NPC·大白鹅' not in js or 'NPC·大白鹅' not in sv:
    bad.append('名字不见了')
print(' '.join(bad))
PYEOF
)"
if [ -z "$GOOSEOUT" ]; then
  ok "大白鹅的数值前后端一致（js/goose.js 的 GOOSE 与 server 的 GOOSE_* 逐个核对）"
else
  bad "大白鹅数值前后端不一致：$GOOSEOUT"
fi
# 大白鹅必须由服务端自己放养：客户端的上报名单里不许出现它
# （塞进去就变成"客户端能增删 NPC"；这里只查 sendNpcRoster 的函数体，别误伤渲染层的 kind 判断）
if awk '/^function sendNpcRoster/,/^}/' js/main.js | grep -q "goose"; then
  bad "客户端在上报名单（sendNpcRoster）里带了 goose"
else
  ok "客户端不把大白鹅上报名单（服务端自己放养，客户端只渲染）"
fi

# ── 3) 静态站素材齐不齐（免得部署出一个缺 js 的站）────────────────────────
step "3/5 静态素材 + 反代补丁器自测"
MISS=0
for f in index.html style.css favicon.svg apple-touch-icon.png js/main.js js/net.js js/npc.js js/goose.js js/config.js vendor/three.module.js; do
  [ -f "$f" ] || { bad "缺少 $f" ; MISS=1; }
done
[ "$MISS" = 0 ] && ok "index.html / style.css / js/* / vendor 都在"
[ -f js/config.js ] || say "  （提示：js/config.js 由 $PY tools/gen_config.py 生成，deploy.sh 会自动重跑）"

# 站点图标：hub 1.4.0 起第三方前端要自带一张 180×180、**不透明**的 apple-touch-icon.png
# （iOS「加到主屏幕」用它；带 alpha 的图在 iOS 上会被垫成黑底）。这里静态判，不用开浏览器。
ICONOUT="$($PY - <<'PYEOF'
import struct
raw = open('apple-touch-icon.png', 'rb').read()
if raw[:8] != b'\x89PNG\r\n\x1a\n':
    print('apple-touch-icon.png 不是 PNG')
else:
    w, h = struct.unpack('>II', raw[16:24])
    ct = raw[25]                      # 0 灰度 / 2 RGB / 3 索引 / 4 灰度+A / 6 RGBA
    if (w, h) != (180, 180):
        print('apple-touch-icon.png 尺寸是 %dx%d，应为 180x180' % (w, h))
    elif ct in (4, 6):
        print('apple-touch-icon.png 带 alpha 通道（颜色类型 %d）—— iOS 主屏幕要求不透明' % ct)
    else:
        print('OK %dx%d 颜色类型 %d（无 alpha）' % (w, h, ct))
PYEOF
)"
case "$ICONOUT" in
  OK*) ok "站点图标：apple-touch-icon.png $ICONOUT" ;;
  *)   bad "站点图标检查：$ICONOUT" ;;
esac
if grep -q 'href="\./favicon\.svg"' index.html && grep -q 'href="\./apple-touch-icon\.png"' index.html; then
  ok "index.html 引了 favicon.svg + apple-touch-icon.png（cachebust 会给它们打版本号）"
else
  bad "index.html 没有引站点图标（favicon.svg / apple-touch-icon.png）"
fi
if grep -q 'svg|png' tools/cachebust.py && grep -q 'js|css|svg|png' tools/cachebust.py; then
  ok "cachebust 会给站点图标打 ?v=（稳定文件名在 CF 后最久 4 小时不更新）"
else
  bad "cachebust 没管 .svg/.png（图标改了用户看不到）"
fi

# 反代补丁器的四条核心承诺（不需要目标机真装 nginx/caddy：自检命令用 `--validate` 换成 true/false）：
#   补得上 / 幂等 / 自检失败逐字节回滚 / 自检命令被传成端口号时当场报错（caddy 路径曾因此静默回滚）
mkdir -p build/ci; PT="$CIT/patchtest"; rm -rf "$PT"; mkdir -p "$PT/conf.d"
printf 'x.example {\n\treverse_proxy 127.0.0.1:28080\n}\n' > "$PT/Caddyfile"
printf 'server {\n    listen 8080;\n    location / {\n        proxy_pass http://127.0.0.1:28080;\n    }\n}\n' > "$PT/site.conf"
for PTEST in caddy nginx; do
  if [ "$PTEST" = caddy ]; then
    TCONF="$PT/Caddyfile"; TORIG="$PT/Caddyfile.orig"
    TARGS=(--conf "$TCONF" --snippet "$PT/conf.d/cyber-probe.caddy" --domain x.example --hub-port 28080 --ws-port 28910 --webroot /var/www/cyber-probe --no-reload)
    TOOL=tools/caddy_patch.py; EXPECT_MARK="import "
  else
    TCONF="$PT/site.conf"; TORIG="$PT/site.conf.orig"
    TARGS=(--conf "$TCONF" --hub-port 28080 --ws-port 28910 --webroot /var/www/cyber-probe --no-reload)
    TOOL=tools/nginx_patch.py; EXPECT_MARK="chicken/ws"
  fi
  cp "$TCONF" "$TORIG"
  rm -f "$PT/conf.d/cyber-probe.caddy"
  A="$($PY "$TOOL" --local "${TARGS[@]}" --validate true 2>&1)"; ARC=$?
  AMARK="$(grep -c "$EXPECT_MARK" "$TCONF" 2>/dev/null || true)"   # ⚠ 立刻看，后面 C 用例会把文件回滚掉
  B="$($PY "$TOOL" --local "${TARGS[@]}" --validate true 2>&1)"; BRC=$?
  cp "$TORIG" "$TCONF"; rm -f "$PT/conf.d/cyber-probe.caddy"
  C="$($PY "$TOOL" --local "${TARGS[@]}" --validate false 2>&1)"; CRC=$?
  D="$($PY "$TOOL" --local "${TARGS[@]}" --validate 28080 2>&1)"; DRC=$?
  if [ "$ARC" = 0 ] && printf '%s' "$A" | grep -q "PATCHED" && [ "${AMARK:-0}" != 0 ] \
     && [ "$BRC" = 0 ] && printf '%s' "$B" | grep -q "SKIP" \
     && [ "$CRC" = 4 ] && diff -q "$TORIG" "$TCONF" >/dev/null \
     && [ "$DRC" = 5 ] && printf '%s' "$D" | grep -q "端口号"; then
    ok "$PTEST 补丁器：补得上 / 幂等 / 自检失败逐字节回滚 / 防呆拒绝端口当命令"
  else
    bad "$PTEST 补丁器自测失败（补块 rc=$ARC、幂等 rc=$BRC、回滚 rc=$CRC、防呆 rc=$DRC）"
    printf '%s\n%s\n%s\n%s\n' "$A" "$B" "$C" "$D" | sed 's/^/      /'
  fi
  # ⑤ 贴 → 摘 必须**字节回到原样**：插入时补的分隔空行也属于「改动」的一部分，
  #    插入用的字面量与摘除用的字面量一旦不对称，每次卸载都会在原地留下一个空行。
  #    这种不对称只有往返对比能抓到（nginx 路径就这么漏过）。
  cp "$TORIG" "$TCONF"; rm -f "$PT/conf.d/cyber-probe.caddy"
  E="$($PY "$TOOL" --local "${TARGS[@]}" --validate true 2>&1)"; ERC=$?
  F="$($PY "$TOOL" --local "${TARGS[@]}" --remove --no-reload 2>&1)"; FRC=$?
  if [ "$ERC" = 0 ] && [ "$FRC" = 0 ] && diff -q "$TORIG" "$TCONF" >/dev/null; then
    ok "$PTEST 贴→摘 字节一致（往返还原）"
  else
    bad "$PTEST 贴→摘 后文件与原件不一致（rc=$ERC/$FRC）：$(diff "$TORIG" "$TCONF" | head -4 | tr '\n' ' ')"
  fi
done
rm -rf "$PT"

# 卸载路径不许出现 systemctl restart：reload 在**停着的**服务上会失败，后面的 restart 就等于把它拉起来
# （验证机上真发生过：卸 nginx 路径的包，把本来停着的 caddy 启动了）
# ⚠ 用 awk 只取「if REMOVE: → else:」之间的代码：安装那条路上本来就有 restart（那是合理的）。
#   以前这里写 `grep -A6`，而 restart 恰好落在窗口外 → 门禁永远不会红（变异测试抓出来的）。
RM_RESTART=""
for f in tools/caddy_patch.py tools/nginx_patch.py; do
  awk '/^if REMOVE:/{inb=1} inb && /^else:/{exit} inb' "$f" | grep -q "systemctl restart" && RM_RESTART="$RM_RESTART $f"
done
if [ -n "$RM_RESTART" ]; then
  bad "卸载路径里出现了 systemctl restart（会把本来停着的反代拉起来）：$RM_RESTART"
else
  ok "卸载只 reload 且先判 is-active（不会拉起停着的服务）"
fi
# 探测站点配置必须排除 *.bak-*：补丁器每改一次都会在同目录留 <conf>.bak-<时间>-add/-rm，
# 而备份里同样有「proxy_pass …:hub_port」—— 不排除就会把备份当成站点配置（卸载去改备份、真配置原封不动）
if grep -A2 'grep -rlE' tools/run_header.sh | grep -q '\.bak-'; then
  ok "探测站点配置时排除了备份/停用文件"
else
  bad "探测站点配置没排除 *.bak-*（备份会被当成站点配置）"
fi
# 探测函数要把 nginx / caddy 两边路径都算出来（与当前用哪个反代无关）：
# 卸载必须按两边各摘一次 —— 只摘探测到的那一边，反代换过就会留下另一边的块/import 行
# ⚠ 行号必须**限定在函数体内**（文件顶部还有一处 `CADDYFILE=""` 初始化，按全文件取第一处
#   会永远拿到那一行 → 门禁恒绿，是死门禁（变异测试抓出来的））。
DL=$(grep -n '^detect_proxy_conf() {' tools/run_header.sh | cut -d: -f1)
NL=$(awk -v s="${DL:-0}" 'NR>s && /if \[ "\$PROXY" = nginx \]; then/{print NR; exit}' tools/run_header.sh)
CL=$(awk -v s="${DL:-0}" 'NR>s && /CADDYFILE=/{print NR; exit}' tools/run_header.sh)
if [ -n "$DL" ] && [ -n "$NL" ] && [ -n "$CL" ] && [ "$CL" -lt "$NL" ]; then
  ok "探测函数两边路径都算（卸载能两边各摘一次）"
else
  bad "探测函数只算了一边的路径（反代换过后卸载会留残留：块或 import 行；DL=$DL NL=$NL CL=$CL）"
fi

# ── 4.5) 站名机制 + 对外口径：公开内容里不许出现任何人的站名 ───────────────
step "4.5/5 站名机制 / 对外口径"
# ① gen_config.py 的 --site-name 必须真落进 config.js
SITEOUT="$CIT/site-name-check.js"
if python "$(pwd -W 2>/dev/null || pwd)/tools/gen_config.py" --stub --out "$SITEOUT" --site-name '测试站名' >/dev/null 2>&1 \
   && grep -q 'export const SITE_NAME = "测试站名"' "$SITEOUT"; then
  ok "gen_config.py --site-name 会写进 config.js（站名按实例注入，不写死在页面里）"
else
  bad "gen_config.py --site-name 没落进 config.js（站名机制坏了）"
fi
# ② 公开内容里不许出现「养鸡场 / chicken-farm / 赛博探针」（用户定的对外口径：统一 cyber-probe）。
#    站名走 config.js 按实例注入，所以 index.html 里永远只有中性默认名。
if grep -rnE '养鸡场|chicken-farm|赛博探针' index.html js/main.js js/hud.js js/data.js js/goose.js js/npc.js server/farm_server.py README.md 2>/dev/null | grep -v 'chicken-farm-ops' >/dev/null; then
  bad "公开内容里出现了「养鸡场 / chicken-farm / 赛博探针」（对外口径是 cyber-probe）"
  grep -rnE '养鸡场|chicken-farm|赛博探针' index.html js/main.js js/hud.js js/data.js js/goose.js js/npc.js server/farm_server.py README.md 2>/dev/null | head -3
else
  ok "公开内容里没有「养鸡场 / chicken-farm / 赛博探针」（站名只走 config.js）"
fi
# ③ 安装器必须收 --site-name，并在目标机上落盘（重跑 install 不丢站名）
if grep -q '^  --site-name' tools/run_header.sh && grep -q 'APPDIR/site-name' tools/run_header.sh; then
  ok "安装器支持 --site-name 且会落盘（重跑 install 不丢站名）"
else
  bad "安装器缺 --site-name 或没落盘"
fi
# ③b 本机的部署脚本（tools/deploy.sh，不进公开库）也必须会传站名 —— 否则"重发一次站"
#     就把线上页签名刷成中性默认名（站名按实例注入的代价就是这条链子不能断）
if [ -f tools/deploy.sh ]; then
  if grep -q 'gen_config.py --ssh "$HOST" --site-name "$SITE_NAME"' tools/deploy.sh \
     && grep -q 'from 线上 config.js 认回站名\|\.site-name' tools/deploy.sh; then
    ok "deploy.sh 会带上站名（先认线上/本机记的，再传 --site-name）"
  else
    bad "deploy.sh 不会传站名 → 部署会把线上页签名刷掉"
  fi
else
  say "  - deploy.sh 不在（公开克隆里没有本机部署脚本），跳过"
fi
# ④ main.js 取站名必须用命名空间导入：具名导入在旧 config.js（还没这一项）上会抛
#    SyntaxError「does not provide an export named」→ 整个页面白屏
if grep -q 'import \* as CFG from' js/main.js && grep -q 'CFG.SITE_NAME' js/main.js; then
  ok "main.js 用命名空间导入取站名（旧 config.js 缺项也不会白屏）"
else
  bad "main.js 取站名的方式不安全（具名导入在旧 config.js 上会白屏）"
fi

# ⑤ hub 1.4.0 的口径之一：离线时长按 **hub 时钟**算（last_seen_ago），不再拿浏览器时钟减 last_seen
#    （访客手机快 8 小时时，旧写法会把在线节点显示成「离线 8 小时」甚至整只鸡变离线）
if grep -q 'last_seen_ago' js/data.js && grep -q 'seenAgo' js/npc.js && grep -q 'seenAgo' js/hud.js; then
  ok "离线时长走 hub 1.4.0 的 last_seen_ago（日期/时长都不再用浏览器时钟推算）"
else
  bad "前端没接 last_seen_ago（访客时钟不准时在线节点会被算成离线）"
fi
if grep -n 'now - .*last_seen\|nowT - n\.last_seen\|now() - n\.last_seen\|fmtAgo(n\.last_seen)' js/hud.js js/npc.js >/dev/null 2>&1; then
  bad "还有地方拿浏览器时钟减 last_seen（应改用 seenAgo/last_seen_ago）"
else
  ok "没有残留「浏览器时钟 - last_seen」的算法"
fi

# ⑥ hub 1.4.0 的口径之二：切到后台停轮询 + 丢弃在途请求，回到前台立刻拉一次
if grep -q "addEventListener('visibilitychange'" js/data.js && grep -q 'this._abort?.abort()' js/data.js \
   && grep -q 'AbortController' js/data.js; then
  ok "切后台停轮询并 abort 在途请求，回前台立刻补拉（hub 1.4.0 推荐做法）"
else
  bad "没有处理页面可见性（后台窗口还在空跑轮询）"
fi

# ── --fast 到此收工：只跳过服务端（第 4 步）与浏览器（第 5 步）──────────────
if [ "$FAST" = 1 ]; then
  step "4/5 服务端协议自测"
  say "跳过（--fast 只跑 1~3 步 + 4.5 的静态门禁）"
  step "5/5 浏览器断言"
  say "跳过（--fast）"
  say ""
  if [ ${#FAILED[@]} -eq 0 ]; then
    say "═══ 全绿（--fast：服务端/浏览器未跑）═══"
    exit 0
  fi
  say "═══ 有 ${#FAILED[@]} 项失败（--fast）═══"
  for f in "${FAILED[@]}"; do say "  ✗ $f"; done
  exit 1
fi

# ── 4) 起一个隔离实例跑服务端全套断言（失败自动换干净实例重跑一次）───────
step "4/5 服务端协议自测（隔离实例 :$GATE_PORT）"
LOG="$CIT/ci-server-$GATE_PORT.log"
TOUT=""; TRCF=1; ATT=0
for ATT in 1 2; do
  free_port "$GATE_PORT"
  $PY server/farm_server.py --port "$GATE_PORT" >"$LOG" 2>&1 &
  SRV=$!
  READY=0
  for _ in $(seq 1 40); do
    if curl -s -o /dev/null -m 2 "http://127.0.0.1:$GATE_PORT/" 2>/dev/null; then READY=1; break; fi
    sleep 0.3
  done
  if [ "$READY" != 1 ]; then
    bad "隔离实例没起来（看 $LOG）"
  else
    # ⚠ 别写成 `test_server | tail -6`：整份输出被吞掉，失败原因就查不到了。
    #   存文件 + 看退出码，失败时把日志路径打出来。
    TOUT="$($PY server/test_server.py 127.0.0.1 "$GATE_PORT" 2>&1)"; TRCF=$?
    printf '%s\n' "$TOUT" > "$CIT/ci-tests.log"
    if [ ! -f "$LOG" ]; then bad "服务端日志没生成（$LOG）"
    elif grep -q "Traceback" "$LOG"; then bad "服务端日志里有 Traceback（看 $LOG）"
    else ok "服务端日志零 Traceback"; fi
  fi
  kill "$SRV" 2>/dev/null || true
  wait "$SRV" 2>/dev/null || true
  free_port "$GATE_PORT"
  if [ "$TRCF" = 0 ]; then break; fi
  # ⚠ 两条黑盒用例（两只暴躁鸡挤到一起 / 玩家不在跟前时鸡欺负鸡）依赖随机时机与两只鸡
  #   当时离多远，在一台实例上会偶发空转；权威证明是白盒那两条。所以失败先换干净实例重跑一次。
  if [ "$ATT" = 1 ]; then say "  第一次没全绿 → 换干净实例重跑一次……"; fi
done
printf '%s\n' "$TOUT" | tail -8
SUF=""
if [ "$ATT" = 2 ]; then SUF="（第二次才过：黑盒用例时机抖动）"; fi
if [ "$TRCF" = 0 ]; then
  ok "服务端断言全绿$SUF"
else
  bad "服务端断言有失败（完整输出 $CIT/ci-tests.log）"
fi

# ── 5) 可选：headless 浏览器断言 ──────────────────────────────────────────
step "5/5 浏览器断言"
if [ "$WITH_BROWSER" = 1 ]; then
  # mock 必须有真 hub 才能给前端喂数据（公开仓库里不写死任何人的 hub 地址）：
  # ⚠ 没给 MOCK_UPSTREAM 时 mock 会**立刻 exit 2**，然后断言全变成「读不到探针数据」——
  #   那种假失败比直接跳过难查得多。所以这里先判，再把 local common.sh 的域名当默认值。
  MOCK_UP="${MOCK_UPSTREAM:-}"
  [ -z "$MOCK_UP" ] && [ -n "${DOMAIN:-}" ] && MOCK_UP="https://$DOMAIN"
  if [ -z "$MOCK_UP" ]; then
    say "跳过（要跑就设 MOCK_UPSTREAM=https://你的hub；本机没有 hub 地址时前端拿不到任何数据）"
  else
  say "（要 node + Chrome，且一次只跑一个浏览器测试；数据源 $MOCK_UP）"
  free_port 8899
  MOCK_UPSTREAM="$MOCK_UP" $PY mock/serve.py 8899 >"$CIT/ci-mock.log" 2>&1 &
  MOCK=$!
  for _ in $(seq 1 40); do curl -s -o /dev/null -m 2 "http://127.0.0.1:8899/" 2>/dev/null && break; sleep 0.3; done
  $PY server/farm_server.py --port "$WS_PORT" >"$CIT/ci-ws.log" 2>&1 &
  WS=$!
  sleep 1.5
  # ⚠ URL 要带 `/chicken/`、`?debug` 与 `cc=JP`：
  #   · 站点挂在 /chicken/ 下（根路径是 hub 首页）
  #   · window.__farm 只在 ?debug 时挂出来
  #   · 本地没法经 Cloudflare（拿不到 CF-IPCountry），访客国旗那条断言要靠 ?cc= 自报 —— 少了它必红一条
  if node tools/cdp_test.mjs "http://127.0.0.1:8899/chicken/?debug&cc=JP&ws=ws://127.0.0.1:$WS_PORT" 2>&1 | tail -8; then
    ok "cdp_test.mjs 全绿"
  else
    bad "cdp_test.mjs 有失败"
  fi
  kill "$MOCK" "$WS" 2>/dev/null || true
  free_port 8899; free_port "$WS_PORT"
  fi
else
  say "跳过（要跑就加 --with-browser）"
fi

say ""
if [ ${#FAILED[@]} -eq 0 ]; then
  say "═══ 全绿 ═══"
  exit 0
fi
say "═══ 有 ${#FAILED[@]} 项失败 ═══"
for f in "${FAILED[@]}"; do say "  ✗ $f"; done
exit 1
