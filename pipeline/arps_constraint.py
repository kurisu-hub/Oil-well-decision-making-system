#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""T15 · 机理约束（Arps 双曲递减）

问题不在精度，在物理：
    ANBM 逐档逐月独立拟合倍数，曲线可以任意反弹。实测 77/77 口井的预测曲线
    **全部非单调**，最夸张的档位在第 5–6 个月预测到基线的 **4.0 倍**
    （`1.23 → 1.10 → 2.60 → 2.23 → 4.00 → 4.00`）。评委会问一句「这曲线为什么涨」。

做法：
    q(t) = q_i · (1 + b·D_i·t)^(-1/b),  b ∈ [0, 1]
    b = 0 时退化为指数递减 q = q_i·exp(-D_i·t)，所以指数基线是这个族的特例，
    不是另一个模型——加上约束等于把假设空间从「任意 12 个倍数」缩到「3 个物理参数」。

验收（P2 · T15）：
    ① 输出曲线单调递减、非负          → 由参数化保证，仍逐井断言
    ② 外推 60 月不发散                → 断 q(60) 有限、正、且小于 q(1)
    ③ 与无约束版折外 MAE 差 ≤ 5%      → 对 ANBM（5 折按井，924 格）

用法：
    python arps_constraint.py --all
    python arps_constraint.py --assert   # 只跑三条物理断言
    python arps_constraint.py --fit      # 打印参数分布

作者：算法专家 · 2026-11-10 · 依赖 twin_state 的数据读取，仅标准库
"""
from __future__ import annotations

import argparse
import collections
import json
import math
import os
import statistics as st

import twin_state as T
import same_protocol as SP

HERE = os.path.dirname(os.path.abspath(__file__))
PROJ = os.path.abspath(os.path.join(HERE, "..", ".."))
OUT_DIR = os.path.join(HERE, "out")

B_GRID = [i / 20 for i in range(21)]              # 0, 0.05, …, 1.00
DI_GRID = [i / 1000 for i in range(2, 601, 2)]    # 0.002 … 0.600（步 0.002）
# 上界原设 0.30，实测 P90 正好压在 0.298 —— 说明有 10% 的井被边界截断，
# 是网格伪影不是数据性质，放宽到 0.60。
N_HIST = 36                                       # 拟合用的事件前月数
HORIZON = 12                                      # 评价期
EXTRA = 60                                        # 外推检验期


# ---------------------------------------------------------------- 模型
def arps_q(qi, b, di, t):
    """t 为从起点算起的月数（>=0）。b=0 退化为指数。"""
    if t <= 0:
        return qi
    if b <= 1e-9:
        return qi * math.exp(-di * t)
    return qi * (1.0 + b * di * t) ** (-1.0 / b)


def fit(obs, ev):
    """在事件前历史上拟合 (q_i, b, D_i)。

    用对数最小二乘：给定 (b, D_i)，ln q_i 有闭式解，所以只在 (b, D_i) 上搜。
    拟合只用事件前可用月 —— 与 base_incl / D_fit 的口径同源，不引入任何后视。
    """
    pre = [o for o in obs if o.mi < ev.mi and o.usable][-N_HIST:]
    # 12 个月以下拟合不出 3 个参数（D-038②）。原来卡在 6，实测 15 口井用 7–11 个月
    # 就硬拟合三参数且 fallback 全 False —— 闸门写了没接上，与 D-011 同型。
    if len(pre) < 12:
        return {"qi": ev.base_incl, "b": 0.0, "di": max(ev.D_fit, 0.001),
                "n_hist": len(pre), "fallback": True, "rmse": None}
    tt = list(range(len(pre)))          # 0 起算，最后一个月 = len(pre)-1
    ys = [o.rate for o in pre]
    ly = [math.log(max(y, 1e-9)) for y in ys]

    best = None
    for b in B_GRID:
        for di in DI_GRID:
            # 每个 t 的对数衰减项
            if b <= 1e-9:
                dec = [di * t for t in tt]
            else:
                dec = [math.log(1.0 + b * di * t) / b for t in tt]
            # ln q_i = mean(ln y + dec)
            lqi = sum(ly[i] + dec[i] for i in range(len(tt))) / len(tt)
            sse = 0.0
            for i in range(len(tt)):
                e = ly[i] - (lqi - dec[i])
                sse += e * e
            if best is None or sse < best[0]:
                best = (sse, math.exp(lqi), b, di)
    sse, qi0, b, di = best
    return {"qi": qi0, "b": b, "di": di, "n_hist": len(pre),
            "fallback": False, "rmse": math.sqrt(sse / len(tt)),
            "t_last": len(pre) - 1}


def forecast(p, k, base_shift):
    """预测事件后第 k 个月（k=1..）。

    base_shift = 事件月相对拟合起点的月数（= 历史长度）。
    """
    qi, b, di = p["qi"], p["b"], p["di"]
    if p["fallback"]:
        return qi * math.exp(-di * k)
    t = base_shift + k
    return arps_q(qi, b, di, t)


# ---------------------------------------------------------------- 断言
def run_asserts(series, events, params_by_well):
    print("=" * 84)
    print("T15 · 三条物理断言")
    print("=" * 84)
    bad_mono = bad_neg = bad_div = 0
    worst = None
    for api8, p in params_by_well.items():
        shift = p.get("t_last", 0) + 1
        cur = [forecast(p, k, shift) for k in range(1, HORIZON + 1)]
        cur = [c for c in cur if c is not None and math.isfinite(c)]
        # ① 单调递减
        for a, b in zip(cur, cur[1:]):
            if b > a + 1e-12:
                bad_mono += 1
                break
        # ① 非负
        if any(c < 0 for c in cur):
            bad_neg += 1
        # ② 60 月外推
        c60 = [forecast(p, k, shift) for k in range(1, EXTRA + 1)]
        if (not all(math.isfinite(x) and x >= 0 for x in c60)
                or c60[-1] > c60[0] or c60[-1] <= 0):
            bad_div += 1
        else:
            r = c60[-1] / c60[0] if c60[0] > 0 else 0
            if worst is None or r > worst[1]:
                worst = (api8, r)
    n = len(params_by_well)
    fit_p = {k: v for k, v in params_by_well.items() if not v.get("fallback")}
    b_bind = sum(1 for v in fit_p.values() if v["b"] <= 1e-9 or v["b"] >= 0.999)
    d_bind = sum(1 for v in fit_p.values() if v["di"] >= 0.599)
    any_bind = sum(1 for v in fit_p.values()
                   if v["b"] <= 1e-9 or v["b"] >= 0.999 or v["di"] >= 0.599)
    n_fb = n - len(fit_p)
    print(f"[0] 参数可辨识性（D-038）：拟合井 {len(fit_p)} · 降级 {n_fb}"
          f" · b 贴边 {b_bind} · D_i 贴边 {d_bind} · 任一贴边 {any_bind}"
          f"（{any_bind / max(1, len(fit_p)):.1%}）")
    print(f"    贴边 ≠ 失败：b=0 就是指数解，数据说这口井没有双曲性；"
          f"但「逐井机理标定」这个说法只对内点井成立")
    print(f"[1] 12 月曲线单调递减          : {'PASS' if bad_mono == 0 else 'FAIL'}"
          f"  违反 {bad_mono}/{n} 井")
    print(f"[1] 12 月曲线非负              : {'PASS' if bad_neg == 0 else 'FAIL'}"
          f"  违反 {bad_neg}/{n} 井")
    print(f"[2] 60 月外推有限、正、不增长   : {'PASS' if bad_div == 0 else 'FAIL'}"
          f"  违反 {bad_div}/{n} 井")
    if worst:
        print(f"    最缓的那口井 q(60)/q(1) = {worst[1]:.3f}（{worst[0]}），"
              f"仍 < 1，即 60 个月内不会发散")
    print("-" * 84)
    ok = (bad_mono == 0 and bad_neg == 0 and bad_div == 0)
    print(f"断言合计：{'全 PASS' if ok else '有 FAIL'}")
    print("=" * 84)
    return ok


# ---------------------------------------------------------------- 对照
def evaluate(series, events, params_by_well):
    """Arps 约束版 vs ANBM（无约束）在**同一批 924 格**上比 MAE。

    Arps 是逐井拟合，只用事件前历史，没有跨井样本，所以不需要折——天然折外。
    与 T12 的 5 折 ANBM 在同样的 924 格上比，口径一致。
    """
    pairs, pairs_m1 = [], []
    for api8, ev in events.items():
        obs = series.get(api8, [])
        p = params_by_well.get(api8)
        if p is None:
            continue
        shift = p.get("t_last", 0) + 1
        post = [o for o in obs if ev.mi <= o.mi < ev.mi + HORIZON]
        for k, o in enumerate(post, 1):
            pairs.append((o.rate, forecast(p, k, shift)))
            pairs_m1.append((o.rate, ev.base_incl * math.exp(-ev.D_fit * k)))
    return {"arps": SP.metrics(pairs), "m1_existing_exp": SP.metrics(pairs_m1),
            "n": len(pairs)}


def nonmono_stats(wells):
    """ANBM（无约束版）预测曲线的非单调比例——这就是「约束」要治的病。"""
    m = SP.fit_anbm(wells)
    up, worst = 0, (None, 0, None)
    for w in wells:
        cur = [SP.pred_anbm(m, w["base"], t) for t in range(HORIZON)]
        ups = [(i, b / a) for i, (a, b) in enumerate(zip(cur, cur[1:])) if b > a + 1e-9]
        if ups:
            up += 1
            peak = max(r for _, r in ups)
            if peak > worst[1]:
                worst = (w["well_id"], peak, [round(c, 2) for c in cur])
    return {"n": len(wells), "nonmono": up, "worst": worst}


def vs_template(wells, params, events):
    """Arps 与最强基线 Template 的配对 bootstrap（单位=井）。

    D-036 把门槛钉在 Template 1.8893 上。降级修复后 Arps 到 1.8711，
    比 Template 低 0.97% —— 这种量级绝不能直接说「更好」，先检验。
    """
    byid = {w["well_id"]: w for w in wells}
    tpl = {}
    for test_ids in SP.folds(wells, SP.N_FOLD):
        ts = set(test_ids)
        train = [w for w in wells if w["well_id"] not in ts]
        if len(train) < 10:
            continue
        m = SP.fit_template(train)
        for wid in test_ids:
            w = byid.get(wid)
            if w:
                tpl[wid] = [(w["y"][t], SP.pred_template(m, w["base"], t))
                            for t in range(HORIZON)]
    ar, ids = {}, []
    for api8, p in params.items():
        wid = "CO" + api8
        if wid not in tpl:
            continue
        ev = events[api8]
        shift = p.get("t_last", 0) + 1
        post = [o for o in SERIES[api8] if ev.mi <= o.mi < ev.mi + HORIZON]
        ar[wid] = [(o.rate, forecast(p, k, shift)) for k, o in enumerate(post, 1)]
        ids.append(wid)
    mae_a = {i: st.mean(abs(y - q) for y, q in ar[i]) for i in ids}
    mae_t = {i: st.mean(abs(y - q) for y, q in tpl[i]) for i in ids}
    diffs = [mae_a[i] - mae_t[i] for i in ids]
    rng = __import__("random").Random(SP.SEED)
    boots = sorted(st.mean([diffs[rng.randrange(len(diffs))] for _ in diffs])
                   for _ in range(10000))
    lo, hi = boots[250], boots[9750]
    print("=" * 84)
    print(f"配对 bootstrap：Arps {st.mean(mae_a.values()):.4f} vs Template "
          f"{st.mean(mae_t.values()):.4f}（单位=井，n={len(ids)}，10000 次）")
    print(f"  差 {st.mean(diffs):+.4f} · 95% CI [{lo:+.4f}, {hi:+.4f}] · "
          f"{'含 0 → 不显著' if lo < 0 < hi else '不含 0 → 显著'}")
    win = sum(1 for d in diffs if d < 0)
    print(f"  逐井胜负 Arps 更好 {win} / 更差 {len(diffs) - win}（胜率 {win / len(diffs):.1%}）")
    print("=" * 84)
    return {"mae_arps": st.mean(mae_a.values()), "mae_template": st.mean(mae_t.values()),
            "diff": st.mean(diffs), "ci": [lo, hi], "n": len(ids)}


SERIES = {}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--all", action="store_true")
    ap.add_argument("--assert", dest="do_assert", action="store_true")
    ap.add_argument("--fit", action="store_true")
    a = ap.parse_args()
    if not any([a.all, a.do_assert, a.fit]):
        a.all = True

    d = T.find_data_dir()
    series = T.load_series(os.path.join(d, "pilot_series.csv"))
    events = T.load_events(os.path.join(d, "pilot_events_v2c.csv"))
    wells, _ = SP.load()
    print(f"井 {len(series)} · 事件 {len(events)}\n")

    SERIES.clear()
    SERIES.update(series)
    params = {api8: fit(series.get(api8, []), ev) for api8, ev in events.items()}

    if a.fit or a.all:
        bs = [p["b"] for p in params.values() if not p["fallback"]]
        ds = [p["di"] for p in params.values() if not p["fallback"]]
        fb = sum(1 for p in params.values() if p["fallback"])
        print("=" * 84)
        print("Arps 参数分布（拟合于事件前 36 月）")
        print("=" * 84)
        print(f"可用井 {len(bs)} · 回退 {fb}（历史不足 6 个月）")
        print(f"b（双曲指数）: 中位 {st.median(bs):.2f} · "
              f"均值 {st.mean(bs):.3f} · b=0 占 {sum(1 for x in bs if x <= 1e-9) / len(bs):.0%}")
        print(f"D_i（月递减）: 中位 {st.median(ds):.4f} · "
              f"P10 {sorted(ds)[int(len(ds) * .1)]:.4f} · "
              f"P90 {sorted(ds)[int(len(ds) * .9)]:.4f}")
        print(f"拟合 RMSE（对数）中位 "
              f"{st.median([p['rmse'] for p in params.values() if p['rmse'] is not None]):.3f}")
        print("=" * 84)
        print()

    ok = True
    if a.do_assert or a.all:
        ok = run_asserts(series, events, params)
        print()

    if a.all:
        res = evaluate(series, events, params)
        nm = nonmono_stats(wells)
        anbm_mae = 2.0967      # T12 5 折按井，见 pipeline/out/same_protocol.json
        try:
            j = json.load(open(os.path.join(OUT_DIR, "same_protocol.json"),
                               encoding="utf-8"))
            anbm_mae = j["ANBM"]["MAE"]
        except Exception:
            pass
        print("=" * 84)
        print("与无约束版对照（同一批 924 格）")
        print("=" * 84)
        print(f"{'模型':<26}{'MAE':>9}{'RMSE':>9}{'sMAPE':>9}{'单调':>7}{'信息集':>10}")
        print("-" * 84)
        print(f"{'Arps 约束版（本文）':<24}{res['arps']['MAE']:>9.4f}"
              f"{res['arps']['RMSE']:>9.4f}{res['arps']['sMAPE']:>9.3f}{'是':>7}{'逐井36月':>10}")
        print(f"{'m1_existing_exp（b=0）':<24}{res['m1_existing_exp']['MAE']:>9.4f}"
              f"{res['m1_existing_exp']['RMSE']:>9.4f}"
              f"{res['m1_existing_exp']['sMAPE']:>9.3f}{'是':>7}{'逐井36月':>10}")
        print(f"{'ANBM 无约束版（5 折）':<24}{anbm_mae:>9.4f}"
              f"{'':>9}{'':>9}{'否':>7}{'池化77井':>10}")
        print("-" * 84)
        dev_m1 = (res["arps"]["MAE"] - res["m1_existing_exp"]["MAE"]) / res["m1_existing_exp"]["MAE"]
        dev_an = (res["arps"]["MAE"] - anbm_mae) / anbm_mae
        print(f"对照 A（同信息集 · 只换函数形式）：vs m1_existing_exp {dev_m1 * 100:+.2f}%"
              f"  → 判据 |差|≤5% {'PASS' if abs(dev_m1) <= 0.05 else 'FAIL'}")
        print(f"对照 B（不同信息集 · 按 T15 原文「无约束版」）：vs ANBM {dev_an * 100:+.2f}%"
              f"  → 判据 |差|≤5% {'PASS' if abs(dev_an) <= 0.05 else 'FAIL'}")
        print()
        print("两个都必须报，因为只有 A 把「约束」这一件事隔离出来：")
        print("  A 的差别只有函数形式（Arps 双曲 vs 指数），参数都逐井拟合于同一段事件前历史；")
        print(f"  B 的差别还叠了「逐井拟合 vs 池化档位」，Arps 赢的那 {abs(dev_an) * 100:.1f}% 主要来自信息集，")
        print("    不能记在约束头上——真要归因，得把 ANBM 也改成逐井，那是另一个模型。")
        print()
        print(f"ANBM 曲线非单调：{nm['nonmono']}/{nm['n']} 井 = {nm['nonmono'] / nm['n']:.0%}；"
              f"最夸张 {nm['worst'][0]} 单月涨 {nm['worst'][1]:.2f} 倍")
        print(f"  该井 ANBM 曲线（m³/d）：{nm['worst'][2]}")
        print("  对比 Arps 同井曲线：单调递减，12 个月内不会回头")
        print("=" * 84)

        # 分组 MAE（D-038③）：贴边井与内点井分开报，否则 1.9318 不可解释
        def sub_mae(ids):
            prs = []
            for api8 in ids:
                ev = events[api8]
                p = params[api8]
                shift = p.get("t_last", 0) + 1
                for k, o in enumerate([x for x in series[api8]
                                       if ev.mi <= x.mi < ev.mi + HORIZON], 1):
                    prs.append((o.rate, forecast(p, k, shift)))
            return SP.metrics(prs) if prs else {"MAE": float("nan"), "n": 0}

        inner_ids, bind_ids, fb_ids = [], [], []
        for api8, p in params.items():
            if p.get("fallback"):
                fb_ids.append(api8)
            elif p["b"] <= 1e-9 or p["b"] >= 0.999 or p["di"] >= 0.599:
                bind_ids.append(api8)
            else:
                inner_ids.append(api8)
        g_inner, g_bind = sub_mae(inner_ids), sub_mae(bind_ids)
        print(f"分组 MAE：内点 {len(inner_ids)} 井 {g_inner['MAE']:.4f}（n={g_inner['n']}）"
              f" · 贴边 {len(bind_ids)} 井 {g_bind['MAE']:.4f}（n={g_bind['n']}）"
              f" · 降级 {len(fb_ids)} 井（不参与参数解释）")
        print()

        vs = vs_template(wells, params, events)
        print()

        os.makedirs(OUT_DIR, exist_ok=True)
        out = {"schema": "arps/1.0",
               "params": {k: {kk: vv for kk, vv in v.items() if kk != "t_last"}
                          for k, v in params.items()},
               "eval": {k: v for k, v in res.items() if k != "n"},
               "anbm_mae": anbm_mae, "mae_dev_vs_anbm": dev_an,
               "mae_dev_vs_m1": dev_m1,
               "nonmono": {"n": nm["n"], "nonmono": nm["nonmono"],
                           "worst_well": nm["worst"][0],
                           "worst_ratio": nm["worst"][1]},
               "asserts_ok": ok,
               "binding": {"n_fit": len(fit_p_all := [v for v in params.values()
                                                     if not v.get("fallback")]),
                           "n_fallback": len(fb_ids),
                           "n_inner": len(inner_ids), "n_binding": len(bind_ids),
                           "b_binding": sum(1 for v in fit_p_all
                                            if v["b"] <= 1e-9 or v["b"] >= 0.999),
                           "di_binding": sum(1 for v in fit_p_all if v["di"] >= 0.599)},
               "vs_template": vs,
               "mae_inner": g_inner["MAE"], "mae_binding": g_bind["MAE"],
               "n_inner_cells": g_inner["n"], "n_binding_cells": g_bind["n"]}
        path = os.path.join(OUT_DIR, "arps.json")
        json.dump(out, open(path, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
        print(f"已写出 {path}")


if __name__ == "__main__":
    main()
