<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { init, use, type ECharts } from 'echarts/core'
import { LineChart } from 'echarts/charts'
import { GridComponent, TooltipComponent } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'
import { duration, samples, timeAt, type Metric } from './replay'

use([LineChart, GridComponent, TooltipComponent, CanvasRenderer])
const props = defineProps<{ minute: number; metric: Metric }>()
const host = ref<HTMLDivElement>()
let chart: ECharts | undefined
let observer: ResizeObserver | undefined

/** 图表只读到游标为止，保留缺测断点，避免把通信中断画成连续曲线。 */
function render() {
  const { minute, metric } = props
  const start = Math.max(0, minute - 20)
  const end = Math.min(duration, start + 20)
  chart?.setOption({
    animation: false,
    grid: { left: 48, right: 22, top: 14, bottom: 28 },
    tooltip: { trigger: 'axis', valueFormatter: (value: unknown) => value == null ? '无采样' : `${value} ${metric.unit}` },
    xAxis: {
      type: 'category',
      boundaryGap: false,
      data: Array.from({ length: end - start + 1 }, (_, i) => timeAt(start + i)),
      axisLabel: { interval: 4, color: '#53647a', fontSize: 11 },
      axisLine: { lineStyle: { color: '#dce5ec' } },
      axisTick: { show: false },
    },
    yAxis: {
      type: 'value',
      min: 0,
      splitNumber: 4,
      axisLabel: { color: '#53647a', fontSize: 11 },
      splitLine: { lineStyle: { color: '#e8eef3', type: 'dashed' } },
    },
    series: [{
      name: metric.name,
      type: 'line',
      showSymbol: minute === start,
      symbolSize: 6,
      connectNulls: false,
      data: samples.slice(start, minute + 1).map(sample => sample[metric.key]),
      lineStyle: { color: metric.color, width: 2.5 },
      itemStyle: { color: metric.color },
      areaStyle: { color: metric.color, opacity: 0.09 },
    }],
  }, { notMerge: true })
}

onMounted(() => {
  if (!host.value) return
  chart = init(host.value)
  observer = new ResizeObserver(() => chart?.resize())
  observer.observe(host.value)
  render()
})
watch(() => [props.minute, props.metric], render)
onBeforeUnmount(() => {
  observer?.disconnect()
  chart?.dispose()
})
</script>

<template>
  <div ref="host" class="trend-chart" role="img" :aria-label="`${metric.name}最近 20 分钟的模拟趋势，单位 ${metric.unit}`" />
</template>
