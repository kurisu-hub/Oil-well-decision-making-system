<script setup lang="ts">
import { computed } from 'vue'
import { NSlider } from 'naive-ui'
import { useAppStore } from '@/stores/app'
import { n, pct, signed } from '@/utils/format'

/**
 * 补资料 · 信息价值（当场算）
 *
 * 恒等式（bundle 自洽、界面内可自验）：
 *   ① expected_benefit = flip_prob × value_npv   （120 口中 118 口精确，2 口为四舍五入）
 *   ② net_benefit      = expected_benefit − cost （120/120 精确）
 * 所以本控制台只做「成本 σ 可拖动」的重算：
 *     期望收益 B  = flip_prob × value_npv        （查表，不算风险指标）
 *     期望净收益  = B − σ
 * σ 取 bundle 的 cost 时，结果与 bundle 的 net_benefit 恒等 → 界面显示「已还原 bundle 口径」。
 * 翻绿概率 flip_prob 直接查表，不用前端公式反推。
 */
const store = useAppStore()
const v = computed(() => store.voiCalc)
const focus = computed(() => store.focusWell)

const sigmaMax = computed(() => {
  const s0 = v.value?.sigma0
  return typeof s0 === 'number' && s0 > 0 ? Math.max(6, Math.ceil(s0 * 3)) : 6
})
const sigmaVal = computed({
  get: () => v.value?.sigma ?? 0,
  set: (x: number) => { store.voiSigma = x },
})

const stateLabel: Record<string, string> = {
  green: '可判定',
  yellow: '数据不足',
  red: '不建议',
  gray: '低价值低置信',
}

/** 期望收益反推：B = p × value_npv（恒等①，用于展示分解，不用于另立口径） */
const decomp = computed(() => {
  const c = v.value
  const npv = focus.value?.value_npv ?? null
  if (!c || c.p === null || typeof npv !== 'number') return null
  return { p: c.p, npv, prod: c.p * npv }
})
</script>

<template>
  <section class="panel voi">
    <h3 class="panel-title">
      <span class="fig-no">DWG-COMP-002D</span>
      <span class="fig-cap">补资料 · 信息价值</span>
      <span class="fig-unit">{{ store.meta.units.money }}</span>
    </h3>

    <div class="small dim mono">
      焦点井 {{ focus?.well_id ?? '暂无' }}<span v-if="focus"> · {{ focus.name }}</span>
    </div>

    <template v-if="v">
      <div class="rule"></div>

      <!-- 可拖的补资料成本 -->
      <div class="ctl">
        <div class="ctl-head">
          <span>补资料成本 σ</span>
          <span class="val">{{ n(v.sigma, 2) }}</span>
          <span class="unit">{{ store.meta.units.money }}</span>
        </div>
        <NSlider
          v-model:value="sigmaVal"
          :min="0"
          :max="sigmaMax"
          :step="0.25"
          :disabled="v.sigma0 === null"
        />
        <div class="row">
          <span class="stamp">bundle σ₀ {{ n(v.sigma0, 2) }}</span>
          <button v-if="store.voiSigma !== null" class="linkbtn" @click="store.resetVoiSigma()">
            还原 σ₀
          </button>
        </div>
      </div>

      <div class="rule"></div>

      <!-- 当场算结果 -->
      <dl class="kv">
        <dt>翻绿概率 p</dt>
        <dd>{{ pct(v.p, 1) }}</dd>
        <dt>期望收益 B</dt>
        <dd>{{ n(v.B, 2) }}</dd>
        <dt>期望净收益 B−σ</dt>
        <dd :style="{ color: (v.enb ?? 0) >= 0 ? 'var(--green)' : 'var(--red)' }">
          {{ signed(v.enb, 2) }}
        </dd>
        <dt>bundle net_benefit</dt>
        <dd class="dim">{{ n(v.bundleNb, 2) }}</dd>
      </dl>

      <div v-if="decomp" class="mono dim small decomp">
        B = p × NPV = {{ pct(decomp.p, 1) }} × {{ n(decomp.npv, 2) }} = {{ n(decomp.prod, 2) }}
      </div>

      <div class="row stamps">
        <span class="badge" :class="v.recommend ? 'badge-green' : 'badge-gray'">
          {{ v.recommend ? '建议补资料' : '不建议补资料' }}
        </span>
        <span v-if="v.identity === true" class="stamp stamp-live">bundle 自洽 ✓</span>
        <span v-else-if="v.identity === false" class="stamp stamp-illus">与 bundle 口径不一致</span>
        <span v-if="store.voiSigma === null" class="stamp stamp-live">σ=σ₀（已还原）</span>
        <span v-else class="stamp stamp-assump">σ 偏离 σ₀（现场测算）</span>
      </div>

      <div class="rule"></div>

      <!-- 决策翻转 -->
      <div class="blk-h">决策翻转推演</div>
      <dl class="kv">
        <dt>当前决策</dt>
        <dd>{{ stateLabel[v.curState ?? ''] ?? '暂无' }}</dd>
        <dt>补资料后（若翻绿）</dt>
        <dd style="color: var(--green)">{{ stateLabel[v.flipTo] }}</dd>
        <dt>是否翻转</dt>
        <dd :style="{ color: v.flips ? 'var(--yellow)' : 'var(--muted)' }">
          {{ v.flips ? '会翻转' : '不翻转' }}
        </dd>
        <dt>翻转概率</dt>
        <dd>{{ v.flips ? pct(v.p, 1) : '—' }}</dd>
      </dl>
      <div class="small dim na-note">
        翻转概率直接取 bundle 的 flip_prob，不由前端反推；补资料只降低「数据不足」这一支不确定性，
        不改变 value_npv 本身。
      </div>
    </template>

    <div v-else class="na small">暂无（该井无 VOI，不编造）</div>
  </section>
</template>

<style scoped>
.voi { padding: 8px 10px; }
.blk-h { font-size: 10px; color: var(--muted); letter-spacing: .04em; margin-bottom: 5px; }
.stamps { gap: 5px; flex-wrap: wrap; margin-top: 6px; }
.decomp { margin-top: 4px; font-size: 10px; }
.na-note { margin-top: 6px; font-size: 10px; line-height: 1.4; }
.linkbtn {
  background: none;
  border: none;
  color: var(--steel);
  cursor: pointer;
  font-size: 10px;
  padding: 0;
  text-decoration: underline;
}
</style>
