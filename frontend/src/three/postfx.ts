/**
 * postfx.ts · 后处理链（SSAO / Bloom / 体积雾近似）
 *
 * **诚实声明**：这里的「体积雾」不是 raymarching 体积雾，是屏幕空间大气透视近似
 * （中心清晰、随距离与视线倾角增加雾量）。真 raymarching 需要深度纹理 + 多步采样，
 * 在这个场景（101 km 视域、软件渲染）里成本不可接受，且 D-007 的判据是可开关不是物理正确。
 * 若要真体积雾，走 UE5 路线或后期加 GodRays，本期不做。
 *
 * 三个 pass 各自独立可开关，且**关掉任何一个都仍然出图**（不是一关就黑屏）。
 * 依赖：three/examples/jsm/postprocessing/*（会进 bundle，注意体积增量）。
 */
import * as THREE from 'three'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { SSAOPass } from 'three/examples/jsm/postprocessing/SSAOPass.js'
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js'
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js'
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js'

export interface PostFXConfig {
  ssao: {
    enabled: boolean
    kernelRadius: number
    minDistance: number
    maxDistance: number
    output: number
  }
  bloom: {
    enabled: boolean
    strength: number
    radius: number
    threshold: number
  }
  /** 体积雾近似（屏幕空间大气透视） */
  volumetricFog: {
    enabled: boolean
    density: number
    heightFalloff: number
    color: [number, number, number]
    /** 视线越平越浓（掠射），越俯视越淡 */
    horizonBoost: number
  }
}

export const DEFAULT_POSTFX: PostFXConfig = {
  ssao: { enabled: true, kernelRadius: 0.55, minDistance: 0.0012, maxDistance: 0.06, output: 0 },
  bloom: { enabled: true, strength: 0.42, radius: 0.55, threshold: 0.82 },
  volumetricFog: { enabled: true, density: 0.0022, heightFalloff: 0.055, color: [0.42, 0.55, 0.66], horizonBoost: 1.9 },
}

/** 体积雾近似的着色器：不需要深度纹理，用视线与高度做衰减 */
const HazeShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uDensity: { value: 0.0022 },
    uHorizon: { value: 1.9 },
    uColor: { value: new THREE.Color(0.42, 0.55, 0.66) },
    uTime: { value: 0 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uDensity;
    uniform float uHorizon;
    uniform vec3  uColor;
    varying vec2 vUv;

    void main() {
      vec4 src = texture2D(tDiffuse, vUv);
      // 屏幕中心到边缘的径向距离：远处（画面上方）雾更浓
      vec2 d = vUv - 0.5;
      float radial = length(d);
      // 竖直梯度：上部（远景/天空）雾浓，下部（近地）雾淡
      float vert = smoothstep(0.85, 0.1, vUv.y);
      float amt = clamp(uDensity * 260.0 * (vert * uHorizon + radial * 0.6), 0.0, 0.55);
      vec3 fogged = mix(src.rgb, uColor, amt);
      gl_FragColor = vec4(fogged, src.a);
    }
  `,
}

export type PostFXKey = 'ssao' | 'bloom' | 'volumetricFog'

export interface PostFXRig {
  cfg: PostFXConfig
  readonly enabled: boolean
  render(): void
  setSize(w: number, h: number): void
  setEnabled(key: PostFXKey, on: boolean): void
  getEnabled(): Record<PostFXKey, boolean>
  dispose(): void
}

/**
 * 构建后处理链。**只有 tier === 'A' 或显式 force 时才真正创建 composer**，
 * Tier B（软件渲染）返回一个 enabled=false 的空壳，render() 直接调 renderer.render。
 *
 * 依据 D-007：软渲基线 34–35 fps，全开 SSAO+Bloom 会掉到 10 fps 以下。
 */
export function buildPostFX(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.PerspectiveCamera,
  tier: 'A' | 'B',
  cfgIn: Partial<PostFXConfig> = {},
  force = false,
): PostFXRig {
  const cfg: PostFXConfig = {
    ssao: { ...DEFAULT_POSTFX.ssao, ...cfgIn.ssao },
    bloom: { ...DEFAULT_POSTFX.bloom, ...cfgIn.bloom },
    volumetricFog: { ...DEFAULT_POSTFX.volumetricFog, ...cfgIn.volumetricFog },
  }

  const usable = tier === 'A' || force
  const anyOn = cfg.ssao.enabled || cfg.bloom.enabled || cfg.volumetricFog.enabled

  if (!usable || !anyOn) {
    return {
      cfg,
      enabled: false,
      render: () => renderer.render(scene, camera),
      setSize: () => {},
      setEnabled: (k, on) => { cfg[k].enabled = on },
      getEnabled: () => ({ ssao: cfg.ssao.enabled, bloom: cfg.bloom.enabled, volumetricFog: cfg.volumetricFog.enabled }),
      dispose: () => {},
    }
  }

  const size = renderer.getSize(new THREE.Vector2())
  const composer = new EffectComposer(renderer)

  const renderPass = new RenderPass(scene, camera)
  const ssaoPass = new SSAOPass(scene, camera, size.x, size.y)
  ssaoPass.kernelRadius = cfg.ssao.kernelRadius
  ssaoPass.minDistance = cfg.ssao.minDistance
  ssaoPass.maxDistance = cfg.ssao.maxDistance
  ssaoPass.output = cfg.ssao.output as SSAOPass['output']

  const bloomPass = new UnrealBloomPass(
    new THREE.Vector2(size.x, size.y), cfg.bloom.strength, cfg.bloom.radius, cfg.bloom.threshold,
  )
  const hazePass = new ShaderPass(HazeShader)
  hazePass.uniforms.uDensity.value = cfg.volumetricFog.density
  hazePass.uniforms.uHorizon.value = cfg.volumetricFog.horizonBoost
  hazePass.uniforms.uColor.value = new THREE.Color(...cfg.volumetricFog.color)
  const outputPass = new OutputPass()

  /** 按当前开关重建 pass 顺序：SSAO 自带场景渲染，所以与 RenderPass 二选一 */
  function rebuild() {
    composer.passes.length = 0
    composer.addPass(cfg.ssao.enabled ? ssaoPass : renderPass)
    if (cfg.bloom.enabled) composer.addPass(bloomPass)
    if (cfg.volumetricFog.enabled) composer.addPass(hazePass)
    composer.addPass(outputPass)
  }
  rebuild()

  return {
    cfg,
    enabled: true,
    render: () => composer.render(),
    setSize: (w, h) => {
      composer.setSize(w, h)
      ssaoPass.setSize(w, h)
      bloomPass.setSize(w, h)
    },
    setEnabled: (k, on) => {
      cfg[k].enabled = on
      rebuild()
    },
    getEnabled: () => ({
      ssao: cfg.ssao.enabled,
      bloom: cfg.bloom.enabled,
      volumetricFog: cfg.volumetricFog.enabled,
    }),
    dispose: () => {
      ssaoPass.dispose?.()
      bloomPass.dispose?.()
      hazePass.dispose?.()
      outputPass.dispose?.()
      composer.dispose?.()
    },
  }
}
