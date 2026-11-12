<script setup lang="ts">
import { computed } from 'vue'
import { NBadge, NButton } from 'naive-ui'
import { useRoute } from 'vue-router'
import DataModeBadge from './DataModeBadge.vue'
import DataClockBadge from './DataClockBadge.vue'
import { useAppStore } from '@/stores/app'

const route = useRoute()
const store = useAppStore()

const tabs = [
  { to: '/', label: '① 决策沙盘 · 区块价值全景' },
  { to: '/portfolio', label: '③ 措施会结算' },
  { to: '/review', label: '④ 数据与复盘' },
  { to: '/evidence', label: '证据中心' },
  { to: '/about', label: '关于' },
]
const wellTab = computed(() => {
  const id =
    (route.params.wellId as string) || store.focusWellId || store.wells[0]?.well_id
  return { to: `/well/${id}`, label: '② 单井决策卡' }
})
// D-063：按 tabs 顺序渲染全部 5 项（证据中心 / 关于此前无渲染入口，C3/C8/C9/D11 四条闸门
// 以 /about 为载体）；wellTab 插在 ①② 之间，三维场景保持末位，共 7 个可达入口
const ordered = computed(() => [
  tabs[0],
  wellTab.value,
  tabs[1],
  tabs[2],
  tabs[3],
  tabs[4],
  { to: '/scene', label: '⑤ 三维场景' },
])

const issueCount = computed(() => store.issues.length)

// 时间戳：bundle 生成时刻（等宽、ISO 截断到分钟）
const stamp = computed(() => {
  const s = store.meta.generated_at ?? ''
  return s ? s.replace('T', ' ').slice(0, 16) : '暂无'
})
const srcShort = computed(() => {
  const s = store.meta.source ?? ''
  return s.length > 28 ? s.slice(0, 28) + '…' : s || '暂无'
})
// 版本条用完整时间戳（ISO 截断到秒），顶栏行 2 的 stamp 只到分钟
const genFull = computed(() => {
  const s = store.dataVersion.generatedAt ?? ''
  return s ? s.replace('T', ' ').replace(/\+.*$/, '').slice(0, 19) : '暂无'
})
</script>

<template>
  <header class="topbar no-print">
    <!-- 行 1：图纸标题栏（图号 / 名称 / 版本 / 时间戳 / 来源） -->
    <div class="row titlebar">
      <span class="fig-no">DWG-COMP-001</span>
      <strong class="title">Weld 区块 · 完井措施决策沙盘</strong>
      <span class="stamp stamp-live">REV {{ store.meta.config_id }}</span>
      <span class="grow"></span>
      <span class="stamp" :title="store.meta.source">SRC {{ srcShort }}</span>
      <DataClockBadge />
      <DataModeBadge />
      <NBadge v-if="issueCount" :value="issueCount" :max="99" type="warning">
        <span class="small muted" title="bundle 契约校验提示，见第四幕数据卡">契约提示 {{ issueCount }}</span>
      </NBadge>
      <NButton
        size="tiny"
        :type="store.projection ? 'warning' : 'default'"
        :title="store.projection ? '投屏模式已开：字号 / 点击目标 / 场景高度已放大，点此关闭' : '投屏模式：放大字号与点击目标，便于投影观看'"
        @click="store.toggleProjection()"
      >
        {{ store.projection ? '投屏 · 开' : '投屏' }}
      </NButton>
      <NButton
        size="tiny"
        title="模型卡 / 状态混淆矩阵：交付模型参数、自检指标、判态混淆矩阵、基线审计、90% 区间口径"
        @click="$router.push('/model-card')"
      >
        模型卡
      </NButton>
      <NButton size="tiny" @click="store.openPassport(store.passports.map((p) => p.id), '全部数字护照')">
        数字护照
      </NButton>
      <NButton size="tiny" type="primary" @click="$router.push('/report')">导出报告</NButton>
    </div>

    <!-- 行 2：工序导航 + 工程量 -->
    <nav class="row tabs">
      <RouterLink
        v-for="t in ordered"
        :key="t.label"
        :to="t.to"
        class="tab"
        :class="{ active: $route.path === t.to }"
        >{{ t.label }}</RouterLink
      >
      <span class="grow"></span>
      <span class="mono dim qty">
        N_WELLS {{ store.meta.n_wells }} · N_EVENTS {{ store.meta.n_events }} ·
        {{ store.meta.model_version }} · GEN {{ stamp }}
      </span>
    </nav>

    <!-- 行 3：数据版本条（dataset_id / data_mode / n_wells / n_events / generated_at / active file） -->
    <div class="row verbar">
      <span class="stamp stamp-live">DATA</span>
      <span class="mono vcell" title="dataset_id">
        DS <b>{{ store.dataVersion.datasetId ?? '暂无' }}</b>
      </span>
      <span class="mono vcell">
        MODE <b>{{ store.dataVersion.dataMode }}</b>
      </span>
      <span class="mono vcell">
        WELLS <b>{{ store.dataVersion.nWells ?? '暂无' }}</b>
      </span>
      <span class="mono vcell">
        EVENTS <b>{{ store.dataVersion.nEvents ?? '暂无' }}</b>
      </span>
      <span class="mono vcell">
        GEN <b>{{ genFull }}</b>
      </span>
      <span class="grow"></span>
      <span
        v-if="store.dataVersion.fallback"
        class="stamp ver-alarm"
        title="指定的 real / real_pilot 数据文件缺失，已回退 mock 示意数据 —— 当前画面不是实测结果"
      >
        ⚠ 已回退 mock 示意数据 · 非实测
      </span>
      <span class="mono vcell file" :title="store.dataVersion.activeFile">
        FILE <b>{{ store.dataVersion.activeFile }}</b>
      </span>
    </div>
  </header>
</template>

<style scoped>
.topbar {
  height: var(--topbar-h);
  padding: 0 12px;
  border-bottom: 1px solid var(--line);
  background: linear-gradient(180deg, var(--panel-2), var(--panel));
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 5px;
}
.titlebar { gap: 8px; }
.fig-no {
  font-family: var(--mono);
  font-size: 10px;
  letter-spacing: .12em;
  color: var(--sand);
  border: 1px solid var(--line-strong);
  padding: 1px 6px;
  line-height: 16px;
}
.title { font-size: 14px; font-weight: 600; letter-spacing: .02em; }
.tabs { gap: 0; border-bottom: 1px solid var(--line-soft); }
.tab {
  color: var(--muted);
  text-decoration: none;
  font-size: 12px;
  padding: 2px 10px;
  border: 1px solid transparent;
  border-bottom: none;
  margin-bottom: -1px;
}
.tab:hover { color: var(--text); background: var(--panel-3); }
.tab.active {
  color: var(--text);
  background: var(--panel);
  border-color: var(--line);
  border-bottom: 1px solid var(--panel);
  font-weight: 600;
}
.qty { font-size: 10px; letter-spacing: .04em; }

/* 数据版本条：图纸标题栏的下沿，等宽、细线、可省略 */
.verbar {
  gap: 10px;
  border-top: 1px solid var(--line-soft);
  padding-top: 3px;
  min-width: 0;
  overflow: hidden;
}
.verbar .vcell {
  font-size: 10px;
  color: var(--dim);
  letter-spacing: .03em;
  white-space: nowrap;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
.verbar .vcell b { color: var(--muted); font-weight: 600; }
.verbar .vcell.file { flex: none; max-width: 34%; }
/* 回退 mock：红色告警，不能让观众误以为在看实测数据 */
.ver-alarm {
  color: #e0715c;
  border-color: rgba(193, 80, 58, .75);
  background: rgba(193, 80, 58, .16);
  font-weight: 600;
  flex: none;
}
.proj .verbar .vcell { font-size: 12px; }
.proj .verbar .vcell b { color: var(--text); }
</style>
