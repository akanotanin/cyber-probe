#!/usr/bin/env bash
# 打一个"一键部署包"：dist/cyber-probe-<日期>.run（单文件，含 install/status/restart/logs/test/uninstall/version）
# 用法: bash tools/pack_run.sh
#
# ★ 包里**不带**探针名单：安装器在目标机上就地读 hub 的 SQLite 现场生成 config.js，
#   所以别人装出来的是他自己的探针数据。这里只放一个空占位，保证 install 之前站点也能起。
set -euo pipefail
cd "$(dirname "$0")/.."
source tools/common.sh

say "== 1/4 准备载荷 =="
rm -rf build/pack
mkdir -p build/pack/site build/pack/server build/pack/tools build/pack/systemd
cp index.html style.css favicon.svg apple-touch-icon.png build/pack/site/
cp -r js vendor build/pack/site/
cp server/farm_server.py server/test_server.py build/pack/server/
cp tools/nginx_patch.py tools/caddy_patch.py tools/cachebust.py tools/gen_config.py build/pack/tools/
cp systemd/cyber-probe.service build/pack/systemd/
$PY tools/gen_config.py --stub --out build/pack/site/js/config.js

# 隐私约定：config.js 里不许出现域名/IP（这个站是公开的，装完在目标机上重生成也是同一约定）
if grep -Eq '[a-z0-9-]+\.(com|net|org|cn|io|xyz|top|de)\b|[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+' build/pack/site/js/config.js; then
  grep -En '[a-z0-9-]+\.(com|net|org|cn|io|xyz|top|de)\b|[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+' build/pack/site/js/config.js | head -3
  die "config.js 里出现了疑似域名/IP —— 隐私约定是「不落盘」，先查清楚再打包"
fi
say "  站点 $(find build/pack/site -type f | wc -l) 个文件；config.js 是空占位（安装时在目标机上重生成）"
VERSION="$(date +%Y%m%d%H%M)-$(git rev-parse --short HEAD 2>/dev/null || echo nogit)"
printf '%s\n' "$VERSION" > build/pack/VERSION

say "== 2/4 打 tar 载荷 =="
( cd build/pack && find . -type f | sort | tar czf ../payload.tgz -T - )
du -h build/payload.tgz | sed 's/^/  /'

say "== 3/4 拼出单文件包 =="
STAMP="$(date +%Y%m%d-%H%M)"      # 带分钟，免得同一天打两次重名（发布资产同名但内容不同最容易看错）
mkdir -p dist
OUT="dist/cyber-probe-$STAMP.run"
cat tools/run_header.sh build/payload.tgz > "$OUT"
chmod +x "$OUT"
# 再留一份稳定名字的副本：README 里的 `releases/latest/download/cyber-probe.run` 靠它
cp -f "$OUT" dist/cyber-probe.run
chmod +x dist/cyber-probe.run

say "== 4/4 自检 =="
# 头里必须有项目名（对外发布口径：这个项目叫 cyber-probe）
if ! grep -q 'cyber-probe' tools/run_header.sh; then
  die "run_header.sh 里没有项目名（对外口径：cyber-probe）"
fi
if ! bash "$OUT" --help >/dev/null 2>&1; then
  die "包自检失败：bash $OUT --help 退出码非 0"
fi
bash "$OUT" --help | head -3 | sed 's/^/  /'
say "  产出 $OUT（$(du -h "$OUT" | cut -f1)）  版本 $VERSION"
say "  在服务器上: sudo bash $OUT install --yes"
