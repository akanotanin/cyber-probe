#!/usr/bin/env bash
# 把 模型库的模块下载到本地（默认 vendor/models），让站点运行时不再访问第三方 CDN。
#
# 为什么是"安装时下载"而不是"放进仓库"：
#   模型库的许可允许在作品里用（可商用、免署名），但不允许再分发模型本体 ——
#   把文件提交进仓库、或让别人从你的仓库/发布包里拿，都算再分发。
#   所以仓库里只有脚本与 id 清单，下载发生在安装/构建这一步，产物只在你这台机器上。
#
# 用法：
#   bash tools/fetch_models.sh                # 下到 vendor/models（已存在且完整就跳过）
#   bash tools/fetch_models.sh /path/to/dir   # 指定目录（安装器用它往 webroot 里灌）
#   FORCE=1 bash tools/fetch_models.sh        # 重新下载
#   bash tools/fetch_models.sh --check        # 只检查不下载（退出码 0=齐了）
#
# 落盘用 .js 而不是 .mjs：不少服务器（nginx 默认 mime.types、部分 CDN）没有 .mjs 的 MIME 映射，
# 会按 application/octet-stream 返回，配合 nosniff 浏览器直接拒绝把模块执行掉 —— 整站就只剩自建道具。
#
# 失败不致命：拿不到的模型会被 js/world.js 的自建道具顶替，站点照常能玩。

set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# 模型源地址不写死在代码里：用环境变量 MODEL_CDN，或本机文件 tools/.model-cdn（不进库）。
# 没配置就跳过（站点会退回自建道具），不会把安装搞失败。
CDN="${MODEL_CDN:-}"
if [ -z "$CDN" ] && [ -f "$ROOT/tools/.model-cdn" ]; then
  CDN="$(head -1 "$ROOT/tools/.model-cdn" | tr -d '\r\n ')"
fi
if [ -z "$CDN" ]; then
  echo "· 未配置模型源（MODEL_CDN 或 tools/.model-cdn）→ 跳过，站点用自建道具" >&2
  exit 0
fi
case "$CDN" in */) ;; *) CDN="$CDN/" ;; esac
FORCE="${FORCE:-0}"
CHECK_ONLY=0
DEST="$ROOT/vendor/models"

for a in "$@"; do
  case "$a" in
    --check) CHECK_ONLY=1 ;;
    -*) echo "未知参数：$a" >&2; exit 2 ;;
    *) DEST="$a" ;;
  esac
done

# id 清单只认两处：js/model-ids.js（道具）与 js/dog.js（看门狗）。
# 安装包里的目录布局是 <包>/site/js/...，仓库里是 <仓>/js/...，两个都认。
SRC="$ROOT"
[ -f "$SRC/js/model-ids.js" ] || SRC="$ROOT/site"
if [ ! -f "$SRC/js/model-ids.js" ]; then
  echo "✗ 找不到 js/model-ids.js（$ROOT 与 $ROOT/site 下都没有）" >&2; exit 1
fi
ids="$(grep -oE "^[[:space:]]*'[a-z0-9-]+'," "$SRC/js/model-ids.js" | tr -d " ',\t")"
dog="$(grep -oE "farm-dog-[a-z0-9]+" "$SRC/js/dog.js" | head -1)"
[ -n "$dog" ] && ids="$ids
$dog"
ids="$(printf '%s\n' "$ids" | sed '/^$/d' | sort -u)"
total="$(printf '%s\n' "$ids" | wc -l | tr -d ' ')"

[ -d "$DEST" ] || mkdir -p "$DEST" || { echo "✗ 建不了目录 $DEST" >&2; exit 1; }

ok=0; skip=0; fail=0; failed=""
# ⚠ curl 是原生二进制：Windows 上不认 MSYS 的 /c/... 绝对路径，所以先 cd 进目标目录、只用相对文件名
cd "$DEST" || { echo "✗ 进不了 $DEST" >&2; exit 1; }
for id in $ids; do
  f="$id.js"
  if [ "$FORCE" != "1" ] && [ -s "$f" ] && grep -q 'createAsset' "$f" 2>/dev/null; then
    skip=$((skip+1)); ok=$((ok+1)); continue
  fi
  [ "$CHECK_ONLY" = "1" ] && { fail=$((fail+1)); failed="$failed $id"; continue; }
  if curl -fsS --max-time 40 --retry 2 -A 'cyber-probe/1.x (self-hosted farm)' -o "$f.part" "$CDN$id.mjs" 2>/dev/null \
     && [ -s "$f.part" ] && grep -q 'createAsset' "$f.part"; then
    mv "$f.part" "$f"; ok=$((ok+1))
  else
    rm -f "$f.part"; fail=$((fail+1)); failed="$failed $id"
  fi
done

if [ "$CHECK_ONLY" = "1" ]; then
  if [ "$fail" -eq 0 ]; then echo "✓ 模型齐了（$total 个，$DEST）"; exit 0; fi
  echo "✗ 缺 $fail/$total 个：$failed" >&2; exit 1
fi

echo "模型：$ok/$total 就位（新下载 $((ok-skip))，已存在 $skip，失败 $fail）→ $DEST"
if [ "$fail" -gt 0 ]; then
  echo "  失败的：$failed" >&2
  echo "  （不影响可玩性：这些道具会退回自建模型；联网后重跑本脚本即可补上）" >&2
  exit 1
fi
