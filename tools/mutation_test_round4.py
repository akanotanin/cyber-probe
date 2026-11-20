#!/usr/bin/env python3
"""反向验证：把 test_audit_round4.py 覆盖的每处修复逐一「塞回」副本，确认测试真的变红。

全绿的测试如果永远不会红，就等于没测试。副本落在 build/mut4，不动工作区。
跑法：python tools/mutation_test_round4.py
"""
import io
import os
import pathlib
import shutil
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
MUT = ROOT / 'build' / 'mut4'
TEST = 'tools/test_audit_round4.py'

# (名字, 文件, 搜索串, 替换串)
MUTATIONS = [
    ('R1 nginx 用本机 which 判目标机', 'tools/nginx_patch.py',
     "    elif have_target('nginx'):\n        VALIDATE_CMD = 'nginx -t'",
     "    elif shutil.which('nginx'):\n        VALIDATE_CMD = 'nginx -t'"),
    ('R1b caddy 卸载用本机 which', 'tools/caddy_patch.py',
     "        if have_target('caddy'):\n            run_cmd('caddy validate --config %s && { systemctl is-active --quiet caddy",
     "        if shutil.which('caddy'):\n            run_cmd('caddy validate --config %s && { systemctl is-active --quiet caddy"),
    ('R1c 无 HOST 时仍去跑 ssh 探测', 'tools/nginx_patch.py',
     "if VALIDATE_CMD is None and (LOCAL or HOST):",
     "if VALIDATE_CMD is None:"),
    ('R2 SQLite 兜底回到宽 except', 'tools/gen_config.py',
     "    except sqlite3.OperationalError as e:\n        if not _is_missing_interval(e):\n            raise\n",
     "    except sqlite3.OperationalError:\n"),
    ('R2b SQLite 兜底条件放宽成恒真', 'tools/gen_config.py',
     "    return 'no such column' in msg or 'no column named' in msg",
     "    return True"),
    ('R3 cachebust 正则回到死代码版', 'tools/cachebust.py',
     '''JS_BARE = re.compile(r"""(?m)^([ \\t]*import\\s+['"])(\\.{1,2}/[\\w./-]+\\.js)(['"])""")''',
     '''JS_BARE = re.compile(r"""(^|\\n\\s*import\\s+['"])(\\.{1,2}/[\\w./-]+\\.js)(['"])""")'''),
    ('R4 nginx 不拒 - 开头的 HOST', 'tools/nginx_patch.py',
     "    if a.startswith('-'):\n        # ⚠ HOST 会被塞进 ['ssh', HOST, ...]",
     "    if False:\n        # ⚠ HOST 会被塞进 ['ssh', HOST, ...]"),
    ('R5 backup_file 回到 xargs', 'tools/run_header.sh',
     '  local old\n  while IFS= read -r old; do\n    [ -n "$old" ] && rm -f -- "$old"\n  done < <(ls -1t -- "$f.bak-"* 2>/dev/null | tail -n +$((BAK_KEEP + 1)))',
     '  ls -1t -- "$f.bak-"* 2>/dev/null | tail -n +$((BAK_KEEP + 1)) | xargs -r rm -f'),
    ('R6 subst_lit 换回 bash 模式替换', 'tools/run_header.sh',
     'unit="$(subst_lit "$unit" \'__APPDIR__\' "$APPDIR")"',
     'unit="${unit//__APPDIR__/$APPDIR}"'),
    ('R7 modelFallback 回到裸插值', 'tools/run_header.sh',
     "modelFallback: '$model_src_js'", "modelFallback: '${MODEL_SRC:-}'"),
    ('R8 caddy 不剥注释', 'tools/caddy_patch.py',
     '                code = code_of(lines[j])       # 深度只数代码里的花括号',
     '                code = lines[j]'),
    ('R9 大门逻辑被删（死代码）', 'js/world.js',
     '      for (const l of gateLeaves) l.g.rotation.y = l.dir * gateA * 1.45;\n',
     '\n'),
    ('R10 mock nezha 回到裸 recv', 'mock/nezha.py',
     '                    payload = self._recv_exact(n) if n else b\'\'',
     '                    payload = self.connection.recv(n) if n else b\'\''),
    ('R11 mutation_test 不捕超时', 'tools/mutation_test.py',
     '    except subprocess.TimeoutExpired as e:',
     '    except KeyboardInterrupt as e:'),
    ('R12 gen_config 不编码 URI', 'tools/gen_config.py',
     "    return 'file:' + urllib.parse.quote(str(path)) + '?mode=ro'",
     "    return f'file:{path}?mode=ro'"),
    ('R13 data.js 的 pingOnly 失效', 'js/data.js',
     '      if (pingOnly) {\n        d = Komari.mapDetail(null, Komari.unwrap(await getJSON(pingUrl, signal)));\n      } else {',
     '      if (false) {\n        d = Komari.mapDetail(null, Komari.unwrap(await getJSON(pingUrl, signal)));\n      } else {'),
]


def prepare():
    if MUT.exists():
        shutil.rmtree(MUT)
    shutil.copytree(ROOT, MUT, ignore=shutil.ignore_patterns(
        '.git', 'build', 'dist', 'shots', 'scratch', 'research', '.cache', 'node_modules', 'vendor'))
    return MUT


def run_test():
    r = subprocess.run([sys.executable, TEST], cwd=str(MUT), capture_output=True, text=True,
                       timeout=300)
    return r.returncode, (r.stdout or '') + (r.stderr or '')


def main():
    only = [a for a in sys.argv[1:] if a]
    prepare()
    base_rc, base_out = run_test()
    print('基线（未变异）: 退出码 %d' % base_rc)
    if base_rc != 0:
        print('!! 基线不是绿的，先修好再做变异测试')
        print(base_out[-3000:])
        return 1
    todo = [m for m in MUTATIONS if not only or m[0].split()[0] in only]
    bad = 0
    for name, rel, old, new in todo:
        p = MUT / rel
        src = io.open(p, encoding='utf-8', newline='').read()
        if old not in src:
            print('%-40s ✗ 变异点没找到' % name)
            bad += 1
            continue
        io.open(p, 'w', encoding='utf-8', newline='').write(src.replace(old, new, 1))
        rc, out = run_test()
        io.open(p, 'w', encoding='utf-8', newline='').write(src)
        red = rc != 0
        fails = [l.strip() for l in out.splitlines() if l.startswith('FAIL')]
        print('%-40s rc=%-3d %s' % (name, rc, ('变红 ✓  ' + (fails[0][:64] if fails else '')) if red else '**没变红 ✗ 测试是死的**'))
        if not red:
            bad += 1
    print('\n结果：%d/%d 个变异被抓住' % (len(todo) - bad, len(todo)))
    return 1 if bad else 0


if __name__ == '__main__':
    sys.exit(main())
