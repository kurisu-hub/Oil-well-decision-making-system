/**
 * pumpjackRig.ts · 把四连杆解算结果应用到 glb 节点
 *
 * glb 里 6 个可动节点的原点都在世界原点（bpy 导出的合并网格，没有局部轴心），
 * 所以不能直接 `obj.rotation.z = x`，必须「绕指定铰点旋转」再与初始矩阵相乘：
 *
 *     M = T(pivot) · R(Δ) · T(−pivot) · M₀
 *
 * 连杆（pitman）两端都是铰接，不能只旋转，要做**线段对齐**：
 * 把初始线段 B₀C₀ 刚体变换到当前线段 BC（长度恒定，所以只有旋转 + 平移）。
 *
 * 坐标：kinematics 用 Blender 的 (x, z)；three 里对应 (x, y, 0)。
 * Blender 的 Y-up 导出把 (x, y, z) 映射为 (x, z, −y)，故 Blender 的 XZ 平面 → three 的 XY 平面。
 */
import * as THREE from 'three'
import {
  type FourBarGeom,
  DEFAULT_GEOM,
  solveFourBar,
  strokesToOmega,
  strokePhase,
} from './kinematics'

const V = (xz: readonly [number, number]) => new THREE.Vector3(xz[0], xz[1], 0)

/** 绕 XY 平面内某点旋转的矩阵 */
function rotateAbout(angle: number, px: number, py: number): THREE.Matrix4 {
  const m = new THREE.Matrix4().makeRotationZ(angle)
  const t1 = new THREE.Matrix4().makeTranslation(px, py, 0)
  const t2 = new THREE.Matrix4().makeTranslation(-px, -py, 0)
  return t1.multiply(m).multiply(t2)
}

export interface RigNodes {
  beam: THREE.Object3D
  cranks: THREE.Object3D[]
  pitmans: THREE.Object3D[]
  staticNode: THREE.Object3D | null
  root: THREE.Object3D
}

export interface RigState {
  /** 曲柄角（弧度） */
  theta: number
  /** 冲次 1/min */
  strokeRate: number
  /** 游梁摆角增量（度） */
  beamDeg: number
  /** 光杆竖直位移（米，正为上升） */
  rodY: number
  /** 归一化相位 0=下死点 1=上死点 */
  phase: number
}

/**
 * 从 glb 场景里拣出运动节点。
 * 命名约定来自 build_pumpjack.py 的 join_by_group：pq_static / pq_beam / pq_crank_l …
 */
export function findRigNodes(root: THREE.Object3D): RigNodes {
  const byName = new Map<string, THREE.Object3D>()
  root.traverse((o) => {
    if (o.name) byName.set(o.name, o)
  })
  const pick = (...names: string[]) => names.map((n) => byName.get(n)).filter(Boolean) as THREE.Object3D[]

  const beam = pick('pq_beam')[0]
  const cranks = pick('pq_crank_l', 'pq_crank_r')
  const pitmans = pick('pq_pitman_l', 'pq_pitman_r')
  if (!beam) throw new Error('pumpjackRig: 找不到 pq_beam 节点')

  return {
    beam,
    cranks,
    pitmans,
    staticNode: pick('pq_static')[0] ?? null,
    root,
  }
}

export class PumpjackRig {
  readonly nodes: RigNodes
  readonly geom: FourBarGeom

  private base = new Map<THREE.Object3D, THREE.Matrix4>()
  private theta: number
  private rate = 7.2
  private autoRotate = false
  private minY = 0
  private stroke = 0
  private prevBackPin: [number, number] | undefined

  constructor(nodes: RigNodes, geom: FourBarGeom = DEFAULT_GEOM) {
    this.nodes = nodes
    this.geom = geom
    this.theta = geom.crankPhase0

    // 冻结初始矩阵：所有后续变换都以它为基准，避免累积漂移
    for (const o of [nodes.beam, ...nodes.cranks, ...nodes.pitmans]) {
      o.updateMatrix()
      this.base.set(o, o.matrix.clone())
      o.matrixAutoUpdate = false
    }

    const r = this.sampleExtremes()
    this.minY = r.minY
    this.stroke = r.stroke
    this.apply(this.theta)
  }

  private sampleExtremes() {
    let minY = Infinity
    let maxY = -Infinity
    let prev: [number, number] | undefined
    const N = 360
    for (let i = 0; i <= N; i++) {
      const st = solveFourBar(this.geom.crankPhase0 + (i / N) * Math.PI * 2, this.geom, prev)
      if (!st.ok) continue
      minY = Math.min(minY, st.rodY)
      maxY = Math.max(maxY, st.rodY)
      prev = st.backPin
    }
    return { minY, maxY, stroke: maxY - minY }
  }

  /** 冲次（1/min），范围 1–12 */
  setStrokeRate(v: number) {
    this.rate = THREE.MathUtils.clamp(v, 1, 12)
  }

  getStrokeRate() {
    return this.rate
  }

  /** 开/关自动回转 */
  setRunning(on: boolean) {
    this.autoRotate = on
  }

  isRunning() {
    return this.autoRotate
  }

  /** 直接把曲柄放到某个角度（用于拖动播放头 / 单帧调试） */
  setCrankAngle(theta: number) {
    this.apply(theta)
  }

  /** 推进 dt 秒 */
  update(dt: number) {
    if (!this.autoRotate) return
    this.apply(this.theta + strokesToOmega(this.rate) * dt)
  }

  /** 内部：解算并写矩阵 */
  private apply(theta: number) {
    const st = solveFourBar(theta, this.geom, this.prevBackPin)
    if (!st.ok) return
    this.prevBackPin = st.backPin
    this.theta = theta

    const P = this.geom.beamPivot
    const A = this.geom.crankPivot

    // 游梁：绕支架轴承转 beamDelta
    const beamM = rotateAbout(st.beamDelta, P[0], P[1])
    const beam0 = this.base.get(this.nodes.beam)!
    this.nodes.beam.matrix.copy(beamM).multiply(beam0)
    this.nodes.beam.matrixWorldNeedsUpdate = true

    // 曲柄：绕曲柄轴转 (θ − θ₀)
    const crankM = rotateAbout(theta - this.geom.crankPhase0, A[0], A[1])
    for (const c of this.nodes.cranks) {
      const m0 = this.base.get(c)!
      c.matrix.copy(crankM).multiply(m0)
      c.matrixWorldNeedsUpdate = true
    }

    // 连杆：线段 B₀C₀ → BC 的刚体对齐
    const B0: [number, number] = [
      A[0] + this.geom.crankR * Math.cos(this.geom.crankPhase0),
      A[1] + this.geom.crankR * Math.sin(this.geom.crankPhase0),
    ]
    const C0: [number, number] = [
      P[0] + this.geom.backArm * Math.cos(this.geom.backPhase0),
      P[1] + this.geom.backArm * Math.sin(this.geom.backPhase0),
    ]
    const d0 = V(C0).sub(V(B0)).normalize()
    const d1 = V(st.backPin).sub(V(st.pin)).normalize()
    const q = new THREE.Quaternion().setFromUnitVectors(d0, d1)
    const align = new THREE.Matrix4()
      .makeTranslation(st.pin[0], st.pin[1], 0)
      .multiply(new THREE.Matrix4().makeRotationFromQuaternion(q))
      .multiply(new THREE.Matrix4().makeTranslation(-B0[0], -B0[1], 0))
    for (const p of this.nodes.pitmans) {
      const m0 = this.base.get(p)!
      p.matrix.copy(align).multiply(m0)
      p.matrixWorldNeedsUpdate = true
    }
  }

  /** 当前状态快照（给 UI / 读数用） */
  getState(): RigState {
    const st = solveFourBar(this.theta, this.geom, this.prevBackPin)
    return {
      theta: this.theta,
      strokeRate: this.rate,
      beamDeg: THREE.MathUtils.radToDeg(st.beamDelta),
      rodY: st.rodY,
      phase: strokePhase(st.rodY, this.minY, this.stroke),
    }
  }

  /** 满冲程（米），由几何解算得出，不是常量 */
  getStrokeLength() {
    return this.stroke
  }
}
