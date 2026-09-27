#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# cyber-probe 一键部署包（all-in-one）
#   静态站 + 联机服 + systemd 单元 + 反代（nginx 或 Caddy），一个文件搞定（幂等，可反复跑）
#   用法：sudo bash cyber-probe-<日期>.run [模式] [参数]      详见 --help
#
#   设计前提：跑在**装了 monitor hub 的那台机器**上。hub 的监听端口、数据库路径、
#   站点域名都从 hub 的 systemd 单元与反代配置里自动认，认不到才用参数兜。
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

# 这些都可以被命令行参数覆盖；空串 = 自动探测
DOMAIN=""
WEBROOT=/var/www/cyber-probe
APPDIR=/opt/cyber-probe
SERVICE=cyber-probe
WS_PORT=28910
HUB_PORT=""
MONITOR_DB=""
NGINX_CONF=""
CADDYFILE=""
PROXY=auto            # nginx | caddy | auto | none
NO_GEO=0
MODE=install
YES=0
BAK_KEEP=5
LOGS_N=50

say() { printf '%s\n' "$*"; }
die() { printf '✗ %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
cyber-probe 一键部署包 —— 把 monitor hub 的探针数据做成一座可玩的 3D 世界

用法：sudo bash cyber-probe-<日期>.run [模式] [参数]

模式（默认 install）：
  install      安装/升级：静态站 + 联机服 + systemd 单元 + 反代（nginx 或 Caddy，幂等）
  status       看现状：单元状态、端口、站点/接口/WebSocket 探活、最近日志
  restart      只重启联机服（并核对 pid 真的变了）
  logs [n]     看最近 n 行日志（默认 50）
  test         在机上跑一遍全套服务端自测（需要 python3）
  uninstall    卸载：停服+删单元+删目录+摘反代（静态站先打包备份到 /root）
  version      看这个包是什么时候打的

参数（都能自动探测，探测结果会打印出来；探测不对时才需要显式给）：
  --domain  <域名>        对外域名（默认取 hub 单元的 --site，其次反代配置里的 server_name）
  --hub-port <端口>       hub 端口（默认取 hub 单元的 --listen）
  --monitor-db <路径>     monitor hub 的 SQLite（默认取 hub 单元的 --db）
  --proxy   nginx|caddy   用哪个反代（默认自动认：谁在跑用谁）
  --nginx-conf <路径>     nginx 站点配置文件
  --caddyfile <路径>      Caddyfile
  --webroot <路径>        静态站目录（默认 /var/www/cyber-probe）
  --appdir  <路径>        联机服目录（默认 /opt/cyber-probe）
  --service <名字>        systemd 单元名（默认 cyber-probe）
  --port    <端口>        联机服监听端口（仅回环，默认 28910）
  --site-name <名字>      本站的名字（显示在浏览器页签；不写就用页面自带的默认名）
  --no-geo                不查国旗（离线环境；网站鸡名牌显示 🌐）
  --yes, -y               install/uninstall 不再交互确认
  -h, --help              这份说明

包内含：站点（index.html/style.css/js/vendor）、server/farm_server.py + test_server.py、
        systemd 单元模板、config.js 生成器、nginx / Caddy 反代补丁工具。
公开路径固定 /chicken/（主题 jikasei 的入口按这个路径自动认）。
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    install|status|restart|logs|test|uninstall|version) MODE="$1"; shift ;;
    --domain) DOMAIN="$2"; shift 2 ;;
    --webroot) WEBROOT="$2"; shift 2 ;;
    --appdir) APPDIR="$2"; shift 2 ;;
    --service) SERVICE="$2"; shift 2 ;;
    --port) WS_PORT="$2"; shift 2 ;;
    --hub-port) HUB_PORT="$2"; shift 2 ;;
    --monitor-db) MONITOR_DB="$2"; shift 2 ;;
    --site-name) SITE_NAME_ARG="$2"; shift 2 ;;
    --proxy) PROXY="$2"; shift 2 ;;
    --nginx-conf) NGINX_CONF="$2"; shift 2 ;;
    --caddyfile) CADDYFILE="$2"; shift 2 ;;
    --no-geo) NO_GEO=1; shift ;;
    --yes|-y) YES=1; shift ;;
    -h|--help|help) usage; exit 0 ;;
    [0-9]*) LOGS_N="$1"; shift ;;
    *) die "未知参数 $1（--help 看用法）" ;;
  esac
done

SELF="${BASH_SOURCE[0]}"
SELF="$(cd "$(dirname "$SELF")" && pwd)/$(basename "$SELF")"
WORK=""
cleanup() { [ -n "$WORK" ] && rm -rf "$WORK" || true; }
trap cleanup EXIT

need_root() { [ "$(id -u)" = 0 ] || die "需要 root：sudo bash $SELF $MODE"; }

extract() {
  [ -n "$WORK" ] && return 0
  WORK="$(mktemp -d /tmp/cyber-probe-pack.XXXXXX)"
  local line
  line="$(grep -an '^__ARCHIVE_BELOW__$' "$SELF" | head -1 | cut -d: -f1 || true)"
  [ -n "$line" ] || die "包已损坏（找不到载荷标记）"
  tail -n +$((line + 1)) "$SELF" | tar xzf - -C "$WORK" || die "解包失败（包可能被破坏）"
  [ -f "$WORK/VERSION" ] || die "载荷不完整（没有 VERSION）"
  say "  载荷版本 $(cat "$WORK/VERSION")"
}

backup_file() {
  local f="$1"; [ -f "$f" ] || return 0
  local stamp; stamp="$(date +%Y%m%d-%H%M%S)"
  cp -p "$f" "$f.bak-$stamp"
  ls -1t "$f.bak-"* 2>/dev/null | tail -n +$((BAK_KEEP + 1)) | xargs -r rm -f
  say "  备份 $f.bak-$stamp"
}

# ─────────────────────────── 自动探测 ───────────────────────────

hub_unit() {
  # monitor hub 的单元名各版本不一（monitor-hub / hub / monitor），按顺序找。
  # ⚠ 不能写成 `systemctl ... | grep -q xxx`：grep -q 找到就退出 → 上游收 SIGPIPE →
  #   pipefail 把整条管道判成非零 → if 条件假 → 静默选到下一个候选（实测选成了
  #   monitor-agent，于是域名/端口全探测错）。所以先把列表抓成变量，再逐个比对。
  local u units names
  units="$(systemctl list-unit-files 2>/dev/null | awk '{print $1}' || true)"
  for u in monitor-hub hub monitor; do
    if printf '%s\n' "$units" | grep -qx "$u\.service"; then printf '%s' "$u"; return 0; fi
  done
  names="$(systemctl list-units --type=service --state=running --no-legend 2>/dev/null \
    | awk '{print $1}' | sed 's/\.service$//' || true)"
  for u in $(printf '%s\n' "$names" | grep -iE 'hub' || true); do printf '%s' "$u"; return 0; done
  for u in $(printf '%s\n' "$names" | grep -iE 'monitor|komari|nezha' | grep -v agent || true); do printf '%s' "$u"; return 0; done
  return 1
}

hub_exec_args() {  # 从单元里抠出 ExecStart 的参数串
  local u="$1"
  systemctl show "$u" -p ExecStart --value 2>/dev/null | head -1 || true
}

detect_hub() {
  local u args
  u="$(hub_unit || true)"
  if [ -n "${u:-}" ]; then
    args="$(hub_exec_args "$u")"
    # ⚠ 探测用的管道一律 `|| true` 兜底：set -e + pipefail 下「grep 没匹配到」返回 1
    #   会直接把整个脚本干掉（装到别人机器上表现成"检测到一半就退出，什么都没说"）。
    [ -n "$HUB_PORT" ] || HUB_PORT="$(printf '%s' "$args" | grep -oE '\-\-listen[= ][^ ]*' | head -1 \
      | sed -E 's/.*:([0-9]+)$/\1/' || true)"
    [ -n "$MONITOR_DB" ] || MONITOR_DB="$(printf '%s' "$args" | grep -oE '\-\-db[= ][^ ;]*' | head -1 \
      | sed -E 's/^--db[= ]//' || true)"
    [ -n "$DOMAIN" ] || DOMAIN="$(printf '%s' "$args" | grep -oE '\-\-site[= ][^ ;]*' | head -1 \
      | sed -E 's|.*//||; s|/.*||' || true)"
    say "  hub 单元      $u"
  else
    say "  hub 单元      没找到（按端口/默认值兜）"
  fi
  if [ -z "$HUB_PORT" ]; then
    HUB_PORT="$(ss -tlnp 2>/dev/null | grep -iE 'monitor(-hub)?' | grep -oE '127\.0\.0\.1:[0-9]+' \
      | head -1 | cut -d: -f2 || true)"
  fi
  [ -n "$HUB_PORT" ] || HUB_PORT=28080
  if [ -z "$MONITOR_DB" ]; then
    MONITOR_DB="$(ls -1 /opt/monitor/data/monitor.db /opt/*/data/monitor.db /var/lib/monitor/monitor.db 2>/dev/null | head -1 || true)"
  fi
}

detect_proxy() {
  local n=0 c=0
  if command -v nginx >/dev/null 2>&1 && systemctl is-active --quiet nginx 2>/dev/null; then n=1; fi
  if command -v caddy >/dev/null 2>&1 && systemctl is-active --quiet caddy 2>/dev/null; then c=1; fi
  case "$PROXY" in
    nginx) [ "$n" = 1 ] || say "  ⚠ 指定了 --proxy nginx，但 nginx 没在跑" ;;
    caddy) [ "$c" = 1 ] || say "  ⚠ 指定了 --proxy caddy，但 caddy 没在跑" ;;
    auto)
      if [ "$n" = 1 ]; then PROXY=nginx
      elif [ "$c" = 1 ]; then PROXY=caddy
      elif command -v nginx >/dev/null 2>&1; then PROXY=nginx
      elif command -v caddy >/dev/null 2>&1; then PROXY=caddy
      else PROXY=none; fi ;;
  esac
  say "  反向代理     $PROXY"
}

detect_proxy_conf() {
  # ★ 两边路径都先算出来（跟当前用哪个反代无关）：**卸载要按两边各摘一次**。
  #   装的时候用的是当时的反代，卸的时候反代可能已经换了（比如后来装了 nginx 并启动）——
  #   只摘探测到的那一边，另一边会留下 location 块 / import 行；Caddy 那边更严重：
  #   import 一个已被删掉的片段会让 caddy 直接起不来（验证机上实测到残留）。
  if [ -z "$NGINX_CONF" ]; then
    # ⚠ 必须排除备份/停用文件：补丁器每改一次都会在同目录留 <conf>.bak-<时间>-add/-rm，
    #   而备份里同样有 proxy_pass …:hub_port —— 不排除就会**把备份当成站点配置**，
    #   于是卸载去改备份、真配置上的三块原封不动（验证机上实测踩过）。
    NGINX_CONF="$(grep -rlE "proxy_pass[[:space:]]+http://127\.0\.0\.1:${HUB_PORT}" \
      /etc/nginx/conf.d /etc/nginx/sites-enabled /etc/nginx/sites-available 2>/dev/null \
      | grep -vE '\.bak-|\.orig$|\.save$|\.disabled|\.dpkg-|~$' | head -1 || true)"
  fi
  [ -n "$NGINX_CONF" ] || NGINX_CONF="$(ls -1 /etc/nginx/conf.d/*.conf 2>/dev/null | head -1 || true)"
  [ -n "$NGINX_CONF" ] || NGINX_CONF=/etc/nginx/conf.d/hub.conf
  if [ -z "$CADDYFILE" ]; then
    CADDYFILE="$(systemctl show caddy -p ExecStart --value 2>/dev/null \
      | grep -oE '\-\-config[= ][^ ]*' | head -1 | sed -E 's/^--config[= ]//' || true)"
  fi
  [ -n "$CADDYFILE" ] || CADDYFILE=/etc/caddy/Caddyfile

  if [ "$PROXY" = nginx ]; then
    say "  nginx 配置   $NGINX_CONF"
    if [ -z "$DOMAIN" ] && [ -f "$NGINX_CONF" ]; then
      DOMAIN="$(grep -oE 'server_name[[:space:]]+[^;]+' "$NGINX_CONF" | head -1 \
        | sed -E 's/server_name[[:space:]]+//; s/[[:space:]]+/ /g' | awk '{print $1}' | grep -v '^_' || true)"
    fi
  elif [ "$PROXY" = caddy ]; then
    say "  Caddyfile    $CADDYFILE"
  fi
  [ -n "$DOMAIN" ] || DOMAIN="$(hostname -f 2>/dev/null || hostname)"
  say "  对外域名     $DOMAIN"

  # 站点实际监听端口（探活用）：nginx 未必是 443（本机测试站点常在 8080），Caddy 看站点地址。
  SITE_PORT=443
  local p
  if [ "$PROXY" = nginx ] && [ -f "${NGINX_CONF:-/nonexistent}" ]; then
    p="$(grep -E '^[[:space:]]*listen[[:space:]]+[0-9]+' "$NGINX_CONF" 2>/dev/null | grep -oE '[0-9]+' | head -1 || true)"
    [ -n "$p" ] && SITE_PORT="$p"
  elif [ "$PROXY" = caddy ] && [ -f "${CADDYFILE:-/nonexistent}" ]; then
    p="$(grep -E '^[[:space:]]*[^#[:space:]].*\{[[:space:]]*$' "$CADDYFILE" 2>/dev/null \
          | head -1 | grep -oE ':[0-9]+' | head -1 | tr -d ':' || true)"
    [ -n "$p" ] && SITE_PORT="$p"
  fi
  say "  站点端口     $SITE_PORT"
}

# ─────────────────────────── 各步 ───────────────────────────

gen_config() {
  local out="$1" extra="" res nm="${SITE_NAME_ARG:-}"
  [ "$NO_GEO" = 1 ] && extra="--no-geo"
  # 站名：命令行给了就用它（并落盘，重跑安装不丢）；没给就沿用上次落盘的
  if [ -n "$nm" ]; then
    printf '%s\n' "$nm" > "$APPDIR/site-name" 2>/dev/null || true
  elif [ -f "$APPDIR/site-name" ]; then
    nm="$(head -1 "$APPDIR/site-name")"
  fi
  if [ -n "$MONITOR_DB" ] && [ -f "$MONITOR_DB" ]; then
    # shellcheck disable=SC2086
    if res="$(python3 "$WORK/tools/gen_config.py" --db "$MONITOR_DB" --out "$out" \
               --cache "$WORK/tools/flag_cache.json" $extra --site-name "$nm" 2>&1)"; then
      printf '%s\n' "$res" | sed 's/^/  /'
    else
      die "就地读 hub 数据库生成 config.js 失败：$res"
    fi
  else
    say "  ⚠ 没找到 hub 数据库（可用 --monitor-db 指定）→ 先用空清单"
    say "    静态站本身没问题，但网站鸡要等重跑 install（或手动跑 gen_config.py）才会出现"
    # shellcheck disable=SC2086
    python3 "$WORK/tools/gen_config.py" --stub --out "$out" $extra --site-name "$nm" | sed 's/^/  /'
  fi
}

install_site() {
  local parent; parent="$(dirname "$WEBROOT")"
  local stage="$parent/.cyber-probe.new" old="$parent/.cyber-probe.old"
  rm -rf "$stage"; mkdir -p "$stage"
  cp -a "$WORK/site/." "$stage/"
  gen_config "$stage/js/config.js"
  find "$stage" -type d -exec chmod 755 {} +
  find "$stage" -type f -exec chmod 644 {} +
  # ★ 资源 URL 打版本号（绕开 Cloudflare 的浏览器缓存，默认 4 小时）：
  #   不打的话「新 index.html + 旧缓存的 js」= 协议对不上（服务端字段改过就整片鸡不动/报错）。
  if [ -f "$WORK/tools/cachebust.py" ]; then
    python3 "$WORK/tools/cachebust.py" "$stage" "$(date +%Y%m%d%H%M)" | sed 's/^/    /'
  fi
  printf '%s\n' "$(cat "$WORK/VERSION" 2>/dev/null || echo unknown)" > "$stage/version.txt"
  chmod 644 "$stage/version.txt"
  rm -rf "$old"
  if [ -d "$WEBROOT" ]; then mv "$WEBROOT" "$old"; fi
  mv "$stage" "$WEBROOT"
  rm -rf "$old"
  say "  静态站就位 $WEBROOT（$(find "$WEBROOT" -type f | wc -l) 个文件，$(du -sh "$WEBROOT" | cut -f1)）"
}

site_url() { printf 'https://%s/chicken/' "$DOMAIN"; }

# 探活用 --resolve 把域名钉到 127.0.0.1（这样 SNI 与 Host 都是真域名；只改 Host 头在 Caddy 上
# 会握手失败，状态码 000）。站点不一定在 443 —— nginx 常见 listen 8080 —— 所以按
# 「站点端口 → 443 → 80」顺序试，每个端口先 https 后 http；命中就把它标在输出里。
# ⚠ 端口标记必须由函数**自己打印**：函数是在 $( ) 里跑的（子 shell），给全局变量赋值会丢。
probe_code() {   # probe_code <路径> [额外 curl 参数...]
  local path="$1"; shift
  local p s c=""
  for p in $SITE_PORT 443 80; do
    for s in https http; do
      c="$(curl -sk -m 8 -o /dev/null -w '%{http_code}' "$@" \
            --resolve "$DOMAIN:$p:127.0.0.1" "$s://$DOMAIN:$p$path" 2>/dev/null || true)"
      if [ -n "$c" ] && [ "$c" != "000" ]; then
        printf '%s   （%s://%s:%s）' "$c" "$s" "$DOMAIN" "$p"; return 0
      fi
    done
  done
  printf '%s' "${c:-000}"
}

# WebSocket 必须用 HTTP/1.1 探：HTTP/2 里没有 Upgrade 机制（Caddy 会回 400）。
# head -1 会让上游收 SIGPIPE，所以整条管道要吞掉退出码（不能挂 `|| say`，会误报失败）。
probe_ws() {
  local p s line
  for p in $SITE_PORT 443 80; do
    for s in https http; do
      line="$(curl -sk -m 5 -i --http1.1 --resolve "$DOMAIN:$p:127.0.0.1" \
        -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
        -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
        "$s://$DOMAIN:$p/chicken/ws" 2>/dev/null | head -1 || true)"
      case "$line" in *101*|*"Switching Protocols"*) printf '%s (端口 %s)' "$line" "$p"; return 0 ;; esac
    done
  done
  printf '%s' "${line:-（curl 失败）}"
}

do_status() {
  say "· systemd     $(systemctl show "$SERVICE" -p ActiveState --value 2>/dev/null || echo '无此单元') / $(systemctl show "$SERVICE" -p SubState --value 2>/dev/null)  pid=$(systemctl show "$SERVICE" -p MainPID --value 2>/dev/null || echo -)"
  say "· 端口 $WS_PORT  $(ss -tlnp 2>/dev/null | awk -v p=":$WS_PORT" '$4 ~ p {print $4" ("$6")"}' | head -1)"
  say "· 站点版本    $([ -f "$WEBROOT/version.txt" ] && cat "$WEBROOT/version.txt" || echo '未知（没打过包）')"
  say "· 生成于      $([ -f "$WEBROOT/js/config.js" ] && grep -oE 'GENERATED_AT = "[^"]*"' "$WEBROOT/js/config.js" | head -1 | cut -d'"' -f2 || echo '（没生成）')"
  say "· /chicken/       $(probe_code /chicken/)"
  say "· /chicken/api/   $(probe_code /chicken/api/nodes)"
  say "· /chicken/ws     $(probe_ws)"
  say '· 最近日志'
  journalctl -u "$SERVICE" -n 3 --no-pager 2>/dev/null | sed 's/^/    /' || true
}

do_install() {
  need_root
  command -v python3 >/dev/null || die "缺 python3（生成 config.js 与反代补丁都要它）"
  command -v systemctl >/dev/null || die "缺 systemd"
  extract

  say "-- 0/5 探测环境 --"
  detect_hub
  detect_proxy
  detect_proxy_conf
  say "  hub 端口     $HUB_PORT"
  say "  hub 数据库   ${MONITOR_DB:-（没找到）}"

  say "-- 1/5 静态站 --"
  install_site

  say "-- 2/5 联机服 --"
  mkdir -p "$APPDIR"; chmod 755 "$APPDIR"
  backup_file "$APPDIR/farm_server.py"
  install -m 644 "$WORK/server/farm_server.py" "$APPDIR/farm_server.py"
  python3 -c "import ast; ast.parse(open('$APPDIR/farm_server.py', encoding='utf-8').read())" \
    || die "服务端语法检查没过"
  say "  已安装 $APPDIR/farm_server.py（$(stat -c %s "$APPDIR/farm_server.py") 字节）"

  say "-- 3/5 systemd 单元 --"
  backup_file "/etc/systemd/system/$SERVICE.service"
  sed -e "s|__APPDIR__|$APPDIR|g" -e "s|__WS_PORT__|$WS_PORT|g" \
    "$WORK/systemd/cyber-probe.service" > "/etc/systemd/system/$SERVICE.service"
  if grep -q '__APPDIR__\|__WS_PORT__' "/etc/systemd/system/$SERVICE.service"; then
    die "单元模板里有没替换的占位符"
  fi
  chmod 644 "/etc/systemd/system/$SERVICE.service"
  if command -v systemd-analyze >/dev/null 2>&1; then
    if ! systemd-analyze verify "/etc/systemd/system/$SERVICE.service" 2>&1 | grep -q .; then
      say "  单元自检 OK（systemd-analyze verify）"
    else
      say "  ⚠ systemd-analyze 有话说（下面几行）；服务本身可能仍能起来，但如果起不来就回滚备份"
      systemd-analyze verify "/etc/systemd/system/$SERVICE.service" 2>&1 | head -5 | sed 's/^/    /'
    fi
  fi
  local old_pid new_pid act
  old_pid="$(systemctl show "$SERVICE" -p MainPID --value 2>/dev/null || echo 0)"
  systemctl daemon-reload
  systemctl enable "$SERVICE" >/dev/null 2>&1 || true
  systemctl restart "$SERVICE"
  sleep 1.5
  new_pid="$(systemctl show "$SERVICE" -p MainPID --value)"
  act="$(systemctl show "$SERVICE" -p ActiveState --value)"
  say "  状态 $act，pid ${old_pid:-0} → $new_pid"
  if [ "$act" != active ]; then journalctl -u "$SERVICE" -n 20 --no-pager; die "服务没起来"; fi
  if [ "$new_pid" = 0 ] || [ "$new_pid" = "$old_pid" ]; then say "  ⚠ pid 没变（可能本来就没在跑）"; fi

  say "-- 4/5 反代（$PROXY）--"
  case "$PROXY" in
    nginx)
      if [ -f "$NGINX_CONF" ]; then
        if ! grep -q 'connection_upgrade' "$NGINX_CONF"; then
          say "  ⚠ 配置里没有 \$connection_upgrade 映射 → WebSocket 那块可能不工作（对照 hub 的站点配置）"
        fi
        python3 "$WORK/tools/nginx_patch.py" --local --conf "$NGINX_CONF" \
          --ws-port "$WS_PORT" --hub-port "$HUB_PORT" --webroot "$WEBROOT"
      else
        say "  跳过（找不到 $NGINX_CONF，可用 --nginx-conf 指定）"
      fi ;;
    caddy)
      python3 "$WORK/tools/caddy_patch.py" --local --conf "$CADDYFILE" --domain "$DOMAIN" \
        --ws-port "$WS_PORT" --hub-port "$HUB_PORT" --webroot "$WEBROOT"
      say "  （Caddy 的 reverse_proxy 自带 WebSocket 升级，不用额外配 Upgrade 头）" ;;
    none)
      say "  ⚠ 没有在跑的 nginx / Caddy，反代这块跳过了。装好反代后跑这两条即可："
      say "    nginx: python3 $WORK/tools/nginx_patch.py --local --conf /etc/nginx/conf.d/<你的站点>.conf --webroot $WEBROOT"
      say "    Caddy: python3 $WORK/tools/caddy_patch.py  --local --conf /etc/caddy/Caddyfile --domain $DOMAIN --webroot $WEBROOT" ;;
  esac

  say "-- 5/5 验证 --"
  do_status

  say ""
  say "装好了 → $(site_url)"
  say "hub 里增删探测任务后重跑 install 即可刷新名单（会就地重读 hub 数据库）"
}

do_uninstall() {
  need_root
  say "将卸载 cyber-probe：停服+删单元 $SERVICE、删 $APPDIR、$WEBROOT 打包备份后删除、摘反代块（nginx 与 Caddy 都试）"
  if [ "$YES" != 1 ]; then
    printf '确认请输入 yes：'; read -r answer
    [ "${answer:-}" = "yes" ] || { say "已取消"; exit 0; }
  fi
  extract
  systemctl stop "$SERVICE" 2>/dev/null || true
  systemctl disable "$SERVICE" 2>/dev/null || true
  rm -f "/etc/systemd/system/$SERVICE.service"
  systemctl daemon-reload 2>/dev/null || true
  if [ -d "$WEBROOT" ]; then
    local stamp bak
    stamp="$(date +%Y%m%d-%H%M%S)"
    bak="/root/cyber-probe-web-uninstall-$stamp.tgz"
    tar czf "$bak" -C "$(dirname "$WEBROOT")" "$(basename "$WEBROOT")"
    rm -rf "$WEBROOT"
    say "  静态站已备份到 $bak 并删除 $WEBROOT"
  fi
  rm -rf "$APPDIR"
  say "  已删除 $APPDIR"
  detect_hub
  detect_proxy
  detect_proxy_conf
  if [ "$PROXY" = nginx ] && [ -f "$NGINX_CONF" ]; then
    python3 "$WORK/tools/nginx_patch.py" --local --remove --conf "$NGINX_CONF" \
      --ws-port "$WS_PORT" --hub-port "$HUB_PORT" --webroot "$WEBROOT" || true
  fi
  if command -v caddy >/dev/null 2>&1 && [ -f "$CADDYFILE" ]; then
    python3 "$WORK/tools/caddy_patch.py" --local --remove --conf "$CADDYFILE" \
      --ws-port "$WS_PORT" --hub-port "$HUB_PORT" --webroot "$WEBROOT" || true
  fi
  say "卸载完成（hub 与站点其余配置未动）"
}

do_test() {
  need_root
  extract
  [ -f "$WORK/server/test_server.py" ] || die "包里没有 test_server.py"
  say "-- 在机上跑全套服务端自测（127.0.0.1:$WS_PORT）--"
  PYTHONPATH="$APPDIR" python3 "$WORK/server/test_server.py" 127.0.0.1 "$WS_PORT"
}

say "cyber-probe 部署包 · 模式 $MODE"
case "$MODE" in
  install)   do_install ;;
  status)
    extract
    detect_hub; detect_proxy; detect_proxy_conf
    do_status ;;
  restart)
    need_root
    OLD="$(systemctl show "$SERVICE" -p MainPID --value 2>/dev/null || echo 0)"
    systemctl restart "$SERVICE"
    sleep 1.5
    NEW="$(systemctl show "$SERVICE" -p MainPID --value)"
    say "  已重启：pid ${OLD:-0} → $NEW"
    [ "$NEW" != 0 ] && [ "$NEW" != "$OLD" ] || say "  ⚠ pid 没变 → 没真重启"
    do_status ;;
  logs)      journalctl -u "$SERVICE" -n "$LOGS_N" --no-pager ;;
  test)      do_test ;;
  uninstall) do_uninstall ;;
  version)   extract ;;
  *)         usage; exit 2 ;;
esac

exit 0
__ARCHIVE_BELOW__
