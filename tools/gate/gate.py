#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
验收闸门 · 唯一入口

用法：
    python tools/gate/gate.py            # 跑全部
    python tools/gate/gate.py --json     # 机器可读
    python tools/gate/gate.py --only D1,A4

状态语义（严格区分，不许混用）：
    PASS     断言成立
    FAIL     断言不成立 —— 必须修
    BLOCKED  依赖的产物还没交付 —— 不是通过，只是还没到验证的时候
    ERROR    闸门自身异常

退出码：
    0  全 PASS（可能有 BLOCKED 以外的豁免=无）
    1  存在 FAIL
    2  无 FAIL 但存在 BLOCKED 或 ERROR
"""
import os
import sys
import json
import gzip

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import gate_data
import gate_text

ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))

# ============================================================================
# 闸门版本与清单冻结（2026-11-03）
#
# 规则：
#   1. 本清单冻结后，只允许「修定义」，不允许「加条目」。
#   2. 新增需求 → 记 CHANGELOG → 升版本号 → 本清单与 GATES-vX.Y.md 同步更新。
#   3. 运行时校验实际条目与清单完全一致，多一条少一条都直接报错退出。
#
# 为什么这么严：闸门是 P0 的冻结产物，不是执行过程中随手长出来的。
# 一旦允许边做边加，就永远收不了口——今天 PASS 的，明天又会被新条目追平。
# ============================================================================
GATES_VERSION = "v1.2"

GATES_MANIFEST = [
    # 数据 · 不变量（12）
    "I1", "I2", "I3", "I4", "I5", "I6", "I7", "I8", "I9", "I10", "I11", "I12",
    # 数据 · 历史缺陷（16）
    "A3", "B1", "B2", "B3", "B4", "B5", "B6", "B7", "B8",
    "C1", "C4", "C6", "D2", "D3", "D9", "D10",
    # v1.2 新增（P10 红队：策略选井与标签一致）
    "B9",
    # 文案/路径（6）
    "A4", "A5", "A6", "D1", "D6", "D11",
    # 构建（3）
    "D12", "E-EXT", "E-SHA",
]


# ---------------------------------------------------------------- 构建类闸门

def _artifact_path(root):
    for p in ("release_v3/index.html", "release/index.html"):
        fp = os.path.join(root, p)
        if os.path.isfile(fp):
            return p, fp
    return None, None


def g_d12(root):
    """D12 体积：raw ≤ 12 MB，gzip ≤ 6 MB"""
    rel, fp = _artifact_path(root)
    if not fp:
        return "BLOCKED", "未找到 index.html"
    raw = os.path.getsize(fp)
    with gzip.open(fp + ".gz", "wb", compresslevel=9) as f:
        with open(fp, "rb") as src:
            f.write(src.read())
    gz = os.path.getsize(fp + ".gz")
    os.remove(fp + ".gz")
    mb = 1024 * 1024
    detail = f"{rel}: raw {raw/mb:.2f} MB / gzip {gz/mb:.2f} MB"
    if raw > 12 * mb:
        return "FAIL", detail + " → raw 超 12 MB"
    if gz > 6 * mb:
        return "FAIL", detail + " → gzip 超 6 MB"
    return "PASS", detail


def g_external(root):
    """单文件离线：运行时外链计数应为 0

    白名单（2026-11-03 修定义）：
      · w3.org / vuejs.org/error-reference —— 命名空间与错误码模板，不发起请求
      · `source_url` 字段内的 URL —— 数据出处标注（如 COGCC 数据集地址、文献链接），
        仅作文字展示，代码中无 fetch/XHR（纪律要求），不会联网。
        判据改为「排除 source_url 字段后，仍有 0 处外链」。
    """
    rel, fp = _artifact_path(root)
    if not fp:
        return "BLOCKED", "未找到 index.html"
    with open(fp, "r", encoding="utf-8", errors="replace") as f:
        text = f.read()
    import re
    # 先剔除 source_url 字段的字面值
    stripped = re.sub(r'"source_url"\s*:\s*"[^"]*"', '""', text)
    urls = re.findall(r"https?://[^\s\"'<>)]+", stripped)
    allow = ("w3.org", "vuejs.org/error-reference")
    bad = [u for u in urls if not any(a in u for a in allow)]
    n_src = len(re.findall(r'"source_url"\s*:\s*"[^"]*"', text))
    if bad:
        return "FAIL", f"{len(bad)} 处运行时外链 → {bad[:5]}"
    return "PASS", (f"运行时外链 0（豁免命名空间/错误码 {len(urls)-len(bad)} 处；"
                    f"另有 {n_src} 处 source_url 出处标注，仅文字展示）")


def g_sha_stable(root):
    """确定性：release 产物与当前构建产物 SHA 一致"""
    import hashlib
    pairs = [
        (os.path.join(root, "release", "index.html"),
         os.path.join(root, "frontend", "dist", "index.html")),
        (os.path.join(root, "release_v3", "bundle_v3.json"),
         os.path.join(root, "frontend", "src", "data", "bundle_v3.json")),
    ]
    checked = []
    for a, b in pairs:
        if not (os.path.isfile(a) and os.path.isfile(b)):
            continue
        ha = hashlib.sha256(open(a, "rb").read()).hexdigest()
        hb = hashlib.sha256(open(b, "rb").read()).hexdigest()
        if ha != hb:
            return "FAIL", f"{os.path.relpath(a, root)} 与构建产物 SHA 不一致"
        checked.append(os.path.basename(a))
    if not checked:
        return "BLOCKED", "无可比对的两份产物"
    return "PASS", f"一致：{', '.join(checked)}"


BUILD_GATES = [
    ("D12", "体积 raw≤12MB / gzip≤6MB", g_d12, "P9"),
    ("E-EXT", "单文件无外链", g_external, "P9"),
    ("E-SHA", "两次构建 SHA 一致", g_sha_stable, "P9"),
]


# ---------------------------------------------------------------- 汇总

def collect(root, only=None):
    rows = []
    for r in gate_data.run(root):
        rows.append(dict(r, group="数据"))
    for r in gate_text.run(root):
        rows.append(dict(r, group="文案"))
    for gid, title, fn, dep in BUILD_GATES:
        try:
            st, detail = fn(root)
        except Exception as e:
            st, detail = "ERROR", f"{type(e).__name__}: {e}"
        rows.append({"id": gid, "title": title, "status": st,
                     "detail": detail, "dep": dep, "group": "构建"})
    if only:
        keep = {x.strip().upper() for x in only}
        rows = [r for r in rows if r["id"].upper() in keep]
    return rows


def check_manifest(rows):
    """冻结校验：实际条目必须与 GATES_MANIFEST 完全一致"""
    actual = [r["id"] for r in rows]
    expected = GATES_MANIFEST
    extra = [x for x in actual if x not in expected]
    missing = [x for x in expected if x not in actual]
    if not extra and not missing:
        return None
    msg = [f"闸门清单漂移（GATES-{GATES_VERSION} 冻结 {len(expected)} 条，实际 {len(actual)} 条）"]
    if extra:
        msg.append(f"  多出 {len(extra)} 条：{extra}")
        msg.append("  → 新增条目必须：记 CHANGELOG → 升 GATES_VERSION → 更新 GATES-vX.Y.md")
    if missing:
        msg.append(f"  缺少 {len(missing)} 条：{missing}")
        msg.append("  → 删条目等于放水，同样需要走变更流程")
    return "\n".join(msg)


def main():
    args = sys.argv[1:]
    as_json = "--json" in args
    only = None
    for a in args:
        if a.startswith("--only"):
            only = a.split("=", 1)[1] if "=" in a else None
            if only is None:
                i = args.index(a)
                only = args[i + 1] if i + 1 < len(args) else ""

    rows = collect(ROOT, only)

    # 冻结校验（--only 时跳过，因为子集必然对不上）
    drift = None if only else check_manifest(rows)
    if drift:
        print("=" * 78)
        print("✗ 闸门清单漂移，拒绝执行")
        print("=" * 78)
        print(drift)
        return 3

    if as_json:
        print(json.dumps(rows, ensure_ascii=False, indent=2))
    else:
        print("=" * 78)
        print(f"验收闸门 · 工创赛三维决策孪生 · GATES-{GATES_VERSION}（冻结 {len(GATES_MANIFEST)} 条）")
        print("=" * 78)
        cur = None
        for r in rows:
            if r["group"] != cur:
                cur = r["group"]
                print(f"\n── {cur} ──")
            mark = {"PASS": "✓", "FAIL": "✗", "BLOCKED": "○", "ERROR": "!"}.get(r["status"], "?")
            print(f"{mark} {r['id']:<6} {r['status']:<8} {r['title']}")
            if r["status"] != "PASS":
                print(f"          {r['detail']}")

    n = {s: sum(1 for r in rows if r["status"] == s) for s in ("PASS", "FAIL", "BLOCKED", "ERROR")}
    print("\n" + "=" * 78)
    print(f"PASS {n['PASS']}   FAIL {n['FAIL']}   BLOCKED {n['BLOCKED']}   ERROR {n['ERROR']}"
          f"   共 {len(rows)} 条   GATES-{GATES_VERSION}")
    print("=" * 78)

    # 落盘
    tsv = os.path.join(HERE, "RESULTS.tsv")
    with open(tsv, "w", encoding="utf-8") as f:
        f.write(f"# GATES-{GATES_VERSION}  frozen={len(GATES_MANIFEST)}  "
                f"run_at={__import__('time').strftime('%Y-%m-%d %H:%M:%S')}\n")
        f.write("id\tgroup\tstatus\ttitle\tdetail\tblocked_by\n")
        for r in rows:
            d = str(r["detail"]).replace("\t", " ").replace("\n", " ")
            f.write(f"{r['id']}\t{r['group']}\t{r['status']}\t{r['title']}\t{d}\t{r.get('dep') or ''}\n")

    if n["FAIL"]:
        return 1
    if n["BLOCKED"] or n["ERROR"]:
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
