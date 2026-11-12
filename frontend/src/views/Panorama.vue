<script setup lang="ts">
import { computed } from 'vue'
import { NButton, NSelect, NSlider, NSwitch } from 'naive-ui'
import { useRouter } from 'vue-router'
import { useAppStore } from '@/stores/app'
import WellMap from '@/components/WellMap.vue'
import ValueMatrix from '@/components/ValueMatrix.vue'
import EmptyValue from '@/components/EmptyValue.vue'
import IllustrativeBadge from '@/components/IllustrativeBadge.vue'

const store = useAppStore()
const router = useRouter()

const stateOptions = [
  { label: '可判定（绿）', value: 'green' },
  { label: '数据不足（黄）', value: 'yellow' },
  { label: '不建议（红）', value: 'red' },
  { label: '低价值低置信（灰）', value: 'gray' },
]
const bucketOptions = computed(() => store.buckets.map((b) => ({ label: b, value: b })))

/** 四象限口径 = bundle 的 well.state（模型侧判态，前端不现算） */
// 象限语义（收口口径）：绿 = 模型可判定子集；黄 = 数据不足；红 = 不建议（模型判红，需复核）；灰 = 低价值低置信
const quadCards = computed(() => [
  { key: 'green', label: '可判定', hint: '模型可判定子集 · P(累计>基线)≥70% 且 NPV>0', wells: store.quadrantGroups.green },
  { key: 'yellow', label: '数据不足', hint: '方向未定 / 价值在死区内 · 补资料后再判', wells: store.quadrantGroups.yellow },
  { key: 'red', label: '不建议（需复核）', hint: '模型判红 · P(NPV>0)≤30%（≥70% 把握亏钱）', wells: store.quadrantGroups.red },
  { key: 'gray', label: '低价值低置信', hint: '证据不足 · 不下注', wells: store.quadrantGroups.gray },
])

const objectiveOptions = [
  { label: '最大 NPV', value: 'npv' },
  { label: '最大增油', value: 'oil' },
  { label: '最大 ROI', value: 'roi' },
  { label: '最小风险', value: 'risk' },
]
</script>

<template>
  <div class="layout">
    <!-- 左：筛选 + 假设 -->
    <aside class="col no-print">
      <section class="panel">
        <h3 class="panel-title">筛选</h3>
        <div class="col">
          <div class="small muted">产量档</div>
          <NSelect
            v-model:value="store.filters.bucket"
            :options="bucketOptions"
            clearable
            placeholder="全部"
            size="small"
          />
          <div class="small muted">决策状态</div>
          <NSelect
            v-model:value="store.filters.state"
            :options="stateOptions"
            clearable
            placeholder="全部"
            size="small"
          />
          <div class="row">
            <NSwitch v-model:value="store.filters.onlyAttention" size="small" />
            <span class="small">只看黄灯（数据不足）</span>
          </div>
          <div class="small muted">
            命中 {{ store.filteredWells.length }} / {{ store.wells.length }} 口
          </div>
        </div>
      </section>

      <section class="panel">
        <h3 class="panel-title">假设（仅前端，不改 bundle）</h3>
        <div class="col">
          <div class="small muted">预算 {{ store.assumptions.budget }} {{ store.meta.units.money }}（3 档 · 网格）</div>
          <NSlider
            :value="store.assumptions.budget"
            :min="store.BUDGET_TICKS[0]"
            :max="store.BUDGET_TICKS[store.BUDGET_TICKS.length - 1]"
            :step="15"
            @update:value="(v: number) => store.setBudgetSnapped(v)"
          />
          <div class="small muted">油价 {{ store.assumptions.oilPrice }} 元/t（3 档 · 网格）</div>
          <NSlider
            :value="store.assumptions.oilPrice"
            :min="store.PRICE_TICKS[0]"
            :max="store.PRICE_TICKS[store.PRICE_TICKS.length - 1]"
            :step="100"
            @update:value="(v: number) => store.setPriceSnapped(v)"
          />
          <div class="small muted">单井成本 {{ store.assumptions.cost }} {{ store.meta.units.money }}（3 档 · 网格）</div>
          <NSlider
            :value="store.assumptions.cost"
            :min="store.COST_TICKS[0]"
            :max="store.COST_TICKS[store.COST_TICKS.length - 1]"
            :step="5"
            @update:value="(v: number) => store.setCostSnapped(v)"
          />
          <div class="small muted">风险偏好（置信阈值下限）</div>
          <NSlider v-model:value="store.assumptions.risk" :min="0" :max="1" :step="0.05" />
          <div class="small muted">优化目标</div>
          <NSelect v-model:value="store.assumptions.objective" :options="objectiveOptions" size="small" />
        </div>
      </section>

      <section class="panel">
        <h3 class="panel-title">象限阈值</h3>
        <div class="small muted" style="margin-bottom: 4px">
          仅作敏感度探索（散点图辅助线），<b>不改变</b>四象限——状态由模型侧给出。
        </div>
        <div class="col">
          <div class="small muted">NPV 阈值 {{ store.npvThreshold }}</div>
          <NSlider v-model:value="store.npvThreshold" :min="-40" :max="80" :step="5" />
          <div class="small muted">置信阈值 {{ (store.confThreshold * 100).toFixed(0) }}%</div>
          <NSlider v-model:value="store.confThreshold" :min="0" :max="1" :step="0.05" />
        </div>
      </section>
    </aside>

    <!-- 中：KPI + 井区 + 矩阵 -->
    <main class="col" style="overflow: auto">
      <section class="panel kpi-row">
        <div class="kpi">
          <div class="small muted">可判定</div>
          <div class="huge num" style="color: var(--green)">{{ store.kpi.green }}</div>
        </div>
        <div class="kpi">
          <div class="small muted">数据不足</div>
          <div class="huge num" style="color: var(--yellow)">{{ store.kpi.yellow }}</div>
        </div>
        <div class="kpi">
          <div class="small muted">不建议</div>
          <div class="huge num" style="color: var(--red)">{{ store.kpi.red }}</div>
        </div>
        <div class="kpi">
          <div class="small muted">低价值低置信</div>
          <div class="huge num" style="color: var(--gray)">{{ store.kpi.gray }}</div>
        </div>
        <div class="kpi">
          <div class="small muted">预算缺口</div>
          <div class="huge num">{{ store.kpi.budgetGap }}<span class="small muted"> {{ store.meta.units.money }}</span></div>
        </div>
      </section>

      <section class="panel">
        <h3 class="panel-title">井区（2.5D 示意 · SVG）</h3>
        <WellMap :wells="store.filteredWells" />
      </section>

      <section class="panel">
        <h3 class="panel-title">价值矩阵（X=期望 NPV，Y=置信度）</h3>
        <ValueMatrix />
      </section>
    </main>

    <!-- 右：四象限清单 -->
    <aside class="side-right col no-print">
      <section class="panel grow">
        <h3 class="panel-title">四象限清单</h3>
        <div class="col">
          <div v-for="q in quadCards" :key="q.key" class="quad">
            <div class="row">
              <span class="badge" :class="`badge-${q.key}`">{{ q.label }}</span>
              <span class="small muted grow">{{ q.hint }}</span>
              <span class="small num">{{ q.wells.length }}</span>
            </div>
            <div v-if="q.wells.length" class="col" style="gap: 2px">
              <div
                v-for="w in q.wells"
                :key="w.well_id"
                class="wellrow"
                @click="router.push(`/well/${w.well_id}`)"
              >
                <span class="mono small">{{ w.well_id }}</span>
                <span class="small muted grow">{{ w.name }} · {{ w.bucket }}</span>
                <IllustrativeBadge v-if="store.illustrativeWell(w.well_id)" />
                <span class="small num">NPV <EmptyValue :value="w.value_npv" /></span>
                <span class="small num">P <EmptyValue :value="w.confidence" :digits="2" /></span>
              </div>
            </div>
            <div v-else class="na small">暂无（该象限无井，不编造）</div>
          </div>
        </div>
      </section>
      <NButton size="small" block @click="router.push('/portfolio')">→ 进入措施会结算</NButton>
    </aside>
  </div>
</template>

<style scoped>
.kpi-row { display: flex; gap: 12px; }
.kpi { flex: 1; min-width: 0; }
.quad {
  border: 1px solid var(--line);
  border-radius: var(--radius);
  padding: 8px;
  background: var(--panel-2);
}
.wellrow {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 4px;
  border-radius: 4px;
  cursor: pointer;
}
.wellrow:hover { background: rgba(90, 169, 230, 0.12); }
</style>
