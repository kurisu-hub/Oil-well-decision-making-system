<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useChart, type ChartOption } from '@/composables/useEcharts'
import { useAppStore } from '@/stores/app'
import type { Well } from '@/types/bundle'

// 价值矩阵：X = 期望 NPV，Y = 置信度 → 四象限
const store = useAppStore()
const router = useRouter()
const el = ref<HTMLElement | null>(null)

const stateColor: Record<string, string> = {
  green: '#2fbf71',
  yellow: '#f2b544',
  red: '#e05d5d',
  gray: '#6b7a90',
}

const list = computed<Well[]>(() => store.filteredWells)

function build(): ChartOption {
  const npvT = store.npvThreshold
  const confT = store.confThreshold
  const items = list.value.map((w) => ({
    value: [w.value_npv ?? 0, w.confidence ?? 0],
    name: w.well_id,
    symbolSize: 10 + ((w.current_oil ?? 0) ** 0.5) * 8,
    itemStyle: { color: stateColor[w.state] ?? '#6b7a90', borderColor: '#0b1220', borderWidth: 1 },
  }))
  const xs = list.value.map((w) => w.value_npv ?? 0)
  const xMin = Math.min(-20, ...xs) - 10
  const xMax = Math.max(20, ...xs) + 10

  return {
    animationDuration: 300,
    grid: { left: 52, right: 18, top: 18, bottom: 40 },
    tooltip: {
      trigger: 'item',
      formatter: (p: { name: string; value: number[] }) => {
        const w = list.value.find((x) => x.well_id === p.name)
        if (!w) return p.name
        return [
          `<b>${w.well_id}</b> ${w.name}`,
          `期望 NPV：${w.value_npv} ${store.meta.units.money}`,
          `置信度：${(w.confidence * 100).toFixed(0)}%`,
          `12 月增油：${w.value_oil} m³`,
          `建议：${w.recommended_action}`,
        ].join('<br/>')
      },
    },
    xAxis: {
      type: 'value',
      name: `期望 NPV（${store.meta.units.money}）`,
      nameLocation: 'middle',
      nameGap: 24,
      min: xMin,
      max: xMax,
      splitLine: { lineStyle: { color: '#22304d' } },
      axisLine: { lineStyle: { color: '#8fa3bf' } },
    },
    yAxis: {
      type: 'value',
      name: '置信度',
      min: 0,
      max: 1,
      splitLine: { lineStyle: { color: '#22304d' } },
      axisLine: { lineStyle: { color: '#8fa3bf' } },
      axisLabel: { formatter: (v: number) => (v * 100).toFixed(0) + '%' },
    },
    series: [
      {
        type: 'scatter',
        data: items,
        markLine: {
          silent: true,
          symbol: 'none',
          lineStyle: { color: '#8fa3bf', type: 'dashed', opacity: 0.7 },
          label: { show: false },
          data: [{ xAxis: npvT }, { yAxis: confT }],
        },
        markArea: {
          silent: true,
          itemStyle: { color: 'rgba(107,122,144,0.10)' },
          label: {
            show: true,
            position: 'insideTop',
            color: '#8fa3bf',
            fontSize: 11,
            formatter: '低价值 · 低置信',
          },
          data: [[{ xAxis: xMin, yAxis: 0 }, { xAxis: npvT, yAxis: confT }]],
        },
      },
    ],
  }
}

const { chart } = useChart(el, build, [list, () => store.npvThreshold, () => store.confThreshold])

onMounted(() => {
  chart.value?.on('click', (p: { name?: string }) => {
    if (p?.name) router.push(`/well/${p.name}`)
  })
})
</script>

<template>
  <div>
    <div ref="el" class="chart" style="height: 320px"></div>
    <div class="row small muted wrap">
      <span class="badge badge-green">可判定</span>
      <span class="badge badge-yellow">数据不足</span>
      <span class="badge badge-red">不建议</span>
      <span class="badge badge-gray">低价值低置信</span>
      <span class="grow"></span>
      <span>点任意井 → 决策卡</span>
    </div>
  </div>
</template>
