<script setup lang="ts">
import { computed } from 'vue'
import { getBundle } from '@/data/provider'

/**
 * 证据中心 · 五张表 + KPI + 零产模型状态
 *
 * 全部只读 bundle.evidence，缺字段一律显示「暂无」，不补数、不推算。
 * 本页是"数字可溯源"的落点：每个结论都能在 pipeline/*.py 里找到生成它的代码。
 */
const bundle = getBundle() as unknown as Record<string, any>
const ev = computed(() => (bundle.evidence ?? {}) as Record<string, any>)

const cal = computed(() => ev.value.calibration ?? null)
const bt = computed(() => ev.value.backtest ?? null)
const dep = computed(() => ev.value.dependence ?? null)
const sens = computed(() => ev.value.sensitivity ?? null)
const leak = computed(() => (ev.value.leakage ?? []) as any[])
const kpi = computed(() => ev.value.kpi ?? null)
const zm = computed(() => ev.value.zero_model ?? null)

function fmt(v: any, digits = 3): string {
  if (v === null || v === undefined || v === '') return '暂无'
  if (typeof v === 'number') return Number.isFinite(v) ? v.toFixed(digits) : '暂无'
  return String(v)
}
function pctf(v: any): string {
  if (typeof v !== 'number' || !Number.isFinite(v)) return '暂无'
  return (v * 100).toFixed(1) + '%'
}

const headline = computed(() => {
  const p = bt.value?.model_percentile
  const b = cal.value?.brier_improvement
  const z = zm.value?.targets?.brier_improvement?.actual ?? b
  return {
    pctile: typeof p === 'number' ? (p * 100).toFixed(2) + '%' : '暂无',
    brier: typeof z === 'number' ? (z * 100).toFixed(1) + '%' : '暂无',
  }
})

/** 相关性让尾部恶化的倍数：|CVaR_block| / |CVaR_independent| */
const tailRatio = computed(() => {
  const a = dep.value?.block_bootstrap?.cvar5
  const b = dep.value?.independent?.cvar5
  if (typeof a !== 'number' || typeof b !== 'number' || b === 0) return '暂无'
  return (Math.abs(a) / Math.abs(b)).toFixed(2) + '×'
})
</script>

<template>
  <section class="ev">
    <header class="hero">
      <h1>证据中心</h1>
      <p class="lede">
        五张表回答五个问题：<em>模型可信吗</em> · <em>选井有用吗</em> · <em>组合风险怎么算</em> ·
        <em>结论稳不稳</em> · <em>有没有偷看答案</em>。
      </p>
      <div class="summary">
        <div class="sm">
          <span class="k">模型选井分位</span>
          <span class="v">{{ headline.pctile }}</span>
          <span class="n">全枚举 C(77,3)=73150，无抽样误差</span>
        </div>
        <div class="sm">
          <span class="k">零产模型 Brier 改善</span>
          <span class="v warn">{{ headline.brier }}</span>
          <span class="n">未达 10% 目标，见页尾披露</span>
        </div>
      </div>
    </header>

    <!-- T1 校准 -->
    <section class="block">
      <h2>T1 · 校准 <small>P（NPV&gt;0）与实际的贴合度</small></h2>
      <p v-if="!cal" class="empty">暂无</p>
      <template v-else>
        <table class="tbl">
          <thead>
            <tr><th>分组</th><th>n</th><th>基率</th><th>Brier</th><th>ECE</th><th>分箱</th></tr>
          </thead>
          <tbody>
            <tr v-for="k in ['PR', 'SI', 'overall']" :key="k">
              <td>{{ k }}</td>
              <td class="mono">{{ cal[k]?.n ?? '暂无' }}</td>
              <td class="mono">{{ fmt(cal[k]?.base_rate) }}</td>
              <td class="mono">{{ fmt(cal[k]?.brier, 4) }}</td>
              <td class="mono">{{ fmt(cal[k]?.ece, 4) }}</td>
              <td class="mono">{{ cal[k]?.bins?.length ?? '暂无' }}</td>
            </tr>
          </tbody>
        </table>
        <p class="note">
          基率基线 Brier = {{ fmt(cal.brier_baseline, 4) }}（常数预测 = 全样本正例率
          {{ fmt(cal.overall?.base_rate) }}），模型改善 {{ pctf(cal.brier_improvement) }}。
          {{ cal.bin_note ?? '' }}
        </p>
      </template>
    </section>

    <!-- T2 回测 -->
    <section class="block">
      <h2>T2 · 决策回测 <small>预算 3 口，实现 NPV 与随机对照</small></h2>
      <p v-if="!bt" class="empty">暂无</p>
      <template v-else>
        <table class="tbl">
          <thead>
            <tr><th>策略</th><th>实现 NPV（万元）</th><th>精确分位</th><th>regret</th></tr>
          </thead>
          <tbody>
            <tr v-for="p in bt.policies" :key="p.id" :class="{ strong: p.id === 'model' }">
              <td>{{ p.label ?? p.id }}</td>
              <td class="mono">{{ fmt(p.realized_mean, 2) }}</td>
              <td class="mono">{{ fmt(p.pctile_exact, 5) }}</td>
              <td class="mono">{{ fmt(p.regret, 2) }}</td>
            </tr>
          </tbody>
        </table>
        <p class="note">
          oracle = {{ fmt(bt.oracle, 2) }} 万元（{{ (bt.oracle_selected ?? []).join(' + ') }}）；
          随机 3 口中位 {{ fmt(bt.exact_enum?.median, 2) }} 万元。
          {{ bt.protocol ?? '' }}。
        </p>
      </template>
    </section>

    <!-- T3 依赖 -->
    <section class="block">
      <h2>T3 · 依赖结构 <small>独立假设 vs 共享时期因子</small></h2>
      <p v-if="!dep" class="empty">暂无</p>
      <template v-else>
        <table class="tbl">
          <thead>
            <tr><th>口径</th><th>loss_prob</th><th>CVaR₅（万元）</th><th>hit_all</th><th>hit_any</th></tr>
          </thead>
          <tbody>
            <tr>
              <td>独立同分布</td>
              <td class="mono">{{ fmt(dep.independent?.loss_prob, 4) }}</td>
              <td class="mono">{{ fmt(dep.independent?.cvar5, 1) }}</td>
              <td class="mono">{{ fmt(dep.independent?.hit_rate_all) }}</td>
              <td class="mono">{{ fmt(dep.independent?.hit_rate_any) }}</td>
            </tr>
            <tr class="strong">
              <td>共享 3 月因子</td>
              <td class="mono">{{ fmt(dep.block_bootstrap?.loss_prob, 4) }}</td>
              <td class="mono">{{ fmt(dep.block_bootstrap?.cvar5, 1) }}</td>
              <td class="mono">{{ fmt(dep.block_bootstrap?.hit_rate_all) }}</td>
              <td class="mono">{{ fmt(dep.block_bootstrap?.hit_rate_any) }}</td>
            </tr>
          </tbody>
        </table>
        <p class="note">
          {{ dep.cvar_sign_convention ?? '' }}。同期因子 ICC ≈
          {{ fmt(dep.block_bootstrap?.icc_estimate) }}，
          {{ dep.block_bootstrap?.n_blocks ?? '暂无' }} 个 3 月块，{{ dep.block_bootstrap?.n_draws ?? '暂无' }} 次抽样。
          相关性让尾部恶化 {{ tailRatio }}。
        </p>
      </template>
    </section>

    <!-- T4 敏感性 -->
    <section class="block">
      <h2>T4 · 敏感性 <small>改假设后结论会不会翻</small></h2>
      <p v-if="!sens" class="empty">暂无</p>
      <template v-else>
        <div class="grid2">
          <div class="card">
            <div class="card-t">D 截断（递减率 clip 到 0.15）</div>
            <table class="mini">
              <tr><th>范围</th><th>基线 ratio 中位</th><th>D×0.67</th><th>D×1.33</th></tr>
              <tr>
                <td>整体（{{ sens.D_clip?.overall?.n ?? '暂无' }} 井）</td>
                <td class="mono">{{ fmt(sens.D_clip?.overall?.baseline_median) }}</td>
                <td class="mono">{{ fmt(sens.D_clip?.overall?.d_scale_067) }}</td>
                <td class="mono">{{ fmt(sens.D_clip?.overall?.d_scale_133) }}</td>
              </tr>
              <tr>
                <td>顶格 14 口</td>
                <td class="mono">{{ fmt(sens.D_clip?.capped14?.baseline_median) }}</td>
                <td class="mono">{{ fmt(sens.D_clip?.capped14?.d_scale_067) }}</td>
                <td class="mono">{{ fmt(sens.D_clip?.capped14?.d_scale_133) }}</td>
              </tr>
            </table>
            <p class="tiny">{{ sens.D_clip?.capped14?.note ?? '' }}</p>
          </div>

          <div class="card">
            <div class="card-t">锚点口径</div>
            <table class="mini">
              <tr><th>口径</th><th>ratio 中位</th><th>说明</th></tr>
              <tr v-for="a in sens.anchor_mode ?? []" :key="a.mode">
                <td class="mono">{{ a.mode }}</td>
                <td class="mono">{{ fmt(a.ratio_median) }}</td>
                <td class="tiny">{{ a.note }}</td>
              </tr>
            </table>
          </div>

          <div class="card">
            <div class="card-t">油价 ±30%</div>
            <table class="mini">
              <tr><th>倍数</th><th>NPV 中位</th><th>NPV 均值</th><th>为正井数</th></tr>
              <tr v-for="p in sens.price_pm30 ?? []" :key="p.mult">
                <td class="mono">×{{ p.mult }}</td>
                <td class="mono">{{ fmt(p.npv_median, 1) }}</td>
                <td class="mono">{{ fmt(p.npv_mean, 1) }}</td>
                <td class="mono">{{ p.n_positive }}</td>
              </tr>
            </table>
          </div>

          <div class="card">
            <div class="card-t">成本 ±20%</div>
            <table class="mini">
              <tr><th>倍数</th><th>NPV 中位</th><th>NPV 均值</th><th>为正井数</th></tr>
              <tr v-for="p in sens.cost_pm20 ?? []" :key="p.mult">
                <td class="mono">×{{ p.mult }}</td>
                <td class="mono">{{ fmt(p.npv_median, 1) }}</td>
                <td class="mono">{{ fmt(p.npv_mean, 1) }}</td>
                <td class="mono">{{ p.n_positive }}</td>
              </tr>
            </table>
          </div>
        </div>
      </template>
    </section>

    <!-- T5 泄漏 -->
    <section class="block">
      <h2>T5 · 泄漏审计 <small>每个特征在事件何时可见</small></h2>
      <p v-if="!leak.length" class="empty">暂无</p>
      <table v-else class="tbl">
        <thead>
          <tr><th>特征</th><th>可见时点</th><th>用了事件后信息</th><th>判定</th></tr>
        </thead>
        <tbody>
          <tr v-for="l in leak" :key="l.feature">
            <td>{{ l.feature }}</td>
            <td class="mono">{{ l.visible_from }}</td>
            <td class="mono">{{ l.uses_post_event ? '是' : '否' }}</td>
            <td :class="l.ok ? 'ok' : 'bad'">{{ l.ok ? '通过' : '违规' }}</td>
          </tr>
        </tbody>
      </table>
    </section>

    <!-- KPI -->
    <section class="block">
      <h2>五类工程指标</h2>
      <p v-if="!kpi" class="empty">暂无</p>
      <table v-else class="tbl">
        <thead><tr><th>类别</th><th>数值</th><th>口径</th></tr></thead>
        <tbody>
          <tr v-for="(v, k) in kpi" :key="k">
            <td>{{ v.label }}</td>
            <td class="mono">{{ fmt(v.value, 3) }} <span class="dim">{{ v.unit }}</span></td>
            <td class="muted">{{ v.formula }}<span v-if="v.caveat"> · {{ v.caveat }}</span></td>
          </tr>
        </tbody>
      </table>
    </section>

    <!-- 零产模型披露 -->
    <section class="block">
      <h2>零产模型 <small>如实披露</small></h2>
      <p v-if="!zm" class="empty">暂无</p>
      <template v-else>
        <div class="verdict" :class="zm.verdict === 'ok' ? 'ok' : 'warn'">
          判定：{{ zm.verdict === 'ok' ? '达标' : '未达标（underperform）' }}
        </div>
        <table class="tbl">
          <thead><tr><th>指标</th><th>目标</th><th>实测</th><th>判定</th></tr></thead>
          <tbody>
            <tr v-for="(t, k) in zm.targets ?? {}" :key="k">
              <td>{{ k }}</td>
              <td class="mono">{{ t.target }}</td>
              <td class="mono">{{ t.actual }}</td>
              <td :class="t.pass ? 'ok' : 'bad'">{{ t.pass ? '通过' : '未达' }}</td>
            </tr>
          </tbody>
        </table>
        <p class="note">{{ zm.verdict_note }}</p>
        <p class="tiny">
          覆盖口径：{{ zm.coverage_rule }}。联合覆盖 {{ fmt(zm.coverage_joint) }}，
          条件覆盖 {{ fmt(zm.coverage_conditional) }}。
        </p>
      </template>
    </section>
  </section>
</template>

<style scoped>
.ev {
  max-width: 1080px;
  margin: 0 auto;
  padding: 28px 24px 72px;
  color: var(--text);
}
.hero {
  padding-bottom: 18px;
  border-bottom: 1px solid var(--line);
}
h1 {
  margin: 0 0 10px;
  font-size: 25px;
}
.lede {
  font-size: 14px;
  line-height: 1.8;
  color: var(--muted);
  margin: 0 0 16px;
}
.lede em {
  color: var(--sand);
  font-style: normal;
}
.summary {
  display: flex;
  gap: 14px;
  flex-wrap: wrap;
}
.sm {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 4px;
  padding: 12px 16px;
  min-width: 240px;
}
.sm .k {
  display: block;
  font-size: 11px;
  color: var(--dim);
  letter-spacing: 0.06em;
}
.sm .v {
  display: block;
  font-size: 22px;
  color: var(--sand);
  font-family: var(--mono, monospace);
  margin: 4px 0 2px;
}
.sm .v.warn {
  color: var(--oxide-lt);
}
.sm .n {
  font-size: 11px;
  color: var(--dim);
}
.block {
  margin-top: 32px;
}
h2 {
  font-size: 15px;
  color: var(--sand);
  margin: 0 0 12px;
  letter-spacing: 0.06em;
  font-weight: 600;
}
h2 small {
  font-size: 11px;
  color: var(--dim);
  font-weight: 400;
  margin-left: 8px;
  letter-spacing: 0;
}
.tbl,
.mini {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}
.tbl th,
.tbl td,
.mini th,
.mini td {
  text-align: left;
  padding: 8px 10px;
  border-bottom: 1px solid var(--line-soft);
  vertical-align: top;
}
.tbl thead th,
.mini th {
  color: var(--dim);
  font-size: 11px;
  border-bottom: 1px solid var(--line);
  font-weight: 500;
}
.strong td {
  color: var(--sand);
}
.mono {
  font-family: var(--mono, ui-monospace, monospace);
  color: var(--steel);
}
.muted {
  color: var(--muted);
  font-size: 12px;
}
.dim {
  color: var(--dim);
  font-size: 11px;
}
.tiny {
  font-size: 11px;
  color: var(--dim);
  margin: 6px 0 0;
  line-height: 1.6;
}
.note {
  font-size: 12px;
  color: var(--muted);
  margin: 8px 0 0;
  line-height: 1.7;
}
.grid2 {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 12px;
}
.card {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 4px;
  padding: 12px 14px;
}
.card-t {
  font-size: 12px;
  color: var(--steel);
  margin-bottom: 8px;
}
.ok {
  color: var(--green);
}
.bad {
  color: var(--red);
}
.verdict {
  display: inline-block;
  padding: 4px 12px;
  border-radius: 3px;
  font-size: 12px;
  margin-bottom: 10px;
}
.verdict.warn {
  background: rgba(180, 85, 45, 0.16);
  color: var(--oxide-lt);
  border: 1px solid var(--oxide-dim);
}
.verdict.ok {
  background: rgba(95, 158, 120, 0.15);
  color: var(--green);
  border: 1px solid var(--green);
}
.empty {
  color: var(--dim);
  font-size: 12px;
  padding: 10px 0;
}
@media (max-width: 900px) {
  .grid2 {
    grid-template-columns: 1fr;
  }
}
</style>
