#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
P1 · bundle v3.1 构建（数据管道）

输入：
  release/pilot_bundle_final77.json                        基线（只增不改）
  09_开源数据平替/.../pilot/pilot_events_v2c.csv            事件表
  09_开源数据平替/.../pilot/pilot_series.csv                月序列
  frontend/src/data/geo.json                               P2 井位（可选）

输出：
  frontend/src/data/bundle_v3.json
  release_v3/bundle_v3.json
  release_v3/SHA256SUMS.txt

纪律：
  · 只增不改——旧字段名一个不动（唯一例外：uncertainty.aleatoric 100 → null，修 B7）
  · 不编数字——actual 缺失写 null，绝不填 0 冒充实测
  · 每条断言必须能打印出实测值

用法：
  python pipeline/build_bundle_v31.py
  python pipeline/build_bundle_v31.py --check   # 只校验，不写文件
"""
import os
import sys
import csv
import json
import math
import hashlib
import collections

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
PILOT = os.path.join(ROOT, "09_开源数据平替", "reports",
                     "cogis_pilot_run_40479938455", "pilot")
# D-013：04_数据/原始数据 为唯一运行期数据源，09 为只读归档回退
PILOT_04 = os.path.join(ROOT, "..", "04_数据", "原始数据")
if os.path.isdir(PILOT_04):
    PILOT = PILOT_04
BASE = os.path.join(ROOT, "release", "pilot_bundle_final77.json")
GEO = os.path.join(ROOT, "frontend", "src", "data", "geo.json")
OUT_DEV = os.path.join(ROOT, "frontend", "src", "data", "bundle_v3.json")
OUT_REL = os.path.join(ROOT, "release_v3", "bundle_v3.json")

SCHEMA_VERSION = "3.1"
DATA_RELEASE = "v3.1"
SEED = 20260101

# 经济口径（与论文/旧 bundle 一致，不得随意改）
PRICE_WAN_PER_M3 = 0.323
WELL_COST_WAN = 45.0
DAYS_PER_MONTH = 30.4
HORIZON = 12

# 候选池
POOL_K = 20


# ---------------------------------------------------------------- 读原始数据

def load_raw():
    events = list(csv.DictReader(open(os.path.join(PILOT, "pilot_events_v2c.csv"),
                                      encoding="utf-8")))
    series = {}
    for r in csv.DictReader(open(os.path.join(PILOT, "pilot_series.csv"),
                                 encoding="utf-8")):
        series.setdefault(r["api8"], {})[int(r["mi"])] = float(r["rate_m3d"])
    return events, series


def event_actual(ev_row, series):
    """事件后 12 个月的 (month_str, oil|null) 序列。

    缺记录 → oil=None（不填 0）；记录存在但产量 0 → oil=0.0（真实停产）。
    本批实测 post_missing 全 0，77 口井 12 个月全部有记录。
    """
    y, m = int(ev_row["event_month"][:4]), int(ev_row["event_month"][5:7])
    mi0 = y * 12 + m - 1
    api = ev_row["api8"]
    d = series.get(api, {})
    out = []
    for k in range(1, HORIZON + 1):
        mi = mi0 + k
        yy, mm = (mi) // 12, (mi) % 12 + 1
        month = f"{yy:04d}-{mm:02d}"
        out.append({"month": month, "oil": d.get(mi)})
    return out


def base12_of(curve):
    return sum(p["oil"] for p in curve["baseline"]) * DAYS_PER_MONTH


def pred12_of(curve):
    return sum(p["oil"] for p in curve["prediction"]) * DAYS_PER_MONTH


# ---------------------------------------------------------------- 主构建

def build():
    with open(BASE, "r", encoding="utf-8") as f:
        b = json.load(f)
    events, series = load_raw()

    ev_by_api = {e["api8"]: e for e in events}
    curve_by_id = {c["well_id"]: c for c in b["curves"]}

    # ---------- 1. meta ----------
    meta = b["meta"]
    meta["dataset_id"] = "cogcc-weld-v3"
    meta["data_release"] = DATA_RELEASE
    meta["release"] = DATA_RELEASE
    meta["model_version"] = "anbm+lsdrt-v2+conformal-final77"   # 模型未换代，只升数据契约
    meta["generated_at"] = _now()
    meta["seed"] = SEED

    # B6：120 与 77 分列 + 解释
    meta["residual_pool_n"] = 120
    meta["n_wells_fit"] = 77
    meta["pool_note"] = (
        "残差因子池含 120 个折外样本，来自 v2 训练批（2149 事件逐步筛至 120 折外残差）；"
        "本批决策评估仅 77 口井（每井一事件）。两者口径不同，不可混用。"
    )

    # D9：范围与年份分布
    yh = collections.Counter(e["event_month"][:4] for e in events)
    meta["scope"] = {
        "county": "WELD",
        "event_month_min": min(e["event_month"] for e in events),
        "event_month_max": max(e["event_month"] for e in events),
        "year_hist": {str(y): yh.get(str(y), 0) for y in range(2014, 2025)},
        "note": "单一县（WELD），事件时间跨度 2014-09 ~ 2024-08，年份分布不均，见 year_hist",
    }

    # ---------- 2. assumptions（B8）----------
    b["assumptions"] = {
        "oil_price_cny_per_t": 3800,
        "oil_density_t_per_m3": 0.85,
        "price_wan_per_m3": PRICE_WAN_PER_M3,
        "well_cost_wan": WELL_COST_WAN,
        "discount_rate_annual": 0.0,
        "days_per_month": DAYS_PER_MONTH,
        "evaluation_horizon_months": HORIZON,
        "currency": "CNY",
        "registry": [
            {"key": "price_wan_per_m3",
             "formula": "oil_price_cny_per_t × oil_density_t_per_m3 / 10000",
             "value": 0.323, "source": "论文 §4.2；3800 元/t × 0.85 t/m³ ÷ 10000"},
            {"key": "well_cost_wan",
             "formula": "单井完井作业成本（固定值）",
             "value": 45.0, "source": "论文 §4.2；工程估算口径"},
            {"key": "days_per_month",
             "formula": "年均 365.25 / 12", "value": 30.4,
             "source": "产量 m³/d → 月累计的换算常数"},
            {"key": "evaluation_horizon_months",
             "formula": "事件后观测窗", "value": 12,
             "source": "事件定义 v2c：后史 12 个月（允许 ≤1 月缺测）"},
            {"key": "discount_rate_annual",
             "formula": "年折现率", "value": 0.0,
             "source": "12 个月窗口内不折现（口径保守）"},
            {"key": "oil_density_t_per_m3",
             "formula": "原油密度", "value": 0.85,
             "source": "Weld 县原油常规取值"},
        ],
    }

    # ---------- 3. wells / curves：population + actual ----------
    pop_cnt = collections.Counter()
    ratio_all = []
    ratio_by_pop = collections.defaultdict(list)
    zero_wells = []
    capped_D = 0
    n_actual_full = 0

    for w in b["wells"]:
        api = str(w.get("api") or "")
        ev = ev_by_api.get(api)
        if ev is None:
            raise RuntimeError(f"井 {w['well_id']} 在事件表中找不到 api={api}")
        pop = ev["status"]
        if pop not in ("PR", "SI"):
            raise RuntimeError(f"未知 population={pop} api={api}")
        w["population"] = pop
        pop_cnt[pop] += 1

        # B7：删掉常数 aleatoric
        u = w.get("uncertainty")
        if isinstance(u, dict) and "aleatoric" in u:
            u["aleatoric"] = None

        # curves.actual
        c = curve_by_id[w["well_id"]]
        act = event_actual(ev, series)
        c["actual"] = act
        if len(act) == HORIZON and all(p["oil"] is not None for p in act):
            n_actual_full += 1

        act12 = sum((p["oil"] or 0.0) for p in act) * DAYS_PER_MONTH
        base12 = base12_of(c)
        if act12 == 0:
            zero_wells.append(w["well_id"])
        if base12 > 0:
            r = act12 / base12
            ratio_all.append(r)
            ratio_by_pop[pop].append(r)

        if abs(float(ev["D_fit"]) - 0.15) < 1e-9:
            capped_D += 1

        # 区间元数据（供 P3 参考，P1 不重算区间）
        c["zero_month_prob"] = round(
            sum(1 for p in act if p["oil"] == 0.0) / HORIZON, 4)
        c["n_lower_positive"] = sum(
            1 for p in c["prediction"] if p.get("lo", 0) > 0)

    # ---------- 4. populations（I2）----------
    def pop_stat(v):
        if not v:
            return {"ratio_median": None, "frac_ge_1": None}
        return {
            "ratio_median": round(_median(v), 4),
            "frac_ge_1": round(sum(1 for x in v if x >= 1) / len(v), 4),
        }

    b["populations"] = {
        "PR": {"label": "在产井·增产", "n": pop_cnt["PR"], **pop_stat(ratio_by_pop["PR"])},
        "SI": {"label": "停产井·复活", "n": pop_cnt["SI"], **pop_stat(ratio_by_pop["SI"])},
    }

    # ---------- 5. geo（P2）----------
    if os.path.isfile(GEO):
        with open(GEO, "r", encoding="utf-8") as f:
            b["geo"] = json.load(f)
    else:
        b["geo"] = {"fallback": True, "coverage": 0.0,
                    "note": "P2 未交付 geo.json，走确定性示意布局"}

    # ---------- 6. 候选池与组合（D10 / I7）----------
    # 规则：预测 NPV 前 20，仅排除 available=false。
    # 本批 77 口全部 available=true → excluded 为空。
    # 不按 anchor 排除：预测 NPV 前 3 的 anchor 为 15.96 / 42.05 / 10.94，
    # 若按 anchor>5 排除会与「池含前 3」直接冲突（见 P0 冻结表 §2.11 与风险 R2）。
    ranked = sorted(b["wells"], key=lambda w: -(w.get("value_npv") or -1e18))
    excluded = []
    pool_ids = []
    for w in ranked:
        if len(pool_ids) >= POOL_K:
            break
        if not w.get("available", True):
            excluded.append({"well_id": w["well_id"], "code": "UNAVAILABLE",
                             "reason": "available=false，数据不可用于决策"})
            continue
        pool_ids.append(w["well_id"])

    by_id = {w["well_id"]: w for w in b["wells"]}
    combo_cost = 3 * WELL_COST_WAN
    combos = []
    for i in range(len(pool_ids)):
        for j in range(i + 1, len(pool_ids)):
            for k in range(j + 1, len(pool_ids)):
                sel = [pool_ids[i], pool_ids[j], pool_ids[k]]
                oil = round(sum(by_id[x]["value_oil"] for x in sel), 2)
                npv = round(sum(by_id[x]["value_npv"] for x in sel), 2)
                combos.append({
                    # —— final77 已有的键，一个不少（只增不改）——
                    "budget": combo_cost,
                    "risk": None,                 # P4：CVaR₅ / 尾部风险
                    "objective": "npv",
                    "selected": sel,
                    "expected_oil": oil,
                    "expected_npv": npv,
                    "loss_prob": None,            # P4
                    "cvar": None,                 # P4（保留旧名，与 cvar5 同义）
                    "hit_rate": None,             # P4（旧名，语义为"至少一口为正"，见 B1）
                    "regret": None,               # P4
                    # —— P1 新增 ——
                    "sum_of_wells": npv,
                    "expected_npv_basis": "point_estimate",
                    "cvar5": None,
                    "hit_rate_all": None,
                    "hit_rate_any": None,
                    "pending": "P4",
                })

    top3 = pool_ids[:3]
    b["portfolio"] = {
        "pool_rule": {
            "k": POOL_K,
            "rule": "候选池 = 预测 NPV 前 20（available=true）；不按 anchor 额外排除，"
                    "以保证「池含预测 NPV 前 3」",
            "excluded": excluded,
            "included_rank_top": top3,
            "n_candidates": len(pool_ids),
            "n_points": len(combos),
            "not_in_pool_note":
                f"其余 {len(b['wells']) - len(pool_ids)} 口井按预测 NPV 排名未进入前 20，未逐条列出",
        },
        "points": combos,
        # 帕累托前沿由 P4 从 1140 条里筛；P1 只留结构与旧键，避免前端空态崩掉
        "frontier": [{"risk": None, "npv": None, "objective": "npv", "pending": "P4"}],
        "strategies": b["portfolio"].get("strategies", []),
        "available": True,
    }

    # combo_metrics 与 portfolio 并轨（修 D10 双轨）
    b["combo_metrics"] = {
        "available": True,
        "k": 3,
        "n_total": len(combos),
        "n_items": len(combos),
        "method": "点估计口径（E[ΣNPV]=ΣE[NPV]）；蒙特卡洛 MC 与残差依赖抽样待 P4",
        "items": [{
            "selected": c["selected"],
            "expected_oil": c["expected_oil"],
            "expected_npv": c["expected_npv"],
            "loss_prob": None,
            "cvar": None,
            "hit_rate": None,
            "regret": None,
            "sum_of_wells": c["sum_of_wells"],
            "pending": "P4",
        } for c in combos],
    }

    # strategies：按各自标签的规则从**全域 77 口**重算选井
    #
    # 2026-11-03 P10 红队发现：三条策略的 selected 全是旧 14 口池的遗留物，
    # 与标签不符（ai 标「预测 NPV 前 3」实际选第 6/5/4 名）。根因是池子并轨时
    # 只改了 points/pool_rule，没管 strategies——同一个「双轨」病换个地方复发。
    # 处置：不再继承旧 selected，一律按标签重算，规则文本写进 bundle 可审计。
    all_npvs = [w["value_npv"] for w in b["wells"]]
    all_mean_npv = sum(all_npvs) / len(all_npvs)
    # 实测响应比 = 事后 12 月实际 / 基线。注意不能用 value_oil——那是
    # 「预测增油」，把它当「事后实际」是口径错（P10 红队抓到的第二处）。
    _cv = {c["well_id"]: c for c in b["curves"]}
    real_ratio = {}
    for _w in b["wells"]:
        _c = _cv[_w["well_id"]]
        _a = sum((p["oil"] or 0.0) for p in _c["actual"])
        _bs = sum(p["oil"] for p in _c["baseline"])
        real_ratio[_w["well_id"]] = (_a / _bs) if _bs > 0 else -9.0

    def top3_by(key):
        return [w["well_id"] for w in sorted(b["wells"], key=key, reverse=True)[:3]]

    RULES = {
        "ai": ("按 value_npv（模型点估计）降序取 3", lambda w: w["value_npv"]),
        "expert": ("按 anchor（事件前锚点日产油）降序取 3", lambda w: w["anchor"]),
        "history": ("按实测 ratio（actual12/base12，含未来信息）降序取 3",
                    lambda w: real_ratio[w["well_id"]]),
    }

    for s in b["portfolio"]["strategies"]:
        if s["id"] in RULES:
            rule_txt, key = RULES[s["id"]]
            s["selected"] = top3_by(key)
            s["selection_rule"] = rule_txt
            s["selection_universe"] = "全部 77 口（非候选池）"
        sel = s.get("selected") or []
        if sel:
            so = round(sum(by_id[x]["value_npv"] for x in sel), 2)
            s["sum_of_wells"] = so
            s["expected_npv"] = so
            s["expected_npv_basis"] = "point_estimate"
            s["pool_members"] = [x for x in sel if x in pool_ids]
        else:
            # random：无固定井集。
            # 抽样域必须是「全部 77 口」而不是池内 20 口——
            # 从池内抽等于把筛选优势算进基线，P5 的分位会虚高。
            exp = round(3 * all_mean_npv, 2)
            s["expected_npv"] = exp
            s["sum_of_wells"] = exp
            s["expected_npv_basis"] = "point_estimate_universe_mean"
            s["note"] = ("随机 3 口的期望 = 全部 77 口平均 NPV × 3；"
                         "抽样域为全域，非候选池。MC 分布待 P5 用 4000 次抽样")
            s["pool_members"] = []

    # ---------- 7. evidence（P1 只写 leakage 与 scope）----------
    b["evidence"] = {
        "leakage": [
            {"feature": "anchor", "visible_from": "event-1m", "uses_post_event": False,
             "ok": True, "note": "事件前最近 3 个非零月的日均产油均值（含措施月）"},
            {"feature": "pre_nz", "visible_from": "event-1m", "uses_post_event": False,
             "ok": True, "note": "事件前非零月计数"},
            {"feature": "D_fit", "visible_from": "event-1m", "uses_post_event": False,
             "ok": True, "note": "事件前 6–12 月 log 线性拟合，clip 到 [0, 0.15]"},
            {"feature": "form5a_seq", "visible_from": "event", "uses_post_event": False,
             "ok": True, "note": "COGIS Form 5A 序号，事件当时即可知"},
            {"feature": "population", "visible_from": "event", "uses_post_event": False,
             "ok": True, "note": "事件时井状态 PR/SI"},
            {"feature": "bucket", "visible_from": "event-1m", "uses_post_event": False,
             "ok": True, "note": "由 anchor 分档派生，继承 anchor 的可见性"},
        ],
        "scope": {
            "county": "WELD",
            "event_month_min": meta["scope"]["event_month_min"],
            "event_month_max": meta["scope"]["event_month_max"],
            "year_hist": meta["scope"]["year_hist"],
        },
    }

    b["schema_version"] = SCHEMA_VERSION

    # I9 / D1：清掉任何绝对路径（来自 final77 的 legacy_audit.inputs）
    b = sanitize_paths(b)
    # A4/A5/A6：清掉上游数据里残留的旧术语
    b = sanitize_text(b)

    stats = {
        "ratio_median": _median(ratio_all),
        "frac_ge_1": sum(1 for x in ratio_all if x >= 1) / len(ratio_all),
        "n_ratio": len(ratio_all),
        "zero_wells": zero_wells,
        "capped_D": capped_D,
        "n_actual_full": n_actual_full,
        "pool_n": len(pool_ids),
        "n_combos": len(combos),
        "top3": top3,
        "pop": dict(pop_cnt),
    }
    return b, stats


# ---------------------------------------------------------------- 工具

def _now():
    import datetime
    return datetime.datetime.now().astimezone().isoformat(timespec="seconds")


def _median(v):
    s = sorted(v)
    n = len(s)
    if n == 0:
        return float("nan")
    return s[n // 2] if n % 2 else (s[n // 2 - 1] + s[n // 2]) / 2


# ---------------------------------------------------------------- 旧字段 diff

def diff_renames(base, new):
    """统计旧字段改名/删除数。只增不改——返回违反项。"""
    bad = []
    newkeys = _flatten(new)

    def walk(o, path=""):
        if isinstance(o, dict):
            for k, v in o.items():
                np = f"{path}.{k}" if path else k
                if np not in newkeys:
                    bad.append(np)
                walk(v, np)
        elif isinstance(o, list) and o and isinstance(o[0], dict):
            walk(o[0], f"{path}[0]")

    walk(base)
    return bad


def _flatten(o, path=""):
    """展开所有键路径；数组只看首元素（结构与样本一致性足够做改名检查）"""
    keys = set()
    if isinstance(o, dict):
        for k, v in o.items():
            np = f"{path}.{k}" if path else k
            keys.add(np)
            keys |= _flatten(v, np)
    elif isinstance(o, list) and o and isinstance(o[0], dict):
        keys |= _flatten(o[0], f"{path}[0]")
    return keys


def sanitize_text(o):
    """强制文案合规：上游数据可能带旧术语，构建时统一清洗（A4/A5/A6）

    注意：这里改的是「说明性文本」，不动任何数值，也不改字段名。
    """
    RULES = [
        ("压裂措施工程仿真驾驶舱", "完井措施决策沙盘"),
        ("压裂措施决策", "完井措施决策"),
        ("压裂世界线", "措施世界线"),
        ("不压裂世界线", "不措施世界线"),
        ("常规水力压裂", "常规水力改造"),
        ("邻井压裂时间", "邻井措施时间"),
        ("邻井压裂记录", "邻井措施记录"),
        ("组合驾驶舱", "组合推演台"),
        ("驾驶舱", "沙盘"),
        ("建议压", "可判定"),
        ("压裂", "完井"),
    ]

    def fix(s):
        for a, b2 in RULES:
            if a in s:
                s = s.replace(a, b2)
        return s

    if isinstance(o, str):
        return fix(o)
    if isinstance(o, dict):
        return {fix(k) if isinstance(k, str) else k: sanitize_text(v) for k, v in o.items()}
    if isinstance(o, list):
        return [sanitize_text(v) for v in o]
    return o


def sanitize_paths(o):
    """把任意绝对路径字符串降级为相对路径（I9 / D1）"""
    if isinstance(o, str):
        if o.startswith("C:") or o.startswith("/Users") or "\\Users\\" in o:
            tail = o.replace("\\", "/").rstrip("/").split("/")[-2:]
            return "pilot/" + tail[-1] if tail else "pilot/"
        return o
    if isinstance(o, dict):
        return {k: sanitize_paths(v) for k, v in o.items()}
    if isinstance(o, list):
        return [sanitize_paths(v) for v in o]
    return o


# ---------------------------------------------------------------- 验收

def validate(b, stats):
    """P1 Done 的 8 条，逐条打印实测值"""
    rows = []

    def add(no, name, ok, detail):
        rows.append((no, name, "PASS" if ok else "FAIL", detail))
        return ok

    all_ok = True
    # 1 actual 12 点 77/77
    n12 = sum(1 for c in b["curves"]
              if len(c.get("actual") or []) == HORIZON
              and all(p["oil"] is not None for p in c["actual"]))
    all_ok &= add(1, "actual 12 点全覆盖", n12 == 77, f"{n12}/77")

    # 2 population
    pr, si = stats["pop"].get("PR", 0), stats["pop"].get("SI", 0)
    all_ok &= add(2, "population 覆盖", pr == 51 and si == 26,
                  f"PR={pr} SI={si} 合计={pr+si}")

    # 3 assumptions
    need = ["oil_price_cny_per_t", "oil_density_t_per_m3", "price_wan_per_m3",
            "well_cost_wan", "discount_rate_annual", "days_per_month"]
    miss = [k for k in need if k not in b["assumptions"]]
    all_ok &= add(3, "assumptions 六项", not miss, f"缺 {miss}" if miss else "6 项齐全")

    # 4 residual_pool_n + note
    ok4 = b["meta"].get("residual_pool_n") and b["meta"].get("pool_note")
    all_ok &= add(4, "120 与 77 可解释", bool(ok4),
                  f"residual_pool_n={b['meta'].get('residual_pool_n')} n_wells={b['meta'].get('n_wells')}")

    # 5 pool_rule + excluded
    pr5 = b["portfolio"]["pool_rule"]
    top3_ok = all(t in pr5["included_rank_top"] for t in stats["top3"])
    all_ok &= add(5, "pool_rule + 前 3 在池内", bool(pr5) and top3_ok,
                  f"k={pr5['k']} 池={pr5['n_candidates']} excluded={len(pr5['excluded'])} top3={stats['top3']}")

    # 6 路径
    txt = json.dumps(b, ensure_ascii=False)
    npath = txt.count("C:\\\\Users") + txt.count("C:/Users") + txt.count("/Users/")
    all_ok &= add(6, "无绝对路径", npath == 0, f"命中 {npath}")

    # 7 旧字段改名
    with open(BASE, "r", encoding="utf-8") as f:
        base = json.load(f)
    # 受控例外：aleatoric 保留键但值变 null，不算改名
    renamed = diff_renames(base, b)
    all_ok &= add(7, "旧字段改名数", len(renamed) == 0,
                  "0" if not renamed else f"{len(renamed)} 处 → {renamed[:6]}")

    # 8 复算断言
    ok8a = abs(stats["ratio_median"] - 1.067) <= 0.002
    ok8b = abs(stats["frac_ge_1"] - 0.558) <= 0.003
    sd = b["state_confusion"]["model_state_dist"]
    ok8c = (sd["green"], sd["yellow"], sd["red"], sd["gray"]) == (19, 35, 17, 6)
    ok8d = len(stats["zero_wells"]) == 7
    ok8e = stats["capped_D"] == 14
    all_ok &= add(8, "复算断言",
                  ok8a and ok8b and ok8c and ok8d and ok8e,
                  f"ratio={stats['ratio_median']:.4f}(±0.002) frac>=1={stats['frac_ge_1']:.4f}(±0.003) "
                  f"states={sd['green']}/{sd['yellow']}/{sd['red']}/{sd['gray']} "
                  f"zero={len(stats['zero_wells'])} cappedD={stats['capped_D']}")

    w = max(len(r[1]) for r in rows) + 2
    print("\n" + "=" * 78)
    print("P1 Done · 8 条验收")
    print("=" * 78)
    for no, name, st, detail in rows:
        mark = "✓" if st == "PASS" else "✗"
        print(f"{mark} {no}. {name:<{w}} {st:<6} {detail}")
    print("=" * 78)
    return all_ok, rows


# ---------------------------------------------------------------- 落盘

def write(b, check_only=False):
    if check_only:
        print("[check] 只校验，不写文件")
        return
    txt = json.dumps(b, ensure_ascii=False, separators=(",", ":"))
    for p in (OUT_DEV, OUT_REL):
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, "w", encoding="utf-8", newline="\n") as f:
            f.write(txt)
        print(f"[write] {os.path.relpath(p, ROOT)}  {len(txt.encode('utf-8'))/1024:.0f} KB")

    # SHA256SUMS
    rel = os.path.dirname(OUT_REL)
    sha = hashlib.sha256(txt.encode("utf-8")).hexdigest()
    with open(os.path.join(rel, "SHA256SUMS.txt"), "w", encoding="utf-8", newline="\n") as f:
        f.write(f"{sha}  bundle_v3.json\n")
    print(f"[sha] {sha}")


def post_check(b):
    """结构性不变量（I1–I12 中 P1 可自证的部分）"""
    errs = []
    n = len(b["wells"])
    if len(b["curves"]) != n or b["meta"]["n_wells"] != n:
        errs.append(f"I1 wells/curves/meta={n}/{len(b['curves'])}/{b['meta']['n_wells']}")
    if sum(v["n"] for v in b["populations"].values()) != n:
        errs.append("I2 populations 求和 ≠ n_wells")
    if any(len(c.get("actual") or []) != HORIZON for c in b["curves"]):
        errs.append("I3 有曲线 actual ≠ 12")
    for c in b["curves"][:5]:
        for p in c["prediction"]:
            if not (0 <= p["lo"] <= p["oil"] <= p["hi"]):
                errs.append(f"I4 区间倒挂 {c['well_id']} {p['month']}")
                break
    # I7
    pr = b["portfolio"]["pool_rule"]
    ex = {e["well_id"] for e in pr["excluded"]}
    sel = set()
    for p in b["portfolio"]["points"]:
        sel.update(p["selected"])
    if ex & sel:
        errs.append(f"I7 排除井仍被选中 {sorted(ex & sel)[:3]}")
    # I10/I11/I12
    g = b.get("geo") or {}
    if "coverage" not in g:
        errs.append("I10 geo 无 coverage")
    else:
        if bool(g.get("fallback")) != (g["coverage"] < 0.9):
            errs.append("I10 fallback 与 coverage 不一致")
        covered = set()
        dup = []
        for pad in g.get("pads") or []:
            for x in pad.get("well_ids") or []:
                if x in covered:
                    dup.append(x)
                covered.add(x)
        ids = {w["well_id"] for w in b["wells"]}
        if dup:
            errs.append(f"I11 井重复归属 {dup[:3]}")
        if covered != ids:
            errs.append(f"I11 pads 覆盖不全 缺{len(ids-covered)} 多{len(covered-ids)}")

    if errs:
        print("\n✗ 结构不变量失败：")
        for e in errs:
            print("   -", e)
        return False
    print("\n✓ 结构不变量 I1–I12（P1 可自证部分）通过")
    return True


def main():
    check_only = "--check" in sys.argv
    print("=" * 78)
    print("P1 · bundle v3.1 构建")
    print("=" * 78)
    b, stats = build()
    ok, _ = validate(b, stats)
    ok2 = post_check(b)
    if ok and ok2:
        write(b, check_only)
        print("\n✓ P1 完成")
        return 0
    print("\n✗ P1 未达标，不写文件")
    return 1


if __name__ == "__main__":
    sys.exit(main())
