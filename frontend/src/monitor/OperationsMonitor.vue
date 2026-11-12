<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import TrendChart from './TrendChart.vue'
import { duration, events, initialMinute, metrics, phases, samples, timeAt, type Metric } from './replay'

const minute = ref(initialMinute)
const selectedMetric = ref<Metric>(metrics[0])
const playing = ref(false)
const speed = ref(1)
const alarmsOnly = ref(false)
let timer: number | undefined

const current = computed(() => samples[minute.value])
const stageIndex = computed(() => {
  const next = phases.findIndex(phase => phase.start > minute.value)
  return next === -1 ? phases.length - 1 : next - 1
})
const stage = computed(() => phases[stageIndex.value])
const finished = computed(() => minute.value === duration)
const history = computed(() => events.filter(event => event.minute <= minute.value).reverse())
const activeAlarms = computed(() => history.value.filter(event => event.type === 'alarm' && event.cleared > minute.value).length)
const shownEvents = computed(() => history.value.filter(event => !alarmsOnly.value || event.type === 'alarm'))

/** 统一停止回放。拖动时间、到达末尾和组件卸载都复用这里，防止定时器继续推进。 */
function pause() {
  window.clearInterval(timer)
  timer = undefined
  playing.value = false
}

function seek(to: number) {
  pause()
  minute.value = Math.max(0, Math.min(duration, to))
}

function togglePlayback() {
  if (playing.value) {
    pause()
    return
  }
  if (finished.value) minute.value = 0
  playing.value = true
  timer = window.setInterval(() => {
    minute.value = Math.min(duration, minute.value + speed.value)
    if (finished.value) pause()
  }, 1000)
}

function displayValue(metric: Metric): string {
  return current.value[metric.key]?.toFixed(metric.digits) ?? '无采样'
}

onBeforeUnmount(pause)
</script>

<template>
  <div class="workspace">
    <aside class="rail">
      <div class="brand">
        <span class="brand-icon" aria-hidden="true"><i /><i /><i /></span>
        <div><strong>油田作业监控</strong><small>FIELD OPERATIONS</small></div>
      </div>
      <div class="nav-heading">单井作业</div>
      <nav aria-label="页面导航">
        <a href="#overview"><span aria-hidden="true">▦</span>作业总览</a>
        <a href="#trend"><span aria-hidden="true">⌁</span>测点趋势</a>
        <a href="#events"><span aria-hidden="true">≡</span>事件与告警</a>
      </nav>
      <div class="rail-note">
        <span class="status-dot" />
        <div><strong>模拟数据源</strong><small>单井启运样例</small></div>
      </div>
    </aside>

    <main class="main" id="overview">
      <header class="topbar">
        <div class="breadcrumb">北一井场 <span aria-hidden="true">/</span> A-07 井</div>
        <span class="mode"><span class="status-dot" />模拟回放</span>
      </header>
      <div class="content">
        <section class="intro" aria-labelledby="operation-title">
          <div>
            <div class="job-id">作业单 OP-A07-001</div>
            <h1 id="operation-title">单井启运监控</h1>
            <p>北一井场 · A-07 井 · 早班 09:00–09:40</p>
          </div>
          <div class="clock">
            <span>回放时刻</span><strong>{{ timeAt(minute) }}</strong>
          </div>
        </section>

        <section class="kpis" aria-label="当前测点和告警">
          <button
            v-for="metric in metrics" :key="metric.key" type="button" class="card kpi"
            :class="{ selected: selectedMetric.key === metric.key }"
            :aria-pressed="selectedMetric.key === metric.key"
            @click="selectedMetric = metric"
          >
            <span class="kpi-label"><span class="metric-dot" :style="{ background: metric.color }" />{{ metric.name }}</span>
            <span class="kpi-value" :class="{ unavailable: current[metric.key] === null }">
              {{ displayValue(metric) }} <small v-if="current[metric.key] !== null">{{ metric.unit }}</small>
            </span>
            <span class="kpi-foot"><span class="tag">{{ metric.tag }}</span><span v-if="current[metric.key] === null">信号中断</span></span>
          </button>
          <article class="card kpi alarm-summary">
            <span class="kpi-label"><span class="metric-dot amber" />活动告警</span>
            <span class="kpi-value" :class="{ amberText: activeAlarms > 0 }">{{ activeAlarms }} <small>条</small></span>
            <span class="kpi-foot">{{ activeAlarms ? '当前时刻尚未恢复' : '当前时刻无活动告警' }}</span>
          </article>
        </section>

        <section class="card process" aria-labelledby="process-title">
          <div class="section-heading">
            <div><h2 id="process-title">作业流程</h2><p>{{ finished ? '交接记录已完成' : stage.detail }}</p></div>
            <span class="chip state">{{ finished ? '已完成' : `当前：${stage.name}` }}</span>
          </div>
          <ol class="steps">
            <li
              v-for="(phase, index) in phases" :key="phase.start"
              :class="{ done: finished || index < stageIndex, active: !finished && index === stageIndex }"
            >
              <button type="button" :aria-current="!finished && index === stageIndex ? 'step' : undefined" @click="seek(phase.start)">
                <span class="step-marker">{{ finished || index < stageIndex ? '✓' : index + 1 }}</span>
                <strong>{{ phase.name }}</strong>
                <small>{{ timeAt(phase.start) }}</small>
              </button>
            </li>
          </ol>
          <div class="transport">
            <button type="button" class="play" @click="togglePlayback">
              <span aria-hidden="true">{{ playing ? 'Ⅱ' : '▶' }}</span>
              {{ playing ? '暂停' : finished ? '重新播放' : '播放' }}
            </button>
            <button type="button" class="neutral" @click="seek(0)">回到开始</button>
            <label class="scrubber">
              <span class="sr-only">回放进度</span>
              <input type="range" min="0" :max="duration" :value="minute"
                :aria-valuetext="timeAt(minute)" @input="seek(Number(($event.target as HTMLInputElement).value))" />
            </label>
            <span class="elapsed">{{ minute }} / {{ duration }} 分钟</span>
            <select v-model.number="speed" aria-label="回放速度">
              <option :value="1">1 分钟/秒</option><option :value="2">2 分钟/秒</option><option :value="4">4 分钟/秒</option>
            </select>
          </div>
        </section>

        <div class="details">
          <section id="trend" class="card trend" aria-labelledby="trend-title">
            <div class="section-heading">
              <div><h2 id="trend-title">测点趋势</h2><p>{{ selectedMetric.tag }} · {{ selectedMetric.unit }} · 每分钟采样</p></div>
              <div class="segmented" aria-label="选择趋势测点">
                <button v-for="metric in metrics" :key="metric.key" type="button"
                  :aria-pressed="selectedMetric.key === metric.key" @click="selectedMetric = metric">{{ metric.name }}</button>
              </div>
            </div>
            <TrendChart :minute="minute" :metric="selectedMetric" />
          </section>

          <section id="events" class="card events" aria-labelledby="events-title">
            <div class="section-heading">
              <div><h2 id="events-title">事件与告警</h2><p>截至 {{ timeAt(minute) }}</p></div>
              <div class="segmented" aria-label="筛选事件">
                <button type="button" :aria-pressed="!alarmsOnly" @click="alarmsOnly = false">全部</button>
                <button type="button" :aria-pressed="alarmsOnly" @click="alarmsOnly = true">仅告警</button>
              </div>
            </div>
            <ol v-if="shownEvents.length" class="event-list">
              <li v-for="event in shownEvents" :key="event.id">
                <time>{{ timeAt(event.minute) }}</time>
                <div class="event-copy"><strong>{{ event.title }}</strong><small>{{ event.source }}</small></div>
                <span v-if="event.type === 'alarm'" class="chip" :class="event.cleared > minute ? 'warning' : 'state'">
                  {{ event.cleared > minute ? '未恢复' : '已恢复' }}
                </span>
                <span v-else class="chip record">记录</span>
              </li>
            </ol>
            <p v-else class="empty">截至当前时刻没有告警。</p>
          </section>
        </div>
      </div>
    </main>
  </div>
</template>
