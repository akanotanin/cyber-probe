#!/usr/bin/env python3
"""安装器 detect_hub 的 Komari 识别单测（不需要真的 systemd / docker / Linux）。

把 run_header.sh 里的 detect_backend_kind + detect_hub 抠出来，用假的 hub_unit /
hub_exec_args / docker 跑三种环境：
  · komari.service（-l 0.0.0.0:25774）→ komari / 25774 / http://127.0.0.1:25774
  · Docker 容器 komari 映射 25774        → komari / 25774
  · monitor-hub.service（--listen :28080 --db …）→ monitor / 28080 / 数据库路径
"""
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

tmp = pathlib.Path(tempfile.mkdtemp(prefix='cp-komari-inst-'))
(tmp / 'funcs.sh').write_text(funcs, encoding='utf-8')
bin_dir = tmp / 'bin'
bin_dir.mkdir()
docker = bin_dir / 'docker'
docker.write_text('#!/bin/sh\nif [ "$1" = "ps" ]; then printf "komari 0.0.0.0:25774->25774/tcp\\n"; fi\n', encoding='utf-8')
docker.chmod(0o755)


def run_case(kind, unit, args, path, webroot='', prev_kind='', prev_port='', prev_url='',
             komari_url=''):
    script = f'''set -u
say() {{ :; }}
die() {{ echo "DIE $*"; exit 1; }}
UNIT={unit!r}
ARGS={args!r}
hub_unit() {{ [ -n "$UNIT" ] && printf '%s' "$UNIT" || return 1; }}
hub_exec_args() {{ printf '%s' "$ARGS"; }}
HUB_KIND={kind!r}; HUB_PORT=""; MONITOR_DB=""; DOMAIN=""; KOMARI_URL={komari_url!r}
PREV_HUB_KIND={prev_kind!r}; PREV_HUB_PORT={prev_port!r}; PREV_KOMARI_URL={prev_url!r}
WEBROOT={webroot!r}
WORK={str(ROOT)!r}
. {str(tmp / 'funcs.sh')!r}
detect_hub
printf 'KIND=%s|PORT=%s|URL=%s|DB=%s\\n' "$HUB_KIND" "$HUB_PORT" "$KOMARI_URL" "$MONITOR_DB"
'''
    env = {'PATH': path, 'HOME': str(tmp)}
    p = subprocess.run(['bash', '-c', script], capture_output=True, text=True,
                       encoding='utf-8', errors='replace', env=env)
    return p.stdout.strip(), p.stderr.strip(), p.returncode


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

web2 = tmp / 'site2'
(web2 / 'js').mkdir(parents=True)
(web2 / 'js' / 'config.js').write_text('export const SOURCE = "monitor";\n', encoding='utf-8')
out, err, rc = run_case('auto', '', '', '/usr/bin:/bin', web2.as_posix())
check('已有 config.js SOURCE=monitor：没有单元/容器时沿用 monitor（不误切 Komari）',
      rc == 0 and out.startswith('KIND=monitor|PORT=28080|'), f'rc={rc} out={out!r} err={err!r}')

# 单元/容器是比旧 config.js 更强的信号：删掉 Komari 后同机装 Monitor，应跟着 monitor 单元走。
out, err, rc = run_case('auto', 'monitor-hub',
                        '/opt/monitor/monitor --listen :28080', '/usr/bin:/bin', web.as_posix())
check('monitor 单元覆盖旧 config.js 的 komari（切回 Monitor 不需要 --source）',
      rc == 0 and out.startswith('KIND=monitor|PORT=28080|'), f'rc={rc} out={out!r} err={err!r}')

out, err, rc = run_case('auto', 'komari', '/usr/bin/komari server -l 0.0.0.0:25774',
                        '/usr/bin:/bin', web2.as_posix())
check('komari 单元覆盖旧 config.js 的 monitor',
      rc == 0 and out.startswith('KIND=komari|PORT=25774|'), f'rc={rc} out={out!r} err={err!r}')

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

print()
if fails:
    print('失败 %d 项：%s' % (len(fails), '，'.join(fails)))
    sys.exit(1)
print('全部通过')
