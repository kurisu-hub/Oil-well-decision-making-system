<script setup lang="ts">
import { computed } from 'vue'
import { useAppStore } from '@/stores/app'

const store = useAppStore()
const mode = computed(() => store.dataMode) // 'mock' | 'real_pilot' | 'real'

/** 发布变体：final77 优先（meta.release 是交付版标记；event_definition 只是事件定义，仍为 v2c） */
const releaseTag = computed(() => {
  const r = store.meta.release
  if (r) return r
  return store.meta.event_definition ?? null
})

const label = computed(() => {
  if (store.realMissing) return '数据缺失'
  if (mode.value === 'real') return '实测数据'
  if (mode.value === 'real_pilot')
    return releaseTag.value ? `实测 pilot · ${releaseTag.value}` : '实测 pilot'
  return '示意数据'
})

const cls = computed(() => {
  if (store.realMissing) return 'badge badge-red'
  if (mode.value === 'real') return 'badge badge-green'
  if (mode.value === 'real_pilot') return 'badge badge-pilot'
  return 'badge badge-yellow'
})

const tip = computed(() => {
  if (store.realMissing)
    return '指定了 real / real_pilot，但对应 bundle 文件未落到 src/data/，已回退 mock（示意）'
  if (mode.value === 'real')
    return `正式全量实测 · ${store.meta.dataset_id} · ${store.meta.n_wells} 井 / ${store.meta.n_events} 事件`
  if (mode.value === 'real_pilot')
    return `pilot 实测 · ${store.meta.dataset_id} · ${store.meta.n_wells} 井 / ${store.meta.n_events} 事件`
      + `${store.meta.event_definition_label ? ' · ' + store.meta.event_definition_label : ''}`
      + ` · n=${store.meta.n_events} 小样本，指标仅作工程验证，不作论文结论`
  return `示意数据（synthetic）· ${store.meta.dataset_id} · 仅前端联调与演示`
})
</script>

<template>
  <span :class="cls" :title="tip">{{ label }}</span>
</template>
