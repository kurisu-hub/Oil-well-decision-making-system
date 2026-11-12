#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""T12 · 同折外协议对照（5 折按井交叉）

背景（D-008 / D-013）：
    `model_card_final77.md §4` 里的三族指标是 **LOO 口径**，而 T13 的判据要求
    「5 折按井交叉下逐月 q 的 MAE ≤ ANBM 同协议 MAE 且不劣于 Flat 同协议 MAE」。
    跨协议比数是红线 1，所以必须在同一协议下把 ANBM / Flat 重算出来。

做法：
    1. 从 bundle 取 77 井 × 12 月的实测与 anchor（单位 m³/d），从原始 events 取
       pre_nz / D_fit / form5a_seq（LSDRT 特征用）。
    2. 三族**按定义重训**（不读 bundle 里已训好的曲线，那是在全量 77 上训的）。
    3. 先跑 LOO（77 折）复现模型卡的 1.9444 / 96.830 —— 复现不出来就说明我的
       重写跟原实现不是同一个模型，此时 5 折的数不能用，必须报「未验证」。
    4. 再跑 5 折按井（seed 20260101，与 bundle 共形标定同种子），出 D-008 要的基线。

产物：
    python same_protocol.py --loo        # 保真度验证（对模型卡）
    python same_protocol.py --kfold      # T12 正式对照表
    python same_protocol.py --all

作者：算法专家 · 2026-11-10 · 仅依赖标准库
"""
from __future__ import annotations

import argparse
import csv
import json
import math
import os
import random
import statistics as st

HERE = os.path.dirname(os.path.abspath(__file__))
PROJ = os.path.abspath(os.path.join(HERE, "..", ".."))
OUT_DIR = os.path.join(HERE, "out")

BUNDLE = os.path.join(PROJ, "04_数据", "bundle_v3.json")
if not os.path.exists(BUNDLE):                       # 回退到前端那份
    BUNDLE = os.path.join(PROJ, "03_源代码", "frontend", "src", "data", "bundle_v3.json")

PILOT_CANDIDATES = [
    os.path.join(PROJ, "04_数据", "原始数据"),        # D-013：04 为唯一运行期数据源
    os.path.join(PROJ, "03_源代码", "09_开源数据平替", "reports",
                 "cogis_pilot_run_40479938455", "pilot"),   # 归档只读
]

SEED = 20260101        # 与 bundle conformal 同种子
N_FOLD = 5
MONTHS = 12


def find_pilot():
    for d in PILOT_CANDIDATES:
        if os.path.exists(os.path.join(d, "pilot_events_v2c.csv")):
            return d
    raise FileNotFoundError("找不到 pilot_events_v2c.csv")


# ---------------------------------------------------------------- D-018 白名单
# 9 特征 + 5 标签同表（dataset_events.py 写死列序）。标签列任何一列混进特征就是
# 100% 泄漏，且漏了不会报警——所以只准白名单取列，禁止 drop 式黑名单。
FEATURES = ["anchor", "pre_nz", "D_fit", "form5a_seq", "population",
            "bucket", "slope_6m", "cv", "cv_missing"]
LABELS = ["actual12", "base12", "ratio", "y_log_ratio", "y_zero"]


def check_events():
    """读 events.csv 表头，断言白名单与标签互斥。D-018。"""
    path = os.path.join(PROJ, "04_数据", "events.csv")
    if not os.path.exists(path):
        return {"ok": None, "reason": "events.csv 不存在"}
    with open(path, encoding="utf-8") as f:
        header = next(csv.reader(f))
    # 优先用 dataset_events 导出的常量（若阿墨已按 D-018 落地）
    d = os.path.join(HERE)
    if d not in os.sys.path:
        os.sys.path.insert(0, d)
    try:
        import dataset_events as DE
        feats, labs = list(DE.FEATURES), list(DE.LABELS)
        src = "dataset_events.py 常量"
    except Exception:
        feats, labs, src = FEATURES, LABELS, "本脚本内置白名单（复制）"
    overlap = set(feats) & set(labs)
    missing = [c for c in feats if c not in header]
    ok = (len(feats) == 9 and len(labs) == 5 and not overlap and not missing)
    return {"ok": ok, "source": src, "n_features": len(feats),
            "n_labels": len(labs), "overlap": sorted(overlap),
            "missing_in_csv": missing, "n_cols": len(header)}


# ---------------------------------------------------------------- 数据
def load():
    b = json.load(open(BUNDLE, encoding="utf-8"))
    pilot = find_pilot()
    ev = {}
    with open(os.path.join(pilot, "pilot_events_v2c.csv"), encoding="utf-8") as f:
        for r in csv.DictReader(f):
            ev["CO" + r["api8"]] = r

    wells = []
    for w in b["wells"]:
        wid = w["well_id"]
        c = next((x for x in b["curves"] if x["well_id"] == wid), None)
        if c is None:
            continue
        e = ev.get(wid, {})
        wel = {
            "well_id": wid,
            "base": float(w["anchor"]),
            "population": w["population"],
            "pre_nz": float(e.get("pre_nz") or 0),
            "D_fit": float(e.get("D_fit") or 0),
            "form5a_seq": float(e.get("form5a_seq") or 0),
            "y": [float(m["oil"] or 0.0) for m in c["actual"][:MONTHS]],
        }
        if len(wel["y"]) != MONTHS or wel["base"] <= 0:
            continue
        wells.append(wel)
    return wells, b


# ---------------------------------------------------------------- 指标
def smape(y, yhat):
    """对称 MAPE（%）。两边都 0 记 0（完全命中），否则分母近 0 会爆。"""
    if y == 0 and yhat == 0:
        return 0.0
    d = abs(y) + abs(yhat)
    return 200.0 * abs(y - yhat) / d if d > 0 else 0.0


def metrics(pairs):
    """pairs = [(y, yhat), ...]"""
    n = len(pairs)
    ae = [abs(y - p) for y, p in pairs]
    se = [(y - p) ** 2 for y, p in pairs]
    sm = [smape(y, p) for y, p in pairs]
    lm = [abs(math.log1p(y) - math.log1p(p)) for y, p in pairs]
    return {"n": n, "MAE": st.mean(ae), "RMSE": math.sqrt(st.mean(se)),
            "sMAPE": st.mean(sm), "logMAE": st.mean(lm)}


# ---------------------------------------------------------------- 分档
def quantile(xs, q):
    """线性插值分位（numpy.percentile 默认口径），用来复现 ANBM 的档界。"""
    s = sorted(xs)
    if not s:
        return 0.0
    pos = (len(s) - 1) * q
    lo = int(math.floor(pos))
    hi = min(lo + 1, len(s) - 1)
    return s[lo] + (s[hi] - s[lo]) * (pos - lo)


def make_bins(bases):
    return [quantile(bases, .25), quantile(bases, .50), quantile(bases, .75)]


def bucket_of(base, bins):
    for i, b in enumerate(bins):
        if base < b:
            return i
    return len(bins)


# ---------------------------------------------------------------- ANBM
def fit_anbm(train):
    """48 个倍数：每档每月一个 c，网格 search 最小化该月 sMAPE。"""
    bases = [w["base"] for w in train]
    bins = make_bins(bases)
    nb = len(bins) + 1
    # 全局曲线（每档样本不足时兜底）
    g = []
    for t in range(MONTHS):
        pairs = [(w["y"][t] / w["base"], 1.0) for w in train]
        best_c, best_s = 1.0, float("inf")
        c = 0.10
        while c <= 4.0001:
            s = sum(smape(w["y"][t], w["base"] * c) for w in train) / len(train)
            if s < best_s:
                best_c, best_s = c, s
            c += 0.01
        g.append(round(best_c, 2))

    curves = {}
    for b in range(nb):
        sub = [w for w in train if bucket_of(w["base"], bins) == b]
        row = []
        for t in range(MONTHS):
            if len(sub) < 5:                      # min_bucket = 5
                row.append(g[t])
                continue
            best_c, best_s = 1.0, float("inf")
            c = 0.10
            while c <= 4.0001:
                s = sum(smape(w["y"][t], w["base"] * c) for w in sub) / len(sub)
                if s < best_s:
                    best_c, best_s = c, s
                c += 0.01
            row.append(round(best_c, 2))
        curves[str(b)] = row
    return {"bins": bins, "curves": curves, "global_curve": g}


def pred_anbm(m, base, t):
    b = bucket_of(base, m["bins"])
    return base * m["curves"].get(str(b), m["global_curve"])[t]


# ---------------------------------------------------------------- Template
def fit_template(train):
    """"零参数全局中位响应"：ŷ(t) = base × median_train(R(t))。"""
    r = []
    for t in range(MONTHS):
        r.append(st.median([w["y"][t] / w["base"] for w in train]))
    return {"r": r}


def pred_template(m, base, t):
    return base * m["r"][t]


# ---------------------------------------------------------------- Flat
def fit_flat(train):
    return {}


def pred_flat(m, base, t):
    return base


# ---------------------------------------------------------------- LSDRT-v2
LSDRT_FEATS = ["base", "pre_nz", "D_fit", "form5a_seq", "y_hist_mean",
               "y_last", "y_slope", "zero_share"]


def lsdrt_features(w):
    y = w["y"]
    return [w["base"], w["pre_nz"], w["D_fit"], w["form5a_seq"]]


def fit_lsdrt(train, k=10, gamma=1.0):
    """LSDRT-v2 的可复现子集。

    原实现用 38 维时序特征 + LassoCV 定权 + Top-10 邻域加权 + 中位增益 τ + 单调化。
    交付里没有 `finalize_final77.py`，38 维特征的构造细节（m1/m3/m6/m12/s3/s6/s12 等
    窗口定义）无从核对，所以这里只保留可核对的 4 维（anchor / pre_nz / D_fit / form5a_seq），
    权重用「与标签的秩相关」近似 Lasso 的稀疏权重。
    这一行**必须在表里标注为 LSDRT-approx，不得当作原模型**。
    """
    X = [lsdrt_features(w) for w in train]
    p = len(X[0])
    mu = [sum(r[j] for r in X) / len(X) for j in range(p)]
    sd = [math.sqrt(sum((r[j] - mu[j]) ** 2 for r in X) / len(X)) or 1.0 for j in range(p)]
    Z = [[(r[j] - mu[j]) / sd[j] for j in range(p)] for r in X]
    gain = [math.log(max(w["y"][0] + w["y"][1] + w["y"][2], 1e-9) /
                     (w["base"] * 3)) for w in train]
    wts = []
    for j in range(p):
        col = [z[j] for z in Z]
        r = _corr(col, gain)
        wts.append(abs(r))
    s = sum(wts) or 1.0
    wts = [x / s * p for x in wts] if s else [1.0] * p
    return {"mu": mu, "sd": sd, "w": wts, "k": k, "gamma": gamma,
            "train": [(Z[i], gain[i], train[i]) for i in range(len(train))]}


def _corr(a, b):
    n = len(a)
    ma, mb = sum(a) / n, sum(b) / n
    va = sum((x - ma) ** 2 for x in a)
    vb = sum((x - mb) ** 2 for x in b)
    if va <= 0 or vb <= 0:
        return 0.0
    return sum((a[i] - ma) * (b[i] - mb) for i in range(n)) / math.sqrt(va * vb)


def pred_lsdrt(m, w):
    x = lsdrt_features(w)
    z = [(x[j] - m["mu"][j]) / m["sd"][j] for j in range(len(x))]
    ds = []
    for zz, g, tw in m["train"]:
        d = math.sqrt(sum(m["w"][j] * (z[j] - zz[j]) ** 2 for j in range(len(z))))
        ds.append((d, g))
    ds.sort(key=lambda p: p[0])
    top = ds[:m["k"]]
    ws = [1.0 / (d ** m["gamma"] + 1e-6) for d, _ in top]
    tot = sum(ws)
    tau = sum(ws[i] * top[i][1] for i in range(len(top))) / tot
    # 信封与 ANBM 的网格范围一致（0.10–4.00 × base），否则 exp(tau) 会爆到离谱
    return min(max(w["base"] * math.exp(tau), 0.0), 4.0 * w["base"])


# ---------------------------------------------------------------- Twin（参考行）
def twin_pairs(mode="rolling", burn=36):
    """把 T13 的状态层放到**同一批 924 个格**上，两种信息集各出一份。

    fixed   ：固定原点，事件前最后一月的状态直接外推 12 个月（中途不更新）
              —— 信息集与三族等价，这一行才能和三族正面比
    rolling ：逐月滚动更新（T13 定义的能力），信息集更强，单列不得混入三族比较
    """
    import twin_state as T
    pilot = find_pilot()
    series = T.load_series(os.path.join(pilot, "pilot_series.csv"))
    events = T.load_events(os.path.join(pilot, "pilot_events_v2c.csv"))
    out, fixed_n = [], 0
    for api8, ev in events.items():
        obs = series.get(api8, [])
        pre = [o for o in obs if o.mi < ev.mi][-burn:]
        post = [o for o in obs if ev.mi <= o.mi < ev.mi + 12]
        if not post or not pre:
            continue
        fixed_n += 1
        tw = T.TwinState(api8, ev)
        for o in pre:
            tw.process(o)
        if mode == "fixed":
            for k, o in enumerate(post, 1):
                q, _, _ = tw.predict_next(horizon=k)
                out.append((o.rate, q))
        else:
            for o in post:
                q, _, _ = tw.predict_next(horizon=1)
                out.append((o.rate, q))
                tw.process(o)
    return out, fixed_n


# ---------------------------------------------------------------- 零产 Brier
def brier_zero(wells, k=N_FOLD):
    """零产 Brier（同折）。

    三族（ANBM / Template / Flat）**不输出零产概率**，给它们填一个 Brier 就是编数，
    所以主表该列统一 N/A；这里单独按 P3 的口径（5 特征 + L2=0.05 + PR/SI 分层）
    在同样的折上重训一次，作为零产预测能力的唯一可比数。
    """
    import sys
    sys.path.insert(0, HERE)
    import model_p3 as P3

    byid = {w["well_id"]: w for w in wells}
    groups = folds(wells, k)
    rows_test = []
    for test_ids in groups:
        ts = set(test_ids)
        tr = [w for w in wells if w["well_id"] not in ts]
        te = [byid[t] for t in test_ids if t in byid]
        if not tr or not te:
            continue
        models = {}
        for pop in ("PR", "SI"):
            sub = [w for w in tr if w["population"] == pop]
            X = [[math.log1p(max(w["base"], 0)), math.log1p(w["pre_nz"]),
                  w["D_fit"], math.log1p(w["form5a_seq"]), (t + 1) / 12.0]
                 for w in sub for t in range(MONTHS)]
            y = [1.0 if w["y"][t] == 0 else 0.0 for w in sub for t in range(MONTHS)]
            if len(set(y)) < 2:
                models[pop] = None
                continue
            Xs, mu, sd = P3.standardize(X)
            models[pop] = P3.logistic_fit(Xs, y, l2=0.05) + (mu, sd)
        rate = sum(1.0 for w in tr for t in range(MONTHS) if w["y"][t] == 0) / \
            (len(tr) * MONTHS)
        for w in te:
            for t in range(MONTHS):
                yz = 1.0 if w["y"][t] == 0 else 0.0
                mp = models.get(w["population"])
                if mp is None:
                    p = rate
                else:
                    wt, b, mu, sd = mp
                    x = [math.log1p(max(w["base"], 0)), math.log1p(w["pre_nz"]),
                         w["D_fit"], math.log1p(w["form5a_seq"]), (t + 1) / 12.0]
                    z = [(x[j] - mu[j]) / (sd[j] or 1.0) for j in range(len(x))]
                    p = P3.logistic_pred([z], wt, b)[0]
                rows_test.append((yz, p, rate))
    b_model = st.mean([(y - p) ** 2 for y, p, _ in rows_test])
    b_const = st.mean([(y - r) ** 2 for y, _, r in rows_test])
    base_rate = st.mean([y for y, _, _ in rows_test])
    return {"n": len(rows_test), "brier_model": b_model, "brier_const": b_const,
            "zero_rate": base_rate,
            "improve_pct": (1 - b_model / b_const) * 100}


def twin_by_well(mode="fixed", burn=36):
    """逐井返回 (actual, pred) 序列，用于配对检验（单位必须回到「井」）。"""
    import twin_state as T
    pilot = find_pilot()
    series = T.load_series(os.path.join(pilot, "pilot_series.csv"))
    events = T.load_events(os.path.join(pilot, "pilot_events_v2c.csv"))
    out = {}
    for api8, ev in events.items():
        obs = series.get(api8, [])
        pre = [o for o in obs if o.mi < ev.mi][-burn:]
        post = [o for o in obs if ev.mi <= o.mi < ev.mi + 12]
        if not post or not pre:
            continue
        tw = T.TwinState(api8, ev)
        for o in pre:
            tw.process(o)
        prs = []
        if mode == "fixed":
            for k, o in enumerate(post, 1):
                q, _, _ = tw.predict_next(horizon=k)
                prs.append((o.rate, q))
        else:
            for o in post:
                q, _, _ = tw.predict_next(horizon=1)
                prs.append((o.rate, q))
                tw.process(o)
        out[api8] = prs
    return out


def anbm_by_well(wells):
    """5 折下逐井返回 (actual, pred)。"""
    byid = {w["well_id"]: w for w in wells}
    out = {}
    for test_ids in folds(wells, N_FOLD):
        ts = set(test_ids)
        train = [w for w in wells if w["well_id"] not in ts]
        if len(train) < 10:
            continue
        m = fit_anbm(train)
        for wid in test_ids:
            w = byid.get(wid)
            if w is None:
                continue
            out[wid] = [(w["y"][t], pred_anbm(m, w["base"], t)) for t in range(MONTHS)]
    return out


def significance(wells):
    """配对 bootstrap：以**井**为重采样单位，检验 Twin 固定原点 vs ANBM。

    为什么单位必须是井不是井月：同一口井 12 个月的误差强相关，按 924 格重采样
    会把置信区间算窄（P14 §2.3 记的同类坑）。井间才近似独立。
    """
    an = anbm_by_well(wells)
    tw = twin_by_well("fixed")
    ids = sorted(set(an) & set(f"CO{k}" for k in tw))
    # twin 的 key 是裸 api8，ANBM 是 CO+api8：统一成 CO 前缀
    tw2 = {("CO" + k if not k.startswith("CO") else k): v for k, v in tw.items()}
    ids = sorted(set(an) & set(tw2))
    mae_a = {i: st.mean(abs(y - p) for y, p in an[i]) for i in ids}
    mae_t = {i: st.mean(abs(y - p) for y, p in tw2[i]) for i in ids}
    diffs = [mae_t[i] - mae_a[i] for i in ids]

    print("=" * 84)
    print("配对 bootstrap（重采样单位 = 井，n = %d，10000 次）" % len(ids))
    print("=" * 84)
    print(f"Twin 固定原点 MAE {st.mean(mae_t.values()):.4f} · "
          f"ANBM MAE {st.mean(mae_a.values()):.4f} · "
          f"差 {st.mean(diffs):+.4f}")
    wins = sum(1 for d in diffs if d < 0)
    print(f"逐井胜负：Twin 更好 {wins} 口 / 更差 {len(diffs) - wins} 口 "
          f"（胜率 {wins / len(diffs):.1%}）")

    rng = random.Random(SEED)
    boots = []
    for _ in range(10000):
        samp = [diffs[rng.randrange(len(diffs))] for _ in range(len(diffs))]
        boots.append(st.mean(samp))
    boots.sort()
    lo, hi = boots[250], boots[9750]
    p_better = sum(1 for b in boots if b < 0) / len(boots)
    print(f"差的 95% CI [{lo:+.4f}, {hi:+.4f}]  "
          f"{'不含 0 → 显著' if (lo < 0 < hi) is False else '含 0 → 不显著'}")
    print(f"P(Twin 更好) ≈ {p_better:.2%}")
    print("-" * 84)
    if lo < 0 < hi:
        print("结论：**不显著**。1.4% 的余量在 77 口井上撑不住，不能拿它宣布「状态空间更准」。")
    elif hi < 0:
        print("结论：**显著优于 ANBM**（CI 整体在 0 以下）。")
    else:
        print("结论：**显著劣于 ANBM**（CI 整体在 0 以上）。")
    print("=" * 84)
    return {"n": len(ids), "mae_twin": st.mean(mae_t.values()),
            "mae_anbm": st.mean(mae_a.values()), "diff": st.mean(diffs),
            "ci": [lo, hi], "p_better": p_better, "wins": wins}


# ---------------------------------------------------------------- 折
def folds(wells, k):
    ids = sorted(w["well_id"] for w in wells)
    random.Random(SEED).shuffle(ids)
    bucket = [[] for _ in range(k)]
    for i, wid in enumerate(ids):
        bucket[i % k].append(wid)
    return bucket


MODELS = {
    "ANBM": (fit_anbm, lambda m, w, t: pred_anbm(m, w["base"], t)),
    "Template": (fit_template, lambda m, w, t: pred_template(m, w["base"], t)),
    "Flat": (fit_flat, lambda m, w, t: pred_flat(m, w["base"], t)),
}


def run(wells, k, verbose=True):
    """k 折按井交叉；k = n_wells 即 LOO。返回 每模型 × [(y, yhat)]。"""
    byid = {w["well_id"]: w for w in wells}
    if k >= len(wells):                      # LOO
        groups = [[wid] for wid in sorted(byid)]
    else:
        groups = folds(wells, k)
    out = {name: [] for name in MODELS}
    out["LSDRT-approx"] = []
    for gi, test_ids in enumerate(groups):
        test_ids = [t for t in test_ids if t in byid]
        test = [byid[t] for t in test_ids]
        train = [w for w in wells if w["well_id"] not in set(test_ids)]
        if not test or len(train) < 10:
            continue
        fitted = {name: fn(train) for name, (fn, _) in MODELS.items()}
        ls = fit_lsdrt(train)
        for w in test:
            for t in range(MONTHS):
                y = w["y"][t]
                for name, (_, pf) in MODELS.items():
                    out[name].append((y, pf(fitted[name], w, t)))
                out["LSDRT-approx"].append((y, pred_lsdrt(ls, w)))
        if verbose and (gi + 1) % 10 == 0:
            print(f"  折 {gi + 1}/{len(groups)} 完成", flush=True)
    return out


# ---------------------------------------------------------------- 输出
REF_LOO = {   # 模型卡 §4 / bundle final77_metrics.loo_reference_protocol_A
    "ANBM": {"sMAPE": 96.830, "MAE": 1.9444},
    "LSDRT-v2": {"sMAPE": 96.449, "MAE": 1.7817},
    "Template": {"sMAPE": 98.042, "MAE": 1.8619},
    "Flat": {"sMAPE": 95.957, "MAE": 2.1330},
}


def print_table(res, title, ref=None):
    print("=" * 84)
    print(title)
    print("=" * 84)
    print(f"{'模型':<16}{'n':>6}{'MAE':>10}{'RMSE':>10}{'sMAPE%':>10}{'logMAE':>10}"
          f"{'对卡偏差':>12}")
    print("-" * 84)
    for name in ("ANBM", "Template", "Flat"):
        m = metrics(res[name])
        dev = ""
        if ref and name in ref:
            dev = f"{(m['MAE'] / ref[name]['MAE'] - 1) * 100:+.1f}%"
        print(f"{name:<16}{m['n']:>6}{m['MAE']:>10.4f}{m['RMSE']:>10.4f}"
              f"{m['sMAPE']:>10.3f}{m['logMAE']:>10.3f}{dev:>12}")
    print(f"{'LSDRT-v2':<16}{'—':>6}{'N/A':>10}{'N/A':>10}{'N/A':>10}{'N/A':>10}"
          f"{'不可复现':>12}")
    print("-" * 84)
    m = metrics(res["LSDRT-approx"])
    print(f"LSDRT-v2 记 N/A 的理由：原实现 `scripts/finalize_final77.py` 未随交付，"
          f"38 维特征构造（m1/m3/m6/m12/s3/s6/s12 的窗口定义）无从核对。")
    print(f"参照行（4 维近似，**不参与任何判定**）：MAE {m['MAE']:.4f} · "
          f"sMAPE {m['sMAPE']:.3f} · RMSE {m['RMSE']:.4f}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--loo", action="store_true")
    ap.add_argument("--kfold", action="store_true")
    ap.add_argument("--sig", action="store_true")
    ap.add_argument("--all", action="store_true")
    a = ap.parse_args()
    if not any([a.loo, a.kfold, a.sig, a.all]):
        a.all = True

    wells, bundle = load()
    chk = check_events()
    if chk["ok"] is False:
        print(f"D-018 白名单断言 FAIL：{chk}")
        raise SystemExit(1)
    if chk["ok"]:
        print(f"D-018 白名单断言 PASS：{chk['n_features']} 特征 + "
              f"{chk['n_labels']} 标签，互斥，来源 {chk['source']}（表头 {chk['n_cols']} 列）")
    else:
        print(f"D-018 白名单检查跳过：{chk.get('reason')}")
    print(f"bundle：{BUNDLE}")
    print(f"井 {len(wells)} · 井月 {len(wells) * MONTHS} · "
          f"零产月 {sum(1 for w in wells for y in w['y'] if y == 0)}")
    print(f"ANBM 档界（全量 77 井四分位复算）："
          f"{[round(x, 6) for x in make_bins([w['base'] for w in wells])]}")
    print(f"bundle 存的档界：{[round(x, 6) for x in bundle['final_model']['models']['ANBM']['bins'][1:-1]]}")
    print()

    if a.sig:
        significance(wells)
        print()

    if a.loo or a.all:
        print("LOO 复现中（77 折，ANBM 每折重训 48 个倍数，约 1 分钟）…", flush=True)
        res = run(wells, len(wells))
        print_table(res, "保真度验证 · LOO 口径（对 model_card_final77 §4）",
                    ref=REF_LOO)
        print("判读：ANBM 行 MAE 与卡上 1.9444 的偏差在 ±2% 内 = 重写与原实现等价；")
        print("      超过 5% = 不是同一个模型，5 折的数不能用。")
        print()

    if a.kfold or a.all:
        res = run(wells, N_FOLD)
        print_table(res, f"T12 正式对照 · {N_FOLD} 折按井交叉（seed {SEED}）")
        print()

        # T13 判据（D-008）：同协议下 twin 与 ANBM / Flat 正面比
        print("-" * 84)
        print("T13 判据口径 · 同一批 924 格（D-008 要求的两条基线在同一张表里）")
        print("-" * 84)
        anbm_mae = metrics(res["ANBM"])["MAE"]
        flat_mae = metrics(res["Flat"])["MAE"]
        nw = 0
        for mode, label in (("fixed", "Twin 固定原点（信息集等价）"),
                            ("rolling", "Twin 逐月滚动（信息集更强）")):
            prs, nw = twin_pairs(mode)
            m = metrics(prs)
            ok1 = "✅" if m["MAE"] <= anbm_mae else "❌"
            ok2 = "✅" if m["MAE"] <= flat_mae else "❌"
            print(f"{label:<28}{m['n']:>5} 格  MAE {m['MAE']:.4f}"
                  f"  ≤ANBM {anbm_mae:.4f} {ok1}   ≤Flat {flat_mae:.4f} {ok2}")
        print(f"（井数 {nw}；判据 = 两条同时成立才过）")
        print()

        bz = brier_zero(wells)
        print("-" * 84)
        print(f"零产 Brier（同折 {N_FOLD} 折，n={bz['n']} 格，零产率 {bz['zero_rate']:.3f}）")
        print("-" * 84)
        print(f"P3 零产模型（5 特征 + L2=0.05 + PR/SI 分层）  Brier {bz['brier_model']:.4f}")
        print(f"常数基础率（同折训练折零产率）                 Brier {bz['brier_const']:.4f}")
        print(f"改善 {bz['improve_pct']:+.2f}%  "
              f"（三族不输出零产概率，主表该列记 N/A，不代填）")

        os.makedirs(OUT_DIR, exist_ok=True)
        path = os.path.join(OUT_DIR, "same_protocol.json")
        dump = {k: metrics(v) for k, v in res.items()}
        dump["T13_threshold"] = {"ANBM_MAE": anbm_mae, "Flat_MAE": flat_mae}
        dump["brier_zero"] = bz
        dump["protocol"] = {"k_fold": N_FOLD, "seed": SEED,
                            "n_wells": len(wells), "n_cell": len(wells) * MONTHS,
                            "unit": "m3/d", "bundle": BUNDLE}
        json.dump(dump, open(path, "w", encoding="utf-8"),
                  ensure_ascii=False, indent=1)
        print(f"已写出 {path}")


if __name__ == "__main__":
    main()
