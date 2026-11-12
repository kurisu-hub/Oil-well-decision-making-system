# -*- coding: utf-8 -*-
"""
T17 · 预计算参数网格（econ_grid_v1）
====================================

目标（06_任务清单.md §5D T17）：油价 / 成本 / 预算三档离散化，前端查表——
改假设 → 亚秒出结果，不再重跑管道。

做法（不发明公式）：
· 单井 NPV 沿用 build_bundle_v31.py 的经济口径恒等式
      value_npv = value_oil × price_wan_per_m3 − well_cost_wan
  其中 price_wan_per_m3 = oil_price_cny_per_t × oil_density_t_per_m3 / 10000
  （bundle.assumptions.registry 原文）。对 (油价, 成本) 3×3=9 个组合逐井重算，
  结果整表随包发布 → 前端只做查表，不做任何公式。
· 油价三档：3800 元/t 的 ×0.8 / ×1.0 / ×1.2 → 3040 / 3800 / 4560 元/t
  （backtest_p5.py 敏感性 price_pm30 用 ±30%，这里取 ±20% 更贴实盘波动；
  两边口径独立、互不引用，如实分档）。
· 成本三档：45 万元的 ×0.8 / ×1.0 / ×1.2 → 36 / 45 / 54 万元。
· 预算三档：k = 2 / 3 / 4 口 × well_cost_wan(45) → 90 / 135 / 180 万元
  （135 即 bundle portfolio 实有档，P4 组合 k=3 同源）。
· 组合层不进网格：分布类指标（loss_prob/cvar/hit_rate/regret）来自 P4 蒙特卡洛，
  按工况重算属于新实验，本任务不冒充——组合层查表仍走 combo_metrics，
  只有逐井 NPV（期望值，线性可加）按工况查网格。

自检（写入前全部通过才落盘）：
  G1  77 口逐井 value_oil 有限；
  G2  基准档(×1.0,×1.0) 逐井 npv 与 bundle.value_npv 最大差 ≤ 0.05 万元
      （整数舍入链容差，与 worker_bench 同判据量级）；
  G3  查表恒等：bundle.combo_metrics.items[0]（模型推荐组合）所选井的
      基准档网格 npv 求和 == 该条 expected_npv（|Δ| ≤ 0.1）；
  G4  档位数 = 3/3/3，网格条目 = 9，每条 77 井全覆盖。

用法：python build_econ_grid.py   （在 pipeline/ 目录下执行）
"""
import json
import sys
from datetime import datetime
from pathlib import Path

HERE = Path(__file__).resolve().parent
BUNDLE = HERE.parent / "frontend" / "src" / "data" / "bundle_v3.json"
OUT_FE = HERE.parent / "frontend" / "src" / "data" / "econ_grid.json"
OUT_RECORD = HERE / "out" / "econ_grid.json"

PRICE_MULTS = [0.8, 1.0, 1.2]
COST_MULTS = [0.8, 1.0, 1.2]
BUDGET_K = [2, 3, 4]


def r2(x):
    return round(x + 0.0, 2)


def main():
    b = json.loads(BUNDLE.read_text(encoding="utf-8"))
    a = b["assumptions"]
    oil_price_ref = a["oil_price_cny_per_t"]          # 3800 元/t
    density = a["oil_density_t_per_m3"]               # 0.85 t/m³
    well_cost = a["well_cost_wan"]                    # 45 万元
    price_wan_ref = a["price_wan_per_m3"]             # 0.323 万元/m³

    wells = b["wells"]
    ids = [w["well_id"] for w in wells]
    oil_map = {w["well_id"]: w["value_oil"] for w in wells}

    # 档位（派生自 bundle 假设，不硬编码）
    price_tiers = [
        {"oil_price_cny_per_t": round(oil_price_ref * m), "mult": m,
         "price_wan_per_m3": round(oil_price_ref * m * density / 10000, 6)}
        for m in PRICE_MULTS
    ]
    cost_tiers = [{"well_cost_wan": round(well_cost * m, 2), "mult": m} for m in COST_MULTS]
    budget_tiers = [{"budget_wan": round(k * well_cost, 2), "k_wells": k} for k in BUDGET_K]

    # 基准档自检基准
    npv_bundle = {w["well_id"]: w["value_npv"] for w in wells}

    bad_oil = [wid for wid, o in oil_map.items() if not isinstance(o, (int, float)) or o != o]

    grid = []
    max_diff_base = 0.0
    for pi, pt in enumerate(price_tiers):
        pw = pt["price_wan_per_m3"]
        for ci, ct in enumerate(cost_tiers):
            cw = ct["well_cost_wan"]
            npvs = {}
            for wid in ids:
                npvs[wid] = r2(oil_map[wid] * pw - cw)
            # 聚合（期望值线性可加，同 build_bundle_v31 组合口径）
            pos = [wid for wid in ids if npvs[wid] > 0]
            top3 = sorted(ids, key=lambda wid: -npvs[wid])[:3]
            entry = {
                "p": pi,
                "c": ci,
                "n_npv_pos": len(pos),
                "sum_npv": r2(sum(npvs[wid] for wid in ids)),
                "top3": {
                    "selected": top3,
                    "expected_oil": r2(sum(oil_map[wid] for wid in top3)),
                    "expected_npv": r2(sum(npvs[wid] for wid in top3)),
                },
                "npv": npvs,
            }
            # G2：基准档逐井对 bundle
            if pt["mult"] == 1.0 and ct["mult"] == 1.0:
                for wid in ids:
                    d = abs(npvs[wid] - npv_bundle[wid])
                    if d > max_diff_base:
                        max_diff_base = d
            grid.append(entry)

    # G3：模型推荐组合的查表恒等
    cm = b.get("combo_metrics")
    identity_diff = None
    if cm and cm.get("items"):
        it0 = cm["items"][0]
        base = next(e for e in grid if e["p"] == 1 and e["c"] == 1)
        s = sum(base["npv"][wid] for wid in it0["selected"])
        identity_diff = abs(s - it0["expected_npv"])

    # ---- 自检 ----
    errs = []
    if bad_oil:
        errs.append(f"G1 value_oil 非有限值: {bad_oil[:5]}")
    if max_diff_base > 0.05:
        errs.append(f"G2 基准档逐井对 bundle 最大差 {max_diff_base:.4f} > 0.05")
    if identity_diff is None or identity_diff > 0.1:
        errs.append(f"G3 组合查表恒等差 {identity_diff} > 0.1（或 combo_metrics 缺失）")
    if not (len(price_tiers) == 3 and len(cost_tiers) == 3 and len(budget_tiers) == 3):
        errs.append("G4 档位数不是 3/3/3")
    if len(grid) != 9 or any(len(e["npv"]) != len(ids) for e in grid):
        errs.append("G4 网格条目数或覆盖井数不对")
    if errs:
        for e in errs:
            print("FAIL", e)
        sys.exit(1)

    out = {
        "version": "econ_grid_v1",
        "generated_at": datetime.now().strftime("%Y-%m-%d %H:%M"),
        "task": "T17 预计算参数网格",
        "source": (
            "bundle_v3.json wells[].value_oil × price_wan_per_m3 − well_cost_wan"
            "（build_bundle_v31.py 经济口径恒等式，逐井重算，前端只查表）"
        ),
        "base": {
            "oil_price_cny_per_t": oil_price_ref,
            "oil_density_t_per_m3": density,
            "price_wan_per_m3": price_wan_ref,
            "well_cost_wan": well_cost,
        },
        "price_tiers": price_tiers,
        "cost_tiers": cost_tiers,
        "budget_tiers": budget_tiers,
        "self_check": {
            "g2_max_diff_base_vs_bundle": round(max_diff_base, 4),
            "g3_combo_identity_diff": round(identity_diff, 4),
        },
        "grid": grid,
    }

    OUT_FE.write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    OUT_RECORD.parent.mkdir(parents=True, exist_ok=True)
    OUT_RECORD.write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")

    size = OUT_FE.stat().st_size
    print(f"OK econ_grid_v1 → {OUT_FE} ({size} B)")
    print(f"  档位: 油价 {[t['oil_price_cny_per_t'] for t in price_tiers]} 元/t · "
          f"成本 {[t['well_cost_wan'] for t in cost_tiers]} 万元 · "
          f"预算 {[t['budget_wan'] for t in budget_tiers]} 万元")
    print(f"  G2 基准档对 bundle 最大差 = {max_diff_base:.4f} 万元（≤0.05）")
    print(f"  G3 推荐组合查表恒等差 = {identity_diff:.4f} 万元（≤0.1）")
    base = grid[4]  # p=1,c=1
    print(f"  基准档: n_npv_pos={base['n_npv_pos']} sum_npv={base['sum_npv']} "
          f"top3={base['top3']['selected']} npv={base['top3']['expected_npv']}")


if __name__ == "__main__":
    main()
