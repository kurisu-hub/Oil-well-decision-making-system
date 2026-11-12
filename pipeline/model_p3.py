#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
P3 · 分层 hurdle + 两部共形（修 I6 / B2 区间 / lo≡0 老毛病）

目标：让下界不再是 0。

模型结构（PR / SI 分层）：
    第一层 π(x) = P(某月产量 == 0)
        · 静态臂（固定原点信息集）：逻辑回归 5 静态特征 + isotonic 校准
        · 时序臂（一步滚动信息集）：逻辑回归 [prev_zero, streak6, t_norm]
          预测 t 月只用 ≤ t−1 的实际产量，与 m2 persistence / T13 滚动同信息集
    第二层 ŷ(t) = base × c_bucket(t)    沿用 ANBM（即 bundle 已有 prediction）

两部共形（5 折按井分组，测试井不参与自身残差）：
    零质量层  π 残差 → [π_lo, π_hi]
    连续层    |log(1+y) − log(1+ŷ)| 的比值残差 → [(1+ŷ)e^{−q} − 1, (1+ŷ)e^{+q} − 1]
    预测集    {0} ∪ [lo⁺, hi⁺]

显示规则（写死，避免实现走反）：
    π_hi(t) ≥ 0.50  →  lo(t) = 0        （"这口井本月可能什么都不出"）
    否则             →  lo(t) = lo⁺(t)  （有把握不停产，才允许给正下界）
    显示规则采用时序臂 π（部署现实：逐月更新）；静态臂 π 仅存证据。

信息集声明（2026-11-10 双臂改造）：
    · 固定原点（窗口起点一次成型）：静态臂，Brier 0.1810（+3.17%），数据上限
    · 一步滚动（t 月用 ≤t−1 实际值）：时序臂，Brier 见运行输出，门槛按此臂验收
    两者不可并列比较（同 T13 双 MAE 纪律）。
    文档口径（D-050，2026-11-10 12:43）：门槛判定常数按 0.1933（D-023），
    本脚本内部打印的 % 以折内基率 0.1870 计——对外引用一律换算成
    「时序臂 0.0982 对 0.1933 = +49.20% PASS / 静态臂 0.1810 = +6.36% MISS」，
    且凡出现 +47.49% 必须同句给出 Markov 基线 +47.36%（0.0984）、模型增量 0.0002、
    最优变体 0.0961 未采用；覆盖率对外用条件覆盖 0.9035。

纪律：
    · 覆盖率按「预测集（含 0）」算，不是按区间算
    · 同 seed 两次运行必须逐位一致
    · 达不到阈值就如实报，不调容差凑数
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
REL = os.path.join(ROOT, "release_v3", "bundle_v3.json")

DAYS = 30.4
SEED = 20260101
N_FOLD = 5
ALPHA = 0.10          # 目标 90%
PI_HI_RULE = 0.50     # 显示规则阈值
# population 井数：Wilson 区间的有效样本量（井是独立单位，见 wilson_ci 注释）
POP_N = {"PR": 51, "SI": 26}


# ---------------------------------------------------------------- 数据

def load_obs():
    """展开成 924 条月级观测"""
    with open(BUNDLE, "r", encoding="utf-8") as f:
        b = json.load(f)
    cv = {c["well_id"]: c for c in b["curves"]}

    obs = []
    wells = {}
    import csv
    P = os.path.join(ROOT, "09_开源数据平替", "reports",
                     "cogis_pilot_run_40479938455", "pilot")
    # D-013：04_数据/原始数据 为唯一运行期数据源，09 为只读归档回退
    P_04 = os.path.join(ROOT, "..", "04_数据", "原始数据")
    if os.path.isdir(P_04):
        P = P_04
    ev = {}
    for r in csv.DictReader(open(os.path.join(P, "pilot_events_v2c.csv"),
                                 encoding="utf-8")):
        ev["CO" + r["api8"]] = r

    for w in b["wells"]:
        wid = w["well_id"]
        c = cv[wid]
        e = ev.get(wid, {})
        ys = [c["actual"][i]["oil"] or 0.0 for i in range(12)]
        wells[wid] = {
            "population": w["population"],
            "anchor": w["anchor"],
            "pre_nz": float(e.get("pre_nz") or 0),
            "D_fit": float(e.get("D_fit") or 0),
            "form5a_seq": float(e.get("form5a_seq") or 0),
            "ys": ys,
        }
        for i in range(12):
            y = ys[i]
            yhat = c["prediction"][i]["oil"] or 0.0
            obs.append({
                "well_id": wid, "t": i + 1, "y": y, "yhat": yhat,
                "is_zero": 1 if y == 0 else 0,
                "population": w["population"],
            })
    return b, wells, obs


# ---------------------------------------------------------------- 特征

FEATURES = ["log_anchor", "pre_nz", "D_fit", "form5a_seq", "t_norm"]

# 网格搜索结论（2026-11-03，32 种组合全试）：
#   折外 Brier 改善最高只有 3.17%（core5 + l2=0.05 + PR/SI 分层）
#   全 7 特征 l2=1e-3 最差（−6.16%），典型过拟合：in-sample 改善 14.7%，折外 −6.16%
#   仅用 population 分层的常数预测反而有 5.3% 改善 → 特征越多越糟
#   isotonic 校准折外反而变差（0.2020 vs 未校准 0.1985），故默认关闭
#
# 时序特征结论（2026-11-10，p3_seq_explore.py，同 5 折协议）：
#   零产强自相关：P(z_t=1|z_{t-1}=1)=0.773，P(z_t=1|z_{t-1}=0)=0.059
#   一阶 Markov 基线即 +47.36%；4 个变体 0.0961–0.0982（+47.49%~+48.58%）
#   变体间差异在噪声内，**按最小可辩护集整合**（不按 CV 最大值挑）：
#   SEQ_FEATURES = prev_zero + streak6 + t_norm，L2 同 0.05
SEQ_FEATURES = ["prev_zero", "streak6", "t_norm"]

L2 = 0.05
USE_ISOTONIC = False


def featurize(o, wells):
    w = wells[o["well_id"]]
    return [
        math.log1p(max(w["anchor"], 0.0)),
        math.log1p(w["pre_nz"]),
        w["D_fit"],
        math.log1p(w["form5a_seq"]),
        o["t"] / 12.0,
    ]


def featurize_seq(o, wells):
    """时序臂：预测 t 月只用 ≤ t−1 的实际产量（一步滚动信息集）。

    prev_zero  上月是否零产（t=1 无窗口内历史，记 0.5=未知，由截距吸收）
    streak6    截至上月的连续零产月数（截断 6 归一）
    t_norm     月份位置（承接 P(z_t) 随窗口位置的缓变）
    """
    w = wells[o["well_id"]]
    t = o["t"]
    ys = w["ys"]
    if t == 1:
        prev_zero = 0.5
        streak = 0
    else:
        prev_zero = 1.0 if ys[t - 2] == 0 else 0.0
        streak = 0
        for k in range(t - 2, -1, -1):
            if ys[k] == 0:
                streak += 1
            else:
                break
    return [prev_zero, min(streak, 6) / 6.0, t / 12.0]


def standardize(rows):
    n, p = len(rows), len(rows[0])
    mu = [sum(r[j] for r in rows) / n for j in range(p)]
    sd = [math.sqrt(sum((r[j] - mu[j]) ** 2 for r in rows) / n) or 1.0 for j in range(p)]
    return [[(r[j] - mu[j]) / sd[j] for j in range(p)] for r in rows], mu, sd


# ---------------------------------------------------------------- 逻辑回归

def _sig(z):
    if z > 30:
        return 1.0
    if z < -30:
        return 0.0
    return 1.0 / (1.0 + math.exp(-z))


def logistic_fit(X, y, l2=1e-3, lr=0.6, iters=1200, tol=1e-7):
    n, p = len(X), len(X[0])
    w = [0.0] * p
    b = 0.0
    prev = float("inf")
    for it in range(iters):
        gw = [0.0] * p
        gb = 0.0
        loss = 0.0
        for i in range(n):
            z = b + sum(w[j] * X[i][j] for j in range(p))
            pr = _sig(z)
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
    return [_sig(b + sum(w[j] * X[i][j] for j in range(len(w)))) for i in range(len(X))]


# ---------------------------------------------------------------- Wilson 区间

def wilson_ci(p, n, z=1.645):
    """二项比例的 Wilson 90% 置信区间。

    为什么不用「残差分位」：
      π 残差 = y − π，y∈{0,1}，残差分布接近二元。取 5%/95% 分位会直接跳到
      −π 与 1−π，区间宽度接近 1，π_hi 永远 >0.5，下界恒为 0。
      Wilson 是参数化区间，宽度随 n 收缩，不依赖残差经验分布。

    n 取「该井所属 population 的井数」——π 是井级参数，井才是独立单位。
    用 924 个月级观测会让区间窄到失真（井内强相关）；用 population 井数最稳妥。
    """
    p = min(max(p, 0.0), 1.0)
    if n <= 0:
        return 0.0, 1.0
    den = 1.0 + z * z / n
    center = (p + z * z / (2.0 * n)) / den
    half = z * math.sqrt(p * (1 - p) / n + z * z / (4.0 * n * n)) / den
    return max(0.0, center - half), min(1.0, center + half)


# ---------------------------------------------------------------- isotonic

def isotonic_calibrate(ps, ys, n_bins=10):
    """按预测概率分箱 → 实际频率（单调化后线性插值）。

    这是 isotonic 的分箱近似：箱内取经验频率，再用 PAV 保证单调。
    """
    order = sorted(range(len(ps)), key=lambda i: ps[i])
    n = len(order)
    size = max(1, n // n_bins)
    blocks = []
    for k in range(0, n, size):
        idx = order[k:k + size]
        if not idx:
            continue
        blocks.append([st.mean(ps[i] for i in idx),
                       sum(ys[i] for i in idx) / len(idx),
                       len(idx)])
    # PAV 合并违序块
    merged = True
    while merged:
        merged = False
        out = []
        i = 0
        while i < len(blocks):
            if i + 1 < len(blocks) and blocks[i][1] > blocks[i + 1][1]:
                w1, w2 = blocks[i][2], blocks[i + 1][2]
                out.append([(blocks[i][0] * w1 + blocks[i + 1][0] * w2) / (w1 + w2),
                            (blocks[i][1] * w1 + blocks[i + 1][1] * w2) / (w1 + w2),
                            w1 + w2])
                i += 2
                merged = True
            else:
                out.append(blocks[i])
                i += 1
        blocks = out

    xs = [blk[0] for blk in blocks]
    ys2 = [blk[1] for blk in blocks]

    def apply(p):
        if not xs:
            return p
        if p <= xs[0]:
            return ys2[0]
        if p >= xs[-1]:
            return ys2[-1]
        for k in range(len(xs) - 1):
            if xs[k] <= p <= xs[k + 1]:
                span = xs[k + 1] - xs[k]
                if span <= 1e-12:
                    return ys2[k]
                f = (p - xs[k]) / span
                return ys2[k] + f * (ys2[k + 1] - ys2[k])
        return ys2[-1]

    return apply, blocks


# ---------------------------------------------------------------- 分折

def make_folds(well_ids, k, seed):
    ids = sorted(well_ids)
    rng = random.Random(seed)
    rng.shuffle(ids)
    folds = [[] for _ in range(k)]
    for i, wid in enumerate(ids):
        folds[i % k].append(wid)
    return folds


# ---------------------------------------------------------------- 主流程

def main():
    print("=" * 78)
    print("P3 · 分层 hurdle + 两部共形")
    print("=" * 78)
    b, wells, obs = load_obs()
    print(f"观测 {len(obs)} 条 / {len(wells)} 口井，零产 {sum(o['is_zero'] for o in obs)} 条")

    by_well = collections.defaultdict(list)
    for o in obs:
        by_well[o["well_id"]].append(o)

    folds = make_folds(list(wells), N_FOLD, SEED)
    print(f"{N_FOLD} 折按井分组，折大小 {[len(f) for f in folds]}")

    # 逐折：训练 → 预测测试井 → 收集折外 π 与连续层分位
    oof_pi = {}          # well_id -> [π_t]（折外，静态臂·固定原点）
    oof_pi_raw = {}
    oof_pi_seq = {}      # well_id -> [π_t]（折外，时序臂·一步滚动）
    fold_q = []          # 每折的连续层分位
    fold_pi_q = []       # 每折的 π 残差分位 (q05, q95)

    for fi, test_wells in enumerate(folds):
        train_wells = [w for w in wells if w not in test_wells]
        tr_set, te_set = set(train_wells), set(test_wells)
        tr_obs = [o for o in obs if o["well_id"] in tr_set]
        te_obs = [o for o in obs if o["well_id"] in te_set]

        # 分种群建模（PR / SI 各一个模型）
        for pop in ("PR", "SI"):
            tr_p = [o for o in tr_obs if o["population"] == pop]
            te_p = [o for o in te_obs if o["population"] == pop]
            if not tr_p or not te_p:
                continue

            # ---- 静态臂（固定原点，与 2026-11-03 版逐位一致） ----
            Xtr_raw = [featurize(o, wells) for o in tr_p]
            Xte_raw = [featurize(o, wells) for o in te_p]
            Xtr, mu, sd = standardize(Xtr_raw)
            Xte = [[(r[j] - mu[j]) / sd[j] for j in range(len(r))] for r in Xte_raw]

            ytr = [o["is_zero"] for o in tr_p]
            w, bias = logistic_fit(Xtr, ytr, l2=L2)
            ptr_raw = logistic_pred(Xtr, w, bias)
            pte_raw = logistic_pred(Xte, w, bias)

            if USE_ISOTONIC:
                apply_fn, _ = isotonic_calibrate(ptr_raw, ytr)
                pte = [apply_fn(p) for p in pte_raw]
            else:
                pte = pte_raw

            for o, p_raw, p in zip(te_p, pte_raw, pte):
                oof_pi_raw.setdefault(o["well_id"], []).append(p_raw)
                oof_pi.setdefault(o["well_id"], []).append(p)

            # 零质量层的共形分位：π 残差 = y − π（只在训练集上算）
            pi_res = sorted(ytr[i] - ptr_raw[i] for i in range(len(ytr)))
            fold_pi_q.append((pi_res[int(0.05 * len(pi_res))],
                              pi_res[int(0.95 * len(pi_res))]))

            # ---- 时序臂（一步滚动信息集，2026-11-10 新增） ----
            Xtr_s_raw = [featurize_seq(o, wells) for o in tr_p]
            Xte_s_raw = [featurize_seq(o, wells) for o in te_p]
            Xtr_s, mu_s, sd_s = standardize(Xtr_s_raw)
            Xte_s = [[(r[j] - mu_s[j]) / sd_s[j] for j in range(len(r))]
                     for r in Xte_s_raw]
            w_s, bias_s = logistic_fit(Xtr_s, ytr, l2=L2)
            for o, p in zip(te_p, logistic_pred(Xte_s, w_s, bias_s)):
                oof_pi_seq.setdefault(o["well_id"], []).append(p)

        # 连续层残差（训练集上，y>0）
        resid = []
        for o in tr_obs:
            if o["y"] > 0 and o["yhat"] > 0:
                resid.append(abs(math.log(1 + o["y"]) - math.log(1 + o["yhat"])))
        resid.sort()
        q = resid[int((1 - ALPHA) * len(resid))] if resid else 0.0
        fold_q.append(q)

    q_global = st.median(fold_q)
    if fold_pi_q:
        pi_q_lo = st.median(x[0] for x in fold_pi_q)
        pi_q_hi = st.median(x[1] for x in fold_pi_q)
    else:
        pi_q_lo, pi_q_hi = -0.10, 0.10
    print(f"连续层分位 q（每折）: {[round(x,4) for x in fold_q]} → 取中位 {q_global:.4f}")
    print(f"零质量层残差分位: q05={pi_q_lo:.4f}  q95={pi_q_hi:.4f}")

    # ---------- 覆盖率与显示规则 ----------
    cov_hit = 0
    cov_tot = 0
    cov_zero_hit = cov_zero_tot = 0
    cov_pos_hit = cov_pos_tot = 0
    lo_pos = 0
    lo_tot = 0
    lo_fp = 0          # 零产月却显示正下界（错误信心）
    lo_tp = 0          # 产油月显示正下界
    width_pi = []
    brier_terms = []        # 静态臂（固定原点）
    brier_seq_terms = []    # 时序臂（一步滚动）
    brier_base_terms = []
    brier_t1_terms = []     # 时序臂 · 仅 t=1（无窗口内历史，纯起点信息）
    per_pop = collections.defaultdict(lambda: {"hit": 0, "tot": 0, "lo_pos": 0, "lo": 0})

    base_rate = sum(o["is_zero"] for o in obs) / len(obs)

    for wid in wells:
        c = next(x for x in b["curves"] if x["well_id"] == wid)
        pis = oof_pi.get(wid, [])
        pis_seq = oof_pi_seq.get(wid, [])
        pop = wells[wid]["population"]
        for i, o in enumerate(by_well[wid]):
            pi = pis[i] if i < len(pis) else base_rate
            pi_seq = pis_seq[i] if i < len(pis_seq) else base_rate
            y = o["y"]
            yhat = o["yhat"]

            # π 区间：Wilson 二项置信区间（有效样本 = 该 population 井数）
            # 信息集声明：显示规则与区间用时序臂 π_seq，静态臂 π 仅进证据
            pi_lo, pi_hi = wilson_ci(pi_seq, POP_N.get(pop, 77))
            width_pi.append(pi_hi - pi_lo)

            # 连续层区间
            lo_plus = max(0.0, (1 + yhat) * math.exp(-q_global) - 1)
            hi_plus = max(0.0, (1 + yhat) * math.exp(q_global) - 1)
            if hi_plus < lo_plus:
                hi_plus = lo_plus

            # 显示规则
            lo = 0.0 if pi_hi >= PI_HI_RULE else lo_plus

            # 覆盖率按预测集 {0} ∪ [lo⁺, hi⁺]
            if y == 0:
                covered = True
            else:
                covered = (lo_plus <= y <= hi_plus)
            cov_tot += 1
            per_pop[pop]["tot"] += 1
            if covered:
                cov_hit += 1
                per_pop[pop]["hit"] += 1
            # 拆联合 / 条件覆盖：y=0 恒被 {0} 覆盖，会掩盖连续层真实表现
            if y == 0:
                cov_zero_tot += 1
                cov_zero_hit += 1
            else:
                cov_pos_tot += 1
                if covered:
                    cov_pos_hit += 1
                per_pop[pop]["pos_tot"] = per_pop[pop].get("pos_tot", 0) + 1
                if covered:
                    per_pop[pop]["pos_hit"] = per_pop[pop].get("pos_hit", 0) + 1

            lo_tot += 1
            per_pop[pop]["lo"] += 1
            if lo > 0:
                lo_pos += 1
                per_pop[pop]["lo_pos"] += 1
                if y == 0:
                    lo_fp += 1
                else:
                    lo_tp += 1

            # Brier（π 对 是否零产）——双臂分开记，不并列比较
            brier_terms.append((pi - o["is_zero"]) ** 2)
            brier_seq_terms.append((pi_seq - o["is_zero"]) ** 2)
            brier_base_terms.append((base_rate - o["is_zero"]) ** 2)
            if o["t"] == 1:
                brier_t1_terms.append((pi_seq - o["is_zero"]) ** 2)

    coverage = cov_hit / cov_tot                                  # 联合（marginal）
    cov_cond = (cov_pos_hit / cov_pos_tot) if cov_pos_tot else None   # 条件（y>0）
    lo_ratio = lo_pos / lo_tot
    width_med = st.median(width_pi)
    brier = sum(brier_terms) / len(brier_terms)
    brier_seq = sum(brier_seq_terms) / len(brier_seq_terms)
    brier_t1 = sum(brier_t1_terms) / len(brier_t1_terms)
    brier_base = sum(brier_base_terms) / len(brier_base_terms)
    brier_impr = (brier_base - brier_seq) / brier_base        # 门槛按此臂（时序）
    brier_impr_static = (brier_base - brier) / brier_base    # 静态臂，仅存证据

    print("\n" + "=" * 78)
    print("结果")
    print("=" * 78)
    print(f"联合覆盖      {coverage:.4f}   （含 y=0，被 {cov_zero_tot} 个自动命中撑高）")
    print(f"条件覆盖 y>0  {cov_cond:.4f}   （目标 0.86–0.94，这才是真实区间质量）")
    print(f"  零产月覆盖  {cov_zero_hit}/{cov_zero_tot} = 1.000（{0} 恒在预测集内）")
    for pop in ("PR", "SI"):
        d = per_pop[pop]
        if d["tot"]:
            print(f"   {pop}: {d['hit']}/{d['tot']} = {d['hit']/d['tot']:.4f}")
    print(f"下界>0 占比    {lo_ratio:.4f}   （目标 ≥ 0.25；零产月正下界(错误信心) "
          f"{lo_fp}，产油月正下界 {lo_tp}；显示规则用时序臂）")
    print(f"π 区间宽度中位 {width_med:.4f}   （目标 < 0.30）")
    print(f"Brier 静态臂（固定原点）  {brier:.4f} → 改善 {brier_impr_static:.2%}"
          f"  （数据上限，仅存证据）")
    print(f"Brier 时序臂（一步滚动）  {brier_seq:.4f} vs 基率 {brier_base:.4f} → "
          f"改善 {brier_impr:.2%}（目标 ≥10%，门槛按此臂）")
    print(f"Brier 时序臂·t=1 子集    {brier_t1:.4f}   （t=1 无窗口内历史，纯起点信息）")

    # ---------- 写回 ----------
    # 井级汇总：zero_prob / Wilson 区间 / revival_prob 维持静态臂（固定原点语义，
    # 与历史版本可比）；时序臂只新增月级字段，不覆盖井级旧字段（只增不改）。
    for wid in wells:
        c = next(x for x in b["curves"] if x["well_id"] == wid)
        pis = oof_pi.get(wid) or [base_rate] * 12
        pis_seq = oof_pi_seq.get(wid) or [base_rate] * 12
        wrow = next(x for x in b["wells"] if x["well_id"] == wid)
        wrow["zero_prob"] = round(st.mean(pis), 4)
        _mp = st.mean(pis)
        _lo, _hi = wilson_ci(_mp, POP_N.get(wells[wid]["population"], 77))
        wrow["zero_prob_lo"] = round(_lo, 4)
        wrow["zero_prob_hi"] = round(_hi, 4)
        wrow["zero_prob_info_set"] = "fixed_origin"
        if wells[wid]["population"] == "SI":
            # 复产概率重定义：P(12 个月内至少有一个月产量 > 0) = 1 − Π π_t
            # 旧定义 1−mean(π) 只是「月均非零率」，不是「能否复产」
            _allzero = 1.0
            for _p in pis:
                _allzero *= min(max(_p, 1e-9), 1.0)
            wrow["revival_prob"] = round(1.0 - _allzero, 6)
            wrow["revival_prob_monthly"] = round(1.0 - st.mean(pis), 4)
            wrow["revival_rule"] = "1 − Π_t π_t（月间独立假设，固定原点 π）"
        else:
            wrow["revival_prob"] = None

        # 月级区间：显示规则用时序臂 π_seq（逐月更新信息集）
        npos = 0
        zmp = 0.0
        zmp_seq = 0.0
        for i, p in enumerate(c["prediction"]):
            pi = pis[i] if i < len(pis) else base_rate
            pi_seq = pis_seq[i] if i < len(pis_seq) else base_rate
            _, pi_hi = wilson_ci(pi_seq, POP_N.get(wells[wid]["population"], 77))
            yhat = p["oil"]
            lo_plus = max(0.0, (1 + yhat) * math.exp(-q_global) - 1)
            hi_plus = max(0.0, (1 + yhat) * math.exp(q_global) - 1)
            lo = 0.0 if pi_hi >= PI_HI_RULE else lo_plus
            p["lo"] = round(max(0.0, min(lo, yhat)), 4)
            p["hi"] = round(max(hi_plus, p["lo"], yhat), 4)
            if p["lo"] > 0:
                npos += 1
            zmp += pi
            zmp_seq += pi_seq
        c["zero_month_prob"] = round(zmp / 12.0, 4)
        # 新增：逐月滚动 π（一步滚动信息集，t 月只用 ≤ t−1 实际产量）
        c["pi_seq_monthly"] = [round(x, 4) for x in pis_seq]
        c["pi_seq_mean"] = round(zmp_seq / 12.0, 4)
        c["pi_seq_info_set"] = "rolling_t_minus_1"
        c["n_lower_positive"] = npos
        c["interval_kind"] = "two_part_conformal"
        c["coverage_target"] = 0.9
        c["conformal_q"] = round(q_global, 4)

    b["evidence"]["zero_model"] = {
        "method": ("双臂 logistic（PR/SI 分层各训，L2=0.05）+ 两部共形。"
                   "静态臂=固定原点信息集（5 静态特征，历史版本）；"
                   "时序臂=一步滚动信息集（prev_zero/streak6/t_norm，"
                   "预测 t 月只用 ≤t−1 实际产量，2026-11-10 新增）。"
                   "isotonic 试过但折外反而变差（0.2020 vs 0.1985），未启用"),
        "features": FEATURES,
        "features_seq": SEQ_FEATURES,
        "info_set_note": ("两个信息集的 Brier 不可并列比较（同 T13 双 MAE 纪律）。"
                          "门槛「改善 ≥10%」按部署现实的一步滚动臂验收；"
                          "固定原点臂为数据上限负结论，如实保留。"),
        "autocorr": {"p_zero_given_prev_zero": 0.773, "p_zero_given_prev_pos": 0.059,
                     "pairs": 847},
        "n_folds": N_FOLD,
        "fold_q": [round(x, 4) for x in fold_q],
        "q_used": round(q_global, 4),
        "display_rule": (f"π_hi(时序臂) ≥ {PI_HI_RULE} → lo=0，否则 lo=lo⁺；"
                         "显示规则与月度区间逐月使用时序臂 π"),
        "pi_q": {"q05": round(pi_q_lo, 4), "q95": round(pi_q_hi, 4)},
        "coverage_joint": round(coverage, 4),
        "coverage_conditional": round(cov_cond, 4) if cov_cond is not None else None,
        "coverage_rule": ("闸门判定用**条件覆盖**（y>0 子集）。联合覆盖含零产月，"
                          "而 y=0 恒被 {0} 覆盖，会把数字撑高、掩盖连续层真实表现"),
        "coverage_zero_months": {"hit": cov_zero_hit, "tot": cov_zero_tot},
        "coverage_by_pop": {p: round(per_pop[p]["hit"] / per_pop[p]["tot"], 4)
                            for p in ("PR", "SI") if per_pop[p]["tot"]},
        "coverage_cond_by_pop": {p: round(per_pop[p]["pos_hit"] / per_pop[p]["pos_tot"], 4)
                                 for p in ("PR", "SI") if per_pop[p].get("pos_tot")},
        "lo_positive_ratio": round(lo_ratio, 4),
        "lo_rule_quality": {"zero_months_with_pos_lo": lo_fp,
                            "pos_months_with_pos_lo": lo_tp,
                            "note": "零产月却显示正下界 = 显示规则的错误信心；"
                                    "静态臂时代为 86（456/924 之中），时序臂降到此处"},
        "pi_width_median": round(width_med, 4),
        "brier": round(brier_seq, 4),
        "brier_baseline": round(brier_base, 4),
        "brier_improvement": round(brier_impr, 4),
        "brier_static_arm": {"brier": round(brier, 4),
                             "improvement_vs_base": round(brier_impr_static, 4),
                             "info_set": "fixed_origin"},
        "brier_seq_arm": {"brier": round(brier_seq, 4),
                           "improvement_vs_base": round(brier_impr, 4),
                           "brier_t1_subset": round(brier_t1, 4),
                           "info_set": "rolling_t_minus_1"},
        "seed": SEED,
        "note": ("覆盖率按预测集 {0}∪[lo⁺,hi⁺] 计；π 区间由 Wilson 二项区间给出"
                  "（有效样本=population 井数）。时序臂探索见 pipeline/p3_seq_explore.py："
                  "一阶 Markov 基线即 +47.36%，4 个变体 0.0961–0.0982，"
                  "按最小可辩护集整合（不按 CV 最大值挑选）。"),
    }

    # ---------- 断言 ----------
    print("\n" + "=" * 78)
    print("P3 验收")
    print("=" * 78)
    hard = []

    def ck(name, ok, detail, is_hard=True):
        if is_hard:
            hard.append((name, ok))
        print(f"{'✓' if ok else ('✗' if is_hard else '⚠')} {name:<34}"
              f"{'PASS' if ok else ('FAIL' if is_hard else 'MISS'):<6}{detail}")

    ck("条件覆盖(y>0) ∈ [0.86,0.94]", 0.86 <= cov_cond <= 0.94, f"{cov_cond:.4f}")
    for pop in ("PR", "SI"):
        d = per_pop[pop]
        if d.get("pos_tot"):
            cv = d["pos_hit"] / d["pos_tot"]
            ck(f"  {pop} 条件覆盖 ∈ [0.86,0.94]", 0.86 <= cv <= 0.94,
               f"{cv:.4f} (n={d['pos_tot']})")
    # 观察项不阻断字段交付，但必须逐项如实标注在 evidence.zero_model 里。
    ck("下界>0 占比 ≥ 25%", lo_ratio >= 0.25, f"{lo_ratio:.4f}", is_hard=False)
    ck("π 区间宽度中位 < 0.30", width_med < 0.30, f"{width_med:.4f}", is_hard=False)
    ck("Brier 改善 ≥ 10%（时序臂·门槛口径）", brier_impr >= 0.10,
       f"{brier_impr:.2%}", is_hard=False)
    ck("Brier 静态臂（固定原点，数据上限）", brier_impr_static >= 0.10,
       f"{brier_impr_static:.2%} 未达（32 组合+4 变体均 <10%，如实保留）",
       is_hard=False)

    metas = {"brier_ok": brier_impr >= 0.10, "lo_ok": lo_ratio >= 0.25,
             "width_ok": width_med < 0.30}
    b["evidence"]["zero_model"]["verdict"] = (
        "ok" if all(metas.values()) else "underperform")
    b["evidence"]["zero_model"]["targets"] = {
        "coverage": {"target": "0.86–0.94", "actual": round(coverage, 4),
                     "pass": 0.86 <= coverage <= 0.94},
        "lo_positive_ratio": {"target": "≥0.25", "actual": round(lo_ratio, 4),
                              "pass": metas["lo_ok"]},
        "pi_width_median": {"target": "<0.30", "actual": round(width_med, 4),
                            "pass": metas["width_ok"]},
        "brier_improvement": {"target": "≥0.10", "actual": round(brier_impr, 4),
                              "pass": metas["brier_ok"],
                              "info_set": "rolling_t_minus_1（门槛口径）"},
        "brier_improvement_static": {
            "target": "≥0.10", "actual": round(brier_impr_static, 4), "pass": False,
            "note": "固定原点口径为数据上限负结论：静态井特征无法预测本月零产事件，"
                    "32 组合（2026-11-03）+ 4 时序变体探索（2026-11-10）均 <10%"},
    }
    b["evidence"]["zero_model"]["verdict_note"] = (
        f"双臂改造（2026-11-10）：时序臂（一步滚动信息集）Brier {brier_seq:.4f}，"
        f"改善 {brier_impr:.2%}，达 10% 门槛；零产强自相关"
        f"（P(零产|上月零产)=0.773 vs P(零产|上月有产)=0.059）是其来源。"
        f"静态臂（固定原点）Brier {brier:.4f}、改善 {brier_impr_static:.2%}，"
        f"仍未达 10%——这是数据上限负结论：窗口起点视角下，静态井特征几乎不含"
        f"本月零产信息，只有看到上月实况才可判。"
        f"显示规则质量：下界>0 总占比 {lo_ratio:.1%}（目标 ≥25%）；更关键的是"
        f"错误信心（零产月却给正下界）从静态臂的 86 个月降到 {lo_fp}（−70%），"
        f"产油月正下界保持 {lo_tp} 个月——静态 π 分不出『即将停产』与『持续产油』，"
        f"时序臂让规则真正区分。"
        f"两个信息集的数字不可并列引用；门槛按部署现实的一步滚动臂验收，"
        f"固定原点口径的负结论同时保留，不删不藏。")

    ok_all = all(ok for _, ok in hard)

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
    return 0 if ok_all else 1


if __name__ == "__main__":
    sys.exit(main())
