#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
P3 探索 · 零产判别加井史时序特征（一步滚动信息集）

背景：32 组静态特征组合折外最高仅 +3.17%（门槛 10%）。
假设：零产有强自相关（井停产往往持续多月），上月是否零产 / 连续零产
      长度 / 窗口内累计零产，都应在预测 t 月时可知（信息集 = ≤ t−1 实际值，
      与 m2 persistence、T13 一步滚动同口径）。

本脚本只探索、不写任何交付件：
  1) 零产模式统计（转移概率、streak 分布）
  2) Markov 基线（按 population 分层，折内估转移概率）
  3) 逻辑回归：静态5特征（现状复刻） vs 静态+时序，同折外协议对比
  4) Brier 改善按双口径报（脚本基率 p(1-p) 与常数模型）
"""
import os
import sys
import json
import math
import random
import statistics as st
import collections

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
BUNDLE = os.path.join(ROOT, "frontend", "src", "data", "bundle_v3.json")
SEED = 20260101
N_FOLD = 5


def load():
    with open(BUNDLE, "r", encoding="utf-8") as f:
        b = json.load(f)
    cv = {c["well_id"]: c for c in b["curves"]}
    import csv
    P = os.path.join(ROOT, "..", "04_数据", "原始数据")
    if not os.path.isdir(P):
        P = os.path.join(ROOT, "09_开源数据平替", "reports",
                         "cogis_pilot_run_40479938455", "pilot")
    ev = {}
    for r in csv.DictReader(open(os.path.join(P, "pilot_events_v2c.csv"),
                                 encoding="utf-8")):
        ev["CO" + r["api8"]] = r
    obs, wells = [], {}
    for w in b["wells"]:
        wid = w["well_id"]
        c = cv[wid]
        e = ev.get(wid, {})
        ys = [c["actual"][i]["oil"] or 0.0 for i in range(12)]
        wells[wid] = {
            "population": w["population"], "anchor": w["anchor"],
            "pre_nz": float(e.get("pre_nz") or 0),
            "D_fit": float(e.get("D_fit") or 0),
            "form5a_seq": float(e.get("form5a_seq") or 0),
            "pre_slope": float(e.get("pre_slope") or 0),
            "ys": ys,
        }
        for i in range(12):
            obs.append({"well_id": wid, "t": i + 1, "y": ys[i],
                        "is_zero": 1 if ys[i] == 0 else 0,
                        "population": w["population"],
                        "yhat": c["prediction"][i]["oil"] or 0.0})
    return b, wells, obs


# ---------- 时序特征：预测 t 月时只用 ≤ t−1 的实际值 ----------
def seq_feats(w, t):
    ys = w["ys"]
    prev_zero = 1.0 if (t >= 2 and ys[t - 2] == 0) else 0.0
    # t=1 无窗口内历史，prev_zero 记 0.5（未知）——靠截距吸收，另给 t_norm 区分
    if t == 1:
        prev_zero = 0.5
    streak = 0
    if t >= 2:
        for k in range(t - 2, -1, -1):
            if ys[k] == 0:
                streak += 1
            else:
                break
    cum_zero = sum(1 for k in range(t - 1) if ys[k] == 0) if t >= 2 else 0
    last_pos = 0.0
    if t >= 2:
        for k in range(t - 2, -1, -1):
            if ys[k] > 0:
                last_pos = ys[k]
                break
    months_since_pos = t - 1
    if t >= 2:
        for k in range(t - 2, -1, -1):
            if ys[k] > 0:
                months_since_pos = t - 1 - (k + 1)
                break
    return {
        "prev_zero": prev_zero,
        "streak": min(streak, 6) / 6.0,
        "cum_zero": cum_zero / 12.0,
        "log_last_pos": math.log1p(last_pos),
        "msp": months_since_pos / 12.0,
    }


def static_feats(w, t):
    return [math.log1p(max(w["anchor"], 0.0)), math.log1p(w["pre_nz"]),
            w["D_fit"], math.log1p(w["form5a_seq"]), t / 12.0]


def featurize(mode, o, wells):
    w = wells[o["well_id"]]
    s = seq_feats(w, o["t"])
    if mode == "seq_only":
        return [s["prev_zero"], s["streak"], s["cum_zero"],
                s["log_last_pos"], s["msp"], o["t"] / 12.0]
    if mode == "static+seq":
        return static_feats(w, o["t"]) + [
            s["prev_zero"], s["streak"], s["cum_zero"],
            s["log_last_pos"], s["msp"]]
    if mode == "static5":      # 现状复刻
        return static_feats(w, o["t"])
    if mode == "min_seq":     # 最小可辩护集
        return [s["prev_zero"], s["streak"], o["t"] / 12.0]
    raise ValueError(mode)


def standardize(rows):
    n, p = len(rows), len(rows[0])
    mu = [sum(r[j] for r in rows) / n for j in range(p)]
    sd = [math.sqrt(sum((r[j] - mu[j]) ** 2 for r in rows) / n) or 1.0
          for j in range(p)]
    return [[(r[j] - mu[j]) / sd[j] for j in range(p)] for r in rows], mu, sd


def _sig(z):
    if z > 30:
        return 1.0
    if z < -30:
        return 0.0
    return 1.0 / (1.0 + math.exp(-z))


def logistic_fit(X, y, l2=0.05, lr=0.6, iters=2500, tol=1e-8):
    n, p = len(X), len(X[0])
    w, b = [0.0] * p, 0.0
    prev = float("inf")
    for _ in range(iters):
        gw, gb, loss = [0.0] * p, 0.0, 0.0
        for i in range(n):
            pr = _sig(b + sum(w[j] * X[i][j] for j in range(p)))
            e = pr - y[i]
            for j in range(p):
                gw[j] += e * X[i][j]
            gb += e
            eps = 1e-12
            loss -= y[i] * math.log(pr + eps) + (1 - y[i]) * math.log(1 - pr + eps)
        for j in range(p):
            w[j] -= lr * (gw[j] / n + l2 * w[j])
        b -= lr * gb / n
        if abs(prev - loss) < tol:
            break
        prev = loss
    return w, b


def logistic_pred(X, w, b):
    return [_sig(b + sum(w[j] * X[i][j] for j in range(len(w))))
            for i in range(len(X))]


def make_folds(well_ids, k, seed):
    ids = sorted(well_ids)
    rng = random.Random(seed)
    rng.shuffle(ids)
    folds = [[] for _ in range(k)]
    for i, wid in enumerate(ids):
        folds[i % k].append(wid)
    return folds


def main():
    b, wells, obs = load()
    n_z = sum(o["is_zero"] for o in obs)
    p_base = n_z / len(obs)
    print(f"观测 {len(obs)} / 井 {len(wells)}，零产 {n_z} 条，零产率 {p_base:.4f}")
    print(f"脚本基率 Brier p(1−p) = {p_base*(1-p_base):.4f}")

    # ---------- 1) 零产模式统计 ----------
    trans = collections.Counter()
    streaks = []
    for w in wells.values():
        ys = w["ys"]
        for t in range(1, 12):
            trans[(ys[t - 1] == 0, ys[t] == 0)] += 1
        s = 0
        for y in ys:
            if y == 0:
                s += 1
            else:
                if s:
                    streaks.append(s)
                s = 0
        if s:
            streaks.append(s)
    n00 = trans[(True, True)]
    n01 = trans[(True, False)]
    n10 = trans[(False, True)]
    n11 = trans[(False, False)]
    print("\n[1] 窗口内相邻月转移（924−77=847 对）")
    print(f"  P(z_t=1 | z_{{t-1}}=1) = {n00}/{n00+n01} = {n00/(n00+n01):.3f}")
    print(f"  P(z_t=1 | z_{{t-1}}=0) = {n10}/{n10+n11} = {n10/(n10+n11):.3f}")
    print(f"  零产 streak 长度分布: "
          f"1:{sum(1 for s in streaks if s==1)} "
          f"2-3:{sum(1 for s in streaks if 2<=s<=3)} "
          f"4-6:{sum(1 for s in streaks if 4<=s<=6)} "
          f">6:{sum(1 for s in streaks if s>6)}  (共 {len(streaks)} 段)")

    folds = make_folds(list(wells), N_FOLD, SEED)
    by_well = collections.defaultdict(list)
    for o in obs:
        by_well[o["well_id"]].append(o)

    # 常数模型基线（同折重训：每折训练集零产率）
    brier_const = 0.0
    for fi, te in enumerate(folds):
        tr = {wid: wells[wid] for wid in wells if wid not in te}
        pr = sum(1 for w in tr.values() for y in w["ys"] if y == 0) / (len(tr) * 12)
        for wid in te:
            for o in by_well[wid]:
                brier_const += (pr - o["is_zero"]) ** 2
    brier_const /= len(obs)
    print(f"\n常数模型（同折重训）Brier = {brier_const:.4f}")

    # ---------- 2) Markov 基线 ----------
    markov_sq = 0.0
    for fi, te in enumerate(folds):
        tr = {wid: wells[wid] for wid in wells if wid not in te}
        cnt = collections.Counter()
        for w in tr.values():
            ys = w["ys"]
            for t in range(1, 12):
                cnt[(w["population"], ys[t - 1] == 0, ys[t] == 0)] += 1
            # t=1 用窗口内不可得 → 用全局零产率（按 population）
            cnt[("T1", w["population"], ys[0] == 0)] += 1
        # t=1 逻辑单独估
        for wid in te:
            w = wells[wid]
            ys = w["ys"]
            # t=1: population 零产率
            n1 = sum(cnt[("T1", pop, True)] for pop in ("PR", "SI"))
            d1 = n1 + sum(cnt[("T1", pop, False)] for pop in ("PR", "SI"))
            p_t1 = (cnt[("T1", w["population"], True)] /
                    (cnt[("T1", w["population"], True)] +
                     cnt[("T1", w["population"], False)])) if d1 else p_base
            markov_sq += (p_t1 - (1 if ys[0] == 0 else 0)) ** 2
            for t in range(1, 12):
                key = (w["population"], ys[t - 1] == 0, True)
                a = cnt[key]
                bb = cnt[(w["population"], ys[t - 1] == 0, True)] + \
                     cnt[(w["population"], ys[t - 1] == 0, False)]
                pr = a / bb if bb else p_base
                markov_sq += (pr - (1 if ys[t] == 0 else 0)) ** 2
    markov = markov_sq / len(obs)
    print(f"[2] Markov 基线（population 分层、折内估转移、t=1 用群零产率）"
          f" Brier = {markov:.4f}  → 改善 vs 基率 "
          f"{(p_base*(1-p_base)-markov)/(p_base*(1-p_base)):+.2%} / "
          f"vs 常数 {(brier_const-markov)/brier_const:+.2%}")

    # ---------- 3) 逻辑回归对比 ----------
    print("\n[3] 逻辑回归（5 折按井 OOF，PR/SI 分层训练，L2=0.05）")
    print(f"{'特征集':<12}{'Brier':>8}{'vs基率':>9}{'vs常数':>9}")
    for mode in ("static5", "min_seq", "seq_only", "static+seq"):
        sq = 0.0
        for fi, te in enumerate(folds):
            tr_set = set(w for w in wells if w not in te)
            for pop in ("PR", "SI"):
                trp = [o for o in obs if o["well_id"] in tr_set
                       and o["population"] == pop]
                tep = [o for o in obs if o["well_id"] in set(te)
                       and o["population"] == pop]
                if not trp or not tep:
                    continue
                Xtr_raw = [featurize(mode, o, wells) for o in trp]
                Xte_raw = [featurize(mode, o, wells) for o in tep]
                Xtr, mu, sd = standardize(Xtr_raw)
                Xte = [[(r[j] - mu[j]) / sd[j] for j in range(len(r))]
                       for r in Xte_raw]
                w_, bias = logistic_fit(Xtr, [o["is_zero"] for o in trp])
                for o, pr in zip(tep, logistic_pred(Xte, w_, bias)):
                    sq += (pr - o["is_zero"]) ** 2
        br = sq / len(obs)
        print(f"{mode:<12}{br:>8.4f}"
              f"{(p_base*(1-p_base)-br)/(p_base*(1-p_base)):>+8.2%}"
              f"{(brier_const-br)/brier_const:>+8.2%}")

    print("\n[4] 阶梯验证：时序特征若只能在训练井上学权重、测试井的 y_{{t-1}} 也是 OOF 可得，"
          "无泄漏路径。上表若 static+seq ≥ 10% 即值得整合。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
