/**
 * tankLevel.ts · 储罐液位跟随数据（不依赖 three，可在 Node 里单测）
 *
 * glb 里的液位柱是 `tk_liquid`，几何从 z=0.035（底板顶）到 z=7.60（满液）。
 * 直接 `scale.y = pct` 会让液面底部跟着浮起来（几何不是从原点起的），
 * 所以要同时反补 position.y，保证**底边钉在罐底**、只有顶面随数据升降。
 *
 * D-054（R-013 裁 B）：罐侧壁外挂磁翻板液位计，独立节点 `tk_gauge_liquid`
 * （几何 z=0.42→7.50），与罐内液柱同一 pct 驱动、各自按自己的 base 反补。
 */

/** 与 build_tank.py 对应：底板厚 0.030，液体从 0.035 起，满液 7.60 */
export const TANK_LIQ = { base: 0.035, top: 7.60, capacityM3: 500 }

/** 与 build_tank.py 的 GA_Z0/GA_Z1 对应：立管液柱 z=0.42→7.50 */
export const TANK_GAUGE_LIQ = { base: 0.42, top: 7.5 }

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v)

/** 最小结构约束：只要有 scale.y / position.y 就能用（避免为了类型拉整个 three 进来） */
export interface ScalableNode {
  scale: { y: number }
  position: { y: number }
  updateMatrix?: () => void
}

/**
 * 通用底边钉死缩放：几何从 base 起到 top，pct 缩放后底边仍在 base。
 */
function scalePinned(node: ScalableNode, pct: number, base: number) {
  const p = clamp(pct, 0.001, 1)
  node.scale.y = p
  // 底部固定：几何底部 y=base，缩放后变成 base*p，需要补 base*(1−p)
  node.position.y = base * (1 - p)
  node.updateMatrix?.()
}

/**
 * @param node  tk_liquid 节点
 * @param pct   液位 0–1
 */
export function setTankLevel(node: ScalableNode, pct: number) {
  scalePinned(node, pct, TANK_LIQ.base)
}

/**
 * D-054：立管液柱（tk_gauge_liquid），与罐内液位同一 pct。
 * 依赖反转时调用方传 null 安全跳过（旧版 glb 没有该节点）。
 */
export function setGaugeLevel(node: ScalableNode | null | undefined, pct: number) {
  if (!node) return
  scalePinned(node, pct, TANK_GAUGE_LIQ.base)
}

/**
 * 由站点日产油推液位（演示口径，不是计量口径）。
 * 说明：这是**可读性映射**，不是真实液位计算 —— 罐容 500 m³，真实液位由进出平衡决定，
 * 需要 DCS 数据；这里只做「数据变 → 液位动」的可视证明。
 *
 * @param siteOilM3d 全站日产油 m³/d
 * @param scaleDays  罐内周转天数。默认 7 天：bundle 实际全站 44.06 m³/d → 液位 61.7%，
 *                   视觉上才看得出变化。取 2.5 天时只有 22%（液面 1.7 m，9 m 罐里几乎看不见）。
 */
export function levelFromSiteOil(siteOilM3d: number, scaleDays = 7): number {
  const m3 = Math.max(0, siteOilM3d) * scaleDays
  return clamp(m3 / TANK_LIQ.capacityM3, 0.05, 0.98)
}

/** 液位 % → 体积 m³ */
export function levelToVolume(pct: number): number {
  return Math.round(TANK_LIQ.capacityM3 * clamp(pct, 0, 1) * 10) / 10
}

/** 液位 % → 液面高度（米，从罐底起） */
export function levelToHeight(pct: number): number {
  return (TANK_LIQ.top - TANK_LIQ.base) * clamp(pct, 0, 1) + TANK_LIQ.base
}
