<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { NButton, NSelect, NSlider, NSwitch } from 'naive-ui'
import { useRouter } from 'vue-router'
import { useAppStore } from '@/stores/app'
import HeroScene from '@/components/HeroScene.vue'
import Scene3D from '@/components/Scene3D.vue'
import { buildScene } from '@/three/buildScene'
import WellDetail from '@/components/WellDetail.vue'
import WorkerInfer from '@/components/WorkerInfer.vue'
import WorldLine from '@/components/WorldLine.vue'
import ScenarioBar from '@/components/ScenarioBar.vue'
import PortfolioCockpit from '@/components/PortfolioCockpit.vue'
import VoiConsole from '@/components/VoiConsole.vue'
import UncertaintyFingerprint from '@/components/UncertaintyFingerprint.vue'
import EvidenceChain from '@/components/EvidenceChain.vue'
import EmptyValue from '@/components/EmptyValue.vue'
import IllustrativeBadge from '@/components/IllustrativeBadge.vue'
import { n, pct } from '@/utils/format'
import type { Well } from '@/types/bundle'

const store = useAppStore()
const router = useRouter()

/**
 * A1：首页必须在 3 s 内出现 WebGL 场景。
 * 做法不是把整页改成 3D，而是让 hero 区在「2.5D 剖面 / 3D 井场」间切换，
 * 默认选 3D（有 WebGL 时），2.5D 作为无 WebGL 的降级。
 * 3D 代码仍与主包同源（单文件构建无法网络懒加载），但首屏不阻塞：
 * Scene3D 只在 heroMode==='3d' 时挂载，挂载时才创建 WebGL 上下文。
 */
function hasWebGL(): boolean {
  try {
    const c = document.createElement('canvas')
    return !!(c.getContext('webgl2') || c.getContext('webgl'))
  } catch {
    return false
  }
}
const heroMode = ref<'2d' | '3d'>(hasWebGL() ? '3d' : '2d')
const heroScene = computed(() =>
  buildScene(
    { wells: store.wells, curves: store.curves, geo: store.geo } as unknown as Record<string, any>,
    { level: 'L0' },
  ),
)

const stateOptions = [
  { label: '可判定（绿）', value: 'green' },
  { label: '数据不足（黄）', value: 'yellow' },
  { label: '不建议（红）', value: 'red' },
  { label: '低价值低置信（灰）', value: 'gray' },
]
const bucketOptions = computed(() => store.buckets.map((b) => ({ label: b, value: b })))
/** C2：目标选项按数据集实有组合点置灰，选不到「无点目标」就不会出死路 */
const objectiveOptions = computed(() =>
  [
    { label: '最大 NPV', value: 'npv' },
    { label: '最大增油', value: 'oil' },
    { label: '最大 ROI', value: 'roi' },
    { label: '最小风险', value: 'risk' },
  ].map((o) => ({
    ...o,
    disabled: !store.objectivesAvailable.has(o.value),
    label: store.objectivesAvailable.has(o.value) ? o.label : `${o.label}（本数据集无组合点）`,
  })),
)

const stateMeta: Record<string, { label: string; cls: string }> = {
  green: { label: '可判定', cls: 'badge-green' },
  yellow: { label: '数据不足', cls: 'badge-yellow' },
  red: { label: '不建议', cls: 'badge-red' },
  gray: { label: '低价值低置信', cls: 'badge-gray' },
}

/** 四象限口径 = bundle 的 well.state（模型侧按 12 个月累计量经验分布判），前端不现算 */
// 象限语义（收口口径，与 store.quadrantOf 的注释一致）：
//   绿 = 模型可判定子集（P(累计>基线)≥70% 且 NPV>0）
//   黄 = 数据不足（方向未定 / 价值在死区内）
//   红 = 不建议（模型判红，需复核：P(NPV>0)≤30%，即 ≥70% 把握亏钱）
//   灰 = 低价值低置信（证据不足，不下注）
const quadCards = computed(() => [
  { key: 'green', label: '可判定', hint: '模型可判定子集 · P(累计>基线)≥70% 且 NPV>0', wells: store.quadrantGroups.green },
  { key: 'yellow', label: '数据不足', hint: '方向未定 / 价值在死区内 · 补资料后再判', wells: store.quadrantGroups.yellow },
  { key: 'red', label: '不建议（需复核）', hint: '模型判红 · P(NPV>0)≤30%（≥70% 把握亏钱）', wells: store.quadrantGroups.red },
  { key: 'gray', label: '低价值低置信', hint: '证据不足 · 不下注', wells: store.quadrantGroups.gray },
])

/** 事后对照（模型状态 vs 实际跑赢/跑输基线）：有就诚实摆出来 */
const confusionLine = computed(() => {
  const c = store.stateConfusion
  if (!c?.matrix) return null
  const m = c.matrix
  const fmt = (k: 'green' | 'yellow' | 'red' | 'gray') => {
    const x = m[k]
    if (!x) return null
    return `${k === 'green' ? '绿' : k === 'yellow' ? '黄' : k === 'red' ? '红' : '灰'} ${x.n}（事后跑赢 ${x.n_good} / 跑输 ${x.n_bad}，精度 ${(x.precision * 100).toFixed(1)}%）`
  }
  const parts = (['green', 'yellow', 'red', 'gray'] as const).map(fmt).filter(Boolean)
  return parts.join(' · ')
})
/** 纯数据事实：实际/基线（不含模型），决策层的经验底线 */
const empiricalLine = computed(() => {
  const a = store.baselineAudit?.act_over_base
  if (!a) return null
  // 主文案口径：这是**实测**基线事实（实际/基线 ≥1 的占比），不是模型推荐
  return `实测基线：实际累计/基线累计 中位 ${a.median.toFixed(3)}，${(a.frac_ge_1 * 100).toFixed(1)}% ≥1（n=${a.n}，纯数据事实，不含模型）`
})

const focus = computed(() => store.focusWell)

const kpis = computed(() => [
  { k: '可判定', v: store.kpi.green, c: 'var(--green)', u: '' as string, prov: 'x_kpi_green' },
  { k: '数据不足', v: store.kpi.yellow, c: 'var(--yellow)', u: '', prov: 'x_kpi_yellow' },
  { k: '不建议', v: store.kpi.red, c: 'var(--red)', u: '', prov: 'x_kpi_red' },
  { k: '低价值低置信', v: store.kpi.gray, c: 'var(--gray)', u: '', prov: 'x_kpi_gray' },
  { k: '预算缺口', v: n(store.kpi.budgetGap, 0), c: 'var(--text)', u: store.meta.units.money as string, prov: 'x_kpi_budget_gap' },
])

/** 组合表驱动井组：改预算/风险/目标 → 命中 point → 井组、井区高亮、前沿同步 */
const planFromTable = ref(true)
watch(
  () => store.activePoint,
  (p) => {
    if (!planFromTable.value || !p) return
    const ids = (p.selected ?? []).filter((id) => store.wells.some((w) => w.well_id === id))
    if (ids.length) store.selectedWellIds = [...ids]
  },
  { immediate: true },
)

/** 手动改井组（第三幕联动）时，允许临时脱离组合表 */
function detachTable() {
  planFromTable.value = false
}

function focusOn(w: Well) {
  store.setFocus(w.well_id)
}
function clearPlan() {
  store.selectedWellIds = []
}
function openWell(id: string) {
  router.push(`/well/${id}`)
}
</script>

<template>
  <div class="cockpit">
    <!-- ============ 左：控制轨 ============ -->
    <aside class="area-rail col no-print">
      <section class="panel">
        <h3 class="panel-title">
          <span class="fig-no">DWG-COMP-002</span>
          <span class="fig-cap">控制轨 · 工况假设</span>
        </h3>
        <div class="col">
          <!-- 预算 / 风险：按 bundle 真实档位分档，保证每次点击都命中查表 -->
          <div class="ctl">
            <div class="ctl-head">
              <span>预算档（portfolio 实有）</span
              ><span class="val">{{ store.assumptions.budget }}</span
              ><span class="unit">{{ store.meta.units.money }}</span>
            </div>
            <div v-if="store.BUDGET_TICKS.length" class="row ticks-row">
              <button
                v-for="t in store.BUDGET_TICKS"
                :key="'b' + t"
                class="tickbtn mono"
                :class="{ on: store.assumptions.budget === t }"
                @click="store.assumptions.budget = t"
              >
                {{ t }}
              </button>
            </div>
            <NSlider v-else v-model:value="store.assumptions.budget" :min="0" :max="600" :step="15" />
          </div>
          <div class="ctl">
            <div class="ctl-head">
              <span>风险档（{{ store.RISK_TICKS.length }} 档 · 拖动就近吸附）</span
              ><span class="val">{{ store.assumptions.risk.toFixed(2) }}</span>
            </div>
            <div v-if="store.RISK_TICKS.length && store.RISK_TICKS.length <= 12" class="row ticks-row">
              <button
                v-for="t in store.RISK_TICKS"
                :key="'r' + t"
                class="tickbtn mono"
                :class="{ on: store.assumptions.risk === t }"
                @click="store.assumptions.risk = t"
              >
                {{ t.toFixed(2) }}
              </button>
            </div>
            <NSlider
              v-else-if="store.RISK_TICKS.length"
              :value="store.assumptions.risk"
              :min="store.RISK_TICKS[0]"
              :max="store.RISK_TICKS[store.RISK_TICKS.length - 1]"
              :step="(store.RISK_TICKS[store.RISK_TICKS.length - 1] - store.RISK_TICKS[0]) / 500"
              :format-tooltip="(v: number) => v.toFixed(1)"
              @update:value="(v: number) => store.setRiskSnapped(v)"
            />
            <NSlider v-else v-model:value="store.assumptions.risk" :min="0" :max="1" :step="0.05" />
          </div>
          <div class="ctl">
            <div class="ctl-head"><span>优化目标</span></div>
            <NSelect v-model:value="store.assumptions.objective" :options="objectiveOptions" size="small" />
          </div>
          <div class="ctl">
            <div class="ctl-head">
              <span>油价（3 档 · 预计算网格）</span
              ><span class="val">{{ store.assumptions.oilPrice }}</span
              ><span class="unit">元/t</span>
            </div>
            <div v-if="store.PRICE_TICKS.length" class="row ticks-row">
              <button
                v-for="t in store.PRICE_TICKS"
                :key="'p' + t"
                class="tickbtn mono"
                :class="{ on: store.assumptions.oilPrice === t }"
                @click="store.setPriceSnapped(t)"
              >
                {{ t }}
              </button>
            </div>
            <NSlider
              v-else
              :value="store.assumptions.oilPrice"
              :min="2000"
              :max="6000"
              :step="100"
              @update:value="(v: number) => store.setPriceSnapped(v)"
            />
          </div>
          <div class="ctl">
            <div class="ctl-head">
              <span>单井成本（3 档 · 预计算网格）</span
              ><span class="val">{{ store.assumptions.cost }}</span
              ><span class="unit">{{ store.meta.units.money }}</span>
            </div>
            <div v-if="store.COST_TICKS.length" class="row ticks-row">
              <button
                v-for="t in store.COST_TICKS"
                :key="'c' + t"
                class="tickbtn mono"
                :class="{ on: store.assumptions.cost === t }"
                @click="store.setCostSnapped(t)"
              >
                {{ t }}
              </button>
            </div>
            <NSlider
              v-else
              :value="store.assumptions.cost"
              :min="20"
              :max="80"
              :step="5"
              @update:value="(v: number) => store.setCostSnapped(v)"
            />
          </div>
          <!-- C2 · 就近吸附提示：非刻度/越界输入被吸附时明示，不出「暂无」死路 -->
          <div v-if="store.assumptionSnap.snapped" class="snap-hint" role="status">
            {{ store.assumptionSnap.reason }}
          </div>
          <div class="row wrap" style="gap: 5px">
            <span class="stamp stamp-assump">假设不写回 bundle</span>
            <span v-if="store.economicsTouched" class="stamp stamp-assump">
              经济值查表 {{ store.GRID_VERSION }} · {{ store.GRID_META.generatedAt }}
            </span>
          </div>
        </div>
      </section>

      <section class="panel">
        <h3 class="panel-title">
          <span class="fig-no">DWG-COMP-002A</span><span class="fig-cap">筛选 · 井集</span>
        </h3>
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
          <div class="row small dim mono">
            <span>HIT</span>
            <span class="grow"></span>
            <span>{{ store.filteredWells.length }} / {{ store.wells.length }}</span>
          </div>
        </div>
      </section>

      <section class="panel">
        <h3 class="panel-title">
          <span class="fig-no">DWG-COMP-002B</span><span class="fig-cap">象限阈值</span>
        </h3>
        <div class="small muted" style="margin-bottom: 4px">
          仅作敏感度探索（散点图辅助线 / bundle 缺 state 时的兜底），<b>不改变</b>四象限——状态由模型侧给出。
        </div>
        <div class="col">
          <div class="ctl">
            <div class="ctl-head">
              <span>NPV 阈值</span><span class="val">{{ store.npvThreshold }}</span
              ><span class="unit">{{ store.meta.units.money }}</span>
            </div>
            <NSlider v-model:value="store.npvThreshold" :min="-120" :max="160" :step="5" />
          </div>
          <div class="ctl">
            <div class="ctl-head">
              <span>置信阈值</span
              ><span class="val">{{ (store.confThreshold * 100).toFixed(0) }}%</span>
            </div>
            <NSlider v-model:value="store.confThreshold" :min="0" :max="1" :step="0.05" />
          </div>
        </div>
      </section>

      <section class="panel">
        <h3 class="panel-title">
          <span class="fig-no">DWG-COMP-002C</span><span class="fig-cap">方案井组</span>
          <span class="fig-unit">N={{ store.selectedWellIds.length }}</span>
        </h3>
        <div class="row wrap" style="gap: 4px">
          <span v-if="!store.selectedWellIds.length" class="na small">暂无（未选井）</span>
          <span v-for="id in store.selectedWellIds" :key="id" class="chip mono" @click="openWell(id)">
            {{ id }}
          </span>
        </div>
        <div class="row" style="margin-top: 6px">
          <NSwitch v-model:value="planFromTable" size="small" @update:value="() => {}" />
          <span class="small dim">组合表驱动</span>
          <span class="grow"></span>
          <NButton size="tiny" @click="clearPlan(); detachTable()">清空</NButton>
        </div>
        <div class="row" style="margin-top: 4px">
          <span class="grow"></span>
          <NButton size="tiny" type="primary" @click="router.push('/portfolio')">→ 措施会结算</NButton>
        </div>
      </section>

      <VoiConsole />
    </aside>

    <!-- ============ 中：英雄场景 ============ -->
    <main class="area-hero">
      <section class="panel hero-panel">
        <h3 class="panel-title">
          <span class="fig-no">DWG-COMP-001</span>
          <span class="fig-cap">{{ heroMode === '3d' ? '井区三维沙盘' : '井区地质剖面 · 2.5D' }}</span>
          <span class="hero-switch">
            <button class="tickbtn mono" :class="{ on: heroMode === '2d' }" @click="heroMode = '2d'">2.5D</button>
            <button class="tickbtn mono" :class="{ on: heroMode === '3d' }" @click="heroMode = '3d'">3D</button>
            <button class="tickbtn mono" @click="router.push('/scene')">全屏 →</button>
          </span>
          <span class="fig-unit">{{ store.meta.units.oil }} · {{ store.meta.units.money }}</span>
        </h3>
        <div class="hero-body">
          <div class="row mode-row">
            <span class="small dim">井区填充口径</span>
            <button
              class="tickbtn mono"
              :class="{ on: store.npvMode === 'bundle' }"
              @click="store.npvMode = 'bundle'"
            >
              bundle 原值
            </button>
            <button
              class="tickbtn mono"
              :class="{ on: store.npvMode === 'adj' }"
              @click="store.npvMode = 'adj'"
            >
              按工况查表（网格）
            </button>
            <span class="grow"></span>
            <span v-if="store.npvMode === 'adj' && !store.economicsTouched" class="stamp stamp-live">
              参考工况下 ≡ 原值
            </span>
            <span v-else-if="store.npvMode === 'adj'" class="stamp stamp-assump">
              {{ store.assumptions.oilPrice }} 元/t · {{ store.assumptions.cost }}
              {{ store.meta.units.money }}
            </span>
          </div>
          <div class="scene-slot">
            <Scene3D v-if="heroMode === '3d'" class="scene-main" :scene="heroScene" />
            <HeroScene v-else class="scene-main" :wells="store.filteredWells" />
            <WellDetail class="scene-detail" />
          </div>
          <div class="kpi-strip">
            <div v-for="k in kpis" :key="k.k" class="kpi">
              <div class="kpi-k">{{ k.k }}</div>
              <div class="kpi-v" :style="{ color: k.c }" :data-prov="k.prov" :data-prov-title="k.k + ' · 数字溯源'">
                {{ k.v }}<span v-if="k.u" class="unit">{{ k.u }}</span>
              </div>
            </div>
          </div>
          <PortfolioCockpit />
        </div>
      </section>
    </main>

    <!-- ============ 右：决策档案 ============ -->
    <aside class="area-dossier col no-print">
      <section class="panel">
        <h3 class="panel-title">
          <span class="fig-no">DWG-COMP-005</span><span class="fig-cap">决策卡 · 焦点井</span>
        </h3>
        <template v-if="focus">
          <div class="row wrap">
            <strong class="grow">{{ focus.name }}</strong>
            <span class="badge" :class="stateMeta[focus.state]?.cls">{{ stateMeta[focus.state]?.label }}</span>
            <IllustrativeBadge v-if="store.illustrativeWell(focus.well_id)" />
          </div>
          <div class="row small dim mono" style="margin-top: 2px">
            <span>{{ focus.well_id }}</span><span class="grow"></span><span>API {{ focus.api }}</span>
          </div>
          <div class="rule"></div>
          <dl class="kv">
            <dt>锚点（压前日产）</dt>
            <dd :data-prov="`p_anchor_${focus.well_id}`" :data-prov-title="focus.well_id + ' · 锚点'">
              {{ n(focus.anchor, 2) }} {{ store.meta.units.oil }}
            </dd>
            <dt>当前日产</dt>
            <dd>{{ n(focus.current_oil, 2) }} {{ store.meta.units.oil }}</dd>
            <dt>期望 NPV</dt>
            <dd
              :style="{ color: (focus.value_npv ?? 0) > 0 ? 'var(--green)' : 'var(--red)' }"
              :data-prov="`p_npv_${focus.well_id}`"
              :data-prov-title="focus.well_id + ' · 期望 NPV'"
            >
              <EmptyValue :value="focus.value_npv" :digits="2" /> {{ store.meta.units.money }}
            </dd>
            <dt>12 月增油</dt>
            <dd><EmptyValue :value="focus.value_oil" :digits="1" /></dd>
            <dt>ROI</dt>
            <dd><EmptyValue :value="focus.roi" :digits="2" /></dd>
            <dt>置信度 P(NPV&gt;0)</dt>
            <dd :data-prov="`p_conf_${focus.well_id}`" :data-prov-title="focus.well_id + ' · 置信度'">
              {{ pct(focus.confidence, 0) }}
            </dd>
            <dt>建议动作</dt>
            <dd>{{ focus.recommended_action || '暂无' }}</dd>
          </dl>
          <div class="row" style="margin-top: 6px">
            <NButton size="tiny" @click="openWell(focus.well_id)">↗ 单井决策卡</NButton>
            <span class="grow"></span>
            <NButton size="tiny" @click="store.openPassport(focus.passport_ids ?? [], focus.well_id + ' 数字护照')">
              数字护照
            </NButton>
          </div>
        </template>
        <div v-else class="na small">暂无（无焦点井）</div>
      </section>

      <!-- T04（A2）：新井试算 · Worker 前端推理 -->
      <WorkerInfer />

      <section class="panel">
        <h3 class="panel-title">
          <span class="fig-no">DWG-COMP-006</span><span class="fig-cap">四象限清单</span>
          <span class="fig-unit">状态 = bundle model state</span>
        </h3>
        <div class="small muted" style="margin-bottom: 4px">
          判态在模型侧完成（12 个月累计量经验分布），前端只读不现算。
          <span v-if="store.stateSource === 'local'" class="na">（本批缺 state，已退回前端口径）</span>
        </div>
        <div v-if="store.zeroParamWins" class="na small" style="margin-bottom: 4px">
          ⚠ 模型自检：零参数对照（平推）在这批事件上不输任何模型 → 本页状态只作候选排序，<b>不作为自动推荐</b>；
          决策层请用下面的实测基线。
        </div>
        <div v-if="confusionLine" class="small dim" style="margin-bottom: 4px">混淆矩阵：{{ confusionLine }}</div>
        <div v-if="empiricalLine" class="small" style="margin-bottom: 4px">
          <b>{{ empiricalLine }}</b>
        </div>
        <div class="col" style="gap: 6px">
          <div v-for="q in quadCards" :key="q.key" class="quad">
            <div class="row">
              <span class="badge" :class="`badge-${q.key}`">{{ q.label }}</span>
              <span class="small dim grow">{{ q.hint }}</span>
              <span class="mono small">{{ q.wells.length }}</span>
            </div>
            <div v-if="q.wells.length" class="qlist">
              <div
                v-for="w in q.wells"
                :key="w.well_id"
                class="wellrow"
                :class="{ active: w.well_id === store.focusWellId }"
                :title="store.stateReasonOf(w) ?? '模型侧未给出判态理由'"
                @click="focusOn(w)"
              >
                <span class="mono small id">{{ w.well_id }}</span>
                <span class="small dim num">NPV {{ n(w.value_npv, 1) }}</span>
                <span class="small dim num">P {{ pct(w.confidence, 2) }}</span>
                <button class="go" title="打开单井决策卡" @click.stop="openWell(w.well_id)">↗</button>
              </div>
            </div>
            <div v-else class="na small">暂无（该象限无井，不编造）</div>
          </div>
        </div>
      </section>

      <section class="panel">
        <h3 class="panel-title">
          <span class="fig-no">DWG-COMP-007</span><span class="fig-cap">不确定性指纹</span>
        </h3>
        <UncertaintyFingerprint v-if="focus" :well="focus" />
        <div v-else class="na small">暂无</div>
      </section>

      <section class="panel">
        <h3 class="panel-title">
          <span class="fig-no">DWG-COMP-008</span><span class="fig-cap">证据链 · 相似事件</span>
        </h3>
        <EvidenceChain
          :similar="store.similarByWell(store.focusWellId)"
          :ids="focus?.evidence?.similar_ids ?? []"
          :features="focus?.evidence?.features"
        />
      </section>

      <section class="panel">
        <h3 class="panel-title">
          <span class="fig-no">DWG-COMP-009</span><span class="fig-cap">数据缺口</span>
        </h3>
        <div v-if="focus?.data_gaps?.length" class="col" style="gap: 3px">
          <div v-for="g in focus.data_gaps" :key="g" class="small dim">· {{ g }}</div>
        </div>
        <div v-else class="na small">暂无</div>
      </section>
    </aside>

    <!-- ============ 底：时间轴 + 场景对比 ============ -->
    <div class="area-axis">
      <div class="axis-row">
        <WorldLine class="axis-wl" />
        <ScenarioBar class="axis-sb" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.hero-panel { display: flex; flex-direction: column; height: 100%; }
.hero-body {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-height: 0;
  flex: 1;
  /* 安全阀：1366×768 这类矮屏下若内容仍超出，中栏自身滚动，而不是把场景压成 0 高 */
  overflow-y: auto;
}
/* 场景区永远保底 196px：2.5D 主场景是沙盘的主体，不允许被挤压到消失 */
.scene-slot { flex: 1 1 0; min-height: 196px; display: flex; gap: 8px; }
.hero-switch { display: inline-flex; gap: 3px; margin-left: 8px; }
.hero-switch .tickbtn { padding: 0 5px; font-size: 9.5px; }
/* 投屏模式：场景给足高度（scoped 下 .proj 作为祖先选择器，优先级高于上面那条）
   矮屏（1366×768）只保 300，否则会把 KPI 条和组合推演台挤出去；
   高屏（1080 及以上）给到 400，抵消字号变大吃掉的垂直空间 */
.proj .scene-slot { min-height: 300px; }
@media (min-height: 900px) {
  .proj .scene-slot { min-height: 400px; }
}
.proj .scene-detail { width: 280px; }
.scene-main { flex: 1 1 0; min-width: 0; }
.scene-detail { width: 240px; flex: none; min-width: 0; }
.mode-row { gap: 6px; flex-wrap: wrap; }
.tickbtn {
  font-family: var(--mono);
  font-size: 10px;
  line-height: 16px;
  padding: 0 7px;
  border: 1px solid var(--line-strong);
  background: var(--panel-2);
  color: var(--muted);
  cursor: pointer;
}
.tickbtn:hover { color: var(--text); background: var(--panel-3); }
.tickbtn.on { color: var(--bg); background: var(--steel); border-color: var(--steel); font-weight: 600; }
.ticks-row { gap: 4px; flex-wrap: wrap; }
.snap-hint {
  margin-top: 4px;
  padding: 4px 8px;
  border: 1px dashed var(--steel);
  color: var(--steel);
  font-size: 11px;
  line-height: 1.5;
  background: var(--panel-2);
}

.kpi-strip {
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  border: 1px solid var(--line);
  background: var(--panel-2);
}
.kpi { padding: 5px 8px; border-left: 1px solid var(--line); }
.kpi:first-child { border-left: none; }
.kpi-k { font-size: 10px; color: var(--muted); letter-spacing: .04em; }
.kpi-v { font-family: var(--mono); font-size: 20px; font-weight: 600; line-height: 1.15; }
.kpi-v .unit { font-size: 10px; color: var(--dim); margin-left: 3px; font-weight: 400; }

/* chip 的基础样式（字号/高度）由 tokens.css 的 --chip-fs / --chip-h 统一给出，
   这里只补交互态，避免各页面写死导致不一致 */
.chip { cursor: pointer; }
.chip:hover { background: var(--panel-3); color: var(--text); }

.quad { border: 1px solid var(--line); padding: 5px 6px; background: var(--panel-2); }
.qlist { max-height: 132px; overflow: auto; margin-top: 3px; }
.wellrow {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 2px 3px;
  cursor: pointer;
  border-left: 2px solid transparent;
}
.wellrow:hover { background: var(--panel-3); }
.wellrow.active { border-left-color: var(--steel); background: var(--panel-3); }
.wellrow .id { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* 点击目标下限 20×20：15×11 在笔记本触摸板/演示投屏下极易点空 */
.go {
  background: none;
  border: 1px solid transparent;
  color: var(--dim);
  cursor: pointer;
  font-size: 12px;
  min-width: 20px;
  min-height: 20px;
  padding: 0;
  line-height: 18px;
  flex: none;
}
.go:hover { color: var(--steel); border-color: var(--line-strong); }
/* 投屏模式下 .go 也要 ≥24，否则演示时这个「进单井卡」的入口最容易点空 */
.proj .go { min-width: 26px; min-height: 26px; font-size: 14px; line-height: 24px; }

.axis-row { display: flex; gap: 10px; align-items: stretch; min-width: 0; min-height: 0; height: 100%; }
.axis-wl { flex: 1; min-width: 0; }
.axis-sb { width: 268px; flex: none; }

@media (max-width: 1440px) {
  .axis-sb { width: 232px; }
  .kpi-v { font-size: 17px; }
  .scene-detail { width: 208px; }
}
</style>
