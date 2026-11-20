#!/usr/bin/env python3
"""2026-11-20 第四轮外部复审的回归测试（复审报告的 13 条 + 自查发现的 2 条）。

覆盖（全部本机可复现，不需要真的 nginx/caddy/hub）：
  ① nginx_patch / caddy_patch：ssh 模式下 which 探的是**目标机**，不是本机
  ② gen_config：SQLite 兜底只吞「缺 interval 列」，表不存在/库被锁要如实抛出
  ③ cachebust：文件第一行的裸 import 也要打 ?v=
  ④ nginx_patch / caddy_patch：- 开头的 HOST 与 PATCH_HOST 直接拒绝（ssh 选项注入）
  ⑤ run_header.sh：backup_file 遇到带空格的文件名也要真的轮换
  ⑥ run_header.sh：APPDIR 含 | 不再把 systemd 单元截成 0 字节
  ⑦ run_header.sh：MODEL_SRC 含引号/尖括号不会写坏 site-options.js
  ⑧ caddy_patch：注释里的不成对花括号不再把 import 插进错误的 vhost
  ⑨ js/world.js：大门「走近推开」已实现（不是只留注释的死代码）
  ⑩ mock/nezha.py：WS 帧读取有 read-exact 缓冲（短读不错位）
  ⑪ mutation_test：ci.sh 超时是受控失败，不是 traceback
  ⑫ gen_config：--db 路径含 # / ? 也能开到正确的文件
  ⑬ data.js：nodeDetail 支持 pingOnly（Komari 下网站鸡详情不白拉 records/load）

跑法：python tools/test_audit_round4.py
"""
import os
import pathlib
import re
import sqlite3
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
PY = sys.executable
NGX = ROOT / 'tools' / 'nginx_patch.py'
CAD = ROOT / 'tools' / 'caddy_patch.py'
GEN = ROOT / 'tools' / 'gen_config.py'
CB = ROOT / 'tools' / 'cachebust.py'
HDR = ROOT / 'tools' / 'run_header.sh'
fails = []


def check(name, cond, detail=''):
    print(('PASS  ' if cond else 'FAIL  ') + name + ('  ' + str(detail)[:600] if (detail and not cond) else ''))
    if not cond:
        fails.append(name)


def write_noeol(path, text):
    path = pathlib.Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, 'w', encoding='utf-8', newline='') as f:
        f.write(text)


def read_raw(path):
    with open(path, encoding='utf-8', newline='') as f:
        return f.read()


def run(args, env=None, cwd=None):
    e = dict(os.environ)
    if env:
        e.update(env)
    return subprocess.run([PY] + [str(a) for a in args], capture_output=True, text=True,
                          encoding='utf-8', errors='replace', stdin=subprocess.DEVNULL,
                          env=e, cwd=cwd)


TMP = pathlib.Path(tempfile.mkdtemp(prefix='cp-r4-'))

# ── ① ssh 模式下的 which 探测 ────────────────────────────────────────────────
# 造一个假 ssh 到 PATH 最前面：它只回答 `command -v nginx`（模拟「远端装了 nginx」），
# 并把真正要执行的远端脚本落盘，供后面断言「校验命令确实发过去了」。
fakebin = TMP / 'bin'
fakebin.mkdir(parents=True, exist_ok=True)
sshlog = TMP / 'ssh-calls.log'
fake_ssh = fakebin / ('ssh.bat' if os.name == 'nt' else 'ssh')
if os.name == 'nt':
    # Windows 上真正的 ssh 是 exe；bash 调 'ssh' 会先命中 ssh.exe，.bat 不够。用一个包装放进
    # 单独的 PATH 目录、只对本测试的 PY 子进程生效（下面 env 里 PATH 前置）。
    write_noeol(fake_ssh, '')
else:
    write_noeol(fake_ssh, '')
os.chmod(fake_ssh, 0o755)

# 不依赖真 ssh：直接静态断言「用的是 have_target 而不是 shutil.which」
for tool, conf in ((NGX, '/etc/nginx/sites-enabled/x.conf'), (CAD, '/etc/caddy/Caddyfile')):
    src = tool.read_text(encoding='utf-8')
    check('%s：sssh 模式用 have_target 探测目标机' % tool.name,
          'def have_target(' in src and 'if LOCAL:' in src and "['ssh', HOST, 'command -v %s'" in src.replace('"', "'"),
          'no have_target')
    # shutil.which 只允许出现在 have_local 的 return 里（--local 分支用）；
    # 注释/docstring 里提到它不算（那段注释正是在解释为什么不能这么写）。
    code_lines = []
    for ln in src.splitlines():
        t = ln.lstrip()
        if t.startswith('#') or t.startswith(('⚠', '★', '"""', "'''")):
            continue
        code_lines.append(ln)
    leftovers = [ln for ln in code_lines
                 if 'shutil.which(' in ln and 'bool(shutil.which(cmd))' not in ln]
    check('%s：校验/卸载不再用 shutil.which 判目标机' % tool.name,
          not leftovers, leftovers)

# ── ② gen_config：SQLite 兜底范围 ────────────────────────────────────────────
sys.path.insert(0, str(ROOT / 'tools'))
import gen_config as gc  # noqa: E402

dbA = TMP / 'no-table.db'
c = sqlite3.connect(str(dbA)); c.execute('create table node(id integer)'); c.commit(); c.close()
# ⚠ 不能只断言「抛异常」：宽 except 下第二条查询抛的异常消息一模一样（no such table），
#   所以两种写法都抛 —— 断言必须抓住真正的差别：**有没有白跑第二条查询**（锁库时那还会
#   再等一个 5s busy timeout）。
_calls = []
_orig_nointerval = gc.ROW_SQL_NO_INTERVAL_SQL = gc.ROW_SQL_NO_INTERVAL


class _Rec:
    """包一层 sqlite3.Connection.execute：记录哪条 SQL 被真的发出去。"""
    def __init__(self, conn):
        self._c = conn

    def execute(self, sql, *a):
        _calls.append(sql)
        return self._c.execute(sql, *a)

    def close(self):
        return self._c.close()

    def __getattr__(self, k):
        return getattr(self._c, k)


_orig_connect = sqlite3.connect
sqlite3.connect = lambda *a, **kw: _Rec(_orig_connect(*a, **kw))
try:
    gc.read_rows_local(str(dbA))
    check('gen_config：库缺 ping_task 表时如实抛错（不被「缺列」兜底掩盖）', False, 'no raise')
except sqlite3.OperationalError as e:
    check('gen_config：库缺 ping_task 表时如实抛错（不被「缺列」兜底掩盖）',
          'no such table' in str(e), e)
finally:
    sqlite3.connect = _orig_connect
check('gen_config：表不存在时不再白跑第二条查询（真实原因不被二次异常顶掉）',
      len(_calls) == 1, _calls)

dbB = TMP / 'no-interval.db'
c = sqlite3.connect(str(dbB))
c.execute('create table ping_task(id,name,target)')
c.execute("insert into ping_task values(1,'n','t')")
c.commit(); c.close()
try:
    rows = gc.read_rows_local(str(dbB))
    check('gen_config：老 hub 真的缺 interval 列时仍能兜底（60s）',
          rows == [(1, 'n', 't', 60)], rows)
except Exception as e:
    check('gen_config：老 hub 真的缺 interval 列时仍能兜底（60s）', False, repr(e))

# ── ⑫ gen_config：URI 里的 # / ? ────────────────────────────────────────────
dbC = TMP / 'weird#2.db'
c = sqlite3.connect(str(dbC))
c.execute('create table ping_task(id,name,target,interval)')
c.execute("insert into ping_task values(9,'n','t',30)")
c.commit(); c.close()
try:
    rows = gc.read_rows_local(str(dbC))
    check('gen_config：--db 路径含 # 也能开到正确文件（URI 百分号编码）',
          rows == [(9, 'n', 't', 30)], rows)
except Exception as e:
    check('gen_config：--db 路径含 # 也能开到正确文件（URI 百分号编码）', False, repr(e))
check('gen_config：URI 里用了 urllib.parse.quote',
      'urllib.parse.quote' in GEN.read_text(encoding='utf-8'))

# ── ③ cachebust：首行裸 import ──────────────────────────────────────────────
site = TMP / 'cbsite'
write_noeol(site / 'js' / 'a.js', "import './util.js';\nimport x from './npc.js';\n")
write_noeol(site / 'js' / 'b.js', "const z = 1;\n  import './late.js';\n")
write_noeol(site / 'index.html', '<script type="module" src="js/a.js"></script>\n')
r = run([CB, site, '777'])
ajs = read_raw(site / 'js' / 'a.js')
bjs = read_raw(site / 'js' / 'b.js')
check('cachebust：文件第一行的裸 import 打上了 ?v=', "util.js?v=777" in ajs, ajs)
check('cachebust：from-import 照旧打戳', "npc.js?v=777" in ajs, ajs)
check('cachebust：非首行的裸 import 仍打戳', "late.js?v=777" in bjs, bjs)
r2 = run([CB, site, '888'])
ajs2 = read_raw(site / 'js' / 'a.js')
check('cachebust：换戳后不堆积', ajs2.count('?v=') == 2 and '?v=888' in ajs2 and '?v=777' not in ajs2, ajs2)

# ── ④ HOST 以 - 开头：直接拒绝 ──────────────────────────────────────────────
for tool, extra in ((NGX, ['--conf', '/tmp/x.conf']), (CAD, ['--conf', '/tmp/Caddyfile'])):
    r = run([tool] + extra + ['-oProxyCommand=touch /tmp/pwned'])
    combined = (r.stdout or '') + (r.stderr or '')
    check('%s：- 开头的位置参数被拒（ssh 选项注入）' % tool.name,
          r.returncode == 2 and '以 - 开头' in combined, 'rc=%s %s' % (r.returncode, combined[:200]))
    r = run([tool, '--local', '--no-reload'] + extra, env={'PATCH_HOST': '-oProxyCommand=x'})
    combined = (r.stdout or '') + (r.stderr or '')
    check('%s：PATCH_HOST 以 - 开头也被拒' % tool.name,
          r.returncode == 2 and 'PATCH_HOST' in combined, 'rc=%s %s' % (r.returncode, combined[:200]))
check('没真的执行注入的命令', not pathlib.Path('/tmp/pwned').exists())

# ④b 没给 ssh 别名时：直接报那条错，不许先拿空 HOST 去跑 ssh（会打误导的 WARN + 白等超时）
for tool, extra in ((NGX, ['--conf', '/tmp/x.conf']), (CAD, ['--conf', '/tmp/Caddyfile'])):
    r = run([tool] + extra)
    combined = (r.stdout or '') + (r.stderr or '')
    check('%s：没给 ssh 别名时只报那条错，不打误导的 WARN' % tool.name,
          r.returncode == 2 and '请给出 ssh 别名' in combined and '目标机上找不到' not in combined,
          'rc=%s %s' % (r.returncode, combined[:300]))

# ── ⑤⑥⑦ run_header.sh 的三处 ────────────────────────────────────────────────
hdr = HDR.read_text(encoding='utf-8')
_bf = re.search(r'backup_file\(\) \{.*?\n\}', hdr, re.S).group(0)
_bf_code = '\n'.join(ln for ln in _bf.splitlines() if not ln.lstrip().startswith('#'))
check('run_header：backup_file 不再用 xargs 拆空白', 'xargs' not in _bf_code, _bf_code)
check('run_header：backup_file 用 while-read 逐行删',
      'while IFS= read -r old' in hdr)
check('run_header：systemd 单元不再用 sed 插值',
      'sed -e "s|__APPDIR__' not in hdr)
check('run_header：单元占位符用 subst_lit 按字面替换（& / | 都安全）',
      'subst_lit() {' in hdr and "subst_lit \"$unit\" '__APPDIR__' \"$APPDIR\"" in hdr)
check('run_header：单元文件先写临时文件再 mv（不会截断真文件）',
      '.$SERVICE.service.tmp.$$' in hdr and 'mv -f "$utmp"' in hdr)
check('run_header：modelFallback 走 URL 白名单净化',
      'url_js_str' in hdr and "modelFallback: '$model_src_js'" in hdr)

# ⑦ 实测：把一个带引号的值喂给 write_options 的净化函数，产出的 JS 必须能解析
jsgen = TMP / 'opt.js'
script = (hdr[hdr.index('url_js_str() {'):hdr.index('write_options() {')] +
          "printf 'window.CP_OPTIONS = {\\n  modelFallback: \"%s\",\\n};\\n' \"$(url_js_str \"$1\")\"")
sp = TMP / 'gen.sh'
write_noeol(sp, '#!/usr/bin/env bash\nset -eu\n' + script + '\n')
r = subprocess.run(['bash', str(sp), "http://x/a'b<c\\d"], capture_output=True, text=True,
                   encoding='utf-8', errors='replace')
body = r.stdout
check('run_header：带引号/尖括号的模型源产出的 JS 不含裸引号', "'" not in body.split('modelFallback:')[1].split(',')[0],
      body)
check('run_header：净化后仍是合法 URL 前缀', 'http://x/abcd' in body, body)

# ⑤ 实测 backup_file 的轮换（含空格路径）
bak_test = TMP / 'baktest.sh'
src = hdr[hdr.index('backup_file() {'):]
src = src[:src.index('\n}\n') + 3]
write_noeol(bak_test, '#!/usr/bin/env bash\nset -euo pipefail\nBAK_KEEP=2\nsay(){ :; }\n' + src + r'''
d="$(mktemp -d)"
f="$d/my site.conf"
: > "$f"
# 手造 5 个旧备份（时间戳递增），再跑一次 backup_file：应只留 BAK_KEEP 份（含这次新建的）
for i in 5 4 3 2 1; do touch -d "2026-01-0$i 00:00" "$f.bak-2026010$i-000000"; done
backup_file "$f"
left="$(ls -1 "$d" | grep -c '\.bak-')"
echo "left=$left"
echo "target_still_there=$([ -f "$f" ] && echo 1 || echo 0)"
echo "newest_kept=$(ls -1t "$d" | grep '\.bak-' | head -1)"
''')
r = subprocess.run(['bash', str(bak_test)], capture_output=True, text=True,
                   encoding='utf-8', errors='replace')
check('run_header：带空格的文件名也能正常轮换（只留 BAK_KEEP 份）',
      'left=2' in r.stdout and 'target_still_there=1' in r.stdout,
      r.stdout + r.stderr)

# ⑥ 实测：APPDIR 含 | 时单元文件内容完整
unit_test = TMP / 'unit.sh'
_subst_fn = hdr[hdr.index('# 字面替换：把 $1 里所有的 $2 换成 $3'):hdr.index('\nbackup_file() {')]
_unit_body = hdr[hdr.index('  local unit\n'):hdr.index("  if grep -q '__APPDIR__")]
_unit_snip = _subst_fn + '\nwrite_unit() {\n' + _unit_body
# 把「写到 /etc」的几处换成 $WORK，其余逻辑（含变量替换）原样跑
_unit_snip = _unit_snip.replace('utmp="/etc/systemd/system/.$SERVICE.service.tmp.$$"',
                                'utmp="$WORK/out.service"')
_unit_snip = _unit_snip.replace('"/etc/systemd/system/$SERVICE.service"', '"$WORK/out.service"')
write_noeol(unit_test, """#!/usr/bin/env bash
set -euo pipefail
WORK="$(mktemp -d)"
mkdir -p "$WORK/systemd"
printf '[Service]\\nWorkingDirectory=__APPDIR__\\nExecStart=__PYTHON__ __APPDIR__/farm_server.py --port __WS_PORT__\\n' > "$WORK/systemd/cyber-probe.service"
APPDIR='/opt/a|b&c'
WS_PORT=28999
pybin=/usr/bin/python3
SERVICE=cp-selftest
""" + _unit_snip + """
}
write_unit
echo "---"
cat "$WORK/out.service"
""")
r = subprocess.run(['bash', str(unit_test)], capture_output=True, text=True,
                   encoding='utf-8', errors='replace')
out = r.stdout
tail_out = out.split('---')[-1]
check('run_header：APPDIR 含 | 时单元仍完整（不截断、不报 sed 错）',
      r.returncode == 0 and 'WorkingDirectory=/opt/a|b&c' in tail_out,
      'rc=%s\n%s\n%s' % (r.returncode, out, r.stderr))
check('run_header：APPDIR 里的占位符被替换干净（& 不被 sed 展开）',
      '__APPDIR__' not in tail_out and '__PYTHON__' not in tail_out and '__WS_PORT__' not in tail_out,
      out)

# ── ⑧ caddy：注释里的不成对花括号 ──────────────────────────────────────────
d8 = TMP / 'caddy-comment'
conf8 = d8 / 'Caddyfile'
snip8 = d8 / 'conf.d' / 'cyber-probe.caddy'
write_noeol(conf8, (
    "a.test {\n"
    "\troot * /var/www/a\n"
    "\tfile_server\n"
    "\t# TODO 这里以后要加个 matcher {   ← 注释里不成对的 {\n"
    "}\n\n"
    "b.test {\n"
    "\treverse_proxy 127.0.0.1:28080\n"
    "}\n"
))
r = run([CAD, '--local', '--no-reload', '--conf', conf8, '--snippet', snip8,
         '--domain', 'nomatch.test', '--hub-port', '28080', '--ws-port', '28910'])
txt8 = read_raw(conf8)
a_block = txt8[:txt8.index('b.test')]
check('caddy_patch：注释里的不成对 { 不会把 import 插进别的 vhost',
      'import ' not in a_block and 'import ' in txt8[txt8.index('b.test'):],
      'rc=%s\n%s' % (r.returncode, txt8))

# 同样的注释，但 hub 上游在**第一个**站点里 —— 剥注释后应命中它，而不是跳到后面那个
d8c = TMP / 'caddy-comment2'
conf8c = d8c / 'Caddyfile'
write_noeol(conf8c, (
    "# 顶部注释里也有个不成对的 }   ← 会先把深度带成负数\n"
    "a.test {\n"
    "\treverse_proxy 127.0.0.1:28080\n"
    "\t# TODO 加 matcher {   ← 注释里不成对的 {\n"
    "}\n\n"
    "b.test {\n"
    "\treverse_proxy 127.0.0.1:9999\n"
    "}\n"
))
r = run([CAD, '--local', '--no-reload', '--conf', conf8c, '--snippet', d8c / 'x.caddy',
         '--domain', 'nomatch.test', '--hub-port', '28080', '--ws-port', '28910'])
txt8c = read_raw(conf8c)
check('caddy_patch：注释带偏深度时仍把 import 插到含 hub 上游的站点',
      r.returncode == 0 and 'import ' in txt8c[:txt8c.index('b.test')],
      'rc=%s\n%s' % (r.returncode, (r.stdout or '') + (r.stderr or '') + '\n' + txt8c))

# 带引号的 # 不该被当注释（`redir * "/a#b"`）
d8b = TMP / 'caddy-hash'
conf8b = d8b / 'Caddyfile'
write_noeol(conf8b, 'a.test {\n\treverse_proxy 127.0.0.1:28080\n\tredir * "/a#b" 301\n}\n')
r = run([CAD, '--local', '--no-reload', '--conf', conf8b, '--snippet', d8b / 'x.caddy',
         '--domain', 'a.test', '--hub-port', '28080', '--ws-port', '28910'])
check('caddy_patch：引号里的 # 不被当注释（块深度仍算得对）',
      r.returncode == 0 and 'import ' in read_raw(conf8b),
      'rc=%s %s' % (r.returncode, (r.stdout or '') + (r.stderr or '')))

# ── ⑨ world.js 的大门 ──────────────────────────────────────────────────────
world = (ROOT / 'js' / 'world.js').read_text(encoding='utf-8')
check('world.js：gateLeaves 有消费者（门真的会动，不再是死代码）',
      world.count('gateLeaves') >= 3 and 'l.g.rotation.y = l.dir * gateA' in world,
      world.count('gateLeaves'))
check('world.js：门是平滑开合（不瞬跳）',
      'gateA += (want - gateA) * Math.min(1, dt * 7)' in world)
check('world.js：边界仍是封死的（门开了也走不出去）',
      "box('fence', WORLD_HALF, 0, t, WORLD_HALF * 2 + t, 1.1)" in world)

# ── ⑩ mock/nezha.py 的 read-exact ──────────────────────────────────────────
nz = (ROOT / 'mock' / 'nezha.py').read_text(encoding='utf-8')
check('mock/nezha.py：有 _recv_exact（读满 n 字节）', 'def _recv_exact(' in nz)
check('mock/nezha.py：帧头/掩码/载荷都走 read-exact',
      nz.count('self._recv_exact(') >= 5, nz.count('self._recv_exact('))
check('mock/nezha.py：不再裸 recv(n) 读载荷',
      'payload = self.connection.recv(n) if n else b\'\'' not in nz)

# ── ⑪ mutation_test 的超时处理 ─────────────────────────────────────────────
mt = (ROOT / 'tools' / 'mutation_test.py').read_text(encoding='utf-8')
check('mutation_test：捕获 TimeoutExpired', 'except subprocess.TimeoutExpired' in mt)
check('mutation_test：超时返回受控退出码 124', 'return 124' in mt)

# ── ⑬ data.js 的 pingOnly ─────────────────────────────────────────────────
djs = (ROOT / 'js' / 'data.js').read_text(encoding='utf-8')
check('data.js：nodeDetail 支持 pingOnly', 'pingOnly = false' in djs and 'if (pingOnly)' in djs)
check('data.js：pingOnly 走独立缓存键（不会串到完整缓存）',
      "pingOnly ? ':ping' : ''" in djs)
check('data.js：pingOnly 时只发 records/ping',
      'd = Komari.mapDetail(null, Komari.unwrap(await getJSON(pingUrl, signal)))' in djs)
hjs = (ROOT / 'js' / 'hud.js').read_text(encoding='utf-8')
check('hud.js：网站鸡详情用 pingOnly', djs and 'pingOnly: true' in hjs)

# ── ⑭ nginx_patch：卸载不许吃掉用户的注释与用户自己的 301 ─────────────────────
# 这两个都是**真机落实测**发现的（不是报告里的条目）。它们的共同特征是：在干净 fixture 上
# 完全看不出来，只有"用户配置里有提到项目名的注释、或自己写了同路径 301"时才会误删。
d14 = TMP / 'nginx-user-cfg'
conf14 = d14 / 'site.conf'
orig14 = (
    '# 我这个站点是 cyber-probe 的入口（用户注释，必须保住）\n'
    '# 第二行说明\n'
    '\n'                                             # ← 空行：旧逻辑的"孤立注释"判据正是它
    'server {\n'
    '    listen 443;\n'
    '    server_name example.test;\n'
    '    location = /chicken { return 301 /; }\n'      # 用户自己写的：跳站根，不是我们插的
    '    location / {\n'
    '        proxy_pass http://127.0.0.1:28080;\n'
    '    }\n'
    '}\n')
write_noeol(conf14, orig14)
r = run([NGX, '--local', '--no-reload', '--conf', conf14, '--hub-port', '28080',
         '--ws-port', '28910', '--webroot', '/srv/site', '--path', '/chicken'])
r2 = run([NGX, '--local', '--no-reload', '--remove', '--conf', conf14, '--hub-port', '28080',
          '--ws-port', '28910', '--webroot', '/srv/site', '--path', '/chicken'])
after14 = read_raw(conf14)
check('nginx_patch：卸载不删用户的文件头注释（哪怕里面提到项目名）',
      '第二行说明' in after14, after14)
check('nginx_patch：卸载不删用户自己的 `location = /chicken { return 301 /; }`',
      'return 301 /;' in after14, after14)
check('nginx_patch：用户配置贴→摘仍字节一致',
      r.returncode == 0 and r2.returncode == 0 and after14 == orig14,
      'add=%s rm=%s\n%s\n%s' % (r.returncode, r2.returncode, r.stdout + r.stderr, after14))

# 那条 301 判据以前写成 `'return 301' in body` —— 我们自己的块和用户的块都命中。
# 反向确认：我们自己插的那种（跳 /chicken/）必须**仍能被摘掉**，否则就是"抓太严"。
check('nginx_patch：我们自己的 301 块仍能被摘（判据没抓过头）',
      'return 301 /chicken/;' not in after14, after14)

# ── ⑮ nginx_patch：REMOTE_REMOVE 不许引用未定义的变量 ────────────────────────
# 真机落实测：第一版在 drop_block 里写了 PREFIX，而 REMOTE_REMOVE 是一段独立脚本、
# 只有 __PREFIX__ 的文本替换 → 卸载直接 NameError 崩掉，块一个都摘不掉。
_src_ngx = NGX.read_text(encoding='utf-8')
_rm = re.search(r"REMOTE_REMOVE = r'''(.*?)'''", _src_ngx, re.S).group(1)
_rm_code = re.sub(r"#[^\n]*", "", _rm)
_rm_code = re.sub(r"'[^'\n]*'", "''", _rm_code)
_rm_code = re.sub(r'"[^"\n]*"', '""', _rm_code)
_bare = [ln.strip() for ln in _rm_code.splitlines()
         if re.search(r'\b(PREFIX|PREFIX_NS|WS_PORT|HUB_PORT|WEBROOT)\b', ln)]
check('nginx_patch：REMOTE_REMOVE 里没有裸用 PREFIX 这类外层变量（会 NameError）',
      not _bare, _bare)

print()
print('失败 %d 项：%s' % (len(fails), '，'.join(fails)) if fails else '全部通过')
sys.exit(1 if fails else 0)
