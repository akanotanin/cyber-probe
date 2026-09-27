#!/usr/bin/env bash
# cyber-probe 全量自检（P1-7）：把散在各处的断言串成一条命令，本地改完跑它就行。
#
#   bash tools/ci.sh                 服务端协议自测 + JS/静态检查（约 5 分钟）
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
for a in "$@"; do [ "$a" = "--with-browser" ] && WITH_BROWSER=1; done

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
step "2/5 JS 模块解析 + 已删 API 残留"
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

# 分数系统已整体删除：任何地方再长出这些调用就说明回退了
if grep -rn "myScore\|renderBoard\|setBoard\|setPlayerTip\|serverScore" js/ index.html >/dev/null 2>&1; then
  bad "js/ 里又出现了已删的分数 API（grep 到残留）"
else
  ok "分数系统无残留引用（myScore/renderBoard/setBoard/setPlayerTip/serverScore）"
fi
if grep -rn "score" server/farm_server.py | grep -v "^\s*#" | grep -v "分数系统\|不记分\|没有分数" | grep -q "score"; then
  bad "farm_server.py 里还有 score 代码（非注释）"
else
  ok "farm_server.py 无 score 代码残留"
fi

# ── 3) 静态站素材齐不齐（免得部署出一个缺 js 的站）────────────────────────
step "3/5 静态素材完整性"
MISS=0
for f in index.html style.css js/main.js js/net.js js/npc.js js/config.js vendor/three.module.js; do
  [ -f "$f" ] || { bad "缺少 $f" ; MISS=1; }
done
[ "$MISS" = 0 ] && ok "index.html / style.css / js/* / vendor 都在"
[ -f js/config.js ] || say "  （提示：js/config.js 由 $PY tools/gen_config.py 生成，deploy.sh 会自动重跑）"

# ── 4) 起一个隔离实例跑服务端全套断言 ─────────────────────────────────────
step "4/5 服务端协议自测（隔离实例 :$GATE_PORT）"
free_port "$GATE_PORT"
LOG="$TMPDIR/ci-server-$GATE_PORT.log"
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
  if $PY server/test_server.py 127.0.0.1 "$GATE_PORT" 2>&1 | tail -6; then
    ok "服务端断言全绿"
  else
    bad "服务端断言有失败（详见上面输出）"
  fi
  if grep -q "Traceback" "$LOG"; then bad "服务端日志里有 Traceback（看 $LOG）"; else ok "服务端日志零 Traceback"; fi
fi
kill "$SRV" 2>/dev/null || true
wait "$SRV" 2>/dev/null || true
free_port "$GATE_PORT"

# ── 5) 可选：headless 浏览器断言 ──────────────────────────────────────────
step "5/5 浏览器断言"
if [ "$WITH_BROWSER" = 1 ]; then
  say "（要 node + Chrome，且一次只跑一个浏览器测试）"
  free_port 8899
  $PY mock/serve.py 8899 >"$TMPDIR/ci-mock.log" 2>&1 &
  MOCK=$!
  for _ in $(seq 1 40); do curl -s -o /dev/null -m 2 "http://127.0.0.1:8899/" 2>/dev/null && break; sleep 0.3; done
  $PY server/farm_server.py --port "$WS_PORT" >"$TMPDIR/ci-ws.log" 2>&1 &
  WS=$!
  sleep 1.5
  if node tools/cdp_test.mjs "http://127.0.0.1:8899/?ws=ws://127.0.0.1:$WS_PORT" 2>&1 | tail -8; then
    ok "cdp_test.mjs 全绿"
  else
    bad "cdp_test.mjs 有失败"
  fi
  kill "$MOCK" "$WS" 2>/dev/null || true
  free_port 8899; free_port "$WS_PORT"
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
