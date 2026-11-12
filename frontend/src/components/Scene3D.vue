<script setup lang="ts">
/**
 * Scene3D · three.js 场景基座（P6）
 *
 * 冻结 API（P0_接口冻结表 §3.1）：
 *   init / setScene / setCamera / setTime / highlight / pick / resize / dispose
 *
 * 设计约束：
 *  - **不读 Pinia store**：数据只能经 setScene 进来（架构 §2.2「3D 只读快照」）
 *  - **纹理全部程序生成**，无贴图文件、无外链
 *  - **单文件构建下无法网络懒加载**：3D 代码与主包同源，只能做"初始化懒加载"
 *    （首屏不创建 WebGL 上下文），这一点在 README 与 P6 文档里如实写明
 */
import { onBeforeUnmount, onMounted, ref, shallowRef } from 'vue'
import { Scene3DEngine, type CameraPreset, type PickResult, type Pose, type SceneJSON, type PerfStat } from '@/three/engine'
import {
  attachTank, attachPumpjack, attachChristmasTree,
  type TankRuntime, type AttachTankOpts, type AttachPumpjackOpts, type AttachSimpleOpts,
  type PumpjackRuntime,
} from '@/three/assetRuntime'

const props = withDefaults(defineProps<{ scene?: SceneJSON | null; autoStart?: boolean }>(), {
  scene: null,
  autoStart: true,
})

const emit = defineEmits<{
  ready: [{ tier: string; ms: number; triangles: number }]
  pick: [PickResult]
  perf: [PerfStat]
  degraded: [string]
  basis: [{ name: string; basis: string; x: number; y: number } | null]
  /** glb 资产运行层挂载完成（T08，建模专家维护；失败时 payload 里是错误消息） */
  assetsReady: [{ tankId: string; pumpjackId?: string; treeId?: string; count?: number; error?: string }]
}>()

const canvas = ref<HTMLCanvasElement | null>(null)
const engine = shallowRef<Scene3DEngine | null>(null)
const tier = ref<'A' | 'B'>('B')
const fps = ref(0)
const tris = ref(0)
const err = ref('')

/* ---------------------------------------------------------------- 冻结 API */

function init(el: HTMLCanvasElement) {
  const e = new Scene3DEngine()
  const r = e.init(el)
  engine.value = e
  tier.value = r.tier
  e.on('perf', (p) => {
    fps.value = p.fps
    tris.value = p.triangles
    emit('perf', p)
  })
  e.on('pick', (p) => emit('pick', p))
  e.on('degraded', (m) => { err.value = m; emit('degraded', m) })
  e.on('ready', (p) => emit('ready', p))
  return r
}

function setScene(s: SceneJSON) { engine.value?.setScene(s) }
function setLevel(level: 'L0' | 'L1', opts?: { padId?: string; wellIds?: string[] }) {
  engine.value?.setLevel(level, opts)
}
function setCamera(p: CameraPreset | Pose, opts?: { durationMs?: number }) {
  engine.value?.setCamera(p, opts)
}
function setTime(t: number) { return engine.value?.setTime(t) }
function highlight(ids: string[]) { engine.value?.highlight(ids) }
function setSelection(ids: string[]) { engine.value?.setSelection(ids) }
function project(id: string) { return engine.value?.project(id) ?? null }
function focusWell(id: string) { engine.value?.focusWell(id) }
function pick(ev: { clientX: number; clientY: number }) { return engine.value?.pick(ev) }
function resize() { engine.value?.resize() }

function dispose() {
  tank.value?.dispose()
  tank.value = null
  engine.value?.dispose()
  engine.value = null
}

/* ---------------------------------------------------------------- 生命周期 */

let ro: ResizeObserver | null = null

onMounted(() => {
  if (!canvas.value) return
  try {
    init(canvas.value)
    if (props.scene) setScene(props.scene)
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e)
    return
  }
  ro = new ResizeObserver(() => resize())
  ro.observe(canvas.value)
})

onBeforeUnmount(() => {
  ro?.disconnect()
  ro = null
  dispose()
})

function onClick(ev: MouseEvent) {
  const r = pick({ clientX: ev.clientX, clientY: ev.clientY })
  if (r && r.wellId) emit('pick', r)
}

/* T09（E3）：悬停任意几何 → 报 basis（带画布坐标，浮标跟随光标）；移出清空 */
let hoverRaf = 0
function onHover(ev: MouseEvent) {
  if (hoverRaf) return
  hoverRaf = requestAnimationFrame(() => {
    hoverRaf = 0
    const r = engine.value?.basisAt({ clientX: ev.clientX, clientY: ev.clientY }) ?? null
    emit('basis', r ? { ...r, x: ev.clientX, y: ev.clientY } : null)
  })
}
function onLeave() {
  emit('basis', null)
}

/* ------------------------------------------------- 资产运行层（T08，加法扩展）
 * glb 资产 + 液位驱动。数据仍由视图层经 setSiteOil 传入（不读 store）。
 * 失败不静默：emit assetsReady 带 error，液位不动要能被看见。
 */
const tank = shallowRef<TankRuntime | null>(null)
const tankErr = ref('')
const pumpjacks = shallowRef<PumpjackRuntime | null>(null)
const pjErr = ref('')
const treeId = ref('')

async function attachAssets(opts: AttachTankOpts) {
  if (!engine.value) return
  tank.value?.dispose()
  tank.value = null
  tankErr.value = ''
  try {
    tank.value = await attachTank(engine.value, opts)
    emit('assetsReady', { tankId: tank.value.id })
  } catch (e) {
    tankErr.value = e instanceof Error ? e.message : String(e)
    emit('assetsReady', { tankId: '', error: tankErr.value })
  }
}
function setSiteOil(siteOilM3d: number) {
  tank.value?.setSiteOil(siteOilM3d)
}
function assetInfo() {
  return tank.value?.info() ?? null
}

/* D-061②：抽油机 8 台（首台四连杆动画 + 其余实例化） */
async function attachPumpjacks(opts: AttachPumpjackOpts) {
  if (!engine.value) return
  pumpjacks.value?.dispose()
  pumpjacks.value = null
  pjErr.value = ''
  try {
    pumpjacks.value = await attachPumpjack(engine.value, opts)
    emit('assetsReady', { tankId: tank.value?.id ?? '', pumpjackId: pumpjacks.value.id, count: pumpjacks.value.count })
  } catch (e) {
    pjErr.value = e instanceof Error ? e.message : String(e)
    emit('assetsReady', { tankId: tank.value?.id ?? '', error: pjErr.value })
  }
}

/* D-061③：采油树（静态井口装置） */
async function attachTree(opts: AttachSimpleOpts) {
  if (!engine.value) return
  try {
    const t = await attachChristmasTree(engine.value, opts)
    treeId.value = t.id
    emit('assetsReady', { tankId: tank.value?.id ?? '', treeId: t.id })
  } catch (e) {
    emit('assetsReady', { tankId: tank.value?.id ?? '', error: e instanceof Error ? e.message : String(e) })
  }
}

/** 冲次（1/min，1–12）——T08 验收项「冲次可调」的场景侧入口 */
function setStrokeRate(v: number) {
  pumpjacks.value?.rig.setStrokeRate(v)
}

defineExpose({
  init, setScene, setLevel, setCamera, setTime, highlight, setSelection, project, focusWell, pick, resize, dispose,
  getStats: () => ({ fps: fps.value, tris: tris.value, tier: tier.value }),
  attachAssets, setSiteOil, assetInfo, attachPumpjacks, attachTree, setStrokeRate,
})
</script>

<template>
  <div class="scene3d">
    <canvas ref="canvas" class="cv" @click="onClick" @mousemove="onHover" @pointermove="onHover" @pointerleave="onLeave" @mouseleave="onLeave" />
    <div class="hud mono">
      <span :class="['dot', tier === 'A' ? 'a' : 'b']" />
      Tier {{ tier }}
      <span class="sep">·</span>{{ fps }} fps
      <span class="sep">·</span>{{ (tris / 1000).toFixed(0) }}k 三角
      <template v-if="tank">
        <span class="sep">·</span>液位 {{ (tank.info().pct * 100).toFixed(0) }}%
      </template>
    </div>
    <div v-if="tankErr" class="assetWarn mono">{{ tankErr }}</div>
    <div v-if="err" class="warn">{{ err }}</div>
  </div>
</template>

<style scoped>
.scene3d {
  position: relative;
  width: 100%;
  height: 100%;
  min-height: 320px;
  background: #0c1013;
  overflow: hidden;
}
.cv {
  display: block;
  width: 100%;
  height: 100%;
}
.hud {
  position: absolute;
  left: 10px;
  bottom: 8px;
  font-size: 10px;
  color: #8a959b;
  background: rgba(12, 16, 19, 0.72);
  border: 1px solid #232b31;
  border-radius: 3px;
  padding: 3px 7px;
  letter-spacing: 0.02em;
}
.dot {
  display: inline-block;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  margin-right: 5px;
  vertical-align: 1px;
}
.dot.a { background: #4f8a5b; }
.dot.b { background: #b99340; }
.assetWarn {
  position: absolute;
  left: 10px;
  bottom: 34px;
  font-size: 10px;
  color: #d9a06a;
  background: rgba(12, 16, 19, 0.72);
  border: 1px solid #6a4a28;
  border-radius: 3px;
  padding: 2px 7px;
}
.sep { margin: 0 4px; color: #3d474e; }
.warn {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  color: #d9a06a;
  font-size: 12px;
  background: rgba(12, 16, 19, 0.9);
}
</style>
