import type { Passport } from '@/types/bundle'

/**
 * T05 · 数字溯源抽屉 —— 前端补录的数字护照条目（id 一律 x_ 前缀）。
 *
 * 边界（防编造，与 bundle passport 分工）：
 * · p_ 前缀 = bundle passport（pipeline 产出，唯一事实源）；
 * · x_ 前缀 = 本表，只补「无护照条目的聚合/派生数字」，formula 只描述真实计算
 *   口径（store 计数逻辑 / bundle 字段语义 / pipeline/portfolio_p4.py 蒙特卡洛口径），
 *   不引入任何页面之外的数值；
 * · value 由 buildStaticProv 调用方传当前页面显示值 —— 本表不硬编码任何数字；
 * · source 用 'derived'（前端聚合/查表）或 'assumption'（蒙特卡洛），不冒充 live。
 */

export interface ProvCtx {
  /** 四象限计数（store.kpi：按 bundle.well.state 分组计数） */
  kpi: { green: number; yellow: number; red: number; gray: number; budgetGap: number }
  /** 全量井数（计数口径的分母） */
  nWells: number
  /** 单井措施成本（万元，store.assumptions.cost） */
  cost: number
  /** 预算（万元，store.assumptions.budget） */
  budget: number
  /** 组合指标（store.combo：查表 combo_metrics / 回退 portfolio.points） */
  combo: {
    expected_oil: number | null
    expected_npv: number | null
    loss_prob: number | null
    cvar: number | null
    hit_rate: number | null
    regret: number | null
    source: string | null
  } | null
  /** combo_metrics 元信息（方法与规模，照抄 bundle，不自述） */
  comboMethod: string | null
}

const LIVE_NOTE = '前端实时取当前页面值（非 bundle 快照）'

function num(v: number | null | undefined, digits = 2): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '暂无'
  return v.toFixed(digits)
}

function pct(v: number | null | undefined, digits = 0): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '暂无'
  return v.toFixed(digits)
}

/** 四象限计数的公共口径说明（判态由模型侧完成，前端只计数） */
const STATE_FORMULA =
  '统计 bundle.wells 中模型判态结果（well.state，模型侧按 12 个月累计量经验分布判定），前端只计数不现算'

export function buildStaticProv(ctx: ProvCtx): Record<string, Passport> {
  const n = ctx.nWells
  const cm = ctx.combo
  const mcNote = ctx.comboMethod ? `方法：${ctx.comboMethod}` : '方法：bundle.combo_metrics.method 缺失'

  const entries: Passport[] = [
    {
      id: 'x_kpi_green',
      label: '可判定井数（绿）',
      value: String(ctx.kpi.green),
      unit: '口',
      formula: STATE_FORMULA,
      source: 'derived',
      sample_size: n,
      config_id: 'T05-PROV',
      assumptions: ['判态阈值：绿 = P(NPV>0) > 0.70 且 NPV > 0（模型侧）'],
      updated_at: LIVE_NOTE,
    },
    {
      id: 'x_kpi_yellow',
      label: '数据不足井数（黄）',
      value: String(ctx.kpi.yellow),
      unit: '口',
      formula: STATE_FORMULA,
      source: 'derived',
      sample_size: n,
      config_id: 'T05-PROV',
      assumptions: ['判态阈值：黄 = 其余（模型侧）'],
      updated_at: LIVE_NOTE,
    },
    {
      id: 'x_kpi_red',
      label: '不建议井数（红）',
      value: String(ctx.kpi.red),
      unit: '口',
      formula: STATE_FORMULA,
      source: 'derived',
      sample_size: n,
      config_id: 'T05-PROV',
      assumptions: ['判态阈值：红 = P(NPV>0) ≤ 0.30（模型侧）'],
      updated_at: LIVE_NOTE,
    },
    {
      id: 'x_kpi_gray',
      label: '低价值低置信井数（灰）',
      value: String(ctx.kpi.gray),
      unit: '口',
      formula: STATE_FORMULA,
      source: 'derived',
      sample_size: n,
      config_id: 'T05-PROV',
      assumptions: ['判态阈值：灰 = 证据不足 / 方向不明且价值在死区内（模型侧）'],
      updated_at: LIVE_NOTE,
    },
    {
      id: 'x_kpi_budget_gap',
      label: '预算缺口',
      value: num(ctx.kpi.budgetGap, 0),
      unit: '万元',
      formula: 'max(0, 可判定（绿）井数 × 单井措施成本 − 当前预算)；成本与预算均为决策假设旋钮',
      source: 'derived',
      sample_size: n,
      config_id: 'T05-PROV',
      assumptions: [`单井成本 ${ctx.cost} 万元（假设旋钮）`, `预算 ${ctx.budget} 万元（假设旋钮，已吸附到最近可用工况）`],
      updated_at: LIVE_NOTE,
    },
    {
      id: 'x_combo_expected_oil',
      label: '组合期望增油',
      value: num(cm?.expected_oil, 1),
      unit: 'm³',
      formula: '所选井 12 月预测增油（value_oil）求和 —— 期望值线性可加；单井值来自 bundle 预测',
      source: 'derived',
      config_id: 'T05-PROV',
      assumptions: ['加法只对期望成立；分位数（CVaR）不可加，须查表'],
      updated_at: LIVE_NOTE,
    },
    {
      id: 'x_combo_expected_npv',
      label: '组合期望 NPV',
      value: num(cm?.expected_npv, 1),
      unit: '万元',
      formula:
        '所选井期望 NPV 逐井取值后求和（期望线性可加）：参考工况取 bundle.value_npv；偏离工况取 T17 预计算网格 econ_grid（build_econ_grid.py，9 组合 × 77 井全表查表，零前端公式）。分布类指标见下方各条',
      source: 'derived',
      config_id: 'T05-PROV',
      assumptions: ['口径为点估计求和，非蒙特卡洛分布', '油价/成本三档（3040/3800/4560 元/t · 36/45/54 万元）离线预计算'],
      updated_at: LIVE_NOTE,
    },
    {
      id: 'x_combo_loss_prob',
      label: '组合亏损概率',
      value: pct(cm?.loss_prob),
      unit: '',
      formula: 'P(组合 NPV < 0)，模型侧蒙特卡洛预计算，前端按 well_id 排序查表（不现算）',
      source: 'assumption',
      sample_size: 2000,
      config_id: 'T05-PROV',
      assumptions: [mcNote, '查表来源：combo_metrics 优先，缺则回退 portfolio.points，均查不到即显示「暂无」'],
      updated_at: LIVE_NOTE,
    },
    {
      id: 'x_combo_cvar',
      label: '组合 CVaR₅',
      value: num(cm?.cvar, 1),
      unit: '万元',
      formula: 'E[NPV | NPV ≤ VaR₅]（亏损为负，符号约定随 bundle）；块 bootstrap 蒙特卡洛，前端查表',
      source: 'assumption',
      sample_size: 2000,
      config_id: 'T05-PROV',
      assumptions: [mcNote, '井间相关性用块 bootstrap 保留（county × 3 月块），非独立假设'],
      updated_at: LIVE_NOTE,
    },
    {
      id: 'x_combo_hit_rate',
      label: '组合命中率',
      value: pct(cm?.hit_rate),
      unit: '',
      formula: 'P(至少一口井 12 月增油达标)（hit_rate_any 口径），蒙特卡洛预计算，前端查表',
      source: 'assumption',
      sample_size: 2000,
      config_id: 'T05-PROV',
      assumptions: [mcNote, '另有 hit_rate_all（全部井达标）口径，页面显示 hit_rate_any'],
      updated_at: LIVE_NOTE,
    },
    {
      id: 'x_combo_regret',
      label: '组合后悔值',
      value: cm?.regret === null || cm?.regret === undefined ? '暂无' : num(cm.regret, 1),
      unit: '万元',
      formula: '最优组合 NPV − 当前组合 NPV（oracle 用真实结果）；三作用域口径见模型卡 P16',
      source: 'derived',
      config_id: 'T05-PROV',
      assumptions: ['当前选择未入预计算表时为「暂无」（EmptyValue 契约：字段级暂缺，非死路）'],
      updated_at: LIVE_NOTE,
    },
  ]

  const map: Record<string, Passport> = {}
  for (const e of entries) map[e.id] = e
  return map
}
