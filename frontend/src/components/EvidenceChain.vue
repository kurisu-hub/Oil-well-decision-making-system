<script setup lang="ts">
import { computed } from 'vue'
import type { Similar } from '@/types/bundle'
import SparkLine from './SparkLine.vue'

// 证据链：Top-3 相似事件（曲线用 SVG，不建 ECharts 实例）
const props = defineProps<{
  similar: Similar | null
  ids: string[]
  features?: { name: string; value: string; direction: 'up' | 'down' | 'neutral' }[]
}>()

const arrow: Record<string, string> = { up: '↑', down: '↓', neutral: '→' }
const color: Record<string, string> = {
  up: 'var(--green)',
  down: 'var(--red)',
  neutral: 'var(--muted)',
}

const items = computed(() => {
  const list = props.similar?.items ?? []
  const wanted = props.ids ?? []
  // 优先按 evidence.similar_ids 的顺序展示
  const ordered = wanted
    .map((id) => list.find((it) => it.event_id === id))
    .filter((x): x is NonNullable<typeof x> => !!x)
  return ordered.length ? ordered : list
})
</script>

<template>
  <div class="col">
    <div v-if="items.length" class="col" style="gap: 6px">
      <div v-for="it in items" :key="it.event_id" class="ev">
        <div class="row">
          <span class="mono small">{{ it.event_id }}</span>
          <span class="small muted">井 <span class="mono">{{ it.well_id }}</span></span>
          <span class="grow"></span>
          <span class="small muted">距离 <span class="num">{{ it.distance }}</span></span>
          <span class="small muted">锚点 <span class="num">{{ it.anchor }}</span></span>
        </div>
        <SparkLine :points="it.actual" :width="260" :height="34" />
      </div>
    </div>
    <div v-else class="na small">暂无（bundle 未提供相似事件）</div>

    <div v-if="features?.length" class="col" style="gap: 2px; margin-top: 4px">
      <div class="small muted">特征方向（来自证据链）</div>
      <div v-for="f in features" :key="f.name" class="row small">
        <span class="grow">{{ f.name }}</span>
        <span class="num">{{ f.value }}</span>
        <span :style="{ color: color[f.direction], width: '14px', textAlign: 'right' }">{{
          arrow[f.direction]
        }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ev {
  border: 1px solid var(--line);
  border-radius: var(--radius);
  padding: 6px 8px;
  background: var(--panel-2);
}
</style>
