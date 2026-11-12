<script setup lang="ts">
import { computed, ref } from 'vue'
import { NButton, NCheckbox, NSelect, NSlider, NTag } from 'naive-ui'
import { useRouter } from 'vue-router'
import { useChart, type ChartOption } from '@/composables/useEcharts'
import { useAppStore } from '@/stores/app'
import EmptyValue from '@/components/EmptyValue.vue'
import IllustrativeBadge from '@/components/IllustrativeBadge.vue'
import { n, pct } from '@/utils/format'
import type { Objective, Strategy } from '@/types/bundle'

const store = useAppStore()
const router = useRouter()

// 预算/风险档位：只取 bundle 里实际存在的取值，不插值
const budgetLevels = computed(() => [...new Set((store.portfolio?.points ?? []).map((p) => p.budget))].sort((a, b) => a - b))
const riskLevels = computed(() => [...new Set((store.portfolio?.points ?? []).map((p) => p.risk))].sort((a, b) => a - b))
const objectiveLevels = computed(() => [...new Set((store.portfolio?.points ?? []).map((p) => p.objective))])

const budget = ref<number>(budgetLevels.value[budgetLevels.value.length - 1] ?? 135)
const risk = ref<number>(riskLevels.value[riskLevels.value.length - 1] ?? 0.3)
const objective = ref<Objective>((objectiveLevels.value[0] as Objective) ?? 'npv')

const gridPoint = computed(
  () =>
    (store.portfolio?.points ?? []).find(
      (p) => p.budget === budget.value && p.risk === risk.value && p.objective === objective.value,
    ) ?? null,
)

const budgetMarks = computed(() =>
  Object.fromEntries(budgetLevels.value.map((b, i) => [i * (100 / Math.max(1, budgetLevels.value.length - 1)), String(b)])),
)
const budgetIndex = computed({
  get: () => budgetLevels.value.indexOf(budget.value),
  set: (i: number) => (budget.value = budgetLevels.value[i]),
})
const riskIndex = computed({
  get: () => riskLevels.value.indexOf(risk.value),
  set: (i: number) => (risk.value = riskLevels.value[i]),
})

// —— 五栏对照 ——
interface Row {
  id: string
  label: string
  selected: string[]
  oil: number | null
  npv: number | null
  loss: number | null
  hit: number | null
  regret: number | null
  matched: boolean
  isYou: boolean
}
const rows = computed<Row[]>(() => {
  const you: Row = {
    id: 'you',
    label: '你的选择',
    selected: store.combo.selected,
    oil: store.combo.expected_oil,
    npv: store.combo.expected_npv,
    loss: store.combo.loss_prob,
    hit: store.combo.hit_rate,
    regret: store.combo.regret,
    matched: store.combo.matched,
    isYou: true,
  }
  const others: Row[] = (store.portfolio?.strategies ?? []).map((s: Strategy) => ({
    id: s.id,
    label: s.label,
    selected: s.selected ?? [],
    oil: s.expected_oil ?? null,
    npv: s.expected_npv ?? null,
    loss: s.loss_prob ?? null,
    hit: s.hit_rate ?? null,
    regret: s.regret ?? null,
    matched: true,
    isYou: false,
  }))
  return [you, ...others]
})

const metrics = computed(() => [
  // 期望增油是 12 个月累计体积，单位是 m³；不是 meta.units.oil（那是日产口径 m3/d）
  { key: 'oil', label: '期望增油 m³', fmt: (v: number | null) => n(v), better: 'high' as const },
  { key: 'npv', label: '期望 NPV', fmt: (v: number | null) => n(v, 1), better: 'high' as const },
  { key: 'loss', label: '亏损概率', fmt: (v: number | null) => pct(v), better: 'low' as const },
  { key: 'hit', label: '命中率', fmt: (v: number | null) => pct(v), better: 'high' as const },
  { key: 'regret', label: '后悔值', fmt: (v: number | null) => n(v, 1), better: 'low' as const },
])

function isBest(key: string): (r: Row) => boolean {
  return (r: Row) => {
    const vals = rows.value.map((x) => (x as unknown as Record<string, number | null>)[key]).filter((v): v is number => typeof v === 'number')
    if (!vals.length) return false
    const v = (r as unknown as Record<string, number | null>)[key]
    if (typeof v !== 'number') return false
    const m = metrics.value.find((x) => x.key === key)!
    const target = m.better === 'high' ? Math.max(...vals) : Math.min(...vals)
    return v === target
  }
}

// —— 前沿图 ——
const el = ref<HTMLElement | null>(null)
function build(): ChartOption {
  const pts = store.portfolio?.points ?? []
  const fr = store.portfolio?.frontier ?? []
  return {
    animationDuration: 300,
    grid: { left: 56, right: 18, top: 20, bottom: 36 },
    tooltip: { trigger: 'item' },
    xAxis: {
      type: 'value',
      name: '风险（亏损概率）',
      nameLocation: 'middle',
      nameGap: 24,
      min: 0,
      max: Math.max(0.4, ...pts.map((p) => p.loss_prob ?? 0)) + 0.05,
      axisLabel: { formatter: (v: number) => (v * 100).toFixed(0) + '%', color: '#8fa3bf', fontSize: 10 },
      splitLine: { lineStyle: { color: '#22304d' } },
    },
    yAxis: {
      type: 'value',
      name: '期望 NPV',
      min: 0,
      splitLine: { lineStyle: { color: '#22304d' } },
      axisLabel: { color: '#8fa3bf', fontSize: 10 },
    },
    series: [
      {
        name: '网格组合',
        type: 'scatter',
        data: pts.map((p) => [p.loss_prob, p.expected_npv]),
        symbolSize: 12,
        itemStyle: { color: '#5aa9e6' },
      },
      {
        name: '有效前沿',
        type: 'line',
        data: fr.map((f) => [f.risk, f.npv]).sort((a, b) => (a[0] as number) - (b[0] as number)),
        lineStyle: { color: '#2fbf71', width: 2 },
        itemStyle: { color: '#2fbf71' },
        symbolSize: 7,
      },
    ],
  }
}
useChart(el, build, [])

/**
 * 「只看可结算井」默认开：77 行里只有 20 口在 combo_metrics 的 C(20,3) 全表里，
 * 默认展开全量只会让演示者勾进死路（风险指标全变“暂无”）。
 */
/** D10：池外井必须能一句话解释「为什么这口井不行」，不能只灰着 */
function poolReason(id: string) {
  const pr = (store.portfolio as { pool_rule?: {
    k?: number; excluded?: { well_id: string; reason?: string }[]
  } } | undefined)?.pool_rule
  const ex = pr?.excluded?.find((e) => e.well_id === id)
  if (ex?.reason) return ex.reason
  const ranked = [...store.wells].sort((a, b) => b.value_npv - a.value_npv)
  const rank = ranked.findIndex((w) => w.well_id === id) + 1
  return `按预测 NPV 排名第 ${rank}，不在候选池前 ${pr?.k ?? 20} 名；`
    + '组合风险指标只对池内井计算'
}

const onlySettleable = ref(true)
const candWells = computed(() =>
  onlySettleable.value
    ? store.wells.filter((w) => store.isSettleable(w.well_id))
    : store.wells,
)

function toggle(id: string, on: boolean) {
  const set = new Set(store.selectedWellIds)
  if (on) {
    // 兜底：只让可结算井进组合，且不超 k 口（否则查表必然落空 → 风险指标全“暂无”）
    if (!store.isSettleable(id)) return
    if (!set.has(id) && set.size >= store.comboK) return
    set.add(id)
  } else set.delete(id)
  store.selectedWellIds = [...set]
}
</script>

<template>
  <div class="layout">
    <!-- 左：预算/风险/候选 -->
    <aside class="col no-print">
      <section class="panel">
        <h3 class="panel-title">预算与风险（按 bundle 实际档位）</h3>
        <div class="small muted">
          预算 {{ budget }} {{ store.meta.units.money }} · 档位 {{ budgetLevels.join(' / ') || '暂无' }}
        </div>
        <NSlider v-model:value="budgetIndex" :min="0" :max="Math.max(0, budgetLevels.length - 1)" :step="1" />
        <div class="small muted">风险阈值 {{ risk }} · 档位 {{ riskLevels.join(' / ') || '暂无' }}</div>
        <NSlider v-model:value="riskIndex" :min="0" :max="Math.max(0, riskLevels.length - 1)" :step="1" />
        <div class="small muted">目标</div>
        <NSelect
          v-model:value="objective"
          :options="objectiveLevels.map((o) => ({ label: o, value: o }))"
          size="small"
        />
        <div class="small muted" style="margin-top: 6px">
          网格命中：<span v-if="gridPoint" class="badge badge-green">{{ gridPoint.selected.join('、') }}</span>
          <span v-else class="na">暂无（该 预算×风险×目标 组合不在预计算网格内）</span>
        </div>
      </section>

      <section class="panel grow">
        <h3 class="panel-title">
          <span class="fig-no">DWG-COMP-020</span><span class="fig-cap">候选井（勾选参与结算）</span>
          <span class="fig-unit">每次恰选 {{ store.comboK }} 口</span>
        </h3>
        <div class="row settle-filter">
          <NCheckbox v-model:checked="onlySettleable">
            只看可结算井（{{ store.comboPool.size }} 口）
          </NCheckbox>
          <span class="grow"></span>
          <span class="small dim mono">
            {{ onlySettleable ? store.comboPool.size : store.wells.length }} / {{ store.wells.length }} 口
          </span>
        </div>
        <div class="small muted" style="margin-bottom: 4px">
          结算候选池 = combo_metrics 覆盖的 {{ store.comboPool.size }} 口；
          池外井勾了也查不到组合风险指标（会显示“暂无”）
        </div>
        <div class="col" style="gap: 2px">
          <div v-for="w in candWells" :key="w.well_id" class="row cand">
            <NCheckbox
              :checked="store.selectedWellIds.includes(w.well_id)"
              :disabled="!store.isSettleable(w.well_id) || (!store.selectedWellIds.includes(w.well_id) && store.selectedWellIds.length >= store.comboK)"
              @update:checked="(v: boolean) => toggle(w.well_id, v)"
            />
            <span class="mono small" :class="{ dim: !store.isSettleable(w.well_id) }">{{ w.well_id }}</span>
            <span class="small muted grow">{{ w.bucket }}</span>
            <span
              v-if="!store.isSettleable(w.well_id)"
              class="badge"
              :title="poolReason(w.well_id)"
            >不参与结算</span>
            <IllustrativeBadge v-if="store.illustrativeWell(w.well_id)" />
            <span class="small num">NPV <EmptyValue :value="w.value_npv" :digits="1" /></span>
          </div>
        </div>
        <div class="small muted" style="margin-top: 8px">
          已选 {{ store.selectedWellIds.length }} / {{ store.comboK }} 口 ·
          <span v-if="store.combo.matched" class="badge badge-green">
            组合指标命中（{{ store.combo.source === 'combo_metrics' ? 'combo_metrics' : 'portfolio.points' }}）
          </span>
          <span v-else class="na">组合指标暂无（查表未命中，不做前端推算）</span>
        </div>
      </section>
    </aside>

    <!-- 中：五栏 + 结算 + 前沿 -->
    <main class="col" style="overflow: auto">
      <section class="panel">
        <h3 class="panel-title">
          五栏对照
          <span class="muted small">你的选择 / AI / 老师傅 / 历史 / 随机</span>
        </h3>
        <div class="scrollx">
          <table class="grid five">
            <thead>
              <tr>
                <th>指标</th>
                <th v-for="r in rows" :key="r.id">
                  {{ r.label }}
                  <div v-if="r.isYou" class="small muted">（求和 + 查表）</div>
                </th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>选中井</td>
                <td v-for="r in rows" :key="r.id" class="small">
                  <span v-if="r.selected.length">{{ r.selected.join('、') }}</span>
                  <span v-else class="na">未选</span>
                </td>
              </tr>
              <tr v-for="m in metrics" :key="m.key">
                <td>{{ m.label }}</td>
                <td v-for="r in rows" :key="r.id">
                  <span v-if="(r as unknown as Record<string, number | null>)[m.key] !== null" :class="{ best: isBest(m.key)(r) }" class="num">
                    {{ m.fmt((r as unknown as Record<string, number | null>)[m.key]) }}
                  </span>
                  <span v-else class="na">暂无</span>
                  <span v-if="isBest(m.key)(r)" class="small" style="color: var(--green)"> ★</span>
                </td>
              </tr>
              <tr>
                <td>CVaR</td>
                <td v-for="r in rows" :key="r.id">
                  <span v-if="r.isYou">
                    <EmptyValue :value="store.combo.cvar" :digits="1" />
                  </span>
                  <span v-else class="na">暂无</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <div class="small muted" style="margin-top: 8px">
          “你的选择”栏：增油 / NPV 由所选井求和（期望值线性可加）；亏损概率 / CVaR / 命中率 / 后悔值
          <strong>不做前端公式</strong>，按 well_id 排序查表，查不到即显示“暂无”。 查表顺序：
          <template v-if="store.comboMetrics?.available">
            <strong>combo_metrics</strong>（Top-{{ store.comboMetrics.n_items }}，C({{ 'n' }},{{ store.comboMetrics.k }})={{ store.comboMetrics.n_total }}）
          </template>
          <template v-else>
            <strong>combo_metrics 缺失 → 回退 portfolio.points</strong>
          </template>
          。当前来源：<span
            class="badge badge-accent"
            :data-combo-source="store.combo.source ?? 'none'"
            >{{
            store.combo.source === 'combo_metrics' ? 'combo_metrics' : store.combo.source === 'portfolio.points' ? 'portfolio.points（回退）' : '暂无'
          }}</span>
        </div>
      </section>

      <section class="panel">
        <h3 class="panel-title">结算摘要</h3>
        <div class="row wrap">
          <div class="stat">
            <div class="small muted">期望增油</div>
            <div class="big num" data-prov="x_combo_expected_oil" data-prov-title="期望增油 · 数字溯源"><EmptyValue :value="store.combo.expected_oil" unit="m³" /></div>
          </div>
          <div class="stat">
            <div class="small muted">期望 NPV</div>
            <div class="big num" data-prov="x_combo_expected_npv" data-prov-title="期望 NPV · 数字溯源"><EmptyValue :value="store.combo.expected_npv" :digits="1" :unit="store.meta.units.money" /></div>
          </div>
          <div class="stat">
            <div class="small muted">亏损概率</div>
            <div class="big num" data-prov="x_combo_loss_prob" data-prov-title="亏损概率 · 数字溯源"><EmptyValue :value="store.combo.loss_prob" :digits="0" /></div>
          </div>
          <div class="stat">
            <div class="small muted">命中率</div>
            <div class="big num" data-prov="x_combo_hit_rate" data-prov-title="命中率 · 数字溯源"><EmptyValue :value="store.combo.hit_rate" :digits="0" /></div>
          </div>
          <div class="stat">
            <div class="small muted">后悔值</div>
            <div class="big num" data-prov="x_combo_regret" data-prov-title="后悔值 · 数字溯源"><EmptyValue :value="store.combo.regret" :digits="1" /></div>
          </div>
          <div class="stat">
            <div class="small muted">CVaR</div>
            <div class="big num" data-prov="x_combo_cvar" data-prov-title="CVaR₅ · 数字溯源"><EmptyValue :value="store.combo.cvar" :digits="1" /></div>
          </div>
        </div>
      </section>

      <section class="panel">
        <h3 class="panel-title">有效前沿（风险 — 收益）</h3>
        <div ref="el" class="chart" style="height: 260px"></div>
      </section>
    </main>

    <!-- 右：导出 -->
    <aside class="side-right col no-print">
      <section class="panel">
        <h3 class="panel-title">网格明细</h3>
        <table class="grid">
          <thead>
            <tr><th>预算</th><th>风险</th><th>NPV</th><th>亏损</th></tr>
          </thead>
          <tbody>
            <tr v-for="(p, i) in store.portfolio?.points ?? []" :key="i">
              <td class="num">{{ p.budget }}</td>
              <td class="num">{{ p.risk }}</td>
              <td class="num">{{ n(p.expected_npv, 1) }}</td>
              <td class="num">{{ pct(p.loss_prob) }}</td>
            </tr>
            <tr v-if="!(store.portfolio?.points ?? []).length">
              <td colspan="4" class="na">暂无</td>
            </tr>
          </tbody>
        </table>
      </section>
      <NButton type="primary" block @click="router.push('/report')">生成 A4 决策报告</NButton>
    </aside>
  </div>
</template>

<style scoped>
.scrollx { overflow-x: auto; }
.five th:first-child, .five td:first-child { min-width: 90px; }
.five th, .five td { min-width: 104px; }
.best { color: var(--green); font-weight: 600; }
.stat { min-width: 104px; }
.cand { padding: 3px 2px; }
.dim { color: var(--dim); opacity: 0.65; }
</style>
