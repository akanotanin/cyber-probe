#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""变异测试：把已经修好的每一处缺陷**再塞回**一份副本里，看对应门禁是否真的变红。
   全绿的门禁如果永远不会红，就等于没门禁 —— 加/改门禁后跑一遍这个。

   用法:  python tools/mutation_test.py            （约 1 分钟；副本落在 build/mut，不动工作区）
   说明:  每轮往 build/mut 的副本里注入一个变异 → 跑 `tools/ci.sh --fast` → 要求退出码非 0
          且 ✗ 行里提到那条门禁 → 立刻把副本改回原样。基线必须先全绿，否则直接判失败。
"""
import io, os, re, shutil, subprocess, sys, pathlib

ROOT = pathlib.Path(__file__).resolve().parents[1]
MUT = ROOT / "build" / "mut"

MUTATIONS = [
    # (名字, 文件, 搜索串, 替换串, 期望变红的门禁在 ✗ 行里的关键字)
    ("M1 nginx 摘除字面量退回不带分隔空行", "tools/nginx_patch.py",
     "b64(WS_BLOCK), b64(API_CHUNK)", "b64(WS_BLOCK), b64(API_AND_STATIC)",
     "贴→摘 后文件与原件不一致"),
    ("M2 卸载退回 reload || restart", "tools/caddy_patch.py",
     'run_cmd(\'caddy validate --config %s && { systemctl is-active --quiet caddy && systemctl reload caddy || echo "（caddy 没在跑，配置已改好，下次启动生效）"; }\' % CONF)',
     'run_cmd(\'caddy validate --config %s && (systemctl reload caddy || systemctl restart caddy)\' % CONF)',
     "卸载路径里出现了 systemctl restart"),
    ("M3 探测站点配置不再排除 .bak-", "tools/run_header.sh",
     "      | grep -vE '\\.bak-|\\.orig$|\\.save$|\\.disabled|\\.dpkg-|~$' | head -1 || true)\"",
     "      | head -1 || true)\"",
     "探测站点配置没排除"),
    ("M4 探测函数不再预先把 Caddyfile 路径算出来", "tools/run_header.sh",
     """  if [ -z "$CADDYFILE" ]; then
    CADDYFILE="$(systemctl show caddy -p ExecStart --value 2>/dev/null \\
      | grep -oE '\\-\\-config[= ][^ ]*' | head -1 | sed -E 's/^--config[= ]//' || true)"
  fi
  [ -n "$CADDYFILE" ] || CADDYFILE=/etc/caddy/Caddyfile

""",
     "",
     "探测函数只算了一边"),
    ("M5 去掉「端口号当命令」的防呆", "tools/nginx_patch.py",
     """if validate.strip().isdigit():
    # 防呆：命令位置被端口类参数顶掉时，别拿它去 bash -c（caddy_patch 曾因此静默回滚）
    print("ERR  自检命令像是个端口号（%s）—— 参数按位置传错了，未改动任何文件" % validate, file=sys.stderr)
    sys.exit(5)
""",
     "",
     "补丁器自测失败"),
    ("M6 服务端记功点被改名（_credit 消失）", "server/farm_server.py",
     "_credit", "_award",
     "服务端缺 _credit"),
]


def prepare():
    if MUT.exists():
        shutil.rmtree(MUT)
    shutil.copytree(ROOT, MUT, ignore=shutil.ignore_patterns(
        ".git", "build", "dist", "shots", "scratch", "research", ".cache", "node_modules"))
    return MUT


def run_ci():
    r = subprocess.run(["bash", "tools/ci.sh", "--fast"], cwd=str(MUT), capture_output=True, text=True, timeout=300)
    return r.returncode, (r.stdout or "") + (r.stderr or "")


def main():
    prepare()
    base_rc, base_out = run_ci()
    print("基线（未变异）: 退出码 %d，末行 %s" % (base_rc, (base_out.strip().splitlines() or ["?"])[-1]))
    if base_rc != 0:
        print("!! 基线就不是绿的，先修好再做变异测试")
        return 1
    bad = 0
    for name, rel, old, new, gate in MUTATIONS:
        p = MUT / rel
        src = io.open(p, encoding="utf-8", newline="").read()
        if old not in src:
            print("%-44s ✗ 变异点没找到（脚本与代码不同步了）" % name)
            bad += 1
            continue
        io.open(p, "w", encoding="utf-8", newline="").write(src.replace(old, new))
        rc, out = run_ci()
        # 门禁变红的判定：退出码非 0 **且** 有以 ✗ 开头的失败行提到这条门禁
        red_lines = [l.strip() for l in out.splitlines() if l.lstrip().startswith("✗")]
        hit = [l for l in red_lines if gate in l]
        red = rc != 0 and bool(hit)
        # 恢复
        io.open(p, "w", encoding="utf-8", newline="").write(src)
        print("%-44s 退出码=%-3d %s" % (name, rc, ("变红 ✓  %s" % hit[0][:76]) if red else "**没变红 ✗ 门禁是死的**"))
        if not red:
            bad += 1
    print("\n结果：%d/%d 个变异被门禁抓住" % (len(MUTATIONS) - bad, len(MUTATIONS)))
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
