<script setup lang="ts">
import { computed, ref } from 'vue'
import type { Well } from '@/types/bundle'
import { useAppStore } from '@/stores/app'

/**
 * 英雄场景 · 2.5D 地质剖面 + 井区（纯 SVG，无 Three.js / WebGL）
 *
 * 数据来源口径（不编造）：
 *  - 井点颜色 = wells[].value_npv（期望 NPV，bundle 原值 / 按工况折算）
 *  - 井点描边 = wells[].state（决策状态）
 *  - 井点半径 = wells[].current_oil（当前日产）
 *  - 响应环   = 截至游标月的累计增量 Σ(prediction − baseline)（读 curves 求和，与世界线同一口径）
 *  - 裂缝翼   = 随时间轴游标延伸的几何示意（M0 近射孔点 → M12 满缝长）
 *  - 射孔/裂缝/管网/平面位置为**工程示意骨架**，bundle 未提供井位坐标与缝长，界面已打角标
 */
const props = defineProps<{ wells: Well[] }>()
const store = useAppStore()

const W = 980
const H = 630

// —— 2.5D 体块（等轴测切块：顶面 + 正面剖面 + 右侧面）——
const A = { x: 140, y: 74 }
const B = { x: 760, y: 74 }
const C = { x: 860, y: 154 }
const D = { x: 240, y: 154 }
const FB = 604 // 正面底
const topFace = `${A.x},${A.y} ${B.x},${B.y} ${C.x},${C.y} ${D.x},${D.y}`
const frontFace = `${D.x},${D.y} ${C.x},${C.y} ${C.x},${FB} ${D.x},${FB}`
const rightFace = `${B.x},${B.y} ${C.x},${C.y} ${C.x},${FB} ${B.x},${B.y + (FB - C.y)}`

/** 顶面参数化：p(u,v) = A + u·(B−A) + v·(D−A) */
function onTop(u: number, v: number) {
  return { x: A.x + (B.x - A.x) * u + (D.x - A.x) * v, y: A.y + (D.y - A.y) * v }
}

// —— 地层（正面剖面）：仅作示意骨架，层位名取 bundle formation，空则暂无 ——
const bands = [
  { f0: 0.0, f1: 0.24, no: '①', name: '上覆层', fill: '#1e2428', pat: 'url(#pat-ln)' },
  { f0: 0.24, f1: 0.46, no: '②', name: '盖层', fill: '#26221d', pat: 'url(#pat-dot)' },
  { f0: 0.46, f1: 0.76, no: '③', name: '目的层', fill: '#2d2519', pat: 'url(#pat-sand)' },
  { f0: 0.76, f1: 1.0, no: '④', name: '底界', fill: '#171b1e', pat: 'url(#pat-ln2)' },
]
const y0 = D.y
const yH = FB - D.y
const bandRect = (b: (typeof bands)[number]) => ({
  y: y0 + yH * b.f0,
  h: yH * (b.f1 - b.f0),
})
const PERF_Y = Math.round(y0 + yH * 0.61) // 射孔/裂缝所在深度（目的层中部）
// C1：无层位数据时必须「整层隐藏 + 显示暂无层位」，不许靠画。
// 当前 geo.strata 为空（公开数据不含本井层位），所以默认关闭示意骨架；
// 允许手动打开，但打开后角标常驻「示意 · 无实测层位」。
const showStrataSkeleton = ref(false)
const formationName = computed(() => {
  const f = props.wells.find((w) => w.formation)?.formation ?? ''
  return f || '暂无'
})

// —— 集输干线（顶面内，v 恒定 → 与前沿平行）——
const TRUNK_V = 0.72
const trunkP1 = onTop(0.03, TRUNK_V)
const trunkP2 = onTop(0.97, TRUNK_V)
const TRUNK_Y = Math.round(trunkP1.y)
const PLANT = { x: 902, y: 150 }

// —— 时间轴联动 ——
const MONTH_MAX = 12
const month = computed(() => Math.max(0, Math.min(MONTH_MAX, Math.round(store.timelineMonth))))
const progress = computed(() => month.value / MONTH_MAX)
/** 裂缝翼随游标延伸的几何比例（M0 起裂 → M12 满缝长） */
const fracScale = computed(() => (0.14 + 0.86 * progress.value).toFixed(3))

/**
 * 每井截至各月的累计增量 Σ(pred − base)：与世界线同一口径（读曲线求和）。
 * 中途缺数据即置 null，后续月份不再外推。
 */
const deltaIndex = computed(() => {
  const out = new Map<string, (number | null)[]>()
  for (const c of store.curves ?? []) {
    const pred = (c.prediction ?? []).slice(0, MONTH_MAX)
    const base = (c.baseline ?? []).slice(0, MONTH_MAX)
    const len = Math.max(pred.length, base.length)
    const acc: (number | null)[] = [0]
    let s = 0
    let ok = true
    for (let i = 0; i < len; i++) {
      const p = pred[i]
      const b = base[i]
      if (ok && p && Number.isFinite(p.oil) && b && Number.isFinite(b.oil)) {
        s += p.oil - b.oil
        acc.push(s)
      } else {
        ok = false
        acc.push(null)
      }
    }
    out.set(c.well_id, acc)
  }
  return out
})

// —— 井点布局：顶面上确定性网格（按传入顺序铺，保证每次渲染一致）——
interface Node {
  well: Well
  x: number
  y: number
  r: number
  fill: string
  stroke: string
  selected: boolean
  focused: boolean
  dim: boolean
  resp: number | null // 截至游标月累计增量（原始值，null=暂无）
  ring: number | null // 响应环半径（null=不画）
  ringStroke: string
}
const nodes = computed<Node[]>(() => {
  const list = props.wells
  if (!list.length) return []
  const n = list.length
  const cols = Math.max(1, Math.ceil(Math.sqrt(n * 7.6)))
  const rows = Math.max(1, Math.ceil(n / cols))
  const maxOil = Math.max(...list.map((w) => Math.abs(w.current_oil ?? 0)), 1)
  const maxAbsNpv = Math.max(
    ...list.map((w) => Math.abs(typeof w.value_npv === 'number' ? w.value_npv : 0)),
    1,
  )
  const sel = new Set(store.selectedWellIds)
  const hasSel = sel.size > 0
  const mi = month.value
  const raw = new Map<string, number | null>()
  let maxAbs = 1e-9
  for (const w of list) {
    const acc = deltaIndex.value.get(w.well_id)
    const v = acc && acc.length > mi ? acc[mi] : null
    raw.set(w.well_id, v ?? null)
    if (typeof v === 'number') maxAbs = Math.max(maxAbs, Math.abs(v))
  }
  return list.map((w, i) => {
    const col = i % cols
    const row = Math.floor(i / cols)
    const u = cols === 1 ? 0.5 : 0.04 + (col / (cols - 1)) * 0.92
    const v = rows === 1 ? 0.5 : 0.08 + (row / (rows - 1)) * 0.72
    const p = onTop(u, v)
    const r = 2.6 + (Math.abs(w.current_oil ?? 0) / maxOil) * 3.4
    // 填充色 = 当前口径下的 NPV（bundle 原值 / 按控制轨工况折算）
    const npv = store.npvAt(w)
    const t = npv === null ? 0.35 : Math.min(1, Math.abs(npv) / maxAbsNpv)
    const fill =
      npv === null
        ? 'rgba(107,118,128,0.55)'
        : npv > 0
          ? `rgba(95,158,120,${(0.3 + 0.65 * t).toFixed(3)})`
          : `rgba(193,80,58,${(0.3 + 0.65 * t).toFixed(3)})`
    const rv = raw.get(w.well_id) ?? null
    const mag = typeof rv === 'number' ? Math.abs(rv) / maxAbs : 0
    const ring = typeof rv === 'number' && mag > 0.03 ? r + 2.5 + 6.5 * Math.min(1, mag) : null
    return {
      well: w,
      x: Math.round(p.x * 10) / 10,
      y: Math.round(p.y * 10) / 10,
      r: Math.round(r * 10) / 10,
      fill,
      stroke: stateStroke(w.state),
      selected: sel.has(w.well_id),
      focused: w.well_id === store.focusWellId,
      dim: hasSel && !sel.has(w.well_id) && w.well_id !== store.focusWellId,
      resp: rv,
      ring: ring === null ? null : Math.round(ring * 10) / 10,
      ringStroke: rv !== null && rv < 0 ? '#c1503a' : '#5f9e78',
    }
  })
})

function stateStroke(s: string): string {
  return s === 'green'
    ? '#5f9e78'
    : s === 'yellow'
      ? '#c9a13a'
      : s === 'red'
        ? '#c1503a'
        : '#6b7680'
}

/** 裂缝翼：以射孔点为中心的对称透镜体（仅方案井组 + 焦点井绘制） */
function fracPath(x: number, y: number, half: number) {
  const h = Math.max(4, half * 0.32)
  return `M ${x - half} ${y} C ${x - half * 0.5} ${y - h} ${x + half * 0.5} ${y - h} ${x + half} ${y} C ${x + half * 0.5} ${y + h} ${x - half * 0.5} ${y + h} ${x - half} ${y} Z`
}

const fracNodes = computed(() =>
  nodes.value.filter((nd) => nd.selected || nd.focused),
)

// —— 左侧「措施推进」标尺（M0 → M12）——
const RULER_X = 112
const RULER_T = 92
const RULER_B = 590
const rulerY = (m: number) => RULER_T + ((RULER_B - RULER_T) * m) / MONTH_MAX
const cursorY = computed(() => rulerY(month.value))
const rulerTicks = [0, 3, 6, 9, 12]

const respStat = computed(() => {
  let pos = 0
  let neg = 0
  let na = 0
  for (const nd of nodes.value) {
    if (nd.resp === null) na += 1
    else if (nd.resp > 0) pos += 1
    else if (nd.resp < 0) neg += 1
  }
  return { pos, neg, na }
})

const legend = [
  ['填充', `NPV（${store.npvMode === 'adj' ? '折算' : 'bundle 原值'}，+青绿 / −氧化铁红）`],
  ['描边', '决策状态（绿/黄/红/灰）'],
  ['点径', `当前日产 ${store.meta.units.oil}`],
  ['外环', '截至游标月累计增量（+绿 / −红）'],
  ['淡化', '不在当前方案井组内'],
  ['相对深度（示意）', '纵轴无量纲 0–1，非真实垂深'],
]
const npvModeLabel = computed(() => (store.npvMode === 'adj' ? '折算口径' : 'bundle 原值'))

function pick(nd: Node) {
  store.setFocus(nd.well.well_id)
}
</script>

<template>
  <div class="scene paper">
    <svg :viewBox="`0 0 ${W} ${H}`" class="chart" role="img" aria-label="2.5D 地质剖面与井区">
      <defs>
        <pattern id="pat-ln" width="10" height="10" patternUnits="userSpaceOnUse" patternTransform="rotate(35)">
          <line x1="0" y1="0" x2="0" y2="10" stroke="#3a444b" stroke-width="1" />
        </pattern>
        <pattern id="pat-ln2" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(-45)">
          <line x1="0" y1="0" x2="0" y2="7" stroke="#2f383e" stroke-width="1" />
        </pattern>
        <pattern id="pat-dot" width="9" height="9" patternUnits="userSpaceOnUse">
          <circle cx="2" cy="2" r="1" fill="#4a4238" />
          <circle cx="6.5" cy="6.5" r="1" fill="#4a4238" />
        </pattern>
        <pattern id="pat-sand" width="12" height="12" patternUnits="userSpaceOnUse">
          <path d="M0 9 L4 3 L8 9 L12 3" fill="none" stroke="#8a6f4a" stroke-width="1" />
        </pattern>
        <linearGradient id="topG" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#242b30" />
          <stop offset="100%" stop-color="#1b2126" />
        </linearGradient>
      </defs>

      <!-- ===== 体块 ===== -->
      <polygon :points="topFace" fill="url(#topG)" stroke="#3d474e" stroke-width="1" />
      <polygon :points="frontFace" fill="#14181b" stroke="#3d474e" stroke-width="1" />
      <polygon :points="rightFace" fill="#0f1214" stroke="#3d474e" stroke-width="1" />

      <!-- ===== 地层 ===== -->
      <g v-if="showStrataSkeleton">
        <rect
          v-for="b in bands"
          :key="b.no"
          x="240"
          :y="bandRect(b).y"
          width="620"
          :height="bandRect(b).h"
          :fill="b.fill"
        />
        <rect
          v-for="b in bands"
          :key="b.no + 'p'"
          x="240"
          :y="bandRect(b).y"
          width="620"
          :height="bandRect(b).h"
          :fill="b.pat"
          opacity="0.5"
        />
        <line
          v-for="b in bands"
          :key="b.no + 'l'"
          x1="240"
          :y1="bandRect(b).y"
          x2="860"
          :y2="bandRect(b).y"
          stroke="#3d474e"
          stroke-width="1"
        />
        <g v-for="b in bands" :key="b.no + 't'">
          <text
            x="250"
            :y="bandRect(b).y + 14"
            fill="#c9a97e"
            font-size="11"
            font-family="ui-monospace, Consolas, monospace"
          >{{ b.no }} {{ b.name }}</text>
        </g>
        <!-- 相对深度轴（示意，无量纲） -->
        <g font-family="ui-monospace, Consolas, monospace" font-size="9" fill="#69747a">
          <line x1="228" :y1="D.y" x2="228" :y2="FB" stroke="#2c3339" stroke-width="1" />
          <g v-for="b in [...bands.map((x) => x.f0), 1]" :key="'d' + b">
            <line x1="222" :y1="y0 + yH * b" x2="228" :y2="y0 + yH * b" stroke="#3d474e" />
            <text x="219" :y="y0 + yH * b + 3" text-anchor="end">{{ b.toFixed(2) }}</text>
          </g>
          <!-- 轴名不画在 SVG 里：竖排会与 0.46 / 0.76 等刻度值压字（实测 5×5px），
               改由下方图例承载「相对深度（示意）」，信息不丢。 -->
        </g>
        <!-- 射孔段基准线 -->
        <line
          x1="240"
          :y1="PERF_Y"
          x2="860"
          :y2="PERF_Y"
          stroke="#c9a97e"
          stroke-width="0.8"
          stroke-dasharray="2 4"
          stroke-opacity="0.5"
        />
        <text x="244" :y="PERF_Y - 4" font-size="9" fill="#c9a97e" font-family="ui-monospace, Consolas, monospace">
          射孔段基准（示意）
        </text>
        <text x="250" :y="FB - 12" font-size="10" fill="#69747a" font-family="ui-monospace, Consolas, monospace">
          层位名 FORMATION：{{ formationName }}
        </text>
        <g style="cursor: pointer" @click="showStrataSkeleton = false">
          <rect x="770" :y="y0 + 6" width="86" height="17" rx="3"
                fill="#2a3140" fill-opacity="0.9" stroke="#c0764a" stroke-width="0.8" />
          <text x="813" :y="y0 + 18" text-anchor="middle" font-size="9.5"
                fill="#d9a06a" font-family="ui-monospace, Consolas, monospace">
            示意 · 无实测层位
          </text>
        </g>
      </g>

      <!-- ===== 无层位数据时的占位（C1：整层隐藏 + 明示暂无）===== -->
      <g v-else>
        <rect
          x="240" :y="y0" width="620" :height="yH"
          fill="none" stroke="#3d474e" stroke-width="1" stroke-dasharray="4 6"
          stroke-opacity="0.55"
        />
        <text
          x="550" :y="y0 + yH / 2 - 8" text-anchor="middle"
          font-size="13" fill="#8a959b" font-family="ui-monospace, Consolas, monospace"
        >暂无层位</text>
        <text
          x="550" :y="y0 + yH / 2 + 12" text-anchor="middle"
          font-size="10" fill="#5f6a70" font-family="ui-monospace, Consolas, monospace"
        >公开数据不含本井层位顶底，不绘制地层</text>
        <g
          style="cursor: pointer"
          @click="showStrataSkeleton = true"
        >
          <rect
            x="500" :y="y0 + yH / 2 + 26" width="100" height="18" rx="3"
            fill="none" stroke="#4a565d" stroke-width="1"
          />
          <text
            x="550" :y="y0 + yH / 2 + 39" text-anchor="middle"
            font-size="10" fill="#8a959b" font-family="ui-monospace, Consolas, monospace"
          >查看示意骨架</text>
        </g>
      </g>

      <!-- ===== 集输管网（示意）===== -->
      <g>
        <line
          :x1="trunkP1.x"
          :y1="TRUNK_Y"
          :x2="trunkP2.x"
          :y2="TRUNK_Y"
          stroke="#4d6474"
          stroke-width="2"
        />
        <line
          :x1="trunkP2.x"
          :y1="TRUNK_Y"
          :x2="PLANT.x"
          :y2="PLANT.y"
          stroke="#4d6474"
          stroke-width="2"
        />
        <!-- 干线流向（示意，措施推进后才有流量） -->
        <line
          class="flow"
          :x1="trunkP1.x"
          :y1="TRUNK_Y"
          :x2="trunkP2.x"
          :y2="TRUNK_Y"
          stroke="#7f9db1"
          stroke-width="2"
          :stroke-opacity="progress > 0 ? 0.85 : 0"
        />
        <rect
          :x="PLANT.x - 7"
          :y="PLANT.y - 7"
          width="14"
          height="14"
          fill="none"
          stroke="#7f9db1"
          stroke-width="1.5"
        />
        <line
          :x1="PLANT.x - 4"
          :y1="PLANT.y - 4"
          :x2="PLANT.x + 4"
          :y2="PLANT.y + 4"
          stroke="#7f9db1"
          stroke-width="1"
        />
        <text :x="PLANT.x - 4" :y="PLANT.y + 22" font-size="9" fill="#7f9db1" font-family="ui-monospace, Consolas, monospace">
          集输站
        </text>
        <!-- 支线：井口 → 干线 -->
        <line
          v-for="nd in nodes"
          :key="'br' + nd.well.well_id"
          class="wb"
          :x1="nd.x"
          :y1="nd.y"
          :x2="nd.x"
          :y2="TRUNK_Y"
          stroke="#4d6474"
          stroke-width="0.6"
          :stroke-opacity="nd.dim ? 0.18 : 0.55"
        />
      </g>

      <!-- ===== 井筒（顶面井口 → 射孔深度）===== -->
      <g>
        <line
          v-for="nd in nodes"
          :key="'wb' + nd.well.well_id"
          class="wb"
          :x1="nd.x"
          :y1="nd.y"
          :x2="nd.x"
          :y2="PERF_Y"
          :stroke="nd.stroke"
          stroke-width="0.9"
          :stroke-opacity="nd.dim ? 0.18 : 0.55"
        />
      </g>

      <!-- ===== 射孔簇（目的层中部）===== -->
      <g stroke="#c9a97e" stroke-width="1.2" stroke-opacity="0.85">
        <g v-for="nd in nodes" :key="'pf' + nd.well.well_id" class="wb" :stroke-opacity="nd.dim ? 0.24 : 0.85">
          <line :x1="nd.x - 4" :y1="PERF_Y - 3" :x2="nd.x + 4" :y2="PERF_Y - 3" />
          <line :x1="nd.x - 4" :y1="PERF_Y + 3" :x2="nd.x + 4" :y2="PERF_Y + 3" />
        </g>
      </g>

      <!-- ===== 裂缝翼（方案井组 + 焦点井）：随游标延伸 ===== -->
      <g>
        <path
          v-for="nd in fracNodes"
          :key="'fr' + nd.well.well_id"
          class="frac"
          :d="fracPath(nd.x, PERF_Y, nd.selected ? 26 : 18)"
          :style="{ transform: `scale(${fracScale})` }"
          fill="rgba(180,85,45,0.28)"
          stroke="#d0764a"
          stroke-width="1.2"
        />
      </g>

      <!-- ===== 累计增量响应环 ===== -->
      <g>
        <circle
          v-for="nd in nodes.filter((x) => x.ring !== null)"
          :key="'rs' + nd.well.well_id"
          class="ring"
          :cx="nd.x"
          :cy="nd.y"
          :r="nd.ring as number"
          fill="none"
          :stroke="nd.ringStroke"
          stroke-width="0.9"
          :stroke-opacity="nd.dim ? 0.22 : 0.6"
        />
      </g>

      <!-- ===== 井口点 ===== -->
      <g>
        <g
          v-for="nd in nodes"
          :key="'wh' + nd.well.well_id"
          class="wellnode"
          :opacity="nd.dim ? 0.34 : 1"
          @click="pick(nd)"
        >
          <circle
            :cx="nd.x"
            :cy="nd.y"
            :r="nd.r"
            :fill="nd.fill"
            :stroke="nd.stroke"
            :stroke-width="nd.focused ? 2.4 : 1.2"
          />
          <circle
            v-if="nd.focused"
            class="focus-ring"
            :cx="nd.x"
            :cy="nd.y"
            :r="nd.r + 5"
            fill="none"
            :stroke="nd.stroke"
            stroke-width="1"
            stroke-dasharray="3 3"
          />
          <text
            v-if="nd.selected || nd.focused"
            :x="nd.x"
            :y="nd.y - nd.r - 4"
            text-anchor="middle"
            font-size="9"
            font-family="ui-monospace, Consolas, monospace"
            :fill="nd.stroke"
          >{{ nd.well.well_id }}</text>
          <title>
            {{ nd.well.well_id }} · {{ nd.well.name }}｜NPV
            {{ nd.well.value_npv ?? '暂无' }} {{ store.meta.units.money }}｜日产
            {{ nd.well.current_oil }} {{ store.meta.units.oil }}｜状态 {{ nd.well.state }}｜截至
            M{{ month }} 累计增量 {{ nd.resp === null ? '暂无' : nd.resp.toFixed(1) }}
          </title>
        </g>
      </g>

      <!-- ===== 左侧：措施推进标尺 M0 → M12 ===== -->
      <g font-family="ui-monospace, Consolas, monospace" font-size="9">
        <line :x1="RULER_X" :y1="RULER_T" :x2="RULER_X" :y2="RULER_B" stroke="#2c3339" stroke-width="3" />
        <line
          :x1="RULER_X"
          :y1="RULER_T"
          :x2="RULER_X"
          :y2="cursorY"
          stroke="#7f9db1"
          stroke-width="3"
          class="ruler-fill"
        />
        <g fill="#69747a">
          <g v-for="t in rulerTicks" :key="'rt' + t">
            <line :x1="RULER_X - 5" :y1="rulerY(t)" :x2="RULER_X + 5" :y2="rulerY(t)" stroke="#3d474e" />
            <text :x="RULER_X - 8" :y="rulerY(t) + 3" text-anchor="end">M{{ t }}</text>
          </g>
        </g>
        <path
          :d="`M ${RULER_X + 4} ${cursorY} l 7 -4 l 0 8 Z`"
          fill="#c9a97e"
        />
        <text :x="RULER_X + 13" :y="cursorY + 3" fill="#c9a97e" font-size="10">T+{{ month }} 月</text>
        <!-- 轴名左移到 RULER_X-34：竖排文字与 M0/M3/M6… 刻度值会压字（实测 2×5px） -->
        <text
          :x="RULER_X - 34"
          :y="(RULER_T + RULER_B) / 2"
          text-anchor="middle"
          :transform="`rotate(-90 ${RULER_X - 34} ${(RULER_T + RULER_B) / 2})`"
          fill="#69747a"
        >
          措施推进
        </text>
      </g>

      <!-- ===== 图廓注记 ===== -->
      <g font-family="ui-monospace, Consolas, monospace" font-size="9" fill="#69747a">
        <text x="140" :y="A.y - 12">SHEET 1 · 井区平面（顶面）</text>
        <text x="240" :y="FB + 12">SCALE 示意（bundle 未含井位坐标 / 缝长）</text>
        <!-- 指北 -->
        <g transform="translate(928 58)">
          <line x1="0" y1="10" x2="0" y2="-10" stroke="#7f9db1" stroke-width="1" />
          <path d="M0 -14 L3.5 -6 L-3.5 -6 Z" fill="#7f9db1" />
          <text x="0" y="22" text-anchor="middle" fill="#7f9db1">N</text>
        </g>
      </g>

      <text
        v-if="!nodes.length"
        :x="W / 2"
        :y="H / 2"
        text-anchor="middle"
        fill="#6b7680"
        font-size="13"
      >暂无（当前筛选下无井，不编造）</text>
    </svg>

    <!-- 图例 -->
    <div class="row legend">
      <span v-for="l in legend" :key="l[0]" class="small dim">
        <b style="color: #8a959b; font-weight: 600">{{ l[0] }}</b> = {{ l[1] }}
      </span>
      <span class="grow"></span>
      <span class="stamp stamp-illus">几何示意</span>
      <span class="stamp" :class="store.npvMode === 'adj' ? 'stamp-assump' : 'stamp-live'">{{ npvModeLabel }}</span>
      <span class="stamp">M{{ month }}</span>
      <span class="stamp">Δ+ {{ respStat.pos }} / Δ− {{ respStat.neg }}</span>
      <span class="stamp">N={{ nodes.length }}</span>
    </div>
  </div>
</template>

<style scoped>
.scene {
  border: 1px solid #2c3339;
  background: var(--bg-2);
  flex: 1 1 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
/* 宽高同设 → viewBox 内容按 preserveAspectRatio=meet 在盒内 letterbox，场景恒填充给定高度。
   min-height 保底：1366 这类窄栏下图例若换行会把 svg 挤到 0 高，主场景不能消失。 */
svg { display: block; flex: 1 1 0; min-height: 120px; height: 100%; width: 100%; }
.wellnode { cursor: pointer; }
.wellnode:hover circle:first-child { stroke-width: 2.6; }
.legend {
  border-top: 1px solid #2c3339;
  padding: 4px 8px;
  gap: 10px;
  /* 单行横向滚动：窄栏下不再换行，避免吃掉场景高度 */
  flex-wrap: nowrap;
  overflow-x: auto;
  overflow-y: hidden;
  flex: none;
  background: var(--panel);
}
.legend .small { white-space: nowrap; }

/* —— 动效：井点 / 井筒 / 支线随状态与口径平滑过渡 —— */
.wellnode circle { transition: fill .35s ease, stroke .35s ease, stroke-width .2s ease; }
.wellnode { transition: opacity .35s ease; }
.wb { transition: stroke-opacity .35s ease, stroke .35s ease; }
.ring { transition: r .45s cubic-bezier(.2,.8,.2,1), stroke-opacity .35s ease; }

/* —— 动效：裂缝翼随游标生长（以射孔点为原点等比放大）—— */
.frac {
  transform-box: fill-box;
  transform-origin: center;
  transition: transform .5s cubic-bezier(.2,.8,.2,1);
}

/* —— 动效：干线流向（示意流量）—— */
.flow {
  stroke-dasharray: 5 9;
  transition: stroke-opacity .4s ease;
  animation: flow 1.6s linear infinite;
}
@keyframes flow { to { stroke-dashoffset: -28; } }

/* —— 动效：推进标尺填充 —— */
.ruler-fill { transition: y2 .45s cubic-bezier(.2,.8,.2,1); }

/* —— 动效：焦点井扫描环 —— */
.focus-ring { animation: sweep 3.2s linear infinite; }
@keyframes sweep { to { stroke-dashoffset: -24; } }

@media (prefers-reduced-motion: reduce) {
  .flow, .focus-ring { animation: none; }
  .frac, .ring, .ruler-fill { transition: none; }
}
</style>
