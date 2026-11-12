#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""T14 · 事件驱动状态机

给每口井一个生命周期状态，每个月一个：
    正常 NORMAL → 候选 CANDIDATE → 已措施 TREAT → 响应期 RESPONSE
        → 见效 EFFECTIVE / 无效 INEFFECTIVE → 衰减 DECLINE → 关井 SHUT

和 T13 的关系：状态机的可观测量全部来自 `twin_state` 的 s_t = [q, d, r, h]，
不另起一套口径。q/dt 只用来判定「产能是否还在」，h 判健康，r 判响应。

**与四象限的关系（关键，别搞混）**
    四象限（绿 19 / 黄 35 / 红 17 / 灰 6）判的是 `P(NPV>0)`，是**经济口径的预测**；
    状态机判的是「这口井现在处于生命周期的哪一步」，是**物理口径的描述**。
    两者不同源，必然对不上。本文件的验收标准不是「对齐」，而是**每个差异都能给出数值解释**。

用法：
    python twin_fsm.py --all        # 状态定义 / 驻留 / 转移 / 四象限对照
    python twin_fsm.py --states     # 导出 77 井状态序列与当前状态
    python twin_fsm.py --compare    # 只跑四象限对照

作者：算法专家 · 2026-11-10 · 依赖 twin_state.py，仅标准库
"""
from __future__ import annotations

import argparse
import collections
import csv
import json
import math
import os
import statistics as st

import twin_state as T

HERE = os.path.dirname(os.path.abspath(__file__))
PROJ = os.path.abspath(os.path.join(HERE, "..", ".."))
OUT_DIR = os.path.join(HERE, "out")

BUNDLE = os.path.join(PROJ, "04_数据", "bundle_v3.json")
EVENTS = os.path.join(PROJ, "04_数据", "events.csv")

STATES = ["NORMAL", "CANDIDATE", "TREAT", "RESPONSE",
          "EFFECTIVE", "INEFFECTIVE", "DECLINE", "SHUT"]
ZH = {"NORMAL": "正常", "CANDIDATE": "候选", "TREAT": "已措施",
      "RESPONSE": "响应期", "EFFECTIVE": "见效", "INEFFECTIVE": "无效",
      "DECLINE": "衰减", "SHUT": "关井"}

R_WINDOW = 3          # 响应期长度（月），与 twin_state.Params.r_window 一致
R_GOOD = 1.05         # 见效阈值：响应强度 >= 1.05 记见效（+5% 以上才算有响应）
R_BAD = 0.95          # 无效阈值：< 0.95 记无效；中间地带按「无效侧」处理
H_WEAK = 0.40         # 健康度低于此进候选池
D_FAST = 0.10         # 月递减超过 10% 进候选池
D_SLOW = 0.03         # 月递减 <= 3% 且健康 >= 0.60 判正常
H_OK = 0.60
MIN_PRE_NZ = 6        # 与 bundle gray 规则同源：事件前非零月 < 6 → 证据不足


# ---------------------------------------------------------------- 数据
def load_bundle():
    b = json.load(open(BUNDLE, encoding="utf-8"))
    out = {}
    for w in b["wells"]:
        out[w["well_id"]] = {
            "state": w["state"], "npv": w["value_npv"], "anchor": w["anchor"],
            "reason": w.get("state_reason", ""),
            "zero_prob": w.get("zero_prob"),
        }
    return out, b


def load_labels():
    """事件级标签（只用于评估对照，绝不进状态判定）。"""
    out = {}
    with open(EVENTS, encoding="utf-8") as f:
        for r in csv.DictReader(f):
            a12 = float(r["actual12"] or 0)
            b12 = float(r["base12"] or 0)
            out["CO" + r["api8"]] = {
                "actual12": a12, "base12": b12,
                "ratio": (a12 / b12) if b12 > 0 else float("nan"),
                "pre_nz": float(r["pre_nz"] or 0),
                "y_zero": int(r["y_zero"] or 0),
            }
    return out


# ---------------------------------------------------------------- 状态判定
def baseline(ev, k):
    """无措施反事实：base_incl × exp(-D_fit·k)，与 P13 §1.1 的 base12 同源。"""
    return ev.base_incl * math.exp(-ev.D_fit * k)


def classify(o, ev, twin, sus=None):
    """单月状态判定。只用**截至本月**的可观测量，不看未来。

    注意顺序：关井 > 已措施 > 响应期 > 见/无效 > 候选 > 衰减 > 正常。
    关井排最前，因为 `days_produced = 0` 时其余量都不可观测。

    「见效/无效」不用峰值 r 判 —— 峰值区分不了好坏（实测：红盘 r 中位 1.364
    反而高于绿盘 1.277，而两者 ratio 中位是 1.04 vs 2.99，差的是持续性）。
    改用**累计响应倍数**：截至本月，第 4 个月起 actual/baseline 的累计均值。
    """
    if o.days <= 0 or o.rate <= 1e-9:
        return "SHUT"
    diff = o.mi - ev.mi
    if diff == 0:
        return "TREAT"
    if 1 <= diff <= R_WINDOW:
        return "RESPONSE"
    if R_WINDOW < diff <= 12:
        if sus is None:
            return "INEFFECTIVE"
        return "EFFECTIVE" if sus >= R_GOOD else "INEFFECTIVE"
    h = twin.h
    d = float(twin.x[1])
    if h < H_WEAK or d > D_FAST:
        return "CANDIDATE"
    if d <= D_SLOW and h >= H_OK:
        return "NORMAL"
    return "DECLINE"


def run_well(api8, obs, ev):
    """跑一口井的完整状态序列。返回 [(mi, state, 观测量)]。"""
    twin = T.TwinState(api8, ev)
    seq = []
    acc = []                      # 第 4 个月起的 actual/baseline 累计
    for o in obs:
        snap = twin.process(o)
        k = o.mi - ev.mi
        if R_WINDOW < k <= 12 and o.usable:
            b = baseline(ev, k)
            if b > 1e-9:
                acc.append(o.rate / b)
        sus = (sum(acc) / len(acc)) if acc else None
        stt = classify(o, ev, twin, sus)
        seq.append({
            "mi": o.mi, "state": stt, "rate": o.rate, "days": o.days,
            "q": snap["s"]["q"] if snap["s"] else None,
            "d": snap["s"]["d"] if snap["s"] else None,
            "r": snap["s"]["r"] if snap["s"] else None,
            "h": snap["s"]["h"] if snap["s"] else None,
            "sus": sus,
        })
    return seq


# ---------------------------------------------------------------- 统计
def dwell_stats(seqs):
    """每状态的驻留时长（连续月数）分布。"""
    out = collections.defaultdict(list)
    for seq in seqs:
        cur, n = None, 0
        for row in seq:
            if row["state"] == cur:
                n += 1
            else:
                if cur is not None:
                    out[cur].append(n)
                cur, n = row["state"], 1
        if cur is not None:
            out[cur].append(n)
    return out


def transitions(seqs):
    cnt = collections.Counter()
    for seq in seqs:
        for a, b in zip(seq, seq[1:]):
            cnt[(a["state"], b["state"])] += 1
    return cnt


def print_transition(cnt):
    print("=" * 96)
    print("转移概率矩阵（月度，行归一；样本 = 77 井全部相邻月对）")
    print("=" * 96)
    tot = {a: sum(v for (x, _), v in cnt.items() if x == a) for a in STATES}
    head = "自 \\ 到".ljust(14) + "".join(f"{ZH[s][:4]:>9}" for s in STATES) + f"{'n':>8}"
    print(head)
    print("-" * 96)
    for a in STATES:
        if tot[a] == 0:
            continue
        row = f"{ZH[a]:<12}" + "".join(
            f"{cnt[(a, b)] / tot[a]:>9.3f}" if tot[a] else f"{'—':>9}"
            for b in STATES)
        print(row + f"{tot[a]:>8}")
    print("-" * 96)


def print_dwell(dw):
    print("=" * 96)
    print("驻留时长分布（连续月数；只统计完整游程，右删失的末段也计入）")
    print("=" * 96)
    print(f"{'状态':<10}{'游程数':>8}{'中位':>8}{'均值':>8}{'P90':>8}{'最长':>8}")
    print("-" * 96)
    for s in STATES:
        v = dw.get(s) or []
        if not v:
            continue
        v = sorted(v)
        print(f"{ZH[s]:<10}{len(v):>8}{st.median(v):>8.1f}{st.mean(v):>8.2f}"
              f"{v[int(len(v) * 0.9) - 1]:>8}{max(v):>8}")
    print("-" * 96)
    print("说明：响应期 / 见效 / 无效 三态的驻留长度由规则窗口直接决定（3 / 9 / 9 月），")
    print("      不是数据发现的分布，读它们只看转移概率，别看驻留均值。")
    print("      有经验内容的是 正常 / 候选 / 衰减 / 关井 四态。")


def print_observables(seqs):
    """每状态的可观测量（中位数），证明状态不是凭空贴标签。"""
    print("=" * 96)
    print("每状态的可观测量（中位；n 为井月数）")
    print("=" * 96)
    acc = collections.defaultdict(lambda: collections.defaultdict(list))
    for seq in seqs:
        for row in seq:
            for k in ("rate", "days", "q", "d", "r", "h"):
                v = row.get(k)
                if v is not None:
                    acc[row["state"]][k].append(v)
    print(f"{'状态':<10}{'n':>7}{'rate':>9}{'days':>7}{'q':>9}{'d':>8}{'r':>7}{'h':>7}")
    print("-" * 96)
    for stt in STATES:
        d = acc.get(stt)
        if not d:
            continue
        g = lambda k: st.median(d[k]) if d[k] else float("nan")
        print(f"{ZH[stt]:<10}{len(d['rate']):>7}{g('rate'):>9.3f}{g('days'):>7.1f}"
              f"{g('q'):>9.3f}{g('d'):>8.3f}{g('r'):>7.3f}{g('h'):>7.3f}")
    print("-" * 96)


# ---------------------------------------------------------------- 四象限推导
def fsm_color_at_event(seq, ev, labels):
    """**事件时点**由状态机推出的颜色（只用事件前信息，不含 r）。

    这是唯一能和四象限对着比的口径：四象限也是事件时点的判断。
    快照时点的颜色另一套，见 snapshot_color()，两者不可混用。

    两个不能踩的坑（都已踩过）：
    1. 不能拿「最后一个月是不是关井」判灰/红 —— 28/77 口井在措施前一个月是关井的，
       那是作业前压井的常规动作，不是「没证据」也不是「井况差」。
       所以状态取**最后一个产油月**，与 base_incl 的口径（末 3 个非零月）同源。
    2. 灰必须给物理判据：事件前 12 个月里关井 >= 6 个月（一半时间不产）→ 状态不可判，
       这才叫证据不足，不是「我不确定」。
    """
    pre = [row for row in seq if row["mi"] < ev.mi]
    if not pre:
        return "gray", "无事件前观测"
    last12 = [row for row in pre[-12:]]
    shut12 = sum(1 for row in last12 if row["state"] == "SHUT")
    if shut12 >= 6:
        return "gray", f"事件前 12 月关井 {shut12} 个月，状态不可判"
    prod = [row for row in pre if row["state"] != "SHUT"]
    if not prod:
        return "gray", "事件前无产油月"
    last = prod[-1]["state"]
    if last == "NORMAL":
        return "green", "末个产油月=正常（d<=3% 且 h>=60%）"
    if last == "DECLINE":
        return "yellow", "末个产油月=衰减（3%<d<=10%）"
    return "red", f"末个产油月={ZH.get(last, last)}（h<40% 或 d>10%，井况差）"


def snapshot_color(row):
    """**快照时点**（最后观测月）的颜色，描述当前生命周期，不做经济判断。"""
    s = row["state"]
    if s == "SHUT":
        return "gray"
    if s in ("NORMAL", "EFFECTIVE"):
        return "green"
    if s in ("CANDIDATE", "INEFFECTIVE"):
        return "red"
    return "yellow"


def compare(bundle, labels, seqs, events):
    """状态机推导 vs 四象限。"""
    rows = []
    for api8, ev in events.items():
        seq = seqs.get(api8)
        if not seq:
            continue
        wid = api8 if api8.startswith("CO") else "CO" + api8
        bw = bundle.get(wid)
        if not bw:
            continue
        lab = labels.get(wid, {})
        col, why = fsm_color_at_event(seq, ev, labels)
        rows.append({"api8": api8, "fsm": col, "why": why,
                     "bundle": bw["state"], "npv": bw["npv"],
                     "ratio": lab.get("ratio", float("nan")),
                     "anchor": bw["anchor"], "pre_nz": lab.get("pre_nz")})
    return rows


def print_compare(rows):
    print("=" * 96)
    print("状态机推导的四色 vs 现有四象限（事件时点，同一批 77 井）")
    print("=" * 96)
    fsm_cnt = collections.Counter(r["fsm"] for r in rows)
    bun_cnt = collections.Counter(r["bundle"] for r in rows)
    order = ["green", "yellow", "red", "gray"]
    print(f"{'':<10}{'状态机':>10}{'bundle':>10}{'差':>8}")
    for c in order:
        print(f"{c:<10}{fsm_cnt.get(c, 0):>10}{bun_cnt.get(c, 0):>10}"
              f"{fsm_cnt.get(c, 0) - bun_cnt.get(c, 0):>8}")
    print(f"{'合计':<10}{sum(fsm_cnt.values()):>10}{sum(bun_cnt.values()):>10}")
    print()
    print("混淆矩阵（行 = 状态机 fsm_color，列 = bundle state）")
    print(f"{'':<10}" + "".join(f"{c:>10}" for c in order) + f"{'n':>8}")
    for a in order:
        line = f"{a:<10}"
        for b in order:
            line += f"{sum(1 for r in rows if r['fsm'] == a and r['bundle'] == b):>10}"
        print(line + f"{sum(1 for r in rows if r['fsm'] == a):>8}")
    agree = sum(1 for r in rows if r["fsm"] == r["bundle"])
    print(f"\n一致 {agree}/{len(rows)} = {agree / len(rows):.1%}"
          f"（事件时点口径；最新快照口径见 §0 / §1-A，两个数不可互换）")
    print("（不一致不是错误：四象限判 P(NPV>0)，状态机判生命周期位置，见差异解释）")


def verdict_vs_quadrant(seqs, bundle, labels):
    """状态机的事后判定（见效/无效）vs 四象限。

    这是本文第二张对照表，比「颜色对颜色」有意义：四象限是**先验判断**，
    状态机的见效/无效是同一批井**事后实测**的结论。拿它去量四象限，
    回答的是「说绿的井，后来到底有没有持续响应」。
    """
    print("=" * 96)
    print("事后判定 vs 四象限：说绿的井后来真见效了吗")
    print("=" * 96)
    rows = []
    for api8, seq in seqs.items():
        wid = api8 if api8.startswith("CO") else "CO" + api8
        bw = bundle.get(wid)
        if not bw:
            continue
        sus = None
        for row in reversed(seq):
            if row.get("sus") is not None:
                sus = row["sus"]
                break
        rows.append({"api8": api8, "sus": sus, "bundle": bw["state"],
                     "ratio": labels.get(wid, {}).get("ratio", float("nan")),
                     "npv": bw["npv"]})
    print(f"{'四象限':<8}{'n':>5}{'可判':>6}{'见效':>6}{'见效率':>8}"
          f"{'sus中位':>10}{'ratio中位':>10}{'NPV中位':>10}")
    print("-" * 96)
    order = ["green", "yellow", "red", "gray"]
    for q in order:
        sub = [r for r in rows if r["bundle"] == q]
        ok = [r for r in sub if r["sus"] is not None]
        if not sub:
            continue
        eff = [r for r in ok if r["sus"] >= R_GOOD]
        rate = (len(eff) / len(ok)) if ok else float("nan")
        rr = [r["ratio"] for r in sub if not math.isnan(r["ratio"])]
        print(f"{q:<8}{len(sub):>5}{len(ok):>6}{len(eff):>6}{rate:>8.1%}"
              f"{st.median([r['sus'] for r in ok]):>10.3f}"
              f"{st.median(rr):>10.3f}"
              f"{st.median([r['npv'] for r in sub]):>+10.1f}")
    print("-" * 96)
    allok = [r for r in rows if r["sus"] is not None]
    base_rate = sum(1 for r in allok if r["sus"] >= R_GOOD) / len(allok)
    n_zero = sum(1 for r in rows if r["sus"] is None)
    print(f"全样本见效率 {base_rate:.1%}（阈值 sus ≥ {R_GOOD}，分母 = 可判井 n={len(allok)}；"
          f"另有 {n_zero} 口无可测月未进分母，含零产井）")
    print("口径三分量必须带齐：分母（可判/全样本）+ 阈值 + 方向。"
          "缺任一项不得单独引用「见效率」。")
    print("读法：绿/红之间的见效率差 = 四象限的先验判断有多少被事后证实。")
    print()
    return rows


def explain(rows):
    """颜色不一致的解释：按数据自动判读，不硬写解释词。

    关键口径（查过，别再混）：`value_npv` 是按**预测曲线**算的期望值，不是实测。
    所以四象限是「先验判断」，`ratio` 是「事后真相」，两者放一起才有信息量：
        ratio < 1  → 这口井实际跑输自身递减基线，bundle 保守是对的
        ratio > 1  → 实际跑赢了，bundle 保守了
    """
    print()
    print("=" * 96)
    print("差异解释（ratio = 实测12月累产 / 自身递减基线；<1 即跑输，bundle 保守成立）")
    print("=" * 96)
    groups = collections.defaultdict(list)
    for r in rows:
        if r["fsm"] != r["bundle"]:
            groups[(r["fsm"], r["bundle"])].append(r)

    print(f"{'迁移':<16}{'n':>4}{'ratio中位':>10}{'ratio均值':>10}"
          f"{'ratio<1':>9}{'NPV期望中位':>12}{'判读':>4}")
    print("-" * 96)
    for (a, b), rs in sorted(groups.items(), key=lambda kv: -len(kv[1])):
        rr = [r["ratio"] for r in rs if not math.isnan(r["ratio"])]
        if not rr:
            continue
        low = sum(1 for x in rr if x < 1.0) / len(rr)
        if low >= 0.70:
            verdict = "事后多数跑输 → bundle 保守成立"
        elif low <= 0.30:
            verdict = "事后多数跑赢 → bundle 保守过头"
        else:
            verdict = "混合组，中位不代表方向（看两端）"
        print(f"{a + '→' + b:<16}{len(rs):>4}{st.median(rr):>10.3f}"
              f"{st.mean(rr):>10.3f}{low:>8.0%}"
              f"{st.median([r['npv'] for r in rs]):>+12.1f}")
        print(f"    {verdict}")
    print("-" * 96)
    agree = sum(1 for r in rows if r["fsm"] == r["bundle"])
    print(f"颜色一致 {agree}/{len(rows)} = {agree / len(rows):.1%}。")
    print("四象限问「做得值不值」（按预测算钱），状态机问「现在走到哪一步」（按实测判位置）。")
    print("两者冲突时不要去调阈值凑一致——要去查那口井到底怎么了。")
    print()


def hard_misses(bundle, labels, seqs, rows):
    """抓出「四象限说好、实测却塌了」的井。这是模型真正失手的地方。"""
    print("=" * 96)
    print("硬失手清单：bundle 给绿（期望 NPV>0），实测 ratio<0.5")
    print("=" * 96)
    miss = []
    for r in rows:
        if r["bundle"] != "green":
            continue
        if math.isnan(r["ratio"]) or r["ratio"] >= 0.5:
            continue
        miss.append(r)
    if not miss:
        print("（无）")
        return miss
    print(f"{'井':<14}{'实测ratio':>10}{'期望NPV':>10}{'anchor':>9}{'状态机为何':<28}")
    print("-" * 96)
    for r in sorted(miss, key=lambda x: x["ratio"]):
        print(f"{r['api8']:<14}{r['ratio']:>10.3f}{r['npv']:>+10.1f}"
              f"{r['anchor']:>9.3f}  {r['why'][:26]}")
    print("-" * 96)
    print(f"共 {len(miss)} 口。共同点：都是**预测能大幅增产、实测几乎不产**。")
    print("这不是状态机判错，是零产/停产不可预测（P13 短板 1）在决策层的直接体现——")
    print("模型给的是「期望」，不是「承诺」，绿盘不能当推荐名单（state_confusion §2b 同结论）。")
    print()
    return miss


# ---------------------------------------------------------------- 导出
def export(bundle, events, seqs, path):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    out = {"schema": "twin_fsm/1.0", "states": STATES,
           "zh": ZH,
           "params": {"r_window": R_WINDOW, "r_good": R_GOOD, "r_bad": R_BAD,
                      "h_weak": H_WEAK, "d_fast": D_FAST, "d_slow": D_SLOW,
                      "h_ok": H_OK, "min_pre_nz": MIN_PRE_NZ},
           "authority": "state/color 的唯一权威 = bundle wells[].state（D-030）；"
                        "fsm_state/fsm_color 仅用于迁移与时序回放，不驱动三维上色",
           "wells": {}}
    for api8, seq in seqs.items():
        if not seq:
            continue
        last = seq[-1]
        # D-030：state / color 的唯一权威是 bundle wells[].state。
        # 这里只给 fsm_* 前缀，供「迁移与时序回放」用，不得驱动三维上色。
        out["wells"][api8] = {
            "ts": last["mi"], "fsm_state": last["state"],
            "fsm_color": snapshot_color(last),
            "s": {k: last[k] for k in ("q", "d", "r", "h")},
            "n_months": len(seq),
            "seq": [[r["mi"], r["state"]] for r in seq],
        }
    json.dump(out, open(path, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    cnt = collections.Counter(w["fsm_state"] for w in out["wells"].values())
    print(f"已写出 {path} · {len(out['wells'])} 井 · 当前状态分布 "
          f"{dict(sorted(cnt.items(), key=lambda kv: -kv[1]))}")
    return out


# ---------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--all", action="store_true")
    ap.add_argument("--compare", action="store_true")
    ap.add_argument("--states", action="store_true")
    a = ap.parse_args()
    if not any([a.all, a.compare, a.states]):
        a.all = True

    d = T.find_data_dir()
    series = T.load_series(os.path.join(d, "pilot_series.csv"))
    events = T.load_events(os.path.join(d, "pilot_events_v2c.csv"))
    bundle, _ = load_bundle()
    labels = load_labels()
    print(f"井 {len(series)} · 事件 {len(events)} · bundle 井 {len(bundle)}\n")

    seqs = {}
    for api8, ev in events.items():
        obs = series.get(api8, [])
        if obs:
            seqs[api8] = run_well(api8, obs, ev)

    if a.all or a.states:
        n = sum(len(s) for s in seqs.values())
        print(f"状态序列：{len(seqs)} 井 · {n} 个井月\n")
        export(bundle, events, seqs, os.path.join(OUT_DIR, "twin_fsm.json"))
        print()

    if a.all or a.compare:
        dw = dwell_stats(seqs.values())
        print_dwell(dw)
        print()
        print_observables(seqs.values())
        print()
        print_transition(transitions(seqs.values()))
        print()
        rows = compare(bundle, labels, seqs, events)
        print_compare(rows)
        explain(rows)
        hard_misses(bundle, labels, seqs, rows)
        verdict_vs_quadrant(seqs, bundle, labels)


if __name__ == "__main__":
    main()
