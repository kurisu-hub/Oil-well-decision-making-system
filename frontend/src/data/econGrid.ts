/**
 * T17 · 预计算参数网格 —— 前端查表访问层
 *
 * 数据来源：`econ_grid.json`（pipeline/build_econ_grid.py 离线产出，随包发布）。
 * 9 个 (油价×成本) 组合 × 77 口井的 value_npv 全表，前端只查表、零公式。
 * 基准档 (×1.0, ×1.0) 与 bundle.value_npv 一致（最大差 0.02 万元 = 整数舍入链，
 * pipeline 自检 G2/G3 已核验；恒等式 = build_bundle_v31 经济口径）。
 *
 * 边界（防编造）：
 * · 网格只覆盖 77 口在册井；新井试算走 Worker 推理（T04），不查本表；
 * · 分布类指标（loss_prob / cvar / hit_rate / regret）不在网格内——
 *   它们来自 P4 蒙特卡洛，按工况重算是新实验，本表不冒充，仍查 combo_metrics；
 * · 预算档（90/135/180）只参与缺口口径，不产生新数值。
 */
import raw from './econ_grid.json'

export interface PriceTier {
  oil_price_cny_per_t: number
  mult: number
  price_wan_per_m3: number
}
export interface CostTier {
  well_cost_wan: number
  mult: number
}
export interface BudgetTier {
  budget_wan: number
  k_wells: number
}
export interface GridCombo {
  p: number
  c: number
  n_npv_pos: number
  sum_npv: number
  top3: { selected: string[]; expected_oil: number; expected_npv: number }
  npv: Record<string, number>
}

const grid = raw as {
  version: string
  generated_at: string
  base: { oil_price_cny_per_t: number; oil_density_t_per_m3: number; price_wan_per_m3: number; well_cost_wan: number }
  price_tiers: PriceTier[]
  cost_tiers: CostTier[]
  budget_tiers: BudgetTier[]
  // 示意配置不重算收益，不带真实网格的自检结果。
  self_check?: { g2_max_diff_base_vs_bundle: number; g3_combo_identity_diff: number }
  grid: GridCombo[]
}

export const GRID_VERSION = grid.version
export const GRID_META = {
  generatedAt: grid.generated_at,
  base: grid.base,
  selfCheck: grid.self_check,
}
/** 油价三档（元/t）——Cockpit 档位按钮与吸附共用 */
export const PRICE_TIERS: number[] = grid.price_tiers.map((t) => t.oil_price_cny_per_t)
/** 成本三档（万元） */
export const COST_TIERS: number[] = grid.cost_tiers.map((t) => t.well_cost_wan)
/** 预算三档（万元）= k×单井成本，k = 2/3/4（135 即 portfolio 实有档） */
export const BUDGET_TIERS: number[] = grid.budget_tiers.map((t) => t.budget_wan)

/** 索引：key = `${p}_${c}` → 组合条目（p 外层 c 内层，与 build_econ_grid.py 落表顺序一致） */
const comboIndex = new Map<string, GridCombo>(grid.grid.map((e) => [`${e.p}_${e.c}`, e]))
const comboAt = (p: number, c: number): GridCombo | null => comboIndex.get(`${p}_${c}`) ?? null

/** 逐井查表：返回该井在 (油价档 p, 成本档 c) 下的 value_npv（万元）；查不到 → null，不猜 */
export function gridNpvAt(wellId: string, pTier: number, cTier: number): number | null {
  const e = comboAt(pTier, cTier)
  const v = e ? e.npv[wellId] : undefined
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/** 组合级（网格聚合层，仅期望值口径）：n_npv_pos / sum_npv / top3 */
export function gridCombo(pTier: number, cTier: number): GridCombo | null {
  return comboAt(pTier, cTier)
}

/** 任意油价（元/t）→ 最近油价档下标（T17 三档离散化 + T03 同款就近吸附语义） */
export function priceTierOf(price: number): number {
  let best = 0
  let bestD = Infinity
  PRICE_TIERS.forEach((t, i) => {
    const d = Math.abs(t - price)
    if (d < bestD) {
      bestD = d
      best = i
    }
  })
  return best
}

/** 任意成本（万元）→ 最近成本档下标 */
export function costTierOf(cost: number): number {
  let best = 0
  let bestD = Infinity
  COST_TIERS.forEach((t, i) => {
    const d = Math.abs(t - cost)
    if (d < bestD) {
      bestD = d
      best = i
    }
  })
  return best
}
