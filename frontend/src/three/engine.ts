/**
 * Scene3D 引擎 · three.js 0.170
 *
 * 冻结的 8 个方法（P0_接口冻结表 §3.1）：
 *   init / setScene / setCamera / setTime / highlight / pick / resize / dispose
 *
 * **两级尺度**（2026-11-03 决策）：真实井位跨 101 × 89 km，v3 架构按 4 km 设计差 25 倍。
 *   L0 区域：见全局分布（pad 标记 + 井口柱 + 干线）
 *   L1 井场：见井筒/裂缝/产量面（真实井距 4.7–6 m）
 * `setLevel()` 是坐标换算的**唯一入口**，外部只传 padId / wellIds，不许自己减原点。
 *
 * 禁止：后处理、物理引擎、外部模型文件、贴图文件（纹理全部程序生成）。
 */
import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { buildLighting, type LightingRig } from './lighting'
import {
  type CameraPreset, type Pose, type PoseCtx, makeCamera, presetPose,
} from './camera'
export type { CameraPreset, Pose }

export type Tier = 'A' | 'B'
export type Level = 'L0' | 'L1'

export interface WellGeo {
  id: string
  x: number
  z: number
  /** 锚点日产油 m³/d，用于井口柱高 */
  anchor: number
  /** 井深 m（正数，渲染时取负 Y） */
  md: number
  state: 'green' | 'yellow' | 'red' | 'gray'
  /** 12 个月预测产量，按 t 切片 */
  pred: number[]
  /** 12 个月基线产量 */
  base: number[]
  /** 实测 12 个月 */
  actual: number[]
  /** 期望 NPV（万元），用于井口环的大小与符号 */
  npv: number
  padId: string
}

export interface PadGeo {
  id: string
  cx: number
  cz: number
  wellIds: string[]
  /** pad 跨度 m */
  span: number
  /** pad 内井的 12 月预测产量合计，用于管线宽度分档 */
  pred: number
}

export interface SceneJSON {
  version: '1.0'
  tier: Tier
  level: Level
  /** 当前层级的坐标半跨度（米） */
  extent: { x: [number, number]; z: [number, number] }
  wells: WellGeo[]
  pads: PadGeo[]
  /** 每条管线：起点/终点 padId（L1 内为井 id） */
  pipes: { from: string; to: string }[]
  /** 产量面：行 × 列 的基线/预测网格（已归一化到 0–1） */
  surface: { rows: number; cols: number; grid: number[] }
  /** 工程假设（缝长等），每个几何体必须能追溯 */
  basis: {
    fracHalfMaxM: number
    fracBasis: string
    wellheadBasis: string
    terrainBasis: string
    verticalExaggeration: number
  }
}

export interface PickResult {
  wellId: string | null
  point: [number, number, number]
}

export interface PerfStat {
  fps: number
  triangles: number
  drawCalls: number
  tier: Tier
  level: Level
}

type EventMap = {
  ready: { tier: Tier; ms: number; triangles: number }
  pick: PickResult
  perf: PerfStat
  degraded: string
}

const COLOR: Record<WellGeo['state'], number> = {
  green: 0x4f8a5b,
  yellow: 0xb99340,
  red: 0xa8453c,
  gray: 0x59636a,
}

/** 状态形状冗余（D8：灰度下仍可辨，靠外形不靠颜色） */
const SEG_BY_STATE: Record<WellGeo['state'], number> = {
  green: 6, // 六棱柱
  yellow: 4, // 四棱柱
  red: 3, // 三棱柱
  gray: 8, // 八棱柱
}

function detectTier(gl: WebGLRenderingContext | WebGL2RenderingContext): Tier {
  try {
    const dbg = gl.getExtension('WEBGL_debug_renderer_info')
    const r = dbg
      ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) || '')
      : ''
    if (/NVIDIA|RTX|Radeon RX|Apple M|GeForce/i.test(r)) return 'A'
  } catch {
    /* 拿不到就降级 */
  }
  return 'B'
}

/** 程序化高度场：确定性伪噪声，不用 Math.random（保证 setTime 前后位同） */
function terraneH(x: number, z: number, amp: number): number {
  const a = Math.sin(x * 0.000031) * Math.cos(z * 0.000027)
  const b = Math.sin((x + z) * 0.000017) * 0.6
  const c = Math.cos(x * 0.000011 - z * 0.000019) * 0.35
  return (a + b + c) * amp
}

export class Scene3DEngine {
  private renderer: THREE.WebGLRenderer | null = null
  private scene: THREE.Scene | null = null
  private camera: THREE.PerspectiveCamera | null = null
  private root: THREE.Group | null = null
  private raf = 0
  private controls: OrbitControls | null = null
  private disposed = false
  private sceneJSON: SceneJSON | null = null
  private tier: Tier = 'B'
  private level: Level = 'L0'
  private ctx: PoseCtx = {}
  private t = 0
  private frames = 0
  private fpsT0 = 0
  private fps = 0
  private listeners: { [K in keyof EventMap]?: ((p: EventMap[K]) => void)[] } = {}
  private highlightSet = new Set<string>()
  /** 可交互对象 → wellId */
  private pickables: THREE.Object3D[] = []
  private fracInst: THREE.InstancedMesh | null = null
  private fracScale = 0.01
  private surfaceMesh: THREE.Mesh | null = null
  private surfaceBase: Float32Array | null = null
  private wellHeadMesh: THREE.InstancedMesh | null = null
  /** wellId → 井口柱顶 y，用于挂环 */
  private wellTop = new Map<string, number>()
  private ringGroup: THREE.Group | null = null
  private selGroup: THREE.Group | null = null
  /**
   * 逐帧回调（扩展点：P0_接口冻结表之外的加法扩展，冻结 8 方法签名不变）。
   * 供资产运行层（assetRuntime）驱动四连杆/液位等持续动画；回调拿 dt 秒。
   */
  private frameCbs = new Set<(dtSec: number) => void>()
  private lightRig: LightingRig | null = null
  private lastFrameT = 0

  /* ------------------------------------------------------------ 生命周期 */

  init(canvas: HTMLCanvasElement): { tier: Tier; ms: number } {
    const t0 = performance.now()
    const gl2 = canvas.getContext('webgl2', { antialias: true, alpha: false })
    const gl = gl2 || (canvas.getContext('webgl') as WebGLRenderingContext | null)
    if (!gl) {
      this.emit('degraded', 'WebGL 不可用，已降级为 2.5D')
      throw new Error('WebGL unavailable')
    }

    this.tier = detectTier(gl)
    const renderer = new THREE.WebGLRenderer({
      canvas,
      context: gl as WebGLRenderingContext,
      antialias: this.tier === 'A',
      powerPreference: 'high-performance',
    })
    renderer.setPixelRatio(Math.min(devicePixelRatio || 1, this.tier === 'A' ? 2 : 1.25))
    renderer.shadowMap.enabled = this.tier === 'A'
    renderer.shadowMap.type = THREE.PCFSoftShadowMap
    this.renderer = renderer

    const scene = new THREE.Scene()
    this.scene = scene

    // D-061①：T07 光照（buildLighting，Tier B 档 = 日轨 + 天空背景 + 雾 + 环境光，
    // 不创建 composer / postfx 不接 —— Tier A 全开 4.8 fps 本就不能演示，见 D-047 档位拆判）。
    // 雾覆盖成 km 级：默认配置 near 90/far 900 是 120 m 探针场景调的，
    // 101 km 井场直接用会把全场雾死（ctx.spanM = 101000）
    this.lightRig = buildLighting(scene, this.tier, {
      fog: {
        enabled: true,
        color: [0.46, 0.54, 0.64],
        near: 4000,
        far: 48000,
      },
    })

    this.root = new THREE.Group()
    scene.add(this.root)

    this.ctx = { spanM: 101000 }
    this.camera = makeCamera(presetPose('C0', this.ctx), 16 / 9, 1, 500000)

    // 观察动词：轨道控制。限制极角不穿地（pole 上方 12° 起），
    // 阻尼系数 0.08 让拖拽有惯性但不飘。
    const controls = new OrbitControls(this.camera, canvas)
    controls.enableDamping = true
    controls.dampingFactor = 0.08
    controls.maxPolarAngle = Math.PI / 2 - 0.21
    controls.minPolarAngle = 0.12
    controls.screenSpacePanning = false
    controls.zoomSpeed = 0.9
    this.controls = controls

    this.resize()
    this.startLoop()

    // 诊断钩子：e2e 与人工排查用（只读引用，不参与业务逻辑）
    ;(window as unknown as Record<string, unknown>).__SCENE3D__ = this

    const ms = performance.now() - t0
    queueMicrotask(() => this.emit('ready', { tier: this.tier, ms, triangles: this.triangles() }))
    return { tier: this.tier, ms }
  }

  dispose(): void {
    this.disposed = true
    cancelAnimationFrame(this.raf)
    this.raf = 0
    this.frameCbs.clear()
    this.lightRig?.dispose()
    this.lightRig = null
    this.controls?.dispose()
    this.controls = null
    const r = this.renderer
    if (this.root) {
      this.root.traverse((o) => {
        const any = o as unknown as {
          geometry?: THREE.BufferGeometry
          material?: THREE.Material | THREE.Material[]
        }
        any.geometry?.dispose()
        if (Array.isArray(any.material)) any.material.forEach((m) => m.dispose())
        else any.material?.dispose()
      })
      this.root.clear()
    }
    this.pickables = []
    this.fracInst = null
    this.surfaceMesh = null
    this.surfaceBase = null
    this.wellHeadMesh = null
    if (r) {
      r.dispose()
      // 释放上下文，否则重复 init/dispose 会累积 WebGL context（浏览器上限约 16 个）
      r.forceContextLoss?.()
      r.domElement.width = r.domElement.width
    }
    this.renderer = null
    this.scene = null
    this.camera = null
    this.root = null
    delete (window as unknown as Record<string, unknown>).__PERF__
  }

  /* ---------------------------------------------------------------- 场景 */

  setScene(json: SceneJSON): void {
    if (!this.root || !this.scene) return
    this.clearRoot()
    this.sceneJSON = json
    this.level = json.level
    const ext = json.extent
    this.ctx.spanM = Math.max(ext.x[1] - ext.x[0], ext.z[1] - ext.z[0])

    this.buildTerrain(json)
    this.buildWells(json)
    this.buildPipes(json)
    this.buildSurface(json)
    this.setTime(this.t)
  }

  /** 两级尺度：唯一入口。外部只传 padId / wellIds */
  setLevel(level: Level, opts: { padId?: string; wellIds?: string[] } = {}): void {
    if (!this.sceneJSON) return
    this.level = level
    if (level === 'L1' && opts.padId) {
      const pad = this.sceneJSON.pads.find((p) => p.id === opts.padId)
      if (pad) {
        this.ctx.padX = pad.cx
        this.ctx.padZ = pad.cz
        const first = this.sceneJSON.wells.find((w) => pad.wellIds.includes(w.id))
        if (first) {
          this.ctx.wellX = first.x
          this.ctx.wellZ = first.z
        }
        const wids = opts.wellIds
        if (wids?.length) {
          this.ctx.wellX = this.sceneJSON.wells.find((w) => w.id === wids[0])?.x ?? this.ctx.wellX
        }
      }
    } else {
      this.ctx.padX = 0
      this.ctx.padZ = 0
      this.ctx.wellX = 0
      this.ctx.wellZ = 0
    }
  }

  setCamera(preset: CameraPreset | Pose, opts: { durationMs?: number } = {}): void {
    if (!this.camera) return
    const pose: Pose = typeof preset === 'string' ? presetPose(preset, this.ctx) : preset
    const target = makeCamera(pose, this.camera.aspect, this.camera.near, this.camera.far)
    const dur = opts.durationMs ?? 0
    if (dur <= 0) {
      this.camera.position.copy(target.position)
      this.camera.quaternion.copy(target.quaternion)
      this.camera.fov = target.fov
      this.camera.updateProjectionMatrix()
      this.controls?.target.set(...pose.target)
      this.controls?.update()
      return
    }
    // 平滑过渡：用缓动插值位置与四元数，不引入 Tween 依赖
    const p0 = this.camera.position.clone()
    const q0 = this.camera.quaternion.clone()
    const f0 = this.camera.fov
    const t0 = performance.now()
    const tick = () => {
      if (this.disposed || !this.camera) return
      const k = Math.min(1, (performance.now() - t0) / dur)
      const e = k < 0.5 ? 2 * k * k : 1 - 2 * (1 - k) * (1 - k)
      this.camera.position.lerpVectors(p0, target.position, e)
      this.camera.quaternion.slerpQuaternions(q0, target.quaternion, e)
      this.camera.fov = f0 + (target.fov - f0) * e
      this.camera.updateProjectionMatrix()
      // 轨道中心跟随机位，否则拖拽会绕旧目标转
      const tg = new THREE.Vector3(...pose.target)
      this.controls?.target.lerp(tg, e)
      if (k < 1) requestAnimationFrame(tick)
    }
    tick()
  }

  /**
   * 推演：t ∈ [0, 12]，纯函数式驱动。
   * 三个返回值（缝长 / 曲面抬升 / NPV）必须同源，E4 的断言就查这个。
   */
  setTime(t: number): { fracScale: number; surfaceLift: number; npv: number } {
    const tt = Math.max(0, Math.min(12, t))
    this.t = tt
    const k = tt / 12
    // 泵注程序近似：初期快速起缝，后期趋缓（easeOut）
    const fracScale = 1 - Math.pow(1 - k, 2.2)

    if (this.fracInst) {
      const sx = Math.max(fracScale, 0.01)
      const m4 = new THREE.Matrix4()
      for (let i = 0; i < this.fracInst.count; i++) {
        this.fracInst.getMatrixAt(i, m4)
        m4.elements[0] = sx
        m4.elements[1] = 0
        m4.elements[2] = 0
        this.fracInst.setMatrixAt(i, m4)
      }
      this.fracInst.instanceMatrix.needsUpdate = true
      ;(this.fracInst.material as THREE.MeshBasicMaterial).opacity = 0.12 + 0.32 * fracScale
    }

    let surfaceLift = 0
    if (this.surfaceMesh && this.surfaceBase) {
      const pos = this.surfaceMesh.geometry.attributes.position as THREE.BufferAttribute
      const idx = Math.min(11, Math.max(0, Math.round(tt) - 1))
      const arr = pos.array as Float32Array
      let mx = 0
      for (let i = 0; i < arr.length / 3; i++) {
        const base = this.surfaceBase[i]
        const lift = base * (0.35 + 0.65 * (idx / 11))
        arr[i * 3 + 1] = lift
        mx = Math.max(mx, lift)
      }
      pos.needsUpdate = true
      this.surfaceMesh.geometry.computeVertexNormals()
      surfaceLift = mx
    }

    // NPV 累计：Σ_{m≤t}(pred−base)×30.4×价 − 成本，与曲面同 t
    let npv = 0
    if (this.sceneJSON) {
      for (const w of this.sceneJSON.wells) {
        for (let m = 0; m < Math.min(12, Math.floor(tt)); m++) {
          npv += ((w.pred[m] ?? 0) - (w.base[m] ?? 0)) * 30.4 * 0.323
        }
        if (tt > 0) npv -= 45
      }
    }
    return { fracScale, surfaceLift, npv }
  }

  highlight(ids: string[]): void {
    this.highlightSet = new Set(ids)
    const mesh = this.wellHeadMesh
    if (!mesh) return
    const c = new THREE.Color()
    for (let i = 0; i < mesh.count; i++) {
      const id = (mesh.userData.ids as string[])[i]
      const on = this.highlightSet.size === 0 || this.highlightSet.has(id)
      c.setHex((mesh.userData.colors as number[])[i])
      if (this.highlightSet.has(id)) c.offsetHSL(0, 0, 0.22)
      mesh.setColorAt(i, on ? c : c.clone().multiplyScalar(0.22))
    }
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
  }

  /**
   * 下注选择环（扩展方法，不破坏冻结的 8 个签名）。
   * 选中的井挂一个青色高环，最多 3 口（对应 budget 约束）。
   */
  setSelection(ids: string[]): void {
    if (!this.root) return
    if (this.selGroup) {
      this.root.remove(this.selGroup)
      this.selGroup.traverse((o) => {
        const any = o as unknown as { geometry?: THREE.BufferGeometry; material?: THREE.Material }
        any.geometry?.dispose()
        any.material?.dispose()
      })
      this.selGroup = null
    }
    const json = this.sceneJSON
    if (!json || !ids.length) return
    const base = json.level === 'L0' ? 1150 : 10
    const g = new THREE.Group()
    for (const id of ids.slice(0, 3)) {
      const w = json.wells.find((x) => x.id === id)
      if (!w) continue
      const geo = new THREE.TorusGeometry(1, 0.12, 6, 40)
      const mat = new THREE.MeshBasicMaterial({ color: 0x67c7d6 })
      const m = new THREE.Mesh(geo, mat)
      m.scale.setScalar(base)
      m.rotation.x = -Math.PI / 2
      m.position.set(w.x, (this.wellTop.get(id) ?? base) + base * 0.9, w.z)
      m.userData.name = 'selection-ring'
      m.userData.basis = '下注选择标记（交互反馈层）：只标记用户已选的井，不编码数据；最多 3 口对应预算约束'
      g.add(m)
    }
    g.userData.name = 'selection-rings'
    this.root.add(g)
    this.selGroup = g
  }

  /**
   * 选择动词：飞到某口井（扩展方法）。
   *
   * 不能用 presetPose('C1') 代替——C1 以 pad 坐标为锚，L0 下锚点在原点，
   * 飞过去会看到一片空地，井全在框外（实测就是这样，后续点击全部失效）。
   * 这里按层级给两套近景：L0 用区域近景，L1 用 C2 井筒。
   */
  focusWell(id: string): void {
    const json = this.sceneJSON
    if (!json) return
    const w = json.wells.find((x) => x.id === id)
    if (!w) return
    this.ctx.wellX = w.x
    this.ctx.wellZ = w.z
    const pad = json.pads.find((p) => p.wellIds.includes(id))
    if (pad) {
      this.ctx.padX = pad.cx
      this.ctx.padZ = pad.cz
    }
    const pose: Pose =
      json.level === 'L0'
        ? { pos: [w.x + 2200, 1600, w.z + 2200], target: [w.x, 0, w.z], fov: 45 }
        : presetPose('C2', this.ctx)
    this.setCamera(pose, { durationMs: 700 })
  }

  /**
   * 把某口井的井口投影到画布坐标（扩展方法，供 e2e 精准点击）。
   * 返回 null 表示该井不在当前层级/视锥内。
   */
  project(id: string): { x: number; y: number } | null {
    const json = this.sceneJSON
    if (!json || !this.camera || !this.renderer) return null
    const w = json.wells.find((x) => x.id === id)
    if (!w) return null
    const v = new THREE.Vector3(w.x, this.wellTop.get(id) ?? 0, w.z)
    v.project(this.camera)
    if (v.z > 1) return null
    const rect = this.renderer.domElement.getBoundingClientRect()
    return {
      x: rect.left + ((v.x + 1) / 2) * rect.width,
      y: rect.top + ((1 - v.y) / 2) * rect.height,
    }
  }

  /**
   * T09 · 几何 basis 浮标（E3）：悬停/点击任意几何 → 该几何的显示依据。
   * 沿父链向上找第一个带 basis 的对象；命中无 basis 的叶子（理论不存在，
   * scene_basis 验收会拦）则继续找下一个命中点。返回 null = 没命中。
   */
  basisAt(ev: { clientX: number; clientY: number }): { name: string; basis: string } | null {
    if (!this.camera || !this.renderer || !this.root) return null
    const rect = this.renderer.domElement.getBoundingClientRect()
    const ndc = new THREE.Vector2(
      ((ev.clientX - rect.left) / rect.width) * 2 - 1,
      -((ev.clientY - rect.top) / rect.height) * 2 + 1,
    )
    const ray = new THREE.Raycaster()
    ray.params.Line = { threshold: 50 }
    ray.setFromCamera(ndc, this.camera)
    const hits = ray.intersectObjects(this.root.children, true)
    for (const h of hits) {
      let o: THREE.Object3D | null = h.object
      while (o) {
        const b = (o.userData as { basis?: string }).basis
        if (b) {
          return { name: String(o.userData.name ?? 'geometry'), basis: b }
        }
        o = o.parent
      }
    }
    return null
  }

  pick(ev: { clientX: number; clientY: number }): PickResult {
    if (!this.camera || !this.renderer) return { wellId: null, point: [0, 0, 0] }
    const rect = this.renderer.domElement.getBoundingClientRect()
    const ndc = new THREE.Vector2(
      ((ev.clientX - rect.left) / rect.width) * 2 - 1,
      -((ev.clientY - rect.top) / rect.height) * 2 + 1,
    )
    const ray = new THREE.Raycaster()
    ray.setFromCamera(ndc, this.camera) // 用 three 的 Raycaster，不自写 CPU 投影
    const hits = ray.intersectObjects(this.pickables, false)
    const hit = hits[0]
    if (!hit) return { wellId: null, point: [0, 0, 0] }
    // 井口柱是 InstancedMesh：命中个体由 instanceId 反查，而不是整个 mesh 一个 id
    let wellId = (hit.object.userData.wellId as string) ?? null
    const ids = hit.object.userData.ids as string[] | undefined
    if (ids && typeof hit.instanceId === 'number') wellId = ids[hit.instanceId] ?? wellId
    return { wellId, point: [hit.point.x, hit.point.y, hit.point.z] }
  }

  resize(): void {
    if (!this.renderer || !this.camera) return
    const canvas = this.renderer.domElement
    const w = canvas.clientWidth || 960
    const h = canvas.clientHeight || 540
    this.renderer.setSize(w, h, false)
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
  }

  on<K extends keyof EventMap>(ev: K, cb: (p: EventMap[K]) => void): void {
    ;(this.listeners[ev] ||= []).push(cb as never)
  }

  getPerf(): PerfStat {
    return {
      fps: Math.round(this.fps),
      triangles: this.triangles(),
      drawCalls: this.renderer?.info.render.calls ?? 0,
      tier: this.tier,
      level: this.level,
    }
  }

  /* --------------------------------------------------- 扩展点（加法，非冻结面）
   *
   * P0_接口冻结表的 8 个冻结方法签名不变；以下两个方法为 P11 §5 资产运行层
   * （assetRuntime：glb 资产 + 四连杆 rig + 液位）的接入点，由建模专家维护。
   * 删除这两个方法即可完全退回 P6 纯程序化场景。
   */

  /** 场景根访问器（assetRuntime 挂 glb 资产用）。引擎未初始化或已销毁时返回 null。 */
  getScene(): THREE.Scene | null {
    return this.disposed ? null : this.scene
  }

  /**
   * 注册逐帧回调（dt 秒，上限 0.1 s 防后台标签页跳变）。
   * 返回反注册函数；dispose 时自动清空。
   */
  onFrame(cb: (dtSec: number) => void): () => void {
    this.frameCbs.add(cb)
    return () => this.frameCbs.delete(cb)
  }

  /* -------------------------------------------------------------- 内部 */

  private emit<K extends keyof EventMap>(ev: K, payload: EventMap[K]): void {
    for (const cb of this.listeners[ev] ?? []) (cb as (p: EventMap[K]) => void)(payload)
  }

  private triangles(): number {
    return this.renderer?.info.render.triangles ?? 0
  }

  private clearRoot(): void {
    if (!this.root) return
    this.root.traverse((o) => {
      const any = o as unknown as {
        geometry?: THREE.BufferGeometry
        material?: THREE.Material | THREE.Material[]
      }
      any.geometry?.dispose()
      if (Array.isArray(any.material)) any.material.forEach((m) => m.dispose())
      else any.material?.dispose()
    })
    this.root.clear()
    this.pickables = []
    this.wellTop.clear()
    this.ringGroup = null
    this.selGroup = null
    this.fracInst = null
    this.surfaceMesh = null
    this.surfaceBase = null
    this.wellHeadMesh = null
  }

  private buildTerrain(json: SceneJSON): void {
    if (!this.root) return
    const [[x0, x1], [z0, z1]] = [json.extent.x, json.extent.z]
    const w = x1 - x0
    const d = z1 - z0
    // 三角面预算：128² 网格 = 32,768 面，单 draw call，填充率才是瓶颈不是面数
    const seg = this.tier === 'A' ? 144 : 96
    const geo = new THREE.PlaneGeometry(w, d, seg, seg)
    geo.rotateX(-Math.PI / 2)
    geo.translate((x0 + x1) / 2, 0, (z0 + z1) / 2)

    const pos = geo.attributes.position as THREE.BufferAttribute
    const ex = json.basis.verticalExaggeration
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i)
      const z = pos.getZ(i)
      pos.setY(i, terraneH(x, z, 320) * ex)
    }
    geo.computeVertexNormals()

    const mat = new THREE.MeshStandardMaterial({
      color: 0x252f36,
      roughness: 0.96,
      metalness: 0.02,
      flatShading: false,
    })
    const mesh = new THREE.Mesh(geo, mat)
    mesh.receiveShadow = this.tier === 'A'
    mesh.userData.name = 'terrain'
    mesh.userData.basis = json.basis.terrainBasis
    this.root.add(mesh)

    // 等高线：marching squares，程序生成，不用贴图
    const contour = this.buildContours(geo, seg, 7)
    if (contour) {
      // E3：等高线也是几何体，同样必须带 basis，否则不渲染
      contour.userData.name = 'contours'
      contour.userData.basis =
        '等高线由高程场 marching squares 7 级提取；高程为确定性伪噪声（非实测 DEM），故等高线仅示意地形起伏'
      this.root.add(contour)
    }

    // 裙边：地形是单层平面，不加深度的块体像一张纸。
    // 注意必须**沿地形边界顶点**向下拉侧壁——用平整 Box 会与起伏地形互相穿插，
    // 实测出现了明显的台阶状伪影。
    const skirt = this.buildSkirt(json, seg, json.level === 'L0' ? 900 : 220)
    if (skirt) this.root.add(skirt)
  }

  /** 沿地形四条边生成侧壁（跟随地形起伏，避免与地面穿插） */
  private buildSkirt(json: SceneJSON, seg: number, depthM: number): THREE.Mesh | null {
    const [[x0, x1], [z0, z1]] = [json.extent.x, json.extent.z]
    const ex = json.basis.verticalExaggeration
    const pts: number[] = []
    const push = (ax: number, az: number, bx: number, bz: number) => {
      const ay = terraneH(ax, az, 320) * ex
      const by = terraneH(bx, bz, 320) * ex
      const base = -depthM
      // 两个三角形组成一段墙（法线朝外，双面材质兜底）
      pts.push(ax, ay, az, bx, by, bz, bx, base, bz)
      pts.push(ax, ay, az, bx, base, bz, ax, base, az)
    }
    for (let i = 0; i < seg; i++) {
      const t0 = i / seg
      const t1 = (i + 1) / seg
      const xa = x0 + (x1 - x0) * t0
      const xb = x0 + (x1 - x0) * t1
      push(xa, z0, xb, z0) // 南
      push(xa, z1, xb, z1) // 北
      const za = z0 + (z1 - z0) * t0
      const zb = z0 + (z1 - z0) * t1
      push(x0, za, x0, zb) // 西
      push(x1, za, x1, zb) // 东
    }
    if (!pts.length) return null
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3))
    g.computeVertexNormals()
    const m = new THREE.MeshStandardMaterial({
      color: 0x141a1f,
      roughness: 0.95,
      metalness: 0,
      side: THREE.DoubleSide,
    })
    const mesh = new THREE.Mesh(g, m)
    mesh.userData.name = 'skirt'
    mesh.userData.basis = '侧壁为视觉厚度（900 m / 220 m），非地层真厚；顶面高程为伪噪声'
    return mesh
  }

  private buildContours(geo: THREE.BufferGeometry, seg: number, levels: number): THREE.LineSegments | null {
    const pos = geo.attributes.position as THREE.BufferAttribute
    const n = seg + 1
    const pts: number[] = []
    const heights: number[] = []
    for (let i = 0; i < pos.count; i++) heights.push(pos.getY(i))
    const lo = Math.min(...heights)
    const hi = Math.max(...heights)
    for (let L = 1; L <= levels; L++) {
      const h = lo + ((hi - lo) * L) / (levels + 1)
      for (let r = 0; r < seg; r++) {
        for (let c = 0; c < seg; c++) {
          const i00 = r * n + c
          const i10 = r * n + c + 1
          const i01 = (r + 1) * n + c
          const i11 = (r + 1) * n + c + 1
          const v = [heights[i00], heights[i10], heights[i11], heights[i01]]
          const P = [i00, i10, i11, i01].map((k) => [
            pos.getX(k), pos.getY(k), pos.getZ(k),
          ])
          const cross: number[][] = []
          for (let e = 0; e < 4; e++) {
            const a = v[e]
            const b = v[(e + 1) % 4]
            if ((a - h) * (b - h) < 0) {
              const k = (h - a) / (b - a)
              cross.push([
                P[e][0] + (P[(e + 1) % 4][0] - P[e][0]) * k,
                h,
                P[e][2] + (P[(e + 1) % 4][2] - P[e][2]) * k,
              ])
            }
          }
          if (cross.length >= 2) {
            pts.push(...cross[0], ...cross[1])
            if (cross.length === 4) pts.push(...cross[2], ...cross[3])
          }
        }
      }
    }
    if (!pts.length) return null
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3))
    const m = new THREE.LineBasicMaterial({ color: 0x4a5a64, transparent: true, opacity: 0.7 })
    return new THREE.LineSegments(g, m)
  }

  private buildWells(json: SceneJSON): void {
    if (!this.root) return
    const maxAnchor = Math.max(...json.wells.map((w) => w.anchor), 0.01)
    const H = json.level === 'L0' ? 4200 : 140

    // 井口柱：按状态分 4 种棱柱（D8 形状冗余）
    const groups: Record<string, WellGeo[]> = { green: [], yellow: [], red: [], gray: [] }
    for (const w of json.wells) groups[w.state].push(w)

    for (const [state, ws] of Object.entries(groups)) {
      if (!ws.length) continue
      const segs = SEG_BY_STATE[state as WellGeo['state']]
      const geo = new THREE.CylinderGeometry(1, 1, 1, segs, 1)
      geo.translate(0, 0.5, 0)
      const mat = new THREE.MeshStandardMaterial({
        color: COLOR[state as WellGeo['state']],
        roughness: 0.62,
        metalness: 0.18,
      })
      const mesh = new THREE.InstancedMesh(geo, mat, ws.length)
      mesh.castShadow = this.tier === 'A'
      const m4 = new THREE.Matrix4()
      const ids: string[] = []
      const colors: number[] = []
      ws.forEach((w, i) => {
        // 井口柱高按 anchor 归一化放大：真实 0.1–42 m³/d 直接按米画等于零高度，
        // 这是可读性妥协，basis 里写明
        const h = H * (0.22 + 0.78 * Math.sqrt(w.anchor / maxAnchor))
        const r = json.level === 'L0' ? 520 : 3
        m4.makeScale(r, h, r)
        m4.setPosition(w.x, 0, w.z)
        mesh.setMatrixAt(i, m4)
        this.wellTop.set(w.id, h)
        ids.push(w.id)
        colors.push(COLOR[w.state])
      })
      mesh.userData.ids = ids
      mesh.userData.colors = colors
      mesh.userData.wellId = ws[0].id
      mesh.userData.name = `wellhead-pillars-${state}`
      mesh.userData.basis =
        json.basis.wellheadBasis
        + `；本组棱数 ${segs}（green=6 / yellow=4 / red=3 / gray=8），${ws.length} 口`
      mesh.instanceMatrix.needsUpdate = true
      this.root.add(mesh)
      this.pickables.push(mesh)
      if (state === 'green') this.wellHeadMesh = mesh
    }

    // 井筒：垂直段 + 造斜段（TubeGeometry）
    // 井筒：合并成 1 个 mesh。77 根管子各一个 draw call 是 604 次调用里的大头，
    // 合并后降到 1 次；代价是不能再按 mesh 拾取——改由井口柱（InstancedMesh）承担拾取。
    const latGeos: THREE.BufferGeometry[] = []
    for (const w of json.wells) {
      const depth = -Math.abs(w.md || 3000)
      const curve = new THREE.CatmullRomCurve3([
        new THREE.Vector3(w.x, 0, w.z),
        new THREE.Vector3(w.x, depth * 0.55, w.z),
        new THREE.Vector3(
          w.x + (json.level === 'L0' ? 0 : 260),
          depth,
          w.z + (json.level === 'L0' ? 0 : 120),
        ),
      ])
      latGeos.push(
        new THREE.TubeGeometry(
          curve,
          this.tier === 'A' ? 24 : 20,
          json.level === 'L0' ? 60 : 2.6,
          this.tier === 'A' ? 8 : 6,
          false,
        ),
      )
    }
    const merged = latGeos.length ? mergeGeometries(latGeos, false) : null
    latGeos.forEach((g) => g.dispose())
    if (merged) {
      const mat = new THREE.MeshStandardMaterial({
        color: 0xb9c6cf,
        roughness: 0.42,
        metalness: 0.35,
        emissive: 0x223038,
        emissiveIntensity: 0.55,
      })
      const mesh = new THREE.Mesh(merged, mat)
      mesh.userData.name = 'wellbore'
      mesh.userData.basis = '井深取 MD 中位 2400–3650 m；造斜段为示意'
      this.root.add(mesh)
    }

    // 裂缝：一条几何 + 实例化，按 t 统一缩放（全部射孔簇同源）。
    const halfMax = json.basis.fracHalfMaxM
    const nFrac = json.wells.length * 3
    if (nFrac > 0) {
      const fg = new THREE.PlaneGeometry(halfMax * 2, json.level === 'L0' ? 120 : 42)
      const fm = new THREE.MeshBasicMaterial({
        color: 0xc0764a,
        transparent: true,
        opacity: 0.28,
        side: THREE.DoubleSide,
        depthWrite: false,
      })
      const inst = new THREE.InstancedMesh(fg, fm, nFrac)
      const m4 = new THREE.Matrix4()
      const q = new THREE.Quaternion()
      const p3 = new THREE.Vector3()
      const s3 = new THREE.Vector3(0.01, 1, 1)
      let i = 0
      for (const w of json.wells) {
        const depth = -Math.abs(w.md || 3000)
        for (let k = -1; k <= 1; k++) {
          p3.set(w.x + k * (json.level === 'L0' ? 90 : 18), depth + 120, w.z)
          q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), (k * Math.PI) / 3)
          m4.compose(p3, q, s3)
          inst.setMatrixAt(i++, m4)
        }
      }
      inst.instanceMatrix.needsUpdate = true
      inst.userData.name = 'fractures'
      inst.userData.basis = json.basis.fracBasis
      this.root.add(inst)
      this.fracInst = inst
    }

    this.buildRings(json)
  }

  /**
   * 井口环：编码 NPV 的**符号与量级**（数据绑定表要求「环 = sign(npv)」）。
   *
   * D8 形状冗余：正 NPV 用圆环（TorusGeometry, 32 边），负 NPV 用方环（4 边），
   * 灰度下靠轮廓就能分，不靠颜色。
   * 半径按 |npv|^0.5 归一化——线性映射会让 1099 万和 12 万差 90 倍，小的看不见。
   */
  private buildRings(json: SceneJSON): void {
    if (!this.root) return
    const maxAbs = Math.max(...json.wells.map((w) => Math.abs(w.npv)), 1)
    const base = json.level === 'L0' ? 900 : 8
    const pos = json.wells.filter((w) => w.npv >= 0)
    const neg = json.wells.filter((w) => w.npv < 0)

    // 两个 InstancedMesh：正=圆环（32 边），负=方环（4 边）。
    // 首版每个环一个 mesh，77 个 draw call；实例化后 2 个。
    const groups: [WellGeo[], THREE.BufferGeometry, number, string][] = [
      [
        pos,
        new THREE.TorusGeometry(1, 0.16, 5, 16),
        0x5f9e6b,
        '正 NPV 圆环',
      ],
      [
        neg,
        new THREE.TorusGeometry(1, 0.2, 4, 4),
        0xb04a40,
        '负 NPV 方环',
      ],
    ]

    const g = new THREE.Group()
    const m4 = new THREE.Matrix4()
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0))
    const p3 = new THREE.Vector3()
    const s3 = new THREE.Vector3()

    for (const [list, geo, color, label] of groups) {
      if (!list.length) {
        geo.dispose()
        continue
      }
      const mat = new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 0.9,
        side: THREE.DoubleSide,
      })
      const inst = new THREE.InstancedMesh(geo, mat, list.length)
      list.forEach((w, i) => {
        const r = base * (0.45 + 0.55 * Math.sqrt(Math.abs(w.npv) / maxAbs))
        p3.set(w.x, (this.wellTop.get(w.id) ?? base) + base * 0.6, w.z)
        s3.setScalar(r)
        m4.compose(p3, q, s3)
        inst.setMatrixAt(i, m4)
      })
      inst.instanceMatrix.needsUpdate = true
      inst.userData.name = `npv-ring-${label === '正 NPV 圆环' ? 'pos' : 'neg'}`
      inst.userData.basis =
        `${label}；环径按 |NPV|^0.5 归一化（线性映射会让大小井差 90 倍）。`
        + '正=圆环 / 负=方环，形状而非颜色区分，灰度下仍可辨'
      g.add(inst)
    }
    g.userData.name = 'npv-rings'
    this.root.add(g)
    this.ringGroup = g
  }

  private buildPipes(json: SceneJSON): void {
    if (!this.root || !json.pipes.length) return
    const byId = new Map<string, { x: number; z: number }>()
    for (const p of json.pads) byId.set(p.id, { x: p.cx, z: p.cz })
    for (const w of json.wells) byId.set(w.id, { x: w.x, z: w.z })

    // 管线宽度编码「预测产量」：按 pad 的 12 月预测合计分 3 档，
    // 每档合并成一个 mesh（3 个 draw call）。单档内仍合并，不回到 58 次调用。
    const weightOf = (id: string) => {
      const pad = json.pads.find((p) => p.id === id)
      if (pad) return pad.pred
      const w = json.wells.find((x) => x.id === id)
      return w ? w.pred.reduce((a, b) => a + b, 0) : 0
    }
    const items = json.pipes
      .map((p) => ({ p, w: weightOf(p.from) + weightOf(p.to) }))
      .filter(({ p }) => byId.has(p.from) && byId.has(p.to))
    if (!items.length) return
    items.sort((a, b) => a.w - b.w)
    const third = Math.ceil(items.length / 3)
    const radius = json.level === 'L0' ? [55, 105, 180] : [1.6, 2.6, 4.0]

    for (let k = 0; k < 3; k++) {
      const slice = items.slice(k * third, (k + 1) * third)
      if (!slice.length) continue
      const geos: THREE.BufferGeometry[] = []
      for (const { p } of slice) {
        const a = byId.get(p.from)!
        const b = byId.get(p.to)!
        const mid = new THREE.Vector3((a.x + b.x) / 2, 40, (a.z + b.z) / 2)
        const curve = new THREE.QuadraticBezierCurve3(
          new THREE.Vector3(a.x, 20, a.z),
          mid,
          new THREE.Vector3(b.x, 20, b.z),
        )
        geos.push(new THREE.TubeGeometry(curve, 12, radius[k], 5, false))
      }
      const merged = mergeGeometries(geos, false)
      geos.forEach((g) => g.dispose())
      if (!merged) continue
      const mat = new THREE.MeshStandardMaterial({
        color: 0x5f7684,
        roughness: 0.7,
        metalness: 0.3,
        transparent: true,
        opacity: 0.85,
      })
      const mesh = new THREE.Mesh(merged, mat)
      mesh.userData.name = `pipes-${k}`
      mesh.userData.basis =
        '管线宽度按端点 12 月预测产量三等分（细/中/粗）；走向为 pad 间连线的示意路由，非实际集输'
      this.root.add(mesh)
    }
  }

  private buildSurface(json: SceneJSON): void {
    if (!this.root) return
    const { rows, cols, grid } = json.surface
    if (!rows || !cols) return
    const [[x0, x1], [z0, z1]] = [json.extent.x, json.extent.z]
    const geo = new THREE.PlaneGeometry(x1 - x0, z1 - z0, cols - 1, rows - 1)
    geo.rotateX(-Math.PI / 2)
    geo.translate((x0 + x1) / 2, 0, (z0 + z1) / 2)

    const pos = geo.attributes.position as THREE.BufferAttribute
    const base = new Float32Array(pos.count)
    const scale = json.level === 'L0' ? 1400 : 80
    for (let i = 0; i < pos.count; i++) {
      base[i] = (grid[i] ?? 0) * scale
      pos.setY(i, base[i])
    }
    pos.needsUpdate = true
    geo.computeVertexNormals()

    const mat = new THREE.MeshBasicMaterial({
      color: 0x4a7fa5,
      transparent: true,
      opacity: 0.28,
      side: THREE.DoubleSide,
      depthWrite: false,
      wireframe: false,
    })
    const mesh = new THREE.Mesh(geo, mat)
    mesh.userData.name = 'surface'
    mesh.userData.basis = '曲面高度 = 12 月预测产量归一化，非压力场'
    this.root.add(mesh)
    this.surfaceMesh = mesh
    this.surfaceBase = base
  }

  private startLoop(): void {
    this.fpsT0 = performance.now()
    this.lastFrameT = this.fpsT0
    const loop = () => {
      if (this.disposed || !this.renderer || !this.scene || !this.camera) return
      this.raf = requestAnimationFrame(loop)
      const now = performance.now()
      const dt = Math.min((now - this.lastFrameT) / 1000, 0.1)
      this.lastFrameT = now
      for (const cb of this.frameCbs) cb(dt)
      this.controls?.update()
      this.lightRig?.update(this.camera)
      this.renderer.render(this.scene, this.camera)
      this.frames++
      if (now - this.fpsT0 >= 500) {
        this.fps = (this.frames * 1000) / (now - this.fpsT0)
        this.frames = 0
        this.fpsT0 = now
        const stat = this.getPerf()
        ;(window as unknown as Record<string, unknown>).__PERF__ = stat
        this.emit('perf', stat)
      }
    }
    loop()
  }
}
