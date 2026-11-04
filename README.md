![预览](preview.jpg)

# cyber-probe

把 Monitor hub / [Komari](https://www.komari.wiki/) / [哪吒监控（Nezha）](https://nezha.wiki/) 的实时监控数据做成一座可玩的 3D 小鸡农场：每台机器一只探针鸡，每个 ping 任务／服务监控一只网站鸡。

## 玩法

- **探针鸡**：国旗、CPU／内存双环、网速、磁盘、负载、在线时长、机型。
- **网站鸡**：平均延迟、最好／最差节点、丢包；哪吒模式显示「近 15 分钟探测 N 次」。
- **暴躁鸡**：CPU／内存超阈值或网络最差的那台会主动啄人；大白鹅有领地意识，可被反杀。
- **多人同场**：服务端裁定战斗，客户端算移动；有啄倒榜、在线统计、手机摇杆。
- **面板入口**：按 <kbd>Tab</kbd> 打开探针列表，点鸡或卡片看详情；⚙ 进后台（站点没有后台时自动隐藏）。

## 安装

前提：Linux + systemd + `python3` 3.9+，已运行 Monitor hub、Komari 或哪吒，并有 nginx/Caddy 反代。

```bash
curl -fsSL https://github.com/akanotanin/cyber-probe/releases/latest/download/cyber-probe.run -o cyber-probe.run
sudo bash cyber-probe.run install
```

向导只问挂载位置、联机服端口、玩法参数。脚本会自动识别后端与端口、生成 `js/config.js`、部署静态站与联机服、补 nginx/Caddy 反代并探活；改过监控任务后重跑 `install` 即可刷新名单。

### 后端

- **Monitor hub**：只读 SQLite 与同源 `/api/*`。
- **Komari**：走公开 API（`/api/nodes`、`/api/clients`、`/api/records/*`）；站点需关闭「私有站点」。自动认 `komari.service`／容器／`25774`，认不到时用 `--source komari --hub-port 25774`，可选 `--komari-url`。
- **哪吒**：走游客 API（`/api/v1/ws/server`、`/api/v1/service`、历史/指标）。需关闭「强制认证」、服务器不对游客隐藏。自动认单元／容器／`8008`，认不到时用 `--source nezha --hub-port 8008`，可选 `--nezha-url`。网站鸡是服务监控；资源历史需 TSDB；游客只能看 1 天。
- `--source auto`（默认）优先沿用已安装 `config.js` 的来源；切换请显式 `--source`，或给出 `--hub-port`。

## 参数

```bash
sudo bash cyber-probe.run config
sudo bash cyber-probe.run config --geese 3 --show-web 0 --hot-max 2
```

| 参数 | 含义 | 默认 |
| --- | --- | --- |
| `--geese N` / `--dogs N` | 大白鹅 / 看门狗数量 | 2 / 1 |
| `--show-web 0\|1` | 是否出现网站鸡 | 1 |
| `--hot-cpu N` / `--hot-mem N` | 暴躁鸡阈值（%） | 55 / 85 |
| `--hot-max N` | 最多暴躁鸡数（0 = 不限） | 0 |
| `--path /farm/` | 挂载路径 | `/chicken/` |
| `--mount path\|domain` | 子路径或独立域名 | path |
| `--source monitor\|komari\|nezha` | 强制数据源 | auto |
| `--komari-url` / `--nezha-url` | API 根地址 | `http://127.0.0.1:<hub-port>` |

设置存 `/etc/cyber-probe/farm.conf`；重装、`config`、`update` 都读它。

## 命令

| 命令 | 作用 |
| --- | --- |
| `status` | 单元／端口／站点／API／WS 探活 |
| `config` | 改玩法参数并重启 |
| `update` | 拉最新包，用现有设置重装 |
| `selftest` | 兼容性自测 |
| `restart` / `logs [n]` / `test` / `uninstall` | 重启 / 日志 / 服务端自测 / 卸载 |

全部命令：`sudo bash cyber-probe.run <命令>`；`--dry-run` 只看设置，完整参数见 `--help`。

## 数据与隐私

- **只读**：Monitor 只读 SQLite/API；Komari、哪吒只读公开 API。
- **`js/config.js` 只有**任务名、间隔、国旗码；不导出主机名/IP、节点 UUID、探测目标。
- **实时数据**：Komari `/chicken/api/clients`、哪吒 `/chicken/api/v1/ws/server`；安装器自动补 WebSocket 反代。
- **自托管**：模型/国旗从本站 `vendor/` 加载；联机服只监听回环；NPC 白名单只允许真实节点/任务 id。

## 本地开发

```bash
python3 tools/gen_config.py --stub --out js/config.js
python3 tools/gen_config.py --komari http://127.0.0.1:25774 --out js/config.js
python3 tools/gen_config.py --nezha http://127.0.0.1:8008 --out js/config.js
MOCK_UPSTREAM=https://hub.example.com python mock/serve.py 8899
python mock/komari.py 8898
python mock/nezha.py 8896
python server/farm_server.py --port 28910
bash tools/ci.sh
```

联机调试：`http://127.0.0.1:8899/chicken/?ws=ws://127.0.0.1:28910/ws`；哪吒 mock 直接 `python mock/nezha.py 8896`，打开 `http://127.0.0.1:8896/chicken/?debug&nomodels`。`?debug` 会把状态挂到 `window.__farm`。

## 许可

[MIT](LICENSE)。`vendor/` 内是 three.js（MIT）。
