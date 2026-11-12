<script setup lang="ts">
import { computed } from 'vue'
import { isNone, n } from '@/utils/format'

// 契约硬约束：字段缺失显示“暂无”，不得编造
const props = withDefaults(
  defineProps<{
    value?: unknown
    unit?: string
    digits?: number
    suffix?: string
  }>(),
  { unit: '', digits: 0, suffix: '' },
)

const missing = computed(() => isNone(props.value))
</script>

<template>
  <span v-if="missing" class="na" title="bundle 未提供该字段，按契约显示“暂无”">暂无</span>
  <span v-else class="num"
    >{{ n(value, digits) }}<span v-if="unit || suffix" class="muted small"> {{ unit || suffix }}</span></span
  >
</template>
