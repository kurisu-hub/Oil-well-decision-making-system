<script setup lang="ts">
import { NDrawer, NDrawerContent, NTag } from 'naive-ui'
import { useAppStore } from '@/stores/app'
import EmptyValue from './EmptyValue.vue'
import IllustrativeBadge from './IllustrativeBadge.vue'

const store = useAppStore()

const srcLabel: Record<string, string> = {
  paper: '文献',
  synthetic: '合成',
  live: '实测',
  assumption: '假设',
  illustrative: '示意',
  derived: '模型推导', // T05：前端聚合/查表类数字（x_ 前缀补录条目）
}
</script>

<template>
  <NDrawer v-model:show="store.passportDrawer.open" :width="480" placement="right">
    <NDrawerContent :title="store.passportDrawer.title" closable>
      <div class="col">
        <div v-for="row in store.passportEntries" :key="row.id" class="pp">
          <template v-if="row.entry">
            <div class="row">
              <strong>{{ row.entry.label }}</strong>
              <NTag size="small" :bordered="false">{{ srcLabel[row.entry.source] ?? row.entry.source }}</NTag>
              <IllustrativeBadge v-if="row.entry.source === 'illustrative'" />
              <span class="grow"></span>
              <span class="big num">{{ row.entry.value }}</span>
              <span class="muted small">{{ row.entry.unit }}</span>
            </div>
            <div class="small muted">公式：<span class="mono">{{ row.entry.formula }}</span></div>
            <div class="small muted">
              样本量：<EmptyValue :value="row.entry.sample_size" /> · config：<EmptyValue
                :value="row.entry.config_id"
              />
            </div>
            <div v-if="row.entry.assumptions?.length" class="small muted">
              假设：{{ row.entry.assumptions.join('；') }}
            </div>
            <div class="small muted">更新：<span class="mono">{{ row.entry.updated_at }}</span></div>
          </template>
          <template v-else>
            <div class="row">
              <strong class="mono">{{ row.id }}</strong>
              <span class="grow"></span>
              <span class="na small">暂无</span>
            </div>
            <div class="small muted">
              bundle 未提供该数字护照条目（不可编造）。请模型侧在 passport.csv 补齐后重出 bundle。
            </div>
          </template>
        </div>
        <div v-if="!store.passportEntries.length" class="na">暂无</div>
      </div>
    </NDrawerContent>
  </NDrawer>
</template>

<style scoped>
.pp {
  border: 1px solid var(--line);
  border-radius: var(--radius);
  padding: 10px;
  background: var(--panel-2);
  display: flex;
  flex-direction: column;
  gap: 3px;
}
</style>
