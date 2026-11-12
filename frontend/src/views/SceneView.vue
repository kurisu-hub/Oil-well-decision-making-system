<script setup lang="ts">
/**
 * 三维决策沙盘 · P7 五动词
 *
 * 观察   OrbitControls（引擎内，限极角不穿地）
 * 选择   Raycaster 点井 → 相机飞行 + 决策卡（population / p₀ / NPV 区间）
 * 推演   拖 M0–M12 → 裂缝 / 曲面 / NPV 三者同源
 * 对照   A/B 两口井并排，差异用形状（▲●■）而非仅颜色
 * 下注   选 3 口 → 结算面板「期望 vs 实测」+ regret
 */
import { computed, onMounted, ref, shallowRef, watch } from 'vue'
import { useAppStore } from '@/stores/app'
import Scene3D from '@/components/Scene3D.vue'
import { buildScene, levelInfo } from '@/three/buildScene'
import type { CameraPreset, SceneJSON } from '@/three/engine'
import type { Curve, Well } from '@/types/bundle'
// T09/收口：vite.config assetsInclude 声明 .glb 为资产 → ?url import 走 asset 管线，
// assetsInlineLimit 拉满时内联 base64 data URI（D-004 A 案）；GLTFLoader.load(data URI)
// 不发网络请求（file:// 下 data: fetch 合法且非网络）
import tankGlbUrl from '@/assets/tank_lod0.glb?url'
import pumpjackGlbUrl from '@/assets/pumpjack_lod0.glb?url'
import treeGlbUrl from '@/assets/christmas_tree_lod0.glb?url'

type Mode = 'inspect' | 'compare' | 'bet'

const store = useAppStore()
const sceneRef = ref<InstanceType<typeof Scene3D> | null>(null)

const level = ref<'L0' | 'L1'>('L0')
const padId = ref<string>('')
/**
 * 推演游标（T01）：不再本组件自存，读全局回放时钟派生的 store.timelineMonth。
 * 这样「曲线游标 / 三维裂缝曲面 / KPI」三处同源，拖动回放条时一起变。
 */
const t = computed(() => store.timelineMonth)
const mode = ref<Mode>('inspect')
const picked = ref<string[]>([])
const link = shallowRef({ fracScale: 0, surfaceLift: 0, npv: 0 })
const perf = shallowRef({ fps: 0, triangles: 0, drawCalls: 0, tier: 'B' as string, level: 'L0' as 'L0' | 'L1' })
/** T09（E3）· 几何 basis 浮标：悬停任意几何显示其显示依据 */
const basisTip = ref<{ name: string; basis: string; x: number; y: number } | null>(null)

const DAYS = 30.4
const PRICE = 0.323
const COST = 45

const wellsById = computed(() => {
  const m = new Map<string, Well>()
  for (const w of store.wells) m.set(w.well_id, w)
  return m
})
const curvesById = computed(() => {
  const m = new Map<string, Curve>()
  for (const c of store.curves) m.set(c.well_id, c)
  return m
})

interface Fact {
  id: string
  population: string
  p0: number | null
  anchor: number
  npv: number
  npvLo: number
  npvHi: number
  realized: number
  state: string
  glyph: string
  md: number
  predSum: number
  baseSum: number
  actSum: number
}

function factsOf(id: string): Fact | null {
  const w = wellsById.value.get(id)
  const c = curvesById.value.get(id)
  if (!w || !c) return null
  const predSum = c.prediction.reduce((a, p) => a + (p.oil ?? 0), 0) * DAYS
  const baseSum = c.baseline.reduce((a, p) => a + (p.oil ?? 0), 0) * DAYS
  // D-053/H-015：实测 = curves[].actual（事件后 12 月）；缺失即契约破坏，显式 warn + 置 0，
  // 禁止静默降级到 history（事件前序列，两个不同的数）
  if (!c.actual) console.warn(`[H-015] ${id} 曲线缺 actual 字段（bundle 契约破坏），实测计 0`)
  const actSum = (c.actual ?? []).reduce((a, p) => a + (p.oil ?? 0), 0) * DAYS
  const npvLo = c.prediction.reduce((a, p) => a + (p.lo ?? p.oil ?? 0), 0) * DAYS * PRICE - COST
  const npvHi = c.prediction.reduce((a, p) => a + (p.hi ?? p.oil ?? 0), 0) * DAYS * PRICE - COST
  const geo = (store.geo as { wells?: { well_id: string; max_md_ft?: number }[] } | null)?.wells
    ?.find((g) => g.well_id === id)
  return {
    id,
    population: String(w.population ?? '—'),
    p0: typeof w.zero_prob === 'number' ? w.zero_prob : null,
    anchor: w.anchor ?? 0,
    npv: w.value_npv ?? 0,
    npvLo,
    npvHi,
    realized: (actSum - baseSum) * PRICE - COST,
    state: String(w.state ?? 'gray'),
    glyph: ({ green: '▲', yellow: '●', red: '■', gray: '◇' } as Record<string, string>)[String(w.state)] ?? '◇',
    md: Math.round((geo?.max_md_ft ?? 0) * 0.3048),
    predSum,
    baseSum,
    actSum,
  }
}

const focus = computed(() => (picked.value.length === 1 ? factsOf(picked.value[0]) : null))
const abPair = computed(() =>
  mode.value === 'compare' && picked.value.length === 2
    ? (picked.value.map(factsOf).filter(Boolean) as Fact[])
    : [],
)
const betFacts = computed(() =>
  mode.value === 'bet' ? (picked.value.map(factsOf).filter(Boolean) as Fact[]) : [],
)
const betSum = computed(() => {
  const f = betFacts.value
  return {
    npv: f.reduce((a, x) => a + x.npv, 0),
    realized: f.reduce((a, x) => a + x.realized, 0),
  }
})
/** 事后最优 3 口：等价于 oracle（按实测 NPV 排序取前 3） */
const oracleValue = computed(() => {
  const list = store.wells
    .map((w) => factsOf(w.well_id)?.realized ?? -Infinity)
    .filter((x) => Number.isFinite(x))
    .sort((a, b) => b - a)
  return list.length >= 3 ? list[0] + list[1] + list[2] : null
})
const betRegret = computed(() => {
  if (betFacts.value.length !== 3 || oracleValue.value == null) return null
  return oracleValue.value - betSum.value.realized
})

const geoInfo = computed(() => levelInfo({ geo: store.geo } as unknown as Record<string, any>))
const pads = computed(() => {
  const g = (store.geo ?? {}) as { pads?: { pad_id: string; n: number; span_m: number }[] }
  return (g.pads ?? []).slice().sort((a, b) => b.n - a.n)
})

/** 单井 pad：进去只有一根柱子，必须明说，不许假装热闹 */
const lonelyPad = computed(() => {
  if (level.value !== 'L1') return null
  const p = pads.value.find((x) => x.pad_id === padId.value)
  return p && p.n === 1 ? p : null
})

const scene = computed<SceneJSON>(() =>
  buildScene(
    { wells: store.wells, curves: store.curves, geo: store.geo } as unknown as Record<string, any>,
    { level: level.value, padId: padId.value || pads.value[0]?.pad_id },
  ),
)

function rebuild() {
  sceneRef.value?.setLevel(level.value, { padId: padId.value || pads.value[0]?.pad_id })
  sceneRef.value?.setScene(scene.value)
  sceneRef.value?.setCamera((level.value === 'L0' ? 'C0' : 'C1') as CameraPreset, { durationMs: 0 })
  applyTime()
  applySelection()
}

function onTimeInput(e: Event) {
  // 手动拖推演滑杆 = 对当前焦点井的显式操作 → 先钉住焦点再写全局时钟。
  // 不钉的话 autoFocus 焦点跟随会在 replayMi 变化时抢焦点（最近事件月重新锚定），
  // 77 事件摊 121 月、事件间隔 1–2 月 → timelineMonth 被压回 ≈1，滑杆形同虚设
  // （scene_check E4 实测 t=3/12 读数全等，即此根因）。
  // 与 setFocus「手动选井后置 pinned」同一语义：用户显式操作优先于自动跟随。
  store.focusPinned = true
  // 写回全局时钟（0–12 换算成回放位置），不在此组件留副本
  store.setTimelineMonth(Number((e.target as HTMLInputElement).value))
}

function applyTime() {
  const r = sceneRef.value?.setTime(t.value)
  if (r) link.value = r
}

// 回放条拖动 / 播放推进时，三维推演跟着走（同源）
watch(() => store.timelineMonth, () => applyTime())

/* ------------------------------------------------ T08 液位接线（建模专家）
 * 场景就绪 → 挂储罐资产；全站日产油变化 → setSiteOil 驱动液位。
 * 口径（14:12 修正）：日产 = 77 井 current_oil 求和（151.09 m³/d，实测）。
 * 首版误用 value_oil（累计增油，合计 18954），液位恒被钳在 98% 不动——
 * HUD 上「99%」就是它。周转 2 天：151×2/500 = 60.4%，落在动态区间中部。
 */
const siteOil = computed(() => store.wells.reduce((s, w) => s + (w.current_oil ?? 0), 0))

async function onSceneReady() {
  const ext = scene.value.extent
  // 放在场景中心向东/向南偏移 12% 跨度处：躲开井位，又在默认相机视野里
  const cx = (ext.x[0] + ext.x[1]) / 2
  const cz = (ext.z[0] + ext.z[1]) / 2
  const ox = (ext.x[1] - ext.x[0]) * 0.12
  const oz = (ext.z[1] - ext.z[0]) * 0.12
  // D-061：三件资产一次装配（同一 ready 回调，一次重建，不许各建一次）
  await sceneRef.value?.attachAssets({ url: tankGlbUrl, position: [cx + ox, 0, cz + oz], turnoverDays: 2 })
  // 抽油机 8 台：沿 X 排开（间距 22 m），避开储罐位置
  await sceneRef.value?.attachPumpjacks({
    url: pumpjackGlbUrl,
    position: [cx - ox - 60, 0, cz - oz],
    spacing: 22,
    count: 8,
    rotationY: Math.PI * 0.5,
    strokeRate: 5,
  })
  // 采油树：站内井口装置示意（储罐旁）
  await sceneRef.value?.attachTree({ url: treeGlbUrl, position: [cx + ox + 18, 0, cz - oz - 10] })
  // immediate watch 在资产就绪前跑过一次（tank 为 null 被忽略），这里补喂当前值
  sceneRef.value?.setSiteOil(siteOil.value)
}

watch(siteOil, (v) => sceneRef.value?.setSiteOil(v), { immediate: true })

function applySelection() {
  sceneRef.value?.setSelection(picked.value)
  sceneRef.value?.highlight(picked.value)
}

function setMode(m: Mode) {
  mode.value = m
  picked.value = []
  applySelection()
}

function fly(p: CameraPreset) {
  sceneRef.value?.setCamera(p, { durationMs: 700 })
}

function onPick(r: { wellId: string | null }) {
  const id = r.wellId
  if (!id) return
  const cap = mode.value === 'bet' ? 3 : mode.value === 'compare' ? 2 : 1
  const idx = picked.value.indexOf(id)
  if (idx >= 0) picked.value.splice(idx, 1)
  else {
    if (picked.value.length >= cap) picked.value.shift()
    picked.value.push(id)
  }
  applySelection()
  if (mode.value === 'inspect') sceneRef.value?.focusWell(id)
}

function fmt(v: number | null | undefined, d = 1) {
  return v == null || !Number.isFinite(v) ? '暂无' : v.toFixed(d)
}

onMounted(() => {
  if (!padId.value && pads.value.length) padId.value = pads.value[0].pad_id
  requestAnimationFrame(() => rebuild())
})
</script>

<template>
  <section class="page">
    <header class="hd">
      <h2>三维决策沙盘 <span class="fig-no">DWG-COMP-3D</span></h2>
      <p class="sub">
        three.js 0.170 · 单文件离线 · 两级尺度（L0 区域 101 km / L1 井场 {{ geoInfo.L1?.size_m_default ?? 300 }} m）
        · 五动词：观察 / 选择 / 推演 / 对照 / 下注
      </p>
    </header>

    <div class="ctrl">
      <div class="grp">
        <span class="lbl">层级</span>
        <button :class="['btn', level === 'L0' && 'on']" @click="level = 'L0'; rebuild()">L0 区域</button>
        <button :class="['btn', level === 'L1' && 'on']" @click="level = 'L1'; rebuild()">L1 井场</button>
        <select v-if="level === 'L1'" v-model="padId" class="sel" @change="rebuild()">
          <option v-for="p in pads" :key="p.pad_id" :value="p.pad_id">
            {{ p.pad_id }} · {{ p.n }} 井 · {{ Math.round(p.span_m) }} m
          </option>
        </select>
      </div>

      <div class="grp">
        <span class="lbl">动词</span>
        <button :class="['btn', mode === 'inspect' && 'on']" @click="setMode('inspect')">选择</button>
        <button :class="['btn', mode === 'compare' && 'on']" @click="setMode('compare')">对照 A/B</button>
        <button :class="['btn', mode === 'bet' && 'on']" @click="setMode('bet')">下注 3 口</button>
      </div>

      <div class="grp">
        <span class="lbl">机位</span>
        <button v-for="c in (['C0','C1','C2','C3','C4'] as CameraPreset[])" :key="c"
                class="btn" @click="fly(c)">{{ c }}</button>
      </div>

      <div class="grp grow">
        <span class="lbl">推演 t = M{{ t }}</span>
        <input :value="t" type="range" min="0" max="12" step="1" class="rng" @input="onTimeInput" />
      </div>
    </div>

    <div class="wrap">
      <Scene3D ref="sceneRef" :scene="scene" @pick="onPick" @perf="(p) => (perf = p)"
               @basis="(b) => (basisTip = b)" @ready="onSceneReady" />

      <!-- T09（E3）：几何依据浮标，跟随光标 -->
      <div v-if="basisTip" class="basis-tip" :data-name="basisTip.name"
           :style="{ left: basisTip.x + 14 + 'px', top: Math.max(basisTip.y - 64, 8) + 'px' }">
        <div class="bt-name">{{ basisTip.name }}</div>
        <div class="bt-body">{{ basisTip.basis }}</div>
      </div>

      <aside class="side">
        <!-- 选择：决策卡 -->
        <div v-if="mode === 'inspect' && focus" class="card">
          <div class="ttl">
            决策卡 · <span class="mono">{{ focus.id }}</span>
            <span class="glyph" :class="'s-' + focus.state">{{ focus.glyph }}</span>
          </div>
          <dl>
            <dt>事件类型</dt><dd>{{ focus.population }}</dd>
            <dt>本月零产概率 p₀</dt><dd>{{ focus.p0 == null ? '暂无' : (focus.p0 * 100).toFixed(1) + '%' }}</dd>
            <dt>锚点日产</dt><dd>{{ fmt(focus.anchor, 2) }} m³/d</dd>
            <dt>期望 NPV</dt><dd>{{ fmt(focus.npv) }} 万元</dd>
            <dt>NPV 区间</dt><dd>{{ fmt(focus.npvLo, 0) }} ~ {{ fmt(focus.npvHi, 0) }}</dd>
            <dt>井深 MD</dt><dd>{{ focus.md }} m</dd>
          </dl>
          <p class="note">
            点井 → 相机飞至 {{ level === 'L0' ? 'C1 井场' : 'C2 井筒' }}；再点一次取消。
            「选择」只做候选排序，不构成建议。
          </p>
        </div>
        <div v-else-if="mode === 'inspect'" class="card hint">
          <div class="ttl">选择</div>
          <p class="note">点井口柱查看决策卡。当前未选中。</p>
        </div>

        <!-- 对照：A/B -->
        <div v-if="mode === 'compare'" class="card">
          <div class="ttl">对照 A/B <span class="dim2">（形状区分，不只靠颜色）</span></div>
          <p v-if="abPair.length < 2" class="note">
            点两口井。已选 {{ picked.length }}/2{{ picked.length ? '：' + picked.join(' · ') : '' }}
          </p>
          <table v-else class="cmp">
            <thead>
              <tr><th></th><th>A</th><th>B</th><th>差</th></tr>
            </thead>
            <tbody>
              <tr><td>井号</td><td class="mono">{{ abPair[0].id }}</td><td class="mono">{{ abPair[1].id }}</td><td>—</td></tr>
              <tr><td>状态</td>
                <td><span class="glyph" :class="'s-' + abPair[0].state">{{ abPair[0].glyph }}</span> {{ abPair[0].state }}</td>
                <td><span class="glyph" :class="'s-' + abPair[1].state">{{ abPair[1].glyph }}</span> {{ abPair[1].state }}</td>
                <td>{{ abPair[0].state === abPair[1].state ? '同' : '异' }}</td></tr>
              <tr><td>事件</td><td>{{ abPair[0].population }}</td><td>{{ abPair[1].population }}</td>
                <td>{{ abPair[0].population === abPair[1].population ? '同' : '异' }}</td></tr>
              <tr><td>p₀</td><td>{{ fmt((abPair[0].p0 ?? NaN) * 100, 1) }}%</td>
                <td>{{ fmt((abPair[1].p0 ?? NaN) * 100, 1) }}%</td>
                <td>{{ fmt(((abPair[0].p0 ?? 0) - (abPair[1].p0 ?? 0)) * 100, 1) }} pp</td></tr>
              <tr><td>期望 NPV</td><td>{{ fmt(abPair[0].npv) }}</td><td>{{ fmt(abPair[1].npv) }}</td>
                <td>{{ fmt(abPair[0].npv - abPair[1].npv) }}</td></tr>
              <tr><td>实测 NPV</td><td>{{ fmt(abPair[0].realized) }}</td><td>{{ fmt(abPair[1].realized) }}</td>
                <td>{{ fmt(abPair[0].realized - abPair[1].realized) }}</td></tr>
              <tr><td>预测误差</td><td>{{ fmt(abPair[0].npv - abPair[0].realized) }}</td>
                <td>{{ fmt(abPair[1].npv - abPair[1].realized) }}</td><td>—</td></tr>
            </tbody>
          </table>
        </div>

        <!-- 下注：结算 -->
        <div v-if="mode === 'bet'" class="card">
          <div class="ttl">下注结算 <span class="dim2">（{{ picked.length }}/3）</span></div>
          <p v-if="betFacts.length < 3" class="note">
            点 3 口井形成组合。已选：{{ picked.join(' · ') || '无' }}
          </p>
          <template v-else>
            <dl>
              <dt>期望（Σ 点估计）</dt><dd>{{ fmt(betSum.npv) }} 万元</dd>
              <dt>实测（事后）</dt><dd>{{ fmt(betSum.realized) }} 万元</dd>
              <dt>oracle 上界</dt><dd>{{ fmt(oracleValue) }} 万元</dd>
              <dt>regret</dt><dd :class="{ neg: (betRegret ?? 0) > 0 }">{{ fmt(betRegret) }} 万元</dd>
            </dl>
            <p class="note">
              期望与实测并列，差值就是模型误差。regret = oracle − 实测，
              越小说明这注押得越接近事后最优。
            </p>
          </template>
        </div>

        <!-- 推演联动 -->
        <div class="card">
          <div class="ttl">推演联动（同源 t）</div>
          <dl>
            <dt>裂缝生长</dt><dd>{{ (link.fracScale * 100).toFixed(1) }}%</dd>
            <dt>曲面抬升</dt><dd>{{ link.surfaceLift.toFixed(1) }} m</dd>
            <dt>累计 NPV</dt><dd>{{ link.npv.toFixed(0) }} 万元</dd>
          </dl>
          <p class="note">三者由同一个 <code>setTime(t)</code> 返回，改 t 同时变。</p>
        </div>

        <!-- 性能 -->
        <div class="card">
          <div class="ttl">性能</div>
          <dl>
            <dt>Tier</dt><dd>{{ perf.tier }}</dd>
            <dt>帧率</dt><dd>{{ perf.fps }} fps</dd>
            <dt>三角面</dt><dd>{{ perf.triangles.toLocaleString() }}</dd>
            <dt>Draw call</dt><dd>{{ perf.drawCalls }}</dd>
          </dl>
        </div>

        <!-- 图例 -->
        <div class="card">
          <div class="ttl">图例（形状冗余，灰度可辨）</div>
          <ul class="lg">
            <li><span class="glyph s-green">▲</span>绿 · 可判定</li>
            <li><span class="glyph s-yellow">●</span>黄 · 观望</li>
            <li><span class="glyph s-red">■</span>红 · 不可判定</li>
            <li><span class="glyph s-gray">◇</span>灰 · 数据不足</li>
            <li><span class="ring pos" />圆环 = NPV ≥ 0</li>
            <li><span class="ring neg" />方环 = NPV &lt; 0</li>
            <li><span class="ring sel" />青环 = 已选（≤3 口）</li>
          </ul>
          <p class="note">
            井口柱高 = 锚点；柱形棱数 = 状态（6/4/3/8 棱）；环径 = |NPV|^0.5；
            管线粗细 = 预测产量三档；缝长 = assumptions（带 basis）。
            悬停任意几何可查看其显示依据（E3 basis 浮标）。
          </p>
        </div>

        <div v-if="lonelyPad" class="card warn">
          <div class="ttl">附近无邻近井</div>
          <p class="note">
            {{ lonelyPad.pad_id }} 是单井井场（58 个 pad 中 45 个是单井）。
            这里只有一根柱子是真实结构，不是渲染缺失。
          </p>
        </div>
      </aside>
    </div>
  </section>
</template>

<style scoped>
.page { padding: 12px 16px 24px; }
.hd h2 { font-size: 15px; margin: 0 0 2px; font-weight: 600; }
.sub { margin: 0 0 10px; font-size: 11px; color: #6b767c; }
.fig-no { font-size: 10px; color: #8a959b; margin-left: 6px; font-family: ui-monospace, Consolas, monospace; }
.ctrl { display: flex; flex-wrap: wrap; gap: 10px 18px; align-items: center; margin-bottom: 10px; }
.grp { display: flex; align-items: center; gap: 6px; }
.grp.grow { flex: 1; min-width: 220px; }
.lbl { font-size: 11px; color: #6b767c; }
.btn { font-size: 11px; padding: 3px 9px; border: 1px solid #cfd6da; background: #fff; border-radius: 3px; cursor: pointer; color: #2b3338; }
.btn.on { background: #2b3338; color: #fff; border-color: #2b3338; }
.sel { font-size: 11px; padding: 3px 6px; border: 1px solid #cfd6da; border-radius: 3px; max-width: 240px; }
.rng { flex: 1; }
.wrap { display: grid; grid-template-columns: minmax(0, 1fr) 288px; gap: 12px; height: 600px; }
.side { display: flex; flex-direction: column; gap: 8px; overflow: auto; }
.card { border: 1px solid #e2e7ea; border-radius: 4px; padding: 8px 10px; background: #fff; }
.card.hint { border-style: dashed; }
.card.warn { border-color: #e0b48a; background: #fdf7f0; }
.ttl { font-size: 11px; font-weight: 600; margin-bottom: 6px; color: #2b3338; }
.dim2 { font-weight: 400; color: #8a959b; font-size: 10px; }
dl { margin: 0; display: grid; grid-template-columns: auto 1fr; gap: 3px 8px; font-size: 11px; }
dt { color: #6b767c; }
dd { margin: 0; text-align: right; font-family: ui-monospace, Consolas, monospace; color: #1b2227; }
dd.neg { color: #a8453c; }
.note { font-size: 10.5px; color: #6b767c; line-height: 1.5; margin: 6px 0 0; }
code { font-family: ui-monospace, Consolas, monospace; background: #f2f5f6; padding: 0 3px; border-radius: 2px; }
.glyph { font-size: 11px; font-weight: 700; }
.s-green { color: #3f7a4c; }
.s-yellow { color: #a8862f; }
.s-red { color: #a8453c; }
.s-gray { color: #6b767c; }
.cmp { width: 100%; border-collapse: collapse; font-size: 10.5px; }
.cmp th, .cmp td { border-bottom: 1px solid #eef1f2; padding: 2px 4px; text-align: right; }
.cmp th:first-child, .cmp td:first-child { text-align: left; color: #6b767c; }
.cmp th { color: #6b767c; font-weight: 500; }
.lg { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: 1fr 1fr; gap: 3px 8px; font-size: 10.5px; color: #4a555b; }
.ring { display: inline-block; width: 9px; height: 9px; border: 2px solid #5f9e6b; border-radius: 50%; margin-right: 4px; vertical-align: -1px; }
.ring.neg { border-radius: 1px; border-color: #b04a40; }
.ring.sel { border-color: #67c7d6; }
/* T09（E3）：几何依据浮标 */
.basis-tip {
  position: fixed;
  z-index: 40;
  max-width: 320px;
  pointer-events: none;
  background: #f8fafb;
  border: 1px solid #c4ccd1;
  border-left: 3px solid #4a7fa5;
  border-radius: 4px;
  padding: 6px 9px;
  box-shadow: 0 2px 10px rgba(10, 20, 26, 0.18);
}
.bt-name {
  font-size: 10px;
  font-weight: 700;
  color: #35526b;
  font-family: ui-monospace, Consolas, monospace;
  margin-bottom: 3px;
}
.bt-body {
  font-size: 10.5px;
  color: #3c464d;
  line-height: 1.5;
}
</style>
