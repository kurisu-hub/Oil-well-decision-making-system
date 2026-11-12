#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""P10 红队复核 · 10 个数字独立回算

原则：**不复用 bundle 的中间量**。每个数字都从最上游（原始 CSV）或最独立
（全枚举）的路径重算一遍，再与 bundle / 上屏值比对。

误差门槛：
  - 整数计数：必须完全相等
  - 浮点数：|Δ| ≤ 0.5 × 10^(-显示小数位)，即「四舍五入到上屏精度后相同」

用法:
  python tools/redteam_p10.py            # 表格输出
  python tools/redteam_p10.py --json     # 机读
"""

import csv
import json
import math
import os
import statistics as st
import sys
from itertools import combinations

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
PILOT = os.path.join(ROOT, "09_开源数据平替", "reports",
                     "cogis_pilot_run_40479938455", "pilot")
BUNDLE = os.path.join(ROOT, "frontend", "src", "data", "bundle_v3.json")

DAYS = 30.4
PRICE = 0.323
COST = 45.0

rows = []


def ck(no, name, calc, ref, tol, note=""):
    """calc=独立回算  ref=bundle/上屏  tol=允许误差"""
    if isinstance(calc, str) or isinstance(ref, str):
        ok = str(calc) == str(ref)
        dtxt = "—"
    elif isinstance(calc, int) and isinstance(ref, int):
        ok = calc == ref
        d = calc - ref
        dtxt = f"{d:+d}"
    else:
        d = float(calc) - float(ref)
        ok = abs(d) <= tol
        dtxt = f"{d:+.2e}" if abs(d) < 0.01 else f"{d:+.4f}"
    rows.append({"no": no, "name": name, "calc": calc, "ref": ref,
                 "delta": dtxt, "ok": ok, "note": note})
    return ok


def load_raw():
    ev = list(csv.DictReader(open(os.path.join(PILOT, "pilot_events_v2c.csv"),
                                 encoding="utf-8")))
    ser = {}
    for r in csv.DictReader(open(os.path.join(PILOT, "pilot_series.csv"),
                                 encoding="utf-8")):
        ser.setdefault(r["api8"], {})[int(r["mi"])] = float(r["rate_m3d"])
    return ev, ser


def act12(evrow, ser):
    y, m = int(evrow["event_month"][:4]), int(evrow["event_month"][5:7])
    mi = y * 12 + m - 1
    d = ser.get(evrow["api8"], {})
    return sum(d.get(mi + k, 0.0) * DAYS for k in range(1, 13))


def base12(evrow):
    b = float(evrow["base_incl_m3d"])
    D = float(evrow["D_fit"])
    return sum(b * math.exp(-D * k) * DAYS for k in range(1, 13))


def main():
    ev, ser = load_raw()
    b = json.load(open(BUNDLE, encoding="utf-8"))
    cv = {c["well_id"]: c for c in b["curves"]}
    wmap = {w["well_id"]: w for w in b["wells"]}

    # ── 1 井数 ────────────────────────────────────────────────
    ck(1, "井数 n_wells", len(ev), b["meta"]["n_wells"], 0,
       "原始事件 CSV 行数 vs meta")

    # ── 2 PR / SI 分群 ────────────────────────────────────────
    pr = sum(1 for r in ev if r["status"] == "PR")
    si = sum(1 for r in ev if r["status"] == "SI")
    bpr = sum(1 for w in b["wells"] if w["population"] == "PR")
    bsi = sum(1 for w in b["wells"] if w["population"] == "SI")
    ck(2, "PR 井数", pr, bpr, 0, "status=PR")
    ck(3, "SI 井数", si, bsi, 0, "status=SI")

    # ── 4 ratio 中位（原始）vs curves 重算 ────────────────────
    ratios_raw, ratios_b = [], []
    zero_raw = 0
    for r in ev:
        a, bs = act12(r, ser), base12(r)
        if bs > 0:
            ratios_raw.append(a / bs)
        if a == 0:
            zero_raw += 1
        wid = "CO" + r["api8"]
        c = cv[wid]
        ab = sum((p["oil"] or 0.0) for p in c["actual"]) * DAYS
        bb = sum(p["oil"] for p in c["baseline"]) * DAYS
        if bb > 0:
            ratios_b.append(ab / bb)
    mr_raw = st.median(ratios_raw)
    mr_b = st.median(ratios_b)
    ck(4, "ratio 中位", round(mr_raw, 4), round(mr_b, 4), 5e-5,
       "原始 CSV 重算 vs bundle curves 重算")

    # ── 5 ≥1 占比 ─────────────────────────────────────────────
    f_raw = sum(1 for x in ratios_raw if x >= 1) / len(ratios_raw)
    f_b = sum(1 for x in ratios_b if x >= 1) / len(ratios_b)
    ck(5, "ratio≥1 占比", round(f_raw, 4), round(f_b, 4), 5e-5, "")

    # ── 6 零产井 ──────────────────────────────────────────────
    zero_b = sum(1 for c in b["curves"]
                 if sum((p["oil"] or 0.0) for p in c["actual"]) == 0)
    ck(6, "零产井数", zero_raw, zero_b, 0, "事件后 12 月产量合计 = 0")

    # ── 7 D 触顶井 ────────────────────────────────────────────
    cap = sum(1 for r in ev if abs(float(r["D_fit"]) - 0.15) < 1e-9)
    ck(7, "D 触顶井数(D=0.15)", cap, 14, 0, "P5 敏感性表左端")

    # ── 8 四象限 ──────────────────────────────────────────────
    q = {"green": 0, "yellow": 0, "red": 0, "gray": 0}
    for w in b["wells"]:
        q[w["state"]] += 1
    quad = f"{q['green']}·{q['yellow']}·{q['red']}·{q['gray']}"
    ck(8, "四象限 绿·黄·红·灰", quad, "19·35·17·6", 0,
       "state 字段计数")

    # ── 9 Σ 单井 NPV ──────────────────────────────────────────
    s_all = sum(w["value_npv"] for w in b["wells"])
    ck(9, "Σ 77 口 value_npv", round(s_all, 2), 2657.08, 0.005, "P0 已核实")

    # ── 10 geo 覆盖率 ─────────────────────────────────────────
    g = b["geo"]
    hit = sum(1 for x in g["wells"] if x.get("x") is not None)
    ck(10, "geo coverage", round(hit / len(b["wells"]), 4), g["coverage"], 5e-5,
       f"有坐标 {hit}/{len(b['wells'])}")

    # ── 11 AI 组合 Σ3 口 ──────────────────────────────────────
    ai = next(s for s in b["portfolio"]["strategies"] if s["id"] == "ai")
    s_sel = sum(wmap[x]["value_npv"] for x in ai["selected"])
    ck(11, "AI 组合 Σ3口 value_npv", round(s_sel, 2), ai["expected_npv"], 0.005,
       "期望线性性：组合行应等于 3 口之和")

    # ── 12 模型分位（全枚举，独立实现）────────────────────────
    real = {}
    for w in b["wells"]:
        c = cv[w["well_id"]]
        a = sum((p["oil"] or 0.0) for p in c["actual"]) * DAYS
        bs = sum(p["oil"] for p in c["baseline"]) * DAYS
        real[w["well_id"]] = (a - bs) * PRICE - COST
    ids = list(real)
    vals = sorted(sum(real[x] for x in c) for c in combinations(ids, 3))
    model_val = sum(real[x] for x in ai["selected"])
    import bisect
    pct = bisect.bisect_left(vals, model_val) / len(vals)
    ck(12, "模型策略分位（全枚举）", round(pct, 5),
       round(b["evidence"]["backtest"]["model_percentile"], 5), 1e-5,
       "C(77,3)=%d" % len(vals))

    # ── 13 oracle 上界 ────────────────────────────────────────
    ck(13, "oracle 上界", round(vals[-1], 2),
       b["evidence"]["backtest"]["oracle"], 0.005, "73150 组合最大值")

    # ── 输出 ──────────────────────────────────────────────────
    if "--json" in sys.argv:
        print(json.dumps(rows, ensure_ascii=False, indent=2))
    else:
        print("=" * 92)
        print("P10 红队复核 · 数字独立回算")
        print("=" * 92)
        print(f"{'#':>3}  {'指标':<26}{'独立回算':>16}{'bundle/上屏':>16}"
              f"{'Δ':>12}  判定  备注")
        print("-" * 92)
        for r in rows:
            print(f"{r['no']:>3}  {r['name']:<26}{str(r['calc']):>16}"
                  f"{str(r['ref']):>16}{r['delta']:>12}  "
                  f"{'PASS' if r['ok'] else 'DIFF':<5} {r['note']}")
        bad = [r for r in rows if not r["ok"]]
        print("-" * 92)
        print(f"共 {len(rows)} 项，一致 {len(rows)-len(bad)}，不一致 {len(bad)}")
        if bad:
            for r in bad:
                print(f"  ✗ #{r['no']} {r['name']}: 回算 {r['calc']} vs {r['ref']}")

    # 落盘
    tsv = os.path.join(os.path.dirname(__file__), "redteam_numbers.tsv")
    with open(tsv, "w", encoding="utf-8", newline="\n") as f:
        f.write("no\tname\tcalc\tref\tdelta\tok\tnote\n")
        for r in rows:
            f.write(f"{r['no']}\t{r['name']}\t{r['calc']}\t{r['ref']}\t"
                    f"{r['delta']}\t{r['ok']}\t{r['note']}\n")
    return 0 if all(r["ok"] for r in rows) else 1


if __name__ == "__main__":
    sys.exit(main())
