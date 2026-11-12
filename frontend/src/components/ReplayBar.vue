<script setup lang="ts">
/**
 * ReplayBar · 历史回放器（T01）
 *
 * 口径：
 *  - 唯一时间源是 store.replayMi（绝对月序），本组件只做「播放 / 倍速 / 拖动」三件事
 *  - 曲线游标（WorldLine）、三维推演（SceneView.setTime）、回放 KPI 全部读同一个值
 *  - 不出现「实时 / 当前数据」字样：这是历史回放，不是实时接入（T02 红线）
 *  - 播放到数据集末端自动停，不循环——循环会让人误以为数据在持续更新
 */
import { computed, onBeforeUnmount, onMounted, watch } from 'vue'
import { useAppStore } from '@/stores/app'

const store = useAppStore()

const playing = computed(() => store.replayPlaying)
const speed = computed(() => store.replaySpeed)
const kpi = computed(() => store.replayKpi)
const SPEEDS: (1 | 4 | 16)[] = [1, 4, 16]

function onSpeed(s: 1 | 4 | 16) {
  store.setReplaySpeed(s)
}

/** 1× = 1 月/秒；100ms 一跳，累加真实经过时间，暂停期间不推进 */
let timer: number | null = null
let last = 0
onMounted(() => {
  last = performance.now()
  timer = window.setInterval(() => {
    const now = performance.now()
    const dt = now - last
    last = now
    store.advanceReplay(dt)
  }, 100)
})
onBeforeUnmount(() => {
  if (timer !== null) window.clearInterval(timer)
  timer = null
})

/** 键盘：空格播放/暂停，左右各 1 月（只在没有输入焦点时生效） */
function onKey(e: KeyboardEvent) {
  const el = e.target as HTMLElement | null
  const tag = el?.tagName?.toLowerCase() ?? ''
  if (tag === 'input' || tag === 'textarea' || el?.isContentEditable) return
  if (e.code === 'Space') {
    e.preventDefault()
    store.toggleReplay()
  } else if (e.key === 'ArrowLeft') {
    store.stepReplay(-1)
  } else if (e.key === 'ArrowRight') {
    store.stepReplay(1)
  }
}
onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))

function onSeek(e: Event) {
  const v = Number((e.target as HTMLInputElement).value) / 1000
  store.seekReplayFrac(v)
}

const pct = computed(() => Math.round(store.replayFrac * 1000) / 10)

/** 播放中把滑块拉到末尾就停（advanceReplay 已在端点自停，这里只兜底 UI） */
watch(playing, (v) => {
  if (!v) last = performance.now()
})
</script>

<template>
  <div
    class="bar"
    role="group"
    aria-label="历史回放器"
    :data-mi="store.replayMi"
    :data-m="store.timelineMonth"
    :data-focus="store.focusWellId"
  >
    <span class="tag">历史回放</span>

    <button class="btn play" :class="{ on: playing }" :aria-label="playing ? '暂停' : '播放'" @click="store.toggleReplay()">
      {{ playing ? '❚❚' : '▶' }}
    </button>
    <button class="btn" aria-label="上一月" @click="store.stepReplay(-1)">◀</button>
    <button class="btn" aria-label="下一月" @click="store.stepReplay(1)">▶</button>

    <div class="speeds" role="group" aria-label="倍速">
      <button
        v-for="s in SPEEDS"
        :key="s"
        class="sp"
        :class="{ sel: speed === s }"
        @click="onSpeed(s)"
      >
        {{ s }}×
      </button>
    </div>

    <input
      class="rng"
      type="range"
      min="0"
      max="1000"
      step="1"
      :value="Math.round(store.replayFrac * 1000)"
      aria-label="回放时间轴"
      @input="onSeek"
    />

    <span class="when">数据时刻 <b>{{ store.replayMonth }}</b></span>

    <span class="kpi" title="截至该数据时刻，已发生完井事件的井数 / 已完成 12 个月观察的井数">
      已入场 <b>{{ kpi.entered }}</b>/{{ kpi.total }} · 满 12 月 <b>{{ kpi.observed }}</b>
    </span>

    <button class="btn reset" title="回到数据集末端（最新历史）" @click="store.resetReplay()">⏭ 最新</button>

    <button
      class="btn follow"
      :class="{ on: store.autoFocus }"
      :title="store.autoFocus ? '焦点井跟随回放自动切换（点击锁定当前井）' : '已锁定：点击恢复跟随'"
      @click="store.setAutoFocus(!store.autoFocus)"
    >
      焦点跟随
    </button>

    <span class="pct">{{ pct }}%</span>
  </div>
</template>

<style scoped>
.bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 12px;
  border-bottom: 1px solid var(--line);
  background: var(--panel-2);
  font-size: 11px;
  color: var(--muted);
  user-select: none;
}
.tag {
  color: var(--steel);
  border: 1px solid var(--steel-dim);
  padding: 1px 5px;
  letter-spacing: 0.04em;
  font-size: 10px;
}
.btn {
  min-width: 24px;
  height: 20px;
  padding: 0 6px;
  background: var(--panel-3);
  color: var(--text);
  border: 1px solid var(--line);
  cursor: pointer;
  font-size: 10px;
  line-height: 1;
}
.btn:hover { border-color: var(--steel-dim); }
.btn.play { width: 30px; color: var(--steel); }
.btn.play.on { color: var(--green); border-color: var(--green); }
.speeds { display: flex; gap: 2px; }
.sp {
  height: 20px;
  padding: 0 5px;
  background: transparent;
  color: var(--dim);
  border: 1px solid var(--line-soft);
  cursor: pointer;
  font-size: 10px;
  font-variant-numeric: tabular-nums;
}
.sp.sel { color: var(--text); border-color: var(--steel); background: var(--panel-3); }
.rng {
  flex: 1;
  min-width: 120px;
  height: 14px;
  accent-color: var(--steel);
  cursor: pointer;
}
.when b { color: var(--text); font-variant-numeric: tabular-nums; letter-spacing: 0.02em; }
.kpi { color: var(--dim); white-space: nowrap; }
.kpi b { color: var(--text); font-variant-numeric: tabular-nums; }
.reset { color: var(--muted); }
.pct { width: 44px; text-align: right; color: var(--dim); font-variant-numeric: tabular-nums; }
</style>
