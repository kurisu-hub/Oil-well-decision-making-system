<script setup lang="ts">
import { computed, onMounted, reactive, ref, shallowRef } from 'vue'
import { NButton, NInputNumber, NSelect } from 'naive-ui'
import { useAppStore } from '@/stores/app'
import { AnbmClient, type WorkerMode } from '@/worker/anbmClient'
import type { InferResult } from '@/worker/anbmModel'

/**
 * T04 · A2 Worker 前端推理 —— 新井试算面板
 *
 * 输入一口新井（锚点 / D_fit / 事件类型）→ Web Worker 当场算
 * 12 月预测曲线 + 不完井基线 + ΔN + NPV。
 *
 * 口径披露（面板内明示，不冒充与主看板同源）：
 * · 预测 = ANBM（bundle.final_model 交付参数）；
 * · 基线 = anchor × exp(−D_fit·k)（twin_state.py 同源）；
 * · 主看板 bundle 曲线是 ANBM+LSDRT-v2 融合（finalize_final77.py 产出），
 *   与本试算非同一路径——新井无 LSDRT 特征，只能走 ANBM 口径。
 */
const store = useAppStore()

const anchor = ref(1.0)
const dFit = ref(0.15)
const eventType = ref('recompletion')
const running = ref(false)
const lastMs = ref<number | null>(null)
const mode = ref<WorkerMode | null>(null)
const result = shallowRef<InferResult | null>(null)
const err = reactive({ msg: '' })

const typeOptions = [
  { label: 'recompletion（本批 72 口）', value: 'recompletion' },
  { label: 'refrac（本批 5 口）', value: 'refrac' },
]

const BUCKET_LABELS = [
  '低产(-∞-0.5 m³/d)',
  '中低产(0.5-1.5 m³/d)',
  '中高产(1.5-3.0 m³/d)',
  '高产(3.0-∞ m³/d)',
]

let client: AnbmClient | null = null

const anbmParams = computed(() => {
  const fm = store.finalModel as unknown as {
    models?: { ANBM?: { bins: number[]; curves: Record<string, number[]>; global_curve: number[] } }
  } | null
  const a = fm?.models?.ANBM
  if (!a) return null
  return { bins: a.bins, curves: a.curves, globalCurve: a.global_curve }
})

onMounted(() => {
  const p = anbmParams.value
  if (!p) {
    err.msg = 'bundle.final_model.models.ANBM 缺失（不可试算）'
    return
  }
  client = new AnbmClient(p)
  mode.value = client.mode
  // A2 验收句柄（tools/gate/worker_bench.mjs）：只读调用
  ;(window as unknown as Record<string, unknown>).__worker = {
    mode: () => client?.mode ?? 'inline',
    async infer(input: { anchor: number; dFit: number; eventType?: string }) {
      return client!.infer(input)
    },
    async bench(inputs: { anchor: number; dFit: number }[]) {
      return client!.bench(inputs)
    },
  }
})

async function run() {
  err.msg = ''
  if (!client) return
  if (!(anchor.value > 0)) {
    err.msg = '锚点必须为正数（m³/d）'
    return
  }
  running.value = true
  try {
    const r = await client.infer({ anchor: anchor.value, dFit: dFit.value, eventType: eventType.value })
    result.value = r.result
    lastMs.value = r.ms
    mode.value = client.mode
  } catch (e) {
    err.msg = String(e)
  } finally {
    running.value = false
  }
}

/** 迷你曲线图：预测柱 + 基线线（m³/d 月均产率） */
const chart = computed(() => {
  const r = result.value
  if (!r) return null
  const W = 300
  const H = 80
  const all = [...r.curve, ...r.baseline, 0]
  const max = Math.max(...all) * 1.1 || 1
  const bw = W / 12
  const bars = r.curve.map((v, i) => ({
    x: i * bw + 1,
    y: H - (v / max) * (H - 8) - 2,
    w: bw - 2,
    h: (v / max) * (H - 8),
  }))
  const basePts = r.baseline
    .map((v, i) => `${(i * bw + bw / 2).toFixed(1)},${(H - (v / max) * (H - 8) - 2).toFixed(1)}`)
    .join(' ')
  return { W, H, bars, basePts, max }
})

const npvColor = computed(() => ((result.value?.npv ?? 0) > 0 ? 'var(--green)' : 'var(--red)'))
</script>

<template>
  <section class="panel">
    <h3 class="panel-title">
      <span class="fig-no">DWG-COMP-007</span><span class="fig-cap">新井试算 · A2 前端推理</span>
      <span class="grow"></span>
      <span class="stamp" :class="mode === 'worker' ? 'stamp-live' : ''" data-name="worker-mode">{{
        mode === 'worker' ? 'Worker' : mode === 'inline' ? '主线程兜底' : '初始化'
      }}</span>
    </h3>
    <div class="row wrap small" style="gap: 8px">
      <label class="fld">
        <span class="muted">锚点（压前日产 m³/d）</span>
        <NInputNumber v-model:value="anchor" :min="0.01" :step="0.1" size="small" style="width: 110px" />
      </label>
      <label class="fld">
        <span class="muted">D_fit（事件前递减 1/月）</span>
        <NInputNumber v-model:value="dFit" :min="0" :max="2" :step="0.01" size="small" style="width: 110px" />
      </label>
      <label class="fld">
        <span class="muted">事件类型（记录用）</span>
        <NSelect v-model:value="eventType" :options="typeOptions" size="small" style="width: 200px" />
      </label>
      <NButton size="small" type="primary" :loading="running" @click="run">试算</NButton>
    </div>
    <p v-if="err.msg" class="na small">{{ err.msg }}</p>
    <template v-if="result">
      <div class="row wrap" style="gap: 14px; margin-top: 6px">
        <div class="stat">
          <div class="small muted">ΔN（12 月累计增油）</div>
          <div class="big num">{{ result.dN.toFixed(1) }} <span class="small muted">m³</span></div>
        </div>
        <div class="stat">
          <div class="small muted">NPV</div>
          <div class="big num" :style="{ color: npvColor }">{{ result.npv.toFixed(1) }} <span class="small muted">万元</span></div>
        </div>
        <div class="stat">
          <div class="small muted">分桶</div>
          <div class="small mono">{{ BUCKET_LABELS[result.bucket] ?? result.bucket }}</div>
        </div>
        <div class="stat">
          <div class="small muted">耗时</div>
          <div class="big num">{{ lastMs != null ? lastMs.toFixed(2) : '—' }} <span class="small muted">ms</span></div>
        </div>
      </div>
      <svg v-if="chart" class="wk-chart" :viewBox="`0 0 ${chart.W} ${chart.H}`" role="img" aria-label="新井试算 12 月曲线">
        <g v-for="(b, i) in chart.bars" :key="i">
          <rect :x="b.x" :y="b.y" :width="b.w" :height="b.h" fill="#5f9e78" opacity="0.75" />
        </g>
        <polyline :points="chart.basePts" fill="none" stroke="#c9a13a" stroke-width="1.5" stroke-dasharray="4 2" />
      </svg>
      <div class="small muted">
        柱 = 预测 ŷ(t) = 锚点 × ANBM 分桶曲线；虚线 = 不完井基线 锚点 × exp(−D_fit·t)。
        ΔN = (Σŷ − Σ基线) × 30.4，NPV = ΔN × 0.323 − 45。
      </div>
      <div class="small dim">
        口径注：本试算走 ANBM 交付参数（bundle.final_model）；主看板曲线为 ANBM+LSDRT-v2 融合
        （finalize_final77.py 产出，未随包发布），两路径不同源——新井缺 LSDRT 特征，只能走 ANBM 口径。
        事件类型本批训练 72 recompletion / 5 refrac，ANBM 不分型，仅如实记录。
      </div>
    </template>
    <div v-else class="small muted" style="margin-top: 4px">
      输入一口新井参数，点「试算」在浏览器内当场出 12 月曲线 + NPV（不联网、不发请求）。
    </div>
  </section>
</template>

<style scoped>
.fld { display: flex; flex-direction: column; gap: 2px; }
.wk-chart { width: 100%; height: 84px; margin-top: 6px; }
.stat { display: flex; flex-direction: column; gap: 0; }
</style>
