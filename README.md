![预览](preview.jpg)

# cyber-probe

把 Monitor 探针的实时数据做成一座**可玩的 3D 小鸡农场**：每台机器一只探针鸡，每个 ping 任务一只网站鸡。

## 玩法

- **探针鸡**：每台 VPS 一只，名牌是真数据 —— 国旗、CPU／内存双环、网速、磁盘、负载、在线时长、机型
- **网站鸡**：每个 ping 任务一只，名牌给平均延迟、最好／最差节点、丢包
- **暴躁鸡**：CPU／内存超阈值或网络最差的那台（脚下红环），主动追着啄且永不逃窜
- **NPC·大白鹅**：有领地意识，走进领地就追、够得着就啄；60 血，反过来能啄倒拿分
- **多人同场**：战斗由服务端裁定、移动客户端自算；右上啄倒榜、左上在线统计，手机有虚拟摇杆
- **前台也是面板入口**：按 <kbd>Tab</kbd>（或顶栏 🖥）打开探针列表，hub 里所有服务器一屏看完；点卡片或点场上任意一只鸡都在同一块面板里看详情（九格信息 + 资源／网络延迟两页签），⚙ 进 `/admin`（站点没有后台时自动隐藏）

## 安装

前提：Linux + systemd + `python3` 3.9+，机器上跑着 Monitor hub，并有 nginx 或 Caddy 给它做反代。

```bash
curl -fsSL https://github.com/akanotanin/cyber-probe/releases/latest/download/cyber-probe.run -o cyber-probe.run
sudo bash cyber-probe.run install          # 交互式向导；加 --yes 全用默认值
```

向导只问三件事：**挂在哪**（默认 `/chicken/`，或给农场一个独立域名）、**联机服端口**、**玩法参数**。

脚本会（幂等，可反复跑）：认出 hub 的端口／数据库 → 只读它生成 `js/config.js` → 部署静态站与联机服（`cyber-probe.service`，只听 `127.0.0.1`）→ 给 nginx／Caddy 补反代（改前备份，自检不过自动回滚）→ 三项探活。装完打开 `https://你的域名/chicken/`；hub 里改过 ping 任务后重跑 `install` 刷新名单。

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
| `--geese N` | 大白鹅数量（0 = 不放养） | 2 |
| `--dogs N` | 看门狗数量（0 = 不养狗） | 1 |
| `--show-web 0\|1` | 是否出现「网站鸡」 | 1 |
| `--hot-cpu N` / `--hot-mem N` | 暴躁鸡的 CPU／内存阈值（%） | 55 / 85 |
| `--hot-max N` | 最多几只暴躁鸡（0 = 不限） | 0 |
| `--path /farm/` | 挂载路径 | `/chicken/` |
| `--mount path\|domain` | 挂子路径还是独立域名（配 `--domain`） | path |

设置存 `/etc/cyber-probe/farm.conf`，重装、`config`、`update` 都读它。

## 命令

| 命令 | 作用 |
| --- | --- |
| `status` | 单元／端口／站点／接口／WebSocket 探活 + 玩法参数 + 最近日志 |
| `config` | 改玩法参数，改完自动重启 |
| `update` | 拉最新发布包、用现有设置重装（`--force` 可覆盖更新的本地版） |
| `selftest` | 不需要 root 的自测（18 项） |
| `restart` / `logs [n]` / `test` / `uninstall` | 重启联机服 / 看日志 / 服务端自测 / 卸载（静态站先备份到 `/root`） |

以上都是 `sudo bash cyber-probe.run <命令>`；`--dry-run` 只打印将要写入的设置，全部参数见 `--help`。

## 数据与隐私

- **只读**：只读 hub 的 SQLite 与同源 `/api/*`，不写任何东西
- **公开的 `js/config.js` 里只有**任务名、间隔、国旗码；**主机名／IP 与探测目标一律不导出**
- **不发第三方请求**：模型与国旗都从本站 `vendor/` 加载，缺文件就用内置模型／两字母代码
- **联机服只监听回环**，对外只经你自己的反代；有每 IP 并发上限与限流，上报数值全部过 `isfinite`

## 本地开发

```bash
python mock/serve.py 8899                  # 静态站 + /chicken/api/* 反代真 hub
python server/farm_server.py --port 28910  # 联机服（另开终端）
bash tools/ci.sh                           # 门禁；加 --with-browser 再跑浏览器断言
```

页面带 `?debug` 才会把内部状态挂到 `window.__farm`（自测脚本全靠它）。

## 许可

[MIT](LICENSE)。`vendor/` 内是 three.js（同样 MIT）。
