# -*- coding: utf-8 -*-
"""DAD_Export.zip 检查器：列出所有表、行数、列名，定位「作业/措施」表。

目的只有一个：回答 F4/F5 ——
  COGCC 的全量导出里，有没有一张表同时具备
    (1) 井标识 API    (2) 操作类型代码    (3) 日期
  并且能统计出 HF / recompletion / workover 的事件数与每井分布。

用法：
  python inspect_dad.py --zip D:\\path\\DAD_Export.zip
  python inspect_dad.py --zip ... --only ops        # 只深挖疑似作业表
  python inspect_dad.py --zip ... --no-count        # 不数行（很快，只看结构）

设计约束：不整包解压。zip 内每个成员用流式读，内存占用与会话无关。
"""
from __future__ import annotations

import argparse
import io
import re
import sys
import zipfile
from pathlib import Path

import pandas as pd

# 井标识 / 类型 / 日期 的列名候选（大小写与命名风格都不统一，用正则放宽）
API_PAT = re.compile(r"api", re.I)
TYPE_PAT = re.compile(r"(operation|op_?type|task|activity|event|type|code|status)", re.I)
DATE_PAT = re.compile(r"(date|dt|_dt|time|received|effective)", re.I)

# 我们真正关心的措施类型关键词
MEASURE_PAT = re.compile(r"(frac|hf|stimul|recomplet|workover|acid|perf|re-?perf|squeeze|clean)", re.I)


def members(zf: zipfile.ZipFile) -> list[zipfile.ZipInfo]:
    out = []
    for i in zf.infolist():
        if i.is_dir():
            continue
        out.append(i)
    out.sort(key=lambda x: -x.file_size)
    return out


def read_header(zf: zipfile.ZipFile, info: zipfile.ZipInfo) -> list[str]:
    with zf.open(info) as fh:
        txt = io.TextIOWrapper(fh, encoding="utf-8-sig", errors="replace")
        line = txt.readline()
    line = line.rstrip("\r\n")
    if not line:
        return []
    # 兼容逗号/制表符/分号
    for sep in [",", "\t", ";", "|"]:
        if line.count(sep) >= 2:
            return [c.strip().strip('"') for c in line.split(sep)]
    return [line]


def count_rows(zf: zipfile.ZipFile, info: zipfile.ZipInfo) -> int:
    """数数据行（不含表头）。末尾无换行时补 +1，避免少算最后一行。"""
    n = 0
    last = b""
    with zf.open(info) as fh:
        while True:
            b = fh.read(1 << 20)
            if not b:
                break
            n += b.count(b"\n")
            last = b[-1:]
    if last and last != b"\n":
        n += 1
    return max(0, n - 1)          # 去掉表头


def detect(cols: list[str]) -> dict:
    api = [c for c in cols if API_PAT.search(c)]
    typ = [c for c in cols if TYPE_PAT.search(c)]
    dat = [c for c in cols if DATE_PAT.search(c)]
    return {"api": api, "type": typ, "date": dat}


def deep_dive(zf: zipfile.ZipFile, info: zipfile.ZipInfo, cols: list[str],
              chunksize: int = 500_000) -> None:
    """只读需要的列，统计措施类型分布。"""
    api_col = next((c for c in cols if re.search(r"api", c, re.I)), None)
    # 类型列优先选名字里带 operation/task/type 的
    type_col = None
    for pref in (r"operation", r"op_?type", r"task", r"activity", r"event", r"type"):
        for c in cols:
            if re.search(pref, c, re.I):
                type_col = c
                break
        if type_col:
            break
    date_col = next((c for c in cols if DATE_PAT.search(c)), None)

    print(f"  选用列: api={api_col!r} type={type_col!r} date={date_col!r}")
    if not (api_col and type_col):
        print("  ⚠ 缺 api 或 type 列，无法做措施统计")
        return

    use = [c for c in (api_col, type_col, date_col) if c]
    counts: pd.Series | None = None
    per_well: pd.Series | None = None
    n = 0
    with zf.open(info) as fh:
        for chunk in pd.read_csv(io.TextIOWrapper(fh, encoding="utf-8-sig", errors="replace"),
                                 usecols=use, chunksize=chunksize, low_memory=False,
                                 dtype=str, on_bad_lines="skip"):
            n += len(chunk)
            vc = chunk[type_col].fillna("(null)").astype(str).str.strip().str.upper().value_counts()
            counts = vc if counts is None else counts.add(vc, fill_value=0)
            pw = chunk[api_col].fillna("").astype(str).value_counts()
            per_well = pw if per_well is None else per_well.add(pw, fill_value=0)
    print(f"  行数 {n:,}")

    if counts is None:
        return
    counts = counts.sort_values(ascending=False)
    print(f"\n  ── 操作类型分布（{type_col}，共 {len(counts)} 种）Top 20 ──")
    for k, v in counts.head(20).items():
        flag = " ★措施" if MEASURE_PAT.search(str(k)) else ""
        print(f"    {str(k)[:40]:<42} {int(v):>9,}{flag}")

    hits = {k: int(v) for k, v in counts.items() if MEASURE_PAT.search(str(k))}
    print(f"\n  ── 措施类代码合计 {len(hits)} 种 ──")
    total = 0
    for k, v in sorted(hits.items(), key=lambda x: -x[1]):
        print(f"    {str(k)[:40]:<42} {v:>9,}")
        total += v
    print(f"    {'合计':<40} {total:>9,}")

    if per_well is not None:
        s = per_well.sort_values(ascending=False)
        print(f"\n  ── 每井事件数分布（按 {api_col}）──")
        print(f"    唯一井 {len(s):,}｜中位 {s.median():.0f}｜均值 {s.mean():.1f}｜最大 {s.max()}")
        for th in (1, 3, 5, 10):
            print(f"    ≥{th:>2} 条事件的井: {int((s >= th).sum()):>7,}")


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--zip", required=True)
    ap.add_argument("--no-count", action="store_true", help="不数行，只看结构")
    ap.add_argument("--only", default="", help="只深挖名字含该子串的成员")
    a = ap.parse_args(argv)

    p = Path(a.zip)
    if not p.exists():
        print(f"找不到 {p}", file=sys.stderr)
        return 2

    with zipfile.ZipFile(p) as zf:
        ms = members(zf)
        print(f"===== {p.name}｜{p.stat().st_size/1e6:.1f} MB｜{len(ms)} 个成员 =====\n")
        rows = []
        for i in ms:
            cols = read_header(zf, i) if i.filename.lower().endswith((".csv", ".txt", ".tsv")) else []
            d = detect(cols)
            rows.append({
                "name": i.filename,
                "mb": round(i.file_size / 1e6, 2),
                "ncol": len(cols),
                "has_api": bool(d["api"]),
                "has_type": bool(d["type"]),
                "has_date": bool(d["date"]),
                "info": i,
                "cols": cols,
            })

        print(f"{'表名':<44}{'MB':>9}{'列数':>6}  API 类型 日期")
        print("-" * 78)
        for r in rows:
            print(f"{r['name'][:44]:<44}{r['mb']:>9}{r['ncol']:>6}"
                  f"  {'Y' if r['has_api'] else '-':^3} {'Y' if r['has_type'] else '-':^4} "
                  f"{'Y' if r['has_date'] else '-':^4}")

        print("\n===== 列名（每个表全部列出）=====")
        for r in rows:
            print(f"\n── {r['name']}  ({r['mb']} MB)")
            if r["cols"]:
                print("   " + " | ".join(r["cols"][:40]))
                if len(r["cols"]) > 40:
                    print(f"   … 还有 {len(r['cols'])-40} 列")
            else:
                print("   （非文本表，未解析列名）")

        if not a.no_count:
            print("\n===== 行数 =====")
            for r in rows:
                if r["cols"]:
                    n = count_rows(zf, r["info"])
                    print(f"  {r['name'][:50]:<52}{n:>12,}")

        # 三个条件齐备的表 = 候选作业表
        cand = [r for r in rows if r["has_api"] and r["has_type"] and r["has_date"]]
        if a.only:
            cand = [r for r in cand if a.only.lower() in r["name"].lower()] or \
                   [r for r in rows if a.only.lower() in r["name"].lower()]
        print(f"\n===== 候选作业表（api+type+date 齐备）：{len(cand)} 张 =====")
        for r in cand:
            print(f"\n>>> {r['name']}")
            deep_dive(zf, r["info"], r["cols"])

        if not cand:
            print("  ✗ 没有三条件齐备的表 → F4/F5 需走 Laserfiche 逐井 PDF 路线")
    return 0


if __name__ == "__main__":
    sys.exit(main())
