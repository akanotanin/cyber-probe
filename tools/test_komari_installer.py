#!/usr/bin/env python3
"""安装器 detect_hub 的 Komari 识别单测（不需要真的 systemd / docker / Linux）。

把 run_header.sh 里的 detect_backend_kind + detect_hub 抠出来，用假的 hub_unit /
hub_exec_args / docker 跑三种环境：
  · komari.service（-l 0.0.0.0:25774）→ komari / 25774 / http://127.0.0.1:25774
  · Docker 容器 komari 映射 25774        → komari / 25774
  · monitor-hub.service（--listen :28080 --db …）→ monitor / 28080 / 数据库路径
"""
import os
import pathlib
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
HDR = ROOT / 'tools' / 'run_header.sh'
fails = []


def check(name, cond, detail=''):
    print(('PASS  ' if cond else 'FAIL  ') + name + ('  ' + str(detail) if (detail and not cond) else ''))
    if not cond:
        fails.append(name)


hdr = HDR.read_text(encoding='utf-8')
start = hdr.index('detect_backend_kind() {')
end = hdr.index('detect_proxy() {')
funcs = hdr[start:end]

tmp = ROOT / 'build' / 'ci' / ('installer-%d' % os.getpid())
tmp.mkdir(parents=True, exist_ok=True)
(tmp / 'funcs.sh').write_text(funcs, encoding='utf-8')
bin_dir = tmp / 'bin'
bin_dir.mkdir()
docker = bin_dir / 'docker'
docker.write_text('#!/bin/sh\nif [ "$1" = "ps" ]; then printf "komari 0.0.0.0:25774->25774/tcp\\n"; fi\n', encoding='utf-8')
docker.chmod(0o755)


def run_case(kind, unit, args, path, webroot='', prev_kind='', prev_port='', prev_url='',
             komari_url='', nezha_url='', prev_nezha_url='', detect_kind='', hub_port=''):
    script = f'''set -u
say() {{ :; }}
die() {{ echo "DIE $*"; exit 1; }}
UNIT={unit!r}
ARGS={args!r}
hub_unit() {{ [ -n "$UNIT" ] && printf '%s' "$UNIT" || return 1; }}
hub_exec_args() {{ printf '%s' "$ARGS"; }}
HUB_KIND={kind!r}; HUB_PORT={hub_port!r}; CLI_HUB_PORT={1 if hub_port else 0}; MONITOR_DB=""; DOMAIN=""; KOMARI_URL={komari_url!r}
NEZHA_URL={nezha_url!r}
PREV_HUB_KIND={prev_kind!r}; PREV_HUB_PORT={prev_port!r}; PREV_KOMARI_URL={prev_url!r}
PREV_NEZHA_URL={prev_nezha_url!r}
WEBROOT={webroot!r}
WORK={str(ROOT)!r}
. {str(tmp / 'funcs.sh')!r}
if [ -n {detect_kind!r} ]; then detect_backend_kind() {{ printf '%s' {detect_kind!r}; }}; fi
detect_hub
printf 'KIND=%s|PORT=%s|URL=%s|DB=%s\\n' "$HUB_KIND" "$HUB_PORT" "$KOMARI_URL" "$MONITOR_DB"
[ -n "$NEZHA_URL" ] && printf 'NZURL=%s\\n' "$NEZHA_URL"
exit 0
'''
    env = {'PATH': path, 'HOME': str(tmp)}
    # 临时文件而不是管道：部分 Windows 沙箱会拒绝 CreatePipe（WinError 5）；Linux 行为不变。
    fd_o, po = tempfile.mkstemp(prefix='cp-inst-', suffix='.out')
    fd_e, pe = tempfile.mkstemp(prefix='cp-inst-', suffix='.err')
    os.close(fd_o)
    os.close(fd_e)
    try:
        with open(po, 'w', encoding='utf-8') as fo, open(pe, 'w', encoding='utf-8') as fe:
            p = subprocess.run(['bash', '-c', script], stdout=fo, stderr=fe, env=env)
        out = pathlib.Path(po).read_text(encoding='utf-8', errors='replace')
        err = pathlib.Path(pe).read_text(encoding='utf-8', errors='replace')
    finally:
        for f in (po, pe):
            try:
                os.unlink(f)
            except OSError:
                pass
    return out.strip(), err.strip(), p.returncode


out, err, rc = run_case('auto', 'komari', '/usr/bin/komari server -l 0.0.0.0:25774',
                        str(bin_dir) + ':/usr/bin:/bin')
check('systemd komari：识别为 komari + 25774 + 默认 API URL',
      rc == 0 and out == 'KIND=komari|PORT=25774|URL=http://127.0.0.1:25774|DB=', f'rc={rc} out={out!r} err={err!r}')

out, err, rc = run_case('auto', '', '', str(bin_dir) + ':/usr/bin:/bin')
check('Docker komari：识别为 komari + 宿主映射端口 25774',
      rc == 0 and out == 'KIND=komari|PORT=25774|URL=http://127.0.0.1:25774|DB=', f'rc={rc} out={out!r} err={err!r}')

out, err, rc = run_case('auto', 'monitor-hub',
                        '/opt/monitor/monitor --listen :28080 --db /opt/monitor/data/monitor.db',
                        '/usr/bin:/bin')
check('systemd monitor-hub：仍是 monitor + 28080 + --db',
      rc == 0 and out == 'KIND=monitor|PORT=28080|URL=|DB=/opt/monitor/data/monitor.db',
      f'rc={rc} out={out!r} err={err!r}')

out, err, rc = run_case('komari', 'monitor-hub', '/opt/monitor/monitor --listen :28080',
                        '/usr/bin:/bin')
check('显式 --source komari：monitor 单元被忽略，端口不借用 28080',
      rc == 0 and out.startswith('KIND=komari|PORT=25774|'), f'rc={rc} out={out!r}')

out, err, rc = run_case('monitor', 'komari', '/usr/bin/komari server -l 0.0.0.0:25774',
                        '/usr/bin:/bin')
check('显式 --source monitor：komari 单元被忽略，端口不借用 25774',
      rc == 0 and out.startswith('KIND=monitor|PORT=28080|'), f'rc={rc} out={out!r}')

# 没有单元/容器/API（例如二进制手动跑在 screen 里）：显式 --source komari 也要落到 25774，
# 不能退回 monitor 的 28080。
out, err, rc = run_case('komari', '', '', '/usr/bin:/bin')
check('无单元/容器时 --source komari 默认 25774（不退回 28080）',
      rc == 0 and out == 'KIND=komari|PORT=25774|URL=http://127.0.0.1:25774|DB=',
      f'rc={rc} out={out!r} err={err!r}')

# Komari 暂时没起（单元/容器/API 全探不到），但站点的 config.js 还是 SOURCE=komari：
# update/重装必须沿用 Komari，不能悄悄刷回 monitor。
web = tmp / 'site'
(web / 'js').mkdir(parents=True)
(web / 'js' / 'config.js').write_text('export const SOURCE = "komari";\n', encoding='utf-8')
out, err, rc = run_case('auto', '', '', '/usr/bin:/bin', web.as_posix())
check('已有 config.js SOURCE=komari：探测失败也沿用 komari（不刷回 monitor）',
      rc == 0 and out.startswith('KIND=komari|PORT=25774|'), f'rc={rc} out={out!r} err={err!r}')

# 同机还跑着一个 8008 的哪吒（裸端口 API 探测会先看到它）：
# 已安装的 config.js 比「端口上碰巧跑着谁」更强，status/update 不能把数据源误切过去。
out, err, rc = run_case('auto', '', '', '/usr/bin:/bin', web.as_posix(), detect_kind='nezha')
check('已安装 komari + 8008 另有哪吒：已安装来源优先，不误切哪吒',
      rc == 0 and out.startswith('KIND=komari|PORT=25774|'), f'rc={rc} out={out!r} err={err!r}')

# 但用户显式 --hub-port 8008 就是在指「这次连环哪个后端」：端口探测应优先于旧 config.js。
out, err, rc = run_case('auto', '', '', '/usr/bin:/bin', web.as_posix(),
                        detect_kind='nezha', hub_port='8008')
check('显式 --hub-port 8008：旧 config 是 komari 也按端口切到哪吒',
      rc == 0 and out.startswith('KIND=nezha|PORT=8008|'), f'rc={rc} out={out!r} err={err!r}')

# 但全新机器（没有 config.js）上，8008 的哪吒仍要被自动认出来。
out, err, rc = run_case('auto', '', '', '/usr/bin:/bin', detect_kind='nezha')
check('没有 config.js：8008 的哪吒仍能被自动认出来',
      rc == 0 and out.startswith('KIND=nezha|PORT=8008|'), f'rc={rc} out={out!r} err={err!r}')

web2 = tmp / 'site2'
(web2 / 'js').mkdir(parents=True)
(web2 / 'js' / 'config.js').write_text('export const SOURCE = "monitor";\n', encoding='utf-8')
out, err, rc = run_case('auto', '', '', '/usr/bin:/bin', web2.as_posix())
check('已有 config.js SOURCE=monitor：没有单元/容器时沿用 monitor（不误切 Komari）',
      rc == 0 and out.startswith('KIND=monitor|PORT=28080|'), f'rc={rc} out={out!r} err={err!r}')

# 已安装来源（config.js）优先于同机其他监控单元：不能让一个顺手装的哪吒/monitor
# 单元把现有农场的数据源抢走（要真正切换必须显式 --source）。
out, err, rc = run_case('auto', 'monitor-hub',
                        '/opt/monitor/monitor --listen :28080', '/usr/bin:/bin', web.as_posix())
check('已安装 komari + 同机 monitor 单元：仍按已安装 komari',
      rc == 0 and out.startswith('KIND=komari|PORT=25774|'), f'rc={rc} out={out!r} err={err!r}')

out, err, rc = run_case('auto', 'komari', '/usr/bin/komari server -l 0.0.0.0:25774',
                        '/usr/bin:/bin', web2.as_posix())
check('已安装 monitor + 同机 komari 单元：仍按已安装 monitor',
      rc == 0 and out.startswith('KIND=monitor|PORT=28080|'), f'rc={rc} out={out!r} err={err!r}')

# 同一数据源的单元仍用来发现自定义端口（config.js 只记 source，不记端口）。
out, err, rc = run_case('auto', 'komari', '/usr/bin/komari server -l 0.0.0.0:9999',
                        '/usr/bin:/bin', web.as_posix())
check('已安装 komari + 同源 komari 单元：沿用单元的自定义端口 9999',
      rc == 0 and out.startswith('KIND=komari|PORT=9999|'), f'rc={rc} out={out!r} err={err!r}')

out, err, rc = run_case('auto', 'monitor-hub',
                        '/opt/monitor/monitor --listen :9998 --db /opt/monitor/data/monitor.db',
                        '/usr/bin:/bin', web2.as_posix())
check('已安装 monitor + 同源 monitor 单元：沿用端口 9998 与 --db',
      rc == 0 and out.startswith('KIND=monitor|PORT=9998|') and 'DB=/opt/monitor/data/monitor.db' in out,
      f'rc={rc} out={out!r} err={err!r}')

# 自定义端口/地址落盘后，探测不到后端也要沿用（update/重装/卸载不丢端点）。
out, err, rc = run_case('auto', '', '', '/usr/bin:/bin', prev_kind='komari', prev_port='12345')
check('settings 兜底：komari + 自定义端口 12345 不回落 25774',
      rc == 0 and out == 'KIND=komari|PORT=12345|URL=http://127.0.0.1:12345|DB=',
      f'rc={rc} out={out!r} err={err!r}')

out, err, rc = run_case('monitor', '', '', '/usr/bin:/bin', prev_kind='komari', prev_port='12345')
check('--source monitor 不借用上次 Komari 的自定义端口',
      rc == 0 and out.startswith('KIND=monitor|PORT=28080|'), f'rc={rc} out={out!r}')

out, err, rc = run_case('komari', '', '', '/usr/bin:/bin', prev_kind='monitor', prev_port='28080')
check('--source komari 不借用上次 Monitor 的端口',
      rc == 0 and out.startswith('KIND=komari|PORT=25774|'), f'rc={rc} out={out!r}')

out, err, rc = run_case('auto', '', '', '/usr/bin:/bin', komari_url='http://127.0.0.1:12345')
check('--komari-url 单独给也强制 Komari，并从回环 URL 取端口',
      rc == 0 and out == 'KIND=komari|PORT=12345|URL=http://127.0.0.1:12345|DB=',
      f'rc={rc} out={out!r} err={err!r}')

# ── 哪吒（Nezha）───────────────────────────────────────────────────────────
# 哪吒的端口写在 config.yaml 的 listen_port，不在命令行；单元名通常是 nezha-dashboard。
nz_cfg = tmp / 'nezha-config.yaml'
nz_cfg.write_text('listen_port: 9001\nhttps:\n  listen_port: 8443\n', encoding='utf-8')
out, err, rc = run_case('auto', 'nezha-dashboard',
                        '/opt/nezha/dashboard/nezha-dashboard -c ' + nz_cfg.as_posix(),
                        '/usr/bin:/bin')
check('systemd nezha-dashboard：只读顶层 listen_port（不把 https.listen_port 当 HTTP 端口）',
      rc == 0 and out.startswith('KIND=nezha|PORT=9001|')
      and 'NZURL=http://127.0.0.1:9001' in out, f'rc={rc} out={out!r} err={err!r}')

nz_cfg_nested = tmp / 'nezha-config-nested.yaml'
nz_cfg_nested.write_text('https:\n  listen_port: 8443\n', encoding='utf-8')
out, err, rc = run_case('auto', 'nezha-dashboard',
                        '/opt/nezha/dashboard/nezha-dashboard -c ' + nz_cfg_nested.as_posix(),
                        '/usr/bin:/bin')
check('systemd nezha-dashboard：没有顶层 listen_port → 默认 8008（不拿 8443）',
      rc == 0 and out.startswith('KIND=nezha|PORT=8008|'), f'rc={rc} out={out!r} err={err!r}')

bin_nz = tmp / 'bin_nezha'
bin_nz.mkdir()
docker_nz = bin_nz / 'docker'
docker_nz.write_text(
    '#!/bin/sh\nif [ "$1" = "ps" ]; then printf "nezha ghcr.io/nezhahq/nezha:latest 0.0.0.0:8008->8008/tcp\\n"; fi\n',
    encoding='utf-8')
docker_nz.chmod(0o755)
out, err, rc = run_case('auto', '', '', str(bin_nz) + ':/usr/bin:/bin')
check('Docker nezha：识别为 nezha + 宿主映射端口 8008',
      rc == 0 and out.startswith('KIND=nezha|PORT=8008|')
      and 'NZURL=http://127.0.0.1:8008' in out, f'rc={rc} out={out!r} err={err!r}')

out, err, rc = run_case('nezha', 'monitor-hub', '/opt/monitor/monitor --listen :28080',
                        '/usr/bin:/bin')
check('显式 --source nezha：monitor 单元被忽略，端口不借用 28080',
      rc == 0 and out.startswith('KIND=nezha|PORT=8008|'), f'rc={rc} out={out!r}')

out, err, rc = run_case('monitor', 'nezha-dashboard',
                        '/opt/nezha/dashboard/nezha-dashboard -c ' + nz_cfg.as_posix(),
                        '/usr/bin:/bin')
check('显式 --source monitor：nezha 单元被忽略，仍走 28080',
      rc == 0 and out.startswith('KIND=monitor|PORT=28080|'), f'rc={rc} out={out!r}')

out, err, rc = run_case('auto', '', '', '/usr/bin:/bin', prev_kind='nezha', prev_port='12345',
                        prev_nezha_url='http://127.0.0.1:12345')
check('settings 兜底：nezha + 自定义端口/URL 不回落 8008',
      rc == 0 and out.startswith('KIND=nezha|PORT=12345|')
      and 'NZURL=http://127.0.0.1:12345' in out, f'rc={rc} out={out!r} err={err!r}')

out, err, rc = run_case('monitor', '', '', '/usr/bin:/bin', prev_kind='nezha', prev_port='12345')
check('--source monitor 不借用上次哪吒的自定义端口',
      rc == 0 and out.startswith('KIND=monitor|PORT=28080|'), f'rc={rc} out={out!r}')

out, err, rc = run_case('auto', '', '', '/usr/bin:/bin', nezha_url='http://127.0.0.1:12345')
check('--nezha-url 单独给也强制哪吒，并从回环 URL 取端口',
      rc == 0 and out.startswith('KIND=nezha|PORT=12345|')
      and 'NZURL=http://127.0.0.1:12345' in out, f'rc={rc} out={out!r} err={err!r}')

# 哪吒暂时没起（单元/容器/API 全探不到），但站点的 config.js 还是 SOURCE=nezha：
# update/重装必须沿用它，不能悄悄刷回 monitor。
web_nz = tmp / 'site-nezha'
(web_nz / 'js').mkdir(parents=True)
(web_nz / 'js' / 'config.js').write_text('export const SOURCE = "nezha";\n', encoding='utf-8')
out, err, rc = run_case('auto', '', '', '/usr/bin:/bin', webroot=web_nz.as_posix())
check('已有 config.js SOURCE=nezha：探测失败也沿用 nezha（不刷回 monitor）',
      rc == 0 and out.startswith('KIND=nezha|PORT=8008|')
      and 'NZURL=http://127.0.0.1:8008' in out, f'rc={rc} out={out!r} err={err!r}')

# 哪吒 Agent 容器名里也有 nezha：不能被当成 Dashboard（没有别的信号时回落到 monitor）。
bin_agent = tmp / 'bin_nezha_agent'
bin_agent.mkdir()
docker_agent = bin_agent / 'docker'
docker_agent.write_text(
    '#!/bin/sh\nif [ "$1" = "ps" ]; then printf "nezha-agent ghcr.io/nezhahq/agent:latest\\n"; fi\n',
    encoding='utf-8')
docker_agent.chmod(0o755)
out, err, rc = run_case('auto', '', '', str(bin_agent) + ':/usr/bin:/bin')
check('只看到 nezha-agent 容器：不误判成 Dashboard（回落 monitor）',
      rc == 0 and out.startswith('KIND=monitor|PORT=28080|'), f'rc={rc} out={out!r} err={err!r}')

print()
if fails:
    print('失败 %d 项：%s' % (len(fails), '，'.join(fails)))
    sys.exit(1)
print('全部通过')
