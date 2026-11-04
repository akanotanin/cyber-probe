![预览](preview.jpg)

# cyber-probe

把 Monitor hub / [Komari](https://www.komari.wiki/) / [哪吒监控（Nezha）](https://nezha.wiki/) 的实时监控数据做成一座**可玩的 3D 小鸡农场**：每台机器一只探针鸡，每个 ping 任务／服务监控一只网站鸡。

## 玩法

- **探针鸡**：每台 VPS 一只，名牌是真数据 —— 国旗、CPU／内存双环、网速、磁盘、负载、在线时长、机型
- **网站鸡**：每个 ping 任务一只，名牌给平均延迟、最好／最差节点、丢包
- **暴躁鸡**：CPU／内存超阈值或网络最差的那台（脚下红环），主动追着啄且永不逃窜
- **NPC·大白鹅**：有领地意识，走进领地就追、够得着就啄；60 血，反过来能啄倒拿分
- **多人同场**：战斗由服务端裁定、移动客户端自算；右上啄倒榜、左上在线统计，手机有虚拟摇杆
- **前台也是面板入口**：按 <kbd>Tab</kbd>（或顶栏 🖥）打开探针列表，hub / Komari 里所有服务器一屏看完；点卡片或点场上任意一只鸡都在同一块面板里看详情（九格信息 + 资源／网络延迟两页签），⚙ 进 `/admin`（站点没有后台时自动隐藏）

## 安装

前提：Linux + systemd + `python3` 3.9+，机器上跑着 Monitor hub、Komari 或哪吒监控，并有 nginx 或 Caddy 给它做反代。

```bash
curl -fsSL https://github.com/akanotanin/cyber-probe/releases/latest/download/cyber-probe.run -o cyber-probe.run
sudo bash cyber-probe.run install          # 交互式向导；加 --yes 全用默认值
```

向导只问三件事：**挂在哪**（默认 `/chicken/`，或给农场一个独立域名）、**联机服端口**、**玩法参数**。

脚本会（幂等，可反复跑）：认出监控后端的类型／端口（systemd 单元或 Docker 容器）→ 只读 Monitor 的 SQLite 或 Komari/哪吒的公开 API 生成 `js/config.js` → 部署静态站与联机服（`cyber-probe.service`，只听 `127.0.0.1`）→ 给 nginx／Caddy 补反代（改前备份，自检不过自动回滚）→ 三项探活。装完打开 `https://你的域名/chicken/`；在监控后台改过 ping 任务／服务监控后重跑 `install` 刷新名单。

### Komari

安装器会自动认 `komari.service` / 名为 `komari` 的 Docker 容器 / `25774` 端口上的 Komari API；认不到时显式指定：

```bash
sudo bash cyber-probe.run install --source komari --hub-port 25774
# 容器映射到了别的宿主端口（反代仍指向 127.0.0.1:<hub-port>）：
sudo bash cyber-probe.run install --source komari --hub-port 32768
# 只让“生成任务清单”从另一个地址读（例如本机 HTTPS 反代），反代目标仍是 --hub-port：
sudo bash cyber-probe.run install --source komari --hub-port 25774 --komari-url https://komari.example.com
```

数据走 Komari 的**公开 API**（`/api/nodes`、`/api/clients` WebSocket、`/api/records/*`、`/api/task/ping`），不需要读 Komari 的数据库，也不需要管理员密钥。站点必须是**公开站点**（Komari 后台的「私有站点」关闭）；私有站点会拒绝 Guest 的 `/api/nodes`，页面只能显示空农场。Komari 的节点 UUID 与探测目标不会写进 `config.js`，前端把 UUID 映射成数字 id（联机服按数字 id 认鸡）。

`--source auto`（默认）会**优先沿用已安装站点 `config.js` 的 `SOURCE`**（其次是上次设置里的数据源），再看同机的 systemd 单元 / 容器 / 默认端口；这样同机顺手装的另一个监控面板（比如 8008 的哪吒）不会把现有农场的数据源抢走，Komari 临时没起时重跑 `install`/`update` 也不会刷回 monitor。要真正切换数据源，显式给 `--source monitor|komari|nezha`；`--hub-port 8008` 这种明确端口提示也会先用来判类型。

### 哪吒监控（Nezha）

安装器会自动认 `nezha-dashboard` / `nezha` 单元、名为 `nezha` 的 Dashboard 容器（会排除 `nezha-agent`），以及 `8008` 端口上的哪吒 API；认不到时显式指定：

```bash
sudo bash cyber-probe.run install --source nezha --hub-port 8008
# 容器映射到了别的宿主端口（反代仍指向 127.0.0.1:<hub-port>）：
sudo bash cyber-probe.run install --source nezha --hub-port 32768
# 只让“生成服务监控清单 + 节点白名单”从另一个地址读（例如本机 HTTPS 反代）：
sudo bash cyber-probe.run install --source nezha --hub-port 8008 --nezha-url https://nezha.example.com
```

数据走哪吒**游客可读**的 `/api/v1/*`：`/api/v1/ws/server`（实时状态流，含 Host/State）、`/api/v1/service`（服务监控统计）、`/api/v1/server/<id>/service`、`/api/v1/service/<id>/history`（详情曲线）与 `/api/v1/setting`（站名 / 是否启用 TSDB）。不需要管理员密钥，也不读数据库。

⚠ 三个前提：面板**关闭「强制认证」**（`force_auth: false`）、机器**没有「对游客隐藏」**、反代给 `/chicken/api/v1/ws/server` 透传 WebSocket（安装器会自动加这段；Caddy 的 `reverse_proxy` 自带升级）。反代必须把访客的 `Host`（**含非 80/443 的端口**）原样传给哪吒，否则哪吒的 `CheckOrigin` 会拒掉同源 WebSocket；安装器已用 `$http_host` 处理。否则页面会给出「哪吒面板要求登录」之类的提示，并显示空农场。

与 monitor/Komari 的差异（接口本身不提供的数据，UI 显示「—」，不编造）：

- **网站鸡**是哪吒的**服务监控**。公开接口只有服务级统计：近 15 分钟成功/失败**次数**（不是台数，面板上写「近 15 分钟探测 N 次」）和今日平均延迟；「最快/最慢节点」不显示。点开详情时按需读 `/service/<id>/history`，画各节点曲线。
- **探针鸡**的「网络最差」排名不可用（哪吒没有“每节点当前延迟”的轻量接口），暴躁鸡只按 CPU/内存阈值判定；详情里的「网络延迟」页签仍会按需读 `/server/<id>/service`。
- **资源历史曲线**依赖哪吒启用 TSDB；没启用时详情只显示实时数据与延迟历史，并给出说明。
- 游客只能查 **1 天**历史（7d/30d 需要登录）；因此时间档位是 1 小时 / 6 小时 / 24 小时。
- 节点 id 直接用哪吒的服务器 id（`n<id>`）；安装器通过 WebSocket 取 id 生成联机服白名单。WS 被挡住时只写网站鸡的 `t<id>`（它们仍能出现，探针鸡/假 id 被挡），不会退回“完全相信客户端名单”。

`--source auto` 同样优先沿用现有 `config.js` 的 `SOURCE`；哪吒临时没起时重跑 `install`/`update` 不会把数据源刷回 monitor。同机另有一个面板时也以已安装来源为准，切换请显式 `--source nezha`（或给出 `--hub-port 8008`）。

⚠ `install` 会**整体替换** `--webroot`（默认 `/var/www/cyber-probe`）——旧目录先 `mv` 走再删。别把手工文件放进去。

模型与国旗可以自托管（都不拉也能玩：用内置道具与两字母代码，下次 `install` 会自动补）：

```bash
MODEL_CDN=<模型源> bash tools/fetch_models.sh   # → vendor/models/，缺哪个补哪个
FLAG_CDN=<国旗源> bash tools/fetch_flags.sh     # → vendor/flags/
```

`/chicken/` 是默认路径，也是给面板主题留的约定（主题靠 `GET /chicken/api/nodes` 回不回应判断本站装没装）；换路径或独立域名用 `--path` / `--mount`。

## 参数

```bash
sudo bash cyber-probe.run config                                    # 逐项交互改
sudo bash cyber-probe.run config --geese 3 --show-web 0 --hot-max 2 # 也可直接给参数
```

| 参数 | 含义 | 默认 |
| --- | --- | --- |
| `--geese N` | 大白鹅数量（0 = 不放养；最多 64） | 2 |
| `--dogs N` | 看门狗数量（0 = 不养狗；最多 8） | 1 |
| `--show-web 0\|1` | 是否出现「网站鸡」 | 1 |
| `--hot-cpu N` / `--hot-mem N` | 暴躁鸡的 CPU／内存阈值（%） | 55 / 85 |
| `--hot-max N` | 最多几只暴躁鸡（0 = 不限） | 0 |
| `--path /farm/` | 挂载路径 | `/chicken/` |
| `--mount path\|domain` | 挂子路径还是独立域名（配 `--domain`） | path |
| `--source monitor\|komari\|nezha` | 强制数据源（默认自动认） | auto |
| `--komari-url URL` | Komari 公开 API 根地址 | `http://127.0.0.1:<hub-port>` |
| `--nezha-url URL` | 哪吒公开 API 根地址 | `http://127.0.0.1:<hub-port>` |

设置存 `/etc/cyber-probe/farm.conf`，重装、`config`、`update` 都读它。

## 命令

| 命令 | 作用 |
| --- | --- |
| `status` | 单元／端口／站点／接口／WebSocket 探活 + 玩法参数 + 最近日志 |
| `config` | 改玩法参数，改完自动重启 |
| `update` | 拉最新发布包、用现有设置重装（`--force` 可覆盖更新的本地版） |
| `selftest` | 不需要 root 的自测（30+ 项，含 Komari / 哪吒兼容检查） |
| `restart` / `logs [n]` / `test` / `uninstall` | 重启联机服 / 看日志 / 服务端自测 / 卸载（静态站先备份到 `/root`） |

以上都是 `sudo bash cyber-probe.run <命令>`；`--dry-run` 只打印将要写入的设置，全部参数见 `--help`。

## 数据与隐私

- **只读**：Monitor 模式只读 hub 的 SQLite 与同源 `/api/*`；Komari / 哪吒模式只读各自的公开 API。都不写任何东西
- **公开的 `js/config.js` 里只有**任务名／服务名、间隔、国旗码；**主机名／IP、节点 UUID 与探测目标一律不导出**
- **Komari 的实时指标**经同源反代走 `/chicken/api/clients` WebSocket；**哪吒的实时状态流**走 `/chicken/api/v1/ws/server`（nginx 的 exact location 已配 Upgrade；Caddy 自动处理）
- **不发第三方请求**：模型与国旗都从本站 `vendor/` 加载，缺文件就用内置模型／两字母代码
- **联机服只监听回环**，对外只经你自己的反代；有每 IP 并发上限与限流，上报数值全部过 `isfinite`
- **NPC 名单白名单**：安装器把 hub 里真实存在的 `n<节点id>`／`t<任务id>` 写到 `$APPDIR/npcs-allow`，联机服只接受这些 id（匿名访客不能再塞假 id 占满全站名额）。文件不进公开站；删掉它才退回“相信客户端名单”的旧行为。换数据源或读不到新名单时**不会先删旧文件**（避免 fail-open），新名单由 `gen_config` 原子替换；读取失败时旧名单保留，修好面板后重跑 `install` 即可。

## 本地开发

```bash
python3 tools/gen_config.py --stub --out js/config.js   # 新克隆先跑：js/config.js 是生成物、不进库
python3 tools/gen_config.py --komari http://127.0.0.1:25774 --out js/config.js   # 用本机 Komari 生成
python3 tools/gen_config.py --nezha http://127.0.0.1:8008 --out js/config.js      # 用本机哪吒生成
MOCK_UPSTREAM=https://hub.example.com python mock/serve.py 8899   # 静态站 + /chicken/api/* 反代真 hub
python mock/komari.py 8898                 # 假 Komari API + 静态站（SOURCE=komari，离线可跑）
python mock/nezha.py 8896                  # 假哪吒 API + WebSocket（SOURCE=nezha，离线可跑）
python server/farm_server.py --port 28910  # 联机服（另开终端）
bash tools/ci.sh                           # 门禁；加 --with-browser 再跑浏览器断言
```

本地要试联机（mock 不代理 WebSocket）：打开
`http://127.0.0.1:8899/chicken/?ws=ws://127.0.0.1:28910/ws`。测 Komari 时把 `MOCK_UPSTREAM`
指向 Komari（如 `http://127.0.0.1:25774`），并让 `config.js` 的 `SOURCE = "komari"`。
测哪吒直接用 `python mock/nezha.py 8896`（它自己实现 WebSocket，不需要额外的反代）：
`http://127.0.0.1:8896/chicken/?debug&nomodels`。

`mock/serve.py` 必须给 `MOCK_UPSTREAM`（不写死任何人的 hub 地址），否则直接 exit 2。

页面带 `?debug` 才会把内部状态挂到 `window.__farm`（自测脚本全靠它）。

## 许可

[MIT](LICENSE)。`vendor/` 内是 three.js（同样 MIT）。
