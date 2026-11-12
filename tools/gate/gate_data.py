#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
验收闸门 · 数据类检查（bundle 结构与不变量）
覆盖：I1–I10、A3、B1、B2、B3、B4、B5、B6、B7、B8、C1、D2、D9、D10

设计原则（重要）：
  同一套代码在 P1 交付前后都要能跑。
  字段存在 → 严格判定 PASS/FAIL
  字段缺失 → BLOCKED，并注明「等哪个 agent」
绝不把"没数据"判成 PASS。
"""
import os
import json
import math
import re

# ---------------------------------------------------------------- 定位 bundle

CANDIDATES = [
    "release_v3/bundle_v3.json",                    # 交付版（P1 后）
    "frontend/src/data/bundle_v3.json",             # 开发版（P1 后）
    "frontend/src/data/pilot_bundle_final77.json",  # 当前开发基线
    "release/pilot_bundle_final77.json",            # 历史快照，仅在前者都缺失时兜底
]
# 2026-11-03 修定义：release/ 是已发布的历史快照，不应作为「当前验收对象」。
# 当前开发基线在 frontend/src/data/。P1 产出 bundle_v3 后自动优先级最高。


def find_bundle(root):
    for c in CANDIDATES:
        fp = os.path.join(root, c)
        if os.path.isfile(fp):
            with open(fp, "r", encoding="utf-8") as f:
                return c, json.load(f)
    return None, None


# ---------------------------------------------------------------- 工具

def _blocked(dep, why):
    return "BLOCKED", f"{why}（等 {dep}）"


def _has(d, *path):
    cur = d
    for p in path:
        if not isinstance(cur, dict) or p not in cur:
            return False
        cur = cur[p]
    return True


def _get(d, *path, default=None):
    cur = d
    for p in path:
        if not isinstance(cur, dict) or p not in cur:
            return default
        cur = cur[p]
    return cur


def _wells(b):
    return b.get("wells") or []


def _load_geo(root, b):
    """geo 块来源：优先 bundle.geo（P1 合并后），否则读 P2 的 geo.json。返回 (geo, src)"""
    g = b.get("geo")
    if g:
        return g, "bundle.geo"
    fp = os.path.join(root, "frontend", "src", "data", "geo.json")
    if os.path.isfile(fp):
        with open(fp, "r", encoding="utf-8") as f:
            return json.load(f), "geo.json"
    return None, None


def _curves(b):
    return b.get("curves") or []


# ---------------------------------------------------------------- 不变量 I1–I10

def g_i1(root, b):
    """I1 wells == n_wells == curves == 77"""
    n_w, n_c = len(_wells(b)), len(_curves(b))
    n_meta = _get(b, "meta", "n_wells")
    if (n_w, n_c, n_meta) == (77, 77, 77):
        return "PASS", f"wells={n_w} curves={n_c} meta.n_wells={n_meta}"
    return "FAIL", f"wells={n_w} curves={n_c} meta.n_wells={n_meta}（应全为 77）"


def g_i2(root, b):
    """I2 Σ populations.*.n == 77 且 PR=51 SI=26"""
    pop = b.get("populations")
    if not pop:
        return _blocked("P1", "populations 块不存在")
    pr, si = _get(pop, "PR", "n"), _get(pop, "SI", "n")
    tot = sum((v.get("n") or 0) for v in pop.values() if isinstance(v, dict))
    if pr == 51 and si == 26 and tot == 77:
        return "PASS", f"PR={pr} SI={si} Σ={tot}"
    return "FAIL", f"PR={pr} SI={si} Σ={tot}（应为 51/26/77）"


def g_i3(root, b):
    """I3 curves[].actual.length == 12"""
    cs = _curves(b)
    if not cs:
        return "FAIL", "curves 为空"
    if "actual" not in cs[0]:
        return _blocked("P1", "curves[].actual 不存在")
    bad = [c.get("well_id") for c in cs if len(c.get("actual") or []) != 12]
    if bad:
        return "FAIL", f"{len(bad)} 条曲线 actual ≠ 12 点 → {bad[:5]}"
    return "PASS", f"{len(cs)} 条曲线 actual 均 12 点"


def g_i4(root, b):
    """I4 lo ≤ oil ≤ hi，lo ≥ 0（924 点逐点）"""
    cs = _curves(b)
    n = 0
    bad = []
    for c in cs:
        for p in (c.get("prediction") or []):
            n += 1
            lo, oil, hi = p.get("lo"), p.get("oil"), p.get("hi")
            if None in (lo, oil, hi) or not (lo <= oil <= hi) or lo < 0:
                bad.append((c.get("well_id"), p.get("month"), lo, oil, hi))
    if bad:
        return "FAIL", f"{len(bad)}/{n} 点区间倒挂 → {bad[:3]}"
    return "PASS", f"{n} 点全部 lo≤oil≤hi 且 lo≥0"


def g_i5(root, b):
    """I5 value_npv ≈ value_oil × 0.323 − 45（抽样 20 口）"""
    if not _has(b, "assumptions", "price_wan_per_m3") or not _has(b, "assumptions", "well_cost_wan"):
        return _blocked("P1", "assumptions 缺失，无法校验口径")
    price = b["assumptions"]["price_wan_per_m3"]
    cost = b["assumptions"]["well_cost_wan"]
    ws = _wells(b)[:20]
    bad = []
    for w in ws:
        oil, npv = w.get("value_oil"), w.get("value_npv")
        if oil is None or npv is None:
            continue
        exp = oil * price - cost
        if abs(exp - npv) > max(0.5, abs(npv) * 0.005):
            bad.append((w.get("well_id"), round(npv, 2), round(exp, 2)))
    if bad:
        return "FAIL", f"{len(bad)}/20 口 NPV 口径不符 → {bad[:3]}"
    return "PASS", f"抽样 20 口 NPV = oil×{price}−{cost} 全部吻合"


def g_i6(root, b):
    """I6 zero_prob ∈[0,1]；revival_prob 仅 SI 非空"""
    ws = _wells(b)
    if "zero_prob" not in ws[0]:
        return _blocked("P3", "wells[].zero_prob 不存在")
    bad = []
    for w in ws:
        zp = w.get("zero_prob")
        if zp is not None and not (0 <= zp <= 1):
            bad.append((w.get("well_id"), "zero_prob", zp))
        rp = w.get("revival_prob")
        if rp is not None and w.get("population") != "SI":
            bad.append((w.get("well_id"), "revival_prob on PR", rp))
    if bad:
        return "FAIL", f"{len(bad)} 处越界 → {bad[:3]}"
    return "PASS", "zero_prob 均在 [0,1]，revival_prob 仅 SI"


def g_i7(root, b):
    """I7 pool_rule.excluded ∩ points[].selected = ∅"""
    pr = _get(b, "portfolio", "pool_rule")
    if not pr:
        return _blocked("P4", "portfolio.pool_rule 不存在")
    excluded = {e.get("well_id") for e in (pr.get("excluded") or [])}
    selected = set()
    for p in (_get(b, "portfolio", "points") or []):
        selected.update(p.get("selected") or [])
    overlap = excluded & selected
    if overlap:
        return "FAIL", f"排除井仍被选中：{sorted(overlap)[:5]}"
    return "PASS", f"排除 {len(excluded)} 口，选中井集 {len(selected)} 口，无交集"


def g_i8(root, b):
    """I8 名以 _prob/_frac/_rate 结尾者 ∈ [0,1]"""
    bad = []

    def walk(o, path=""):
        if isinstance(o, dict):
            for k, v in o.items():
                np = f"{path}.{k}" if path else k
                if isinstance(v, (int, float)) and not isinstance(v, bool):
                    if re.search(r"_(prob|frac|rate)$", k) and not (0 <= v <= 1):
                        bad.append((np, v))
                else:
                    walk(v, np)
        elif isinstance(o, list):
            for i, v in enumerate(o[:5]):
                walk(v, f"{path}[{i}]")

    walk(b)
    if bad:
        return "FAIL", f"{len(bad)} 处越界 → {bad[:5]}"
    return "PASS", "命名与量纲一致"


def g_i9(root, b):
    """I9 字符串字段无绝对文件路径；外链仅允许出现在「数据出处」字段

    2026-11-03 修定义：
      `source_url` 是数据来源标注（公开数据集地址），不是运行时外链，也不发起请求。
      「产物是否真的会联网」由 E-EXT 在构建产物上判定，不该在 bundle 层一刀切。
    """
    path_pat = re.compile(r"C:\\\\?Users|C:/Users|/Users/|[A-Za-z]:\\\\Users")
    url_pat = re.compile(r"https?://")
    bad = []

    def walk(o, path=""):
        if isinstance(o, str):
            if path_pat.search(o):
                bad.append((path, "PATH", o[:90]))
            elif url_pat.search(o) and not path.endswith("source_url") and "w3.org" not in o:
                bad.append((path, "URL", o[:90]))
        elif isinstance(o, dict):
            for k, v in o.items():
                walk(v, f"{path}.{k}" if path else k)
        elif isinstance(o, list):
            for i, v in enumerate(o):
                walk(v, f"{path}[{i}]")

    walk(b)
    if bad:
        return "FAIL", f"{len(bad)} 处 → {bad[:4]}"
    return "PASS", "无绝对文件路径；外链仅存在于 source_url 出处字段"


def g_i10(root, b):
    """I10 geo 存在，coverage ∈[0,1]，fallback == (coverage<0.9)"""
    geo, src = _load_geo(root, b)
    if not geo:
        return _blocked("P2", "geo 块不存在（bundle 与 geo.json 均无）")
    cov = geo.get("coverage")
    fb = geo.get("fallback")
    if cov is None or not (0 <= cov <= 1):
        return "FAIL", f"coverage={cov} 越界"
    expect_fb = cov < 0.9
    if bool(fb) != expect_fb:
        return "FAIL", f"coverage={cov} 但 fallback={fb}（应为 {expect_fb}）"
    return "PASS", f"[{src}] coverage={cov:.4f} fallback={fb} 一致"


def g_i11(root, b):
    """I11 pads 覆盖全部井且无重复归属"""
    geo, src = _load_geo(root, b)
    if not geo:
        return _blocked("P2", "geo 块不存在")
    pads = geo.get("pads") or []
    if not pads:
        return "FAIL", f"[{src}] pads 为空（两级尺度需要 pad 分组）"
    seen = {}
    dup = []
    for p in pads:
        for w in (p.get("well_ids") or []):
            if w in seen:
                dup.append((w, seen[w], p.get("pad_id")))
            seen[w] = p.get("pad_id")
    all_ids = {w.get("well_id") for w in _wells(b)}
    covered = set(seen)
    missing = sorted(all_ids - covered)
    extra = sorted(covered - all_ids)
    if dup:
        return "FAIL", f"井重复归属 {len(dup)} 处 → {dup[:3]}"
    if missing or extra:
        return "FAIL", f"覆盖不全：缺 {missing[:5]}，多 {extra[:5]}"
    return "PASS", f"[{src}] {len(pads)} 个 pad 覆盖 {len(covered)} 口井，无重复"


def g_i12(root, b):
    """I12 levels 里的 pad_stats 必须是重算出来的，不是手写死值"""
    geo, src = _load_geo(root, b)
    if not geo:
        return _blocked("P2", "geo 块不存在")
    pads = geo.get("pads") or []
    st = _get(geo, "levels", "L1", "pad_stats")
    if not st:
        return _blocked("P2", "levels.L1.pad_stats 不存在")
    real = {
        "n_pads": len(pads),
        "n_single": sum(1 for p in pads if p.get("n") == 1),
        "n_multi": sum(1 for p in pads if (p.get("n") or 0) > 1),
        "multi_wells": sum(p.get("n") or 0 for p in pads if (p.get("n") or 0) > 1),
        "max_pad_span_m": round(max((p.get("span_m") or 0) for p in pads), 1) if pads else 0,
    }
    bad = []
    for k, v in real.items():
        got = st.get(k)
        if got is None or abs(float(got) - float(v)) > 1e-6:
            bad.append(f"{k}: 写{got} 实{v}")
    if bad:
        return "FAIL", f"[{src}] pad_stats 与实测不符 → {'; '.join(bad)}"
    return "PASS", f"[{src}] pad_stats 与重算一致（{real['n_pads']} pads / {real['n_single']} 单井）"


# ---------------------------------------------------------------- 历史缺陷断言

def g_a3(root, b):
    """A3 数字孪生三要素：geo.coverage / wells[].population / curves[].actual"""
    miss = []
    if not b.get("geo"):
        miss.append("geo")
    if "population" not in (_wells(b)[0] if _wells(b) else {}):
        miss.append("wells[].population")
    if "actual" not in (_curves(b)[0] if _curves(b) else {}):
        miss.append("curves[].actual")
    if miss:
        return _blocked("P1/P2/P3", f"缺 {', '.join(miss)}")
    cov = b["geo"].get("coverage", 0)
    tag = "示意图标" if cov < 0.9 else "真实井位"
    return "PASS", f"三要素齐全，geo.coverage={cov:.3f}（{tag}）"


def g_b1(root, b):
    """B1 hit_rate 必须区分 all / any，UI 只显示 all"""
    bt = _get(b, "evidence", "backtest")
    if not bt:
        return _blocked("P4/P5", "evidence.backtest 不存在")
    ha, hna = bt.get("hit_rate_all"), bt.get("hit_rate_any")
    if ha is None or hna is None:
        return "FAIL", f"hit_rate_all={ha} hit_rate_any={hna}（两者都必须有）"
    return "PASS", f"hit_rate_all={ha:.4f} hit_rate_any={hna:.4f} 分列"


def g_b2(root, b):
    """B2 CVaR₅ 必须为负"""
    dep = _get(b, "evidence", "dependence")
    if not dep:
        return _blocked("P4", "evidence.dependence 不存在")
    cvar = _get(dep, "block_bootstrap", "cvar5")
    if cvar is None:
        return "FAIL", "block_bootstrap.cvar5 缺失"
    if cvar >= 0:
        return "FAIL", f"CVaR₅={cvar} ≥ 0，风险仍被低估"
    conv = dep.get("cvar_sign_convention")
    if not conv:
        return "FAIL", f"CVaR₅={cvar} 为负，但缺符号约定说明"
    return "PASS", f"CVaR₅={cvar:.3f} < 0，符号约定已登记"


def g_b3(root, b):
    """B3 相关性放大尾部风险：块 CVaR₅ 显著劣于独立假设

    2026-11-03 修定义（第二次）：
      旧判据「block.loss_prob ≥ 5×independent.loss_prob」针对旧口径设计——
      旧系统 independent.loss_prob 仅 0.0095，5 倍可达。
      改用增量残差后 independent 已达 0.37，5 倍 = 1.85 > 1.0，数学上不可达。

      且在「共享时期因子」模型下 loss_prob 会**下降**（共同因子让结果两极分化：
      要么全好要么全坏），但尾部损失急剧恶化。实测 CVaR 从 -3542 → -5287，
      而 loss_prob 从 0.370 → 0.356。→ loss_prob 不是度量相关性风险的指标，CVaR 才是。
    """
    dep = _get(b, "evidence", "dependence")
    if not dep:
        return _blocked("P4", "evidence.dependence 不存在")
    li = _get(dep, "independent", "cvar5")
    lb = _get(dep, "block_bootstrap", "cvar5")
    if li is None or lb is None:
        return "FAIL", f"independent.cvar5={li} block_bootstrap.cvar5={lb}"
    if li == 0:
        return "FAIL", "independent.cvar5=0，无法比尾部"
    ratio = abs(lb) / abs(li)
    lp_i = _get(dep, "independent", "loss_prob")
    lp_b = _get(dep, "block_bootstrap", "loss_prob")
    info = f"CVaR₅ {lb:.1f} vs {li:.1f}（{ratio:.2f}×）；loss_prob {lp_b:.4f} vs {lp_i:.4f}"
    if lb >= li:
        return "FAIL", f"块尾部未劣于独立 → {info}"
    if ratio < 1.20:
        return "FAIL", f"尾部恶化不足 20% → {info}"
    return "PASS", info


def g_b4(root, b):
    """B4 oracle ≥ 任何策略"""
    bt = _get(b, "evidence", "backtest")
    if bt:
        oracle = bt.get("oracle")
        pols = bt.get("policies") or []
        if oracle is None:
            return "FAIL", "evidence.backtest.oracle 缺失"
        above = [(p.get("id"), p.get("realized_mean")) for p in pols
                 if (p.get("realized_mean") or 0) > oracle + 1e-9]
        if above:
            return "FAIL", f"策略超过 oracle → {above}"
        return "PASS", f"oracle={oracle:.3f} ≥ {len(pols)} 条策略"

    # 旧 bundle 退路：用 combo_metrics 最大 NPV 作 oracle 代理
    cm = b.get("combo_metrics") or {}
    items = cm.get("items") or []
    strats = _get(b, "portfolio", "strategies") or []
    if not items or not strats:
        return _blocked("P4", "evidence.backtest 与 combo_metrics 均不可用")
    oracle = max(i.get("expected_npv", -1e18) for i in items)
    above = [(s.get("id"), s.get("expected_npv")) for s in strats
             if (s.get("expected_npv") or 0) > oracle + 1e-6]
    if above:
        return "FAIL", f"oracle(combo)= {oracle:.2f}，但策略超过它 → {above}"
    return "PASS", f"oracle(combo)={oracle:.2f} ≥ {len(strats)} 条策略"


def g_b5(root, b):
    """B5 期望线性性：E[ΣNPV] ≡ ΣE[NPV]，相对误差 < 1%

    口径（2026-11-03 归因后重定义，见接口冻结表 §2.11）：
      expected_npv = MC 期望；sum_of_wells = 该组合选中的井 value_npv 之和。
      两者必须相等——这是期望线性性的恒等式，不是可选项。
      旧 bundle 无 sum_of_wells，回退用 selected 3 口 Σ 反算，同样判。
    """
    strats = _get(b, "portfolio", "strategies") or []
    if not strats:
        return _blocked("P4", "portfolio.strategies 不存在")
    idx = {w.get("well_id"): w for w in _wells(b)}

    def sum_of(s):
        if s.get("sum_of_wells") is not None:
            return s["sum_of_wells"], "sum_of_wells"
        sel = s.get("selected") or []
        try:
            return sum((idx[i].get("value_npv") or 0) for i in sel), "Σselected(回退)"
        except KeyError:
            return None, "selected 引用缺失"

    bad = []
    checked = 0
    for s in strats:
        e = s.get("expected_npv")
        so, how = sum_of(s)
        if e is None or so is None:
            continue
        rel = abs(e - so) / max(abs(so), 1.0)
        checked += 1
        if rel >= 0.01:
            bad.append(f"[{s.get('id')}] MC={e:.2f} Σ={so:.2f} 偏 {rel*100:.2f}%")

    # 残差口径语义标签
    rk = _get(b, "portfolio", "residual", "kind")
    kind_note = ""
    if rk and rk != "incremental":
        return "FAIL", f"portfolio.residual.kind={rk}（应为 incremental）"

    if bad:
        return "FAIL", (f"{len(bad)}/{checked} 条策略违反期望线性性 → "
                        + "; ".join(bad[:3])
                        + ("；portfolio.residual 未声明口径" if not rk else ""))
    note = f"残差口径={rk}" if rk else "残差口径未声明（P4 须补 incremental 标签）"
    return "PASS", f"{checked} 条策略满足 E[ΣNPV]=ΣE[NPV]（误差<1%），{note}"


def g_b6(root, b):
    """B6 120 与 77 并存必须解释"""
    n_res = _get(b, "meta", "residual_pool_n")
    n_wells = _get(b, "meta", "n_wells")
    note = _get(b, "meta", "pool_note")
    if n_res is None:
        return _blocked("P1", "meta.residual_pool_n 不存在")
    if not note:
        return "FAIL", f"residual_pool_n={n_res} n_wells={n_wells}，但无 note 解释"
    return "PASS", f"residual_pool_n={n_res} n_wells={n_wells}，note 已给"


def g_b7(root, b):
    """B7 aleatoric 不得为常数 100"""
    vals = [_get(w, "uncertainty", "aleatoric") for w in _wells(b)]
    if not any(v is not None for v in vals):
        return "PASS", "aleatoric 全为 null（已按 B7 处理）"
    uniq = set(vals)
    if len(uniq) == 1 and 100 in uniq:
        return "FAIL", "aleatoric 恒为 100，常数冒充分解"
    if len(uniq) == 1:
        return "FAIL", f"aleatoric 恒为 {uniq.pop()}，仍是常数"
    return "PASS", f"aleatoric 有 {len(uniq)} 个不同取值"


def g_b8(root, b):
    """B8 assumptions 6 项 + 公式登记"""
    need = ["oil_price_cny_per_t", "oil_density_t_per_m3", "price_wan_per_m3",
            "well_cost_wan", "discount_rate_annual", "days_per_month"]
    a = b.get("assumptions")
    if not a:
        return _blocked("P1", "assumptions 块不存在")
    miss = [k for k in need if k not in a]
    if miss:
        return "FAIL", f"缺 {miss}"
    if not a.get("registry"):
        return "FAIL", "6 项齐全但缺 registry（公式/出处登记）"
    return "PASS", f"6 项齐全 + registry {len(a['registry'])} 条"


def g_c1(root, b):
    """C1 地层必须有 basis，无数据则整层不渲染"""
    geo, src = _load_geo(root, b)
    if not geo:
        return _blocked("P2", "geo 块不存在")
    strata = geo.get("strata") or []
    if not strata:
        return "PASS", f"[{src}] strata 为空（UI 须显示「暂无层位」）"
    bad = [s.get("name") for s in strata if not s.get("basis") or not s.get("source_url")]
    if bad:
        return "FAIL", f"[{src}] {len(bad)} 层缺 basis/source_url → {bad}"
    no_depth = [s.get("name") for s in strata
                if s.get("top_m") is None or s.get("bottom_m") is None]
    if no_depth:
        return "PASS", (f"[{src}] {len(strata)} 层均有 basis + source_url，"
                        f"但 {no_depth} 深度为 null → UI 须整层隐藏并标「暂无层位」")
    return "PASS", f"[{src}] {len(strata)} 层均有 basis + source_url + 深度"


def g_d2(root, b):
    """D2 事件后实测曲线：actual 12 点，单井页三线同屏"""
    cs = _curves(b)
    if not cs or "actual" not in cs[0]:
        return _blocked("P1", "curves[].actual 不存在")
    bad = [c.get("well_id") for c in cs if len(c.get("actual") or []) != 12]
    if bad:
        return "FAIL", f"{len(bad)} 条 actual ≠ 12 点"
    return "PASS", f"{len(cs)} 条曲线实测 12 点齐全"


def g_d9(root, b):
    """D9 单一县、时间不均：meta.scope 必须写明"""
    scope = _get(b, "meta", "scope")
    if not scope:
        return _blocked("P1", "meta.scope 不存在")
    yh = scope.get("year_hist") or {}
    if len(yh) < 10:
        return "FAIL", f"year_hist 只有 {len(yh)} 年（应覆盖 2014–2024）"
    if sum(yh.values()) != 77:
        return "FAIL", f"year_hist 求和 {sum(yh.values())} ≠ 77"
    return "PASS", f"county={scope.get('county')}，{len(yh)} 年分布求和 77"


def g_d10(root, b):
    """D10 池子必须含预测 NPV 前 3，且排除原因可查；顺带核对池规模一致性"""
    pr = _get(b, "portfolio", "pool_rule")
    ws = sorted(_wells(b), key=lambda w: (w.get("value_npv") or -1e18), reverse=True)
    top3 = [w.get("well_id") for w in ws[:3]]

    if not pr:
        # 旧 bundle 退路：用 points[].selected 的并集反推池子
        pool = set()
        for p in (_get(b, "portfolio", "points") or []):
            pool.update(p.get("selected") or [])
        if not pool:
            return _blocked("P4", "portfolio.pool_rule 不存在且 points 为空")
        inside = [t for t in top3 if t in pool]
        # 池规模交叉核对：points 池 vs combo_metrics 的 C(n,3)
        cm = b.get("combo_metrics") or {}
        n_items = cm.get("n_items")
        n_pool_from_combo = None
        if n_items:
            n_pool_from_combo = round((8 * n_items + 1) ** 0.5 / 2 + 0.5)  # 反解 C(n,3)
        note = f"points 池 {len(pool)} 口"
        if n_pool_from_combo:
            try:
                if math.comb(n_pool_from_combo, 3) != n_items:
                    n_pool_from_combo = None
            except Exception:
                n_pool_from_combo = None
        if n_pool_from_combo and n_pool_from_combo != len(pool):
            note += f"，但 combo_metrics 按 {n_pool_from_combo} 口算（C({n_pool_from_combo},3)={n_items}）→ 两套池子并存"
        if len(inside) < 3:
            miss = [t for t in top3 if t not in pool]
            return "FAIL", f"预测 NPV 前 3 中 {len(miss)} 口不在池内 → {miss}（且无排除原因）；{note}"
        return "PASS", f"前 3 全在池内，{note}"

    pool_reps = pr.get("included_rank_top") or []
    excluded = {e.get("well_id"): e.get("reason") for e in (pr.get("excluded") or [])}
    miss = [t for t in top3 if t in excluded]
    if miss:
        return "FAIL", f"前 3 被排除 → {[(m, excluded[m]) for m in miss]}"
    if not pool_reps:
        return "FAIL", "pool_rule.included_rank_top 未登记前 3"
    return "PASS", f"前 3 {top3} 在池内，排除 {len(excluded)} 口且各有 reason"


# ---------------------------------------------------------------- 证据层补充

def g_c6(root, b):
    """C6 五类工程指标各 1 个数字进 evidence.kpi"""
    kpi = _get(b, "evidence", "kpi")
    if not kpi:
        return _blocked("P5", "evidence.kpi 不存在")
    need = ["cost", "efficiency", "quality", "reliability", "safety"]
    miss = [k for k in need if not isinstance(kpi.get(k), dict) or kpi[k].get("value") is None]
    if miss:
        return "FAIL", f"缺 {miss}"
    return "PASS", f"5 类指标齐全（{', '.join(need)}）"


def g_d3(root, b):
    """D3 D 截断敏感性：整体 + 顶格 14 口两组"""
    s = _get(b, "evidence", "sensitivity", "D_clip")
    if not s:
        return _blocked("P5", "evidence.sensitivity.D_clip 不存在")
    if not isinstance(s, dict) or "overall" not in s or "capped14" not in s:
        return "FAIL", f"D_clip 结构不全 → keys={list(s) if isinstance(s, dict) else type(s).__name__}"
    n = s["capped14"].get("n")
    if n != 14:
        return "FAIL", f"capped14.n={n}（应为 14）"
    return "PASS", "D_clip 整体 + 顶格 14 口两组齐全"


def g_c4(root, b):
    """C4 数据版本 + 生成时间可读（?refresh 重读属 P8，此处只查字段）"""
    dr = _get(b, "meta", "data_release") or _get(b, "meta", "release")
    gen = _get(b, "meta", "generated_at")
    if not dr or not gen:
        return "FAIL", f"data_release={dr} generated_at={gen}"
    return "PASS", f"版本 {dr}，生成于 {str(gen)[:19]}"


def g_b9(root, b):
    """B9 策略选井必须与其标签的规则一致（P10 红队新增，v1.2）

    为什么加这条：旧 bundle 的 4 条策略 selected 全是旧 14 口池的遗留物。
    标「预测 NPV 前 3」的策略实际选第 6/5/4 名，而回测页拿第 1/2/3 名去
    证明自己排在 99.9% —— 同一个 bundle 里有两套「模型选井」。
    评委点开组合页与回测页各看一次，就能对上这个矛盾。
    """
    strats = _get(b, "portfolio", "strategies") or []
    if not strats:
        return _blocked("P4", "portfolio.strategies 不存在")
    wells = {w.get("well_id"): w for w in _wells(b)}
    cv = {c.get("well_id"): c for c in _get(b, "curves") or []}

    def top3(key):
        return [k for k, _ in sorted(wells.items(),
                                     key=lambda kv: key(kv[1]), reverse=True)[:3]]

    def real_ratio(w):
        c = cv.get(w.get("well_id"))
        if not c:
            return -9.0
        a = sum((p.get("oil") or 0.0) for p in c.get("actual") or [])
        bs = sum(p.get("oil") or 0.0 for p in c.get("baseline") or [])
        return (a / bs) if bs > 0 else -9.0

    RULES = {
        "ai": ("value_npv", lambda w: w.get("value_npv") or -1e18),
        "expert": ("anchor", lambda w: w.get("anchor") or -1e18),
        "history": ("actual12/baseline12（事后）", real_ratio),
    }

    bad, checked = [], 0
    for s in strats:
        sid, sel = s.get("id"), s.get("selected") or []
        if sid not in RULES:
            # random 无固定井集，但要能结算
            if sid == "random" and s.get("realized_npv") is None:
                bad.append("random 无 realized_npv")
            continue
        if not sel:
            bad.append(f"{sid} 无 selected")
            continue
        expect = top3(RULES[sid][1])
        checked += 1
        if sorted(sel) != sorted(expect):
            bad.append(f"{sid} 标「{RULES[sid][0]}」却选了 {sel}（应为 {expect}）")
        # 事后策略必须明示含未来信息
        if sid == "history" and "未来" not in str(s.get("selection_rule", "")):
            bad.append("history 未标注含未来信息")

    if checked == 0:
        return "FAIL", "无可校验的策略"
    if bad:
        return "FAIL", "；".join(bad)
    return "PASS", f"{checked} 条策略选井与标签一致（random 无固定井集，已单独结算）"


# ---------------------------------------------------------------- 注册表
GATES = [
    ("I1",  "wells/curves/meta 计数一致",       g_i1,   "P1"),
    ("I2",  "populations 求和 = 77",           g_i2,   "P1"),
    ("I3",  "actual 均 12 点",                 g_i3,   "P1"),
    ("I4",  "区间 lo≤oil≤hi",                  g_i4,   None),
    ("I5",  "NPV 口径自洽",                    g_i5,   "P1"),
    ("I6",  "zero_prob / revival_prob 合法",   g_i6,   "P3"),
    ("I7",  "排除池与选中集不相交",             g_i7,   "P4"),
    ("I8",  "概率类命名与量纲一致",             g_i8,   None),
    ("I9",  "无绝对路径/外链",                  g_i9,   None),
    ("I10", "geo coverage 与 fallback 一致",   g_i10,  "P2"),
    ("I11", "pads 覆盖全部井且无重复",          g_i11,  "P2"),
    ("I12", "pad_stats 与重算一致",             g_i12,  "P2"),
    ("A3",  "数字孪生三要素齐全",               g_a3,   "P1/P2/P3"),
    ("B1",  "hit_rate all/any 分列",           g_b1,   "P4/P5"),
    ("B2",  "CVaR₅ 为负",                      g_b2,   "P4"),
    ("B3",  "依赖 vs 独立 ≥ 5 倍",             g_b3,   "P4"),
    ("B4",  "oracle 不被策略超过",              g_b4,   "P4"),
    ("B5",  "Σ单井 vs 组合分口径",              g_b5,   "P4"),
    ("B6",  "120 与 77 有解释",                g_b6,   "P1"),
    ("B7",  "aleatoric 不是常数",              g_b7,   "P3"),
    ("B8",  "assumptions 6 项 + registry",     g_b8,   "P1"),
    ("C1",  "地层有 basis 否则不渲染",          g_c1,   "P2"),
    ("C4",  "数据版本 + 生成时间",              g_c4,   None),
    ("C6",  "五类 KPI 齐全",                    g_c6,   "P5"),
    ("D2",  "实测曲线 12 点",                  g_d2,   "P1"),
    ("D3",  "D 截断敏感性两组",                 g_d3,   "P5"),
    ("D9",  "scope 年份分布",                  g_d9,   "P1"),
    ("D10", "池含预测 NPV 前 3",               g_d10,  "P4"),
    ("B9",  "策略选井与其标签规则一致",           g_b9,   "P1/P4"),
]


def run(root):
    rel, b = find_bundle(root)
    if b is None:
        return [{"id": "BUNDLE", "title": "定位 bundle", "status": "BLOCKED",
                 "detail": "未找到 bundle_v3.json / pilot_bundle_final77.json", "dep": "P1"}]
    out = []
    for gid, title, fn, dep in GATES:
        try:
            status, detail = fn(root, b)
        except Exception as e:
            status, detail = "ERROR", f"{type(e).__name__}: {e}"
        out.append({"id": gid, "title": title, "status": status,
                    "detail": detail, "dep": dep, "src": rel})
    return out


if __name__ == "__main__":
    import sys
    root = sys.argv[1] if len(sys.argv) > 1 else "."
    for r in run(root):
        print(f"{r['id']:5} {r['status']:8} {r['title']}\n      {r['detail']}")
