/**
 * assetRuntime.ts · glb 资产运行层（建模专家维护，P11 §5）
 *
 * 职责：把 Blender 产出的 glb 资产挂进 P6 冻结引擎的场景，并按数据驱动
 * 运行态：储罐液位（罐内 tk_liquid + D-054 磁翻板立管 tk_gauge_liquid）、
 * 抽油机四连杆（PumpjackRig，8 台实例化、首台动画）。
 *
 * 边界（架构 §2.2「3D 只读快照」）：
 *  - 本层**不读 Pinia store**，数据一律由视图层经 setSiteOil() 传入；
 *  - 不改 engine.ts 冻结方法，只用 getScene() / onFrame() 两个加法扩展点；
 *  - 删除本层，引擎退回纯程序化场景，无残留引用。
 *  - 资产一律 add 到 engine.getScene()（不是引擎 root）——root 会被
 *    setScene 的 clearRoot 清掉，挂 scene 才能在层级切换后存活（实测踩过）。
 *
 * 资产 URL 由调用方传入（Vite 下 `import tankUrl from '@/assets/tank_lod0.glb?url'`，
 * 单文件构建走 assetsInlineLimit 内联 base64 —— R-004 口径），本层不做网络假设。
 */
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { setTankLevel, setGaugeLevel, levelFromSiteOil, levelToVolume, levelToHeight, TANK_LIQ } from './tankLevel'
import { PumpjackRig, findRigNodes } from './pumpjackRig'

/** engine.ts 的最小结构约束（避免为类型引入整个引擎类型链） */
export interface EngineLike {
  getScene(): THREE.Scene | null
  onFrame(cb: (dtSec: number) => void): () => void
}

export interface TankRuntime {
  /** 资产 id（= glb extras 里的 pa_id，sidecar 同键） */
  readonly id: string
  /** 直接设液位 0–1（跳过产量映射，测试用） */
  setLevelPct(pct: number): void
  /** 按全站日产油（m³/d）驱动液位 —— 视图层唯一需要调的方法 */
  setSiteOil(siteOilM3d: number): void
  /** 当前液位诊断信息 */
  info(): { pct: number; volumeM3: number; heightM: number; source: 'siteOil' | 'direct' | 'none' }
  dispose(): void
}

export interface AttachTankOpts {
  /** glb 地址或 data URI（base64 内联产物） */
  url: string
  /** 场景放置点（米）。默认 (0,0,0)。 */
  position?: [number, number, number]
  /** 朝向（绕 Y，弧度）。默认 0。 */
  rotationY?: number
  /** 缩放。默认 1（glb 已是米制真实尺寸）。 */
  scale?: number
  /** 覆盖 sidecar 默认周转天数（levelFromSiteOil 第 2 参） */
  turnoverDays?: number
}

export interface PumpjackRuntime {
  readonly id: string
  rig: PumpjackRig
  /** 实例台数（含首台） */
  readonly count: number
  dispose(): void
}

export interface AttachPumpjackOpts {
  url: string
  /** 首台放置点（米） */
  position?: [number, number, number]
  /** 相邻两台的排布间距（米，沿 +X）。默认 22（9 m 机身 + 检修空间） */
  spacing?: number
  /** 总台数。默认 8。 */
  count?: number
  rotationY?: number
  /** 冲次 1/min（1–12）。默认 5。 */
  strokeRate?: number
}

export interface AttachSimpleOpts {
  url: string
  position?: [number, number, number]
  rotationY?: number
  scale?: number
}

const loader = new GLTFLoader()

function loadGltf(url: string): Promise<THREE.Group> {
  return new Promise((res, rej) => {
    loader.load(
      url,
      (g) => res(g.scene),
      undefined,
      (e) => rej(new Error(`glb 加载失败: ${String((e as Error)?.message ?? e)}`)),
    )
  })
}

/** 遍历找 extras 里的 pa_id（glTF loader 把 extras 放在节点上，不在根组——实测踩过） */
function findPaId(root: THREE.Object3D, fallback: string): string {
  let id = ''
  root.traverse((o) => {
    if (!id) {
      const v = (o.userData as Record<string, unknown>)?.pa_id
      if (typeof v === 'string' && v) id = v
    }
  })
  return id || fallback
}

/** 在资产里找液位柱节点：优先名字，其次 extras.pa_group === 'liquid' */
function findLiquidNode(root: THREE.Object3D): THREE.Object3D | null {
  let byName: THREE.Object3D | null = root.getObjectByName('tk_liquid') ?? null
  if (byName) return byName
  root.traverse((o) => {
    if (!byName && (o.userData as Record<string, unknown>)?.pa_group === 'liquid') byName = o
  })
  return byName
}

/**
 * 把储罐资产挂进引擎场景，返回液位驱动句柄。
 *
 * 失败语义：引擎无场景 / glb 加载失败 / 找不到 tk_liquid —— 抛错给调用方，
 * **不静默降级**（液位不动但画面正常这种「假成功」比报错更危险，验收会漏）。
 */
export async function attachTank(engine: EngineLike, opts: AttachTankOpts): Promise<TankRuntime> {
  const scene = engine.getScene()
  if (!scene) throw new Error('引擎场景未就绪（init 未完成或已 dispose）')

  const gltf = await loadGltf(opts.url)
  const root = gltf
  root.position.set(...(opts.position ?? [0, 0, 0]))
  root.rotation.y = opts.rotationY ?? 0
  const s = opts.scale ?? 1
  root.scale.setScalar(s)
  // E3（T09）：资产几何同样必须带 basis（验收 scene_basis 遍历整个 scene，不止引擎 root）
  root.userData.name = 'tank-asset'
  root.userData.basis =
    '储罐 glb：Blender 参数化建模（build_tank.py），尺寸断言误差 0.0000%，LOD0 12,796 tris（预算 40k）；'
    + 'D-054 外挂磁翻板液位计，液位高度 = 全站日产油（77 井 value_oil 求和）按 7 天周转映射，非实测罐存量'
  scene.add(root)

  const liquid = findLiquidNode(root)
  if (!liquid) throw new Error('glb 里找不到 tk_liquid 节点（请用 build_tank.py 产物，勿手工改导出）')

  // D-054：立管液柱（旧版 glb 没有该节点时为 null，setGaugeLevel 安全跳过）
  const gauge = root.getObjectByName('tk_gauge_liquid') ?? null

  const id = findPaId(root, 'TK-UNKNOWN')

  let pct = 0
  let source: 'siteOil' | 'direct' | 'none' = 'none'

  const runtime: TankRuntime = {
    id,
    setLevelPct(p: number) {
      pct = p
      source = 'direct'
      setTankLevel(liquid as unknown as { scale: { y: number }; position: { y: number } }, p)
      setGaugeLevel(gauge as unknown as { scale: { y: number }; position: { y: number } } | null, p)
    },
    setSiteOil(siteOilM3d: number) {
      runtime.setLevelPct(levelFromSiteOil(siteOilM3d, opts.turnoverDays))
      source = 'siteOil'
    },
    info() {
      return { pct, volumeM3: levelToVolume(pct), heightM: levelToHeight(pct), source }
    },
    dispose() {
      scene.remove(root)
      root.traverse((o) => {
        const m = o as THREE.Mesh
        m.geometry?.dispose()
        if (Array.isArray(m.material)) m.material.forEach((x) => x.dispose())
        else (m.material as THREE.Material | undefined)?.dispose()
      })
    },
  }

  // 初始给一个明确的中位液位，避免「半罐默认但没人知道是谁设的」
  runtime.setLevelPct(0.5)
  source = 'none'
  pct = 0.5
  return runtime
}

/**
 * D-061②：抽油机挂载 —— 首台原物挂 PumpjackRig 每帧动画，
 * 第 2..count 台把每个网格转成 InstancedMesh（几何/材质共享，draw call 不随台数线性涨）。
 * 实例静止在 130° 出厂姿态；首台运动（生产井在动、停抽井静止，现场即如此）。
 */
export async function attachPumpjack(engine: EngineLike, opts: AttachPumpjackOpts): Promise<PumpjackRuntime> {
  const scene = engine.getScene()
  if (!scene) throw new Error('引擎场景未就绪（init 未完成或已 dispose）')

  const count = Math.max(1, opts.count ?? 8)
  const root = await loadGltf(opts.url)
  const base = opts.position ?? [0, 0, 0]
  root.position.set(...base)
  root.rotation.y = opts.rotationY ?? 0
  root.userData.name = 'pumpjack-asset'
  root.userData.basis =
    '抽油机 glb：API C-456-305-144 参数化建模（build_pumpjack.py），尺寸断言误差 0.0000%，LOD0 6,108 tris（预算 60k）；'
    + `共 ${count} 台（首台四连杆运行，其余实例化静止）；冲次由 PumpjackRig 控制（1–12/min）`
  scene.add(root)

  // 首台：rig
  const nodes = findRigNodes(root)
  const rig = new PumpjackRig(nodes)
  rig.setRunning(true)
  rig.setStrokeRate(opts.strokeRate ?? 5)

  // 其余台：每个网格 → InstancedMesh(count-1)，矩阵 = 平移(spacing*k) · rotY
  const instanced: THREE.InstancedMesh[] = []
  const spacing = opts.spacing ?? 22
  if (count > 1) {
    const m4 = new THREE.Matrix4()
    const r = new THREE.Matrix4().makeRotationY(opts.rotationY ?? 0)
    const meshes: THREE.Mesh[] = []
    root.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh)
    })
    for (const mesh of meshes) {
      const im = new THREE.InstancedMesh(mesh.geometry, mesh.material as THREE.Material, count - 1)
      for (let k = 1; k < count; k++) {
        m4.makeTranslation(base[0] + spacing * k, base[1], base[2])
        m4.multiply(r)
        im.setMatrixAt(k - 1, m4)
      }
      im.instanceMatrix.needsUpdate = true
      im.userData.name = 'pumpjack-instanced'
      im.userData.basis = root.userData.basis
      im.frustumCulled = false
      scene.add(im)
      instanced.push(im)
    }
  }

  const id = findPaId(root, 'PJ-UNKNOWN')
  const off = engine.onFrame((dt) => rig.update(dt))

  return {
    id,
    rig,
    count,
    dispose() {
      off()
      scene.remove(root)
      for (const im of instanced) scene.remove(im)
      root.traverse((o) => {
        const m = o as THREE.Mesh
        m.geometry?.dispose()
        if (Array.isArray(m.material)) m.material.forEach((x) => x.dispose())
        else (m.material as THREE.Material | undefined)?.dispose()
      })
    },
  }
}

/**
 * 采油树（井口装置）挂载：静态资产，无运行态。
 */
export async function attachChristmasTree(engine: EngineLike, opts: AttachSimpleOpts): Promise<{ id: string; dispose(): void }> {
  const scene = engine.getScene()
  if (!scene) throw new Error('引擎场景未就绪（init 未完成或已 dispose）')

  const root = await loadGltf(opts.url)
  root.position.set(...(opts.position ?? [0, 0, 0]))
  root.rotation.y = opts.rotationY ?? 0
  root.scale.setScalar(opts.scale ?? 1)
  root.userData.name = 'christmas-tree-asset'
  root.userData.basis =
    '采油树 glb：7-1/16" 350 型参数化建模（build_christmas_tree.py），尺寸断言误差 0.0000%，LOD0 8,988 tris（预算 25k）'
  scene.add(root)

  const id = findPaId(root, 'CT-UNKNOWN')
  return {
    id,
    dispose() {
      scene.remove(root)
      root.traverse((o) => {
        const m = o as THREE.Mesh
        m.geometry?.dispose()
        if (Array.isArray(m.material)) m.material.forEach((x) => x.dispose())
        else (m.material as THREE.Material | undefined)?.dispose()
      })
    },
  }
}

/** 未用到的导入保持 tree-shaking 友好（TANK_LIQ 供外部对账用） */
export { TANK_LIQ }
