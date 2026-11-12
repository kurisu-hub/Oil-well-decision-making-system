<script setup lang="ts">
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import type { Well } from '@/types/bundle'
import { useAppStore } from '@/stores/app'
import IllustrativeBadge from './IllustrativeBadge.vue'

// 2.5D 井区：SVG 手绘，不用 Three.js / WebGL（现场显卡与工期风险）
const props = defineProps<{ wells: Well[] }>()
const store = useAppStore()
const router = useRouter()

const stateColor: Record<string, string> = {
  green: 'var(--green)',
  yellow: 'var(--yellow)',
  red: 'var(--red)',
  gray: 'var(--gray)',
}

const W = 620
const H = 320

interface Placed { well: Well; x: number; y: number; r: number; fill: string }

const placed = computed<Placed[]>(() => {
  const list = props.wells
  if (!list.length) return []
  const maxOil = Math.max(...list.map((w) => w.current_oil), 1)
  // 确定性布局：按索引在网格上抖动，保证每次渲染一致
  return list.map((w, i) => {
    const col = i % 4
    const row = Math.floor(i / 4)
    const jitterX = ((i * 37) % 60) - 30
    const jitterY = ((i * 53) % 40) - 20
    const x = 90 + col * 145 + jitterX
    const y = 120 + row * 90 + jitterY
    const r = 8 + (w.current_oil / maxOil) * 16
    const v = w.value_npv ?? 0
    const fill = v > 0 ? `rgba(47,191,113,${Math.min(0.9, 0.25 + v / 160)})` : 'rgba(224,93,93,0.35)'
    return { well: w, x, y, r, fill }
  })
})

function go(w: Well) {
  router.push(`/well/${w.well_id}`)
}
</script>

<template>
  <div>
    <svg :viewBox="`0 0 ${W} ${H}`" class="chart" style="max-height: 320px">
      <defs>
        <linearGradient id="geo" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#3a2f22" />
          <stop offset="100%" stop-color="#241d15" />
        </linearGradient>
      </defs>
      <!-- 2.5D 地台 -->
      <polygon :points="`60,90 ${W - 40},90 ${W - 10},260 30,260`" fill="url(#geo)" stroke="var(--geology)" stroke-opacity=".35" />
      <polygon :points="`60,90 ${W - 40},90 ${W - 40},78 60,78`" fill="var(--geology)" fill-opacity=".18" />
      <text x="70" y="74" fill="var(--geology)" font-size="11">地层剖面示意 · {{ store.wells[0]?.formation ?? '—' }}</text>

      <g v-for="p in placed" :key="p.well.well_id" class="well" @click="go(p.well)">
        <ellipse :cx="p.x" :cy="p.y" :rx="p.r * 1.1" :ry="p.r * 0.45" fill="#000" fill-opacity=".35" />
        <line :x1="p.x" :y1="p.y" :x2="p.x" :y2="p.y - 34" :stroke="stateColor[p.well.state]" stroke-width="2" stroke-opacity=".7" />
        <circle
          :cx="p.x"
          :cy="p.y - 34"
          :r="p.r"
          :fill="p.fill"
          :stroke="stateColor[p.well.state]"
          stroke-width="2.5"
        />
        <text :x="p.x" :y="p.y - 34 + 4" text-anchor="middle" font-size="10" fill="var(--text)">
          {{ p.well.well_id }}
        </text>
        <text :x="p.x" :y="p.y + 18" text-anchor="middle" font-size="10" fill="var(--muted)">
          {{ p.well.current_oil }} {{ store.meta.units.oil }}
        </text>
        <text v-if="store.illustrativeWell(p.well.well_id)" :x="p.x" :y="p.y - 34 - p.r - 6" text-anchor="middle" font-size="9" fill="var(--yellow)">示意</text>
      </g>
      <text v-if="!placed.length" :x="W / 2" :y="H / 2" text-anchor="middle" fill="var(--gray)">暂无</text>
    </svg>
    <div class="row small muted wrap legend">
      <span>点径 = 当前日产</span>
      <span>填充 = 期望 NPV（绿正 / 红负）</span>
      <span>描边 = 决策状态</span>
      <span class="grow"></span>
      <IllustrativeBadge v-if="store.wells.some((w) => store.illustrativeWell(w.well_id))" text="含示意井" />
    </div>
  </div>
</template>

<style scoped>
.well { cursor: pointer; }
.well:hover circle { stroke-width: 3.5; }
.legend { margin-top: 4px; }
</style>
