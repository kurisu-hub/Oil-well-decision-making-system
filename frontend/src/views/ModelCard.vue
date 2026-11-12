<script setup lang="ts">
import { computed } from 'vue'
import { useAppStore } from '@/stores/app'
import { n, pct } from '@/utils/format'

/**
 * 模型卡 / 状态混淆矩阵（静态页，可查）
 *
 * 口径：
 *  - 全部内容**只读 bundle**（meta / final_model / model_diagnostics / state_confusion /
 *    baseline_audit / intervals），前端不推算、不补数；缺字段一律显示「暂无」
 *  - 与界面上的判态同源：判态在模型侧完成写进 well.state，本页只解释它怎么来的、准不准
 */
const store = useAppStore()

/** 任意值的安全展示：null/undefined → 暂无；对象/数组 → 紧凑 JSON */
function fmt(v: unknown): string {
  if (v === null || v === undefined || v === '') return '暂无'
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '暂无'
  if (typeof v === 'boolean') return v ? '是' : '否'
  if (typeof v === 'string') return v
  try {
    return JSON.stringify(v)
  } catch {
    return '暂无'
  }
}

const meta = computed(() => store.meta)

const metaRows = computed(() => [
  { k: 'dataset_id', v: fmt(meta.value.dataset_id) },
  { k: 'release', v: fmt(meta.value.release) },
  { k: 'data_mode', v: fmt(meta.value.data_mode) },
  { k: 'event_definition', v: fmt(meta.value.event_definition) },
  { k: 'n_wells / n_events', v: `${fmt(meta.value.n_wells)} / ${fmt(meta.value.n_events)}` },
  { k: 'generated_at', v: fmt(meta.value.generated_at) },
  { k: 'model_version', v: fmt(meta.value.model_version) },
  { k: 'config_id', v: fmt(meta.value.config_id) },
  { k: 'source', v: fmt(meta.value.source) },
  { k: 'units.oil', v: fmt(meta.value.units?.oil) },
  { k: 'units.money', v: fmt(meta.value.units?.money) },
])

// —— final_model ——
const fm = computed(() => store.finalModel)
const fmRows = computed(() => {
  const f = fm.value
  if (!f) return []
  const t = (f.training ?? {}) as Record<string, unknown>
  return [
    { k: 'kind', v: fmt(f.kind) },
    { k: 'schema_version', v: fmt(f.schema_version) },
    { k: 'generated_at', v: fmt(f.generated_at) },
    { k: '训练 n_events / n_wells', v: `${fmt(t.n_events)} / ${fmt(t.n_wells)}` },
    { k: 'anchor_rule', v: fmt(t.anchor_rule) },
    { k: 'dropout_x', v: fmt(t.dropout_x) },
    { k: 'intended_use', v: fmt(f.intended_use) },
    { k: 'provenance', v: fmt(f.provenance) },
    { k: 'legacy_audit', v: fmt(f.legacy_audit) },
  ]
})
const fmModelRows = computed(() => {
  const f = fm.value
  if (!f?.models) return []
  return Object.entries(f.models).map(([name, m]) => {
    const o = (m ?? {}) as Record<string, unknown>
    const keep = ['family', 'form', 'n_params', 'n_buckets', 'k', 'power', 'cv_folds', 'n_features_used']
    const desc = keep
      .filter((k) => o[k] !== undefined)
      .map((k) => `${k}=${fmt(o[k])}`)
      .join(' · ')
    return { name, family: fmt(o.family), form: fmt(o.form), desc }
  })
})
const limitations = computed(() => {
  const l = fm.value?.limitations
  return Array.isArray(l) ? l.map((x) => String(x)) : []
})

// —— model_diagnostics ——
const md = computed(() => store.modelDiagnostics)
const mdModelRows = computed(() => {
  const m = md.value?.models
  if (!m) return []
  return Object.entries(m).map(([name, o]) => ({
    name,
    n: o?.n ?? null,
    smape: o?.smape ?? null,
    smapeMedian: o?.smape_median ?? null,
    mae: o?.mae_m3d ?? null,
    rmse: o?.rmse_m3d ?? null,
    skill: o?.skill_vs_flat ?? null,
    spearman: o?.spearman ?? null,
  }))
})

// —— state_confusion ——
const sc = computed(() => store.stateConfusion)
const STATE_CN: Record<string, string> = {
  green: '绿 · 可判定',
  yellow: '黄 · 数据不足',
  red: '红 · 不建议（需复核）',
  gray: '灰 · 低价值低置信',
}
const scRows = computed(() => {
  const m = sc.value?.matrix
  if (!m) return []
  return (['green', 'yellow', 'red', 'gray'] as const)
    .filter((k) => m[k])
    .map((k) => {
      const x = m[k]
      return {
        key: k,
        label: STATE_CN[k] ?? k,
        n: x.n,
        good: x.n_good,
        bad: x.n_bad,
        precision: x.precision,
        median: x.act_ratio_median ?? null,
      }
    })
})
const scDist = computed(() => {
  const d = sc.value?.model_state_dist
  if (!d) return '暂无'
  return (['green', 'yellow', 'red', 'gray'] as const)
    .map((k) => `${STATE_CN[k] ?? k} ${d[k] ?? 0}`)
    .join(' · ')
})

// —— baseline_audit ——
const ba = computed(() => store.baselineAudit)
const baRows = computed(() => {
  const b = ba.value
  if (!b) return []
  const a = b.act_over_base
  return [
    { k: '基线定义', v: fmt(b.definition) },
    { k: '合并中位递减率 D', v: b.D_pool != null ? fmt(b.D_pool) : '暂无' },
    { k: 'D 回退井数 / D≤0 井数', v: `${fmt(b.n_D_fallback)} / ${fmt(b.n_D_zero)}` },
    { k: '实际/基线 中位', v: a?.median != null ? fmt(a.median) : '暂无' },
    { k: '实测基线 ≥1 占比（主文案）', v: a?.frac_ge_1 != null ? `${(a.frac_ge_1 * 100).toFixed(1)}%（n=${fmt(a.n)}）` : '暂无' },
    { k: 'p25 / p75', v: a?.p25 != null ? `${fmt(a.p25)} / ${fmt(a.p75)}` : '暂无' },
    { k: '锚点口径', v: fmt(b.anchor_source) },
    { k: '锚点最大绝对差 (m³/d)', v: b.anchor_max_abs_diff_m3d != null ? fmt(b.anchor_max_abs_diff_m3d) : '暂无' },
  ]
})

// —— intervals ——
const iv = computed(() => store.intervalPolicy)
const ivRows = computed(() => {
  const i = iv.value
  if (!i) return []
  return [
    { k: '目标覆盖率', v: fmt(i.target_coverage) },
    { k: '半宽口径', v: fmt(i.scale) },
    { k: '区间性质', v: fmt(i.kind) },
    { k: '中文角标', v: fmt(i.label_cn) },
    { k: '总点数 / 下界被截断', v: `${fmt(i.n_points_total)} / ${fmt(i.n_lower_clipped)}` },
    { k: '数学下界 > 0 的点数', v: fmt(i.n_math_lower_positive) },
    { k: 'q90（min/中位/max）', v: i.q90 ? `${fmt(i.q90.min)} / ${fmt(i.q90.median)} / ${fmt(i.q90.max)}` : '暂无' },
    { k: '停产月占比', v: i.frac_months_zero != null ? `${(i.frac_months_zero * 100).toFixed(1)}%` : '暂无' },
    { k: '为什么下界恒为 0', v: fmt(i.why) },
    { k: '换非对称共形也救不回', v: fmt(i.counterfactual_asymmetric) },
    { k: '结论', v: fmt(i.verdict) },
  ]
})
</script>

<template>
  <div style="overflow: auto; height: calc(100vh - var(--topbar-h)); padding: 10px">
    <main class="col" style="gap: 8px; max-width: 1180px">
      <section class="panel">
        <h3 class="panel-title">
          <span class="fig-no">MC-000</span><span class="fig-cap">模型卡 · 数据版本</span>
          <span class="fig-unit">只读 bundle，缺字段显示「暂无」</span>
        </h3>
        <table class="grid">
          <tbody>
            <tr v-for="r in metaRows" :key="r.k">
              <th style="width: 180px">{{ r.k }}</th>
              <td class="mono" style="overflow-wrap: anywhere">{{ r.v }}</td>
            </tr>
          </tbody>
        </table>
      </section>

      <section class="panel">
        <h3 class="panel-title">
          <span class="fig-no">MC-001</span><span class="fig-cap">交付模型（final_model）</span>
          <span class="fig-unit">参数与溯源</span>
        </h3>
        <p v-if="!fm" class="na small">暂无（bundle 未含 final_model）</p>
        <template v-else>
          <table class="grid">
            <tbody>
              <tr v-for="r in fmRows" :key="r.k">
                <th style="width: 180px">{{ r.k }}</th>
                <td class="mono" style="overflow-wrap: anywhere">{{ r.v }}</td>
              </tr>
            </tbody>
          </table>
          <div class="rule"></div>
          <div class="small muted" style="margin-bottom: 4px">模型族（参数量 / 形式）</div>
          <table class="grid">
            <thead>
              <tr><th style="width: 120px">模型</th><th style="width: 240px">family</th><th>form / 参数</th></tr>
            </thead>
            <tbody>
              <tr v-for="r in fmModelRows" :key="r.name">
                <td class="mono">{{ r.name }}</td>
                <td>{{ r.family }}</td>
                <td class="mono" style="overflow-wrap: anywhere">{{ r.desc || r.form }}</td>
              </tr>
            </tbody>
          </table>
          <div class="rule"></div>
          <div class="small muted" style="margin-bottom: 4px">使用限制</div>
          <ul v-if="limitations.length" class="caveats">
            <li v-for="(l, i) in limitations" :key="i">{{ l }}</li>
          </ul>
          <p v-else class="na small">暂无</p>
        </template>
      </section>

      <section class="panel">
        <h3 class="panel-title">
          <span class="fig-no">MC-002</span><span class="fig-cap">模型自检（留一井折外）</span>
          <span class="fig-unit">口径 {{ store.modelDiagnostics?.protocol_used ?? '暂无' }}</span>
        </h3>
        <p v-if="!md" class="na small">暂无（bundle 未含 model_diagnostics）</p>
        <template v-else>
          <div v-if="md.verdict" class="small" style="margin-bottom: 6px; overflow-wrap: anywhere">
            结论：{{ md.verdict }}
          </div>
          <div class="small dim" style="margin-bottom: 6px">
            零参数对照是否不输模型：<b>{{ md.zero_param_wins ? '是' : '否' }}</b>
          </div>
          <table class="grid">
            <thead>
              <tr>
                <th>模型</th><th>n</th><th>sMAPE</th><th>sMAPE 中位</th>
                <th>MAE (m³/d)</th><th>RMSE (m³/d)</th><th>技能分 vs 平推</th><th>Spearman</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="r in mdModelRows" :key="r.name">
                <td class="mono">{{ r.name }}</td>
                <td class="mono">{{ n(r.n, 0) }}</td>
                <td class="mono">{{ n(r.smape, 2) }}</td>
                <td class="mono">{{ n(r.smapeMedian, 2) }}</td>
                <td class="mono">{{ n(r.mae, 3) }}</td>
                <td class="mono">{{ n(r.rmse, 3) }}</td>
                <td class="mono">{{ n(r.skill, 3) }}</td>
                <td class="mono">{{ r.spearman == null ? '暂无' : n(r.spearman, 3) }}</td>
              </tr>
            </tbody>
          </table>
        </template>
      </section>

      <section class="panel">
        <h3 class="panel-title">
          <span class="fig-no">MC-003</span><span class="fig-cap">状态混淆矩阵</span>
          <span class="fig-unit">模型状态 vs 事后实际</span>
        </h3>
        <p v-if="!sc" class="na small">暂无（bundle 未含 state_confusion）</p>
        <template v-else>
          <div v-if="sc.definition" class="small" style="margin-bottom: 6px; overflow-wrap: anywhere">
            定义：{{ sc.definition }}
          </div>
          <div class="small dim" style="margin-bottom: 4px">模型判态分布：{{ scDist }}</div>
          <div class="small dim" style="margin-bottom: 6px">
            事后实际分布：good {{ sc.actual_dist?.good ?? '暂无' }} / bad {{ sc.actual_dist?.bad ?? '暂无' }}
            <template v-if="sc.coverage_of_decisions != null">
              · 决策覆盖率 {{ pct(sc.coverage_of_decisions, 1) }}
            </template>
            <template v-if="sc.accuracy_on_decided != null">
              · 已判定子集准确率 {{ pct(sc.accuracy_on_decided, 1) }}
            </template>
          </div>
          <table class="grid">
            <thead>
              <tr>
                <th>模型状态</th><th>n</th><th>事后跑赢 good</th><th>事后跑输 bad</th>
                <th>精度</th><th>实际/基线 中位</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="r in scRows" :key="r.key">
                <td>{{ r.label }}</td>
                <td class="mono">{{ n(r.n, 0) }}</td>
                <td class="mono">{{ n(r.good, 0) }}</td>
                <td class="mono">{{ n(r.bad, 0) }}</td>
                <td class="mono">{{ pct(r.precision, 1) }}</td>
                <td class="mono">{{ r.median == null ? '暂无' : n(r.median, 3) }}</td>
              </tr>
            </tbody>
          </table>
          <div class="rule"></div>
          <div class="small dim" style="margin-bottom: 4px; overflow-wrap: anywhere">
            判态门槛：{{ sc.thresholds ? fmt(sc.thresholds) : '暂无' }}
            <template v-if="sc.state_map_ok != null"> · state 可复算：{{ sc.state_map_ok ? '是' : '否' }}</template>
          </div>
          <div v-if="sc.note" class="small dim" style="margin-bottom: 6px">注：{{ sc.note }}</div>
          <div v-if="sc.red_evidence" class="small" style="overflow-wrap: anywhere">
            <div class="muted" style="margin-bottom: 2px">红态证据链</div>
            <div class="mono">{{ fmt(sc.red_evidence) }}</div>
          </div>
        </template>
      </section>

      <section class="panel">
        <h3 class="panel-title">
          <span class="fig-no">MC-004</span><span class="fig-cap">基线审计</span>
          <span class="fig-unit">纯数据事实，不含模型</span>
        </h3>
        <p v-if="!ba" class="na small">暂无（bundle 未含 baseline_audit）</p>
        <template v-else>
          <table class="grid">
            <tbody>
              <tr v-for="r in baRows" :key="r.k">
                <th style="width: 200px">{{ r.k }}</th>
                <td class="mono" style="overflow-wrap: anywhere">{{ r.v }}</td>
              </tr>
            </tbody>
          </table>
          <div v-if="ba.note" class="small dim" style="margin-top: 6px; overflow-wrap: anywhere">
            注：{{ ba.note }}
          </div>
        </template>
      </section>

      <section class="panel">
        <h3 class="panel-title">
          <span class="fig-no">MC-005</span><span class="fig-cap">90% 区间口径（intervals）</span>
          <span class="fig-unit">为什么下界恒为 0</span>
        </h3>
        <p v-if="!iv" class="na small">暂无（bundle 未含 intervals）</p>
        <template v-else>
          <table class="grid">
            <tbody>
              <tr v-for="r in ivRows" :key="r.k">
                <th style="width: 200px">{{ r.k }}</th>
                <td class="mono" style="overflow-wrap: anywhere">{{ r.v }}</td>
              </tr>
            </tbody>
          </table>
          <div v-if="iv.why_q_ge_1" class="small dim" style="margin-top: 6px; overflow-wrap: anywhere">
            为什么 q ≥ 1：{{ iv.why_q_ge_1 }}
          </div>
        </template>
      </section>
    </main>
  </div>
</template>

<style scoped>
.caveats { margin: 4px 0 0; padding-left: 18px; font-size: 12px; color: var(--muted); }
.caveats li { margin-bottom: 2px; overflow-wrap: anywhere; }
</style>
