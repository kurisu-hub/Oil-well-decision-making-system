<script setup lang="ts">
import { computed, ref } from 'vue'
import { NButton, NDrawer, NDrawerContent, NSwitch, NTag } from 'naive-ui'
import type { ChartOption } from '@/composables/useEcharts'
import EChart from '@/components/EChart.vue'
import EmptyValue from '@/components/EmptyValue.vue'
import IllustrativeBadge from '@/components/IllustrativeBadge.vue'
import { useAppStore } from '@/stores/app'
import { n, pct } from '@/utils/format'

const store = useAppStore()

// —— VOI（真实数据）——
const voiRows = computed(() =>
  [...(store.vois ?? [])]
    .map((v) => ({ ...v, well: store.wellById(v.well_id) }))
    .sort((a, b) => (b.net_benefit ?? -Infinity) - (a.net_benefit ?? -Infinity)),
)

// —— 学习曲线（示意 / 暂无）——
const lcOption = computed<ChartOption>(() => {
  const lc = store.learningCurve
  if (!lc?.available) return {}
  return {
    animationDuration: 300,
    grid: { left: 56, right: 18, top: 18, bottom: 34 },
    tooltip: { trigger: 'axis' },
    xAxis: {
      type: 'category',
      data: lc.points.map((p) => p.n_train),
      name: lc.x_label,
      nameLocation: 'middle',
      nameGap: 22,
      axisLabel: { color: '#8fa3bf', fontSize: 10 },
    },
    yAxis: {
      type: 'value',
      name: lc.y_label,
      axisLabel: { formatter: (v: number) => (v * 100).toFixed(0) + '%', color: '#8fa3bf', fontSize: 10 },
      splitLine: { lineStyle: { color: '#22304d' } },
    },
    series: [
      {
        type: 'line',
        data: lc.points.map((p) => p.smape),
        smooth: true,
        symbolSize: 6,
        lineStyle: { color: '#5aa9e6', width: 2.5 },
        itemStyle: { color: '#5aa9e6' },
        areaStyle: { color: 'rgba(90,169,230,0.14)' },
      },
    ],
  }
})

// —— 历史回放（示意 / 暂无）——
const btOption = computed<ChartOption>(() => {
  const bt = store.backtest
  if (!bt?.available) return {}
  return {
    animationDuration: 300,
    grid: { left: 56, right: 18, top: 24, bottom: 34 },
    legend: { top: 0, textStyle: { color: '#8fa3bf', fontSize: 11 }, itemHeight: 8 },
    tooltip: { trigger: 'axis' },
    xAxis: {
      type: 'category',
      data: bt.items.map((i) => i.period),
      axisLabel: { color: '#8fa3bf', fontSize: 10 },
    },
    yAxis: { type: 'value', splitLine: { lineStyle: { color: '#22304d' } }, axisLabel: { color: '#8fa3bf', fontSize: 10 } },
    series: [
      { name: '系统', type: 'bar', data: bt.items.map((i) => i.system), itemStyle: { color: '#5aa9e6' } },
      { name: '实际', type: 'bar', data: bt.items.map((i) => i.actual), itemStyle: { color: '#2fbf71' } },
      { name: '老师傅', type: 'bar', data: bt.items.map((i) => i.expert), itemStyle: { color: '#c9a36a' } },
    ],
  }
})

// —— 规律消融 ——
const ablationRows = computed(() => store.ablation?.available ? store.ablation.variants : [])
const rhoOn = computed(() => ablationRows.value.find((v) => v.rho_on) ?? null)
const rhoOff = computed(() => ablationRows.value.find((v) => !v.rho_on) ?? null)

// —— 协议抽屉 ——
const protocolOpen = ref(false)
</script>

<template>
  <div class="layout">
    <aside class="col no-print">
      <section class="panel">
        <h3 class="panel-title">数据卡</h3>
        <div class="col small">
          <div class="row"><span class="grow muted">数据集</span><span class="mono">{{ store.meta.dataset_id }}</span></div>
          <div class="row"><span class="grow muted">模型版本</span><span class="mono">{{ store.meta.model_version }}</span></div>
          <div class="row"><span class="grow muted">配置号</span><span class="mono">{{ store.meta.config_id }}</span></div>
          <div class="row"><span class="grow muted">数据来源</span><span>{{ store.meta.source }}</span></div>
          <div class="row"><span class="grow muted">样本</span><span>{{ store.meta.n_wells }} 井 / {{ store.meta.n_events }} 事件</span></div>
          <div class="row"><span class="grow muted">单位</span><span>{{ store.meta.units.oil }} · {{ store.meta.units.money }}</span></div>
          <div class="row"><span class="grow muted">生成时间</span><span class="mono">{{ store.meta.generated_at }}</span></div>
        </div>
        <div style="margin-top: 8px" class="small muted">Caveats</div>
        <ul class="caveats">
          <li v-for="c in store.meta.caveats" :key="c">{{ c }}</li>
        </ul>
        <div style="margin-top: 8px">
          <NButton size="tiny" @click="$router.push('/model-card')">
            模型卡 / 状态混淆矩阵 →
          </NButton>
        </div>
      </section>

      <section class="panel">
        <h3 class="panel-title">契约校验</h3>
        <div v-if="store.issues.length" class="col small">
          <div v-for="(it, i) in store.issues" :key="i" class="row">
            <NTag size="tiny" :bordered="false" :type="it.level === 'error' ? 'error' : 'warning'">
              {{ it.level }}
            </NTag>
            <span class="grow">{{ it.message }}</span>
          </div>
        </div>
        <div v-else class="na small">暂无异常</div>
      </section>

      <NButton size="small" block @click="protocolOpen = true">打开实验协议抽屉（R1–R10 / QC）</NButton>
    </aside>

    <main class="col" style="overflow: auto">
      <!-- VOI：真实数据 -->
      <section class="panel">
        <h3 class="panel-title">信息价值 VOI（补资料排序）</h3>
        <table class="grid">
          <thead>
            <tr>
              <th>井</th><th>成本（{{ store.meta.units.money }}）</th><th>翻绿概率</th>
              <th>期望收益</th><th>净收益</th><th>建议</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="v in voiRows" :key="v.well_id">
              <td>
                <span class="mono">{{ v.well_id }}</span>
                <span class="muted small"> {{ v.well?.name ?? '' }}</span>
                <IllustrativeBadge v-if="store.illustrativeWell(v.well_id)" />
              </td>
              <td class="num">{{ n(v.cost, 1) }}</td>
              <td class="num">{{ pct(v.flip_prob) }}</td>
              <td class="num">{{ n(v.expected_benefit, 1) }}</td>
              <td class="num" :style="{ color: (v.net_benefit ?? 0) > 0 ? 'var(--green)' : 'var(--red)' }">
                {{ n(v.net_benefit, 1) }}
              </td>
              <td>
                <NTag size="small" :bordered="false" :type="v.recommended ? 'success' : 'default'">
                  {{ v.recommended ? '补' : '不补' }}
                </NTag>
              </td>
            </tr>
            <tr v-if="!voiRows.length"><td colspan="6" class="na">暂无</td></tr>
          </tbody>
        </table>
        <div v-if="!voiRows.some((v) => v.available)" class="na small" style="margin-top: 6px">
          全部 VOI 条目 available:false → 显示“暂无”
        </div>
      </section>

      <!-- 学习曲线：示意 / 暂无 -->
      <section class="panel">
        <h3 class="panel-title">
          学习曲线（训练规模 — sMAPE）
          <IllustrativeBadge v-if="store.illustrativeBlock('learning_curve')" />
          <span v-else class="na small">暂无</span>
        </h3>
        <template v-if="store.learningCurve?.available">
          <EChart :option="lcOption" :height="220" />
          <div class="small muted">sMAPE 随训练井数下降：{{ store.learningCurve.points.map((p) => pct(p.smape)).join(' → ') }}</div>
        </template>
        <div v-else class="na" style="padding: 28px 0; text-align: center">
          暂无 · 等待模型侧产出 learning_curve 字段（契约 v1.1 拟新增）
        </div>
      </section>

      <!-- 历史回放：示意 / 暂无 -->
      <section class="panel">
        <h3 class="panel-title">
          历史回放（系统 vs 实际 vs 老师傅）
          <IllustrativeBadge v-if="store.illustrativeBlock('backtest')" />
          <span v-else class="na small">暂无</span>
        </h3>
        <template v-if="store.backtest?.available">
          <EChart :option="btOption" :height="220" />
          <div class="small muted">单位：{{ store.backtest.unit }}</div>
        </template>
        <div v-else class="na" style="padding: 28px 0; text-align: center">
          暂无 · 等待模型侧产出 backtest 字段（契约 v1.1 拟新增）
        </div>
      </section>

      <!-- 规律消融：示意 / 暂无 -->
      <section class="panel">
        <h3 class="panel-title">
          规律消融（ρ 开 / 关）
          <IllustrativeBadge v-if="store.illustrativeBlock('ablation')" />
          <span v-else class="na small">暂无</span>
        </h3>
        <template v-if="ablationRows.length">
          <div class="row">
            <NSwitch :value="true" disabled />
            <span class="small muted">当前展示全部变体；ρ 对比见下表</span>
          </div>
          <table class="grid" style="margin-top: 6px">
            <thead><tr><th>变体</th><th>ρ</th><th>sMAPE</th><th>命中率</th></tr></thead>
            <tbody>
              <tr v-for="v in ablationRows" :key="v.id">
                <td>{{ v.label }}</td>
                <td>{{ v.rho_on ? '开' : '关' }}</td>
                <td class="num">{{ pct(v.smape) }}</td>
                <td class="num">{{ pct(v.hit_rate) }}</td>
              </tr>
            </tbody>
          </table>
          <div v-if="rhoOn && rhoOff" class="small muted" style="margin-top: 6px">
            关闭 ρ：sMAPE {{ pct(rhoOff.smape) }} vs 开启 {{ pct(rhoOn.smape) }}，命中率
            {{ pct(rhoOff.hit_rate) }} vs {{ pct(rhoOn.hit_rate) }}。
          </div>
        </template>
        <div v-else class="na" style="padding: 28px 0; text-align: center">
          暂无 · 等待模型侧产出 ablation 字段（契约 v1.1 拟新增）
        </div>
      </section>
    </main>

    <!-- 协议抽屉 -->
    <NDrawer v-model:show="protocolOpen" :width="520" placement="right">
      <NDrawerContent title="实验协议 R1–R10 / QC 漏斗" closable>
        <template v-if="store.protocol?.available">
          <IllustrativeBadge />
          <div class="col">
            <div v-for="r in store.protocol.rules" :key="r.id" class="rule">
              <div class="row">
                <span class="mono small">{{ r.id }}</span>
                <span class="grow small">{{ r.title }}</span>
                <NTag size="tiny" :bordered="false" :type="r.status === 'pass' ? 'success' : 'default'">
                  {{ r.status }}
                </NTag>
              </div>
              <div class="small muted">{{ r.detail }}</div>
            </div>
          </div>
          <h4 class="small muted" style="margin: 12px 0 4px">QC 漏斗</h4>
          <table class="grid">
            <thead><tr><th>阶段</th><th>进入</th><th>留存</th></tr></thead>
            <tbody>
              <tr v-for="q in store.protocol.qc" :key="q.stage">
                <td>{{ q.stage }}</td>
                <td class="num">{{ n(q.n_in) }}</td>
                <td class="num">{{ n(q.n_out) }}</td>
              </tr>
            </tbody>
          </table>
        </template>
        <div v-else class="na">暂无 · 等待模型侧产出 protocol 字段（契约 v1.1 拟新增）</div>
      </NDrawerContent>
    </NDrawer>
  </div>
</template>

<style scoped>
.caveats { margin: 4px 0 0; padding-left: 18px; font-size: 12px; color: var(--muted); }

/* 数据卡：model_version / dataset_id 这类长值会把左侧标签挤到 7px → 一字一行。
   改法：标签不参与伸缩，让长值自己折行，整行允许换行。 */
.col.small > .row { flex-wrap: wrap; }
.col.small > .row > .grow.muted { flex: 0 0 auto; }
.col.small > .row > span:last-child { min-width: 0; overflow-wrap: anywhere; }
.rule {
  border: 1px solid var(--line);
  border-radius: var(--radius);
  padding: 6px 8px;
  background: var(--panel-2);
}
</style>
