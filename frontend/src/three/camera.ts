/**
 * 相机与投影 · 纯数学，不碰 DOM
 *
 * 单独成文件的原因：P6 要求「相机矩阵与手算一致（lookAt / perspective 各 3 例，
 * 误差 < 1e-6）」。把数学从渲染器里拆出来，才能在 Node 里用独立的公式实现
 * 对拍，而不是拿 three 自己验 three 自己。
 *
 * 坐标约定（冻结，方向不可反）：
 *   X 东 · Y 上 · Z 北（右手系，ENU 的 y→z）
 *   地面 y = 0，井深为负 Y
 */
import * as THREE from 'three'

/** 两级尺度下的机位锚点 */
export interface PoseCtx {
  /** L0 区域场景跨度（米），用于算相机距离 */
  spanM?: number
  /** L1 井场中心 */
  padX?: number
  padZ?: number
  /** 井口坐标 */
  wellX?: number
  wellZ?: number
}

export interface Pose {
  pos: [number, number, number]
  target: [number, number, number]
  fov: number
}

export type CameraPreset = 'C0' | 'C1' | 'C2' | 'C3' | 'C4'

/** 井深基准：真实 MD 中位 2400–3650 m，取 3600 m 覆盖 95 分位 */
export const WELL_DEPTH_M = 3600

/**
 * 机位参数。
 *
 * 与 v4 原文的差异（已在 P0_接口冻结表 §3.3 记录并说明理由）：
 *   - C0 的 fov 45 → 60，距离按 101×89 km 真实跨度反算（45° 装不下）
 *   - C2/C3 的 target y 由 −800 改 −1800（真实井深，不是示意值）
 *   - 所有 L1 机位以 pad/well 坐标为原点，两级尺度不能混用
 */
export function presetPose(preset: CameraPreset, ctx: PoseCtx = {}): Pose {
  const span = ctx.spanM ?? 101_000
  const px = ctx.padX ?? 0
  const pz = ctx.padZ ?? 0
  const wx = ctx.wellX ?? px
  const wz = ctx.wellZ ?? pz

  switch (preset) {
    case 'C0': {
      // 距离按「77 口井全部入框」反解，不是按地形四角：
      // 实测井群在 x∈[-38.1, 63.2] km、z∈[-46.6, 42.1] km，相对原点偏东北，
      // 0.64·span 时会漏掉 5 口，0.85 才全部入框 → 取 0.88 留余量。
      // （早先用 1.0·span，地形缩成中间一小块，并看不清井）
      const d = 0.88 * span
      const h = d * Math.SQRT1_2
      return { pos: [0, h, h], target: [0, 0, 0], fov: 60 }
    }
    case 'C1':
      // 井场 87 m、井筒 2400 m，真实比例 1:28。C1 取「站着看井口」的视高：
      // 目标点下压到 −260，让井口与上部井筒入画，井底留白（C2 再切）
      return { pos: [px + 560, 380, pz + 560], target: [px, -260, pz], fov: 45 }
    case 'C2':
      // 井筒 3600 m vs 井场 87 m，真实比例 1:41，单一视锥装不下水平视域，
      // 只能退到 6 km 外保垂向覆盖（P0 风险 R1 已记）
      return {
        pos: [wx + 60, -80, wz + 60],
        target: [wx, -1800, wz],
        fov: 35,
      }
    case 'C3':
      return {
        pos: [wx + 140, -1400, wz + 140],
        target: [wx, -1800, wz],
        fov: 30,
      }
    case 'C4':
    default:
      return { pos: [px, 900, pz + 1600], target: [px, 220, pz], fov: 40 }
  }
}

/** 透视投影矩阵（独立实现，用于与 three 对拍） */
export function projectionMatrix(
  fovDeg: number,
  aspect: number,
  near: number,
  far: number,
): number[] {
  const f = 1 / Math.tan((fovDeg * Math.PI) / 360)
  const nf = 1 / (near - far)
  return [
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, (far + near) * nf, -1,
    0, 0, 2 * far * near * nf, 0,
  ]
}

/** 视图矩阵（独立实现：右手系 lookAt，返回列主序 16 元数组） */
export function viewMatrix(
  pos: [number, number, number],
  target: [number, number, number],
  up: [number, number, number] = [0, 1, 0],
): number[] {
  const sub = (a: number[], b: number[]) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
  const cross = (a: number[], b: number[]) => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ]
  const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
  const norm = (a: number[]) => {
    const l = Math.hypot(a[0], a[1], a[2]) || 1
    return [a[0] / l, a[1] / l, a[2] / l]
  }

  const z = norm(sub(pos, target)) // 相机朝向的反方向（+Z 指向相机后方）
  const x = norm(cross(up, z))
  const y = cross(z, x)

  return [
    x[0], y[0], z[0], 0,
    x[1], y[1], z[1], 0,
    x[2], y[2], z[2], 0,
    -dot(x, pos), -dot(y, pos), -dot(z, pos), 1,
  ]
}

/** 用 three 造相机（渲染用），参数与上面两个函数同源 */
export function makeCamera(pose: Pose, aspect: number, near = 1, far = 200_000): THREE.PerspectiveCamera {
  const cam = new THREE.PerspectiveCamera(pose.fov, aspect, near, far)
  cam.position.set(...pose.pos)
  cam.up.set(0, 1, 0)
  cam.lookAt(new THREE.Vector3(...pose.target))
  cam.updateMatrixWorld(true)
  cam.updateProjectionMatrix()
  return cam
}
