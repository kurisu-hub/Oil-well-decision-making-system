import { computed, reactive, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import {
  getBundle,
  getDataMode,
  getDataVersion,
  isIllustrativeBlock,
  isIllustrativeWell,
  validateBundle,
  realBundleMissing,
} from '@/data/provider'
import type { ComboMetric, Curve, Objective, Passport, PortfolioPoint, Similar, Voi, Well } from '@/types/bundle'
import { buildStaticProv } from '@/data/prov'
import {
  BUDGET_TIERS,
  COST_TIERS,
  GRID_META,
  GRID_VERSION,
  PRICE_TIERS,
  costTierOf,
  gridNpvAt,
  priceTierOf,
} from '@/data/econGrid'

const bundle = getBundle()

function normalize(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/** 月序工具：mi = y*12 + m - 1（与 pipeline / pilot_series 同口径） */
function miOf(ym: string): number {
  const y = Number(ym.slice(0, 4))
  const m = Number(ym.slice(5, 7))
  return y * 12 + m - 1
}
function ymOf(mi: number): string {
  const v = Math.round(mi)
  const y = Math.floor(v / 12)
  const m = v - y * 12 + 1
  return `${y}-${String(m).padStart(2, '0')}`
}

export const useAppStore = defineStore('app', () => {
  const meta = bundle.meta
  const wells = ref<Well[]>(bundle.wells ?? [])
  const curves = ref<Curve[]>(bundle.curves ?? [])
  const similars = ref<Similar[]>(bundle.similar ?? [])
  const vois = ref<Voi[]>(bundle.voi ?? [])
  const passports = ref<Passport[]>(bundle.passport ?? [])
  const geo = (bundle as unknown as { geo?: unknown }).geo ?? null
  const portfolio = bundle.portfolio
  const comboMetrics = bundle.combo_metrics
  const learningCurve = bundle.learning_curve
  const backtest = bundle.backtest
  const ablation = bundle.ablation
  const protocol = bundle.protocol
  // —— 模型自检（只读展示，不参与判态）——
  const stateConfusion = bundle.state_confusion ?? null
  const modelDiagnostics = bundle.model_diagnostics ?? null
  const baselineAudit = bundle.baseline_audit ?? null
  /** final77：交付模型参数与溯源；90% 区间口径说明（模型卡静态页展示，前端不据此推算） */
  const finalModel = bundle.final_model ?? null
  const intervalPolicy = bundle.intervals ?? null
  /** 零参数对照是否不输模型：为真 → 决策层不得把模型状态当自动推荐 */
  const zeroParamWins = !!modelDiagnostics?.zero_param_wins

  const dataMode = getDataMode()
  const realMissing = realBundleMissing()
  const issues = validateBundle(bundle)
  /** 数据版本条：dataset_id / data_mode / n_wells / n_events / generated_at / active file */
  const dataVersion = getDataVersion()

  // —— 投屏模式：只放大「看」的字号与点击目标，不动任何数据 / 契约 ——
  // 用 localStorage 记忆，断网单文件也能记住开关
  const PROJ_KEY = 'weld.projection'
  const projection = ref<boolean>(false)
  try {
    projection.value = localStorage.getItem(PROJ_KEY) === '1'
  } catch {
    /* 隐私模式等场景读不到就按关闭处理 */
  }
  function setProjection(v: boolean) {
    projection.value = v
    try {
      localStorage.setItem(PROJ_KEY, v ? '1' : '0')
    } catch {
      /* 写不进去也不影响本次会话 */
    }
  }
  const toggleProjection = () => setProjection(!projection.value)

  // —— 第一幕筛选 ——
  const buckets = computed(() => [...new Set(wells.value.map((w) => w.bucket))].sort())
  const filters = reactive({
    bucket: '' as string,
    state: '' as string,
    onlyAttention: false, // 只看黄灯（数据不足）
  })

  const filteredWells = computed(() =>
    wells.value.filter((w) => {
      if (filters.bucket && w.bucket !== filters.bucket) return false
      if (filters.state && w.state !== filters.state) return false
      if (filters.onlyAttention && w.state !== 'yellow') return false
      return true
    }),
  )

  // —— 控制轨档位：直接取 bundle 里真实存在的 (budget, risk) 组合，保证拖动必命中查表 ——
  // T17：预算档并入预计算网格三档（90/135/180 = k×单井成本，k=2/3/4），
  // 135 即 portfolio 实有档，与 bundle 同源
  const BUDGET_TICKS = [
    ...new Set([
      ...(portfolio?.points ?? []).map((p) => p.budget),
      ...BUDGET_TIERS,
    ]),
  ].filter((v): v is number => typeof v === 'number').sort((a, b) => a - b)
  const RISK_TICKS = [
    ...new Set((portfolio?.points ?? []).map((p) => p.risk)),
  ].filter((v): v is number => typeof v === 'number').sort((a, b) => a - b)
  /** T17：油价 / 成本三档（元/t · 万元），离线网格 price_tiers / cost_tiers */
  const PRICE_TICKS = [...PRICE_TIERS]
  const COST_TICKS = [...COST_TIERS]

  // —— 假设（仅前端展示，不改 bundle）——
  const REF_OIL_PRICE = 3800 // 参考油价（元/t）= 网格基准档（econ_grid price_tiers[1]）
  const REF_COST = 45 // 参考单井成本（万元）= 网格基准档（cost_tiers[1]）
  const assumptions = reactive({
    // 预算默认 = 网格基准档 k=3（135，即 portfolio 实有档）——不能取 ticks[0]：
    // T17 并入 90/180 后 ticks[0]=90，会让开局就落在吸附态（N-2 回归曾抓到此坑）
    budget: BUDGET_TIERS[1] ?? BUDGET_TICKS[0] ?? 135,
    oilPrice: REF_OIL_PRICE,
    cost: REF_COST,
    risk: RISK_TICKS[0] ?? 0.3,
    objective: 'npv' as Objective,
  })
  const INITIAL_ASSUMPTIONS = { ...assumptions }

  /**
   * 工况命中 = 精确查表（不插值、不外推）。
   * C2 · 就近吸附：查不到（非刻度/越界/目标缺数据）时，吸附到最近可用工况
   * （同目标优先，按预算与风险的归一化距离取最近格），下游永不读到 null——
   * 吸附只改变「选中的那格」，不虚构数值，纯查表语义不变。
   */
  const exactPoint = computed(
    () =>
      (portfolio?.points ?? []).find(
        (p) =>
          p.budget === assumptions.budget &&
          p.risk === assumptions.risk &&
          p.objective === assumptions.objective,
      ) ?? null,
  )
  function nearestPoint(): PortfolioPoint | null {
    const pts = portfolio?.points ?? []
    if (!pts.length) return null
    let bLo = Infinity, bHi = -Infinity, rLo = Infinity, rHi = -Infinity
    for (const p of pts) {
      if (p.budget < bLo) bLo = p.budget
      if (p.budget > bHi) bHi = p.budget
      if (p.risk < rLo) rLo = p.risk
      if (p.risk > rHi) rHi = p.risk
    }
    const db = (x: number) => (bHi > bLo ? (x - bLo) / (bHi - bLo) : 0)
    const dr = (x: number) => (rHi > rLo ? (x - rLo) / (rHi - rLo) : 0)
    const ab = db(assumptions.budget)
    const ar = dr(assumptions.risk)
    let best: PortfolioPoint | null = null
    let bestScore = Infinity
    for (const p of pts) {
      const score =
        (db(p.budget) - ab) ** 2 + (dr(p.risk) - ar) ** 2 + (p.objective === assumptions.objective ? 0 : 1e6)
      if (score < bestScore) {
        bestScore = score
        best = p
      }
    }
    return best
  }
  const activePoint = computed(() => exactPoint.value ?? nearestPoint())
  /** C2 提示：snapped=true 表示当前假设被吸附，reason 是给用户看的一句话 */
  const assumptionSnap = computed(() => {
    if (exactPoint.value) return { snapped: false, reason: null as string | null }
    const p = activePoint.value
    if (!p) return { snapped: false, reason: null }
    const bits: string[] = []
    if (p.budget !== assumptions.budget) bits.push(`预算 ${p.budget}`)
    if (p.risk !== assumptions.risk) bits.push(`风险档 ${p.risk.toFixed(2)}`)
    if (p.objective !== assumptions.objective) bits.push(`目标 ${p.objective}`)
    return { snapped: true, reason: `非刻度输入 → 已吸附最近可用工况（${bits.join(' · ')}）` }
  })
  /** 数据集实有的优化目标（objective 选项据此置灰，防止选到无点目标） */
  const objectivesAvailable = computed(
    () => new Set((portfolio?.points ?? []).map((p) => String(p.objective))),
  )
  /** C2 · 旋钮吸附入口：任意数值 → 落到最近档位（供滑杆与验收钩子共用） */
  function nearestTickOf(ticks: number[], x: number): number {
    if (!ticks.length) return x
    let best = ticks[0]
    let bestD = Infinity
    for (const t of ticks) {
      const d = Math.abs(t - x)
      if (d < bestD) {
        bestD = d
        best = t
      }
    }
    return best
  }
  function setRiskSnapped(v: number): void {
    assumptions.risk = nearestTickOf(RISK_TICKS, v)
  }
  function setBudgetSnapped(v: number): void {
    assumptions.budget = nearestTickOf(BUDGET_TICKS, v)
  }
  /** T17：油价 / 成本滑杆就近吸附到三档，档下标仅供查表（assumptions 里存原值） */
  function setPriceSnapped(v: number): void {
    assumptions.oilPrice = nearestTickOf(PRICE_TICKS, v)
  }
  function setCostSnapped(v: number): void {
    assumptions.cost = nearestTickOf(COST_TICKS, v)
  }

  /** 效率前沿：frontier[i] ↔ points[i]，X=risk(loss_prob)，Y=npv(expected_npv) */
  const frontierPoints = computed(() => {
    const pts = portfolio?.points ?? []
    const fr = portfolio?.frontier ?? []
    const out: {
      i: number
      budget: number | null
      risk: number | null
      objective: string
      x: number
      y: number
      selected: string[]
      active: boolean
    }[] = []
    pts.forEach((p, i) => {
      const f = fr[i]
      const x = normalize(f?.risk ?? p.loss_prob)
      const y = normalize(f?.npv ?? p.expected_npv)
      if (x === null || y === null) return
      out.push({
        i,
        budget: normalize(p.budget),
        risk: normalize(p.risk),
        objective: String(p.objective ?? ''),
        x,
        y,
        selected: p.selected ?? [],
        // C2：active 标记跟随「吸附后的命中格」，与 activePoint 一致
        active: activePoint.value != null && p === activePoint.value,
      })
    })
    return out
  })

  /**
   * T17 · 折算 NPV = 预计算网格查表（pipeline/build_econ_grid.py 离线产出，
   * econ_grid v1 · 9 组合 × 77 井全表随包发布）：
   *   当前油价 → 最近油价档（元/t 三档 3040/3800/4560）
   *   当前成本 → 最近成本档（万元三档 36/45/54）
   *   value_npv(井, p档, c档) = 网格查表，零前端公式。
   * 基准档 (×1.0, ×1.0) 与 bundle.value_npv 一致（最大差 0.02 万元 = 舍入链，
   * pipeline 自检 G2/G3 已核验），参考工况下可自验。
   * 井不在网格覆盖内（理论不可能：77 口全表）→ 「暂无」，不猜。
   */
  function npvAdjusted(w: Well): number | null {
    return gridNpvAt(w.well_id, priceTierOf(assumptions.oilPrice), costTierOf(assumptions.cost))
  }
  const economicsTouched = computed(
    () => assumptions.oilPrice !== REF_OIL_PRICE || assumptions.cost !== REF_COST,
  )
  const npvMode = ref<'bundle' | 'adj'>('bundle')
  /** 井区/KPI 统一取值口径 */
  function npvAt(w: Well): number | null {
    return npvMode.value === 'adj' ? npvAdjusted(w) : normalize(w.value_npv)
  }

  // —— 补资料（VOI）当场算 ——
  // 恒等式（bundle 自洽、可自验）：net_benefit = expected_benefit − cost（120/120 精确）
  //                              expected_benefit = flip_prob × value_npv（118/120，2 口为四舍五入）
  const voiSigma = ref<number | null>(null) // null = 跟随 bundle 的补资料成本
  function resetVoiSigma() {
    voiSigma.value = null
  }
  const voiCalc = computed(() => {
    const v = voiByWell(focusWellId.value)
    if (!v || v.available === false) return null
    const p = normalize(v.flip_prob)
    const B = normalize(v.expected_benefit)
    const sigma0 = normalize(v.cost)
    const sigma = voiSigma.value ?? sigma0
    const enb = B !== null && sigma !== null ? B - sigma : null
    const bundleNb = normalize(v.net_benefit)
    const identity =
      B !== null && sigma0 !== null && bundleNb !== null
        ? Math.abs(B - sigma0 - bundleNb) < 0.02
        : null
    const cur = focusWell.value?.state ?? null
    return {
      p,
      B,
      sigma,
      sigma0,
      enb,
      bundleNb,
      identity,
      recommend: enb !== null ? enb > 0 : null,
      curState: cur,
      flips: cur !== null && cur !== 'green',
      flipTo: 'green' as const,
    }
  })

  // —— 第三幕选择 ——
  /**
   * 默认勾选：有 combo_metrics 时优先用其第一条（模型推荐组合），
   * 这样开局就能命中查表、拿到真实组合指标；否则回退“前 3 口非红非灰井”。
   */
  function defaultSelection(): string[] {
    const cm = bundle.combo_metrics
    if (cm?.available && cm.items?.length) {
      const ids = new Set(wells.value.map((w) => w.well_id))
      const first = (cm.items[0].selected ?? []).filter((id) => ids.has(id))
      if (first.length) return first
    }
    const picks = wells.value
      .filter((w) => w.state !== 'red' && w.state !== 'gray')
      .map((w) => w.well_id)
      .slice(0, 3)
    return picks.length ? picks : wells.value.slice(0, 1).map((w) => w.well_id)
  }

  const selectedWellIds = ref<string[]>(defaultSelection())

  // —— 查表：按 well_id 排序后匹配，命中才给组合指标 ——
  const comboKey = computed(() => [...selectedWellIds.value].sort().join('|'))
  const matchedPoint = computed(
    () =>
      (portfolio?.points ?? []).find(
        (p) => [...(p.selected ?? [])].sort().join('|') === comboKey.value,
      ) ?? null,
  )

  // combo_metrics 索引：key = selected 按 well_id 排序后 join('|')
  const comboIndex = computed(() => {
    const m = new Map<string, ComboMetric>()
    if (comboMetrics?.available) {
      for (const it of comboMetrics.items ?? []) {
        m.set([...(it.selected ?? [])].sort().join('|'), it)
      }
    }
    return m
  })
  const useComboMetrics = computed(() => !!comboMetrics?.available)
  const comboHit = computed(() => comboIndex.value.get(comboKey.value) ?? null)

  /**
   * 可结算候选池：combo_metrics 只给了 C(pool, k) 的全表，
   * 池外井一旦被勾进来必然查不到 → 风险指标只能“暂无”。
   * 这里把池显式暴露给 UI，让第三幕能禁用池外井，避免演示者勾进死路。
   */
  const comboPool = computed(() => {
    const s = new Set<string>()
    if (comboMetrics?.available) {
      for (const it of comboMetrics.items ?? []) for (const id of it.selected ?? []) s.add(id)
    }
    return s
  })
  /** 组合规模（k）：combo_metrics.k，缺省 3 */
  const comboK = computed(() => (typeof comboMetrics?.k === 'number' ? comboMetrics.k : 3))
  /** 该井能否参与组合结算 */
  const isSettleable = (id: string) => comboPool.value.size === 0 || comboPool.value.has(id)

  /**
   * 组合结算口径（不做前端公式，只查表）：
   * - 增油：所选井单井值求和（期望值线性可加，已用 mock 三个 point 验算恒等）；
   *   增油量（m³）不随油价/成本变，恒取 bundle 原值。
   * - NPV：T17 网格口径——npvAt 逐井取值（参考工况 = bundle 原值，
   *   偏离工况 = econ_grid 查表）后求和，期望线性可加。
   * - loss_prob / cvar / hit_rate / regret：
   *     ① 有 combo_metrics → 优先查它，查不到即 null（“暂无”）
   *     ② 没有 combo_metrics → 回退查 portfolio.points，查不到同样“暂无”
   *     （分布类指标不在 T17 网格内——P4 蒙特卡洛按工况重算是新实验，不冒充）
   */
  const combo = computed(() => {
    const picked = wells.value.filter((w) => selectedWellIds.value.includes(w.well_id))
    const oil = picked.reduce((s, w) => s + (normalize(w.value_oil) ?? 0), 0)
    const npv = picked.reduce((s, w) => s + (npvAt(w) ?? 0), 0)
    const hit = comboHit.value
    const pt = matchedPoint.value
    const src = hit ? 'combo_metrics' : useComboMetrics.value ? null : pt ? 'portfolio.points' : null
    return {
      selected: [...selectedWellIds.value].sort(),
      count: picked.length,
      expected_oil: picked.length ? oil : null,
      expected_npv: picked.length ? npv : null,
      loss_prob: hit ? normalize(hit.loss_prob) : useComboMetrics.value ? null : pt ? normalize(pt.loss_prob) : null,
      cvar: hit ? normalize(hit.cvar) : useComboMetrics.value ? null : pt ? normalize(pt.cvar) : null,
      hit_rate: hit ? normalize(hit.hit_rate) : useComboMetrics.value ? null : pt ? normalize(pt.hit_rate) : null,
      regret: hit ? normalize(hit.regret) : useComboMetrics.value ? null : pt ? normalize(pt.regret) : null,
      matched: !!hit || (!useComboMetrics.value && !!pt),
      source: src as 'combo_metrics' | 'portfolio.points' | null,
    }
  })

  // —— 四象限 ——
  /**
   * 状态口径（2026-10-27 修）：
   * 唯一权威 = bundle 的 well.state —— 模型侧按「12 个月累计量的经验分布」判：
   *   红 = P(NPV>0) ≤ 0.30（≥70% 把握亏钱）；绿 = P>0.70 且 NPV>0；
   *   灰 = 证据不足 / 方向不明且价值在死区内；其余为黄。
   * 不再由前端用 npv/confidence 现算（旧口径下 77/77 口井 q≥1，
   * 逐月共形区间全被停产月顶穿，导致「高置信负价值」永远出不了红、全落灰）。
   * 只有 bundle 缺 state 时才退回本地阈值推，并由 stateSource 标出「本地推」。
   */
  const npvThreshold = ref(0)
  const confThreshold = ref(0.6)
  type Quad = 'green' | 'yellow' | 'red' | 'gray'
  function quadrantOf(w: Well): Quad {
    const s = w.state
    if (s === 'green' || s === 'yellow' || s === 'red' || s === 'gray') return s
    // 兜底：bundle 没给 state 才本地推（前端口径，非模型产出）
    const npv = normalize(w.value_npv) ?? 0
    const conf = normalize(w.confidence) ?? 0
    const highV = npv > npvThreshold.value
    const highC = conf >= confThreshold.value
    if (highV && highC) return 'green'
    if (highV && !highC) return 'yellow'
    if (!highV && highC) return 'red'
    return 'gray'
  }
  /** 状态来源：'bundle' = 模型侧判态；'local' = 前端兜底推（bundle 缺 state） */
  const stateSource = computed<'bundle' | 'local'>(() =>
    wells.value.every((w) => !!w.state) ? 'bundle' : 'local',
  )
  /** 该井的判态理由（模型侧给出，逐井可查，不编造） */
  function stateReasonOf(w: Well | null): string | null {
    return w?.state_reason ?? null
  }
  const quadrantGroups = computed(() => {
    const g: Record<Quad, Well[]> = { green: [], yellow: [], red: [], gray: [] }
    for (const w of filteredWells.value) g[quadrantOf(w)].push(w)
    return g
  })
  const kpi = computed(() => {
    const g = quadrantGroups.value
    const budgetGap = Math.max(0, g.green.length * assumptions.cost - assumptions.budget)
    return {
      green: g.green.length,
      yellow: g.yellow.length,
      red: g.red.length,
      gray: g.gray.length,
      budgetGap,
    }
  })

  // —— 沙盘：焦点井 + 时间轴（只读 bundle，不落任何推算公式）——
  /** 焦点井：优先绿（可判定），其次黄（数据不足），再退化第一口 */
  const focusWellId = ref<string>(
    wells.value.find((w) => w.state === 'green')?.well_id ??
      wells.value.find((w) => w.state === 'yellow')?.well_id ??
      wells.value[0]?.well_id ??
      '',
  )
  const focusWell = computed(() => wellById(focusWellId.value))
  const focusCurve = computed(() => curveByWell(focusWellId.value))
  const focusVoi = computed(() => voiByWell(focusWellId.value))

  // —— 历史回放时钟（T01）——
  // 唯一时间源 = replayMi（绝对月序 mi = y*12+m-1，与 bundle/pipeline 同口径）。
  // 曲线游标 / 三维推演 / KPI 三处全部由它派生，不再各存一份「时间」。
  const scope = (meta as unknown as { scope?: { event_month_min?: string; event_month_max?: string } }).scope
  // 月份范围兜底：从 curves 的 prediction[].month 求 min/max（YYYY-MM 字典序即时间序）
  const curveMonths: string[] = []
  for (const c of curves.value) {
    for (const p of (c.prediction ?? []) as { month?: string }[]) {
      if (p.month) curveMonths.push(p.month)
    }
  }
  curveMonths.sort()
  const REPLAY_MIN = miOf(scope?.event_month_min ?? curveMonths[0] ?? '2014-09')
  const REPLAY_MAX = miOf(scope?.event_month_max ?? curveMonths[curveMonths.length - 1] ?? '2024-08')

  /** 井 → 事件月序（由 curves[].event_month 直接取，不另算） */
  const eventMiByWell = new Map<string, number>()
  for (const c of curves.value) {
    const ym = (c as unknown as { event_month?: string }).event_month
    if (ym) eventMiByWell.set(c.well_id, miOf(ym))
  }

  /** 回放位置：默认停在数据集末端（打开即「看完全部历史」，不假装实时） */
  const replayMi = ref(REPLAY_MAX)
  const replayPlaying = ref(false)
  /** 倍速：1× = 1 月/秒 */
  const replaySpeed = ref<1 | 4 | 16>(1)

  const clampMi = (mi: number) => Math.max(REPLAY_MIN, Math.min(REPLAY_MAX, Math.round(mi)))
  const replayMonth = computed(() => ymOf(replayMi.value)) // 'YYYY-MM'
  /** 数据集覆盖区间（事件窗口，取 meta.scope；T02 时刻条印这一行） */
  const replayRange = computed(() => ({ min: ymOf(REPLAY_MIN), max: ymOf(REPLAY_MAX) }))
  const replayIdx = computed(() => replayMi.value - REPLAY_MIN)
  const replayTotal = computed(() => Math.max(1, REPLAY_MAX - REPLAY_MIN))
  const replayFrac = computed(() => replayIdx.value / replayTotal.value)

  /** 拖动：按 0–1 比例定位 */
  function seekReplayFrac(frac: number) {
    replayMi.value = clampMi(REPLAY_MIN + frac * replayTotal.value)
  }
  /** 步进（月） */
  function stepReplay(n: number) {
    replayMi.value = clampMi(replayMi.value + n)
  }
  function toggleReplay() {
    // 已在末端再点播放 → 从头放
    if (!replayPlaying.value && replayMi.value >= REPLAY_MAX) replayMi.value = REPLAY_MIN
    replayPlaying.value = !replayPlaying.value
  }
  function setReplaySpeed(s: 1 | 4 | 16) {
    replaySpeed.value = s
  }
  function resetReplay() {
    replayPlaying.value = false
    replayMi.value = REPLAY_MAX
  }
  /** 播放推进：dtMs 为真实毫秒；1× = 1000ms/月 */
  function advanceReplay(dtMs: number) {
    if (!replayPlaying.value) return
    const months = (dtMs / 1000) * replaySpeed.value
    const next = replayMi.value + months
    if (next >= REPLAY_MAX) {
      replayMi.value = REPLAY_MAX
      replayPlaying.value = false // 到端点自动停，不循环（避免「数据在跑」的错觉）
    } else {
      replayMi.value = next
    }
  }

  /**
   * 焦点跟随回放（T01）：
   * 回放走到 M 月时，焦点井自动切到「截至 M 最近发生事件」的那口井——
   * 否则焦点井一旦早于 M−12 月，游标恒为 M12，拖动时间轴曲线不动，验收形同虚设。
   * 用户手动选井后置 pinned，不再自动抢焦点；回放条上可开关。
   */
  const focusPinned = ref(false)
  const autoFocus = ref(true)
  /** 焦点跟随时钟关闭时游标冻结值（D-040：关闭后拖时间轴，游标停在原值） */
  const frozenCursor = ref<number | null>(null)
  function setAutoFocus(v: boolean) {
    autoFocus.value = v
    if (!v) {
      focusPinned.value = true
      frozenCursor.value = timelineMonth.value // 冻结当前游标
    } else {
      focusPinned.value = false
      frozenCursor.value = null
    }
  }
  /** 截至 mi 最近发生事件的井；早于全部事件时取最早一口 */
  function nearestEventWell(mi: number): string | null {
    let best: string | null = null
    let bestMi = -Infinity
    let earliest: string | null = null
    let earliestMi = Infinity
    for (const [id, e] of eventMiByWell) {
      if (e <= mi && e > bestMi) { bestMi = e; best = id }
      if (e < earliestMi) { earliestMi = e; earliest = id }
    }
    return best ?? earliest
  }
  watch(
    () => replayMi.value,
    (v) => {
      if (!autoFocus.value || focusPinned.value) return
      const id = nearestEventWell(Math.round(v))
      if (id && id !== focusWellId.value) {
        focusWellId.value = id
        resetVoiSigma()
      }
    },
  )

  /**
   * 沙盘游标：0 = 该井措施月，12 = 第 12 个月。
   * 由回放时钟与焦点井事件月派生——焦点井在回放时刻尚未措施时，稳定停在 0。
   */
  const focusEventMi = computed(() => {
    const e = eventMiByWell.get(focusWellId.value)
    return e === undefined ? REPLAY_MAX : e
  })
  const timelineMonth = computed(() => {
    if (frozenCursor.value !== null) return frozenCursor.value // D-040：跟随关闭，游标冻结
    return Math.max(0, Math.min(12, Math.round(replayMi.value) - focusEventMi.value))
  })
  /** 旧写入口（0–12）→ 换算成回放位置，保持原有拖拽手势不变 */
  function setTimelineMonth(n: number) {
    replayMi.value = clampMi(focusEventMi.value + Math.max(0, Math.min(12, Math.round(n))))
  }

  /** 回放态 KPI：截至数据时刻，已入场 / 已满 12 月观察 的井数与四象限分布 */
  const replayKpi = computed(() => {
    const cur = Math.round(replayMi.value)
    const q: Record<Quad, number> = { green: 0, yellow: 0, red: 0, gray: 0 }
    let entered = 0
    let observed = 0
    for (const w of wells.value) {
      const e = eventMiByWell.get(w.well_id)
      if (e === undefined || e > cur) continue
      entered += 1
      q[quadrantOf(w)] += 1
      if (e + 12 <= cur) observed += 1
    }
    return {
      month: ymOf(cur),
      entered,
      observed,
      pending: wells.value.length - entered,
      total: wells.value.length,
      ...q,
    }
  })
  function setFocus(id: string) {
    if (!id || id === focusWellId.value) return
    focusWellId.value = id
    focusPinned.value = true // 手动选井后，回放不再抢焦点
    resetVoiSigma()
  }

  // —— 场景对比（保存 / 重置）：只存前端假设快照，不写回 bundle ——
  const DEFAULT_THRESHOLDS = { npv: 0, conf: 0.6 }
  interface Scenario {
    id: string
    name: string
    at: string
    budget: number
    oilPrice: number
    cost: number
    risk: number
    objective: Objective
    green: number
    yellow: number
    red: number
    gray: number
    gap: number
  }
  const scenarios = ref<Scenario[]>([])
  let scenarioSeq = 0
  function saveScenario() {
    const g = quadrantGroups.value
    scenarioSeq += 1
    scenarios.value.unshift({
      id: 'S' + scenarioSeq,
      name: `S${String(scenarioSeq).padStart(2, '0')}`,
      at: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
      budget: assumptions.budget,
      oilPrice: assumptions.oilPrice,
      cost: assumptions.cost,
      risk: assumptions.risk,
      objective: assumptions.objective,
      green: g.green.length,
      yellow: g.yellow.length,
      red: g.red.length,
      gray: g.gray.length,
      gap: kpi.value.budgetGap,
    })
    if (scenarios.value.length > 8) scenarios.value = scenarios.value.slice(0, 8)
  }
  function removeScenario(id: string) {
    scenarios.value = scenarios.value.filter((s) => s.id !== id)
  }
  function resetAssumptions() {
    Object.assign(assumptions, INITIAL_ASSUMPTIONS)
    npvThreshold.value = DEFAULT_THRESHOLDS.npv
    confThreshold.value = DEFAULT_THRESHOLDS.conf
    npvMode.value = 'bundle'
    resetVoiSigma()
  }

  // —— 查找器 ——
  const wellById = (id: string) => wells.value.find((w) => w.well_id === id) ?? null
  const curveByWell = (id: string) => curves.value.find((c) => c.well_id === id) ?? null
  const similarByWell = (id: string) => similars.value.find((s) => s.well_id === id) ?? null
  const voiByWell = (id: string) => vois.value.find((v) => v.well_id === id) ?? null
  // T05：x_ 前缀 = 前端补录条目（聚合/查表数字的溯源，值实时取页面状态）；
  // p_ 前缀照旧走 bundle passport（唯一事实源）
  const staticProv = computed(() =>
    buildStaticProv({
      kpi: kpi.value,
      nWells: wells.value.length,
      cost: assumptions.cost,
      budget: assumptions.budget,
      combo: combo.value,
      comboMethod: comboMetrics?.method ?? null,
    }),
  )
  const passportById = (id: string) =>
    (id.startsWith('x_') ? staticProv.value[id] : undefined) ?? passports.value.find((p) => p.id === id) ?? null
  const illustrativeWell = (id: string) => isIllustrativeWell(id)
  const illustrativeBlock = (b: keyof typeof bundle) => isIllustrativeBlock(b)

  // —— 全局数字护照抽屉 ——
  const passportDrawer = reactive({ open: false, ids: [] as string[], title: '' })
  function openPassport(ids: string[], title = '数字护照') {
    passportDrawer.ids = ids
    passportDrawer.title = title
    passportDrawer.open = true
  }
  function closePassport() {
    passportDrawer.open = false
  }
  const passportEntries = computed(() =>
    passportDrawer.ids.map((id) => ({ id, entry: passportById(id) })),
  )

  const actions = reactive<Record<string, string>>({})
  function setAction(wellId: string, action: string) {
    actions[wellId] = action
  }

  return {
    meta,
    geo,
    wells,
    curves,
    similars,
    vois,
    passports,
    portfolio,
    comboMetrics,
    learningCurve,
    backtest,
    ablation,
    protocol,
    dataMode,
    realMissing,
    issues,
    dataVersion,
    projection,
    setProjection,
    toggleProjection,
    filters,
    buckets,
    filteredWells,
    assumptions,
    BUDGET_TICKS,
    RISK_TICKS,
    PRICE_TICKS,
    COST_TICKS,
    REF_OIL_PRICE,
    REF_COST,
    GRID_VERSION,
    GRID_META,
    setPriceSnapped,
    setCostSnapped,
    activePoint,
    exactPoint,
    assumptionSnap,
    objectivesAvailable,
    setRiskSnapped,
    setBudgetSnapped,
    frontierPoints,
    npvMode,
    npvAt,
    npvAdjusted,
    economicsTouched,
    voiSigma,
    voiCalc,
    resetVoiSigma,
    selectedWellIds,
    matchedPoint,
    combo,
    comboPool,
    comboK,
    isSettleable,
    stateConfusion,
    modelDiagnostics,
    baselineAudit,
    finalModel,
    intervalPolicy,
    zeroParamWins,
    npvThreshold,
    confThreshold,
    quadrantOf,
    stateSource,
    stateReasonOf,
    quadrantGroups,
    kpi,
    focusWellId,
    focusWell,
    focusCurve,
    focusVoi,
    // —— 历史回放（T01）：唯一时间源 ——
    replayMi,
    replayPlaying,
    replaySpeed,
    replayMonth,
    replayRange,
    replayIdx,
    replayTotal,
    replayFrac,
    replayKpi,
    replayMin: REPLAY_MIN,
    replayMax: REPLAY_MAX,
    seekReplayFrac,
    stepReplay,
    toggleReplay,
    setReplaySpeed,
    resetReplay,
    advanceReplay,
    timelineMonth,
    setTimelineMonth,
    focusPinned,
    autoFocus,
    setAutoFocus,
    setFocus,
    scenarios,
    saveScenario,
    removeScenario,
    resetAssumptions,
    wellById,
    curveByWell,
    similarByWell,
    voiByWell,
    passportById,
    illustrativeWell,
    illustrativeBlock,
    passportDrawer,
    openPassport,
    closePassport,
    passportEntries,
    actions,
    setAction,
  }
})
