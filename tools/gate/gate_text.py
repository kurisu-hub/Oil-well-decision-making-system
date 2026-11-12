#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
验收闸门 · 文本与路径类检查
覆盖：A4 / A5 / A6 / D1 / D6 / D11(部分)

规则：只做机器可判定的事。命中即 FAIL，输出命中位置供 P8 修文案。
"""
import os
import re
import json

# ---------------------------------------------------------------- 扫描目标

def collect_text_files(root):
    """收集需要做文案检查的文件：(相对路径, 文本内容)"""
    targets = []
    # 1) 已构建的单文件产物（v3 优先，退回 final77）
    for p in ("release_v3/index.html", "release/index.html"):
        fp = os.path.join(root, p)
        if os.path.isfile(fp):
            targets.append((p, _read(fp)))
    # 2) 源码（.vue / .ts / .json 里的中文文案）
    #    排除 data/archive/：历史版本归档，不参与构建、不是交付内容。
    #    （2026-11-03 修定义：archive 属版本证据，不整改其文案）
    src = os.path.join(root, "frontend", "src")
    for dirpath, dirnames, filenames in os.walk(src):
        dirnames[:] = [d for d in dirnames
                       if d not in ("node_modules", "dist", ".git", "archive")]
        for fn in filenames:
            if not fn.endswith((".vue", ".ts", ".js", ".json", ".html")):
                continue
            fp = os.path.join(dirpath, fn)
            rel = os.path.relpath(fp, root).replace("\\", "/")
            targets.append((rel, _read(fp)))
    # 3) 顶层说明文件
    #    frontend/index.html 是 Vite 入口，<title> 会进产物但不在 src/ 下——
    #    2026-11-03 修定义：纳入扫描范围（曾漏掉 title 里的「压裂」）
    for p in ("frontend/index.html", "frontend/dist/index.html",
              "frontend/package.json", "release_v3/README.md", "release/README.md"):
        fp = os.path.join(root, p)
        if os.path.isfile(fp):
            targets.append((p, _read(fp)))
    return targets


def _read(fp):
    try:
        with open(fp, "r", encoding="utf-8", errors="replace") as f:
            return f.read()
    except Exception:
        return ""


# ---------------------------------------------------------------- 通用检索

def grep(targets, pattern, flags=0, max_hits=20):
    """返回 [(file, lineno, line_stripped)]"""
    rx = re.compile(pattern, flags)
    hits = []
    for rel, text in targets:
        if not text:
            continue
        for i, line in enumerate(text.splitlines(), 1):
            if rx.search(line):
                hits.append((rel, i, line.strip()[:160]))
                if len(hits) >= max_hits:
                    return hits
    return hits


# ---------------------------------------------------------------- 闸门实现

def g_a4(root, ctx):
    """A4 完井 ≠ 压裂：全站「压裂」与英文 `DWG-FRAC` 图号均应为 0

    2026-11-03 P10 红队补强：原判据只查中文「压裂」，漏了图号前缀
    `DWG-FRAC-001`——那是直接印在每张图右上角的工程图号，评委一眼看到
    「FRAC」就等于看到「压裂」。中文清零而英文没清，等于没改。
    """
    hits = grep(ctx["text"], r"压裂")
    # 允许白名单：明确的历史说明/更正句
    allow = re.compile(r"历史上?曾?被?错误?地?称[为作]?[「\"]?压裂|不叫压裂|非压裂|完井.{0,6}不是.{0,6}压裂")
    real = [h for h in hits if not allow.search(h[2])]

    # 英文图号：只认 DWG-FRAC- 前缀（变量名 FRAC_HALF 属代码内部，不计）
    en = grep(ctx["text"], r"DWG-FRAC")

    if real or en:
        detail = "; ".join(f"{f}:{n}" for f, n, _ in (real + en)[:5])
        return "FAIL", (f"「压裂」{len(real)} 处 / `DWG-FRAC` 图号 {len(en)} 处 → {detail}")
    return "PASS", f"「压裂」0（白名单内 {len(hits)}）/ `DWG-FRAC` 图号 0"


def g_a5(root, ctx):
    """A5 「驾驶舱」名不副实：标题与路由应为「决策沙盘/推演台」"""
    bad = grep(ctx["text"], r"驾驶舱")
    good = grep(ctx["text"], r"决策沙盘|推演台")
    if bad:
        detail = "; ".join(f"{f}:{n}" for f, n, _ in bad[:5])
        return "FAIL", f"「驾驶舱」残留 {len(bad)} 处 → {detail}"
    if not good:
        return "FAIL", "未找到「决策沙盘/推演台」字样，标题可能未改"
    return "PASS", f"「驾驶舱」= 0，沙盘/推演台命中 {len(good)} 处"


def g_a6(root, ctx):
    """A6 「建议压」与「不作推荐」矛盾：应删除建议性措辞"""
    pat = r"建议压|推荐压|建议实施|推荐实施"
    hits = grep(ctx["text"], pat)
    # 单独统计「推荐」作为动词的用法（不含字段名 recommended_*）
    loose = grep(ctx["text"], r"(?<!recommended_)推荐(?!_)|推荐(?!d)")
    if hits:
        detail = "; ".join(f"{f}:{n}" for f, n, _ in hits[:5])
        return "FAIL", f"建议性措辞命中 {len(hits)} 处 → {detail}"
    return "PASS", f"建议压/推荐压 = 0（「推荐」松散命中 {len(loose)}，需人工确认是否为「不作推荐」表述）"


def g_d1(root, ctx):
    """D1 绝对路径泄漏：C:\\Users 或 /Users/ 应为 0"""
    pat = r"C:\\\\?Users|C:/Users|/Users/|[A-Za-z]:\\\\Users"
    hits = []
    for rel, text in ctx["text"]:
        if re.search(pat, text):
            for i, line in enumerate(text.splitlines(), 1):
                if re.search(pat, line):
                    hits.append((rel, i, line.strip()[:140]))
    if not hits:
        return "PASS", "绝对路径 0 处"
    detail = "; ".join(f"{f}:{n}" for f, n, _ in hits[:6])
    return "FAIL", f"绝对路径 {len(hits)} 处 → {detail}"


def g_d6(root, ctx):
    """D6 README 路由数 == router 实际路由数（避免正文写 5 实际 6）"""
    router_fp = os.path.join(root, "frontend", "src", "router", "index.ts")
    if not os.path.isfile(router_fp):
        return "BLOCKED", "未找到 frontend/src/router/index.ts"
    rsrc = _read(router_fp)
    paths = re.findall(r"path:\s*['\"](/[^'\"]*)['\"]", rsrc)
    paths = [p for p in paths if not p.startswith("/:")]  # 排除通配兜底
    n_router = len(paths)

    readme_hit = None
    for p in ("release_v3/README.md", "release/README.md", "frontend/README.md"):
        fp = os.path.join(root, p)
        if os.path.isfile(fp):
            t = _read(fp)
            m = re.search(r"(\d+)\s*(?:条|个)?\s*路由", t)
            if m:
                readme_hit = (p, int(m.group(1)))
                break
    if readme_hit is None:
        return "FAIL", f"router 有 {n_router} 条路由（{','.join(paths)}），README 未声明路由数"
    if readme_hit[1] != n_router:
        return "FAIL", f"README 写 {readme_hit[1]} 条，router 实际 {n_router} 条"
    return "PASS", f"READM 与 router 一致：{n_router} 条"


def g_d11(root, ctx):
    """D11 /about 单位表：先确认 about 页存在，再查三项单位"""
    views_dir = os.path.join(root, "frontend", "src", "views")
    about = None
    for dirpath, _, filenames in os.walk(views_dir):
        for fn in filenames:
            if re.search(r"about", fn, re.I):
                about = os.path.join(dirpath, fn)
                break
    if not about:
        return "BLOCKED", "未找到 About 视图（D11 属 P8，需先建 /about）"
    t = _read(about)
    need = {"油": r"m[³3]/d", "钱": r"万元", "长度": r"米|\bm\b"}
    miss = [k for k, pat in need.items() if not re.search(pat, t)]
    if miss:
        return "FAIL", f"About 页缺单位：{miss}"
    return "PASS", f"About 页单位表三项齐全（{os.path.relpath(about, root)}）"


# ---------------------------------------------------------------- 注册表

GATES = [
    # id,  标题,                      函数,    依赖
    ("A4", "完井 ≠ 压裂：文案清零",    g_a4,   None),
    ("A5", "驾驶舱 → 决策沙盘",        g_a5,   None),
    ("A6", "删除建议性措辞",           g_a6,   None),
    ("D1", "绝对路径泄漏 = 0",         g_d1,   None),
    ("D6", "README 与路由表一致",      g_d6,   None),
    ("D11","单位表齐全",               g_d11,  "P8"),
]


def run(root):
    text = collect_text_files(root)
    ctx = {"text": text}
    out = []
    for gid, title, fn, dep in GATES:
        try:
            status, detail = fn(root, ctx)
        except Exception as e:  # 不让单个闸门崩掉整轮
            status, detail = "ERROR", f"{type(e).__name__}: {e}"
        out.append({
            "id": gid, "title": title, "status": status,
            "detail": detail, "dep": dep,
        })
    return out


if __name__ == "__main__":
    import sys
    root = sys.argv[1] if len(sys.argv) > 1 else "."
    for r in run(root):
        print(f"{r['id']:6} {r['status']:8} {r['title']}\n       {r['detail']}")
