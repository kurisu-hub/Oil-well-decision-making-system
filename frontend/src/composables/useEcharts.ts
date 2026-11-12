import * as echarts from 'echarts/core'
// 按需引入：控制单文件体积，不要 import 全量 echarts
import { BarChart, LineChart, ScatterChart } from 'echarts/charts'
import {
  GraphicComponent,
  GridComponent,
  LegendComponent,
  MarkAreaComponent,
  MarkLineComponent,
  TooltipComponent,
} from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'
import { onBeforeUnmount, onMounted, shallowRef, watch, type Ref } from 'vue'

echarts.use([
  LineChart,
  ScatterChart,
  BarChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  MarkLineComponent,
  MarkAreaComponent,
  GraphicComponent,
  CanvasRenderer,
])

export type ChartOption = Parameters<ReturnType<typeof echarts.init>['setOption']>[0]

/**
 * 建一个 ECharts 实例：卸载即 dispose，resize 走 ResizeObserver + 防抖。
 * 全站实例数刻意压到 ≤4，保证“点井 1 秒内出卡”。
 */
export function useChart(
  el: Ref<HTMLElement | null>,
  build: () => ChartOption,
  watchSources: unknown[] = [],
) {
  const chart = shallowRef<echarts.ECharts | null>(null)
  let ro: ResizeObserver | null = null
  let timer: number | undefined

  const render = () => {
    if (!chart.value) return
    chart.value.setOption(build(), true)
  }

  const onResize = () => {
    window.clearTimeout(timer)
    timer = window.setTimeout(() => chart.value?.resize(), 100)
  }

  onMounted(() => {
    if (!el.value) return
    chart.value = echarts.init(el.value, undefined, { renderer: 'canvas' })
    render()
    ro = new ResizeObserver(onResize)
    ro.observe(el.value)
  })

  if (watchSources.length) {
    watch(watchSources, render, { deep: true })
  }

  onBeforeUnmount(() => {
    window.clearTimeout(timer)
    ro?.disconnect()
    ro = null
    chart.value?.dispose()
    chart.value = null
  })

  return { chart, render }
}

export { echarts }
