![预览](preview.jpg)

# cyber-probe

把探针面板（hub）的实时数据做成一座**可玩的 3D 小鸡农场**：每台机器一只探针鸡，每个 ping 任务一只网站鸡，一条命令装在你的面板那台机器上。

## 玩法

- **探针鸡**：每台 VPS 一只，名牌上是真数据 —— 国旗、CPU／内存双环、网速、磁盘、负载、在线时长、机型、血条
- **网站鸡**：每个 ping 任务一只，名牌给平均延迟、最好／最差节点、丢包
- **暴躁鸡**：CPU／内存超阈值或网络最差的那台（脚下红环），主动追着啄且永不逃窜
- **NPC·大白鹅**：有领地意识，走进领地就追、够得着就啄；60 血，反过来能啄倒拿分
- **点任意一只鸡**：开详情抽屉 —— 历史曲线（CPU／内存、网速、磁盘、各探测点延迟）＋ 节点信息
- **多人同场**：战斗由服务端裁定、移动客户端自算；右上啄倒榜、左上在线统计，手机上有虚拟摇杆

## 安装

前提：Linux + systemd + `python3` 3.9+，机器上跑着探针面板（hub），并有 nginx 或 Caddy 给它做反代。

```bash
curl -fsSL https://github.com/akanotanin/cyber-probe/releases/latest/download/cyber-probe.run -o cyber-probe.run
sudo bash cyber-probe.run install          # 交互式向导；加 --yes 则全用默认值
```

向导只问三件事：**挂在哪**（子路径 `/chicken/`，或给农场一个独立域名）、**联机服端口**、**玩法**（大白鹅／看门狗数量、要不要网站鸡、暴躁鸡阈值与数量上限）。

脚本会做（幂等，可反复跑）：认出 hub 的端口／数据库／域名 → 只读那份数据库生成 `js/config.js` → 部署静态站与联机服（`cyber-probe.service`，只监听 `127.0.0.1`）→ 给 nginx／Caddy 补三块反代（改前备份，自检不过自动回滚）→ 站点／接口／WebSocket 各探活一次。

装完打开 `https://你的域名/chicken/`。hub 里增删 ping 任务后重跑一次 `install` 就能刷新名单。

> `/chicken/` 是默认路径，也是给面板主题留的约定（主题靠 `GET /chicken/api/nodes` 回不回应判断本站装没装）。
> 换路径或独立域名用 `--path` / `--mount`，那种情况下主题入口要自己配。

## 玩法参数

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
| `--mount path\|domain` | 挂在子路径，还是给它独立域名（配 `--domain`） | path |

设置存在 `/etc/cyber-probe/farm.conf`，重装、`config`、`update` 都读它，不会被下一次安装冲掉。

## 常用命令

| 命令 | 作用 |
| --- | --- |
| `status` | 单元／端口／站点／接口／WebSocket 探活 + 玩法参数 + 最近日志 |
| `config` | 改玩法参数，改完自动重启生效 |
| `update` | 拉最新发布包，用现有设置重装（`--force` 可覆盖更新的本地版） |
| `selftest` | 不需要 root 的自测（12 项） |
| `restart` / `logs [n]` / `test` / `uninstall` | 重启联机服 / 看日志 / 服务端自测 / 卸载（静态站先备份到 `/root`） |

以上都是 `sudo bash cyber-probe.run <命令>`；`--dry-run` 只打印将要写入的设置，全部参数见 `--help`。

## 数据与隐私

- **只读**：只读 hub 的 SQLite 与同源 `/api/*`，不往里写任何东西
- **公开的 `js/config.js` 里只有**探测任务名、间隔、国旗码；**节点主机名／IP 与探测目标域名一律不导出**
- **联机服只监听回环**，对外只能经你自己的反代进来；有每 IP 并发上限与限流，客户端上报的数值全部过 `isfinite`

## 本地开发

```bash
python mock/serve.py 8899                  # 静态站 + /chicken/api/* 反代到真 hub
python server/farm_server.py --port 28910  # 联机服（另开一个终端）
bash tools/ci.sh                           # 语法／断言；加 --with-browser 再跑浏览器
```

页面带 `?debug` 才会把内部状态挂到 `window.__farm`（自测脚本全靠它）。

## 许可

[MIT](LICENSE)。`vendor/` 内是 three.js（同样 MIT）。
