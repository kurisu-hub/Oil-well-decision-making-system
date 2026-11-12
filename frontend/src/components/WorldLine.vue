<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useAppStore } from '@/stores/app'
import { n, signed } from '@/utils/format'

/**
 * 时间轴 + 世界线（M0 措施月 → M12）
 *
 * 口径（不编造）：
 *  - 措施世界线   = Σ curves[].prediction[].oil（模型留一折外预测，含共形区间 lo/hi）
 *  - 不措施世界线 = Σ curves[].baseline[].oil（事件前锚点按 exp 递减外推）
 *  - 两条线在 M0 同为 0，之后分叉；差额即「措施增量」口径
 *  - 体积换算系数 k 直接由 bundle 自身 12 月口径反解：k = value_oil / Σ(pred−base)，
 *    保证 M12 与 bundle.value_oil 完全一致；反解不出则退回 30.44 d/月 并打角标
 *  - 分摊 NPV = value_npv ×（截至 Mm 的增量进度），属前端口径，已打「分摊」角标；
 *    loss_prob / cvar / hit_rate / regret 一律不在此处推算
 */
const store = useAppStore()

/**
 * 画布尺寸跟随容器实测（1:1，不再用固定 viewBox 缩放）。
 * 原因：固定 900×168 的 viewBox 在 1366 窄栏下会被缩放到 ~0.34，
 * 轴标签 9 号字实际只有 3px，肉眼不可读。改成 1:1 后字号即真实像素。
 */
const plotEl = ref<HTMLElement | null>(null)
const box = ref({ w: 680, h: 132 })
let ro: ResizeObserver | null = null
onMounted(() => {
  if (!plotEl.value || typeof ResizeObserver === 'undefined') return
  ro = new ResizeObserver((es) => {
    for (const e of es) {
      const r = e.contentRect
      if (r.width > 40 && r.height > 40) box.value = { w: Math.round(r.width), h: Math.round(r.height) }
    }
  })
  ro.observe(plotEl.value)
})
onBeforeUnmount(() => ro?.disconnect())

const W = computed(() => Math.max(240, box.value.w))
const H = computed(() => Math.max(90, box.value.h))
const PAD_L = 62
const PAD_R = 14
const PAD_T = 16
const PAD_B = 24
const X0 = PAD_L
const X1 = computed(() => W.value - PAD_R)
const Y0 = PAD_T
const Y1 = computed(() => H.value - PAD_B)

const curve = computed(() => store.focusCurve)
const well = computed(() => store.focusWell)
const m = computed(() => store.timelineMonth)

interface Row {
  m: number
  frac: number | null
  base: number | null
  lo: number | null
  hi: number | null
}

const model = computed(() => {
  const c = curve.value
  if (!c || c.available === false) return null
  const pred = (c.prediction ?? []).slice(0, 12)
  const base = (c.baseline ?? []).slice(0, 12)
  if (!pred.length && !base.length) return null
  const n = Math.max(pred.length, base.length)
  const rows: Row[] = [{ m: 0, frac: 0, base: 0, lo: 0, hi: 0 }]
  let fAcc = 0
  let bAcc = 0
  let loAcc = 0
  let hiAcc = 0
  let fOk = true
  let bOk = true
  for (let i = 1; i <= n; i++) {
    const p = pred[i - 1]
    const b = base[i - 1]
    if (fOk) {
      if (p && Number.isFinite(p.oil)) {
        fAcc += p.oil
        loAcc += typeof p.lo === 'number' && Number.isFinite(p.lo) ? p.lo : p.oil
        hiAcc += typeof p.hi === 'number' && Number.isFinite(p.hi) ? p.hi : p.oil
      } else fOk = false
    }
    if (bOk) {
      if (b && Number.isFinite(b.oil)) bAcc += b.oil
      else bOk = false
    }
    rows.push({
      m: i,
      frac: fOk ? fAcc : null,
      base: bOk ? bAcc : null,
      lo: fOk ? loAcc : null,
      hi: fOk ? hiAcc : null,
    })
  }
  // 体积换算系数：由 bundle 12 月口径反解，保证 M12 对齐 value_oil
  const last = rows[rows.length - 1]
  const dRate = last.frac != null && last.base != null ? last.frac - last.base : null
  const vo = typeof well.value?.value_oil === 'number' ? (well.value.value_oil as number) : null
  let k: number | null = null
  let kSrc = 'none'
  if (dRate != null && Math.abs(dRate) > 1e-9 && vo != null) {
    k = vo / dRate
    kSrc = 'bundle'
  } else if (dRate != null && Math.abs(dRate) > 1e-9) {
    k = 30.44
    kSrc = 'assumed'
  }
  /**
   * 共形下界退化检测：bundle 里 prediction[].lo 若整条曲线都 ≤0（实测 v2 为 924/924 全 0），
   * 则「90% 区间」下界恒为 0，属数据侧单边截断，前端如实标注，不伪造下界。
   */
  const loAll = pred.map((p) => (typeof p?.lo === 'number' ? p.lo : null)).filter((x): x is number => x !== null)
  // 优先听 bundle 的口径字段（final77 起自带 interval_kind），本地检测只作兜底
  const loDegenerate =
    c.interval_kind === 'one_sided_lower_clipped_at_zero' ||
    (loAll.length > 0 && loAll.every((x) => x <= 0))
  return { rows, n, k, kSrc, dRate, loDegenerate }
})

/** 累计量单位换算：曲线 oil 是 m³/d（月均日产），乘 k（≈月天数）后才是 m³ 累计 */
const kk = computed(() => model.value?.k ?? null)
const vol = (x: number | null): number | null => (x == null || kk.value == null ? null : x * kk.value)

const vals = computed(() => {
  const mo = model.value
  if (!mo) return [0, 1]
  const v: number[] = []
  for (const r of mo.rows) for (const x of [r.frac, r.base, r.lo, r.hi]) { const y = vol(x); if (y != null) v.push(y) }
  return v.length ? v : [0, 1]
})
const vmin = computed(() => Math.min(0, ...vals.value))
const vmax = computed(() => {
  const mx = Math.max(...vals.value)
  return mx === vmin.value ? vmin.value + 1 : mx
})

function mx(mo: number) {
  return X0 + (X1.value - X0) * (mo / 12)
}
function my(v: number) {
  const t = (v - vmin.value) / (vmax.value - vmin.value || 1)
  return Y1.value - (Y1.value - Y0) * t
}

/**
 * x 轴月份**标签**抽稀：刻度线 13 条照画（工程图纸要留刻度），标签按可用宽度决定密度。
 * 判据 = 每月像素间距 ≥ 一个「M12」标签宽（3 字符 × 字宽）+ 最小间隙：
 *   放得下 → 13 个全标（1920）
 *   放不下 → M0/M3/M6/M9/M12（1366 投屏档，绘图区仅 ~212px）
 *   仍不够 → M0/M6/M12
 * 这样窄屏下刻度不会互相压字，宽屏又能看全。
 */
const xLabelMonths = computed(() => {
  const step = (X1.value - X0) / 12
  const fs = store.projection ? 12 : 9
  const need = fs * 0.62 * 3 + 6 // 「M12」3 字符 + 6px 最小间隙
  if (step >= need) return [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]
  if (step * 3 >= need) return [0, 3, 6, 9, 12]
  return [0, 6, 12]
})
function pathOf(key: 'frac' | 'base' | 'lo' | 'hi'): string {
  const mo = model.value
  if (!mo) return ''
  return mo.rows
    .filter((r) => vol(r[key]) != null)
    .map((r) => `${mx(r.m).toFixed(1)},${my(vol(r[key]) as number).toFixed(1)}`)
    .join(' ')
}
const pFrac = computed(() => pathOf('frac'))
const pBase = computed(() => pathOf('base'))
const bandPath = computed(() => {
  const mo = model.value
  if (!mo) return ''
  const hi = mo.rows.filter((r) => vol(r.hi) != null).map((r) => `${mx(r.m).toFixed(1)},${my(vol(r.hi) as number).toFixed(1)}`)
  const lo = mo.rows
    .filter((r) => vol(r.lo) != null)
    .map((r) => `${mx(r.m).toFixed(1)},${my(vol(r.lo) as number).toFixed(1)}`)
    .reverse()
  return hi.length && lo.length ? `${hi.join(' ')} ${lo.join(' ')}` : ''
})
const splitPath = computed(() => {
  const mo = model.value
  if (!mo) return ''
  const f = mo.rows.filter((r) => vol(r.frac) != null).map((r) => `${mx(r.m).toFixed(1)},${my(vol(r.frac) as number).toFixed(1)}`)
  const b = mo.rows
    .filter((r) => vol(r.base) != null)
    .map((r) => `${mx(r.m).toFixed(1)},${my(vol(r.base) as number).toFixed(1)}`)
    .reverse()
  return f.length && b.length ? `${f.join(' ')} ${b.join(' ')}` : ''
})
const splitPositive = computed(() => {
  const mo = model.value
  if (!mo) return false
  const last = mo.rows[mo.rows.length - 1]
  return (last.frac ?? 0) - (last.base ?? 0) >= 0
})

// —— 当前游标读数 ——
const cur = computed(() => {
  const mo = model.value
  if (!mo) return null
  const r = mo.rows.find((x) => x.m === m.value) ?? mo.rows[mo.rows.length - 1]
  const k = mo.k
  const dRate = r.frac != null && r.base != null ? r.frac - r.base : null
  const full = mo.dRate
  const progress = dRate != null && full != null && Math.abs(full) > 1e-9 ? dRate / full : null
  const npv = typeof well.value?.value_npv === 'number' ? (well.value.value_npv as number) : null
  // 区间：取「游标所在月」的累计分位（rows[m] 本身已是 0..m 月的累加），
  // 与措施累计 / 增量同一时点、同一单位（m³）。绝不跨月重复累加。
  return {
    row: r,
    fracVol: vol(r.frac),
    baseVol: vol(r.base),
    deltaVol: vol(dRate),
    loVol: vol(r.lo),
    hiVol: vol(r.hi),
    progress,
    npvPart: npv != null && progress != null ? npv * progress : null,
    npvFull: npv,
    kSrc: mo.kSrc,
    loDegenerate: mo.loDegenerate,
  }
})

/**
 * 世界线读数角标：
 *  - 区间按「对齐到当前月」裁剪，避免把未来月份的分位相加造成区间虚宽
 *  - 增量也按月口径给出「月率」版，方便与日产/月产对照
 */
const stamps = computed(() => {
  const mo = model.value
  const c = cur.value
  if (!mo || !c) return []
  const out: { k: string; v: string; cls?: string }[] = []
  const sgn = (v: number | null) => (v == null ? '暂无' : (v > 0 ? '+' : '') + v.toFixed(1))
  out.push({ k: '游标', v: `M${m.value}/12` })
  out.push({ k: '措施累计', v: c.fracVol == null ? '暂无' : c.fracVol.toFixed(1) })
  out.push({ k: '不措施累计', v: c.baseVol == null ? '暂无' : c.baseVol.toFixed(1) })
  out.push({ k: '增量 Δ', v: sgn(c.deltaVol), cls: c.deltaVol != null && c.deltaVol > 0 ? 'stamp-live' : 'stamp-assump' })
  out.push({
    k: '90% 区间',
    v:
      c.loVol == null || c.hiVol == null
        ? '暂无'
        : `[${c.loVol.toFixed(0)}, ${c.hiVol.toFixed(0)}] m³`,
  })
  out.push({ k: '分摊 NPV', v: sgn(c.npvPart) })
  out.push({ k: '进度', v: c.progress == null ? '暂无' : `${Math.round(c.progress * 100)}%` })
  out.push({ k: 'k', v: mo.kSrc === 'bundle' ? '反解' : mo.kSrc === 'assumed' ? '30.44' : '暂无' })
  return out
})

const breakEven = computed(() => {
  const v = curve.value?.break_even
  return typeof v === 'number' && Number.isFinite(v) ? v : null
})
const lag = computed(() => {
  const v = curve.value?.response_lag_months
  return typeof v === 'number' && Number.isFinite(v) ? v : null
})

// y 轴刻度（4 档）
const yTicks = computed(() => {
  const t = [0, 0.25, 0.5, 0.75, 1].map((f) => vmin.value + (vmax.value - vmin.value) * f)
  return t
})

// —— 拖拽 ——
const dragging = ref(false)
function monthFromEvent(e: PointerEvent) {
  const svg = (e.currentTarget as SVGRectElement).ownerSVGElement
  if (!svg) return
  const rect = svg.getBoundingClientRect()
  const rel = ((e.clientX - rect.left) / rect.width) * W.value
  const mm = Math.round(((rel - X0) / (X1.value - X0)) * 12)
  store.setTimelineMonth(Math.max(0, Math.min(12, mm)))
}
function onDown(e: PointerEvent) {
  dragging.value = true
  ;(e.currentTarget as SVGRectElement).setPointerCapture?.(e.pointerId)
  monthFromEvent(e)
}
function onMove(e: PointerEvent) {
  if (dragging.value) monthFromEvent(e)
}
function onUp(e: PointerEvent) {
  dragging.value = false
  ;(e.currentTarget as SVGRectElement).releasePointerCapture?.(e.pointerId)
}
function onKey(e: KeyboardEvent) {
  if (e.key === 'ArrowLeft') store.setTimelineMonth(Math.max(0, m.value - 1))
  else if (e.key === 'ArrowRight') store.setTimelineMonth(Math.min(12, m.value + 1))
}
</script>

<template>
  <section class="panel wl">
    <h3 class="panel-title">
      <span class="fig-no">DWG-COMP-003</span>
      <span class="fig-cap">时间轴 · 两条世界线（措施 / 不措施）</span>
      <span class="fig-unit">M0–M12 · 累计 m³（曲线 {{ store.meta.units.oil }}）</span>
    </h3>

    <div v-if="!model || !cur" class="na small">暂无（该井曲线缺失，不编造）</div>

    <div v-else class="body">
      <!-- 读数区：非对称，左侧窄、数值等宽 -->
      <div class="readout">
        <div class="rd-head mono">
          {{ well?.well_id }}<span class="dim"> · {{ well?.name ?? '暂无' }}</span>
        </div>
        <dl class="kv compact">
          <dt>游标</dt>
          <dd>M{{ m }}<span class="dim">/12</span></dd>
          <dt>措施累计</dt>
          <dd>{{ n(cur.fracVol, 1) }}</dd>
          <dt>不措施累计</dt>
          <dd>{{ n(cur.baseVol, 1) }}</dd>
          <dt>增量 Δ</dt>
          <dd :style="{ color: (cur.deltaVol ?? 0) >= 0 ? '#5f9e78' : '#c1503a' }">
            {{ signed(cur.deltaVol, 1) }}
          </dd>
          <dt>90% 区间</dt>
          <dd class="dim">
            [{{ n(cur.loVol, 0) }},{{ n(cur.hiVol, 0) }}]<span class="u">m³</span>
          </dd>
          <dt>分摊 NPV</dt>
          <dd :style="{ color: (cur.npvPart ?? 0) >= 0 ? '#5f9e78' : '#c1503a' }">
            {{ signed(cur.npvPart, 1) }}
          </dd>
          <dt>进度</dt>
          <dd>{{ cur.progress == null ? '暂无' : (cur.progress * 100).toFixed(0) + '%' }}</dd>
        </dl>
        <div class="row stamps">
          <span class="stamp stamp-assump">分摊口径</span>
          <span class="stamp" :class="cur.kSrc === 'bundle' ? 'stamp-live' : 'stamp-assump'">
            k={{ cur.kSrc === 'bundle' ? '反解' : '30.44' }}
          </span>
          <span class="stamp">保本 {{ breakEven == null ? '暂无' : breakEven.toFixed(1) }} 月</span>
          <span class="stamp">滞后 {{ lag == null ? '暂无' : lag }} 月</span>
          <span
            v-if="cur.loDegenerate"
            class="stamp stamp-oneside"
            title="bundle 的 prediction[].lo 全为 0：数据侧只给了上界分位，下界被截断在 0。这里如实画成 [0, 上界] 的单边带，不以预测线为中心伪造对称区间。"
          >
            单边 90% 区间（下限截断为 0）
          </span>
        </div>
      </div>

      <!-- 图表区（尺寸由 ResizeObserver 实测，viewBox 1:1 → 字号即真实像素） -->
      <div ref="plotEl" class="plot">
        <svg
          :viewBox="`0 0 ${W} ${H}`"
          class="chart"
          :class="{ dragging }"
          role="img"
          aria-label="措施与不措施两条世界线"
        >
          <!-- 网格 + y 刻度（单位 m³ 累计，与读数区 / 区间同源） -->
          <g>
            <!-- 单位贴左边距：若与 y 刻度同右对齐（X0-6），会和最上面的刻度值压字（实测 12×8px） -->
            <text
              x="2"
              :y="Y0 - 3"
              text-anchor="start"
              font-size="9"
              fill="#8a959b"
              font-family="ui-monospace, Consolas, monospace"
            >
              m³
            </text>
            <g v-for="(t, i) in yTicks" :key="'y' + i">
              <line :x1="X0" :y1="my(t)" :x2="X1" :y2="my(t)" stroke="#232a2f" stroke-width="1" />
              <text :x="X0 - 6" :y="my(t) + 3" text-anchor="end" font-size="9" fill="#69747a" font-family="ui-monospace, Consolas, monospace">
                {{ n(t, 0) }}
              </text>
            </g>
            <!-- x 刻度 -->
            <g font-family="ui-monospace, Consolas, monospace" font-size="9" fill="#69747a">
              <!-- 刻度线：13 条全画 -->
              <g v-for="mm in 13" :key="'xt' + mm">
                <line
                  :x1="mx(mm - 1)"
                  :y1="Y1"
                  :x2="mx(mm - 1)"
                  :y2="Y1 + 4"
                  stroke="#3d474e"
                  stroke-width="1"
                />
              </g>
              <!-- 标签：按可用宽度抽稀，绝不叠字（游标所在月另由下方游标标注给出） -->
              <text
                v-for="mo in xLabelMonths"
                :key="'xl' + mo"
                :x="mx(mo)"
                :y="Y1 + 18"
                text-anchor="middle"
              >
                M{{ mo }}
              </text>
            </g>
          </g>

          <!-- 分叉填充 -->
          <polygon
            v-if="splitPath"
            :points="splitPath"
            :fill="splitPositive ? 'rgba(95,158,120,.14)' : 'rgba(193,80,58,.16)'"
          />
          <!-- 90% 区间带 -->
          <polygon v-if="bandPath" :points="bandPath" fill="rgba(201,169,126,.13)" />

          <!-- 两条世界线 -->
          <polyline :points="pBase" fill="none" stroke="#7f9db1" stroke-width="1.6" stroke-dasharray="5 3" />
          <polyline :points="pFrac" fill="none" stroke="#d0764a" stroke-width="2.2" />

          <!-- 保本 / 滞后标记 -->
          <g v-if="breakEven != null && breakEven <= 12">
            <line
              :x1="mx(breakEven)"
              :y1="Y0"
              :x2="mx(breakEven)"
              :y2="Y1"
              stroke="#c9a97e"
              stroke-width="1"
              stroke-dasharray="2 3"
            />
            <text :x="mx(breakEven) + 3" :y="Y0 + 9" font-size="9" fill="#c9a97e" font-family="ui-monospace, Consolas, monospace">
              保本 {{ breakEven.toFixed(1) }}
            </text>
          </g>
          <g v-if="lag != null && lag <= 12">
            <line :x1="mx(lag)" :y1="Y1 - 6" :x2="mx(lag)" :y2="Y1 + 2" stroke="#c9a13a" stroke-width="1.5" />
            <text :x="mx(lag) + 3" :y="Y1 - 8" font-size="9" fill="#c9a13a" font-family="ui-monospace, Consolas, monospace">
              见效
            </text>
          </g>

          <!-- 游标 -->
          <g>
            <line :x1="mx(m)" :y1="Y0 - 4" :x2="mx(m)" :y2="Y1" stroke="#dde3e6" stroke-width="1" />
            <rect
              :x="mx(m) - 5"
              :y="Y0 - 12"
              width="10"
              height="10"
              transform="rotate(45 0 0)"
              fill="#dde3e6"
              :style="{ transformOrigin: `${mx(m)}px ${Y0 - 7}px` }"
            />
            <circle v-if="cur.fracVol != null" :cx="mx(m)" :cy="my(cur.fracVol)" r="3.4" fill="#d0764a" />
            <circle v-if="cur.baseVol != null" :cx="mx(m)" :cy="my(cur.baseVol)" r="3.4" fill="#7f9db1" />
          </g>

          <!-- 拖拽热区 -->
          <rect
            :x="X0"
            :y="Y0 - 14"
            :width="X1 - X0"
            :height="Y1 - Y0 + 18"
            fill="transparent"
            style="cursor: ew-resize"
            tabindex="0"
            @pointerdown="onDown"
            @pointermove="onMove"
            @pointerup="onUp"
            @pointercancel="onUp"
            @keydown="onKey"
          />

          <!-- 图例 -->
          <g font-family="ui-monospace, Consolas, monospace" font-size="9">
            <line :x1="X1 - 150" y1="8" :x2="X1 - 132" y2="8" stroke="#d0764a" stroke-width="2.2" />
            <text :x="X1 - 128" y="11" fill="#8a959b">措施（完井）</text>
            <line :x1="X1 - 60" y1="8" :x2="X1 - 42" y2="8" stroke="#7f9db1" stroke-width="1.6" stroke-dasharray="5 3" />
            <text :x="X1 - 38" y="11" fill="#8a959b">不措施</text>
          </g>
        </svg>
        <div class="row small dim hint">
          <span>拖动图内游标（或聚焦后 ←/→）→ 两条世界线在 M{{ m }} 处的差值与区间同步更新</span>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
/* 轴行高度由栅格给定，整条链必须 min-height:0，否则 svg 会把面板顶出可视区 */
.wl {
  padding: 8px 10px 6px;
  display: flex;
  flex-direction: column;
  min-height: 0;
  height: 100%;
  overflow: hidden;
}
.body { display: flex; gap: 12px; align-items: stretch; min-height: 0; flex: 1 1 0; overflow: hidden; }
.readout {
  width: 196px;
  flex: none;
  border-right: 1px solid #2c3339;
  padding-right: 10px;
  overflow: auto;
}
@media (max-width: 1440px) {
  .body { gap: 8px; }
  /* 矮屏：读数区改双列（8 行 → 4 行），避免被面板裁掉一半 */
  .readout { width: 178px; padding-right: 7px; }
  .readout .kv.compact { grid-template-columns: auto 1fr auto 1fr; font-size: 10px; line-height: 14px; }
  .readout .rd-head { margin-bottom: 3px; }
  .hint { display: none; }
}
.kv.compact { gap: 1px 8px; font-size: 11px; }
.kv.compact > dt { color: #8a959b; }
.kv.compact .u { color: #5b666e; font-size: 9px; margin-left: 2px; }
.rd-head { font-size: 11px; color: #dde3e6; margin-bottom: 6px; }
.stamps { gap: 5px; flex-wrap: wrap; margin-top: 5px; }
/* 单边区间：用砂岩色（口径/备注语义），不用黄色「示意」色 —— 这是数据事实，不是示意数据 */
.stamp-oneside { color: var(--sand, #c9a97e); border-color: rgba(201, 169, 126, .55); }
.plot {
  flex: 1;
  min-width: 0;
  min-height: 0;
  height: 100%;
  display: flex;
  flex-direction: column;
}
.plot .chart { flex: 1 1 0; min-height: 0; height: 100%; }
.hint { margin-top: 2px; font-size: 10px; }
.dragging { cursor: ew-resize; }
</style>
