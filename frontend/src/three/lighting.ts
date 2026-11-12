/**
 * lighting.ts · 光照方案（日轨 / 级联阴影 / 环境光 / 雾）
 *
 * 设计约束来自 D-007：T07 结项只认「五项各有独立开关 + 软渲染 fps ≥ 34」。
 * 所以这里不是一个"调好参数的光照"，而是一套**可逐项关断**的光照：
 * 每一项都有 enabled，且关掉之后场景仍然可读（不是一关就全黑）。
 *
 * 五项分别是：
 *   1. sun.trajectory    日轨（按经纬度 + 时刻算太阳方位/高度角）
 *   2. shadow.cascade    级联阴影（近景高精度 + 远景低精度两级）
 *   3. ambient           环境光（半球光，天空/地面双色）
 *   4. postfx.ssao       环境光遮蔽（在 postfx.ts，需 composer）
 *   5. postfx.fog        体积雾（在 postfx.ts，高度雾）
 *
 * 参数全部集中在 DEFAULT_LIGHT_CFG，可被外部 JSON 覆盖（见 applyConfig）。
 * **不要把这些值散落回 engine.ts** —— P3 明确禁止。
 */
import * as THREE from 'three'

export type QualityTier = 'A' | 'B'

export interface LightingConfig {
  sun: {
    /** 日轨：按经纬度和时刻算太阳方向 */
    enabled: boolean
    latitude: number      // 北纬为正
    longitude: number     // 东经为正（Weld County 为 −104.7）
    dayOfYear: number     // 1–365
    hour: number          // 0–24（当地真太阳时近似）
    intensity: number
    color: [number, number, number]
    /** 低角度时让光色偏暖，模拟大气散射 */
    warmAtLowSun: boolean
  }
  shadow: {
    /** 级联阴影总开关 */
    enabled: boolean
    /** 近景级：高精度，覆盖 camera 前方 nearMeters 内 */
    nearMeters: number
    nearMapSize: number
    /** 远景级：低精度，覆盖 farMeters 内 */
    farMeters: number
    farMapSize: number
    bias: number
  }
  ambient: {
    enabled: boolean
    skyColor: [number, number, number]
    groundColor: [number, number, number]
    intensity: number
    /** 场景背景色（null = 不动 scene.background） */
    background: [number, number, number] | null
  }
  fog: {
    /** 基础雾（scene.fog，几乎零成本，Tier B 也开得起） */
    enabled: boolean
    color: [number, number, number]
    near: number
    far: number
  }
}

/** 默认配置：Tier A 全开；Tier B 见 TIER_B_OVERRIDE */
export const DEFAULT_LIGHT_CFG: LightingConfig = {
  sun: {
    enabled: true,
    latitude: 40.35,
    longitude: -104.70,
    // 日轨参数不是随便挑的：11 月初下午 15:24 在 40.35°N 算出来高度角只有 17°，
    // 属于掠射光，垂直面几乎吃不到照度，场景一片黑（实测第一版就是这样）。
    // 取 9 月下旬 14:12 → 高度角约 45°，既保留斜阳的侧向立体感，又能看清构件。
    dayOfYear: 268,
    hour: 14.2,
    intensity: 3.6,
    color: [1.0, 0.93, 0.82],
    warmAtLowSun: true,
  },
  shadow: {
    enabled: true,
    nearMeters: 90,
    nearMapSize: 2048,
    farMeters: 520,
    farMapSize: 1024,
    bias: -0.0006,
  },
  ambient: {
    enabled: true,
    skyColor: [0.62, 0.74, 0.92],
    groundColor: [0.20, 0.18, 0.15],
    intensity: 2.1,
    /** 场景背景色（null = 不动 scene.background）。归入 ambient：关环境光时背景一起暗下来 */
    background: [0.33, 0.45, 0.61],
  },
  fog: {
    enabled: true,
    // 日间大气透视：远处淡出到接近地平线的霾色，而不是夜景的深蓝
    color: [0.46, 0.54, 0.64],
    near: 90,
    far: 900,
  },
}

/**
 * Tier B（软件渲染 / 集显）覆盖项。
 * 依据 D-007：软渲基线是 34–35 fps，任何一档后处理都会把它打穿。
 * 这里只保留「几乎零成本」的两项（日轨方向 + 线性雾），
 * 阴影与后处理全部关闭 —— 但**开关仍然存在且可被外部重新打开**，
 * 满足「五项各有独立开关」的判据。
 */
export const TIER_B_OVERRIDE: Partial<LightingConfig> = {
  shadow: { ...DEFAULT_LIGHT_CFG.shadow, enabled: false },
  ambient: { ...DEFAULT_LIGHT_CFG.ambient, intensity: 1.7 },
  fog: { ...DEFAULT_LIGHT_CFG.fog, near: 200, far: 1100 },
}

/** 深合并：外部 JSON 覆盖默认值 */
export function mergeConfig(
  base: LightingConfig,
  patch?: Partial<LightingConfig>,
): LightingConfig {
  if (!patch) return structuredClone(base)
  const out = structuredClone(base)
  for (const k of Object.keys(patch) as (keyof LightingConfig)[]) {
    const v = patch[k]
    if (v && typeof v === 'object') Object.assign(out[k] as object, v)
  }
  return out
}

// ---------------------------------------------------------------- 日轨

const RAD = Math.PI / 180

/**
 * 太阳方向（指向太阳的单位向量，three 坐标：Y-up，Z 朝南为负）。
 *
 * 用 NOAA 的简化太阳位置算法：
 *   赤纬 δ = 23.44° · sin(360/365 · (284 + N))
 *   时角 ω = 15° · (H − 12)
 *   高度角 h = asin(sinφ·sinδ + cosφ·cosδ·cosω)
 *   方位角 A = acos((sinδ − sin h · sinφ) / (cos h · cosφ))
 *
 * 场景坐标系：+X 东、+Z 南、−Z 北（three 默认，Blender 的 −Y 北映射而来）。
 */
export function sunDirection(
  latitude: number,
  dayOfYear: number,
  hour: number,
): { dir: THREE.Vector3; elevationDeg: number; azimuthDeg: number } {
  const phi = latitude * RAD
  const delta = 23.44 * RAD * Math.sin((360 / 365) * (284 + dayOfYear) * RAD)
  const omega = 15 * RAD * (hour - 12)

  const sinH = Math.sin(phi) * Math.sin(delta) + Math.cos(phi) * Math.cos(delta) * Math.cos(omega)
  const h = Math.asin(Math.max(-1, Math.min(1, sinH)))

  const cosA = (Math.sin(delta) - sinH * Math.sin(phi)) / (Math.cos(h) * Math.cos(phi) || 1e-9)
  let A = Math.acos(Math.max(-1, Math.min(1, cosA)))
  // 下午时角为正 → 太阳在西侧，方位角取 2π−A
  if (omega > 0) A = Math.PI * 2 - A

  // 方位角 A：从北起顺时针。three 里 +X 东、−Z 北
  const dir = new THREE.Vector3(
    Math.sin(A) * Math.cos(h),
    Math.sin(h),
    -Math.cos(A) * Math.cos(h),
  ).normalize()

  return { dir, elevationDeg: h / RAD, azimuthDeg: A / RAD }
}

/** 低太阳角偏暖（大气路径长，蓝光散射多） */
export function sunColorFor(cfg: LightingConfig['sun'], elevationDeg: number): THREE.Color {
  const base = new THREE.Color(...cfg.color)
  if (!cfg.warmAtLowSun) return base
  const t = THREE.MathUtils.clamp((28 - elevationDeg) / 28, 0, 1)   // 28° 以下开始变暖
  const warm = new THREE.Color(1.0, 0.62, 0.36)
  return base.clone().lerp(warm, t * 0.75)
}

// ---------------------------------------------------------------- 构建

export interface LightingRig {
  cfg: LightingConfig
  sun: THREE.DirectionalLight | null
  sunFar: THREE.DirectionalLight | null
  hemi: THREE.HemisphereLight | null
  /** 每帧调用：让阴影包围盒跟着相机走（简化级联，避免阴影在远处糊成一片） */
  update(camera: THREE.PerspectiveCamera): void
  /** 运行时改配置（UI 开关用） */
  setEnabled(key: EnableKey, on: boolean): void
  getEnabled(): Record<EnableKey, boolean>
  dispose(): void
}

export type EnableKey = 'sun' | 'shadow' | 'ambient' | 'fog'

/**
 * 搭光照。返回的 rig 里 sun/hemi 可能为 null（对应项关闭），
 * 调用方要按 null 判断，不要假设一定存在。
 */
export function buildLighting(
  scene: THREE.Scene,
  tier: QualityTier,
  userCfg?: Partial<LightingConfig>,
): LightingRig {
  const base = tier === 'B' ? mergeConfig(DEFAULT_LIGHT_CFG, TIER_B_OVERRIDE) : DEFAULT_LIGHT_CFG
  const cfg = mergeConfig(base, userCfg)

  const sunPos = sunDirection(cfg.sun.latitude, cfg.sun.dayOfYear, cfg.sun.hour)
  const color = sunColorFor(cfg.sun, sunPos.elevationDeg)

  let sun: THREE.DirectionalLight | null = null
  let sunFar: THREE.DirectionalLight | null = null

  if (cfg.sun.enabled) {
    sun = new THREE.DirectionalLight(color, cfg.sun.intensity)
    sun.position.copy(sunPos.dir).multiplyScalar(1000)
    sun.target.position.set(0, 0, 0)
    scene.add(sun)
    scene.add(sun.target)

    if (cfg.shadow.enabled) {
      sun.castShadow = true
      sun.shadow.mapSize.set(cfg.shadow.nearMapSize, cfg.shadow.nearMapSize)
      sun.shadow.bias = cfg.shadow.bias
      const d = cfg.shadow.nearMeters * 0.5
      Object.assign(sun.shadow.camera, {
        left: -d, right: d, top: d, bottom: -d, near: 1, far: cfg.shadow.farMeters * 2,
      })
      sun.shadow.camera.updateProjectionMatrix()

      // 远景级：同方向、低精度、不投影到近景（只补远处轮廓）
      sunFar = new THREE.DirectionalLight(color, cfg.sun.intensity * 0.35)
      sunFar.position.copy(sunPos.dir).multiplyScalar(1000)
      sunFar.castShadow = true
      sunFar.shadow.mapSize.set(cfg.shadow.farMapSize, cfg.shadow.farMapSize)
      sunFar.shadow.bias = cfg.shadow.bias * 1.8
      const df = cfg.shadow.farMeters * 0.5
      Object.assign(sunFar.shadow.camera, {
        left: -df, right: df, top: df, bottom: -df, near: 1, far: cfg.shadow.farMeters * 3,
      })
      sunFar.shadow.camera.updateProjectionMatrix()
      scene.add(sunFar)
      scene.add(sunFar.target)
    }
  }

  let hemi: THREE.HemisphereLight | null = null
  if (cfg.ambient.enabled) {
    hemi = new THREE.HemisphereLight(
      new THREE.Color(...cfg.ambient.skyColor),
      new THREE.Color(...cfg.ambient.groundColor),
      cfg.ambient.intensity,
    )
    scene.add(hemi)
    if (cfg.ambient.background) scene.background = new THREE.Color(...cfg.ambient.background)
  }

  const applyFog = () => {
    scene.fog = cfg.fog.enabled
      ? new THREE.Fog(new THREE.Color(...cfg.fog.color), cfg.fog.near, cfg.fog.far)
      : null
  }
  applyFog()

  const tmp = new THREE.Vector3()
  const rig: LightingRig = {
    cfg,
    sun,
    sunFar,
    hemi,
    update(camera) {
      if (!sun) return
      // 阴影包围盒跟着相机：近景级只覆盖相机前方 nearMeters
      const focus = tmp.copy(camera.position).add(
        camera.getWorldDirection(new THREE.Vector3()).multiplyScalar(cfg.shadow.nearMeters * 0.42),
      )
      sun.target.position.copy(focus)
      sun.position.copy(focus).add(sunPos.dir.clone().multiplyScalar(600))
      sun.target.updateMatrixWorld()

      if (sunFar) {
        const focusFar = camera.position.clone().add(
          camera.getWorldDirection(new THREE.Vector3()).multiplyScalar(cfg.shadow.farMeters * 0.45),
        )
        sunFar.target.position.copy(focusFar)
        sunFar.position.copy(focusFar).add(sunPos.dir.clone().multiplyScalar(1800))
        sunFar.target.updateMatrixWorld()
      }
    },
    setEnabled(key, on) {
      if (key === 'sun') {
        if (sun) sun.visible = on
        if (sunFar) sunFar.visible = on
      } else if (key === 'shadow') {
        if (sun) sun.castShadow = on
        if (sunFar) sunFar.castShadow = on
      } else if (key === 'ambient') {
        if (hemi) hemi.visible = on
      } else if (key === 'fog') {
        cfg.fog.enabled = on
        applyFog()
      }
      const section = cfg[key] as { enabled: boolean } | undefined
      if (section) section.enabled = on
    },
    getEnabled() {
      return {
        sun: cfg.sun.enabled,
        shadow: cfg.shadow.enabled,
        ambient: cfg.ambient.enabled,
        fog: cfg.fog.enabled,
      }
    },
    dispose() {
      for (const o of [sun, sunFar, hemi]) {
        if (!o) continue
        o.dispose?.()
        scene.remove(o)
        if ((o as THREE.DirectionalLight).target) scene.remove((o as THREE.DirectionalLight).target)
      }
      scene.fog = null
      scene.background = null
    },
  }

  return rig
}
