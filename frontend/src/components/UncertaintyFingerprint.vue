<script setup lang="ts">
import { computed } from 'vue'
import type { Well } from '@/types/bundle'
import EmptyValue from './EmptyValue.vue'

// 不确定性指纹：四段归因评分（0–100，不是方差占比）
const props = defineProps<{ well: Well }>()

const segs = computed(() => {
  const u = props.well?.uncertainty
  return [
    { key: 'aleatoric', label: '固有随机', color: 'var(--accent)', v: u?.aleatoric ?? null },
    { key: 'data', label: '数据不足', color: 'var(--yellow)', v: u?.data ?? null },
    { key: 'model', label: '模型分歧', color: 'var(--geology)', v: u?.model ?? null },
    { key: 'economic', label: '经济参数', color: 'var(--red)', v: u?.economic ?? null },
  ]
})
</script>

<template>
  <div class="col">
    <div v-for="s in segs" :key="s.key" class="seg">
      <div class="row small">
        <span class="grow">{{ s.label }}</span>
        <EmptyValue :value="s.v" />
      </div>
      <div class="track">
        <div
          v-if="typeof s.v === 'number'"
          class="fill"
          :style="{ width: Math.max(0, Math.min(100, s.v)) + '%', background: s.color }"
        ></div>
        <div v-else class="fill na-fill"></div>
      </div>
    </div>
    <div class="small muted">评分为归因强度（0–100），不是方差占比，四段之和不必为 100。</div>
  </div>
</template>

<style scoped>
.seg { display: flex; flex-direction: column; gap: 3px; }
.track { height: 8px; background: var(--panel-2); border: 1px solid var(--line-soft); overflow: hidden; }
.fill { height: 100%; }
.na-fill {
  width: 100%;
  background: repeating-linear-gradient(45deg, #23292e, #23292e 4px, #2c3339 4px, #2c3339 8px);
}
</style>
