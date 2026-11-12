<script setup lang="ts">
import { ref } from 'vue'
import { useChart, type ChartOption } from '@/composables/useEcharts'

// 通用 ECharts 容器：卸载即 dispose，resize 走 ResizeObserver
const props = withDefaults(defineProps<{ option: ChartOption; height?: number }>(), { height: 260 })
const el = ref<HTMLElement | null>(null)
useChart(el, () => props.option, [() => props.option])
</script>

<template>
  <div ref="el" class="chart" :style="{ height: height + 'px' }"></div>
</template>
