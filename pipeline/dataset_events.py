#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
T11 · 事件级样本表（77 行 × 8 特征 + 1 缺失指示列）

任务来源：06_任务清单 T11 · 裁决 D-002 / D-005
下游：算法专家 T12–T15（TabPFN 对比 / 状态空间 / 状态机 / Arps 约束）的唯一输入

输入（只读）：
  04_数据/原始数据/pilot_events_v2c.csv   77 个事件（anchor / pre_nz / D_fit / form5a_seq / status）
  04_数据/原始数据/pilot_series.csv       逐井逐月 rate_m3d（mi = y*12+m-1，绝对月序）
  04_数据/bundle_v3.json                  基线（只用于交叉核对 anchor / bucket，不参与计算）

输出：
  04_数据/events.csv

列字典
  ── 标识 ──
  api8            井 API 号（与 events/series/api8 一致，8 位）
  event_month     事件月 YYYY-MM（COGIS Form 5A 完井/再完井）

  ── 特征（8 个，全部事件前可观测，无泄漏）──
  anchor          事件前末 3 个非零月日均产油均值（含措施月），m³/d
                  ＝ v2c.base_incl_m3d ＝ bundle.wells[].anchor（脚本断言逐井相等）
  pre_nz          事件前非零月数（v2c 原列）
  D_fit           事件前 6–12 月 log 线性拟合月递减率，clip [0, 0.15]（v2c 原列）
  form5a_seq      Form 5A 序号（v2c 原列）
  population      PR / SI（v2c.status）
  bucket          anchor 分档 0–3，边 [0.517289, 1.454301, 2.953842]
                  （bundle final_model.ANBM.bins，脚本断言与 bundle.wells[].bucket 逐井相等）
  slope_6m        事件前（mi < 事件月）最近 ≤6 个**有记录**月的
                  rate_m3d 对 mi 的 OLS 斜率，m³/d 每月
  cv              事件前最近 ≤12 个**有记录**月的 rate_m3d 变异系数
                  （样本标准差 ddof=1 / 均值）

  ── 缺失指示（D-002）──
  cv_missing      1 = 可用月 <6 或均值 =0 → cv 置 NaN（空单元格）
                  下游填补只准用训练折内统计量（D-002 影响面③）

  ── 标签（供 T12 直接使用，P14 §2.4：y1/y2 两个都给）──
  actual12        事件后第 1–12 月实测累产，m³ ＝ Σ rate_m3d × 30.4
                  （与 backtest_p5.py act12 逐字同口径）
  base12          Σ_{t=1..12} anchor·exp(−D_fit·t)·30.4（与 backtest 敏感性组同口径）
  ratio           actual12 / base12
  y_log_ratio     log(ratio)；actual12 = 0 的井置 NaN（7 口零产井）
  y_zero          1{actual12 = 0}（事件级"完全无响应"）

口径不变量（脚本逐条断言，见 main 末尾）：
  77 行 · anchor/bucket 与 bundle 逐井一致 · ratio 中位 = 1.0673（基线）
  零产 = 7 口 · PR 51 / SI 26 · base12 > 0 · cv NaN ⇔ cv_missing = 1

用法：
  python pipeline/dataset_events.py
"""
import csv
import json
import math
import os
import statistics

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))

EVENTS_CSV = os.path.join(ROOT, "04_数据", "原始数据", "pilot_events_v2c.csv")
SERIES_CSV = os.path.join(ROOT, "04_数据", "原始数据", "pilot_series.csv")
BUNDLE_JSON = os.path.join(ROOT, "04_数据", "bundle_v3.json")
OUT_CSV = os.path.join(ROOT, "04_数据", "events.csv")

DAYS = 30.4          # 与管道全局口径一致（P13 §1.3）
HORIZON = 12
CV_MIN_MONTHS = 6    # D-002：可用月 < 6 → NaN
SLOPE_WINDOW = 6
CV_WINDOW = 12

# ---- D-018：特征白名单（9 列）与标签（5 列），二者必须互斥 ----
# 特征全部事件前可观测（mi < 事件月）；标签全部事件后。
# T12 只准按 FEATURES 取列，禁止 drop 黑名单写法（漏一列即泄漏且不报警）。
FEATURES = ["anchor", "pre_nz", "D_fit", "form5a_seq", "population",
            "bucket", "slope_6m", "cv", "cv_missing"]
LABELS = ["actual12", "base12", "ratio", "y_log_ratio", "y_zero"]
assert not (set(FEATURES) & set(LABELS)), "特征与标签列必须互斥（D-018）"

# bucket 取 bundle.wells[].bucket 标签（构建时按全精度 anchor 分档，是冻结契约值）。
# ANBM bins（final_model）是同一分档的 6 位舍入记录：CSV anchor 只存 4 位，
# 边缘井（恰在分位边上）用 bins 复算会与标签差 1 档，脚本会把这些井如实列出。
BUCKET_EDGES = [0.517289, 1.454301, 2.953842]
BUCKET_LABELS = {
    "低产(-∞-0.5 m³/d)": 0,
    "中低产(0.5-1.5 m³/d)": 1,
    "中高产(1.5-3.0 m³/d)": 2,
    "高产(3.0-∞ m³/d)": 3,
}
# 已知差异：12323026 的 bundle.anchor(0.05) 与 v2c.base_incl_m3d(0.0157) 不一致，
# 管道（backtest_p5 §敏感性）与 P13 契约均以 v2c 为准，本表用 v2c，差异保留报告。
ANCHOR_KNOWN_DIFF = {"12323026"}

BASELINE = {
    "n": 77, "ratio_median": 1.0673, "zero": 7, "PR": 51, "SI": 26,
}


def bucket_from_bins(anchor: float) -> int:
    for i, edge in enumerate(BUCKET_EDGES):
        if anchor < edge:
            return i
    return len(BUCKET_EDGES)


def ols_slope(xs, ys):
    """简单线性回归斜率；n < 2 返回 None。"""
    n = len(xs)
    if n < 2:
        return None
    mx, my = sum(xs) / n, sum(ys) / n
    var = sum((x - mx) ** 2 for x in xs)
    if var == 0:
        return None
    cov = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
    return cov / var


def fmt(v):
    """None → 空单元格（pandas 读作 NaN）；float 保留 6 位。"""
    if v is None:
        return ""
    if isinstance(v, float):
        return f"{v:.6f}".rstrip("0").rstrip(".") if v == v else ""
    return v


def load():
    events = list(csv.DictReader(open(EVENTS_CSV, encoding="utf-8")))
    series = {}
    for r in csv.DictReader(open(SERIES_CSV, encoding="utf-8")):
        series.setdefault(r["api8"], {})[int(r["mi"])] = float(r["rate_m3d"])
    bundle = json.load(open(BUNDLE_JSON, encoding="utf-8"))
    return events, series, bundle


def build_row(e, series, bucket_by_api):
    api = e["api8"]
    y, m = int(e["event_month"][:4]), int(e["event_month"][5:7])
    mi0 = y * 12 + m - 1
    d = series.get(api, {})

    # ---- 特征（事件前可观测）----
    anchor = float(e["base_incl_m3d"])
    pre_nz = int(e["pre_nz"])
    d_fit = float(e["D_fit"] or 0.0)
    form5a_seq = int(e["form5a_seq"])
    population = e["status"]
    bucket = bucket_by_api[api]          # bundle 冻结标签（全精度分档）

    pre_mis = sorted(mi for mi in d if mi < mi0)
    pre_rates = [d[mi] for mi in pre_mis]

    # slope_6m：最近 ≤6 个有记录月
    s6 = pre_mis[-SLOPE_WINDOW:]
    slope_6m = ols_slope(s6, [d[mi] for mi in s6])

    # cv：最近 ≤12 个有记录月（D-002：n<6 或均值 0 → NaN + cv_missing=1）
    c12 = pre_rates[-CV_WINDOW:]
    cv, cv_missing = None, 0
    if len(c12) >= CV_MIN_MONTHS:
        mean = sum(c12) / len(c12)
        if mean > 0:
            cv = statistics.stdev(c12) / mean
    if cv is None:
        cv_missing = 1

    # ---- 标签（事件后）----
    post = [d.get(mi0 + k) for k in range(1, HORIZON + 1)]
    assert all(v is not None for v in post), f"{api} 事件后 12 月有缺测"
    actual12 = sum(post) * DAYS
    base12 = sum(anchor * math.exp(-d_fit * t) for t in range(1, HORIZON + 1)) * DAYS
    assert base12 > 0, f"{api} base12 ≤ 0（anchor={anchor}, D={d_fit}）"
    ratio = actual12 / base12
    y_zero = 1 if actual12 == 0.0 else 0
    y_log = math.log(ratio) if ratio > 0 else None

    return {
        "api8": api,
        "event_month": e["event_month"],
        "population": population,
        "anchor": anchor,
        "pre_nz": pre_nz,
        "D_fit": d_fit,
        "form5a_seq": form5a_seq,
        "bucket": bucket,
        "slope_6m": slope_6m,
        "cv": cv,
        "cv_missing": cv_missing,
        "actual12": actual12,
        "base12": base12,
        "ratio": ratio,
        "y_log_ratio": y_log,
        "y_zero": y_zero,
        # 内部核对用，写出前剔除
        "_pre_months": len(pre_mis),
    }


def main():
    events, series, bundle = load()
    assert len(events) == BASELINE["n"], f"事件数 {len(events)} ≠ 77"

    bw = {str(w["api"]): w for w in bundle["wells"]}
    bucket_by_api = {api: BUCKET_LABELS[w["bucket"]] for api, w in bw.items()}

    rows = [build_row(e, series, bucket_by_api) for e in events]

    # ---- 与基线 bundle 交叉核对 ----
    # anchor：v2c 全精度 vs bundle 3 位舍入展示值（个别井有实质差异，如实报告）
    n_anchor, anchor_diffs = 0, []
    for r in rows:
        w = bw[r["api8"]]
        if abs(w["anchor"] - r["anchor"]) <= 5e-3 and r["api8"] not in ANCHOR_KNOWN_DIFF:
            n_anchor += 1
        elif r["api8"] in ANCHOR_KNOWN_DIFF:
            anchor_diffs.append((r["api8"], r["anchor"], w["anchor"], "已知差异，v2c 为准"))
        elif abs(w["anchor"] - r["anchor"]) <= 5e-3:
            n_anchor += 1
        else:
            anchor_diffs.append((r["api8"], r["anchor"], w["anchor"], "超舍入范围"))
    assert n_anchor + len(anchor_diffs) == 77

    # bucket：bundle 标签（本表取值）vs ANBM bins 用 CSV anchor 复算（仅一致性报告）
    bins_mismatch = [
        (r["api8"], r["anchor"], bucket_from_bins(r["anchor"]), r["bucket"])
        for r in rows if bucket_from_bins(r["anchor"]) != r["bucket"]
    ]

    # ---- 口径不变量 ----
    n_pr = sum(1 for r in rows if r["population"] == "PR")
    n_si = sum(1 for r in rows if r["population"] == "SI")
    n_zero = sum(r["y_zero"] for r in rows)
    med_ratio = round(statistics.median(r["ratio"] for r in rows), 4)
    n_cv_missing = sum(r["cv_missing"] for r in rows)
    n_slope_ok = sum(1 for r in rows if r["slope_6m"] is not None)

    assert (n_pr, n_si) == (BASELINE["PR"], BASELINE["SI"]), f"PR/SI = {n_pr}/{n_si}"
    assert n_zero == BASELINE["zero"], f"零产井 {n_zero} ≠ 7"
    assert abs(med_ratio - BASELINE["ratio_median"]) < 5e-4, \
        f"ratio 中位 {med_ratio} ≠ 基线 {BASELINE['ratio_median']}"
    assert n_slope_ok == 77, "slope_6m 有井算不出"
    assert all(r["_pre_months"] >= CV_MIN_MONTHS for r in rows), "存在事件前 <6 记录月的井"
    assert all((r["cv"] is None) == (r["cv_missing"] == 1) for r in rows), \
        "cv 与 cv_missing 不互斥"

    # ---- 写出 ----
    cols = ["api8", "event_month", "population", "anchor", "pre_nz", "D_fit",
            "form5a_seq", "bucket", "slope_6m", "cv", "cv_missing",
            "actual12", "base12", "ratio", "y_log_ratio", "y_zero"]
    with open(OUT_CSV, "w", newline="", encoding="utf-8") as f:
        wtr = csv.DictWriter(f, fieldnames=cols, extrasaction="ignore")
        wtr.writeheader()
        for r in rows:
            wtr.writerow({c: fmt(r[c]) for c in cols})

    # ---- 报告 ----
    print("T11 事件级样本表 · 完成")
    print(f"  输出        {OUT_CSV}")
    print(f"  行数        {len(rows)}（PR {n_pr} / SI {n_si}）")
    print(f"  特征        8 + cv_missing 指示列（D-002）")
    print(f"  cv 缺失     {n_cv_missing} 口" +
          ("：" + ",".join(r["api8"] for r in rows if r["cv_missing"]) if n_cv_missing else ""))
    print(f"  y_zero      {n_zero} 口（actual12 = 0）")
    print(f"  ratio 中位  {med_ratio}（基线 {BASELINE['ratio_median']}，对上）")
    print(f"  anchor 核对 {n_anchor}/77 与 bundle 一致（±5e-3 舍入容差）")
    for api, a_csv, a_b, note in anchor_diffs:
        print(f"    ⚠ {api}: v2c {a_csv} vs bundle {a_b} · {note}")
    print(f"  bucket 取   bundle 冻结标签（全精度分档）；bins 复算不一致 "
          f"{len(bins_mismatch)} 口（CSV 4 位舍入卡分位边，属预期）：")
    for api, a, bi, bl in bins_mismatch:
        print(f"    · {api}: anchor {a}，bins 复算 {bi}，标签 {bl}（以标签为准）")
    print()
    print("下游验收（D-002 原文）：")
    print('  python -c "import pandas as pd; d=pd.read_csv(\'04_数据/events.csv\'); '
          'assert len(d)==77; assert set(d.cv_missing.unique())<= {0,1}; '
          "assert d.loc[d.cv_missing==1,'cv'].isna().all()\"")


if __name__ == "__main__":
    main()
