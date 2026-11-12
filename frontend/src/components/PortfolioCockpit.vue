<script setup lang="ts">
import { computed } from 'vue'
import { useAppStore } from '@/stores/app'
import EmptyValue from './EmptyValue.vue'
import { n, pct } from '@/utils/format'

/**
 * 组合推演台：预算 / 风险 / 目标 → 组合、指标、前沿一起变
 *
 * 全部为**查表**：portfolio.points 按 (budget, risk, objective) 精确匹配，
 * 命中才给组合与指标；不命中即「暂无」，不插值、不外推、不算前端公式。
 * frontier[i] 与 points[i] 一一对应（X=loss_prob 风险，Y=expected_npv 收益）。
 */
const store = useAppStore()

const W = 330
const H = 118
const PAD_L = 34
const PAD_R = 10
const PAD_T = 12
const PAD_B = 20

const objColor: Record<string, string> = {
  npv: '#d0764a',
  oil: '#c9a97e',
  roi: '#7f9db1',
  risk: '#5f9e78',
}
const objLabel: Record<string, string> = { npv: 'NPV', oil: '增油', roi: 'ROI', risk: '风险' }

const pts = computed(() => store.frontierPoints)
const xs = computed(() => pts.value.map((d) => d.x))
const ys = computed(() => pts.value.map((d) => d.y))
const xMin = computed(() => (xs.value.length ? Math.min(...xs.value) : 0))
const xMax = computed(() => (xs.value.length ? Math.max(...xs.value) : 1))
const yMin = computed(() => Math.min(0, ...(ys.value.length ? ys.value : [0])))
const yMax = computed(() => (ys.value.length ? Math.max(...ys.value) : 1))
const X0 = PAD_L
const X1 = W - PAD_R
const Y0 = PAD_T
const Y1 = H - PAD_B

function px(v: number) {
  const t = (v - xMin.value) / (xMax.value - xMin.value || 1)
  return X0 + (X1 - X0) * t
}
function py(v: number) {
  const t = (v - yMin.value) / (yMax.value - yMin.value || 1)
  return Y1 - (Y1 - Y0) * t
}

const active = computed(() => pts.value.find((d) => d.active) ?? null)
const ap = computed(() => store.activePoint)

/** 组合指标：全部来自查表命中项，未命中一律 null → 暂无 */
const combo = computed(() => {
  const p = ap.value
  if (!p) return null
  return {
    selected: [...(p.selected ?? [])].sort(),
    oil: p.expected_oil ?? null,
    npv: p.expected_npv ?? null,
    loss: p.loss_prob ?? null,
    cvar: p.cvar ?? null,
    hit: p.hit_rate ?? null,
    regret: p.regret ?? null,
  }
})

/** 四策略对比条 */
const strategies = computed(() => {
  const list = store.portfolio?.strategies ?? []
  const maxAbs = Math.max(...list.map((s) => Math.abs(s.expected_npv ?? 0)), 1)
  return list.map((s) => ({
    id: s.id,
    label: s.label,
    npv: s.expected_npv ?? null,
    oil: s.expected_oil ?? null,
    hit: s.hit_rate ?? null,
    regret: s.regret ?? null,
    w: (Math.abs(s.expected_npv ?? 0) / maxAbs) * 50,
    pos: (s.expected_npv ?? 0) >= 0,
    selected: s.selected ?? [],
  }))
})
const zeroAt = computed(() => {
  // 零轴在条内的相对位置（按 [-maxAbs, +maxAbs] 对称）
  return 50
})
</script>

<template>
  <section class="panel pfc">
    <h3 class="panel-title">
      <span class="fig-no">DWG-COMP-010</span>
      <span class="fig-cap">组合推演台 · 效率前沿</span>
      <span class="fig-unit">
        B{{ store.assumptions.budget }} · R{{ store.assumptions.risk }} ·
        {{ objLabel[store.assumptions.objective] ?? store.assumptions.objective }}
      </span>
    </h3>

    <div class="pf-body">
      <!-- 组合指标 -->
      <div class="blk metrics">
        <div class="blk-h">组合指标（查表）</div>
        <template v-if="combo">
          <dl class="kv kv2">
            <dt>井数</dt><dd>{{ combo.selected.length }}</dd>
            <dt>期望增油</dt><dd>{{ n(combo.oil, 1) }}<span class="u">m³</span></dd>
            <dt>期望 NPV</dt>
            <dd :style="{ color: (combo.npv ?? 0) >= 0 ? 'var(--green)' : 'var(--red)' }">{{ n(combo.npv, 1) }}</dd>
            <dt>亏损概率</dt><dd>{{ pct(combo.loss, 1) }}</dd>
            <dt>CVaR</dt><dd>{{ n(combo.cvar, 1) }}</dd>
            <dt>命中率</dt><dd>{{ pct(combo.hit, 1) }}</dd>
            <dt>后悔值</dt><dd>{{ n(combo.regret, 1) }}</dd>
          </dl>
          <div class="row wrap chips" style="gap: 3px">
            <span v-for="id in combo.selected" :key="id" class="chip mono">{{ id }}</span>
          </div>
        </template>
        <div v-else class="na small">
          暂无（当前 B/R/目标组合不在 portfolio.points 内，不插值不外推）
        </div>
      </div>

      <!-- 前沿散点 -->
      <div class="blk">
        <div class="blk-h">效率前沿（X=亏损概率 · Y=期望 NPV）</div>
        <svg :viewBox="`0 0 ${W} ${H}`" class="chart" role="img" aria-label="效率前沿散点">
          <!-- 网格 -->
          <g>
            <line v-for="i in 4" :key="'g' + i"
              :x1="X0" :y1="Y0 + ((Y1 - Y0) * (i - 1)) / 3" :x2="X1" :y2="Y0 + ((Y1 - Y0) * (i - 1)) / 3"
              stroke="#232a2f" stroke-width="1" />
            <line :x1="X0" :y1="Y1" :x2="X1" :y2="Y1" stroke="#3d474e" stroke-width="1" />
            <line :x1="X0" :y1="Y0" :x2="X0" :y2="Y1" stroke="#3d474e" stroke-width="1" />
            <text :x="X0 - 3" :y="Y0 + 4" text-anchor="end" font-size="8" fill="#69747a" font-family="ui-monospace, Consolas, monospace">{{ n(yMax, 0) }}</text>
            <text :x="X0 - 3" :y="Y1 + 3" text-anchor="end" font-size="8" fill="#69747a" font-family="ui-monospace, Consolas, monospace">{{ n(yMin, 0) }}</text>
            <text :x="X0" :y="H - 8" font-size="8" fill="#69747a" font-family="ui-monospace, Consolas, monospace">{{ pct(xMin, 0) }}</text>
            <text :x="X1" :y="H - 8" text-anchor="end" font-size="8" fill="#69747a" font-family="ui-monospace, Consolas, monospace">{{ pct(xMax, 0) }}</text>
          </g>
          <!-- 点 -->
          <g>
            <g v-for="d in pts" :key="d.i">
              <rect
                :x="px(d.x) - 3"
                :y="py(d.y) - 3"
                width="6"
                height="6"
                :fill="objColor[d.objective] ?? '#6b7680'"
                :opacity="d.active ? 1 : 0.42"
                stroke="none"
              />
              <circle
                v-if="d.active"
                :cx="px(d.x)"
                :cy="py(d.y)"
                r="7.5"
                fill="none"
                stroke="#dde3e6"
                stroke-width="1.2"
              />
              <title>
                B{{ d.budget }} · R{{ d.risk }} · {{ objLabel[d.objective] ?? d.objective }}｜风险
                {{ pct(d.x, 1) }}｜NPV {{ n(d.y, 1) }}｜{{ (d.selected ?? []).join(',') }}
              </title>
            </g>
          </g>
          <!-- 图例 -->
          <g font-family="ui-monospace, Consolas, monospace" font-size="8">
            <g v-for="(c, k, i) in objColor" :key="k" :transform="`translate(${X0 + i * 52} ${Y0 - 3})`">
              <rect x="0" y="-6" width="6" height="6" :fill="c" />
              <text x="9" y="0" fill="#8a959b">{{ objLabel[k] ?? k }}</text>
            </g>
          </g>
          <text v-if="!pts.length" :x="(X0 + X1) / 2" :y="(Y0 + Y1) / 2" text-anchor="middle" fill="#6b7680" font-size="10">暂无</text>
        </svg>
        <div v-if="active" class="small dim mono">
          CURSOR 风险 {{ pct(active.x, 1) }} · NPV {{ n(active.y, 1) }}
        </div>
      </div>

      <!-- 策略对比 -->
      <div class="blk">
        <div class="blk-h">策略对比（期望 NPV，{{ store.meta.units.money }}）</div>
        <div v-if="strategies.length" class="bars">
          <div v-for="s in strategies" :key="s.id" class="bar-row">
            <div class="bar-lab small">{{ s.label }}</div>
            <div class="bar-track">
              <div class="bar-zero" :style="{ left: zeroAt + '%' }"></div>
              <div
                class="bar-fill"
                :class="{ pos: s.pos }"
                :style="{
                  left: s.pos ? '50%' : (50 - s.w) + '%',
                  width: s.w + '%',
                }"
              ></div>
            </div>
            <div class="bar-val mono" :style="{ color: s.pos ? 'var(--green)' : 'var(--red)' }">
              <EmptyValue :value="s.npv" :digits="1" />
            </div>
          </div>
        </div>
        <div v-else class="na small">暂无</div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.pfc { padding: 8px 10px; }
.pf-body { display: grid; grid-template-columns: 208px minmax(0, 1fr) minmax(0, 1.1fr); gap: 12px; }
.blk { min-width: 0; border-left: 1px solid var(--line); padding-left: 10px; overflow: auto; }
.blk:first-child { border-left: none; padding-left: 0; }
.blk-h { font-size: 10px; color: var(--muted); letter-spacing: .04em; margin-bottom: 5px; }
.kv2 { grid-template-columns: auto 1fr auto 1fr; gap: 1px 6px; font-size: 11px; }
.u { color: #5b666e; font-size: 9px; margin-left: 2px; }
/* chip 的基础样式由 tokens.css 的 --chip-fs / --chip-h 统一给出，这里不写死 */
.chips { margin-top: 4px; }
.bars { display: flex; flex-direction: column; gap: 4px; }
.bar-row { display: grid; grid-template-columns: 118px 1fr 52px; gap: 6px; align-items: center; }
/* 策略名不省略、不截断：装不下就折行（宁可两行，也不要被 ellipsis 吃掉） */
.bar-lab { color: var(--muted); font-size: 10px; white-space: normal; line-height: 1.3; }
.bar-track { position: relative; height: 12px; background: var(--panel-2); border: 1px solid var(--line-soft); }
.bar-zero { position: absolute; top: -1px; bottom: -1px; width: 1px; background: var(--line-strong); }
.bar-fill { position: absolute; top: 1px; bottom: 1px; background: #c1503a; }
.bar-fill.pos { background: #5f9e78; }
.bar-val { font-size: 10px; text-align: right; }
@media (max-width: 1440px) {
  .pf-body { grid-template-columns: 180px minmax(0, 1fr) minmax(0, 1fr); }
  .bar-row { grid-template-columns: 96px 1fr 46px; }
  /* 1366 投屏：中区只剩 ~450px，三列并排必然挤爆（kv2 的 4 列被压到 19px 宽 → 一字一行）
     → 改成三块纵向堆叠，各自占满整宽 */
  .proj .pf-body { grid-template-columns: minmax(0, 1fr); gap: 8px; }
  .proj .blk { border-left: none; padding-left: 0; border-top: 1px solid var(--line); padding-top: 6px; }
  .proj .blk:first-child { border-top: none; padding-top: 0; }
  .proj .kv2 { grid-template-columns: auto 1fr auto 1fr; font-size: 12px; }
  /* 投屏档整块纵向堆叠、占满整宽 → 第一列给足 190px，
     「历史回放（事后实际增油前 3）」需 180px，不再被压掉 48px */
  .proj .bar-row { grid-template-columns: 190px 1fr 56px; }
}
</style>
