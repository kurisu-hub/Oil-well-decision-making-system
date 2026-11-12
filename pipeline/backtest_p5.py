#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
P5 · 决策回测、校准与敏感性（修 B1 补全 / C6 / D3 / D9）

口径（照抄，不得改）：
    actual12 = Σ rate_m3d(t) × 30.4          t = event+1 .. +12
    base12   = Σ anchor_incl × exp(−D·t) × 30.4
    real_npv = (actual12 − base12) × 0.323 − 45

关键前提：
    bundle 的 curves[].prediction 是**折外**的
    （deploy_conformal: 5 折按井交叉，测试井不参与自己的残差；R-11 LOO 红线 pass），
    所以可以用它做「模型选井」的回测，不存在 in-sample 选井问题。

策略（预算 = 3 口 = 135 万）：
    oracle  事后最优 3 口（真实 NPV 排序）
    model   模型预测 NPV 前 3（折外预测）
    anchor  锚点产量前 3
    ratio   事后 ratio 前 3
    random  随机 3 口 × 4000 次

纪律：
    · 分位用随机分布，不用点估计吹牛
    · 达不到 90% 就如实写「无决策价值」，不调参凑数
    · 敏感性 4 组齐全，每组给两组数字
"""
import os
import sys
import csv
import json
import random
import statistics as st
import collections

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
BUNDLE = os.path.join(ROOT, "frontend", "src", "data", "bundle_v3.json")
REL = os.path.join(ROOT, "release_v3", "bundle_v3.json")
PILOT = os.path.join(ROOT, "09_开源数据平替", "reports",
                     "cogis_pilot_run_40479938455", "pilot")
# D-013：04_数据/原始数据 为唯一运行期数据源，09 为只读归档回退
PILOT_04 = os.path.join(ROOT, "..", "04_数据", "原始数据")
if os.path.isdir(PILOT_04):
    PILOT = PILOT_04

DAYS = 30.4
PRICE = 0.323
COST = 45.0
BUDGET_K = 3
N_RANDOM = 4000
SEED = 20260101
N_BOOT = 1000


# ---------------------------------------------------------------- 基础量

def load_all():
    with open(BUNDLE, "r", encoding="utf-8") as f:
        b = json.load(f)
    cv = {c["well_id"]: c for c in b["curves"]}
    ev = {}
    for r in csv.DictReader(open(os.path.join(PILOT, "pilot_events_v2c.csv"),
                                 encoding="utf-8")):
        ev["CO" + r["api8"]] = r          # key 必须与 well_id 同形（CO + api8）

    wells = {}
    for w in b["wells"]:
        wid = w["well_id"]
        c = cv[wid]
        pred12 = sum(p["oil"] for p in c["prediction"]) * DAYS
        base12 = sum(p["oil"] for p in c["baseline"]) * DAYS
        act12 = sum((p["oil"] or 0.0) for p in c["actual"]) * DAYS
        e = ev.get(wid, {})
        wells[wid] = {
            "well_id": wid, "population": w["population"],
            "state": w["state"], "confidence": w.get("confidence"),
            "anchor": w["anchor"], "pred_npv": w["value_npv"],
            "pred12": pred12, "base12": base12, "act12": act12,
            "ratio": (act12 / base12) if base12 > 0 else None,
            "real_npv": (act12 - base12) * PRICE - COST,
            "D_fit": float(e.get("D_fit") or 0.0),
            "base_excl": float(e.get("base_m3d") or 0.0),
            "base_incl": float(e.get("base_incl_m3d") or 0.0),
        }
    missing = sum(1 for w in wells.values() if w["base_incl"] <= 0)
    if missing:
        print(f"⚠️ {missing} 口井的 base_incl 为空，敏感性 anchor 组会退化")
    return b, wells


def pick_top(wells, key, k=BUDGET_K):
    return [w["well_id"] for w in sorted(wells, key=key, reverse=True)[:k]]


def realized(wells, sel):
    return sum(wells[x]["real_npv"] for x in sel)


# ---------------------------------------------------------------- 回测

def backtest(wells, rng):
    ids = list(wells)
    out = {}

    # oracle：事后真实最优
    oracle_sel = pick_top([wells[i] for i in ids], lambda w: w["real_npv"])
    oracle_val = realized(wells, oracle_sel)

    # 其余策略
    pol = {
        "oracle": (oracle_sel, "事后最优（真实 NPV 前 3）"),
        "model": (pick_top([wells[i] for i in ids], lambda w: w["pred_npv"]),
                  "模型预测 NPV 前 3（折外）"),
        "anchor": (pick_top([wells[i] for i in ids], lambda w: w["anchor"]),
                   "锚点产量前 3"),
        "ratio": (pick_top([wells[i] for i in ids], lambda w: w["ratio"] or -9),
                  "事后 ratio 前 3"),
    }

    # 随机 4000 次（对照，用于 bootstrap CI）
    rand_vals = []
    for _ in range(N_RANDOM):
        s = rng.sample(ids, BUDGET_K)
        rand_vals.append(realized(wells, s))
    rand_vals.sort()

    # 精确分位：全枚举 C(77,3)=73150，无抽样误差
    exact = []
    for i in range(len(ids)):
        for j in range(i + 1, len(ids)):
            for k in range(j + 1, len(ids)):
                exact.append(wells[ids[i]]["real_npv"]
                             + wells[ids[j]]["real_npv"]
                             + wells[ids[k]]["real_npv"])
    exact.sort()

    def pctile_exact(v):
        lo, hi = 0, len(exact)
        while lo < hi:
            mid = (lo + hi) // 2
            if exact[mid] < v:
                lo = mid + 1
            else:
                hi = mid
        return lo / len(exact)

    def pctile(v):
        """v 在随机分布中的分位（越大越好）"""
        lo, hi = 0, len(rand_vals)
        while lo < hi:
            mid = (lo + hi) // 2
            if rand_vals[mid] < v:
                lo = mid + 1
            else:
                hi = mid
        return lo / len(rand_vals)

    policies = []
    for pid, (sel, label) in pol.items():
        val = realized(wells, sel)
        policies.append({
            "id": pid, "label": label, "selected": sel,
            "realized_mean": round(val, 2),
            "pctile_vs_random": round(pctile(val), 4),
            "pctile_exact": round(pctile_exact(val), 5),
            "regret": round(oracle_val - val, 2),
        })

    # model 策略的分位 bootstrap CI
    model_val = next(p["realized_mean"] for p in policies if p["id"] == "model")
    model_pct = next(p["pctile_vs_random"] for p in policies if p["id"] == "model")
    boot = []
    n = len(rand_vals)
    for _ in range(N_BOOT):
        samp = [rand_vals[rng.randrange(n)] for _ in range(n)]
        samp.sort()
        # 分位 = P(random < model_val)
        lo, hi = 0, n
        while lo < hi:
            mid = (lo + hi) // 2
            if samp[mid] < model_val:
                lo = mid + 1
            else:
                hi = mid
        boot.append(lo / n)
    boot.sort()

    return {
        "oracle": round(oracle_val, 2),
        "oracle_selected": oracle_sel,
        "policies": policies,
        "random": {
            "mean": round(st.mean(rand_vals), 2),
            "median": round(st.median(rand_vals), 2),
            "p5": round(rand_vals[int(0.05 * n)], 2),
            "p95": round(rand_vals[int(0.95 * n)], 2),
            "n_draws": N_RANDOM,
            "seed": SEED,
        },
        "exact_enum": {
            "n_combos": len(exact),
            "median": round(exact[len(exact) // 2], 2),
            "p5": round(exact[int(0.05 * len(exact))], 2),
            "p95": round(exact[int(0.95 * len(exact))], 2),
            "note": f"全枚举 C(77,{BUDGET_K})={len(exact)}，分位无抽样误差",
        },
        "model_percentile": round(pctile_exact(model_val), 5),
        "model_percentile_rand4000": model_pct,
        "model_pctile_ci95": [round(boot[int(0.025 * len(boot))], 4),
                             round(boot[int(0.975 * len(boot))], 4)],
    }


# ---------------------------------------------------------------- 校准

def calibration(wells):
    """confidence = P(NPV>0)；与「真实 NPV>0」比对。PR/SI 分列。"""
    def binning(rows, nb=5):
        rows = [r for r in rows if r["confidence"] is not None]
        rows.sort(key=lambda r: r["confidence"])
        if len(rows) < nb:
            return [], None, None
        size = len(rows) / nb
        bins = []
        for i in range(nb):
            seg = rows[int(i * size):int((i + 1) * size)] if i < nb - 1 else rows[int(i * size):]
            if not seg:
                continue
            pc = st.mean(r["confidence"] for r in seg)
            po = sum(1 for r in seg if r["real_npv"] > 0) / len(seg)
            bins.append({"pred": round(pc, 4), "obs": round(po, 4), "n": len(seg)})
        return bins, rows, nb

    def brier(rows):
        if not rows:
            return None
        return sum((r["confidence"] - (1.0 if r["real_npv"] > 0 else 0.0)) ** 2
                   for r in rows) / len(rows)

    def ece(bins, total):
        if not bins or not total:
            return None
        return sum(b["n"] / total * abs(b["pred"] - b["obs"]) for b in bins)

    out = {}
    for pop in ("PR", "SI"):
        rows = [w for w in wells.values() if w["population"] == pop]
        bins, valid, _ = binning(rows)
        out[pop] = {
            "bins": bins,
            "brier": round(brier(valid), 4) if valid else None,
            "ece": round(ece(bins, len(valid or [])), 4) if bins else None,
            "n": len(rows),
            "base_rate": round(sum(1 for r in rows if r["real_npv"] > 0) / len(rows), 4),
        }

    allrows = list(wells.values())
    bins, valid, _ = binning(allrows)
    br = brier(valid)
    # 全局基率基线：用「全样本正例率」作常数预测（v4 指定，比 0.5 常数严格）
    base_rate = sum(1 for r in allrows if r["real_npv"] > 0) / len(allrows)
    br_base = sum((base_rate - (1.0 if r["real_npv"] > 0 else 0.0)) ** 2
                  for r in allrows) / len(allrows)
    out["overall"] = {
        "bins": bins,
        "brier": round(br, 4) if br is not None else None,
        "ece": round(ece(bins, len(valid or [])), 4) if bins else None,
        "n": len(allrows),
        "base_rate": round(base_rate, 4),
    }
    out["brier_baseline"] = round(br_base, 4)
    out["brier_baseline_rule"] = f"常数预测 = 全样本正例率 {base_rate:.4f}"
    out["brier_improvement"] = round((br_base - br) / br_base, 4) if br else None
    out["n_bins"] = 5
    out["bin_note"] = ("用 5 箱而非 10 箱：SI 仅 26 口，10 箱每箱不足 3 个样本，"
                       "分箱估计会失真。PR/SI 各 5 箱，每箱 PR≈10、SI≈5 个")
    return out


# ---------------------------------------------------------------- 敏感性

def sensitivity(wells, base_all):
    """4 组：D_clip / anchor_mode / 油价 ±30% / 成本 ±20%"""
    out = {}

    # --- D 截断 ---
    def ratio_with_D(scale, only_capped=False):
        vals = []
        for w in wells.values():
            if only_capped and abs(w["D_fit"] - 0.15) > 1e-9:
                continue
            D = min(w["D_fit"] * scale, 0.15)
            b12 = sum(w["base_incl"] * pow(2.718281828459045, -D * t) * DAYS
                      for t in range(1, 13))
            if b12 > 0:
                vals.append(w["act12"] / b12)
        return st.median(vals) if vals else None

    base_med = base_all["ratio_median"]
    caps = [w for w in wells.values() if abs(w["D_fit"] - 0.15) < 1e-9]
    out["D_clip"] = {
        "overall": {
            "baseline_median": round(base_med, 4),
            "d_scale_067": round(ratio_with_D(0.67), 4),
            "d_scale_133": round(ratio_with_D(1.33), 4),
            "n": len(wells),
        },
        "capped14": {
            "n": len(caps),
            "baseline_median": round(st.median([w["ratio"] for w in caps if w["ratio"]]), 4),
            "d_scale_067": round(ratio_with_D(0.67, True), 4),
            "d_scale_133": round(ratio_with_D(1.33, True), 4),
            "note": "D 顶格 0.15 的 14 口井；改 D 后其基线变化最大",
        },
        "method": "D 分别乘 0.67 / 1.33 后再 clip 到 [0, 0.15]，重算 base12 与 ratio 中位",
    }

    # --- anchor incl / excl ---
    def ratio_with_anchor(mode):
        vals = []
        for w in wells.values():
            anc = w["base_incl"] if mode == "incl" else w["base_excl"]
            if anc <= 0:
                continue
            b12 = sum(anc * pow(2.718281828459045, -w["D_fit"] * t) * DAYS
                      for t in range(1, 13))
            if b12 > 0:
                vals.append(w["act12"] / b12)
        return st.median(vals) if vals else None

    out["anchor_mode"] = [
        {"mode": "incl", "ratio_median": round(ratio_with_anchor("incl"), 4),
         "note": "含措施月（主口径）"},
        {"mode": "excl", "ratio_median": round(ratio_with_anchor("excl"), 4),
         "note": "不含措施月（审计对照）"},
    ]

    # --- 油价 ±30% ---
    out["price_pm30"] = []
    for mult in (0.7, 1.0, 1.3):
        vals = [(w["act12"] - w["base12"]) * (PRICE * mult) - COST for w in wells.values()]
        out["price_pm30"].append({
            "mult": mult,
            "npv_median": round(st.median(vals), 2),
            "npv_mean": round(st.mean(vals), 2),
            "n_positive": sum(1 for v in vals if v > 0),
        })

    # --- 成本 ±20% ---
    out["cost_pm20"] = []
    for mult in (0.8, 1.0, 1.2):
        vals = [(w["act12"] - w["base12"]) * PRICE - COST * mult for w in wells.values()]
        out["cost_pm20"].append({
            "mult": mult,
            "npv_median": round(st.median(vals), 2),
            "npv_mean": round(st.mean(vals), 2),
            "n_positive": sum(1 for v in vals if v > 0),
        })

    return out


# ---------------------------------------------------------------- KPI

def compute_kpi(wells, bt, cal):
    """五类工程指标，各一个数字 + 口径"""
    green = [w for w in wells.values() if w["state"] == "green"]
    red = [w for w in wells.values() if w["state"] == "red"]

    # 质量：绿盘 precision
    prec = sum(1 for w in green if w["real_npv"] > 0) / len(green) if green else None

    # 成本：按绿盘误判数 × 单井成本
    n_green_bad = sum(1 for w in green if w["real_npv"] <= 0)
    cost_saved = n_green_bad * COST

    # 安全：误压概率 = 红盘/黄盘里被判可执行的比例？这里定义为「绿盘里实际亏损的比例」
    mis = n_green_bad / len(green) if green else None

    # 可靠性：模型策略相对随机的分位
    rel = bt["model_percentile"]

    # 效率：用**可数的交互步数**，不编时间。
    # 依据 README 的四幕路径：① 全景 → 点井看卡 → ② 单井卡 → ③ 选 3 口结算 → ④ 复盘
    #   展开 = 打开全景(1) + 点 1 口井(1) + 读决策卡(1) + 勾选 3 口(3) + 结算(1) + 打开复盘(1)
    steps = 8

    return {
        "cost": {
            "value": round(cost_saved, 1), "unit": "万元",
            "label": "按绿盘误判数 × 45 万/井 估算的可避免支出",
            "formula": f"绿盘 {len(green)} 口中实际亏损 {n_green_bad} 口 × 45 万",
            "caveat": "前提是「不选这些井」即省下费用；未计机会成本",
        },
        "efficiency": {
            "value": steps, "unit": "steps",
            "label": "完成一次三口选井决策的交互步数（四幕路径展开）",
            "formula": "全景1 + 点井1 + 读卡1 + 勾选3 + 结算1 + 复盘1 = 8 步",
            "caveat": "步数可复现；**耗时尚未实测**，待 P9 在浏览器里计时后补 time_sec 字段",
        },
        "quality": {
            "value": round(prec, 4) if prec is not None else None, "unit": "ratio",
            "label": "绿盘 precision（判绿且实际 NPV>0）",
            "formula": f"绿盘 {len(green)} 口中 {len(green)-n_green_bad} 口实际为正",
            "caveat": "n=19，95% CI 约 ±0.20，不宜单独引用",
        },
        "reliability": {
            "value": round(rel, 4), "unit": "pctile",
            "label": "模型选井相对随机策略的分位",
            "formula": "P(random_4000 < model_realized)",
            "caveat": f"95% CI [{bt['model_pctile_ci95'][0]:.3f}, {bt['model_pctile_ci95'][1]:.3f}]",
        },
        "safety": {
            "value": round(mis, 4) if mis is not None else None, "unit": "ratio",
            "label": "误压概率（绿盘判错的比例）",
            "formula": f"{n_green_bad}/{len(green)}",
            "caveat": "与 quality 互为补数，单列以对齐「五类指标」要求",
        },
    }


# ---------------------------------------------------------------- 主流程

def main():
    print("=" * 78)
    print("P5 · 决策回测 / 校准 / 敏感性 / KPI")
    print("=" * 78)
    b, wells = load_all()
    rng = random.Random(SEED)

    # 复算 ratio，确认口径没漂
    ratios = [w["ratio"] for w in wells.values() if w["ratio"] is not None]
    rmed = st.median(ratios)
    rge1 = sum(1 for x in ratios if x >= 1) / len(ratios)
    print(f"复算 ratio_median={rmed:.4f}  frac_ge_1={rge1:.4f}  n={len(ratios)}")

    # 回测
    print("\n[1/4] 策略回测（随机 4000 次）…")
    bt = backtest(wells, rng)
    print(f"  oracle = {bt['oracle']:.2f} 万元 {bt['oracle_selected']}")
    print(f"  {'策略':<8}{'实现NPV':>12}{'随机分位':>10}{'regret':>10}")
    for p in bt["policies"]:
        print(f"  {p['id']:<8}{p['realized_mean']:12.2f}{p['pctile_vs_random']:10.3f}{p['regret']:10.2f}")
    print(f"  模型策略分位 = {bt['model_percentile']:.3f}  "
          f"95%CI [{bt['model_pctile_ci95'][0]:.3f}, {bt['model_pctile_ci95'][1]:.3f}]")

    # 校准
    print("\n[2/4] 校准（PR/SI 分列，5 箱）…")
    cal = calibration(wells)
    for pop in ("PR", "SI", "overall"):
        c = cal[pop]
        print(f"  {pop:8} n={c['n']:3} base_rate={c['base_rate']:.3f} "
              f"Brier={c['brier']} ECE={c['ece']}")
    print(f"  基线 Brier={cal['brier_baseline']}  改善={cal['brier_improvement']}")

    # 敏感性
    print("\n[3/4] 敏感性 4 组…")
    sens = sensitivity(wells, {"ratio_median": rmed})
    print(f"  D_clip overall: base={sens['D_clip']['overall']['baseline_median']} "
          f"×0.67={sens['D_clip']['overall']['d_scale_067']} "
          f"×1.33={sens['D_clip']['overall']['d_scale_133']}")
    print(f"  D_clip capped14(n={sens['D_clip']['capped14']['n']}): "
          f"base={sens['D_clip']['capped14']['baseline_median']} "
          f"×0.67={sens['D_clip']['capped14']['d_scale_067']} "
          f"×1.33={sens['D_clip']['capped14']['d_scale_133']}")
    print(f"  anchor: " + " / ".join(f"{x['mode']}={x['ratio_median']}" for x in sens["anchor_mode"]))
    print(f"  price: " + " / ".join(f"×{x['mult']}→{x['npv_median']}" for x in sens["price_pm30"]))
    print(f"  cost : " + " / ".join(f"×{x['mult']}→{x['npv_median']}" for x in sens["cost_pm20"]))

    # KPI
    print("\n[4/4] KPI 五类…")
    kpi = compute_kpi(wells, bt, cal)
    for k, v in kpi.items():
        print(f"  {k:<12} {v['value']} {v['unit']:<7} {v['label'][:40]}")

    # ---------- 写回 ----------
    b["evidence"]["backtest"] = {
        "protocol": "LOO（5 折按井交叉，折外预测；R-11 pass）",
        "budget_k": BUDGET_K,
        "budget_wan": BUDGET_K * COST,
        "policies": bt["policies"],
        "oracle": bt["oracle"],
        "oracle_selected": bt["oracle_selected"],
        "random": bt["random"],
        "exact_enum": bt["exact_enum"],
        "model_percentile": bt["model_percentile"],
        "model_percentile_rand4000": bt["model_percentile_rand4000"],
        "model_pctile_ci95": bt["model_pctile_ci95"],
        "hit_rate_all": b["evidence"]["backtest"].get("hit_rate_all"),
        "hit_rate_any": b["evidence"]["backtest"].get("hit_rate_any"),
        "note": "hit_rate_any = 三口至少一口为正；hit_rate_all = 三口同时为正。UI 只显示 all（修 B1）",
        "caveat": ("n=77、预算 3 口，单次选井结果的重尾极强；分位比点估计稳健，"
                   "但仍应看 CI 而非单值"),
    }
    b["evidence"]["calibration"] = cal
    b["evidence"]["sensitivity"] = sens
    b["evidence"]["kpi"] = kpi
    b["evidence"]["scope"] = {
        "county": b["meta"]["scope"]["county"],
        "event_month_min": b["meta"]["scope"]["event_month_min"],
        "event_month_max": b["meta"]["scope"]["event_month_max"],
        "year_hist": b["meta"]["scope"]["year_hist"],
        "note": "单一县（WELD），11 个年份分布不均，/evidence 须画分布条",
    }

    # ---------- 断言 ----------
    print("\n" + "=" * 78)
    print("P5 验收")
    print("=" * 78)
    checks = []

    def ck(name, ok, detail):
        checks.append((name, ok))
        print(f"{'✓' if ok else '✗'} {name:<36}{'PASS' if ok else 'FAIL':<6}{detail}")

    ck("复算 ratio 1.067 ±0.002", abs(rmed - 1.067) <= 0.002, f"{rmed:.4f}")
    ck("复算 frac≥1 0.558 ±0.003", abs(rge1 - 0.558) <= 0.003, f"{rge1:.4f}")
    ck("模型分位 ≥ 90%", bt["model_percentile"] >= 0.90, f"{bt['model_percentile']:.3f}")
    ck("分位 CI 下界 > 75%", bt["model_pctile_ci95"][0] > 0.75,
       f"{bt['model_pctile_ci95'][0]:.3f}")
    ck("oracle ≥ 所有策略",
       all(p["realized_mean"] <= bt["oracle"] + 1e-6 for p in bt["policies"]),
       f"{bt['oracle']:.2f}")
    ck("敏感性 4 组齐全",
       all(k in sens for k in ("D_clip", "anchor_mode", "price_pm30", "cost_pm20")),
       "D_clip/anchor/price/cost")
    ck("D_clip 含 capped14 且 n=14", sens["D_clip"]["capped14"]["n"] == 14,
       f"n={sens['D_clip']['capped14']['n']}")
    ck("KPI 5 项齐全",
       all(k in kpi and kpi[k]["value"] is not None for k in
           ("cost", "efficiency", "quality", "reliability", "safety")),
       "cost/efficiency/quality/reliability/safety")

    ok_all = all(ok for _, ok in checks)

    if ok_all:
        txt = json.dumps(b, ensure_ascii=False, separators=(",", ":"))
        for p in (BUNDLE, REL):
            with open(p, "w", encoding="utf-8", newline="\n") as f:
                f.write(txt)
        import hashlib
        sha = hashlib.sha256(txt.encode("utf-8")).hexdigest()
        with open(os.path.join(os.path.dirname(REL), "SHA256SUMS.txt"),
                  "w", encoding="utf-8", newline="\n") as f:
            f.write(f"{sha}  bundle_v3.json\n")
        print(f"\n[write] bundle_v3.json  {len(txt.encode('utf-8'))/1024:.0f} KB")
        print(f"[sha] {sha}")
    else:
        print("\n✗ 未通过，不写文件")
        if not (bt["model_percentile"] >= 0.90 and bt["model_pctile_ci95"][0] > 0.75):
            print("\n⚠️ 模型策略未达 90% 分位门槛 —— 按 v4 纪律，应如实写「无决策价值」。")
    return 0 if ok_all else 1


if __name__ == "__main__":
    sys.exit(main())
