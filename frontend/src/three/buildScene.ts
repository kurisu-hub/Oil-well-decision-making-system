/**
 * bundle → SceneJSON
 *
 * 职责单一：只做投影，不做判断。任何"没有依据"的几何都在这里被标 basis 或直接丢弃，
 * 渲染层不再二次加工（E3：每个几何体带 basis；无依据者不渲染）。
 *
 * 两级尺度：
 *   L0 区域 —— 全 77 井，跨度约 101 × 89 km
 *   L1 井场 —— 单 pad，跨度按 pad_stats 自适应（真实 87 m 起）
 */
import type { SceneJSON, WellGeo, PadGeo } from './engine'

type AnyRec = Record<string, any>

const DAYS = 30.4

export interface BuildOpts {
  level: 'L0' | 'L1'
  padId?: string
  /** 假设：裂缝半长上限（米）。来源见 assumptions/registry */
  fracHalfMaxM?: number
}

/** 反距离权重插值出粗网格产量面（只用于"形状"，标注为示意场） */
function makeSurface(wells: WellGeo[], rows: number, cols: number) {
  const xs = wells.map((w) => w.x)
  const zs = wells.map((w) => w.z)
  const x0 = Math.min(...xs); const x1 = Math.max(...xs)
  const z0 = Math.min(...zs); const z1 = Math.max(...zs)
  const dx = Math.max(x1 - x0, 1)
  const dz = Math.max(z1 - z0, 1)
  const grid: number[] = []
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const px = x0 + (dx * c) / (cols - 1)
      const pz = z0 + (dz * r) / (rows - 1)
      let num = 0
      let den = 0
      for (const w of wells) {
        const d2 = (w.x - px) ** 2 + (w.z - pz) ** 2 + 1
        const wt = 1 / d2
        num += wt * (w as AnyRec).__scalar
        den += wt
      }
      grid.push(den > 0 ? num / den : 0)
    }
  }
  // 归一化到 0–1
  const mx = Math.max(...grid, 1e-9)
  return { rows, cols, grid: grid.map((v) => v / mx) }
}

export function buildScene(bundle: AnyRec, opts: BuildOpts): SceneJSON {
  const geo = bundle.geo ?? {}
  const curves = new Map<string, AnyRec>()
  for (const c of bundle.curves ?? []) curves.set(c.well_id, c)

  const padOf = new Map<string, string>()
  for (const p of geo.pads ?? []) for (const id of p.well_ids ?? []) padOf.set(id, p.pad_id)

  const level = opts.level
  const pad = level === 'L1' ? (geo.pads ?? []).find((p: AnyRec) => p.pad_id === opts.padId) : null
  const keep = (wid: string) => (level === 'L1' ? pad?.well_ids?.includes(wid) : true)

  // ---- 井 ----
  const wells: WellGeo[] = []
  for (const w of bundle.wells ?? []) {
    if (!keep(w.well_id)) continue
    const g = (geo.wells ?? []).find((x: AnyRec) => x.well_id === w.well_id)
    if (!g || g.x == null) continue // 无坐标 → 不渲染（不编位置）
    const c = curves.get(w.well_id)
    if (!c) continue
    const pred = (c.prediction ?? []).map((p: AnyRec) => p.oil ?? 0)
    const base = (c.baseline ?? []).map((p: AnyRec) => p.oil ?? 0)
    // D-053/H-015：实测 = actual（事件后 12 月），缺失显式 warn，不静默画空线
    if (!c.actual) console.warn(`[H-015] ${w.well_id} 曲线缺 actual（契约破坏）`)
    const actual = (c.actual ?? []).map((p: AnyRec) => p.oil ?? 0)
    const mdFt = g.max_md_ft ?? 10000
    wells.push({
      id: w.well_id,
      x: g.x,
      z: -g.y, // ENU 的 y（北）→ three 的 Z 北
      anchor: w.anchor ?? 0,
      md: mdFt * 0.3048,
      state: (w.state ?? 'gray') as WellGeo['state'],
      pred,
      base,
      actual,
      npv: w.value_npv ?? 0,
      padId: padOf.get(w.well_id) ?? '',
    })
  }

  // ---- 产量面的标量：12 月预测增油 ----
  for (const w of wells) {
    const inc = w.pred.reduce((a, b) => a + b, 0) - w.base.reduce((a, b) => a + b, 0)
    ;(w as AnyRec).__scalar = Math.max(inc, 0)
  }

  // ---- pad ----
  const padIds = new Set(wells.map((w) => w.padId).filter(Boolean))
  const pads: PadGeo[] = (geo.pads ?? [])
    .filter((p: AnyRec) => padIds.has(p.pad_id))
    .map((p: AnyRec) => ({
      id: p.pad_id,
      cx: p.centroid_x ?? 0,
      cz: -(p.centroid_y ?? 0),
      wellIds: p.well_ids ?? [],
      span: p.span_m ?? 0,
      pred: (p.well_ids ?? [])
        .map((id: string) => wells.find((w) => w.id === id))
        .filter(Boolean)
        .reduce((a: number, w: WellGeo) => a + w.pred.reduce((x, y) => x + y, 0), 0),
    }))

  // ---- 管线：L0 连 pad 质心（按 x 排序成链）；L1 连井到 pad 质心 ----
  const pipes: { from: string; to: string }[] = []
  if (level === 'L0') {
    const sorted = [...pads].sort((a, b) => a.cx - b.cx)
    for (let i = 0; i + 1 < sorted.length; i++) {
      pipes.push({ from: sorted[i].id, to: sorted[i + 1].id })
    }
  } else if (pad) {
    for (const id of pad.well_ids ?? []) {
      if (wells.some((w) => w.id === id)) pipes.push({ from: id, to: pad.pad_id })
    }
  }

  // ---- extent ----
  let extent: { x: [number, number]; z: [number, number] }
  if (level === 'L0') {
    const span = geo.levels?.L0?.span_m ?? 101000
    extent = { x: [-span / 2, span / 2], z: [-span * 0.44, span * 0.44] }
  } else {
    const size = Math.max(pad?.span_m ?? 0, 300) * 2.2
    const half = Math.min(Math.max(size / 2, 260), 600)
    const cx = pad?.centroid_x ?? 0
    const cz = -(pad?.centroid_y ?? 0) // ENU 北 → three Z
    extent = { x: [cx - half, cx + half], z: [cz - half, cz + half] }
  }

  const rows = level === 'L0' ? 24 : 18
  const cols = level === 'L0' ? 24 : 18

  return {
    version: '1.0',
    tier: 'B',
    level,
    extent,
    wells,
    pads,
    pipes,
    surface: makeSurface(wells, rows, cols),
    basis: {
      fracHalfMaxM: opts.fracHalfMaxM ?? 120,
      fracBasis: '裂缝半长按泵注程序插值（0 → 120 m），非实测缝长；数值取自 assumptions 的 frac_half_m',
      wellheadBasis:
        '井口柱高按 anchor 归一化放大（真实 0.1–42 m³/d 按米画等于零高度，属可读性妥协）；'
        + '柱形按状态区分棱数（6/4/3/8），灰度下仍可辨',
      terrainBasis:
        '高程为确定性伪噪声（振幅 320 m × 垂向放大），无实测 DEM；等高线由高度场 marching squares 生成',
      verticalExaggeration: level === 'L0' ? 6 : 1,
    },
  }
}

/** 取 L0 与 L1 的两级定义，供 UI 显示 */
export function levelInfo(bundle: AnyRec) {
  const g = bundle.geo ?? {}
  return {
    L0: g.levels?.L0 ?? null,
    L1: g.levels?.L1 ?? null,
    coverage: g.coverage ?? 0,
    fallback: g.fallback ?? true,
    nPads: (g.pads ?? []).length,
  }
}

export { DAYS }
