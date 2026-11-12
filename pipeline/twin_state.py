#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""T13 · 状态空间模型（数字孪生状态层）

每口井一个状态向量 s_t = [q, d, r, h]
    q  当前产能        m3/d，>= 0
    d  月递减率        1/月，[0, 0.30]
    r  措施响应强度    无量纲，[0, 5]（1.0 = 无响应）
    h  健康度          0–1

滤波形式（为什么用对数空间）：
    ln q_{t+1} = ln q_t - d_t      <- 递减对产量是乘性的，取对数后变成线性
    d_{t+1}    = d_t + eps
观测：
    z_t = ln(rate_m3d) = ln q_t + v_t
于是 (ln q, d) 是一个标准线性高斯系统，闭式卡尔曼即可，不需要粒子滤波。
零产月（days_produced = 0）不当作「产量为 0」的观测——关井不是产能归零，
按缺失观测处理，只让健康度 h 掉下来。这是本文件对 P13 短板 1 的直接回应。

r 与 h 不是线性高斯量，各自用一个标量滤波（EWMA + 物理投影），
协方差按独立假设放在 4x4 的对角块上——这是近似，写进 limitations。

用法：
    python twin_state.py --eval        # 折外一步预测对比（T13 验收）
    python twin_state.py --states      # 导出 77 井最新 s_t + P_t
    python twin_state.py --assert      # 物理范围 / 幂等 / 确定性三条断言
    python twin_state.py --sens        # 超参敏感性（3x3）
    python twin_state.py --all         # 以上全跑

作者：算法专家 · 2026-11-09 · 仅依赖 numpy + 标准库
"""
from __future__ import annotations

import argparse
import csv
import json
import math
import os
import statistics as st

import numpy as np

# ---------------------------------------------------------------- 路径解析
HERE = os.path.dirname(os.path.abspath(__file__))
PROJ = os.path.abspath(os.path.join(HERE, "..", ".."))
OUT_DIR = os.path.join(HERE, "out")

# 现有 4 个脚本写死的是 09_开源数据平替/...；项目整理后实际在 04_数据/原始数据/。
# 本脚本自己找，不改别人的行为。
DATA_CANDIDATES = [
    os.path.join(PROJ, "04_数据", "原始数据"),
    os.path.join(PROJ, "03_源代码", "09_开源数据平替", "reports",
                 "cogis_pilot_run_40479938455", "pilot"),
]


def find_data_dir() -> str:
    for d in DATA_CANDIDATES:
        if os.path.exists(os.path.join(d, "pilot_series.csv")):
            return d
    raise FileNotFoundError(
        "找不到 pilot_series.csv，试过：\n  " + "\n  ".join(DATA_CANDIDATES))


# ---------------------------------------------------------------- 超参数
# 全部是「先验给定」，不是网格搜出来的。搜过就成 in-sample 调参了（红线 1）。
class Params:
    # 这三个数是**从数据辨识出来的**，不是拍脑袋也不是网格搜出来的。见 identify_noise()：
    #   Δlog(rate) 的 sd = 0.633，滞后 1 阶自相关 ρ = -0.251（n = 18,442 个相邻可用井月）
    #   Cov(Δz_t, Δz_{t-1}) = -σ_obs²  → σ_obs = 0.633·sqrt(0.251) = 0.317
    #   Var(Δz) = 2σ_obs² + σ_q²      → σ_q   = sqrt(0.401 - 2·0.1005) = 0.447
    # ρ 为负说明月度涨落主要来自测量/计量噪声，不是产能真的在跳；
    # 但扣掉观测噪声后剩下的过程项仍有 0.45，说明产能本身确实在漂——所以斜率不能取太小。
    sd_q = 0.45      # ln q 的月过程噪声 sd
    sd_d = 0.008     # 递减率随机游走 sd（D 物理上限 0.30，月波动取 1/40）
    sd_obs = 0.32    # 观测噪声 sd（对数空间）
    event_q_inflate = 25.0   # 事件月过程噪声放大倍数（状态突变，让滤波器敢跳）
    event_q_months = 1       # 放大持续月数

    h_alpha = 0.85   # 健康度 EWMA 系数（≈ 6 个月记忆）
    r_window = 3     # 措施响应期长度（月），与 T14 的「响应期 1–3 月」一致

    d_init = 0.02    # 冷启动递减率先验（Weld 区块典型 2%/月）
    p0_lnq = 0.50    # 冷启动 lnq 方差
    p0_d = 0.05      # 冷启动 d 方差

    # 物理范围（P14 §5 新增断言）
    q_min, d_min, d_max = 0.0, 0.0, 0.30
    r_min, r_max = 0.0, 5.0
    h_min, h_max = 0.0, 1.0


# ---------------------------------------------------------------- 数据
class Obs:
    __slots__ = ("mi", "days", "rate", "oil_m3")

    def __init__(self, mi, days, rate, oil_m3):
        self.mi, self.days, self.rate, self.oil_m3 = mi, days, rate, oil_m3

    @property
    def usable(self) -> bool:
        """可当观测用的月：有生产天数且产量非零。关井月不算。"""
        return self.days > 0 and self.rate > 1e-9


class Event:
    __slots__ = ("api8", "mi", "base_incl", "D_fit", "status", "well")

    def __init__(self, api8, mi, base_incl, D_fit, status, well):
        self.api8, self.mi, self.base_incl = api8, mi, base_incl
        self.D_fit, self.status, self.well = D_fit, status, well


def ym_to_mi(ym: str) -> int:
    """'2017-03' -> 绝对月序，与 pilot_series.csv 的 mi 同口径（y*12+m-1）。"""
    y, m = ym.split("-")
    return int(y) * 12 + int(m) - 1


def load_series(path):
    out = {}
    with open(path, encoding="utf-8") as f:
        for r in csv.DictReader(f):
            api8 = r["api8"]
            out.setdefault(api8, []).append(
                Obs(int(r["mi"]), float(r["days_produced"]),
                    float(r["rate_m3d"]), float(r["oil_m3"])))
    for v in out.values():
        v.sort(key=lambda o: o.mi)
    return out


def load_events(path):
    out = {}
    with open(path, encoding="utf-8") as f:
        for r in csv.DictReader(f):
            api8 = r["api8"]
            out[api8] = Event(api8, ym_to_mi(r["event_month"]),
                              float(r["base_incl_m3d"]), float(r["D_fit"]),
                              r["status"], r["well"].strip())
    return out


# ---------------------------------------------------------------- 状态滤波器
class TwinState:
    """单井状态估计器。逐井独立，不需要任何跨井样本。"""

    def __init__(self, api8, event: Event | None = None, params=Params):
        self.api8 = api8
        self.p = params
        self.ev = event
        self.x = None            # [ln q, d]
        self.P = None            # 2x2
        self.r = 1.0
        self.h = 1.0
        self.var_r = 0.0
        self.var_h = 0.0
        self.last_mi = None      # 幂等闸门：<= 已被吃过的观测一律丢弃
        self.n_obs = 0
        self.n_skip = 0
        self.last_obs = None

    # -- 冷启动 --------------------------------------------------
    def _bootstrap(self, o: Obs):
        self.x = np.array([math.log(max(o.rate, 1e-6)), self.p.d_init])
        self.P = np.diag([self.p.p0_lnq, self.p.p0_d])

    # -- 预测 ----------------------------------------------------
    def predict_next(self, horizon: int = 1):
        """从当前后验出发，预测 h 个月后的 (q_hat, sd_state, sd_pred)。

        sd_state = 状态本身的不确定度（进 s_t / P_t）
        sd_pred  = 下一次观测的不确定度 = sqrt(sd_state^2 + sd_obs^2)，用于区间
                   两者不能混用：只用 sd_state 做区间，覆盖率会掉到 0.4（已踩过）
        """
        if self.x is None:
            return None, None, None
        p = self.p
        Q = np.diag([p.sd_q ** 2, p.sd_d ** 2])
        x = self.x.copy()
        P = self.P.copy()
        frac = 1.0
        if self.last_obs is not None:
            frac = min(max(self.last_obs.days / 30.4, 0.0), 1.0)
        for i in range(max(horizon, 1)):
            f = frac if i == 0 else 1.0          # 只对「上一月实际产了多少天」加权
            F = np.array([[1.0, -f], [0.0, 1.0]])
            x = F @ x
            P = F @ P @ F.T + Q * max(f, 0.05)
        lnq = x[0]
        var_state = max(float(P[0, 0]), 1e-12)
        var_pred = var_state + p.sd_obs ** 2
        return math.exp(lnq), math.sqrt(var_state), math.sqrt(var_pred)

    # -- 更新 ----------------------------------------------------
    def process(self, o: Obs) -> dict:
        p = self.p
        # 幂等：同一观测（或更早的）重复喂，状态不动
        if self.last_mi is not None and o.mi <= self.last_mi:
            self.n_skip += 1
            return self.snapshot(skipped=True)

        if self.x is None:
            self._bootstrap(o)
            self.last_mi = o.mi
            self.h = 1.0 if o.usable else 0.3
            self.last_obs = o
            return self.snapshot()

        # --- 预测 ---
        # 关键：递减按**生产天数**加权，不按日历月。井关着的月份产能不该掉——
        # 否则停产一年再复产，分母已经塌到接近 0，r 全被截到 5（已踩过）。
        gap = o.mi - self.last_mi          # 中间缺月就多推几步
        x_pred = self.x.copy()
        P_pred = self.P.copy()
        in_event = (self.ev is not None
                    and 0 <= (o.mi - self.ev.mi) < p.event_q_months)
        q_inflate = p.event_q_inflate if in_event else 1.0
        Q = np.diag([p.sd_q ** 2 * q_inflate, p.sd_d ** 2])
        for _ in range(max(gap - 1, 0)):            # 中间整月（有观测但落在窗口外）
            x_pred = np.array([x_pred[0] - x_pred[1], x_pred[1]])
            P_pred = np.array([[1.0, -1.0], [0.0, 1.0]]) @ P_pred \
                @ np.array([[1.0, 0.0], [-1.0, 1.0]]) + Q
        frac = 1.0
        if self.last_obs is not None:                # 上一月实际生产了多少天
            frac = min(max(self.last_obs.days / 30.4, 0.0), 1.0)
        x_pred = np.array([x_pred[0] - x_pred[1] * frac, x_pred[1]])
        F_frac = np.array([[1.0, -frac], [0.0, 1.0]])
        P_pred = F_frac @ P_pred @ F_frac.T + Q * max(frac, 0.05)

        q_hat = math.exp(x_pred[0])

        # --- 观测更新 ---
        if o.usable:
            z = math.log(o.rate)
            S = P_pred[0, 0] + p.sd_obs ** 2
            K = P_pred[:, 0] / S
            innov = z - x_pred[0]
            self.x = x_pred + K * innov
            I_KH = np.eye(2) - np.outer(K, np.array([1.0, 0.0]))
            self.P = I_KH @ P_pred
            self.P = 0.5 * (self.P + self.P.T)      # 数值对称
        else:
            self.x, self.P = x_pred, P_pred

        # --- 物理投影（投影后协方差保持不变，见 limitations）---
        self.x[1] = min(max(self.x[1], p.d_min), p.d_max)
        self.x[0] = min(self.x[0], math.log(1e5))   # 只防 exp 溢出

        # --- r：措施响应强度（该井最近一次措施的峰值响应，不随时间衰减）---
        # 定义照 P14 §3.2：r = 事件后 1–3 月峰值 / 基线。分母用事件记录里的
        # base_incl_m3d（事件前末 3 个非零月均值，P13 §1.1，已验无泄漏），
        # 不用滤波器滞后估计——用滞后估计会把衰减期偏低系统性放大成「强响应」。
        if o.usable and self.ev is not None:
            diff = o.mi - self.ev.mi
            if 0 <= diff <= p.r_window:
                base = self.ev.base_incl if self.ev.base_incl > 1e-9 else q_hat
                r_obs = o.rate / base
                if diff == 0:
                    self.r = r_obs
                else:
                    self.r = max(self.r, r_obs)
                self.var_r = 0.09          # 单次测量的方差（对数比约 ±20%）
        self.r = min(max(self.r, p.r_min), p.r_max)

        # --- h：健康度 ---
        if o.usable:
            uptime = min(o.days / 30.4, 1.0)
            rel = abs(o.rate - q_hat) / max(q_hat, 1e-9)
            stability = math.exp(-rel / 0.35)
            obs_h = 0.5 * uptime + 0.5 * stability
        else:
            obs_h = 0.05                                  # 关井月
        self.h = p.h_alpha * self.h + (1 - p.h_alpha) * obs_h
        self.h = min(max(self.h, p.h_min), p.h_max)
        self.var_h = p.h_alpha ** 2 * self.var_h + (1 - p.h_alpha) ** 2 * 0.04

        self.last_mi = o.mi
        self.n_obs += 1
        self.last_obs = o
        return self.snapshot()

    # -- 快照 ----------------------------------------------------
    def snapshot(self, skipped: bool = False) -> dict:
        if self.x is None:
            return {"api8": self.api8, "ts": None, "s": None, "P": None,
                    "skipped": skipped}
        q = math.exp(self.x[0])
        d = float(self.x[1])
        r = float(self.r)
        h = float(self.h)
        # delta 法把 (lnq, d) 的协方差搬到 (q, d)
        var_lnq, var_d = float(self.P[0, 0]), float(self.P[1, 1])
        cov_lnq_d = float(self.P[0, 1])
        P = np.zeros((4, 4))
        P[0, 0] = q * q * var_lnq
        P[1, 1] = var_d
        P[0, 1] = P[1, 0] = q * cov_lnq_d
        P[2, 2] = float(self.var_r)
        P[3, 3] = float(self.var_h)
        return {
            "api8": self.api8,
            "well": self.ev.well if self.ev else "",
            "ts": self.last_mi,
            "s": {"q": q, "d": d, "r": r, "h": h},
            "P": P.tolist(),
            "sd_q": math.sqrt(max(P[0, 0], 0.0)),
            "n_obs": self.n_obs,
            "skipped": skipped,
            "source": "kalman_logspace+ewma",
        }


# ---------------------------------------------------------------- 噪声辨识
def identify_noise(series):
    """从 Δlog(rate) 的方差/自协方差分解出 (σ_obs, σ_q)。

    模型：z_t = ln q_t + v_t,  ln q_t = ln q_{t-1} - d + w_t
    →  Δz_t = w_t - v_{t-1} + v_t - d
    →  Var(Δz) = 2σ_obs² + σ_q²,  Cov(Δz_t, Δz_{t-1}) = -σ_obs²
    这两个式子只用产量序列本身，不用任何标签，所以不构成折外泄漏。
    """
    dz = []
    for obs in series.values():
        prev = None
        for o in obs:
            if o.usable:
                if prev is not None and o.mi - prev.mi == 1:
                    dz.append(math.log(o.rate) - math.log(prev.rate))
                prev = o
    n = len(dz)
    mu = st.mean(dz)
    var = st.variance(dz)
    cov1 = sum((dz[i] - mu) * (dz[i + 1] - mu) for i in range(n - 1)) / (n - 1)
    sd_obs = math.sqrt(max(-cov1, 1e-9))
    sd_q = math.sqrt(max(var - 2 * sd_obs ** 2, 1e-9))
    return {"n": n, "mean_dz": mu, "sd_dz": math.sqrt(var),
            "lag1_cov": cov1, "lag1_ac": cov1 / var,
            "sd_obs": sd_obs, "sd_q": sd_q}


def print_identify(series):
    r = identify_noise(series)
    print("=" * 78)
    print("噪声参数辨识（只用 Δlog(rate) 的二阶统计量，不用标签）")
    print("=" * 78)
    print(f"相邻可用井月对 n = {r['n']} · Δlog 均值 {r['mean_dz']:+.4f} "
          f"· sd {r['sd_dz']:.3f} · 滞后1阶自相关 {r['lag1_ac']:+.3f}")
    print(f"→ σ_obs = {r['sd_obs']:.3f}   （Cov(Δz_t,Δz_{{t-1}}) = -σ_obs²）")
    print(f"→ σ_q   = {r['sd_q']:.3f}   （Var(Δz) = 2σ_obs² + σ_q²）")
    print(f"当前 Params：σ_obs={Params.sd_obs}  σ_q={Params.sd_q}  σ_d={Params.sd_d}")
    print("=" * 78)


# ---------------------------------------------------------------- 三条基线
def baseline_exp(ev: Event, k: int) -> float:
    """现有模型的月产量口径：base_incl x exp(-D_fit*k)。P13 §1.1 的 base12 同源。"""
    return ev.base_incl * math.exp(-ev.D_fit * k)


def _metrics(rows, key_hat):
    ae, se, ae_nz = [], [], []
    cov90 = cov90_nz = hit = hit_nz = 0
    for r in rows:
        a, m = r["actual"], r[key_hat]
        if math.isnan(m):
            continue
        e = abs(a - m)
        ae.append(e)
        se.append((a - m) ** 2)
        lo, hi = r.get(key_hat + "_lo"), r.get(key_hat + "_hi")
        inside = (lo is not None and lo <= a <= hi)
        if a > 1e-9:
            ae_nz.append(e)
            hit_nz += 1
            cov90_nz += 1 if inside else 0
        if lo is not None:
            hit += 1
            cov90 += 1 if inside else 0
    n = len(rows)
    has_int = hit > 0
    return {
        "n": n,
        "MAE": st.mean(ae) if ae else float("nan"),
        "RMSE": math.sqrt(st.mean(se)) if se else float("nan"),
        "MedAE": st.median(ae) if ae else float("nan"),
        "MAE_nz": st.mean(ae_nz) if ae_nz else float("nan"),
        "n_nz": len(ae_nz),
        # 条件覆盖：只在 y>0 的井月上算（与 P13 §2.2 的 694 月同口径）
        "cov90": (cov90_nz / hit_nz) if (hit_nz and has_int) else None,
        "cov90_all": (cov90 / hit) if has_int else None,
    }


def one_step_eval(series, events, burn=36, params=Params):
    """折外一步预测：36 月历史滚动喂入，事件后 12 个月逐月预测下一月。

    折外性说明：每口井只用**自己**过去的信息，被预测月从不参与自己的状态更新；
    跨井样本为零，因此不存在「测试井泄漏到训练集」的可能（P13 §6 红线 1 天然满足）。
    """
    rows = []
    burn_hist = []
    for api8, ev in events.items():
        obs = series.get(api8, [])
        pre = [o for o in obs if o.mi < ev.mi]
        post = [o for o in obs if ev.mi <= o.mi < ev.mi + 12]
        if not post:
            continue
        hist = pre[-burn:]
        burn_hist.append(len(hist))
        twin = TwinState(api8, ev, params)
        for o in hist:
            twin.process(o)

        last_nz = None
        for o in hist:
            if o.usable:
                last_nz = o.rate
        for k, o in enumerate(post, 1):
            q_hat, sd_state, sd_pred = twin.predict_next()
            row = {"api8": api8, "k": k, "actual": o.rate, "days": o.days,
                   "usable": o.usable}
            if q_hat is None:                     # 历史太短，冷启动
                row["twin"] = float("nan")
            else:
                row["twin"] = q_hat
                row["twin_lo"] = max(0.0, q_hat - 1.645 * q_hat * sd_pred)
                row["twin_hi"] = q_hat + 1.645 * q_hat * sd_pred
            row["m_exp"] = baseline_exp(ev, k)
            row["m_persist"] = last_nz if last_nz is not None else float("nan")
            row["status"] = ev.status
            rows.append(row)
            twin.process(o)
            if o.usable:
                last_nz = o.rate

    ok = [r for r in rows if not math.isnan(r.get("twin", float("nan")))]
    res = {
        "n_wells": len(burn_hist),
        "n_months": len(rows),
        "burn_mean": st.mean(burn_hist) if burn_hist else 0,
        "n_full36": sum(1 for b in burn_hist if b >= 36),
        "models": {
            "twin_kalman": _metrics(ok, "twin"),
            "m1_existing_exp": _metrics(rows, "m_exp"),
            "m2_persistence": _metrics(rows, "m_persist"),
        },
    }
    return res, rows


def print_eval(res, rows):
    print("=" * 78)
    print("T13 · 折外一步预测（36 月滚动历史 · 事件后 12 月 · 逐月重估）")
    print("=" * 78)
    print(f"井 {res['n_wells']} · 井月 {res['n_months']} · "
          f"预热月数均值 {res['burn_mean']:.1f} · 满 36 月的井 {res['n_full36']}")
    print()
    hdr = (f"{'模型':<22}{'MAE':>9}{'RMSE':>9}{'MedAE':>9}{'MAE(非零)':>11}"
           f"{'覆盖(y>0)':>11}{'覆盖(全)':>10}")
    print(hdr)
    print("-" * 78)
    name = {"twin_kalman": "Twin 状态空间（本文）",
            "m1_existing_exp": "m1_existing_exp",
            "m2_persistence": "m2_persistence"}
    for k in ("twin_kalman", "m1_existing_exp", "m2_persistence"):
        m = res["models"][k]
        cov = f"{m['cov90']:.3f}" if m["cov90"] is not None else "—"
        cova = f"{m['cov90_all']:.3f}" if m["cov90_all"] is not None else "—"
        print(f"{name[k]:<22}{m['MAE']:>9.4f}{m['RMSE']:>9.4f}"
              f"{m['MedAE']:>9.4f}{m['MAE_nz']:>11.4f}{cov:>11}{cova:>10}")
    print("-" * 78)
    t = res["models"]["twin_kalman"]
    e = res["models"]["m1_existing_exp"]
    p = res["models"]["m2_persistence"]
    print(f"对 m1_existing_exp：MAE {t['MAE']:.4f} vs {e['MAE']:.4f} "
          f"→ {'改善' if t['MAE'] < e['MAE'] else '变差'} "
          f"{(1 - t['MAE'] / e['MAE']) * 100:+.2f}%")
    print(f"对 m2_persistence：  MAE {t['MAE']:.4f} vs {p['MAE']:.4f} "
          f"→ {'改善' if t['MAE'] < p['MAE'] else '变差'} "
          f"{(1 - t['MAE'] / p['MAE']) * 100:+.2f}%")

    print()
    print("按事件类型拆分（PR 再完井 51 井 / SI 关井复产 26 井）：")
    print(f"{'':<22}{'PR MAE':>10}{'SI MAE':>10}")
    for k in ("twin_kalman", "m1_existing_exp", "m2_persistence"):
        kk = {"twin_kalman": "twin", "m1_existing_exp": "m_exp",
              "m2_persistence": "m_persist"}[k]
        mp = _metrics([r for r in rows if r["status"] == "PR"], kk)["MAE"]
        ms = _metrics([r for r in rows if r["status"] == "SI"], kk)["MAE"]
        print(f"{name[k]:<22}{mp:>10.4f}{ms:>10.4f}")

    # 12 月累计口径（与 NPV 同源）
    KEY = {"twin_kalman": "twin", "m1_existing_exp": "m_exp",
           "m2_persistence": "m_persist"}

    def cum(key):
        tot = []
        for api8 in {r["api8"] for r in rows}:
            rs = [r for r in rows if r["api8"] == api8]
            a = sum(r["actual"] * 30.4 for r in rs)
            m = sum(r[key] * 30.4 for r in rs if not math.isnan(r[key]))
            tot.append(m - a)
        return st.mean(tot), st.median(tot)

    print()
    print("12 月累计产量偏差（m³，均值 / 中位）：")
    for k in ("twin_kalman", "m1_existing_exp"):
        mu, md = cum(KEY[k])
        print(f"  {name[k]:<22}{mu:>12.1f} / {md:>10.1f}")
    print("=" * 78)


def horizon_eval(series, events, horizons=(1, 3, 6, 12), params=Params):
    """固定原点外推：事件前最后一月为原点，直接预测 h 个月后，中途不更新。

    这一步是为了回答一个必须回答的问题：一步预测上「持续性基线」很强，
    那状态空间的价值在哪？——在 h 变大以后。持续性没有趋势项，误差随 h 线性涨；
    Twin 有递减项并且带不确定度，误差涨得慢。这张表就是它的辩护。
    """
    out = {}
    for h in horizons:
        rows = []
        for api8, ev in events.items():
            obs = series.get(api8, [])
            pre = [o for o in obs if o.mi < ev.mi]
            if len(pre) < 3:
                continue
            twin = TwinState(api8, ev, params)
            last_nz = None
            for o in pre:
                twin.process(o)
                if o.usable:
                    last_nz = o.rate
            target = [o for o in obs if o.mi == ev.mi + h - 1]
            if not target or last_nz is None:
                continue
            q_hat, _, sd_pred = twin.predict_next(horizon=h)
            if q_hat is None:
                continue
            rows.append({"actual": target[0].rate, "twin": q_hat,
                         "m_exp": baseline_exp(ev, h), "m_persist": last_nz,
                         "twin_lo": max(0.0, q_hat - 1.645 * q_hat * sd_pred),
                         "twin_hi": q_hat + 1.645 * q_hat * sd_pred})
        out[h] = _metrics(rows, "twin") | {
            "m_exp_MAE": _metrics(rows, "m_exp")["MAE"],
            "m_persist_MAE": _metrics(rows, "m_persist")["MAE"],
        }
    return out


def print_horizon(res):
    print("=" * 78)
    print("固定原点外推 · 误差随 h 的增长（同一批井，中途不更新）")
    print("=" * 78)
    print(f"{'h(月)':>6}{'n':>6}{'Twin MAE':>11}{'指数基线':>11}{'持续性':>11}"
          f"{'对持续性':>11}")
    print("-" * 78)
    for h in sorted(res):
        m = res[h]
        gain = (1 - m["MAE"] / m["m_persist_MAE"]) * 100
        print(f"{h:>6}{m['n']:>6}{m['MAE']:>11.4f}{m['m_exp_MAE']:>11.4f}"
              f"{m['m_persist_MAE']:>11.4f}{gain:>10.1f}%")
    print("-" * 78)
    print("持续性基线 = 原点前面最后一个非零实测值，恒定外推。")
    print("=" * 78)


# ---------------------------------------------------------------- 断言
def run_asserts(series, events, params=Params):
    print("=" * 78)
    print("T13 · 附加断言（P14 §5）")
    print("=" * 78)
    fails = 0

    # 1) 物理范围：全部 77 井跑完整时序
    bad = []
    for api8, ev in events.items():
        twin = TwinState(api8, ev, params)
        for o in series.get(api8, []):
            s = twin.process(o)["s"]
            if not (s["q"] >= params.q_min - 1e-9
                    and params.d_min - 1e-9 <= s["d"] <= params.d_max + 1e-9
                    and params.r_min - 1e-9 <= s["r"] <= params.r_max + 1e-9
                    and params.h_min - 1e-9 <= s["h"] <= params.h_max + 1e-9):
                bad.append((api8, o.mi, s))
    print(f"[1] 物理范围 q>=0, d∈[0,0.3], r∈[0,5], h∈[0,1] : "
          f"{'PASS' if not bad else 'FAIL'}  越界 {len(bad)} 次")
    fails += 0 if not bad else 1

    # 2) 幂等：同一观测喂两次，状态必须逐位相同
    drift = 0.0
    for api8, ev in list(events.items())[:20]:
        twin = TwinState(api8, ev, params)
        obs = series.get(api8, [])
        for o in obs[-20:]:
            s1 = twin.process(o)["s"]
            s2a = twin.snapshot()["s"]
            twin.process(o)                      # 重复喂
            s2 = twin.snapshot()["s"]
            for k in ("q", "d", "r", "h"):
                drift = max(drift, abs(s1[k] - s2[k]), abs(s2a[k] - s2[k]))
    print(f"[2] 幂等（同一观测重复喂，状态不漂）     : "
          f"{'PASS' if drift == 0.0 else 'FAIL'}  最大漂移 {drift:.3e}")
    fails += 0 if drift == 0.0 else 1

    # 3) 确定性：同样输入两次跑，结果逐位相同
    a = [TwinState(k, v, params).process(o)["s"]["q"]
         for k, v in list(events.items())[:5]
         for o in series.get(k, [])[-3:]]
    b = [TwinState(k, v, params).process(o)["s"]["q"]
         for k, v in list(events.items())[:5]
         for o in series.get(k, [])[-3:]]
    print(f"[3] 确定性（同输入同输出）               : "
          f"{'PASS' if a == b else 'FAIL'}  n={len(a)}")
    fails += 0 if a == b else 1

    print("-" * 78)
    print(f"断言合计：{'全 PASS' if fails == 0 else f'{fails} 条 FAIL'}")
    print("=" * 78)
    return fails


# ---------------------------------------------------------------- 敏感性
def run_sens(series, events):
    print("=" * 78)
    print("超参敏感性（3x3，不是调参，是看结论稳不稳）")
    print("=" * 78)
    print(f"{'sd_obs':>8}{'sd_d':>8}{'MAE':>10}{'对 M1 改善':>12}")
    base = None
    for sd_obs in (0.20, 0.30, 0.40):
        for sd_d in (0.004, 0.008, 0.016):
            p = Params()
            p.sd_obs, p.sd_d = sd_obs, sd_d
            res, _ = one_step_eval(series, events, params=p)
            t = res["models"]["twin_kalman"]["MAE"]
            e = res["models"]["m1_existing_exp"]["MAE"]
            if base is None:
                base = t
            print(f"{sd_obs:>8.2f}{sd_d:>8.3f}{t:>10.4f}{(1 - t / e) * 100:>11.2f}%")
    print("-" * 78)
    print("（sd_obs 固定 0.30 / sd_d 固定 0.008 为本文采用的先验值，其余为敏感性对照）")
    print("=" * 78)


# ---------------------------------------------------------------- 导出
def export_states(series, events, path):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    out = {"schema": "twin_state/1.0", "generated_by": "pipeline/twin_state.py",
           "s_fields": ["q", "d", "r", "h"],
           "physical": {"q": [0, None], "d": [0, 0.3], "r": [0, 5], "h": [0, 1]},
           "wells": {}}
    for api8, ev in events.items():
        twin = TwinState(api8, ev)
        for o in series.get(api8, []):
            twin.process(o)
        snap = twin.snapshot()
        out["wells"][api8] = snap
    with open(path, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=1)
    qs = [w["s"]["q"] for w in out["wells"].values() if w["s"]]
    hs = [w["s"]["h"] for w in out["wells"].values() if w["s"]]
    print(f"已写出 {path} · {len(out['wells'])} 井 · "
          f"q 中位 {st.median(qs):.3f} · h 中位 {st.median(hs):.3f}")
    return out


# ---------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--eval", action="store_true")
    ap.add_argument("--identify", action="store_true")
    ap.add_argument("--horizon", action="store_true")
    ap.add_argument("--states", action="store_true")
    ap.add_argument("--assert", dest="do_assert", action="store_true")
    ap.add_argument("--sens", action="store_true")
    ap.add_argument("--all", action="store_true")
    a = ap.parse_args()
    if not any([a.eval, a.horizon, a.states, a.do_assert, a.sens, a.identify, a.all]):
        a.all = True

    d = find_data_dir()
    series = load_series(os.path.join(d, "pilot_series.csv"))
    events = load_events(os.path.join(d, "pilot_events_v2c.csv"))
    print(f"数据目录：{d}")
    print(f"井 {len(series)} · 事件 {len(events)} · "
          f"井月 {sum(len(v) for v in series.values())}\n")

    if a.identify or a.all:
        print_identify(series)
        print()
    if a.do_assert or a.all:
        run_asserts(series, events)
        print()
    if a.eval or a.all:
        res, rows = one_step_eval(series, events)
        print_eval(res, rows)
        print()
    if a.horizon or a.all:
        print_horizon(horizon_eval(series, events))
        print()
    if a.sens:
        run_sens(series, events)
        print()
    if a.states or a.all:
        export_states(series, events, os.path.join(OUT_DIR, "twin_states.json"))


if __name__ == "__main__":
    main()
