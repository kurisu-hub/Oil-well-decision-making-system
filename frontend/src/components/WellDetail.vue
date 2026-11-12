<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useAppStore } from '@/stores/app'
import { n, pct } from '@/utils/format'

/**
 * DETAIL A · 井筒放大详图（焦点井）
 *
 * 口径（不编造）：
 *  - 全部字段来自 bundle（well / curve / voi），缺失一律「暂无」
 *  - 地层分带、射孔簇、裂缝翼、井身结构均为**几何示意**——bundle 未含井位坐标、井深、
 *    缝长、簇间距，界面已打「几何示意」角标，尺寸不用于任何计算
 *  - 截至游标月累计增量 = Σ(prediction − baseline)（读曲线求和，与世界线同一口径）
 */
const store = useAppStore()
const w = computed(() => store.focusWell)
const curve = computed(() => store.focusCurve)
const voi = computed(() => store.voiByWell(store.focusWellId))

const MONTH_MAX = 12
const month = computed(() => Math.max(0, Math.min(MONTH_MAX, Math.round(store.timelineMonth))))
const progress = computed(() => month.value / MONTH_MAX)

/** 截至游标月的累计产量 / 基线 / 增量：读曲线求和，缺数据即 null */
const cum = computed(() => {
  const c = curve.value
  if (!c || c.available === false) return null
  const pred = (c.prediction ?? []).slice(0, MONTH_MAX)
  const base = (c.baseline ?? []).slice(0, MONTH_MAX)
  const mi = month.value
  let f = 0
  let b = 0
  let ok = true
  for (let i = 0; i < mi; i++) {
    const p = pred[i]
    const q = base[i]
    if (ok && p && Number.isFinite(p.oil) && q && Number.isFinite(q.oil)) {
      f += p.oil
      b += q.oil
    } else {
      ok = false
    }
  }
  return ok ? { frac: f, base: b, delta: f - b } : null
})

// —— 放大详图几何（示意，无量纲相对深度）——
const DW = 236
const DH = 300
const GY = 26 // 地面
const BX = 118 // 井筒中心线
const SY0 = 36
const SY1 = 268
const TD = 278
const SHOE = SY0 + (SY1 - SY0) * 0.46 // 套管鞋（盖层底 / 目的层顶）
const PERF_D = SY0 + (SY1 - SY0) * 0.61 // 射孔段中部
const bands = [
  { f0: 0.0, f1: 0.24, name: '上覆层', fill: '#1e2428', pat: 'url(#wd-ln)' },
  { f0: 0.24, f1: 0.46, name: '盖层', fill: '#26221d', pat: 'url(#wd-dot)' },
  { f0: 0.46, f1: 0.76, name: '目的层', fill: '#2d2519', pat: 'url(#wd-sand)' },
  { f0: 0.76, f1: 1.0, name: '底界', fill: '#171b1e', pat: 'url(#wd-ln2)' },
]
const bandRect = (b: (typeof bands)[number]) => ({
  y: SY0 + (SY1 - SY0) * b.f0,
  h: (SY1 - SY0) * (b.f1 - b.f0),
})
const FRAC_HALF = 64
const fracScale = computed(() => (0.14 + 0.86 * progress.value).toFixed(3))
function fracPath(x: number, y: number, half: number) {
  const h = Math.max(3, half * 0.34)
  return `M ${x - half} ${y} C ${x - half * 0.5} ${y - h} ${x + half * 0.5} ${y - h} ${x + half} ${y} C ${x + half * 0.5} ${y + h} ${x - half * 0.5} ${y + h} ${x - half} ${y} Z`
}
const perfClusters = [-11, 0, 11]
const depthTicks = [0, 0.24, 0.46, 0.76, 1]
const dy = (f: number) => SY0 + (SY1 - SY0) * f

/**
 * 标注分级：详图 viewBox 固定 236×300，窄栏（1366 非投屏约 184px → 0.78×）下 8 号字
 * 实际只有 ~6px，次要标注会与主标注叠字。
 * 规则：主标注（地层名 / 地面 / 射孔簇 / TD / 深度刻度）永远画；
 *      次要标注（套管鞋 / 缝长 / 相对深度轴名）在缩放 < 0.95 时**不画**，改为下方图例承载。
 * 这样任何档位都不叠字，信息也不丢（图例里仍在）。
 */
const svgEl = ref<SVGSVGElement | null>(null)
const dW = ref(DW)
let ro: ResizeObserver | null = null
onMounted(() => {
  if (!svgEl.value || typeof ResizeObserver === 'undefined') return
  ro = new ResizeObserver((es) => {
    for (const e of es) {
      const ww = e.contentRect.width
      if (ww > 40) dW.value = Math.round(ww)
    }
  })
  ro.observe(svgEl.value)
})
onBeforeUnmount(() => ro?.disconnect())
const dScale = computed(() => dW.value / DW)
const showMinor = computed(() => dScale.value >= 0.95)
/** 次要标注：窄栏不画，落到图例（带 title，鼠标悬停可看） */
const minorLegend = [
  { t: '套管鞋', d: '盖层底 / 目的层顶，相对深度 0.46（示意图元，非实测井深）' },
  { t: '缝长（示意，非实测）', d: '裂缝翼半长随游标月份生长，纯几何示意，不参与任何计算' },
]

const rows = computed(() => {
  const x = w.value
  if (!x) return []
  const u = store.meta.units
  return [
    { k: '锚点', v: n(x.anchor, 2), u: u.oil, prov: `p_anchor_${x.well_id}` },
    { k: '当前日产', v: n(x.current_oil, 2), u: u.oil },
    // value_oil 是 12 个月累计体积，不是日产：单位必须写 m³，不能沿用 meta.units.oil（m3/d）
    { k: '12月增油', v: n(x.value_oil, 1), u: 'm³' },
    { k: '期望 NPV', v: n(x.value_npv, 2), u: u.money, prov: `p_npv_${x.well_id}` },
    { k: 'ROI', v: n(x.roi, 2), u: '' },
    { k: '置信度', v: pct(x.confidence, 0), u: '', prov: `p_conf_${x.well_id}` },
    { k: '响应滞后', v: n(curve.value?.response_lag_months ?? null, 1), u: '月' },
    { k: '保本点', v: n(curve.value?.break_even ?? null, 1), u: '月' },
    { k: `至M${month.value} 累计增`, v: cum.value ? n(cum.value.delta, 1) : '暂无', u: '' },
    { k: '补资料成本 σ', v: n(voi.value?.cost ?? null, 2), u: u.money },
  ]
})
</script>

<template>
  <div class="detail">
    <div class="d-head">
      <span class="fig-no">DWG-COMP-001A</span>
      <span class="d-title">DETAIL A · 井筒放大</span>
      <span class="grow"></span>
      <span class="stamp stamp-illus">几何示意</span>
    </div>

    <template v-if="w">
      <div class="d-id">
        <span class="mono id">{{ w.well_id }}</span>
        <span class="badge" :class="`badge-${w.state}`">{{ w.state }}</span>
      </div>
      <div class="d-name small">{{ w.name || '暂无' }}</div>

      <svg
        ref="svgEl"
        :key="w.well_id"
        class="d-svg"
        :viewBox="`0 0 ${DW} ${DH}`"
        role="img"
        aria-label="焦点井井筒放大详图"
      >
        <defs>
          <pattern id="wd-ln" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(35)">
            <line x1="0" y1="0" x2="0" y2="8" stroke="#3a444b" stroke-width="1" />
          </pattern>
          <pattern id="wd-ln2" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(-45)">
            <line x1="0" y1="0" x2="0" y2="6" stroke="#2f383e" stroke-width="1" />
          </pattern>
          <pattern id="wd-dot" width="8" height="8" patternUnits="userSpaceOnUse">
            <circle cx="2" cy="2" r="1" fill="#4a4238" />
            <circle cx="6" cy="6" r="1" fill="#4a4238" />
          </pattern>
          <pattern id="wd-sand" width="10" height="10" patternUnits="userSpaceOnUse">
            <path d="M0 8 L3.5 2.5 L7 8 L10 2.5" fill="none" stroke="#8a6f4a" stroke-width="1" />
          </pattern>
        </defs>

        <!-- 地层 -->
        <g>
          <rect
            v-for="b in bands"
            :key="'b' + b.name"
            x="8"
            :y="bandRect(b).y"
            width="220"
            :height="bandRect(b).h"
            :fill="b.fill"
          />
          <rect
            v-for="b in bands"
            :key="'p' + b.name"
            x="8"
            :y="bandRect(b).y"
            width="220"
            :height="bandRect(b).h"
            :fill="b.pat"
            opacity="0.5"
          />
          <line
            v-for="b in bands"
            :key="'l' + b.name"
            x1="8"
            :y1="bandRect(b).y"
            x2="228"
            :y2="bandRect(b).y"
            stroke="#3d474e"
            stroke-width="0.8"
          />
          <text
            v-for="b in bands"
            :key="'t' + b.name"
            x="12"
            :y="bandRect(b).y + 10"
            fill="#c9a97e"
            font-size="8"
            font-family="ui-monospace, Consolas, monospace"
          >{{ b.name }}</text>
        </g>

        <!-- 地面 -->
        <line x1="4" :y1="GY" x2="232" :y2="GY" stroke="#5b666e" stroke-width="1" />
        <text x="6" :y="GY - 3" font-size="8" fill="#69747a" font-family="ui-monospace, Consolas, monospace">
          地面
        </text>

        <!-- 井口装置 -->
        <g stroke="#7f9db1" fill="none" stroke-width="1">
          <rect :x="BX - 10" :y="GY - 13" width="20" height="8" />
          <line :x1="BX - 6" :y1="GY - 9" :x2="BX + 6" :y2="GY - 9" />
          <path :d="`M ${BX - 4} ${GY - 5} l 8 0 l -4 5 Z`" fill="#7f9db1" stroke="none" />
        </g>

        <!-- 水泥环 + 套管（地面 → 套管鞋） -->
        <rect :x="BX - 4" :y="GY" width="8" :height="SHOE - GY" fill="rgba(107,118,128,0.30)" />
        <line :x1="BX - 3" :y1="GY" :x2="BX - 3" :y2="SHOE" stroke="#8a959b" stroke-width="0.8" />
        <line :x1="BX + 3" :y1="GY" :x2="BX + 3" :y2="SHOE" stroke="#8a959b" stroke-width="0.8" />
        <line :x1="BX - 9" :y1="SHOE" :x2="BX + 9" :y2="SHOE" stroke="#8a959b" stroke-width="0.8" />
        <!-- 次要标注：窄栏（<0.95×）不画，改由下方图例承载，避免叠字 -->
        <text
          v-if="showMinor"
          :x="BX + 11"
          :y="SHOE + 3"
          font-size="8"
          fill="#8a959b"
          font-family="ui-monospace, Consolas, monospace"
        >
          套管鞋
        </text>

        <!-- 生产段（套管鞋 → TD） -->        <line :x1="BX" :y1="SHOE" :x2="BX" :y2="TD" stroke="#b9c2c8" stroke-width="1.4" />

        <!-- 裂缝翼（随游标生长） -->
        <path
          class="d-frac"
          :d="fracPath(BX, PERF_D, FRAC_HALF)"
          :style="{ transform: `scale(${fracScale})` }"
          fill="rgba(180,85,45,0.30)"
          stroke="#d0764a"
          stroke-width="1.1"
        />

        <!-- 射孔簇（示意 3 簇） -->
        <g stroke="#c9a97e" stroke-width="1.1">
          <g v-for="d in perfClusters" :key="'pc' + d">
            <line :x1="BX - 6" :y1="PERF_D + d" :x2="BX - 2" :y2="PERF_D + d" />
            <line :x1="BX + 2" :y1="PERF_D + d" :x2="BX + 6" :y2="PERF_D + d" />
          </g>
        </g>
        <text :x="BX + 10" :y="PERF_D - 14" font-size="8" fill="#c9a97e" font-family="ui-monospace, Consolas, monospace">
          射孔簇 ×3
        </text>

        <!-- 缝长标注（示意） -->
        <g font-size="8" font-family="ui-monospace, Consolas, monospace" fill="#d0764a">
          <line
            :x1="BX - FRAC_HALF"
            :y1="PERF_D + 30"
            :x2="BX + FRAC_HALF"
            :y2="PERF_D + 30"
            stroke="#d0764a"
            stroke-width="0.7"
          />
          <line :x1="BX - FRAC_HALF" :y1="PERF_D + 27" :x2="BX - FRAC_HALF" :y2="PERF_D + 33" stroke="#d0764a" stroke-width="0.7" />
          <line :x1="BX + FRAC_HALF" :y1="PERF_D + 27" :x2="BX + FRAC_HALF" :y2="PERF_D + 33" stroke="#d0764a" stroke-width="0.7" />
          <!-- 短文案：完整口径「缝长（示意，非实测）」放在下方图例，避免与深度刻度压字 -->
          <text v-if="showMinor" :x="BX" :y="PERF_D + 42" text-anchor="middle">
            缝长
          </text>
        </g>

        <!-- 井底 -->
        <line :x1="BX - 10" :y1="TD" :x2="BX + 10" :y2="TD" stroke="#b9c2c8" stroke-width="1.2" />
        <text :x="BX + 12" :y="TD + 3" font-size="8" fill="#8a959b" font-family="ui-monospace, Consolas, monospace">
          TD（示意）
        </text>

        <!-- 相对深度刻度 -->
        <g font-size="8" font-family="ui-monospace, Consolas, monospace" fill="#69747a">
          <line x1="96" :y1="SY0" x2="96" :y2="SY1" stroke="#2c3339" stroke-width="0.8" />
          <g v-for="t in depthTicks" :key="'dt' + t">
            <line x1="92" :y1="dy(t)" x2="96" :y2="dy(t)" stroke="#3d474e" stroke-width="0.8" />
            <text x="90" :y="dy(t) + 3" text-anchor="end">{{ t.toFixed(2) }}</text>
          </g>
          <!-- 轴名改横排置于井底之下：竖排会与 0.76 / 1.00 两个刻度值压字 -->
          <text x="104" :y="TD + 20" text-anchor="middle">相对深度（示意）</text>
        </g>
      </svg>

      <!-- 图例：次要标注在这里兜底（窄栏下 SVG 内不画，避免叠字），悬停看口径 -->
      <div class="d-legend small">
        <span class="muted">图例 ·</span>
        <span
          v-for="g in minorLegend"
          :key="g.t"
          class="lg"
          :title="g.d"
        >{{ g.t }}</span>
      </div>

      <div class="rule"></div>
      <dl class="kvx">
        <template v-for="r in rows" :key="r.k">
          <dt>{{ r.k }}</dt>
          <dd :data-prov="r.prov" :data-prov-title="r.prov ? `${w.well_id} · ${r.k}` : undefined">{{ r.v }}<span v-if="r.u" class="u">{{ r.u }}</span></dd>
        </template>
      </dl>
      <div class="row d-foot">
        <span class="stamp">M{{ month }}</span>
        <span class="stamp stamp-live">曲线求和</span>
        <span class="grow"></span>
        <button class="mini mono" @click="store.openPassport(w.passport_ids ?? [], w.well_id + ' 数字护照')">
          数字护照
        </button>
      </div>
    </template>

    <div v-else class="na small d-empty">暂无（无焦点井）</div>
  </div>
</template>

<style scoped>
.detail {
  border: 1px solid var(--line);
  background: var(--panel);
  padding: 6px 7px;
  display: flex;
  flex-direction: column;
  gap: 3px;
  /* 高度由 .scene-slot 拉伸给定：显式 height:100% 才能让内部 svg 的 flex:1 生效，
     否则 auto 高度下 flex-basis:0 会把详图压成 70px。溢出走内部滚动，不撑破网格。 */
  height: 100%;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  animation: dIn .35s ease;
}
@keyframes dIn { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
.d-head {
  display: flex;
  align-items: center;
  gap: 6px;
  /* 装不下就整段换行（图号 + 图名一行，「几何示意」落到第二行），
     不省略、不缩字 */
  flex-wrap: wrap;
  row-gap: 2px;
  white-space: nowrap;
  flex: none;
  min-height: 20px;
}
.d-title {
  font-size: 10px;
  color: var(--muted);
  letter-spacing: .02em;
  flex: none;
}
.d-id { display: flex; align-items: center; gap: 6px; flex: none; }
.d-id .id { font-size: 12px; font-weight: 600; color: var(--text); }
.d-name {
  color: var(--dim);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: none;
  min-height: 16px;
  line-height: 16px;
  margin-top: -1px;
}
.d-svg {
  display: block;
  width: 100%;
  flex: 1 1 0;
  min-height: 150px;
  background: var(--bg-2);
  border: 1px solid var(--line);
}
.d-legend {
  flex: none;
  display: flex;
  flex-wrap: wrap;
  gap: 2px 8px;
  color: var(--muted);
  line-height: 15px;
}
.d-legend .lg {
  border-bottom: 1px dotted var(--line-strong);
  cursor: help;
}
.d-frac {
  transform-box: fill-box;
  transform-origin: center;
  transition: transform .5s cubic-bezier(.2,.8,.2,1);
}
.kvx {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 0 6px;
  font-size: 11px;
  line-height: 15px;
  margin: 0;
}
.kvx > dt { color: var(--muted); white-space: nowrap; }
.kvx > dd {
  margin: 0;
  text-align: right;
  font-family: var(--mono);
  font-variant-numeric: tabular-nums;
  color: var(--text);
}
.kvx .u { color: var(--dim); font-size: 9px; margin-left: 2px; }
.d-foot { gap: 5px; }
.mini {
  font-size: 10px;
  line-height: 16px;
  padding: 0 6px;
  border: 1px solid var(--line-strong);
  background: var(--panel-2);
  color: var(--steel);
  cursor: pointer;
}
.mini:hover { background: var(--panel-3); color: var(--text); }
.d-empty { padding: 10px 0; }
/* —— 动效：井筒分带随游标推进逐层点亮（示意）—— */
.d-band {
  opacity: .25;
  transform-box: fill-box;
  transform-origin: center bottom;
  animation: bandIn .6s cubic-bezier(.2,.8,.2,1) forwards;
}
@keyframes bandIn { to { opacity: 1; transform: none; } }

@media (prefers-reduced-motion: reduce) {
  .detail, .d-band, .d-frac { animation: none; transition: none; opacity: 1; }
}
</style>
