// bundle.json 契约类型（契约 v1.0 冻结字段 + v1.1 拟新增块）
// 规则：前端只读，不改字段；缺失一律 null / available:false，页面显示“暂无”。

// real_pilot = pilot 实测（120 井/120 事件，工程验证用），real = 正式全量
export type DataMode = 'synthetic' | 'real_pilot' | 'real'
export type DecisionState = 'green' | 'yellow' | 'red' | 'gray'
export type Objective = 'npv' | 'oil' | 'roi' | 'risk'
export type StrategyId = 'you' | 'ai' | 'expert' | 'history' | 'random'
export type SourceLevel = 'paper' | 'synthetic' | 'live' | 'assumption' | 'illustrative' | 'derived'

export interface Point {
  month: string
  oil: number
  lo?: number
  hi?: number
}

export interface Meta {
  dataset_id: string
  generated_at: string
  data_mode: DataMode
  /** 事件定义版本：v1=宽口径，v2=收紧，v2c=v2+前状态符号 bug 修正后再过滤 */
  event_definition?: 'v1' | 'v2' | 'v2c'
  event_definition_label?: string
  /** 发布变体：final77 = 在 77 事件上全量重训的交付版（event_definition 仍为 v2c） */
  release?: string
  model_version: string
  config_id: string
  source: string
  n_wells: number
  n_events: number
  units: { oil: string; money: string }
  caveats: string[]
}

export interface Well {
  well_id: string
  name: string
  county: string
  formation: string
  api: string
  anchor: number
  bucket: string
  current_oil: number
  value_npv: number
  value_oil: number
  roi: number
  confidence: number
  state: DecisionState
  state_reason?: string
  uncertainty: { aleatoric: number; data: number; model: number; economic: number }
  evidence: {
    similar_ids: string[]
    features: { name: string; value: string; direction: 'up' | 'down' | 'neutral' }[]
  }
  data_gaps: string[]
  recommended_action: string
  passport_ids: string[]
  available: boolean
  /** P1 新增：事件类型（PR = 生产井再完井 / SI = 关井复产） */
  population?: 'PR' | 'SI' | string
  /** P3 新增：单月零产概率（两部共形 · 零质量层） */
  zero_prob?: number
  zero_prob_lo?: number
  zero_prob_hi?: number
  /** P3 新增：12 个月内至少一个月产油（SI 才有值） */
  revival_prob?: number | null
  revival_prob_monthly?: number | null
}

export interface Curve {
  well_id: string
  event_month: string
  history: Point[]
  /** 实测序列（final77 bundle 未下发，视图层降级用 history；待算法侧确认口径） */
  actual?: Point[]
  baseline: Point[]
  prediction: Point[]
  break_even: number
  response_lag_months: number
  available: boolean
  /** 区间口径（final77 起）：下界被非负截断时应标「单边区间（下界截断于 0）」 */
  interval_kind?: 'one_sided_lower_clipped_at_zero' | string
  n_lower_clipped?: number
  q90?: number
}

export interface Similar {
  well_id: string
  items: {
    event_id: string
    well_id: string
    distance: number
    anchor: number
    actual: Point[]
  }[]
}

export interface PortfolioPoint {
  budget: number
  risk: number
  objective: Objective
  selected: string[]
  expected_oil: number
  expected_npv: number
  loss_prob: number
  cvar: number
  hit_rate: number
  regret: number
}

export interface Strategy {
  id: StrategyId
  label: string
  selected: string[]
  expected_oil: number
  expected_npv: number
  loss_prob: number
  hit_rate: number
  regret: number
}

export interface Portfolio {
  points: PortfolioPoint[]
  strategies: Strategy[]
  frontier: { risk: number; npv: number; objective: Objective }[]
  available: boolean
}

export interface Voi {
  well_id: string
  cost: number
  flip_prob: number
  expected_benefit: number
  net_benefit: number
  recommended: boolean
  available: boolean
}

export interface Passport {
  id: string
  label: string
  value: string
  unit: string
  formula: string
  source: SourceLevel
  sample_size?: number
  config_id?: string
  assumptions?: string[]
  updated_at: string
}

// —— 契约 v1.1 拟新增（第四幕四块）；未产出前一律 undefined → “暂无” ——
export interface LearningCurve {
  available: boolean
  source: SourceLevel
  x_label: string
  y_label: string
  points: { n_train: number; smape: number; lo?: number; hi?: number }[]
}

export interface Backtest {
  available: boolean
  source: SourceLevel
  unit: string
  items: { period: string; system: number; actual: number; expert: number }[]
}

export interface Ablation {
  available: boolean
  source: SourceLevel
  label: string
  variants: { id: string; label: string; rho_on: boolean; smape: number; hit_rate: number }[]
}

export interface Protocol {
  available: boolean
  source: SourceLevel
  rules: { id: string; title: string; status: 'pass' | 'fail' | 'na'; detail: string }[]
  qc: { stage: string; n_in: number; n_out: number }[]
}

/**
 * 组合指标（契约新增，只加不改）：模型侧预计算的组合级指标。
 * 前端不推算，只按 selected（well_id 排序后）查表；查不到即“暂无”。
 */
export interface ComboMetric {
  selected: string[]
  expected_oil?: number
  expected_npv?: number
  loss_prob: number
  cvar: number
  hit_rate: number
  regret: number
}

export interface ComboMetrics {
  available: boolean
  k: number // 组合规模，如 3
  n_total: number // 理论组合数，如 C(20,3)=1140
  n_items: number // 实际产出条数（Top-N）
  method?: string
  items: ComboMetric[]
}

/**
 * 状态混淆矩阵（模型诊断块，只加不改）：
 * 模型状态 vs 事后实际（12 个月实测累计 / 递减外推基线 ≥1 = good）。
 * 前端只读展示，不参与判态——判态在模型侧完成，写进 well.state。
 */
export interface StateConfusion {
  definition?: string
  model_state_dist: Record<DecisionState, number>
  actual_dist: { good: number; bad: number }
  matrix: Record<
    DecisionState,
    { n: number; n_good: number; n_bad: number; precision: number; act_ratio_median?: number }
  >
  coverage_of_decisions?: number
  accuracy_on_decided?: number
  /** 红态证据链：高置信负价值能不能出红（给数 / 给原因，不硬造） */
  red_evidence?: Record<string, unknown>
  /** 状态能否由 (npv, conf, pre_nz) 唯一复算出来 */
  state_map_ok?: boolean
  thresholds?: Record<string, number | string>
  note?: string
}

/** 模型自检：四指标交叉验证 + 零参数对照，用来判断「模型到底学没学到」 */
export interface ModelDiagnostics {
  protocol_used?: string
  zero_param_wins?: boolean
  verdict?: string
  models?: Record<
    string,
    {
      n: number
      smape: number
      smape_median?: number
      mae_m3d?: number
      rmse_m3d?: number
      logmae?: number
      skill_vs_flat?: number
      cum_smape_pct?: number
      spearman?: number | null
      scale?: Record<string, number>
    }
  >
}

/** 基线审计：递减率 D 的拟合情况 + 实际/基线比（纯数据事实，不含模型） */
export interface BaselineAudit {
  definition?: string
  D_pool?: number
  n_D_fallback?: number
  n_D_zero?: number
  n_total?: number
  act_over_base?: { n: number; median: number; frac_ge_1: number; p25?: number; p75?: number }
  anchor_source?: string
  anchor_max_abs_diff_m3d?: number
  note?: string
}

export interface Bundle {
  schema_version: string
  meta: Meta
  wells: Well[]
  curves: Curve[]
  similar: Similar[]
  portfolio: Portfolio
  voi: Voi[]
  passport: Passport[]
  learning_curve?: LearningCurve
  backtest?: Backtest
  ablation?: Ablation
  protocol?: Protocol
  combo_metrics?: ComboMetrics
  state_confusion?: StateConfusion
  model_diagnostics?: ModelDiagnostics
  baseline_audit?: BaselineAudit
  /** final77：交付模型的参数与溯源（finalize_final77.py 产出） */
  final_model?: FinalModel
  /** 90% 区间口径说明：为什么 prediction[].lo 恒为 0 */
  intervals?: IntervalPolicy
}

/** 90% 区间的口径与「下界恒为 0」的定性结论 */
export interface IntervalPolicy {
  target_coverage?: string
  scale?: string
  kind?: 'one_sided_lower_clipped_at_zero' | string
  label_cn?: string
  n_points_total?: number
  n_lower_clipped?: number
  n_math_lower_positive?: number
  q90?: Record<string, number>
  why?: string
  why_q_ge_1?: string
  frac_months_zero?: number
  counterfactual_asymmetric?: string
  verdict?: string
}

/** final77 最终模型（只读展示；推理参数随 bundle 一起交付） */
export interface FinalModel {
  schema_version?: string
  kind?: string
  generated_at?: string
  training?: Record<string, unknown>
  models?: Record<string, unknown>
  conformal?: Record<string, unknown>
  provenance?: { deterministic?: boolean; seed?: number; script?: string; [k: string]: unknown }
  legacy_audit?: { verdict?: string; n_under_legacy?: number; [k: string]: unknown }
  intended_use?: string
  limitations?: string[]
  final77_metrics?: Record<string, unknown>
}
