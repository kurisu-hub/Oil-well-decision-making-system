# -*- coding: utf-8 -*-
"""把 bundle + geo 压成孪生大屏需要的紧凑 data.json（只取用得到的字段）。"""
import json, math, statistics, pathlib

ROOT = pathlib.Path(__file__).resolve().parents[2]
B = ROOT / "02_可运行产物" / "pilot_bundle_final77.json"
G = ROOT / "03_源代码" / "frontend" / "src" / "data" / "geo.json"
OUT = ROOT / "03_源代码" / "frontend" / "screen" / "src" / "data.json"

b = json.loads(B.read_text(encoding="utf-8"))
geo = {w["well_id"]: w for w in json.loads(G.read_text(encoding="utf-8"))["wells"]}
curves = {c["well_id"]: c for c in b["curves"]}
wells = b["wells"]

# ---- 真实统计：事件后 12 个月 / 基线 ----
ratios = []
for w in wells:
    c = curves.get(w["well_id"])
    if not c:
        continue
    pred = [p["oil"] for p in c["prediction"]][:12]
    base = [p["oil"] for p in c["baseline"]][:12]
    sb = sum(base)
    if sb > 0:
        ratios.append(sum(pred) / sb)
ratio_med = statistics.median(ratios)
share_ge1 = sum(1 for r in ratios if r >= 1) / len(ratios)

# 官方口径：实际 12 个月累计 / 基线（纯数据事实，不含模型）
aob = b["baseline_audit"]["act_over_base"]

# 预测/基线（模型口径，用于曲线对照，标注清楚）
ratio_pred = ratio_med
share_pred = share_ge1

states = {s: sum(1 for w in wells if w["state"] == s) for s in ("green", "yellow", "red", "gray")}

# ---- 井位：ENU 米 → 归一化到背景环（保留相对方位，压缩半径）----
xs = [geo[w["well_id"]]["x"] for w in wells if w["well_id"] in geo]
ys = [geo[w["well_id"]]["y"] for w in wells if w["well_id"] in geo]
cx, cy = (min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2
rmax = max(math.hypot(x - cx, y - cy) for x, y in zip(xs, ys))
R = 1500.0
pos = {}
for w in wells:
    g = geo.get(w["well_id"])
    if not g:
        continue
    dx, dy = g["x"] - cx, g["y"] - cy
    r = math.hypot(dx, dy)
    a = math.atan2(dy, dx)
    rr = R * (r / rmax) ** 0.62 if rmax else 0
    pos[w["well_id"]] = (round(math.cos(a) * rr, 1), round(math.sin(a) * rr, 1))

# ---- 8 口 hero 井（沿用 twin.json 的绑定，都在井场前排）----
HERO = ["CO12338294", "CO12334960", "CO12336656", "CO12336653",
        "CO12336702", "CO12338128", "CO12334421", "CO12338132"]
hero_set = set(HERO)

def spark(wid, n=12):
    c = curves.get(wid)
    if not c:
        return None
    return [round(p["oil"], 3) for p in c["prediction"]][:n]

out_wells = []
for w in wells:
    wid = w["well_id"]
    g = geo.get(wid, {})
    out_wells.append({
        "id": wid,
        "name": w["name"],
        "api": w["api"],
        "state": w["state"],
        "npv": round(w["value_npv"], 1),
        "oil": round(w["value_oil"], 1),
        "roi": round(w["roi"], 3),
        "conf": round(w["confidence"], 3),
        "anchor": w["anchor"],
        "bucket": w["bucket"],
        "action": w["recommended_action"],
        "reason": w["state_reason"],
        "x": pos.get(wid, (0, 0))[0],
        "y": pos.get(wid, (0, 0))[1],
        "lon": round(g.get("lon", 0), 5),
        "lat": round(g.get("lat", 0), 5),
        "hero": wid in hero_set,
        "gap": (w.get("data_gaps") or [""])[0][:60],
        "sp": spark(wid),
    })

# hero 排序：按 twin.json 的 A-1..A-8
order = {w: i for i, w in enumerate(HERO)}
heros = sorted([w for w in out_wells if w["hero"]], key=lambda w: order[w["id"]])

strat = b["portfolio"]["strategies"]
p = b["portfolio"]["points"][0]

data = {
    "meta": {
        "dataset": b["meta"]["dataset_id"],
        "release": b["meta"]["release"],
        "n_wells": b["meta"]["n_wells"],
        "n_events": b["meta"]["n_events"],
        "n_months": b["meta"]["n_wells"] * 12,
        "source": "COGCC / ECMC 产量年报 + COGIS Form 5A + FracFocus(CO)",
        "window": "2014-09 ~ 2024-08",
        "model": b["meta"]["model_version"],
        "generated": b["meta"]["generated_at"][:10],
    },
    "kpi": {
        "ratio_median": round(aob["median"], 4),
        "share_ge1": round(aob["frac_ge_1"], 4),
        "ratio_p25": round(aob["p25"], 4),
        "ratio_p75": round(aob["p75"], 4),
        "ratio_pred": round(ratio_pred, 4),
        "states": states,
        "budget": p["budget"],
        "ai_npv": strat[0]["expected_npv"],
        "ai_oil": strat[0]["expected_oil"],
        "ai_hit": strat[0]["hit_rate"],
        "ai_loss": strat[0]["loss_prob"],
        "oracle_npv": round(strat[0]["expected_npv"] + 0, 2),
        "regret_expert": strat[1]["regret"],
        "regret_hist": strat[2]["regret"],
        "regret_random": strat[3]["regret"],
    },
    "strategies": strat,
    "combo": {
        "k": b["combo_metrics"]["k"],
        "n_total": b["combo_metrics"]["n_total"],
        "top": b["combo_metrics"]["items"][:6],
    },
    "confusion": b["state_confusion"],
    "diag": b["model_diagnostics"],
    "metrics": b["final_model"]["final77_metrics"].get("in_sample_fit", {}),
    "intervals": {k: b["intervals"][k] for k in
                  ("target_coverage", "alpha", "label_cn", "n_points_total", "frac_lower_clipped")},
    "q90": b["intervals"]["q90"],
    "d_pool": b["baseline_audit"]["D_pool"],
    "passport": [{k: p_[k] for k in ("id", "label", "value", "unit", "formula", "source", "sample_size")}
                 for p_ in b["passport"][:60]],
    "wells": out_wells,
    "heroes": [h["id"] for h in heros],
}

OUT.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
kb = OUT.stat().st_size / 1024
print(f"OK {OUT}  {kb:.0f} KB")
print("ratio_median", round(ratio_med, 4), "share>=1", round(share_ge1, 4), "n", len(ratios))
print("states", states, "heros", len(heros), "pos range",
      min(v[0] for v in pos.values()), max(v[0] for v in pos.values()))
print("ai", strat[0])
