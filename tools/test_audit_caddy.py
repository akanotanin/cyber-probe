#!/usr/bin/env python3
"""Caddy 补丁器的回归测试（报告 BUG-02/09/11/20/30/32）。"""
import os
import pathlib
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
CAD = ROOT / 'tools' / 'caddy_patch.py'
PY = sys.executable
fails = []


def check(name, cond, detail=''):
    print(('PASS  ' if cond else 'FAIL  ') + name + ('  ' + detail if (detail and not cond) else ''))
    if not cond:
        fails.append(name)


def run(args):
    return subprocess.run([PY] + args, capture_output=True, text=True,
                          encoding='utf-8', errors='replace')


TMP = pathlib.Path(tempfile.mkdtemp(prefix='cp-caddy-'))
conf = TMP / 'Caddyfile'
snip = TMP / 'conf.d' / 'cyber-probe.caddy'
src = (
    "# 别人的站点\n"
    "a.test {\n"
    "\troot * /var/www/a\n"
    "\tfile_server\n"
    "}\n\n"
    "b.test {\n"
    "\treverse_proxy 127.0.0.1:28080\n"
    "}\n"
)
conf.write_text(src, encoding='utf-8', newline='')

# ---- 1) 域名不匹配时兜底必须选中「含 hub 上游」的 b.test，不能越界插到 a.test（BUG-11）----
r = run([str(CAD), '--local', '--no-reload', '--conf', str(conf), '--snippet', str(snip),
         '--domain', 'nope.test', '--hub-port', '28080', '--ws-port', '28910',
         '--webroot', '/srv/site', '--path', '/chicken'])
check('兜底插入成功', r.returncode == 0, r.stdout + r.stderr)
out = conf.read_text(encoding='utf-8')
a_end = out.find('b.test {')
imp = out.find('import ' + str(snip))
check('import 行落在 b.test 块里（a.test 之后）', a_end < imp, 'a_end=%d imp=%d' % (a_end, imp))
block_a = out[:a_end]
check('a.test 块没被污染', 'import ' not in block_a, block_a)
check('片段文件已写', snip.exists())
before_rm = out

# ---- 2) 卸载只删片段本体，不动自己的备份；Caddyfile 有 -rm 备份（BUG-09）----
# 换 webroot 再装一次 → 片段内容变了，才会留下 .bak-<stamp>-add（同内容会 SKIP）
r = run([str(CAD), '--local', '--no-reload', '--conf', str(conf), '--snippet', str(snip),
         '--domain', 'nope.test', '--hub-port', '28080', '--ws-port', '28910',
         '--webroot', '/srv/site2', '--path', '/chicken'])
check('第二次安装成功刷新片段', r.returncode == 0, r.stdout + r.stderr)
baks = sorted(p.name for p in snip.parent.glob('cyber-probe.caddy.bak-*'))
check('安装留了片段备份', len(baks) >= 1, str(baks))
r = run([str(CAD), '--local', '--no-reload', '--remove', '--conf', str(conf), '--snippet', str(snip),
         '--ws-port', '28910', '--hub-port', '28080', '--webroot', '/srv/site', '--path', '/chicken'])
out = conf.read_text(encoding='utf-8')
check('卸载后 import 行没了', 'import ' + str(snip) not in out)
check('卸载后 Caddyfile 回到原文', out == src, out)
check('卸载后片段本体已删', not snip.exists())
still = [p.name for p in snip.parent.glob('cyber-probe.caddy.bak-*')]
check('卸载没把 .bak-*-add 一起删掉', len(still) >= 1, str(still))
check('卸载留了 Caddyfile 的 -rm 备份',
      any(p.name.startswith('Caddyfile.bak-') and p.name.endswith('-rm') for p in TMP.iterdir()),
      str([p.name for p in TMP.iterdir()]))

# ---- 3) 卸载自检失败要回滚（配置 + 片段都回来）（BUG-09）----
conf.write_text(src, encoding='utf-8', newline='')
run([str(CAD), '--local', '--no-reload', '--conf', str(conf), '--snippet', str(snip),
     '--domain', 'b.test', '--hub-port', '28080', '--ws-port', '28910',
     '--webroot', '/srv/site', '--path', '/chicken'])
patched = conf.read_text(encoding='utf-8')
r = run([str(CAD), '--local', '--conf', str(conf), '--snippet', str(snip), '--remove',
         '--validate', 'false', '--hub-port', '28080', '--ws-port', '28910',
         '--webroot', '/srv/site', '--path', '/chicken'])
check('卸载自检失败 → exit 4', r.returncode == 4, str(r.returncode))
check('卸载自检失败 → Caddyfile 回滚', conf.read_text(encoding='utf-8') == patched)
check('卸载自检失败 → 片段也回来了', snip.exists())

# ---- 4) --conf 传 Caddyfile 路径时不再当目录（BUG-20）----
alt = TMP / 'AltCaddyfile'
alt.write_text('c.test {\n\troot * /x\n}\n', encoding='utf-8')
r = run([str(CAD), '--local', '--no-reload', '--conf', str(alt), '--snippet', str(TMP / 's2.caddy'),
         '--domain', 'c.test', '--hub-port', '28080', '--ws-port', '28910',
         '--webroot', '/srv/site', '--path', '/chicken'])
check('--conf 传文件路径可用', r.returncode == 0 and 'import ' in alt.read_text(encoding='utf-8'),
      r.stdout + r.stderr)

# ---- 5) 默认自检命令里的路径要加引号（BUG-20）----
import re
src_code = CAD.read_text(encoding='utf-8')
check('默认 validate 命令用了 shlex.quote',
      "VALIDATE_CMD = '' if NO_RELOAD else 'caddy validate --config ' + shlex.quote(CONF)" in src_code)
check('reload 前的 validate 也 quote',
      '-rm 备份' not in src_code and "shlex.quote(CONF))" in src_code)

print()
print('失败 %d 项' % len(fails) if fails else '全部通过')
sys.exit(1 if fails else 0)
