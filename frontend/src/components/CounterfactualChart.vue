<script setup lang="ts">
import { computed, ref } from 'vue'
import { useChart, type ChartOption } from '@/composables/useEcharts'
import type { Curve } from '@/types/bundle'
import EmptyValue from './EmptyValue.vue'

// 反事实三条世界线：历史 / 基线（不压）/ 预测（压，带 90% 区间）+ 保本线 + 滞后标注
const props = defineProps<{ curve: Curve | null; unit: string }>()
const el = ref<HTMLElement | null>(null)

const months = computed(() => {
  const c = props.curve
  if (!c) return [] as string[]
  const set = new Set<string>()
  for (const p of c.history ?? []) set.add(p.month)
  for (const p of c.baseline ?? []) set.add(p.month)
  for (const p of c.prediction ?? []) set.add(p.month)
  return [...set].sort()
})

/** 单边区间：优先听 bundle 的 interval_kind（final77 起自带），本地检测兜底 */
const oneSided = computed(() => {
  const c = props.curve
  if (!c) return false
  if (c.interval_kind === 'one_sided_lower_clipped_at_zero') return true
  const los = (c.prediction ?? []).map((p) => p.lo).filter((x): x is number => typeof x === 'number')
  return los.length > 0 && los.every((x) => x <= 0)
})

function build(): ChartOption {
  const c = props.curve
  if (!c) return {}
  const axis = months.value
  const at = (arr: { month: string; oil: number }[] | undefined, m: string) =>
    arr?.find((p) => p.month === m)?.oil ?? null
  const loAt = (m: string) => c.prediction?.find((p) => p.month === m)?.lo ?? null
  const hiAt = (m: string) => c.prediction?.find((p) => p.month === m)?.hi ?? null

  const history = axis.map((m) => at(c.history, m))
  const baseline = axis.map((m) => at(c.baseline, m))
  const pred = axis.map((m) => at(c.prediction, m))
  const lo = axis.map(loAt)
  const band = axis.map((m) => {
    const l = loAt(m)
    const h = hiAt(m)
    return l === null || h === null ? null : h - l
  })

  const ev = c.event_month ?? null
  const lagIdx = axis.indexOf(ev ?? '')
  const lagEnd =
    lagIdx >= 0 ? axis[Math.min(axis.length - 1, lagIdx + (c.response_lag_months ?? 0))] : null

  return {
    animationDuration: 300,
    grid: { left: 56, right: 16, top: 26, bottom: 34 },
    legend: { top: 0, textStyle: { color: '#8fa3bf', fontSize: 11 }, itemHeight: 8 },
    tooltip: { trigger: 'axis', axisPointer: { type: 'line' } },
    xAxis: {
      type: 'category',
      data: axis,
      axisLabel: { color: '#8fa3bf', fontSize: 10, interval: 1 },
      axisLine: { lineStyle: { color: '#8fa3bf' } },
    },
    yAxis: {
      type: 'value',
      name: props.unit,
      nameTextStyle: { color: '#8fa3bf', fontSize: 10 },
      splitLine: { lineStyle: { color: '#22304d' } },
      axisLabel: { color: '#8fa3bf', fontSize: 10 },
    },
    series: [
      {
        name: '区间下沿',
        type: 'line',
        stack: 'band',
        data: lo,
        symbol: 'none',
        lineStyle: { opacity: 0 },
        areaStyle: { opacity: 0 },
        silent: true,
        tooltip: { show: false },
      },
      {
        name: '90% 区间',
        type: 'line',
        stack: 'band',
        data: band,
        symbol: 'none',
        lineStyle: { opacity: 0 },
        areaStyle: { color: 'rgba(90,169,230,0.18)' },
        silent: true,
        tooltip: { show: false },
      },
      {
        name: '压前实测',
        type: 'line',
        data: history,
        symbolSize: 5,
        lineStyle: { width: 2.5, color: '#e8eef8' },
        itemStyle: { color: '#e8eef8' },
      },
      {
        name: '基线（不压）',
        type: 'line',
        data: baseline,
        symbol: 'none',
        lineStyle: { width: 2, type: 'dashed', color: '#8fa3bf' },
        itemStyle: { color: '#8fa3bf' },
      },
      {
        name: '预测（压）',
        type: 'line',
        data: pred,
        symbol: 'none',
        lineStyle: { width: 2.5, color: '#2fbf71' },
        itemStyle: { color: '#2fbf71' },
        markLine: {
          silent: true,
          symbol: 'none',
          data: [{ yAxis: c.break_even }],
          lineStyle: { color: '#f2b544', type: 'dotted', width: 2 },
          label: {
            show: true,
            formatter: `保本线 ${c.break_even}`,
            color: '#f2b544',
            fontSize: 10,
            position: 'insideEndTop',
          },
        },
        markArea: ev
          ? {
              silent: true,
              itemStyle: { color: 'rgba(242,181,68,0.10)' },
              label: {
                show: true,
                formatter: `见效滞后 ${c.response_lag_months} 个月`,
                color: '#f2b544',
                fontSize: 10,
              },
              data: [[{ xAxis: ev }, { xAxis: lagEnd ?? ev }]],
            }
          : undefined,
      },
    ],
  }
}

const { chart } = useChart(el, build, [() => props.curve])
defineExpose({ chart })
</script>

<template>
  <div>
    <div v-if="!curve" class="na" style="padding: 40px 0; text-align: center">
      暂无该井曲线（bundle 未提供或 available:false）
    </div>
    <div v-else>
      <div ref="el" class="chart" style="height: 300px"></div>
      <!-- 图内标注画在 canvas 上不可选/不可读，这里再给一份文字版本 -->
      <div class="row wrap small muted" style="margin-top: 4px">
        <span>保本线 <EmptyValue :value="curve.break_even" :digits="1" :unit="unit" /></span>
        <span>
          见效滞后 <EmptyValue :value="curve.response_lag_months" /> 个月（自
          <span class="mono">{{ curve.event_month }}</span> 起）
        </span>
        <span v-if="oneSided" class="badge">单边 90% 区间（下界截断于 0）</span>
        <span v-else>90% 区间由共形校准给出</span>
      </div>
    </div>
  </div>
</template>
