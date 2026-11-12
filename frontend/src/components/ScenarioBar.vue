<script setup lang="ts">
import { NButton } from 'naive-ui'
import { useAppStore } from '@/stores/app'

/** 场景对比：保存当前控制轨假设快照 → 可横向比选；重置回到默认口径 */
const store = useAppStore()
const objLabel: Record<string, string> = {
  npv: 'NPV',
  oil: '增油',
  roi: 'ROI',
  risk: '风险',
}
</script>

<template>
  <section class="panel sb">
    <h3 class="panel-title">
      <span class="fig-no">DWG-COMP-004</span>
      <span class="fig-cap">场景对比</span>
      <span class="fig-unit">{{ store.meta.units.money }} / {{ store.meta.units.oil }}</span>
    </h3>

    <div class="row btns">
      <NButton size="tiny" type="primary" @click="store.saveScenario()">保存当前</NButton>
      <NButton size="tiny" @click="store.resetAssumptions()">重置</NButton>
    </div>

    <!-- 当前 -->
    <div class="snap cur">
      <div class="row">
        <span class="mono small">NOW</span>
        <span class="grow dim small">
          预算 {{ store.assumptions.budget }} · 油价 {{ store.assumptions.oilPrice }} · 成本
          {{ store.assumptions.cost }} · 风险 {{ store.assumptions.risk.toFixed(2) }} ·
          {{ objLabel[store.assumptions.objective] ?? store.assumptions.objective }}
        </span>
      </div>
      <div class="row counts">
        <span class="c green" title="可判定">{{ store.kpi.green }}</span>
        <span class="c yellow" title="数据不足">{{ store.kpi.yellow }}</span>
        <span class="c red" title="不建议">{{ store.kpi.red }}</span>
        <span class="c gray" title="低价值低置信">{{ store.kpi.gray }}</span>
        <span class="grow"></span>
        <span class="mono small dim">缺口 {{ store.kpi.budgetGap }}</span>
      </div>
    </div>

    <!-- 已保存 -->
    <div v-if="!store.scenarios.length" class="na small">暂无已保存场景</div>
    <div v-else class="list">
      <div v-for="s in store.scenarios" :key="s.id" class="snap">
        <div class="row">
          <span class="mono small">{{ s.name }}</span>
          <span class="dim small mono">{{ s.at }}</span>
          <span class="grow"></span>
          <span class="small dim mono">缺口 {{ s.gap }}</span>
          <button class="x" :title="`删除 ${s.name}`" @click="store.removeScenario(s.id)">×</button>
        </div>
        <div class="row dim small mono wrap">
          <span>B{{ s.budget }}</span>
          <span>P{{ s.oilPrice }}</span>
          <span>C{{ s.cost }}</span>
          <span>R{{ s.risk.toFixed(2) }}</span>
          <span>{{ objLabel[s.objective] ?? s.objective }}</span>
        </div>
        <div class="row counts">
          <span class="c green">{{ s.green }}</span>
          <span class="c yellow">{{ s.yellow }}</span>
          <span class="c red">{{ s.red }}</span>
          <span class="c gray">{{ s.gray }}</span>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.sb { display: flex; flex-direction: column; }
.btns { gap: 6px; margin-bottom: 6px; }
.snap {
  border: 1px solid var(--line);
  border-left: 2px solid var(--line-strong);
  padding: 4px 6px;
  margin-bottom: 4px;
  background: var(--panel-2);
}
.snap.cur { border-left-color: var(--steel); }
.list { overflow: auto; }
.counts { gap: 4px; margin-top: 2px; }
.c {
  font-family: var(--mono);
  font-size: 11px;
  min-width: 26px;
  text-align: center;
  border: 1px solid var(--line);
  line-height: 15px;
}
.c.green { color: var(--green); }
.c.yellow { color: var(--yellow); }
.c.red { color: var(--red); }
.c.gray { color: var(--gray); }
.x {
  background: none;
  border: none;
  color: var(--dim);
  cursor: pointer;
  font-size: 13px;
  line-height: 1;
  padding: 0 2px;
}
.x:hover { color: var(--red); }
</style>
