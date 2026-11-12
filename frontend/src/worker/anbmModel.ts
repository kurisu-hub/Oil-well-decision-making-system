/**
 * T04 · A2 Worker 前端推理 —— ANBM 纯模型（Worker 与主线程兜底共用同一份）
 *
 * 口径来源（全部离线侧已验证，不发明公式）：
 * · 预测：`bundle.final_model.models.ANBM`，form = ŷ(t) = base × c_{bucket(base)}(t)
 *   （pipeline/same_protocol.py `pred_anbm`；bucket_of = 首个 base < bins[i]）
 * · 基线：`base × exp(−D_fit × k)`（pipeline/twin_state.py `baseline_exp`，
 *   m1_existing_exp 同源；已对 bundle 77 口 ×12 月核验，76/77 口 < 1e-3，1 口为 3 位舍入差）
 * · 经济：ΔN = (Σŷ − Σ基线) × 30.4；NPV = ΔN × 0.323 − 45
 *   （pipeline/build_bundle_v31.py PRICE_WAN_PER_M3 / WELL_COST_WAN / DAYS_PER_MONTH；
 *   已对 77 口核验 value_npv = value_oil × 0.323 − 45 最大差 0.02 = 整数舍入链）
 * · 事件类型：本批训练集 72 recompletion / 5 refrac，ANBM 口径不分型（如实记录，不冒用）
 */

export interface AnbmParams {
  /** 分桶边界（含 ±1e9 哨兵，共 5 个 → 4 桶） */
  bins: number[]
  /** 各桶 12 月倍数曲线，key = 桶号字符串 */
  curves: Record<string, number[]>
  /** 全局曲线（桶样本不足时兜底） */
  globalCurve: number[]
}

export interface EconParams {
  /** 万元/m³ */
  price: number
  /** 万元/口 */
  cost: number
  /** 天/月 */
  days: number
}

export interface InferInput {
  /** 锚点：压前日产（m³/d），> 0 */
  anchor: number
  /** 事件前递减率（1/月），≥ 0 */
  dFit: number
  /** 事件类型：recompletion | refrac（ANBM 口径不分型，仅记录） */
  eventType?: string
}

export interface InferResult {
  bucket: number
  /** 12 个月预测（m³/d，月均产率口径） */
  curve: number[]
  /** 12 个月不完井基线（m³/d） */
  baseline: number[]
  /** Σŷ − Σ基线（m³/d·月） */
  sumPred: number
  sumBase: number
  /** ΔN（m³，12 月累计增油） */
  dN: number
  /** NPV（万元） */
  npv: number
  /** 事件类型（透传记录） */
  eventType: string | null
}

export const MONTHS = 12

/**
 * 与 same_protocol.bucket_of 同法。
 * bundle 侧 bins 为含 ±1e9 哨兵的 5 元数组（3 个真实分位），
 * 等价于「数有几个分位 ≤ base」：base=q1 落 1 桶（<q1 → 0 桶），与 3 元数组的
 * 首个 base < bins[i] 逐边一致（已对 77 口井的 bundle.bucket 标签核验）。
 */
export function bucketOf(base: number, bins: number[]): number {
  let k = 0
  for (let j = 1; j < bins.length - 1; j++) {
    if (bins[j] <= base) k++
  }
  return k
}

/** 单口推理（纯函数，无副作用，输入相同输出逐位相同） */
export function infer(input: InferInput, anbm: AnbmParams, econ: EconParams): InferResult {
  const { anchor, dFit } = input
  if (!(anchor > 0) || !Number.isFinite(anchor)) throw new Error('anchor 必须为正数（m³/d）')
  if (!(dFit >= 0) || !Number.isFinite(dFit)) throw new Error('D_fit 必须为非负数（1/月）')

  const b = bucketOf(anchor, anbm.bins)
  const c = anbm.curves[String(b)] ?? anbm.globalCurve
  const curve: number[] = []
  const baseline: number[] = []
  let sumPred = 0
  let sumBase = 0
  for (let t = 0; t < MONTHS; t++) {
    const p = anchor * c[t]
    const bl = anchor * Math.exp(-dFit * (t + 1))
    curve.push(p)
    baseline.push(bl)
    sumPred += p
    sumBase += bl
  }
  const dN = (sumPred - sumBase) * econ.days
  const npv = dN * econ.price - econ.cost
  return {
    bucket: b,
    curve,
    baseline,
    sumPred,
    sumBase,
    dN,
    npv,
    eventType: input.eventType ?? null,
  }
}
