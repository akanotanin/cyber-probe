![预览](preview.png)

# cyber-probe

把 [monitor](https://github.com/monitor-probe/monitor) 探针的实时数据变成一座**可玩的 3D 小鸡农场**。

- **每台 VPS = 一只探针鸡**：名牌上是真数据（国旗、CPU／内存双环、网速、磁盘、负载、在线时长、机型、血条）
- **每个 ping 任务 = 一只网站鸡**：名牌给平均延迟、最好／最差节点、丢包
- **CPU > 55% 或内存 > 85% 的机器变暴躁鸡**，会追着玩家啄；网络最差的那台也暴躁（脚下红环）
- **多人同场**：战斗（啄／扇翅／伤害／倒地）服务端裁定，移动客户端自算（手感优先）
- **右上「🐔 啄倒榜」+ 左下自身卡片**：谁把谁啄倒由**服务端裁定**（客户端上报的战绩一律忽略），榜按啄倒数实时排序、自己那行高亮、离场玩家的战绩灰显存档；卡片是名字／血条／🏆啄倒数，被啄晕时显示复活倒计时

一条命令装在**你自己的 hub 那台机器**上，探针名单现场从你自己的数据库生成。

## 安装

前提：Linux + systemd + `python3` 3.9+；机器上跑着 monitor hub，并有 nginx 或 Caddy 在给它做反代。

```bash
curl -fsSL https://github.com/akanotanin/cyber-probe/releases/latest/download/cyber-probe.run -o cyber-probe.run
sudo bash cyber-probe.run install --yes
```

它会做这几件事（幂等，可反复跑）：

1. 从 hub 的 systemd 单元认出 `--listen`（端口）、`--db`（数据库）、`--site`（域名）
2. 就地**只读**那份 SQLite，生成静态站的 `js/config.js`
3. 部署静态站 + 联机服 + `cyber-probe.service`（DynamicUser，只监听 `127.0.0.1`）
4. 给 nginx 或 Caddy **幂等**补三块：`/chicken/api/*` → hub 的 `/api/`、`/chicken/ws` → 联机服、
   `/chicken/*` → 静态站（改前备份，写完自检不过**自动回滚**）
5. 站点／接口／WebSocket 各探活一次并打印结果

装完打开 `https://你的域名/chicken/`。hub 里增删 ping 任务后**重跑一次 install** 就能刷新名单。

> `/chicken/` 是路径约定：主题 [monitor-theme-jikasei](https://github.com/akanotanin/monitor-theme-jikasei) 的
> 顶栏图标靠 `GET /chicken/api/nodes` 回不回应 JSON 判断本站装没装，装了才显示入口。

## 其他模式

```bash
sudo bash cyber-probe.run status      # 单元/端口/站点/接口/WebSocket 探活 + 最近日志
sudo bash cyber-probe.run restart
sudo bash cyber-probe.run logs 100
sudo bash cyber-probe.run test        # 机上跑服务端协议自测（78 项）
sudo bash cyber-probe.run uninstall   # 停服+删单元+删目录+摘反代块；静态站先打包备份到 /root
```

需要手动指定时：`--domain <域名> --proxy nginx|caddy --nginx-conf <路径> --caddyfile <路径>
--hub-port <端口> --monitor-db <路径> --webroot <路径> --port <端口> --no-geo --yes`

## 数据与隐私

- **只读**：只读 hub 的 SQLite 与同源 `/api/*`，不往里写任何东西
- **公开的 `js/config.js` 里只有**探测任务名、间隔、国旗码；**节点主机名／IP 与探测目标域名一律不导出**
- 联机服只监听回环，对外只能经你自己的反代进来；有每 IP 并发上限、每连接限流，客户端数值全部过 `isfinite`

## 目录

```
js/                    前端：地形 / 方块鸡模型与名牌 / 探针鸡·网站鸡 / HUD / WS 联机 / 轮询聚合 / 音效
server/farm_server.py  联机服：纯标准库手写 WebSocket，20Hz 快照，战斗服务端权威
server/test_server.py  协议自测（白盒 + 黑盒）
tools/                 一键包头 run_header.sh、打包 pack_run.sh、gen_config.py（读 hub 库生成名单）、
                       nginx_patch.py / caddy_patch.py（幂等补丁）、ci.sh
mock/serve.py          本地自测伺服（静态 + /chicken/api/* 反代，等价线上反代）
systemd/               单元模板（占位符 __APPDIR__ / __WS_PORT__）
```

## 本地开发

```bash
python mock/serve.py 8899                        # 静态 + /chicken/api/* 反代到真 hub
python server/farm_server.py --port 28910        # 本地联机服（另开一个终端）
node tools/cdp_test.mjs                          # 浏览器断言 + 截图（要 node + Chrome）
python server/test_server.py 127.0.0.1 28910     # 服务端协议自测（78 项，不用浏览器）
bash tools/ci.sh                                 # 语法/符号/模块解析 + 隔离实例全套断言
bash tools/ci.sh --with-browser                  # 再带上浏览器断言
```

页面带 `?debug` 才会把内部状态挂到 `window.__farm`（自测脚本全靠它）。

## 许可

[MIT](LICENSE)。代码为本项目原创实现；`vendor/` 内是 three.js（同样 MIT）。
