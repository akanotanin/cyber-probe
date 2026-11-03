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
SITE_PORT=443         # 站点实际监听端口（探活用；detect_proxy_conf 会按配置改）。给默认值：
                      # restart 模式不探测时也不会被 `set -u` 打成 unbound variable
HUB_PORT=""
MONITOR_DB=""
NGINX_CONF=""
CADDYFILE=""
PROXY=auto            # nginx | caddy | auto | none
NO_GEO=0
GEESE=""             # 场上放养的 NPC·大白鹅数量（空 = 用默认/上次设置）
DOGS=""              # 看门狗数量
SHOW_WEB=1            # 是否出现「网站鸡」
HOT_CPU=55            # CPU% 超过它 → 暴躁鸡
HOT_MEM=85            # 内存% 超过它 → 暴躁鸡
HOT_MAX=0             # 最多几只暴躁鸡（0 = 不限）
FARM_PATH=/chicken/   # 对外挂载路径；/ 表示独立域名挂在根
MOUNT=path            # path = 挂到已有站点的子路径；domain = 独立域名（自己写 vhost）
SETTINGS=/etc/cyber-probe/farm.conf   # 安装器自己的设置（重装/config 都读它）
INTERACTIVE=auto      # auto = 有 TTY 且没给 --yes 时进向导
DRY_RUN=0
FORCE=0
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
                 · 不带参数直接跑 = **交互式向导**（问你要挂在哪、几只鹅、要不要网站鸡……）
                 · 带 --yes 或非交互环境 = 全用默认值/上次设置（CI、批量部署用这个）
  config       改玩法参数（大白鹅/看门狗/网站鸡/暴躁鸡条件），改完立刻生效
  update       拉取 GitHub 最新发布包并升级（保留现有设置与数据）
  status       看现状：单元状态、端口、站点/接口/WebSocket 探活、玩法参数、最近日志
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
  --geese   <数量>        场上放养的 NPC·大白鹅数量（默认 2；0 = 不放养；最多 64）
  --dogs    <数量>        看门狗数量（默认 1；0 = 不养狗；最多 8）
  --show-web <0|1>        是否出现「网站鸡」（默认 1；0 = 只有探针鸡）
  --hot-cpu <百分比>      暴躁鸡的 CPU 阈值（默认 55）
  --hot-mem <百分比>      暴躁鸡的内存阈值（默认 85）
  --hot-max <数量>        最多几只暴躁鸡（默认 0 = 不限；>0 按压力取前 N 只）
  --path    <路径>        对外挂载路径（默认 /chicken/；可给 /farm/ 这种；给 / 则走独立域名）
  --mount   path|domain   挂载方式：path=挂在已有站点子路径（默认），domain=独立域名站点
  --yes, -y               不问任何问题，全用默认值/上次设置
  --dry-run               只打印将要写入的设置，不改系统
  --force                 update 时即使发布页那份比本地旧也覆盖
  -h, --help              这份说明

包内含：站点（index.html/style.css/js/vendor）、server/farm_server.py + test_server.py、
        systemd 单元模板、config.js 生成器、nginx / Caddy 反代补丁工具。
默认公开路径 /chicken/（面板主题的入口按这个路径自动认；可用 --path 改成别的）。
EOF
}

# CLI 显式给过的项，配置文件不许覆盖它
CLI_GEESE=0; CLI_DOGS=0; CLI_WEB=0; CLI_HC=0; CLI_HM=0; CLI_HX=0; CLI_PATH=0; CLI_MOUNT=0
# 自定义安装位置也必须记进设置文件：重装/卸载靠它找回自己那一份，
# 否则会退回默认名去停服/删目录 —— 同机若还装着默认命名的那份，就会被误删。
CLI_NGINX_CONF=0; CLI_SVC=0; CLI_WR=0; CLI_AD=0; CLI_DOMAIN=0; CLI_PROXY=0

while [ $# -gt 0 ]; do
  case "$1" in
    install|config|update|status|restart|logs|test|uninstall|version|selftest) MODE="$1"; shift ;;
    --domain) DOMAIN="$2"; CLI_DOMAIN=1; shift 2 ;;
    --webroot) WEBROOT="$2"; CLI_WR=1; shift 2 ;;
    --appdir) APPDIR="$2"; CLI_AD=1; shift 2 ;;
    --service) SERVICE="$2"; CLI_SVC=1; shift 2 ;;
    --port) WS_PORT="$2"; WS_PORT_SET=1; shift 2 ;;
    --hub-port) HUB_PORT="$2"; shift 2 ;;
    --monitor-db) MONITOR_DB="$2"; shift 2 ;;
    --site-name) SITE_NAME_ARG="$2"; shift 2 ;;
    --geese) GEESE="${2:-}"; CLI_GEESE=1; shift 2 ;;
    --dogs) DOGS="${2:-}"; CLI_DOGS=1; shift 2 ;;
    --show-web) SHOW_WEB="${2:-}"; CLI_WEB=1; shift 2 ;;
    --hot-cpu) HOT_CPU="${2:-}"; CLI_HC=1; shift 2 ;;
    --hot-mem) HOT_MEM="${2:-}"; CLI_HM=1; shift 2 ;;
    --hot-max) HOT_MAX="${2:-}"; CLI_HX=1; shift 2 ;;
    --path) FARM_PATH="${2:-}"; CLI_PATH=1; shift 2 ;;
    --mount) MOUNT="${2:-}"; CLI_MOUNT=1; shift 2 ;;
    --settings) SETTINGS="${2:-}"; shift 2 ;;
    --proxy) PROXY="$2"; CLI_PROXY=1; shift 2 ;;
    --nginx-conf) NGINX_CONF="$2"; CLI_NGINX_CONF=1; shift 2 ;;
    --caddyfile) CADDYFILE="$2"; shift 2 ;;
    --no-geo) NO_GEO=1; shift ;;
    --yes|-y) YES=1; INTERACTIVE=0; shift ;;
    --interactive|-i) INTERACTIVE=1; shift ;;
    --dry-run) DRY_RUN=1; YES=1; shift ;;
    --force) FORCE=1; shift ;;
    -h|--help|help) usage; exit 0 ;;
    [0-9]*) LOGS_N="$1"; shift ;;
    *) die "未知参数 $1（--help 看用法）" ;;
  esac
done

# ---------- 上次安装留下的设置（重装 / config / update 都靠它保持原样）----------
# 这个目录将来会被 rm -rf：只放行「像安装目录」的路径。
# 过严没关系（会回退默认目录），过松就是删系统目录。
safe_dir() {
  local p="${1:-}" norm parent
  case "$p" in /?*|[A-Za-z]:/?*) : ;; *) return 1 ;; esac
  norm="${p%/}"
  # 先规范化再判断：`/var/www/../etc` 字面上像子目录，实际就是 /etc —— 而 uninstall 会
  # `rm -rf` 掉这个目录（2026-11-03 修）。realpath 不可用时退回字面比较（老行为）。
  if command -v realpath >/dev/null 2>&1; then
    local rp
    rp="$(realpath -m -- "$norm" 2>/dev/null || true)"
    if [ -n "$rp" ]; then norm="$rp"; fi
  fi
  case "$norm" in *..*) return 1 ;; esac
  case "$norm" in
    /|/etc|/usr|/bin|/sbin|/lib|/lib64|/boot|/dev|/proc|/sys|/run|/srv|/root|/home|/var|/opt|/tmp|/var/www|/var/lib|/var/log)
      return 1 ;;
    /etc/*|/usr/*|/bin/*|/sbin/*|/lib/*|/lib64/*|/boot/*|/dev/*|/proc/*|/sys/*|/run/*|/root/*|/var/lib/*|/var/log/*)
      return 1 ;;
  esac
  case "$norm" in [A-Za-z]:*) return 0 ;; esac          # Windows 盘符（selftest 在本机跑）
  parent="$(dirname "$norm")"
  case "$parent" in
    /|/etc|/usr|/bin|/sbin|/lib*|/boot|/dev|/proc|/sys|/run|/root|/home|/var|/tmp)
      return 1 ;;
  esac
  return 0
}

# 目录校验：两道防线里的第一道。install 开头也调一次（见 check_dirs 的调用点）。
check_dirs() {
  if [ "${CLI_WR:-0}" = 1 ] && ! safe_dir "$WEBROOT"; then
    die "--webroot '$WEBROOT' 不行：这个目录卸载时会被整个删除，请给 /var/www/<名字> 这种子目录"
  fi
  WEBROOT="${WEBROOT%/}"
  safe_dir "$WEBROOT" || WEBROOT=/var/www/cyber-probe
  if [ "${CLI_AD:-0}" = 1 ] && ! safe_dir "$APPDIR"; then
    die "--appdir '$APPDIR' 不行：这个目录卸载时会被整个删除，请给 /opt/<名字> 这种子目录"
  fi
  APPDIR="${APPDIR%/}"
  safe_dir "$APPDIR" || APPDIR=/opt/cyber-probe
  return 0
}

load_settings() {
  # ⚠ 必须在读文件之前：设置文件不存在时下面会 return，首次安装就完全不校验 ——
  #   真机实测 `--webroot /` 一路走到 `mv / //.cyber-probe.old`（mv 自己拒绝才没出事）。
  check_dirs
  [ -f "$SETTINGS" ] || return 0
  local k v f_mount="" f_path="" f_domain="" f_proxy=""
  while IFS='=' read -r k v; do
    v="$(printf '%s' "$v" | tr -d '\r')"     # 兼容 Windows 上编辑过的设置文件
    case "$k" in ''|'#'*) continue ;; esac
    case "$k" in
      GEESE)     [ "$CLI_GEESE" = 1 ] || GEESE="$v" ;;
      DOGS)      [ "$CLI_DOGS" = 1 ] || DOGS="$v" ;;
      SHOW_WEB)  [ "$CLI_WEB" = 1 ] || SHOW_WEB="$v" ;;
      HOT_CPU)   [ "$CLI_HC" = 1 ] || HOT_CPU="$v" ;;
      HOT_MEM)   [ "$CLI_HM" = 1 ] || HOT_MEM="$v" ;;
      HOT_MAX)   [ "$CLI_HX" = 1 ] || HOT_MAX="$v" ;;
      FARM_PATH) f_path="$v"; [ "$CLI_PATH" = 1 ] || FARM_PATH="$v" ;;
      MOUNT)     f_mount="$v"; [ "$CLI_MOUNT" = 1 ] || MOUNT="$v" ;;
      SITE_NAME) [ -n "${SITE_NAME_ARG:-}" ] || SITE_NAME_ARG="$v" ;;
      WS_PORT)   [ -n "${WS_PORT_SET:-}" ] || WS_PORT="$v" ;;
      # 自定义安装位置：重装/卸载必须找回同一份（否则会去停默认名的服务、删默认目录）
      SERVICE)   [ "$CLI_SVC" = 1 ] || SERVICE="$v" ;;
      WEBROOT)   [ "$CLI_WR" = 1 ] || WEBROOT="$v" ;;
      APPDIR)    [ "$CLI_AD" = 1 ] || APPDIR="$v" ;;
      # 域名只有「上次就是独立域名模式」时才沿用；path 模式下要让 detect_proxy_conf
      # 从站点配置里重新认（否则换了站点、域名还停在上一套）
      DOMAIN)    f_domain="$v"
                 if [ "$f_mount" = domain ] && [ -z "${DOMAIN:-}" ]; then DOMAIN="$v"; fi ;;
      PROXY)     f_proxy="$v" ;;
    esac
  done < "$SETTINGS"
  # 文件里的值可能是坏的（手工编辑过）：读完再校验一次，坏的回退默认
  check_dirs
  # 记下**文件里**的上一次设置（不是已经打上命令行参数的当前值）
  PREV_MOUNT="$f_mount"; PREV_FARM_PATH="$f_path"; PREV_DOMAIN="$f_domain"; PREV_PROXY="$f_proxy"
  return 0
}

# 反代配置存在性：显式给了却不存在就别往下装（以前是悄悄跳过反代、照样报「装好了」）
check_proxy_conf() {
  if [ "${CLI_NGINX_CONF:-0}" = 1 ] && [ "${MOUNT:-path}" = path ] && [ ! -f "${NGINX_CONF:-}" ]; then
    die "--nginx-conf 给的 $NGINX_CONF 不存在（反代没配上就只剩一个没人访问的静态站）"
  fi
  return 0
}

# 端口预检：被别的进程占着就别往下装（否则 systemd 起来 exit 1，留下半装状态，
# 系统日志里那句 Errno 98 用户多半看不到）。自己上一次的实例占着不算冲突。
check_port_free() {
  local holder cur listening
  # ⚠ 不能写 `ss -tln | grep -q`：grep 命中即退出 → ss 收 SIGPIPE → pipefail 把整条管道
  #   判成 141 → 误判「端口空闲」，装完 systemd 起不来（Errno 98）。先收进变量再匹配。
  listening="$(ss -tln 2>/dev/null || true)"
  printf '%s\n' "$listening" | grep -qE ":${WS_PORT}[[:space:]]" || return 0
  cur="$(systemctl show "$SERVICE" -p MainPID --value 2>/dev/null || echo 0)"
  holder="$(ss -tlnp 2>/dev/null | grep -E ":${WS_PORT}[[:space:]]" | grep -oE 'pid=[0-9]+' | head -1 | cut -d= -f2 || true)"
  if [ -n "${holder:-}" ] && [ "$holder" != "${cur:-0}" ]; then
    die "端口 $WS_PORT 已被 pid $holder 占用（$(ps -o comm= -p "$holder" 2>/dev/null | head -1)）——换一个 --port"
  fi
  return 0
}

warn_service_takeover() {
  # 设置文件只有一份：用一个新 --service 装，会把旧安装的归属冲掉 ——
  # 旧单元继续在跑，但 installer 从此不认识它（卸载也找不到）。真机实测过。
  local prev=""
  [ -f "$SETTINGS" ] && prev="$(grep -E '^SERVICE=' "$SETTINGS" 2>/dev/null | head -1 | cut -d= -f2)"
  if [ -n "$prev" ] && [ "$prev" != "$SERVICE" ] && systemctl is-active --quiet "$prev" 2>/dev/null; then
    say "  ⚠ 机器上已有另一份安装在跑（$prev）"
    say "    本次会把设置文件改指向 $SERVICE —— 那一份以后不受本安装器管理"
    say "    想保留它：先按它原来的参数卸载；继续则 10 秒后覆盖设置"
    sleep 10
  fi
}

save_settings() {
  mkdir -p "$(dirname "$SETTINGS")"
  cat > "$SETTINGS" <<EOF
# cyber-probe 安装设置（由 installer 写入；改它等价于跑一次 config）
# 路径 /chicken/ 表示挂在已有站点的子路径；MOUNT=domain 时 FARM_PATH=/
MOUNT=$MOUNT
FARM_PATH=$FARM_PATH
WS_PORT=$WS_PORT
DOMAIN=${DOMAIN:-}
SITE_NAME=${SITE_NAME_ARG:-}
GEESE=$GEESE
DOGS=$DOGS
SHOW_WEB=$SHOW_WEB
HOT_CPU=$HOT_CPU
HOT_MEM=$HOT_MEM
HOT_MAX=$HOT_MAX
SERVICE=$SERVICE
PROXY=$PROXY
WEBROOT=$WEBROOT
APPDIR=$APPDIR
EOF
  chmod 644 "$SETTINGS"
}

# 数值/开关校验（向导里手滑输错不该把服务写坏）
need_int() {   # need_int <名字> <值> [最小值]
  case "$2" in
    ''|*[!0-9]*) die "$1 只接受非负整数（现在是 '$2'）" ;;
  esac
  [ "${3:-0}" = 0 ] || [ "$2" -ge "$3" ] || die "$1 不能小于 $3（现在是 $2）"
}
norm_path() {  # 统一成 /xxx/ ；空 = 默认
  local p="${1:-/chicken/}"
  [ "$p" = "/" ] && { printf '/'; return; }
  p="/${p#/}"; p="${p%/}/"
  printf '%s' "$p"
}

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

# ─────────────────────────── 玩法选项 / 向导 ───────────────────────────

# 把玩法参数落到两个地方：
#   ① 服务端读的文本文件（$APPDIR/geese、$APPDIR/dogs，服务端启动时读）
#   ② 前端读的 js/site-options.js（网站鸡开关、暴躁鸡阈值与上限）
write_options() {
  local web=false
  [ "$SHOW_WEB" = 1 ] && web=true
  mkdir -p "$APPDIR"
  printf '%s
' "$GEESE" > "$APPDIR/geese"
  printf '%s
' "$DOGS"  > "$APPDIR/dogs"
  cat > "$WEBROOT/js/site-options.js" <<EOF
// 由一键安装器写入（$(date +%Y-%m-%d\ %H:%M)）。改这里等价于跑一次 installer 的 config 模式。
// 没有这个文件时前端用同样的默认值（见 js/data.js 顶部）。
window.CP_OPTIONS = {
  showWeb: $web,   // 是否出现「网站鸡」
  hotCpu: $HOT_CPU,    // CPU% 超过它 → 暴躁鸡
  hotMem: $HOT_MEM,    // 内存% 超过它 → 暴躁鸡
  hotMax: $HOT_MAX,    // 最多几只暴躁鸡（0 = 不限）
  modelFallback: '${MODEL_SRC:-}',   // 模型源：本地缺的临时用它顶着（空 = 只用本地）
};
EOF
  chmod 644 "$WEBROOT/js/site-options.js"
  # 模型源另存一份：config 模式重写 site-options.js 时靠它把 modelFallback 带回来
  if [ -n "${MODEL_SRC:-}" ]; then
    printf '%s\n' "$MODEL_SRC" > "$APPDIR/model-cdn"
    chmod 644 "$APPDIR/model-cdn"
  fi
  # 国旗源也记一份：重装时靠它把 vendor/flags 补回来（不记的话没带环境变量重装就全丢）
  if [ -n "${FLAG_CDN:-}" ]; then
    printf '%s\n' "$FLAG_CDN" > "$APPDIR/flag-cdn"
    chmod 644 "$APPDIR/flag-cdn"
  fi
  say "  玩法：大白鹅 ${GEESE} 只 · 看门狗 ${DOGS} 只 · 网站鸡 $([ "$SHOW_WEB" = 1 ] && echo 显示 || echo 隐藏) · 暴躁阈值 CPU>${HOT_CPU}% 内存>${HOT_MEM}% · 上限 ${HOT_MAX:-0}"
}

ask() {        # ask <提示> <默认值>  → 输出用户输入（空则默认）
  # ⚠ 提示必须写 stderr：这个函数是在 $( ) 里调的，写 stdout 会把提示本身也当成答案收进去
  local prompt="$1" def="${2:-}" ans=""
  printf '  %s%s ' "$prompt" "${def:+[$def]}" >&2
  read -r ans || true
  printf '%s' "${ans:-$def}"
}

ask_yes() {    # ask_yes <提示> <y|n>
  local prompt="$1" def="${2:-n}" ans=""
  printf '  %s (%s) ' "$prompt" "$([ "$def" = y ] && echo 'Y/n' || echo 'y/N')" >&2
  read -r ans || true
  ans="${ans:-$def}"
  case "$ans" in [Yy]*) return 0 ;; *) return 1 ;; esac
}

# 交互式向导：全部问题都有默认值，回车即用默认
run_wizard() {
  say ""
  say "═══ 交互式安装向导（直接回车 = 用括号里的默认值）═══"
  say ""
  say "① 挂在哪里"
  say "   1) 挂在现有站点的子路径（默认 /chicken/）—— 不用新域名、不用另签证书"
  say "   2) 给农场一个独立域名（挂在根路径 /）—— 需要把域名解析到本机"
  local m; m="$(ask '选 1 还是 2：' "$([ "$MOUNT" = domain ] && echo 2 || echo 1)")"
  if [ "$m" = 2 ]; then
    MOUNT=domain; FARM_PATH=/
    DOMAIN="$(ask '农场域名（例如 farm.example.com）：' "$DOMAIN")"
    [ -n "$DOMAIN" ] || die "独立域名模式必须给域名"
    # 交互里给的域名等同于命令行 --domain：不置这个标记的话，normalize_settings 的
    # 「必须显式给 --domain」守卫会把向导刚收下的域名当场拒掉（2026-11-03 修）。
    CLI_DOMAIN=1
  else
    MOUNT=path
    FARM_PATH="$(ask '子路径：' "$FARM_PATH")"
  fi
  WS_PORT="$(ask '联机服端口（只监听回环）：' "$WS_PORT")"

  say ""
  say "② 玩法参数"
  GEESE="$(ask '大白鹅几只（0 = 不放养）：' "${GEESE:-2}")"
  DOGS="$(ask '看门狗几只（0 = 不养狗）：' "${DOGS:-1}")"
  if ask_yes '显示「网站鸡」（关掉只留探针鸡）？' "$([ "$SHOW_WEB" = 1 ] && echo y || echo n)"; then SHOW_WEB=1; else SHOW_WEB=0; fi
  HOT_CPU="$(ask '暴躁鸡的 CPU 阈值（%）：' "${HOT_CPU:-55}")"
  HOT_MEM="$(ask '暴躁鸡的内存阈值（%）：' "${HOT_MEM:-85}")"
  HOT_MAX="$(ask '最多几只暴躁鸡（0 = 不限）：' "${HOT_MAX:-0}")"

  normalize_settings
  say ""
  say "③ 确认"
  say "   挂载：$([ "$MOUNT" = domain ] && echo "独立域名 https://$DOMAIN/" || echo "https://$DOMAIN$FARM_PATH")"
  say "   端口：$WS_PORT"
  say "   玩法：鹅 ${GEESE} · 狗 ${DOGS} · 网站鸡 $([ "$SHOW_WEB" = 1 ] && echo 显示 || echo 隐藏) · 暴躁 CPU>${HOT_CPU}% / 内存>${HOT_MEM}% / 上限 ${HOT_MAX}"
  ask_yes '就按这个装？' y || { say '已取消（什么都没改）'; exit 0; }
}

normalize_settings() {
  # 没有设置文件（首次安装 / 刚 uninstall 过）时用默认值
  GEESE="${GEESE:-2}"; DOGS="${DOGS:-1}"; SHOW_WEB="${SHOW_WEB:-1}"
  HOT_CPU="${HOT_CPU:-55}"; HOT_MEM="${HOT_MEM:-85}"; HOT_MAX="${HOT_MAX:-0}"
  FARM_PATH="$(norm_path "$FARM_PATH")"
  [ "$MOUNT" = domain ] && FARM_PATH=/
  need_int '大白鹅数量' "$GEESE"
  need_int '看门狗数量' "$DOGS"
  need_int 'CPU 阈值' "$HOT_CPU" 1
  need_int '内存阈值' "$HOT_MEM" 1
  need_int '暴躁鸡上限' "$HOT_MAX"
  need_int '联机服端口' "$WS_PORT" 1
  # 上限：主循环每帧对 NPC 做 O(N²) 软分离（server/farm_server.py 的 separate_probes），
  # 800 只鹅就已经 126ms/帧（20Hz 的预算是 50ms）→ 联机服追不上帧 = 全场卡死。一个手滑的多余 0 就能触发。
  [ "$GEESE" -le 64 ] || die "大白鹅最多 64 只（再多会把联机服主循环拖死）"
  [ "$DOGS"  -le 8 ] || die "看门狗最多 8 只"
  [ "$HOT_CPU" -le 100 ] || die "CPU 阈值要 ≤100"
  [ "$HOT_MEM" -le 100 ] || die "内存阈值要 ≤100"
  case "$SHOW_WEB" in 1|0) ;; *) die "--show-web 只接受 0 或 1" ;; esac
  case "$MOUNT" in path|domain) ;; *) die "--mount 只接受 path 或 domain" ;; esac
  # 独立域名必须显式给域名：DOMAIN 会被 detect_hub / detect_proxy_conf 填成 hub 或别的站点的域名，
  # 拿它去生成 vhost 会跟已有站点抢 server_name（农场域名反而没生效）
  if [ "$MOUNT" = domain ] && [ "${CLI_DOMAIN:-0}" != 1 ]; then
    # 只有「上一套本来就是 domain」才允许沿用设置文件里的域名；首次切 domain 必须显式给，
    # 因为此时 DOMAIN 可能是 detect_hub / 现有站点 server_name 探测出来的（别人的域名）
    if [ "${PREV_MOUNT:-}" != domain ] || [ -z "${PREV_DOMAIN:-}" ]; then
      die "domain 模式需要显式给 --domain <农场域名>（现在拿到的是「${DOMAIN:-空}」，可能是探测到的 hub 域名）"
    fi
  fi
  if [ "$MOUNT" = path ] && [ "$FARM_PATH" = / ]; then
    die "路径给的是 / —— 想挂在根就用 --mount domain（独立域名），别把别人站点的根顶掉"
  fi
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
  for u in $(printf '%s\n' "$names" | grep -iE 'monitor|hub' | grep -viE 'agent' || true); do printf '%s' "$u"; return 0; done
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
    local ssout
    ssout="$(ss -tlnp 2>/dev/null || true)"     # 先收变量：`| grep -q`/`head` 会 SIGPIPE
    HUB_PORT="$(printf '%s\n' "$ssout" | grep -iE 'monitor(-hub)?' | grep -oE '127\.0\.0\.1:[0-9]+' \
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
    # ⚠ 也必须排除我们自己写的 vhost（cyber-probe-<域名>.conf）：它的 /api、/admin 里
    #   同样有 proxy_pass …:hub_port。domain→path 切换时若把它当成目标站点，下一步
    #   need_clean 会先把它删掉，反代步骤就找不到文件、静默跳过（2026-11-03 复审修）。
    # 上游写法不止 127.0.0.1：localhost / [::1] 很常见，漏了就会去改一个不相关的站点。
    local up_pat
    up_pat="proxy_pass[[:space:]]+http://(127\.0\.0\.1|localhost|\[::1\]):${HUB_PORT}"
    NGINX_CONF="$(grep -rlE "$up_pat" \
      /etc/nginx/conf.d /etc/nginx/sites-enabled /etc/nginx/sites-available 2>/dev/null \
      | grep -vE '\.bak-|\.orig$|\.save$|\.disabled|\.dpkg-|~$' \
      | grep -vE '/cyber-probe-[^/]*\.conf$' | head -1 || true)"
  fi
  if [ -z "$NGINX_CONF" ] && [ "$PROXY" = nginx ]; then
    # 以前这里会兜底成「conf.d 里第一个 .conf」—— 那是在赌，改错站点还会报成功。
    # 现在留空，让第 4 步直接报错并提示 --nginx-conf，别再静默改别人的站点。
    say "  ⚠ 没找到反代到 hub 的 nginx 站点配置（找过 127.0.0.1/localhost/[::1]:$HUB_PORT）"
    say "    用 --nginx-conf /etc/nginx/conf.d/<你的站点>.conf 指定"
  fi
  if [ -z "$CADDYFILE" ]; then
    CADDYFILE="$(systemctl show caddy -p ExecStart --value 2>/dev/null \
      | grep -oE '\-\-config[= ][^ ]*' | head -1 | sed -E 's/^--config[= ]//' || true)"
  fi
  [ -n "$CADDYFILE" ] || CADDYFILE=/etc/caddy/Caddyfile

  # 站点实际域名：path 模式下以「要打补丁的那个站点」为准（nginx 的 server_name /
  # Caddy 站点块地址）。⚠ 从 domain 切回 path 时，load_settings 会把上一套农场域名带进
  # DOMAIN；不换掉的话，探活、--resolve、最后的 site_url 全指向错的 vhost
  #（2026-11-03 KuromiX3 真机复现：切回 path 后仍打印 https://旧农场域名/chicken/）。
  local site_host="" sns=""
  if [ "$PROXY" = nginx ]; then
    say "  nginx 配置   ${NGINX_CONF:-（没找到，用 --nginx-conf 指定）}"
    if [ -f "${NGINX_CONF:-/nonexistent}" ]; then
      sns="$(grep -oE 'server_name[[:space:]]+[^;]+' "$NGINX_CONF" | head -1 \
        | sed -E 's/server_name[[:space:]]+//; s/[[:space:]]+/ /g' || true)"
      site_host="$(printf '%s\n' "$sns" | tr ' ' '\n' | grep -v '^_' | head -1 || true)"
    fi
  elif [ "$PROXY" = caddy ]; then
    say "  Caddyfile    $CADDYFILE"
    if [ -f "${CADDYFILE:-/nonexistent}" ]; then
      # 找「含 hub 上游」的站点块，取它的地址（example.com / :8080 / http://example.com）
      local ln_c addr_c
      ln_c="$(grep -nF -e "127.0.0.1:${HUB_PORT}" -e "localhost:${HUB_PORT}" "$CADDYFILE" 2>/dev/null \
              | head -1 | cut -d: -f1 || true)"
      if [ -n "${ln_c:-}" ]; then
        addr_c="$(head -n "$ln_c" "$CADDYFILE" \
          | grep -E '^[[:space:]]*[^#[:space:]].*\{[[:space:]]*$' | tail -1 \
          | sed -E 's/[[:space:]]*\{[[:space:]]*$//; s/^[[:space:]]+//' || true)"
        site_host="$(printf '%s' "$addr_c" | awk '{print $1}')"
        site_host="${site_host#http://}"; site_host="${site_host#https://}"; site_host="${site_host%%:*}"
      fi
    fi
  fi
  if [ "${MOUNT:-path}" = path ] && [ "${CLI_DOMAIN:-0}" != 1 ] && [ -n "${site_host:-}" ] \
     && printf '%s' "$site_host" | grep -qE '^[A-Za-z0-9.-]+$'; then
    if [ -z "${DOMAIN:-}" ] || [ "${PREV_MOUNT:-}" = domain ]; then
      DOMAIN="$site_host"          # 首次安装 / 刚从 domain 切过来
    elif [ -n "$sns" ] && ! printf '%s\n' "$sns" | tr ' ' '\n' | grep -qxF "$DOMAIN"; then
      DOMAIN="$site_host"          # 设置里的域名不在这个站点的 server_name 里（换过站点）
    fi
  fi
  [ -n "$DOMAIN" ] || DOMAIN="$(hostname -f 2>/dev/null || hostname)"
  say "  对外域名     $DOMAIN"

  # 站点实际监听端口（探活用）：nginx 未必是 443（本机测试站点常在 8080），Caddy 看站点地址。
  SITE_PORT=443
  local p domconf
  domconf="/etc/nginx/conf.d/cyber-probe-${DOMAIN:-}.conf"
  if [ "${MOUNT:-path}" = domain ]; then
    # 独立域名模式：只探**自己**这份 vhost 的端口。首次安装时 vhost 还没写，
    # 以前会回落到上一套 path 站点的端口（比如别人的 8080）→ --resolve 打到别人站点上，
    # 明明农场 vhost 没生效也可能报 200。现在文件不存在就按 443 试（会再试 80）。
    if [ -f "$domconf" ]; then
      p="$(grep -E '^[[:space:]]*listen[[:space:]]+[0-9]+' "$domconf" 2>/dev/null | grep -oE '[0-9]+' | head -1 || true)"
      if [ -n "$p" ]; then SITE_PORT="$p"; fi
    fi
  elif [ "$PROXY" = nginx ] && [ -f "${NGINX_CONF:-/nonexistent}" ]; then
    p="$(grep -E '^[[:space:]]*listen[[:space:]]+[0-9]+' "$NGINX_CONF" 2>/dev/null | grep -oE '[0-9]+' | head -1 || true)"
    [ -n "$p" ] && SITE_PORT="$p"
  elif [ "$PROXY" = caddy ] && [ -f "${CADDYFILE:-/nonexistent}" ]; then
    # 取「含 hub 上游」的那个站点块的地址端口：Caddyfile 里可能还有别的 `:端口 {`
    # （管理端点、别的 vhost），取第一个带端口的块会探错站点（2026-11-03 复审修）。
    local ln addr
    ln="$(grep -nF -e "127.0.0.1:${HUB_PORT}" -e "localhost:${HUB_PORT}" "$CADDYFILE" 2>/dev/null \
          | head -1 | cut -d: -f1 || true)"
    if [ -n "${ln:-}" ]; then
      addr="$(head -n "$ln" "$CADDYFILE" | grep -E '^[[:space:]]*[^#[:space:]].*\{[[:space:]]*$' | tail -1 || true)"
    else
      addr="$(grep -E '^[[:space:]]*[^#[:space:]].*\{[[:space:]]*$' "$CADDYFILE" 2>/dev/null | head -1 || true)"
    fi
    p="$(printf '%s' "${addr:-}" | grep -oE ':[0-9]+' | head -1 | tr -d ':' || true)"
    [ -n "$p" ] && SITE_PORT="$p"
  fi
  say "  站点端口     $SITE_PORT"
}

# ─────────────────────────── 各步 ───────────────────────────

gen_config() {
  local out="$1" extra="" res nm="${SITE_NAME_ARG:-}"
  [ "$NO_GEO" = 1 ] && extra="--no-geo"
  # 站名与国旗缓存都要落在 APPDIR：首次安装时它还没建，以前这行在 if 里静默失败
  mkdir -p "$APPDIR" 2>/dev/null || true
  # 站名：命令行给了就用它（并落盘，重跑安装不丢）；没给就沿用上次落盘的
  if [ -n "$nm" ]; then
    printf '%s\n' "$nm" > "$APPDIR/site-name" 2>/dev/null || true
  elif [ -f "$APPDIR/site-name" ]; then
    nm="$(head -1 "$APPDIR/site-name")"
  fi
  if [ -n "$MONITOR_DB" ] && [ -f "$MONITOR_DB" ]; then
    # shellcheck disable=SC2086
    # 缓存放 APPDIR（持久）：以前放 $WORK，而 $WORK 是 /tmp 下的解包目录、脚本退出就删，
    # 于是每次重跑 install 都重新解析+查一遍国旗接口（批量接口有频率限制，网络抖就少国旗）
    if res="$(python3 "$WORK/tools/gen_config.py" --db "$MONITOR_DB" --out "$out" \
               --cache "$APPDIR/flag_cache.json" $extra --site-name "$nm" 2>&1)"; then
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

model_src() {
  if [ -n "${MODEL_CDN:-}" ]; then printf '%s' "$MODEL_CDN"; return; fi
  if [ -f "$WORK/tools/.model-cdn" ]; then head -1 "$WORK/tools/.model-cdn" | tr -d '\r\n '; return; fi
  # 上次安装落盘的模型源：config 模式下 $WORK 里没有开发机设置，也要能沿用（否则会被抹成空）
  if [ -f "$APPDIR/model-cdn" ]; then head -1 "$APPDIR/model-cdn" | tr -d '\r\n '; fi
}

flag_src() {
  if [ -n "${FLAG_CDN:-}" ]; then printf '%s' "$FLAG_CDN"; return; fi
  if [ -f "$WORK/tools/.flag-cdn" ]; then head -1 "$WORK/tools/.flag-cdn" | tr -d '\r\n '; return; fi
  if [ -f "$APPDIR/flag-cdn" ]; then head -1 "$APPDIR/flag-cdn" | tr -d '\r\n '; fi
}

install_site() {
  # 第二道防线：这里会 mv/rm 整个目录，绝不能是根
  case "$WEBROOT" in /|'') die "拒绝把根目录当作静态站目录（WEBROOT='$WEBROOT'）" ;; esac
  local parent; parent="$(dirname "$WEBROOT")"
  # 暂存目录名带 PID：同一父目录下装两份（不同 --webroot）时，固定名会互相覆盖
  local stage="$parent/.cyber-probe.new.$$" old="$parent/.cyber-probe.old.$$"
  rm -rf "$stage"; mkdir -p "$stage"
  cp -a "$WORK/site/." "$stage/"
  gen_config "$stage/js/config.js"
  # 模型/国旗本体：许可不允许随包分发，所以在这里现下（失败只告警，站点会退回自建道具）。
  # ⚠ install 会整体替换 webroot：上次配置过的源必须沿用，否则重装一次模型/国旗就全丢了
  #   （以前只有当前环境变量里带着 MODEL_CDN/FLAG_CDN 才会补回来）。
  local msrc fsrc
  msrc="$(model_src)"
  fsrc="$(flag_src)"
  if [ -f "$WORK/tools/fetch_flags.sh" ]; then
    FLAG_CDN="$fsrc" bash "$WORK/tools/fetch_flags.sh" "$stage/vendor/flags" 2>&1 | sed 's/^/    /' || true
  fi
  if [ -f "$WORK/tools/fetch_models.sh" ]; then
    MODEL_CDN="$msrc" bash "$WORK/tools/fetch_models.sh" "$stage/vendor/models" 2>&1 | sed 's/^/    /' ||       say "  ⚠ 模型没下全（不影响可玩：这些道具会用自建版；联网后重跑 install 即可补上）"
  fi
  find "$stage" -type d -exec chmod 755 {} +
  find "$stage" -type f -exec chmod 644 {} +
  # ★ 资源 URL 打版本号（绕开 Cloudflare 的浏览器缓存，默认 4 小时）：
  #   不打的话「新 index.html + 旧缓存的 js」= 协议对不上（服务端字段改过就整片鸡不动/报错）。
  if [ -f "$WORK/tools/cachebust.py" ]; then
    python3 "$WORK/tools/cachebust.py" "$stage" "$(date +%Y%m%d%H%M%S)" | sed 's/^/    /'
  fi
  printf '%s\n' "$(cat "$WORK/VERSION" 2>/dev/null || echo unknown)" > "$stage/version.txt"
  chmod 644 "$stage/version.txt"
  rm -rf "$old"
  if [ -d "$WEBROOT" ]; then mv "$WEBROOT" "$old"; fi
  mv "$stage" "$WEBROOT"
  rm -rf "$old"
  say "  静态站就位 $WEBROOT（$(find "$WEBROOT" -type f | wc -l) 个文件，$(du -sh "$WEBROOT" | cut -f1)）"
}

site_url() { printf 'https://%s%s' "$DOMAIN" "$FARM_PATH"; }

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
        "$s://$DOMAIN:$p${FARM_PATH}ws" 2>/dev/null | head -1 || true)"
      case "$line" in *101*|*"Switching Protocols"*) printf '%s (端口 %s)' "$line" "$p"; return 0 ;; esac
    done
  done
  printf '%s' "${line:-（curl 失败）}"
}

do_status() {
  # ⚠ 独立域名模式的 vhost 是**安装过程中**才写的：step 0 探测时文件还不存在，SITE_PORT 会停在 443，
  #   探活就先打到 443 上的别的服务（实测 KuromiX3 的 xray 回 403，被当成「站点状态」）。
  #   所以探活前按 vhost 再读一次端口（path 模式不变）。
  if [ "${MOUNT:-path}" = domain ] && [ -n "${DOMAIN:-}" ]; then
    local _p
    _p="$(grep -E '^[[:space:]]*listen[[:space:]]+[0-9]+' "/etc/nginx/conf.d/cyber-probe-${DOMAIN}.conf" 2>/dev/null \
          | grep -oE '[0-9]+' | head -1 || true)"
    if [ -n "$_p" ]; then SITE_PORT="$_p"; fi
  fi
  say "· systemd     $(systemctl show "$SERVICE" -p ActiveState --value 2>/dev/null || echo '无此单元') / $(systemctl show "$SERVICE" -p SubState --value 2>/dev/null)  pid=$(systemctl show "$SERVICE" -p MainPID --value 2>/dev/null || echo -)"
  say "· 端口 $WS_PORT  $(ss -tlnp 2>/dev/null | awk -v p=":$WS_PORT" '$4 ~ p {print $4" ("$6")"}' | head -1)"
  say "· 站点版本    $([ -f "$WEBROOT/version.txt" ] && cat "$WEBROOT/version.txt" || echo '未知（没打过包）')"
  say "· 挂载方式    $MOUNT · 路径 $FARM_PATH$([ -f "$SETTINGS" ] && echo "（$SETTINGS）" || echo '（没找到设置文件，用默认值）')"
  say "· 玩法参数    鹅 $([ -f "$APPDIR/geese" ] && head -1 "$APPDIR/geese" || echo 2) · 狗 $([ -f "$APPDIR/dogs" ] && head -1 "$APPDIR/dogs" || echo 1) · 网站鸡 $(grep -q 'showWeb: true' "$WEBROOT/js/site-options.js" 2>/dev/null && echo 显示 || echo 隐藏) · $(grep -oE 'hotCpu: [0-9]+|hotMem: [0-9]+|hotMax: [0-9]+' "$WEBROOT/js/site-options.js" 2>/dev/null | tr '
' ' ')"
  say "· 生成于      $([ -f "$WEBROOT/js/config.js" ] && grep -oE 'GENERATED_AT = "[^"]*"' "$WEBROOT/js/config.js" | head -1 | cut -d'"' -f2 || echo '（没生成）')"
  say "· ${FARM_PATH}         $(probe_code "$FARM_PATH")"
  say "· ${FARM_PATH}api/     $(probe_code "${FARM_PATH}api/nodes")"
  say "· ${FARM_PATH}ws       $(probe_ws)"
  say '· 最近日志'
  journalctl -u "$SERVICE" -n 3 --no-pager 2>/dev/null | sed 's/^/    /' || true
}

do_install() {
  normalize_settings
  if [ "$DRY_RUN" = 1 ]; then
    say "（--dry-run：只打印将要写入的设置，不改系统）"
    say "  MOUNT=$MOUNT  FARM_PATH=$FARM_PATH  WS_PORT=$WS_PORT  DOMAIN=${DOMAIN:-（自动探测）}"
    say "  GEESE=$GEESE  DOGS=$DOGS  SHOW_WEB=$SHOW_WEB  HOT_CPU=$HOT_CPU  HOT_MEM=$HOT_MEM  HOT_MAX=$HOT_MAX"
    say "  SETTINGS=$SETTINGS  WEBROOT=$WEBROOT  APPDIR=$APPDIR"
    return 0
  fi
  need_root
  command -v python3 >/dev/null || die "缺 python3（生成 config.js 与反代补丁都要它）"
  command -v systemctl >/dev/null || die "缺 systemd"

  # 交互式向导：默认走（有 TTY 且没给 --yes）；CI/管道里自动跳过
  if [ "$INTERACTIVE" = auto ]; then
    if [ "$YES" != 1 ] && [ -t 0 ]; then INTERACTIVE=1; else INTERACTIVE=0; fi
  fi
  extract

  say "-- 0/6 探测环境 --"
  detect_hub
  detect_proxy
  detect_proxy_conf
  say "  hub 端口     $HUB_PORT"
  say "  hub 数据库   ${MONITOR_DB:-（没找到）}"
  [ "$INTERACTIVE" = 1 ] && run_wizard
  normalize_settings
  # 三项必须在动任何文件之前查：晚一步失败就会留下半装状态（目录、单元、反代块）
  check_dirs
  check_proxy_conf
  check_port_free
  # ⚠ 接管提示必须在**写设置之前**：设置只有一份，save_settings 一落盘 SERVICE 就变成当前值，
  #   warn_service_takeover 再读就永远「prev == 当前」，警告再也触发不了（复审回归）。
  #   放在动任何文件之前也更合理 —— 木已成舟再提示就没意义了。
  warn_service_takeover
  # 先把设置落盘：后面任何一步失败（反代自检不过、被 Ctrl-C），uninstall 仍能按这份设置
  # 找回自定义的 webroot/appdir/service/port，而不是退回默认路径停错服务、删错目录。
  save_settings
  say "  设置已写入 $SETTINGS（中途失败也能按它卸载）"

  say "-- 1/6 静态站 --"
  install_site

  say "-- 2/6 联机服 --"
  mkdir -p "$APPDIR"; chmod 755 "$APPDIR"
  backup_file "$APPDIR/farm_server.py"
  install -m 644 "$WORK/server/farm_server.py" "$APPDIR/farm_server.py"
  # 路径用 argv 传：拼进 -c 的字符串时，--appdir 里带单引号就会破坏语法（root 自伤，但属缺陷）
  python3 - "$APPDIR/farm_server.py" <<'PYCHECK' || die "服务端语法检查没过"
import ast, sys
ast.parse(open(sys.argv[1], encoding='utf-8').read())
PYCHECK
  say "  已安装 $APPDIR/farm_server.py（$(stat -c %s "$APPDIR/farm_server.py") 字节）"
  MODEL_SRC="$(model_src)"
  write_options          # geese / dogs 文本 + js/site-options.js

  say "-- 3/6 systemd 单元 --"
  # 接管提示已经提前到「写设置之前」（见 do_install 开头）：这里不能再调 —— 设置里的
  # SERVICE 已经是当前值，比不出「旧的另一份安装」了。
  backup_file "/etc/systemd/system/$SERVICE.service"
  local pybin; pybin="$(command -v python3)"
  sed -e "s|__APPDIR__|$APPDIR|g" -e "s|__WS_PORT__|$WS_PORT|g" -e "s|__PYTHON__|$pybin|g"     "$WORK/systemd/cyber-probe.service" > "/etc/systemd/system/$SERVICE.service"
  if grep -q '__APPDIR__\|__WS_PORT__\|__PYTHON__' "/etc/systemd/system/$SERVICE.service"; then
    die "单元模板里有没替换的占位符"
  fi
  chmod 644 "/etc/systemd/system/$SERVICE.service"
  if command -v systemd-analyze >/dev/null 2>&1; then
    # 先收进变量再判断：`cmd | grep -q` 在 pipefail 下会被 SIGPIPE 变成 141，
    # 「有话说」会被误判成「自检 OK」（子代理审查指出）
    local vout
    vout="$(systemd-analyze verify "/etc/systemd/system/$SERVICE.service" 2>&1 || true)"
    if [ -z "$vout" ]; then
      say "  单元自检 OK（systemd-analyze verify）"
    else
      say "  ⚠ systemd-analyze 有话说（下面几行）；服务本身可能仍能起来，但如果起不来就回滚备份"
      printf '%s
' "$vout" | head -5 | sed 's/^/    /' || true
    fi
  fi
  local old_pid new_pid act
  old_pid="$(systemctl show "$SERVICE" -p MainPID --value 2>/dev/null || echo 0)"
  check_port_free
  systemctl daemon-reload
  systemctl enable "$SERVICE" >/dev/null 2>&1 || true
  systemctl restart "$SERVICE"
  sleep 1.5
  new_pid="$(systemctl show "$SERVICE" -p MainPID --value)"
  act="$(systemctl show "$SERVICE" -p ActiveState --value)"
  say "  状态 $act，pid ${old_pid:-0} → $new_pid"
  if [ "$act" != active ]; then journalctl -u "$SERVICE" -n 20 --no-pager; die "服务没起来（已写入的目录/单元可用 sudo bash $SELF uninstall --yes 清掉）"; fi
  if [ "$new_pid" = 0 ] || [ "$new_pid" = "$old_pid" ]; then say "  ⚠ pid 没变（可能本来就没在跑）"; fi

  # 换了挂载方式或路径：先把上一套摘掉，再装新的（不然旧块会一直留在配置里）
  local need_clean=0
  [ -n "${PREV_MOUNT:-}" ] && [ "$PREV_MOUNT" != "$MOUNT" ] && need_clean=1
  [ -n "${PREV_FARM_PATH:-}" ] && [ "$PREV_FARM_PATH" != "$FARM_PATH" ] && need_clean=1
  [ "${PREV_MOUNT:-}" = domain ] && [ "${PREV_DOMAIN:-}" != "$DOMAIN" ] && need_clean=1
  # 只换反代（nginx ↔ Caddy）也要清旧块：两边都留着 location/import 会指向同一个上游，重复路由。
  # `auto` 是「还没探测」的占位（config 模式下会原样存进设置文件），不当真。
  case "${PREV_PROXY:-}" in
    ''|auto) ;;
    *) [ "$PREV_PROXY" != "$PROXY" ] && need_clean=1 ;;
  esac
  if [ "$need_clean" = 1 ]; then
    say "  挂载方式有变（${PREV_MOUNT} ${PREV_FARM_PATH:-} → ${MOUNT} ${FARM_PATH}），先摘掉旧的"
    if [ "$PREV_MOUNT" = domain ]; then
      python3 "$WORK/tools/vhost.py" --proxy nginx --remove --domain "${PREV_DOMAIN:-$DOMAIN}" >/dev/null 2>&1 \
        || say "  ⚠ 旧的 nginx vhost 没摘掉，装完请检查 /etc/nginx/conf.d/"
      python3 "$WORK/tools/vhost.py" --proxy caddy --remove --domain "${PREV_DOMAIN:-$DOMAIN}" --conf "$CADDYFILE" >/dev/null 2>&1 \
        || say "  ⚠ 旧的 Caddy vhost/import 没摘干净，装完请检查 $CADDYFILE"
    else
      if [ -n "${NGINX_CONF:-}" ]; then
        python3 "$WORK/tools/nginx_patch.py" --local --no-reload --remove --conf "$NGINX_CONF" \
          --ws-port "$WS_PORT" --hub-port "$HUB_PORT" --webroot "$WEBROOT" --path "${PREV_FARM_PATH:-/chicken/}" >/dev/null 2>&1 \
          || say "  ⚠ 旧的 nginx 块没摘干净，装完请检查 $NGINX_CONF"
      fi
      python3 "$WORK/tools/caddy_patch.py" --local --no-reload --remove --conf "$CADDYFILE" \
        --ws-port "$WS_PORT" --hub-port "$HUB_PORT" --webroot "$WEBROOT" --path "${PREV_FARM_PATH:-/chicken/}" >/dev/null 2>&1 \
        || say "  ⚠ 旧的 Caddy 片段/import 没摘干净，装完请检查 $CADDYFILE"
    fi
  fi

  check_proxy_conf
  say "-- 4/6 反代（$PROXY · $MOUNT 模式）--"
  if [ "$MOUNT" = domain ]; then
    # 独立域名：自己写一份完整的 vhost（删文件即卸载，不碰别人的配置）
    case "$PROXY" in
      nginx)
        python3 "$WORK/tools/vhost.py" --proxy nginx --domain "$DOMAIN" --webroot "$WEBROOT"           --ws-port "$WS_PORT" --hub-port "$HUB_PORT" ;;
      caddy)
        # ⚠ 必须把探测到的 Caddyfile 传进去：vhost.py 不给 --conf 就固定用 /etc/caddy/Caddyfile，
        #   caddy 用自定义 --config 启动时 import 会加错文件（站点 404，卸载也摘不掉）。
        python3 "$WORK/tools/vhost.py" --proxy caddy --domain "$DOMAIN" --webroot "$WEBROOT"           --ws-port "$WS_PORT" --hub-port "$HUB_PORT" --conf "$CADDYFILE" ;;
      none)
        say "  ⚠ 没有在跑的 nginx / Caddy：站点文件已经装好；装好反代后**重跑**这条命令即可补上 vhost："
        say "    sudo bash $SELF install --mount domain --domain $DOMAIN --yes" ;;
    esac
  else
    case "$PROXY" in
      nginx)
        if [ -z "${NGINX_CONF:-}" ] || [ ! -f "$NGINX_CONF" ]; then
          # 以前是「跳过」并照样报装好了 —— 站点装完却没有任何路由，用户只会看到 404。
          die "找不到要打补丁的 nginx 站点配置（探测到：${NGINX_CONF:-无}）。用 --nginx-conf /etc/nginx/conf.d/<你的站点>.conf 指定后重跑"
        fi
        # 旧版这里会警告「没有 $connection_upgrade 映射」—— 假警告：我们插的块用的是
        # 字面量 Connection "upgrade"，不引用任何需要自定义 map 的变量（2026-11-03 删）。
        python3 "$WORK/tools/nginx_patch.py" --local --conf "$NGINX_CONF"           --ws-port "$WS_PORT" --hub-port "$HUB_PORT" --webroot "$WEBROOT" --path "$FARM_PATH" ;;
      caddy)
        python3 "$WORK/tools/caddy_patch.py" --local --conf "$CADDYFILE" --domain "$DOMAIN"           --ws-port "$WS_PORT" --hub-port "$HUB_PORT" --webroot "$WEBROOT" --path "$FARM_PATH"
        say "  （Caddy 的 reverse_proxy 自带 WebSocket 升级，不用额外配 Upgrade 头）" ;;
      none)
        say "  ⚠ 没有在跑的 nginx / Caddy，反代这块跳过了；装好反代后**重跑** install 即可补上："
        say "    sudo bash $SELF install --yes --nginx-conf /etc/nginx/conf.d/<你的站点>.conf"
        say "    （Caddy：加 --proxy caddy --caddyfile /etc/caddy/Caddyfile）" ;;
    esac
  fi

  say "-- 5/6 记下设置 --"
  save_settings
  say "  $SETTINGS（重装/config/update 都读它）"

  say "-- 6/6 验证 --"
  do_status

  say ""
  # domain+nginx 的 vhost 模板只 listen 80：还没签证书时给 https 链接是死链
  # （KuromiX3 真机复现：装完打印 https://… 实际只有 http 能开）。证书签好后 vhost 里会有
  # listen 443，这里自然回到 https。
  local domconf2="/etc/nginx/conf.d/cyber-probe-${DOMAIN}.conf"
  if [ "$MOUNT" = domain ] && [ "$PROXY" = nginx ] \
     && ! grep -qE '^[[:space:]]*listen[[:space:]]+443' "$domconf2" 2>/dev/null; then
    say "装好了 → http://$DOMAIN/（还没配证书：按上面的 certbot 命令签好后再用 https）"
  else
    say "装好了 → $(site_url)"
  fi
  say "改玩法参数：sudo bash $SELF config      升级：sudo bash $SELF update"
  say "hub 里增删探测任务后重跑 install 即可刷新名单（会就地重读 hub 数据库）"
}

# 改玩法参数：交互式逐项问（回车保留原值），写完立刻重启联机服生效
do_config() {
  need_root
  # 安装类参数只该在 install 时用：config 不重写 unit、不重打反代块、也不搬目录，
  # 只把它们写进设置 → 会出现「设置说 28999、服务还监听 28910」这种自相矛盾（复审修）。
  if [ "${WS_PORT_SET:-0}" = 1 ] || [ "$CLI_PROXY" = 1 ] || [ "$CLI_MOUNT" = 1 ] \
     || [ "$CLI_PATH" = 1 ] || [ "$CLI_DOMAIN" = 1 ] || [ "$CLI_WR" = 1 ] \
     || [ "$CLI_AD" = 1 ] || [ "$CLI_SVC" = 1 ]; then
    die "config 只改玩法参数（鹅/狗/网站鸡/暴躁阈值）；端口、挂载、路径、域名、目录、反代请重跑 install"
  fi
  normalize_settings
  if [ "$INTERACTIVE" = auto ]; then
    if [ "$YES" != 1 ] && [ -t 0 ]; then INTERACTIVE=1; else INTERACTIVE=0; fi
  fi
  say "当前设置：$SETTINGS"
  say "  挂载 $MOUNT $FARM_PATH · 端口 $WS_PORT · 鹅 ${GEESE:-2} · 狗 ${DOGS:-1} · 网站鸡 $([ "$SHOW_WEB" = 1 ] && echo 显示 || echo 隐藏)"
  say "  暴躁阈值 CPU>${HOT_CPU}% 内存>${HOT_MEM}% · 上限 ${HOT_MAX:-0}"
  if [ "$INTERACTIVE" = 1 ]; then
    say ""
    say "直接回车 = 保持原值"
    GEESE="$(ask '大白鹅几只：' "${GEESE:-2}")"
    DOGS="$(ask '看门狗几只：' "${DOGS:-1}")"
    if ask_yes '显示「网站鸡」？' "$([ "$SHOW_WEB" = 1 ] && echo y || echo n)"; then SHOW_WEB=1; else SHOW_WEB=0; fi
    HOT_CPU="$(ask '暴躁鸡 CPU 阈值（%）：' "${HOT_CPU:-55}")"
    HOT_MEM="$(ask '暴躁鸡内存阈值（%）：' "${HOT_MEM:-85}")"
    HOT_MAX="$(ask '最多几只暴躁鸡（0 = 不限）：' "${HOT_MAX:-0}")"
    normalize_settings
    ask_yes '保存并生效？' y || { say '已取消（什么都没改）'; exit 0; }
  fi
  extract
  # 没装过就别往下写：`cat > $WEBROOT/js/site-options.js` 在目录不存在时失败，
  # set -e 直接退出，用户只看到一行 "No such file or directory"
  [ -d "$WEBROOT" ] || die "还没安装（$WEBROOT 不存在）—— 先跑一次 install"
  mkdir -p "$APPDIR"
  # ⚠ 必须沿用上次的模型源：do_config 里 MODEL_SRC 默认是空的，直接 write_options 会把
  #   安装时写进 site-options.js 的 modelFallback 抹成空串（缺失模型就不再从该源补）
  MODEL_SRC="$(model_src)"
  write_options
  save_settings
  # 改了 site-options.js 也要换缓存戳：CF 橙云的浏览器缓存默认 4 小时，
  # 不换的话「改完刷新即生效」在 Cloudflare 后面不成立（2026-11-03 修）
  if [ -f "$WORK/tools/cachebust.py" ]; then
    python3 "$WORK/tools/cachebust.py" "$WEBROOT" "$(date +%Y%m%d%H%M%S)" | sed 's/^/    /' || true
  fi
  # ⚠ 不能写成 `systemctl ... | grep -q xxx`：grep 找到就退出 → 上游收 SIGPIPE →
  #   pipefail 把整条管道判成非零 → 条件永远为假（hub_unit 里踩过同样的坑）。
  local units
  units="$(systemctl list-unit-files 2>/dev/null | awk '{print $1}' || true)"
  if echo "$units" | grep -qx "$SERVICE.service"; then
    systemctl restart "$SERVICE"; sleep 1.2
    say "  已重启 $SERVICE（$(systemctl show "$SERVICE" -p ActiveState --value)）"
  else
    say "  ⚠ 还没安装（没有 $SERVICE 单元）—— 参数已存好，跑一次 install 就生效"
  fi
  say "  前端参数（网站鸡/暴躁阈值）改的是 $WEBROOT/js/site-options.js，刷新页面即生效"
}

# 升级：重新下载 GitHub 最新发布包，再用**现有设置**重跑 install（设置/数据都不丢）
do_update() {
  need_root
  local url="https://github.com/akanotanin/cyber-probe/releases/latest/download/cyber-probe.run"
  local tmp; tmp="$(mktemp -d /tmp/cyber-probe-update.XXXXXX)"
  say "  当前版本 $(cat "$WEBROOT/version.txt" 2>/dev/null || echo '未知')"
  say "  下载 $url"
  if ! curl -fsSL --max-time 120 "$url" -o "$tmp/pkg.run"; then
    rm -rf "$tmp"
    die "下载失败（没网 / 被墙 / 发布页没有 cyber-probe.run）—— 也可以手动下载后跑 install"
  fi
  if ! grep -q '^__ARCHIVE_BELOW__$' "$tmp/pkg.run"; then
    rm -rf "$tmp"; die "下载到的文件不是完整包（缺载荷标记）"
  fi
  if ! bash "$tmp/pkg.run" version >/dev/null 2>&1; then
    rm -rf "$tmp"; die "下载到的包跑不起来（version 自检失败）"
  fi
  local remote local_v newest
  # grep 没匹配到会返回 1，set -e 下整条赋值把脚本干掉；nogit 版本（YYYYMMDDHHMM-nogit）也匹配不到
  remote="$(bash "$tmp/pkg.run" version 2>/dev/null | grep -oE '[0-9]{8,12}(-[0-9a-zA-Z]+)?' | head -1 || true)"
  local_v="$(cat "$WEBROOT/version.txt" 2>/dev/null || echo '')"
  newest="$(printf '%s
%s
' "$remote" "$local_v" | sed '/^$/d' | sort | tail -1)"
  say "  新包版本 $remote（本地 $local_v）"
  if [ -n "$local_v" ] && [ "$newest" = "$local_v" ] && [ "$remote" != "$local_v" ] && [ "$FORCE" != 1 ]; then
    rm -rf "$tmp"
    say "  本地版本比发布页还新（发布页那份大概是旧版）→ 不动。确实要覆盖就加 --force"
    return 0
  fi
  say "  用现有设置重装（$SETTINGS）"
  # 自定义设置路径必须传下去：否则升级后的实例会去读默认路径，等于换了一套设置
  local sub=(install --yes)
  [ "$SETTINGS" = /etc/cyber-probe/farm.conf ] || sub+=(--settings "$SETTINGS")
  if ! bash "$tmp/pkg.run" "${sub[@]}"; then
    rm -rf "$tmp"
    die "升级失败（临时目录已清理；旧版本还在跑，可重试或手动下载后 install）"
  fi
  rm -rf "$tmp"
  return 0
}

do_uninstall() {
  need_root
  # 第二道防线：下面会 rm -rf $WEBROOT / $APPDIR
  case "$WEBROOT" in /|'') die "设置里的 WEBROOT 是根目录，拒绝卸载（先检查 $SETTINGS）" ;; esac
  case "$APPDIR" in /|'') die "设置里的 APPDIR 是根目录，拒绝卸载（先检查 $SETTINGS）" ;; esac
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
  if [ "$MOUNT" = domain ]; then
    # 独立域名：删自己写的 vhost / Caddy 站点文件（别人的配置没动过）
    # Caddy 必须带上探测到的 Caddyfile：自定义 --config 时 import 行加在别处，摘不到。
    local rc=0
    python3 "$WORK/tools/vhost.py" --proxy nginx --remove --domain "$DOMAIN" || rc=1
    python3 "$WORK/tools/vhost.py" --proxy caddy --remove --domain "$DOMAIN" --conf "$CADDYFILE" || rc=1
    [ "$rc" = 0 ] || say "  ⚠ vhost 没摘干净（见上面的报错）：手工检查 $NGINX_CONF / $CADDYFILE"
  else
    # 两边都摘（与 install 的「双边清理」对称）：装完换过反代、或 nginx 已经停了，
    # 只摘「当前探测到的那一边」会留下 location 块 / Caddy import —— 后者指向已删片段，caddy 起不来。
    local rc=0
    if [ -f "${NGINX_CONF:-}" ]; then
      python3 "$WORK/tools/nginx_patch.py" --local --remove --conf "$NGINX_CONF" \
        --ws-port "$WS_PORT" --hub-port "$HUB_PORT" --webroot "$WEBROOT" --path "$FARM_PATH" || rc=1
    fi
    if [ -f "${CADDYFILE:-}" ]; then
      python3 "$WORK/tools/caddy_patch.py" --local --remove --conf "$CADDYFILE" \
        --ws-port "$WS_PORT" --hub-port "$HUB_PORT" --webroot "$WEBROOT" --path "$FARM_PATH" || rc=1
    fi
    # 别再用 `|| true` 把补丁器的报错吞掉：Caddy 的 import 残留会让它起不来，必须让人看见。
    [ "$rc" = 0 ] || say "  ⚠ 反代块没摘干净（见上面的报错）：先跑 nginx -t / caddy validate 再手工处理"
  fi
  if [ -f "$SETTINGS" ]; then
    cp -p "$SETTINGS" "/root/cyber-probe-farm.conf.$(date +%Y%m%d-%H%M%S)" 2>/dev/null || true
    rm -f "$SETTINGS"
    rmdir "$(dirname "$SETTINGS")" 2>/dev/null || true      # 空目录别留在 /etc 里
    say "  设置文件已备份到 /root 并删除"
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

# 自测：不需要 root、不碰系统服务、不写 /etc —— 在临时目录里把能测的都测一遍。
# 用法：bash cyber-probe.run selftest
# 自测：不需要 root、不碰系统服务、不写 /etc —— 在临时目录里把能测的都测一遍。
# 用法：bash cyber-probe.run selftest
do_selftest() {
  local tmp fails=0
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/cp-selftest.XXXXXX")"
  # 在 git-bash 里跑自测时，mktemp 给的是 MSYS 路径（/tmp/...），原生 python 不认 → 转成 C:/ 形式
  if command -v cygpath >/dev/null 2>&1; then tmp="$(cygpath -m "$tmp")"; fi
  pass() { say "PASS  $*"; }
  fail() { say "FAIL  $*"; fails=$((fails + 1)); }
  chk() { if [ "$1" = 1 ]; then pass "$2"; else fail "$2 ${3:-}"; fi; }

  # 找可用的 python：Linux 上是 python3；Windows 的 python3 可能是商店占位符（静默退出、返回 0）
  # ⚠ Windows 上 python3 常常是"应用商店占位符"：存在、退出码 0、但什么都不做 →
  #   必须真的跑一句 print 验证，否则补丁器"成功"了却一个字都没改。
  PY3=""
  for _c in "${PY:-}" python3 python; do
    [ -n "$_c" ] || continue
    command -v "$_c" >/dev/null 2>&1 || continue
    [ "$("$_c" -c 'print(1)' 2>/dev/null)" = 1 ] && { PY3="$_c"; break; }
  done
  # ⚠ 找不到可用解释器时**不能**回退到 python3：Windows 的 python3 常是应用商店占位符
  #   （存在、退出 0、什么都不做）→ 补丁器「成功」了却一个字都没改。留空跳过补丁器自测。
  if [ -z "$PY3" ]; then
    say "  ⚠ 没找到能跑的 python（python3 可能是应用商店占位符）→ 跳过补丁器自测"
  fi

  extract
  # 同理：$WORK 是解包目录，在 git-bash 里也是 MSYS 路径 → 原生 python 读不到
  if command -v cygpath >/dev/null 2>&1; then WORK="$(cygpath -m "$WORK")"; fi
  say "· 自测目录 $tmp（python: $PY3）"
  # ⚠ 两个只影响「本机自测」的 Windows 环境坑（Linux/服务器上无副作用）：
  #   ① Git Bash/MSYS 会把给原生程序的、以 / 开头的参数改写成 <msys>/…：
  #      `--path /farm` → C:/Program Files/Git/farm、`--webroot /srv/site` 同理 →
  #      补丁器插进去的是 mangled 路径，自测 6 项全红（真机 Linux 不受影响）。
  #   ② 中文 Windows 的控制台/管道编码是 GBK，而 vhost 的站点注释里有 ⚙（U+2699，
  #      GBK 编不出来）、补丁器又把子进程输出按 UTF-8 解码 → 打印时 UnicodeEncodeError。
  #   自测这一段统一关掉参数路径转换、让 python 走 UTF-8（只影响下面导出的子进程环境）。
  export MSYS2_ARG_CONV_EXCL='*' MSYS_ARG_CONV_EXCL='*' PYTHONUTF8=1

  # (1) 路径规范化
  if [ "$(norm_path chicken)" = /chicken/ ] && [ "$(norm_path /farm)" = /farm/ ]  \
       && [ "$(norm_path /a/b/)" = /a/b/ ] && [ "$(norm_path /)" = / ]; then
    chk 1 "路径规范化（chicken → /chicken/、/farm → /farm/、/ → /）"
  else
    chk 0 "路径规范化"
  fi

  # (2) 设置文件读写往返
  local bak_settings="$SETTINGS"
  SETTINGS="$tmp/farm.conf"
  MOUNT=path FARM_PATH=/farm/ WS_PORT=28999 DOMAIN=example.test SITE_NAME=测试站
  GEESE=3 DOGS=0 SHOW_WEB=0 HOT_CPU=70 HOT_MEM=90 HOT_MAX=2
  SERVICE=cp-selftest WEBROOT="$tmp/site-selftest" APPDIR="$tmp/app-selftest"
  save_settings
  if grep -q "FARM_PATH=/farm/" "$SETTINGS" && grep -q "GEESE=3" "$SETTINGS"  \
       && grep -q "SHOW_WEB=0" "$SETTINGS" && grep -q "HOT_MAX=2" "$SETTINGS" \
       && grep -qF "SERVICE=cp-selftest" "$SETTINGS" && grep -qF "WEBROOT=$tmp/site-selftest" "$SETTINGS"; then
    chk 1 "设置文件写对了（$SETTINGS）"
  else
    chk 0 "设置文件内容不对"
  fi
  GEESE="" DOGS="" SHOW_WEB=1 HOT_CPU=55 HOT_MEM=85 HOT_MAX=0 FARM_PATH=/chicken/ MOUNT=path
  WS_PORT=1 DOMAIN="" SITE_NAME_ARG=""
  SERVICE=cyber-probe WEBROOT=/var/www/cyber-probe APPDIR=/opt/cyber-probe
  CLI_SVC=0 CLI_WR=0 CLI_AD=0
  load_settings
  if [ "$GEESE" = 3 ] && [ "$DOGS" = 0 ] && [ "$SHOW_WEB" = 0 ] && [ "$HOT_CPU" = 70 ]  \
       && [ "$FARM_PATH" = /farm/ ] && [ "$WS_PORT" = 28999 ] \
       && [ "$SERVICE" = cp-selftest ] && [ "$WEBROOT" = "$tmp/site-selftest" ] && [ "$APPDIR" = "$tmp/app-selftest" ]; then
    chk 1 "设置能读回来（鹅3/狗0/网站鸡关/阈值70/路径/farm//端口 + 自定义 service/webroot/appdir）"
  else
    chk 0 "设置读回不对" "鹅=$GEESE 狗=$DOGS 网站鸡=$SHOW_WEB CPU=$HOT_CPU 路径=$FARM_PATH 端口=$WS_PORT 服务=$SERVICE WEB=$WEBROOT APP=$APPDIR"
  fi

  # (2b) 防呆：设置文件里写根目录的话，uninstall 会 rm -rf / —— 必须回退默认值
  SETTINGS="$tmp/farm-bad.conf"
  printf 'WEBROOT=/\nAPPDIR=/\nSERVICE=boom\n' > "$SETTINGS"
  WEBROOT=/var/www/cyber-probe APPDIR=/opt/cyber-probe
  load_settings
  if [ "$WEBROOT" = /var/www/cyber-probe ] && [ "$APPDIR" = /opt/cyber-probe ]; then
    chk 1 "设置里的根目录会回退默认（防 uninstall 误删 /）"
  else
    chk 0 "根目录防呆失效" "WEB=$WEBROOT APP=$APPDIR"
  fi
  SETTINGS="$tmp/farm.conf"

  # (3) 生成给前端的 site-options.js 与服务端读的 geese/dogs
  WEBROOT="$tmp/site"; APPDIR="$tmp/app"
  mkdir -p "$WEBROOT/js" "$APPDIR"
  SHOW_WEB=0 HOT_CPU=66 HOT_MEM=77 HOT_MAX=4
  write_options >/dev/null
  if grep -q "showWeb: false" "$WEBROOT/js/site-options.js" && grep -q "hotCpu: 66" "$WEBROOT/js/site-options.js"  \
       && [ "$(cat "$APPDIR/geese")" = 3 ] && [ "$(cat "$APPDIR/dogs")" = 0 ]; then
    chk 1 "site-options.js 与 geese/dogs 落盘正确"
  else
    chk 0 "site-options.js / geese / dogs 内容不对"
  fi

  # (3b) 模型源：config 模式重写 site-options.js 时不能把 modelFallback 抹掉
  #      （以前 do_config 不设 MODEL_SRC → 每次 config 都把安装时写的值变空）
  MODEL_SRC='https://models.example'
  write_options >/dev/null
  MODEL_CDN=""
  MODEL_SRC="$(model_src)"     # 模拟 do_config：环境里没有，只能从 APPDIR 落盘处读回
  write_options >/dev/null
  if grep -qF "modelFallback: 'https://models.example'" "$WEBROOT/js/site-options.js"; then
    chk 1 "模型源在 config 重写后仍在（modelFallback 没被抹空）"
  else
    chk 0 "config 重写把 modelFallback 抹掉了" "$(grep -o "modelFallback: '[^']*'" "$WEBROOT/js/site-options.js")"
  fi

  # (3c) 数量上限：手滑多打一个 0 不能把联机服主循环（O(N²) 软分离）拖死
  if ( GEESE=65; normalize_settings ) >/dev/null 2>&1; then
    chk 0 "大白鹅 65 只也放行（上限没生效）"
  else
    chk 1 "大白鹅数量上限生效（>64 会被拒）"
  fi

  if command -v "$PY3" >/dev/null; then
    # (4) nginx 补丁器：贴 / 幂等 / 摘（字节一致），用自定义前缀
    local fx="$tmp/ngx"; mkdir -p "$fx"
    cat > "$fx/site.conf" <<'SITECONF'
server {
    listen 443 ssl;
    server_name t.test;
    location / {
        proxy_pass http://127.0.0.1:28080;
    }
}
SITECONF
    cp "$fx/site.conf" "$fx/orig.conf"
    if "$PY3" "$WORK/tools/nginx_patch.py" --local --no-reload --conf "$fx/site.conf" --hub-port 28080 --ws-port 28910 --webroot /srv/site --path /farm >/dev/null 2>&1        && grep -q "location ^~ /farm/" "$fx/site.conf"; then
      chk 1 "nginx 补丁：自定义路径 /farm/ 插进去了"
    else
      chk 0 "nginx 补丁：没插进去"
    fi
    _out="$("$PY3" "$WORK/tools/nginx_patch.py" --local --no-reload --conf "$fx/site.conf" --hub-port 28080 --ws-port 28910 --webroot /srv/site --path /farm 2>&1 || true)"
    case "$_out" in *SKIP*)
      chk 1 "nginx 补丁：重跑幂等（SKIP）" ;;
    *)  chk 0 "nginx 补丁：不幂等" ;;
    esac
    "$PY3" "$WORK/tools/nginx_patch.py" --local --no-reload --remove --conf "$fx/site.conf" --hub-port 28080 --ws-port 28910 --webroot /srv/site --path /farm >/dev/null 2>&1 || true
    if cmp -s "$fx/site.conf" "$fx/orig.conf"; then chk 1 "nginx 补丁：贴→摘 字节一致"; else chk 0 "nginx 补丁：摘不干净"; fi

    # (4a2) 兜底也要字节一致：现场参数与安装时不一致（换过 --hub-port / --webroot）会走「按路径摘块」，
    #       那一路以前会在原地留下一个分隔空行（真机 path→domain 切换时踩到）
    cp -f "$fx/orig.conf" "$fx/site2.conf"
    "$PY3" "$WORK/tools/nginx_patch.py" --local --no-reload --conf "$fx/site2.conf" --hub-port 28085 --ws-port 28912 --webroot /srv/site --path /farm >/dev/null 2>&1 || true
    "$PY3" "$WORK/tools/nginx_patch.py" --local --no-reload --remove --conf "$fx/site2.conf" --hub-port 28080 --ws-port 28910 --webroot /srv/other --path /farm >/dev/null 2>&1 || true
    if cmp -s "$fx/site2.conf" "$fx/orig.conf"; then
      chk 1 "nginx 补丁：参数不一致时兜底摘除也字节一致"
    else
      chk 0 "nginx 补丁：兜底摘除留空行"
    fi

    # (4b) 兜底：块被摘掉后留下的孤立注释段也要清掉（线上真踩过：注释跟着空行漂在配置里）
    local fo="$tmp/orphan"; mkdir -p "$fo"
    cat > "$fo/site.conf" <<'ORPHANCONF'
server {
    listen 8080;
    server_name t.test;
    # cyber-probe 联机游戏服（孤立注释）

    # ---- cyber-probe：静态站（孤立注释）

    location / {
        proxy_pass http://127.0.0.1:28080;
    }
}
ORPHANCONF
    if "$PY3" "$WORK/tools/nginx_patch.py" --local --no-reload --remove --conf "$fo/site.conf" --hub-port 28080 --ws-port 28910 --webroot /srv/site --path /farm >/dev/null 2>&1        && ! grep -q "cyber-probe" "$fo/site.conf"; then
      chk 1 "nginx 补丁：孤立的 cyber-probe 注释段会被清掉"
    else
      chk 0 "nginx 补丁：孤立注释没清干净"
    fi

    # (4c) 块已存在但参数变了（换过 --hub-port）：必须就地更新，不能 SKIP 装死
    #      以前 SKIP → /api 还指老端口，重装完 502（KuromiX3 真机实测）
    cp -f "$fx/orig.conf" "$fx/site3.conf"
    "$PY3" "$WORK/tools/nginx_patch.py" --local --no-reload --conf "$fx/site3.conf" --hub-port 28080 --ws-port 28910 --webroot /srv/site --path /farm >/dev/null 2>&1 || true
    "$PY3" "$WORK/tools/nginx_patch.py" --local --no-reload --conf "$fx/site3.conf" --hub-port 28085 --ws-port 28910 --webroot /srv/site --path /farm >/dev/null 2>&1 || true
    if grep -q "127.0.0.1:28085/api/" "$fx/site3.conf" && ! grep -q "127.0.0.1:28080/api/" "$fx/site3.conf"; then
      chk 1 "nginx 补丁：已有块会跟着 --hub-port 更新"
    else
      chk 0 "nginx 补丁：换了 hub 端口仍是老值"
    fi

    # (4d) 危险安装目录（卸载会 rm -rf）：/etc 这种必须挡掉
    local ok_dirs=0 bad_dirs=0 d
    for d in /opt/cp /var/www/cp /srv/cp /home/u/cp; do safe_dir "$d" && ok_dirs=$((ok_dirs + 1)); done
    for d in / /etc /usr /var /opt /var/www /etc/nginx /home/u; do safe_dir "$d" || bad_dirs=$((bad_dirs + 1)); done
    if [ "$ok_dirs" = 4 ] && [ "$bad_dirs" = 8 ]; then
      chk 1 "安全目录判定：安装子目录放行、系统目录挡掉"
    else
      chk 0 "安全目录判定不对（放行 $ok_dirs/4，挡掉 $bad_dirs/8）"
    fi

    # (5) Caddy 补丁器
    local fc="$tmp/caddy"; mkdir -p "$fc"
    cat > "$fc/Caddyfile" <<'CADDYCONF'
t.test {
	reverse_proxy 127.0.0.1:28080
}
CADDYCONF
    if "$PY3" "$WORK/tools/caddy_patch.py" --local --no-reload --conf "$fc/Caddyfile" --snippet "$fc/conf.d/x.caddy" --domain t.test --hub-port 28080 --ws-port 28910 --webroot /srv/site --path /farm >/dev/null 2>&1        && grep -q "handle /farm/api/" "$fc/conf.d/x.caddy"; then
      chk 1 "Caddy 补丁：自定义路径 /farm/ 写进片段"
    else
      chk 0 "Caddy 补丁：片段不对"
    fi
    "$PY3" "$WORK/tools/caddy_patch.py" --local --no-reload --remove --conf "$fc/Caddyfile" --snippet "$fc/conf.d/x.caddy" --domain t.test --hub-port 28080 --ws-port 28910 --webroot /srv/site --path /farm >/dev/null 2>&1 || true
    if [ ! -f "$fc/conf.d/x.caddy" ] && ! grep -q "import " "$fc/Caddyfile"; then
      chk 1 "Caddy 补丁：摘掉片段与 import 行"
    else
      chk 0 "Caddy 补丁：摘不干净"
    fi

    # (6) 独立域名 vhost（--dry-run 不落盘）
    if "$PY3" "$WORK/tools/vhost.py" --proxy nginx --domain farm.test --webroot /srv/site --dry-run 2>&1 | grep -q "server_name farm.test"; then
      chk 1 "vhost（nginx）：生成的 server 块对"
    else
      chk 0 "vhost（nginx）"
    fi
    if "$PY3" "$WORK/tools/vhost.py" --proxy caddy --domain farm.test --webroot /srv/site --dry-run 2>&1 | grep -q "^farm.test {"; then
      chk 1 "vhost（Caddy）：生成的站点块对"
    else
      chk 0 "vhost（Caddy）"
    fi
    # 前台那枚 ⚙ 入口要能进后台：两种 vhost 都必须把 /admin 反代到 hub
    if "$PY3" "$WORK/tools/vhost.py" --proxy nginx --domain farm.test --webroot /srv/site --dry-run 2>&1 | grep -q "location ^~ /admin {"; then
      chk 1 "vhost（nginx）：/admin 反代到 hub（⚙ 入口）"
    else
      chk 0 "vhost（nginx）：/admin 反代"
    fi
    if "$PY3" "$WORK/tools/vhost.py" --proxy caddy --domain farm.test --webroot /srv/site --dry-run 2>&1 | grep -q "handle /admin\* {"; then
      chk 1 "vhost（Caddy）：/admin 反代到 hub（⚙ 入口）"
    else
      chk 0 "vhost（Caddy）：/admin 反代"
    fi
  else
    say "（没有 python3，跳过补丁器与 vhost 的自测）"
  fi

  SETTINGS="$bak_settings"
  rm -rf "$tmp"
  say ""
  if [ "$fails" = 0 ]; then say "═══ 自测全绿 ═══"; return 0; fi
  say "═══ 自测失败 $fails 项 ═══"
  return 1
}

say "cyber-probe 部署包 · 模式 $MODE"
load_settings          # 先吃上次的设置（命令行参数已经覆盖优先）
case "$MODE" in
  install)   do_install ;;
  config)    do_config ;;
  update)    do_update ;;
  selftest)  do_selftest ;;
  status)
    extract
    detect_hub; detect_proxy; detect_proxy_conf
    do_status ;;
  restart)
    need_root
    # ⚠ 探测必须在 do_status 之前：probe_code/probe_ws 读 $SITE_PORT 与 $DOMAIN，不探测的话
    #   path 模式 $SITE_PORT 未定义（set -u 直接 exit 1）、$DOMAIN 也是空，三项探活全废。
    detect_hub; detect_proxy; detect_proxy_conf
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
