<script setup lang="ts">
import { computed, watch } from 'vue'
import { NButton, NTag } from 'naive-ui'
import { useRoute, useRouter } from 'vue-router'
import { useAppStore } from '@/stores/app'
import CounterfactualChart from '@/components/CounterfactualChart.vue'
import UncertaintyFingerprint from '@/components/UncertaintyFingerprint.vue'
import EvidenceChain from '@/components/EvidenceChain.vue'
import EmptyValue from '@/components/EmptyValue.vue'
import IllustrativeBadge from '@/components/IllustrativeBadge.vue'
import { n, pct } from '@/utils/format'

const store = useAppStore()
const route = useRoute()
const router = useRouter()

const wellId = computed(() => (route.params.wellId as string) || '')
const well = computed(() => store.wellById(wellId.value))

// 非法井号 → 回退第一口 available 井
watch(
  well,
  (w) => {
    if (!w && store.wells.length) {
      router.replace(`/well/${store.wells[0].well_id}`)
    }
  },
  { immediate: true },
)

const curve = computed(() => store.curveByWell(wellId.value))
const similar = computed(() => store.similarByWell(wellId.value))
const voi = computed(() => store.voiByWell(wellId.value))

const stateMeta: Record<string, { label: string; cls: string }> = {
  green: { label: '可判定', cls: 'badge-green' },
  yellow: { label: '数据不足', cls: 'badge-yellow' },
  red: { label: '不建议', cls: 'badge-red' },
  gray: { label: '低价值低置信', cls: 'badge-gray' },
}

/** 象限 = bundle 的 well.state（模型侧判态），阈值只作兜底展示 */
const quad = computed(() => {
  const w = well.value
  if (!w) return null
  const s = store.quadrantOf(w)
  const fallback =
    (w.value_npv ?? 0) > store.npvThreshold
      ? (w.confidence ?? 0) >= store.confThreshold
        ? '高价值 · 高置信'
        : '高价值 · 低置信'
      : (w.confidence ?? 0) >= store.confThreshold
        ? '低价值 · 高置信'
        : '低价值 · 低置信'
  return {
    label: store.stateReasonOf(w) ?? `前端口径（bundle 未给理由）：${fallback}`,
    cls: stateMeta[s]?.cls ?? 'badge-gray',
  }
})

const actionOptions = ['压', '不压', '补资料', '专家复核']
const currentAction = computed(
  () => store.actions[wellId.value] || well.value?.recommended_action || '',
)

function switchWell(delta: number) {
  const i = store.wells.findIndex((w) => w.well_id === wellId.value)
  const next = store.wells[(i + delta + store.wells.length) % store.wells.length]
  if (next) router.push(`/well/${next.well_id}`)
}
</script>

<template>
  <div class="layout two">
    <aside class="col no-print">
      <section class="panel">
        <h3 class="panel-title">井列表</h3>
        <div class="col" style="gap: 2px">
          <div
            v-for="w in store.wells"
            :key="w.well_id"
            class="wellrow"
            :class="{ active: w.well_id === wellId }"
            @click="router.push(`/well/${w.well_id}`)"
          >
            <span class="mono small">{{ w.well_id }}</span>
            <span class="small muted grow">{{ w.bucket }}</span>
            <span class="badge" :class="stateMeta[w.state]?.cls">{{ stateMeta[w.state]?.label }}</span>
            <IllustrativeBadge v-if="store.illustrativeWell(w.well_id)" />
          </div>
        </div>
      </section>
      <section class="panel">
        <h3 class="panel-title">信息价值（第四幕）</h3>
        <template v-if="voi && voi.available">
          <div class="row small"><span class="grow">补资料成本</span><EmptyValue :value="voi.cost" :digits="1" :unit="store.meta.units.money" /></div>
          <div class="row small"><span class="grow">翻绿概率</span><span class="num">{{ pct(voi.flip_prob) }}</span></div>
          <div class="row small"><span class="grow">期望净收益</span><EmptyValue :value="voi.net_benefit" :digits="1" :unit="store.meta.units.money" /></div>
          <NTag size="small" :bordered="false" :type="voi.recommended ? 'success' : 'default'">
            {{ voi.recommended ? '建议补资料' : '不建议补资料' }}
          </NTag>
        </template>
        <div v-else class="na small">暂无</div>
      </section>
    </aside>

    <main class="col" style="overflow: auto">
      <section v-if="!well" class="panel"><span class="na">暂无该井</span></section>

      <template v-else>
        <!-- WellHeader -->
        <section class="panel">
          <div class="row wrap">
            <strong style="font-size: 18px">{{ well.name }}</strong>
            <span class="mono small muted">{{ well.well_id }} · API {{ well.api }}</span>
            <span class="small muted">{{ well.county }} · {{ well.formation }}</span>
            <span class="badge badge-accent">{{ well.bucket }}</span>
            <IllustrativeBadge v-if="store.illustrativeWell(well.well_id)" />
            <span class="grow"></span>
            <NButton size="tiny" @click="switchWell(-1)">上一口</NButton>
            <NButton size="tiny" @click="switchWell(1)">下一口</NButton>
          </div>
          <div class="row wrap" style="margin-top: 8px">
            <div class="stat">
              <div class="small muted">锚点（压前日产）</div>
              <div
                class="big num"
                :data-prov="`p_anchor_${well.well_id}`"
                :data-prov-title="well.well_id + ' · 锚点'"
              >{{ n(well.anchor, 1) }}<span class="small muted"> {{ store.meta.units.oil }}</span></div>
            </div>
            <div class="stat">
              <div class="small muted">期望 NPV</div>
              <div
                class="big num"
                :style="{ color: (well.value_npv ?? 0) > 0 ? 'var(--green)' : 'var(--red)' }"
                :data-prov="`p_npv_${well.well_id}`"
                :data-prov-title="well.well_id + ' · 期望 NPV'"
              >
                <EmptyValue :value="well.value_npv" :digits="1" :unit="store.meta.units.money" />
              </div>
            </div>
            <div class="stat">
              <div class="small muted">12 月增油</div>
              <div class="big num"><EmptyValue :value="well.value_oil" :digits="1" unit="m³" /></div>
            </div>
            <div class="stat">
              <div class="small muted">ROI</div>
              <div class="big num"><EmptyValue :value="well.roi" :digits="2" /></div>
            </div>
            <div class="stat">
              <div class="small muted">置信度 P(NPV&gt;0)</div>
              <div
                class="big num"
                :data-prov="`p_conf_${well.well_id}`"
                :data-prov-title="well.well_id + ' · 置信度'"
              >{{ pct(well.confidence) }}</div>
            </div>
          </div>
        </section>

        <!-- 反事实图 -->
        <section class="panel">
          <h3 class="panel-title">
            反事实三条世界线
            <span class="muted small">历史 / 基线（不压）/ 预测（压，90% 区间）</span>
          </h3>
          <CounterfactualChart :curve="curve" :unit="store.meta.units.oil" />
        </section>

        <div class="duo">
          <!-- 四象限 + 动作 -->
          <section class="panel">
            <h3 class="panel-title">决策象限</h3>
            <div class="col">
              <div class="row">
                <span class="badge" :class="quad?.cls">{{ stateMeta[well.state]?.label ?? '未知' }}</span>
                <span class="small muted">{{ quad?.label }}</span>
              </div>
              <div class="small muted">
                模型建议：<strong>{{ well.recommended_action }}</strong>
              </div>
              <div class="row wrap">
                <span class="small muted">我的决定：</span>
                <NButton
                  v-for="a in actionOptions"
                  :key="a"
                  size="tiny"
                  :type="currentAction === a ? 'primary' : 'default'"
                  @click="store.setAction(well.well_id, a)"
                  >{{ a }}</NButton
                >
              </div>
              <NButton size="small" @click="store.openPassport(well.passport_ids, `${well.well_id} 数字护照`)">
                打开数字护照（{{ well.passport_ids.length }} 项）
              </NButton>
            </div>
          </section>

          <!-- 不确定性指纹 -->
          <section class="panel">
            <h3 class="panel-title">不确定性指纹</h3>
            <UncertaintyFingerprint :well="well" />
          </section>
        </div>

        <!-- 证据链 -->
        <section class="panel">
          <h3 class="panel-title">证据链（Top-3 相似事件 + 特征方向）</h3>
          <EvidenceChain :similar="similar" :ids="well.evidence?.similar_ids ?? []" :features="well.evidence?.features ?? []" />
        </section>

        <!-- 数据缺口 -->
        <section class="panel">
          <h3 class="panel-title">数据缺口</h3>
          <ul v-if="well.data_gaps?.length" class="gaps">
            <li v-for="g in well.data_gaps" :key="g">{{ g }}</li>
          </ul>
          <div v-else class="na small">暂无（未标注缺口）</div>
        </section>
      </template>
    </main>
  </div>
</template>

<style scoped>
.wellrow {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 6px;
  border-radius: 4px;
  cursor: pointer;
}
.wellrow:hover { background: var(--panel-2); }
.wellrow.active { background: rgba(90, 169, 230, 0.16); }
.stat { min-width: 96px; }
.duo { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.duo .panel { margin-top: 0; }
.gaps { margin: 0; padding-left: 18px; font-size: 13px; color: var(--muted); }
@media (max-width: 1100px) { .duo { grid-template-columns: 1fr; } }
</style>
