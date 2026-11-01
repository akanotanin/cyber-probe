#!/usr/bin/env bash
# 国旗图下载成本地文件（默认 vendor/flags/<cc>.png），让名牌上的国旗不再从站外取图。
#
# 与模型同一套做法：仓库里只有脚本与码表，图片在安装/部署时下载，产物只留在自己机器上。
# 源地址不写死：用环境变量 FLAG_CDN，或本机文件 tools/.flag-cdn（不进库）。
# 没配就跳过（名牌退回两字母代码，不影响可玩）。
#
# 用法：
#   bash tools/fetch_flags.sh                 # 下到 vendor/flags
#   bash tools/fetch_flags.sh /path/to/dir    # 指定目录（安装器往 webroot 里灌）
#   FORCE=1 bash tools/fetch_flags.sh         # 重新下载
#   bash tools/fetch_flags.sh --check         # 只检查不下载

set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FORCE="${FORCE:-0}"
CHECK_ONLY=0
DEST="$ROOT/vendor/flags"

for a in "$@"; do
  case "$a" in
    --check) CHECK_ONLY=1 ;;
    -*) echo "未知参数：$a" >&2; exit 2 ;;
    *) DEST="$a" ;;
  esac
done

SRC="${FLAG_CDN:-}"
if [ -z "$SRC" ] && [ -f "$ROOT/tools/.flag-cdn" ]; then
  SRC="$(head -1 "$ROOT/tools/.flag-cdn" | tr -d '\r\n ')"
fi
if [ -z "$SRC" ]; then
  echo "· 未配置国旗源（FLAG_CDN 或 tools/.flag-cdn）→ 跳过，名牌用两字母代码" >&2
  exit 0
fi
case "$SRC" in */) ;; *) SRC="$SRC/" ;; esac

# ISO 3166-1 alpha-2（含 XK 这类非官方常用码），覆盖探针节点/探测点/访客可能出现的国家
CODES="ad ae af ag ai al am ao aq ar as at au aw ax az ba bb bd be bf bg bh bi bj bl bm bn bo bq br bs bt bv bw by bz ca cc cd cf cg ch ci ck cl cm cn co cr cu cv cw cx cy cz de dj dk dm do dz ec ee eg eh er es et fi fj fk fm fo fr ga gb gd ge gf gg gh gi gl gm gn gp gq gr gs gt gu gw gy hk hm hn hr ht hu id ie il im in io iq ir is it je jm jo jp ke kg kh ki km kn kp kr kw ky kz la lb lc li lk lr ls lt lu lv ly ma mc md me mf mg mh mk ml mm mn mo mp mq mr ms mt mu mv mw mx my mz na nc ne nf ng ni nl no np nr nu nz om pa pe pf pg ph pk pl pm pn pr ps pt pw py qa re ro rs ru rw sa sb sc sd se sg sh si sj sk sl sm sn so sr ss st sv sx sy sz tc td tf tg th tj tk tl tm tn to tr tt tv tw tz ua ug um us uy uz va vc ve vg vi vn vu wf ws xk ye yt za zm zw"

total=0; ok=0; fail=0; failed=""
[ -d "$DEST" ] || mkdir -p "$DEST" || { echo "✗ 建不了目录 $DEST" >&2; exit 1; }
# ⚠ curl 是原生二进制：Windows 上不认 MSYS 的 /c/... 绝对路径 → 先 cd 进目标目录，只用相对名
cd "$DEST" || { echo "✗ 进不了 $DEST" >&2; exit 1; }

for cc in $CODES; do
  total=$((total+1))
  f="$cc.png"
  if [ "$FORCE" != "1" ] && [ -s "$f" ]; then ok=$((ok+1)); continue; fi
  [ "$CHECK_ONLY" = "1" ] && { fail=$((fail+1)); failed="$failed $cc"; continue; }
  if curl -fsS --max-time 25 --retry 1 -o "$f.part" "$SRC$cc.png" 2>/dev/null && [ -s "$f.part" ]; then
    mv "$f.part" "$f"; ok=$((ok+1))
  else
    rm -f "$f.part"; fail=$((fail+1)); failed="$failed $cc"
  fi
done

if [ "$CHECK_ONLY" = "1" ]; then
  if [ "$fail" -eq 0 ]; then echo "✓ 国旗齐了（$total 面，$DEST）"; exit 0; fi
  echo "✗ 缺 $fail/$total 面：$(echo "$failed" | cut -c1-120)…" >&2; exit 1
fi
echo "国旗：$ok/$total 面就位（失败 $fail）→ $DEST"
[ "$fail" -gt 0 ] && echo "  缺的会在下次安装/部署时再补；缺图的名字牌会显示两字母代码" >&2
exit 0
