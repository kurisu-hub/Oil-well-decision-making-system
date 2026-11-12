/**
 * pumpjack 四连杆运动学（纯函数，无 three 依赖，可在 Node 里单测）
 *
 * 机构：曲柄 AB → 连杆 BC → 游梁 CD → 驴头 DE → 光杆
 *
 *                              E(驴头弧心, +X 侧)
 *                             /
 *                        a=4.153   D(P, 支架轴承)
 *                             \     │
 *                              \    b=1.845
 *                               \   │
 *                                  C(后臂铰点, −X 侧)
 *                                   \
 *                                    \ L=6.346 (连杆)
 *                                     \
 *                                      B(曲柄销)
 *                                      │ r=0.86
 *                                      A(曲柄轴)
 *
 * 已知曲柄转角 θ，C 点同时在「绕 P 半径 b」和「绕 B 半径 L」两个圆上 → 两圆交点。
 * 两个解对应机构的两种装配（开式 / 交叉），取离上一帧近的，避免渲染时跳变。
 *
 * 坐标：全部用 Blender 的 X-Z 平面（X 横向、Z 高度），米制。
 * three.js 映射：three.x = blender.x，three.y = blender.z，three.z = −blender.y。
 */

export interface FourBarGeom {
  /** 曲柄轴 A（Blender x,z） */
  crankPivot: [number, number]
  /** 支架轴承 D（游梁支点） */
  beamPivot: [number, number]
  /** 曲柄半径 r */
  crankR: number
  /** 连杆长 L（B→C） */
  pitmanL: number
  /** 游梁后臂 b（D→C） */
  backArm: number
  /** 游梁前臂 a（D→E，E 为驴头弧心） */
  frontArm: number
  /** 初始曲柄角（弧度） */
  crankPhase0: number
  /** 初始前臂方向角（D→E，弧度） */
  frontPhase0: number
  /** 初始后臂方向角（D→C，弧度） */
  backPhase0: number
}

export interface FourBarState {
  theta: number
  /** 曲柄销 B */
  pin: [number, number]
  /** 后臂铰点 C */
  backPin: [number, number]
  /** 游梁摆角增量（弧度，相对初始姿态，顺时针为负） */
  beamDelta: number
  /** 驴头弧心 E */
  head: [number, number]
  /** 光杆相对初始姿态的竖直位移（米，正为上升） */
  rodY: number
  /** 机构是否解算成功（两圆不相交 → false） */
  ok: boolean
}

const TWO_PI = Math.PI * 2

const PIVOT: [number, number] = [-1.20, 7.70]     // D，支架轴承
const CRANK: [number, number] = [-3.30, 1.05]     // A，曲柄轴
const BACK_PIN0: [number, number] = [-3.02, 8.00] // C0，后臂铰点
const HEAD0: [number, number] = [2.95, 7.55]      // E0，驴头弧心
const CRANK_R = 0.824                             // 与 build_pumpjack.py 的 CRANK_R 必须一致
const CRANK_PHASE0 = (130 * Math.PI) / 180        // 静态姿态停在 130°

const dist = (p: [number, number], q: [number, number]) => Math.hypot(q[0] - p[0], q[1] - p[1])
const ang = (p: [number, number], q: [number, number]) => Math.atan2(q[1] - p[1], q[0] - p[0])

/**
 * 由建模参数推导的标准几何。
 * 数值来源：build_pumpjack.py 的 SADDLE / CRANK / BEAM_BACK_X / HH_C 常量。
 * **改建模参数必须同步改这里**，否则运动与几何会脱开（这是最容易埋的坑）。
 */
export const DEFAULT_GEOM: FourBarGeom = (() => {
  const B0: [number, number] = [
    CRANK[0] + CRANK_R * Math.cos(CRANK_PHASE0),
    CRANK[1] + CRANK_R * Math.sin(CRANK_PHASE0),
  ]
  return {
    crankPivot: CRANK,
    beamPivot: PIVOT,
    crankR: CRANK_R,
    pitmanL: dist(B0, BACK_PIN0),
    backArm: dist(PIVOT, BACK_PIN0),
    frontArm: dist(PIVOT, HEAD0),
    crankPhase0: CRANK_PHASE0,
    frontPhase0: ang(PIVOT, HEAD0),
    backPhase0: ang(PIVOT, BACK_PIN0),
  }
})()

/** 两圆交点。返回 0/1/2 个解；无解说明机构尺寸不自洽。 */
function circleIntersect(
  c1: [number, number], r1: number,
  c2: [number, number], r2: number,
): [number, number][] {
  const dx = c2[0] - c1[0]
  const dy = c2[1] - c1[1]
  const d = Math.hypot(dx, dy)
  if (d < 1e-9) return []
  if (d > r1 + r2 + 1e-9 || d < Math.abs(r1 - r2) - 1e-9) return []
  const a = (r1 * r1 - r2 * r2 + d * d) / (2 * d)
  const h2 = r1 * r1 - a * a
  const h = h2 > 0 ? Math.sqrt(h2) : 0
  const mx = c1[0] + (a * dx) / d
  const my = c1[1] + (a * dy) / d
  const rx = (-dy * h) / d
  const ry = (dx * h) / d
  return [
    [mx + rx, my + ry],
    [mx - rx, my - ry],
  ]
}

/**
 * 解算给定曲柄角下的机构姿态。
 * @param theta       曲柄角（弧度，含相位）
 * @param geom        几何
 * @param prevBackPin 上一帧 C 点，用于在两解中挑连续的那个
 */
export function solveFourBar(
  theta: number,
  geom: FourBarGeom = DEFAULT_GEOM,
  prevBackPin?: [number, number],
): FourBarState {
  const [ax, az] = geom.crankPivot
  const pin: [number, number] = [
    ax + geom.crankR * Math.cos(theta),
    az + geom.crankR * Math.sin(theta),
  ]

  const sols = circleIntersect(geom.beamPivot, geom.backArm, pin, geom.pitmanL)
  if (sols.length === 0) {
    return { theta, pin, backPin: prevBackPin ?? [0, 0], beamDelta: 0, head: [0, 0], rodY: 0, ok: false }
  }

  const ref = prevBackPin ?? [
    geom.beamPivot[0] + geom.backArm * Math.cos(geom.backPhase0),
    geom.beamPivot[1] + geom.backArm * Math.sin(geom.backPhase0),
  ]
  let backPin = sols[0]
  let best = Infinity
  for (const s of sols) {
    const dd = Math.hypot(s[0] - ref[0], s[1] - ref[1])
    if (dd < best) {
      best = dd
      backPin = s
    }
  }

  // 游梁是刚体：转角 = 当前后臂角 − 初始后臂角；前臂角 = 初始前臂角 + 同一转角
  // 必须归一化到 (−π, π]：C 点绕到 P 的另一侧时 atan2 会从 +π 跳到 −π，
  // 不做这一步摆角会算出 360°（实测踩过）。
  let beamDelta = ang(geom.beamPivot, backPin) - geom.backPhase0
  while (beamDelta > Math.PI) beamDelta -= TWO_PI
  while (beamDelta < -Math.PI) beamDelta += TWO_PI
  const frontAngle = geom.frontPhase0 + beamDelta
  const head: [number, number] = [
    geom.beamPivot[0] + geom.frontArm * Math.cos(frontAngle),
    geom.beamPivot[1] + geom.frontArm * Math.sin(frontAngle),
  ]

  const head0Z = geom.beamPivot[1] + geom.frontArm * Math.sin(geom.frontPhase0)

  return {
    theta,
    pin,
    backPin,
    beamDelta,
    head,
    rodY: head[1] - head0Z,
    ok: true,
  }
}

export interface StrokeSample {
  theta: number
  rodY: number
  beamDelta: number
}

/** 曲柄转一圈采样，返回极值与行程（验收断言用） */
export function sampleStroke(geom: FourBarGeom = DEFAULT_GEOM, n = 720) {
  let minY = Infinity
  let maxY = -Infinity
  let minBeam = Infinity
  let maxBeam = -Infinity
  let bad = 0
  let maxJump = 0
  const samples: StrokeSample[] = []
  let prevC: [number, number] | undefined
  let prevY = 0

  for (let i = 0; i <= n; i++) {
    const theta = geom.crankPhase0 + (i / n) * TWO_PI
    const st = solveFourBar(theta, geom, prevC)
    if (!st.ok) {
      bad += 1
      continue
    }
    if (prevC) {
      const jump = Math.hypot(st.backPin[0] - prevC[0], st.backPin[1] - prevC[1])
      // 相邻采样点间的 C 点位移上限：曲柄走 0.5° 时连杆端点不该跳超过 3 cm
      if (jump > maxJump) maxJump = jump
    }
    minY = Math.min(minY, st.rodY)
    maxY = Math.max(maxY, st.rodY)
    minBeam = Math.min(minBeam, st.beamDelta)
    maxBeam = Math.max(maxBeam, st.beamDelta)
    samples.push({ theta, rodY: st.rodY, beamDelta: st.beamDelta })
    prevC = st.backPin
    prevY = st.rodY
  }

  const stroke = maxY - minY
  const iTop = samples.reduce((b, s, i) => (s.rodY > samples[b].rodY ? i : b), 0)
  const iBot = samples.reduce((b, s, i) => (s.rodY < samples[b].rodY ? i : b), 0)

  return {
    minY,
    maxY,
    stroke,
    beamSwingDeg: ((maxBeam - minBeam) * 180) / Math.PI,
    topThetaDeg: ((samples[iTop].theta * 180) / Math.PI) % 360,
    botThetaDeg: ((samples[iBot].theta * 180) / Math.PI) % 360,
    failCount: bad,
    maxPinJump: maxJump,
    samples,
  }
}

/** 光杆位置 → 归一化相位（0 下死点，1 上死点） */
export function strokePhase(rodY: number, minY: number, stroke: number): number {
  if (stroke < 1e-9) return 0
  return (rodY - minY) / stroke
}

/** 冲次（1/min）→ 曲柄角速度（rad/s） */
export function strokesToOmega(strokePerMin: number): number {
  return (strokePerMin / 60) * TWO_PI
}
