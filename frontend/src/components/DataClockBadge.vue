<script setup lang="ts">
/**
 * DataClockBadge · 数据时刻条（T02）
 *
 * 顶部常驻一行，全站可见：
 *   数据时刻 2019-03 · 数据集 2014-09~2024-08 · 历史回放
 *
 * 口径：
 *  - 「数据时刻」= 回放时钟当前月（store.replayMonth），不是系统时间、不是实时数据
 *  - 「数据集」= 事件窗口（bundle.meta.scope 的 event_month_min/max）
 *  - **不出现「实时 / 当前数据」字样**：本项目做的是历史回放，不是实时接入
 *  - 只展示，不改任何数据；点击跳到三维场景里看这一刻（可选）
 */
import { computed } from 'vue'
import { useAppStore } from '@/stores/app'

const store = useAppStore()

const range = computed(() => store.replayRange)
const month = computed(() => store.replayMonth)
const atEnd = computed(() => month.value === range.value.max)
</script>

<template>
  <span
    class="clock"
    :title="`数据时刻 ${month}；数据集覆盖事件月 ${range.min}~${range.max}；本次展示为历史数据回放`"
  >
    <span class="k">数据时刻</span>
    <b class="v">{{ month }}</b>
    <span class="sep">·</span>
    <span class="k">数据集</span>
    <span class="v2">{{ range.min }}~{{ range.max }}</span>
    <span class="sep">·</span>
    <span class="tag" :class="{ end: atEnd }">历史回放</span>
  </span>
</template>

<style scoped>
.clock {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 1px 6px;
  border: 1px solid var(--line);
  background: var(--panel-2);
  color: var(--muted);
  font-size: 10px;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
.k { color: var(--dim); }
.v { color: var(--text); letter-spacing: 0.02em; }
.v2 { color: var(--muted); }
.sep { color: var(--line-strong); }
.tag {
  color: var(--steel);
  border: 1px solid var(--steel-dim);
  padding: 0 4px;
  font-size: 9px;
  letter-spacing: 0.04em;
}
.tag.end { color: var(--sand); border-color: var(--sand-dim); }
</style>
