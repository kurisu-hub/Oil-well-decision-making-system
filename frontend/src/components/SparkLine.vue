<script setup lang="ts">
import { computed } from 'vue'
import type { Point } from '@/types/bundle'

// 相似井小曲线：手写 SVG polyline，不建 ECharts 实例（性能决策）
const props = withDefaults(defineProps<{ points: Point[]; width?: number; height?: number; color?: string }>(), {
  width: 120,
  height: 40,
  color: '#5aa9e6',
})

const path = computed(() => {
  const pts = props.points ?? []
  if (!pts.length) return ''
  const vals = pts.map((p) => p.oil)
  const max = Math.max(...vals)
  const min = Math.min(...vals)
  const span = max - min || 1
  const pad = 2
  const w = props.width - pad * 2
  const h = props.height - pad * 2
  return pts
    .map((p, i) => {
      const x = pad + (pts.length === 1 ? w / 2 : (i / (pts.length - 1)) * w)
      const y = pad + h - ((p.oil - min) / span) * h
      return `${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')
})
</script>

<template>
  <svg :width="width" :height="height" :viewBox="`0 0 ${width} ${height}`" class="spark">
    <polyline :points="path" fill="none" :stroke="color" stroke-width="1.5" stroke-linejoin="round" />
  </svg>
</template>

<style scoped>
.spark { display: block; }
</style>
