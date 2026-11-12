import type { Bundle, Curve, Passport, Similar, Voi, Well } from '@/types/bundle'
// 硬约束：JSON 用 import 引入，禁止 fetch（file:// 下 fetch 会被 CORS 拦）。
import mockRaw from '@/data/mock_bundle.json'
import supplementRaw from '@/data/mock_supplement.json'

// 可选数据源：文件存在才加载，缺失时构建不会失败。
//
// ── 数据源优先级（收口口径，2026-10-27 冻结；2026-11-10 D-053 更新）────
//   **当前生效源 = ./bundle_v3.json**（v3.1，含 actual / pi_seq_* / passport）
//   1. ./bundle.json                     正式全量（real）
//   2. ./pilot_bundle_final77.json       final77（11-09 存档、字段不全、无 actual/pi_seq，非当前数据源，不得据其判缺失）
//   3. ./pilot_bundle_v2c_fixed.json     v2c      （修复版，兜底）
//   4. ./archive/pilot_bundle_v2.json    v2       （已归档，见下）
//   5. ./archive/pilot_bundle_v1.json    v1       （已归档，见下）
//   6. mock_bundle.json + mock_supplement.json   仅设计模式 / 回退兜底
//
// 注意：import.meta.glob(eager) 会把命中的文件**全部**内联进单文件产物，
// 而交付要求 release 不得含 v1/v2/旧数据 —— 所以 v2/v1 只做物理归档
// （src/data/archive/），**不写 glob、不参与构建**。
// 需要临时回滚对比：把文件移回 src/data/，并解开下面两行的注释即可，链条顺序已按上面排好。
// const pilotV2Modules = import.meta.glob('./archive/pilot_bundle_v2.json', { eager: true })
// const pilotV1Modules = import.meta.glob('./archive/pilot_bundle_v1.json', { eager: true })
// ────────────────────────────────────────────────────────────────────
const finalModules = import.meta.glob('./bundle.json', { eager: true }) as Record<
  string,
  { default: unknown }
>
// ⚠️ P9 体积控制（2026-11-03）：v3.1 稳定后，final77 / v2c 的 eager glob 已关闭。
//    eager 会把命中的 JSON **全部内联**进单文件，这两份合计约 1.2 MB 纯冗余。
//    需要回退对比时：取消下方两行注释，并在 resolve() 里恢复 pilotHit 分支即可。
// const pilotFinal77Modules = import.meta.glob('./pilot_bundle_final77.json', { eager: true })
// const pilotV2cModules = import.meta.glob('./pilot_bundle_v2c_fixed.json', { eager: true })
// v3.1 = P1–P5 产出的当前基线（actual / population / geo / assumptions / evidence / pool_rule）
const bundleV3Modules = import.meta.glob('./bundle_v3.json', {
  eager: true,
}) as Record<string, { default: unknown }>

/** schema 主版本校验：v3 数据契约与 v1/v2 不兼容，主版本不符直接拒绝 */
function schemaOk(b: unknown): boolean {
  const v = (b as { schema_version?: string })?.schema_version
  return typeof v === 'string' && v.split('.')[0] === '3'
}

export type DataMode = 'mock' | 'real_pilot' | 'real'

/** 取命中文件，同时记住它来自哪个文件名（用于数据版本条展示 active file） */
function firstOf(m: Record<string, { default: unknown }>): { bundle: Bundle; file: string } | null {
  for (const [path, mod] of Object.entries(m)) {
    if (!mod?.default) continue
    return { bundle: mod.default as Bundle, file: path.replace(/^\.\//, '') }
  }
  return null
}

function readEnvMode(): DataMode | 'auto' {
  const m = (import.meta.env?.VITE_DATA_MODE as string | undefined) ?? 'auto'
  if (m === 'real' || m === 'real_pilot' || m === 'mock') return m
  return 'auto'
}

const mockBase = mockRaw as unknown as Bundle
const supplement = supplementRaw as unknown as {
  source: string
  illustrative_well_ids: string[]
  illustrative_blocks: string[]
  wells: Well[]
  curves: Curve[]
  similar: Similar[]
  voi: Voi[]
  passport: Passport[]
  learning_curve?: Bundle['learning_curve']
  backtest?: Bundle['backtest']
  ablation?: Bundle['ablation']
  protocol?: Bundle['protocol']
}

/**
 * 合并规则（只新增，不改动）：
 * - 主 mock_bundle.json 的条目一律保留，补充文件里同 id 的条目【不覆盖】；
 * - 补充文件仅追加主 bundle 里不存在 well_id / passport id 的条目；
 * - 第四幕四块（learning_curve/backtest/ablation/protocol）整体由补充文件提供。
 */
function mergeMock(): Bundle {
  const wellIds = new Set(mockBase.wells.map((w) => w.well_id))
  const curveIds = new Set(mockBase.curves.map((c) => c.well_id))
  const similarIds = new Set(mockBase.similar.map((s) => s.well_id))
  const voiIds = new Set(mockBase.voi.map((v) => v.well_id))
  const passportIds = new Set(mockBase.passport.map((p) => p.id))

  return {
    ...mockBase,
    wells: [
      ...mockBase.wells,
      ...supplement.wells.filter((w) => !wellIds.has(w.well_id)),
    ],
    curves: [
      ...mockBase.curves,
      ...supplement.curves.filter((c) => !curveIds.has(c.well_id)),
    ],
    similar: [
      ...mockBase.similar,
      ...supplement.similar.filter((s) => !similarIds.has(s.well_id)),
    ],
    voi: [...mockBase.voi, ...supplement.voi.filter((v) => !voiIds.has(v.well_id))],
    passport: [
      ...mockBase.passport,
      ...supplement.passport.filter((p) => !passportIds.has(p.id)),
    ],
    learning_curve: supplement.learning_curve,
    backtest: supplement.backtest,
    ablation: supplement.ablation,
    protocol: supplement.protocol,
  }
}

const mergedMock: Bundle = mergeMock()

const finalHit = firstOf(finalModules)
const v3Hit = firstOf(bundleV3Modules)
// 回退链已关闭（见上方说明）：需要时恢复 pilotHit 定义


/** 数据源优先级：v3.1 > 正式全量(real) > pilot 实测(final77 > v2c) > mock(+示意补充) */
function resolve(): { id: DataMode; bundle: Bundle; file: string; fallback: boolean } {
  const forced = readEnvMode()
  if (forced === 'mock') return { id: 'mock', bundle: mergedMock, file: 'mock_bundle.json', fallback: false }
  if (forced === 'real') {
    return finalHit
      ? { id: 'real', bundle: finalHit.bundle, file: finalHit.file, fallback: false }
      : { id: 'mock', bundle: mergedMock, file: 'mock_bundle.json', fallback: true }
  }
  if (forced === 'real_pilot') {
    // 优先 v3.1；schema 主版本不符则不采用
    if (v3Hit && schemaOk(v3Hit.bundle))
      return { id: 'real_pilot', bundle: v3Hit.bundle, file: v3Hit.file, fallback: false }
    return { id: 'mock', bundle: mergedMock, file: 'mock_bundle.json', fallback: true }
  }
  // auto：v3.1 一旦落到 src/data/ 就自动生效
  if (v3Hit && schemaOk(v3Hit.bundle))
    return { id: 'real_pilot', bundle: v3Hit.bundle, file: v3Hit.file, fallback: false }
  if (finalHit) return { id: 'real', bundle: finalHit.bundle, file: finalHit.file, fallback: false }
  return { id: 'mock', bundle: mergedMock, file: 'mock_bundle.json', fallback: false }
}

const resolved = resolve()

/**
 * 当前生效的 bundle。
 * real / real_pilot 下【不加载】示意补充文件 → 缺块与空象限显示“暂无”。
 */
export function getBundle(): Bundle {
  return resolved.bundle
}

export function getDataMode(): DataMode {
  return resolved.id
}

/** 当前生效的数据文件名（数据版本条展示用；不编造，取自实际命中路径） */
export function getActiveFile(): string {
  return resolved.file
}

/** 数据版本条的完整信息集合；缺字段一律 null，视图层显示“暂无” */
export interface DataVersion {
  datasetId: string | null
  dataMode: DataMode
  nWells: number | null
  nEvents: number | null
  generatedAt: string | null
  activeFile: string
  fallback: boolean
}
export function getDataVersion(): DataVersion {
  const m = resolved.bundle.meta ?? ({} as Bundle['meta'])
  return {
    datasetId: m.dataset_id ?? null,
    dataMode: resolved.id,
    nWells: typeof m.n_wells === 'number' ? m.n_wells : null,
    nEvents: typeof m.n_events === 'number' ? m.n_events : null,
    generatedAt: m.generated_at ?? null,
    activeFile: resolved.file,
    fallback: resolved.fallback,
  }
}

/** 指定了 real/real_pilot 但对应文件缺失，已回退 mock（用于角标告警） */
export function realBundleMissing(): boolean {
  return resolved.fallback
}

/** 来自示意补充文件的井：UI 必须打“示意”角标 */
export function isIllustrativeWell(wellId: string): boolean {
  if (resolved.id !== 'mock') return false
  return supplement.illustrative_well_ids.includes(wellId)
}

/** 来自示意补充文件的区块：UI 必须打“示意”角标 */
export function isIllustrativeBlock(block: keyof Bundle): boolean {
  if (resolved.id !== 'mock') return false
  return supplement.illustrative_blocks.includes(block as string)
}

/** 契约校验：只报告，不阻断。缺字段由视图层显示“暂无”。 */
export interface ContractIssue {
  level: 'warn' | 'error'
  message: string
}

export function validateBundle(b: Bundle): ContractIssue[] {
  const issues: ContractIssue[] = []
  const wellIds = new Set((b.wells ?? []).map((w) => w.well_id))
  const passportIds = new Set((b.passport ?? []).map((p) => p.id))

  if (!b.meta) issues.push({ level: 'error', message: 'meta 缺失' })
  for (const w of b.wells ?? []) {
    for (const pid of w.passport_ids ?? []) {
      if (!passportIds.has(pid)) {
        issues.push({ level: 'warn', message: `${w.well_id} 引用的数字护照 ${pid} 在 passport 中不存在 → 显示“暂无”` })
      }
    }
  }
  for (const p of b.portfolio?.points ?? []) {
    for (const id of p.selected ?? []) {
      if (!wellIds.has(id)) {
        issues.push({ level: 'error', message: `portfolio.point 选中了不存在的井 ${id}` })
      }
    }
  }
  for (const s of b.portfolio?.strategies ?? []) {
    for (const id of s.selected ?? []) {
      if (!wellIds.has(id)) {
        issues.push({ level: 'error', message: `strategy ${s.id} 选中了不存在的井 ${id}` })
      }
    }
  }
  for (const c of b.curves ?? []) {
    if ((c.prediction?.length ?? 0) !== 12) {
      issues.push({ level: 'warn', message: `${c.well_id} 预测点数为 ${c.prediction?.length ?? 0}，契约要求 12` })
    }
  }
  if ((b.portfolio?.strategies ?? []).every((s) => s.id !== 'you')) {
    issues.push({ level: 'warn', message: 'strategies 缺 you 栏 → 由前端按“求和 + 查表”生成' })
  }
  const cm = b.combo_metrics
  if (!cm?.available) {
    issues.push({
      level: 'warn',
      message: '缺 combo_metrics → 第三幕“你”栏的组合指标回退 portfolio.points 查表，未命中则“暂无”',
    })
  } else {
    for (const it of cm.items ?? []) {
      for (const id of it.selected ?? []) {
        if (!wellIds.has(id)) {
          issues.push({ level: 'error', message: `combo_metrics 引用了不存在的井 ${id}` })
        }
      }
    }
  }
  return issues
}
