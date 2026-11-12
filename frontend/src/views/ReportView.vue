<script setup lang="ts">
import { computed } from 'vue'
import { NButton } from 'naive-ui'
import { useAppStore } from '@/stores/app'
import DataModeBadge from '@/components/DataModeBadge.vue'
import EmptyValue from '@/components/EmptyValue.vue'
import IllustrativeBadge from '@/components/IllustrativeBadge.vue'
import { n, pct } from '@/utils/format'

const store = useAppStore()

const today = new Date().toISOString().slice(0, 10)

const stateLabel: Record<string, string> = {
  green: '可判定',
  yellow: '数据不足',
  red: '不建议',
  gray: '低价值低置信',
}

const selectedWells = computed(() =>
  store.combo.selected.map((id) => store.wellById(id)).filter((w) => !!w),
)

const passportLines = computed(() =>
  store.passports
    .filter((p) => selectedWells.value.some((w) => w!.passport_ids.includes(p.id)))
    .map((p) => `${p.label} = ${p.value} ${p.unit}｜公式：${p.formula}｜来源：${p.source}`),
)

const missingPassports = computed(() => {
  const out: string[] = []
  for (const w of selectedWells.value) {
    for (const id of w!.passport_ids) {
      if (!store.passportById(id)) out.push(`${w!.well_id} → ${id}`)
    }
  }
  return out
})

const hasIllustrative = computed(() =>
  selectedWells.value.some((w) => store.illustrativeWell(w!.well_id)),
)

const gaps = computed(() => {
  const m = new Map<string, number>()
  for (const w of selectedWells.value) {
    for (const g of w!.data_gaps ?? []) m.set(g, (m.get(g) ?? 0) + 1)
  }
  return [...m.entries()]
})

function doPrint() {
  window.print()
}
</script>

<template>
  <div style="overflow: auto; height: calc(100vh - var(--topbar-h)); padding: 12px">
    <div class="row no-print" style="margin-bottom: 10px">
      <NButton type="primary" size="small" @click="doPrint">打印 / 另存为 PDF（A4）</NButton>
      <NButton size="small" @click="$router.push('/portfolio')">返回结算</NButton>
      <span class="grow"></span>
      <span class="small muted">打印时自动套用 A4 页边距 15mm</span>
    </div>

    <article class="report panel" style="max-width: 820px; margin: 0 auto">
      <header>
        <div class="row">
          <h1 style="margin: 0">完井措施决策报告</h1>
          <span class="grow"></span>
          <DataModeBadge />
        </div>
        <div class="small muted">
          Weld 区块 · {{ store.meta.dataset_id }} · 生成 {{ today }} · 模型
          <span class="mono">{{ store.meta.model_version }}</span> · config
          <span class="mono">{{ store.meta.config_id }}</span>
        </div>
        <p class="small muted" style="margin: 4px 0 0">
          本报告全部数字来自离线 bundle（schema 1.0），前端未做任何推算；缺失字段一律标注“暂无”。
        </p>
      </header>

      <h2>一、候选与推荐组合</h2>
      <table class="grid">
        <thead>
          <tr>
            <th>井号</th><th>层位</th><th>产量档</th><th>锚点</th>
            <th>期望 NPV（{{ store.meta.units.money }}）</th><th>置信度</th><th>状态</th><th>建议动作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="w in selectedWells" :key="w!.well_id">
            <td>
              <span class="mono">{{ w!.well_id }}</span>
              <IllustrativeBadge v-if="store.illustrativeWell(w!.well_id)" />
            </td>
            <td>{{ w!.formation }}</td>
            <td class="small">{{ w!.bucket }}</td>
            <td class="num">{{ n(w!.anchor, 1) }}</td>
            <td class="num"><EmptyValue :value="w!.value_npv" :digits="1" /></td>
            <td class="num">{{ pct(w!.confidence) }}</td>
            <td>{{ stateLabel[w!.state] ?? '—' }}</td>
            <td>
              {{ store.actions[w!.well_id] || w!.recommended_action }}
              <span v-if="store.actions[w!.well_id]" class="small muted">（人工）</span>
            </td>
          </tr>
          <tr v-if="!selectedWells.length"><td colspan="8" class="na">暂无</td></tr>
        </tbody>
      </table>
      <div class="small muted" style="margin-top: 6px">
        组合口径：增油 / NPV 为所选井求和（期望值线性可加）；亏损概率 / CVaR / 命中率 / 后悔值
        按 well_id 排序查 portfolio.points，
        <span v-if="store.combo.matched">已命中网格。</span>
        <span v-else class="na">未命中 → 暂无（不做前端推算）。</span>
      </div>

      <h2>二、组合结算</h2>
      <table class="grid">
        <tbody>
          <tr><td>选中井数</td><td class="num">{{ store.combo.count }}</td></tr>
          <tr><td>期望增油</td><td class="num"><EmptyValue :value="store.combo.expected_oil" /></td></tr>
          <tr>
            <td>期望 NPV（{{ store.meta.units.money }}）</td>
            <td class="num"><EmptyValue :value="store.combo.expected_npv" :digits="1" /></td>
          </tr>
          <tr><td>亏损概率</td><td class="num"><EmptyValue :value="store.combo.loss_prob" /></td></tr>
          <tr><td>CVaR</td><td class="num"><EmptyValue :value="store.combo.cvar" :digits="1" /></td></tr>
          <tr><td>命中率</td><td class="num"><EmptyValue :value="store.combo.hit_rate" /></td></tr>
          <tr><td>后悔值</td><td class="num"><EmptyValue :value="store.combo.regret" :digits="1" /></td></tr>
        </tbody>
      </table>

      <h2>三、单井决策卡摘要（含证据链）</h2>
      <div v-for="w in selectedWells" :key="w!.well_id" class="panel" style="margin-bottom: 8px">
        <div class="row">
          <strong>{{ w!.name }}</strong>
          <span class="mono small muted">{{ w!.well_id }} · {{ w!.formation }}</span>
          <span class="badge badge-accent">{{ w!.bucket }}</span>
          <IllustrativeBadge v-if="store.illustrativeWell(w!.well_id)" />
          <span class="grow"></span>
          <span class="badge" :class="`badge-${w!.state}`">{{ stateLabel[w!.state] ?? '—' }}</span>
        </div>
        <div class="small muted">
          相似事件：{{ (w!.evidence?.similar_ids ?? []).join('、') || '暂无' }}
        </div>
        <div class="small muted">
          不确定性指纹：固有
          <EmptyValue :value="w!.uncertainty?.aleatoric" /> / 数据
          <EmptyValue :value="w!.uncertainty?.data" /> / 模型
          <EmptyValue :value="w!.uncertainty?.model" /> / 经济
          <EmptyValue :value="w!.uncertainty?.economic" />
        </div>
        <div class="small muted">数据缺口：{{ (w!.data_gaps ?? []).join('；') || '暂无' }}</div>
      </div>

      <h2>四、风险、数据缺口与假设</h2>
      <ul class="caveats">
        <li v-for="c in store.meta.caveats" :key="c">{{ c }}</li>
      </ul>
      <div v-if="gaps.length">
        <div class="small muted">候选井缺口汇总</div>
        <ul class="caveats">
          <li v-for="[g, cnt] in gaps" :key="g">{{ g }}（{{ cnt }} 口井）</li>
        </ul>
      </div>
      <div class="small muted">
        假设：预算 {{ store.assumptions.budget }} {{ store.meta.units.money }} · 油价
        {{ store.assumptions.oilPrice }} 元/t · 单井成本 {{ store.assumptions.cost }}
        {{ store.meta.units.money }} · 置信阈值 {{ pct(store.confThreshold) }}
      </div>
      <div v-if="hasIllustrative" class="small">
        <IllustrativeBadge text="含示意井" /> 本报告含示意补充数据（mock_supplement.json），非实测结果。
      </div>

      <h2>五、数字护照脚注</h2>
      <ol class="foot">
        <li v-for="(l, i) in passportLines" :key="i" class="small muted">{{ l }}</li>
        <li v-if="!passportLines.length" class="na small">暂无</li>
      </ol>
      <div v-if="missingPassports.length" class="na small">
        缺失护照条目（不得编造）：{{ missingPassports.join('；') }}
      </div>

      <div class="sign-row">
        <div>决策人签字</div>
        <div>技术复核</div>
        <div>日期</div>
      </div>
    </article>
  </div>
</template>

<style scoped>
.report { padding: 18px 20px; }
.caveats { margin: 4px 0; padding-left: 18px; font-size: 12px; color: var(--muted); }
.foot { margin: 4px 0; padding-left: 20px; }
.foot li { margin-bottom: 2px; }
.sign-row { margin-top: 24pt; display: flex; gap: 32pt; }
.sign-row div { flex: 1; border-top: 1px solid var(--line); padding-top: 4pt; font-size: 10pt; color: var(--muted); }
</style>
