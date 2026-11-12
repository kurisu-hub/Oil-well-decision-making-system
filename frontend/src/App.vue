<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, watch } from 'vue'
import { NConfigProvider, NGlobalStyle, darkTheme } from 'naive-ui'
import TopBar from '@/components/TopBar.vue'
import ReplayBar from '@/components/ReplayBar.vue'
import PassportDrawer from '@/components/PassportDrawer.vue'
import { useAppStore } from '@/stores/app'
import { TWIN_SYNC, selfTest, type SyncClient } from '@/twin/sync'

const store = useAppStore()

// —— T05 · 数字溯源抽屉：全局「点数字开护照」——
// 任意元素带 data-prov="id1,id2" 即可点开数字护照抽屉（p_ = bundle 护照，
// x_ = 前端补录）。document 级监听（捕获阶段优先于元素自身 onclick，
// 避免「点井行选焦点」与「点数字看溯源」互相打架：行内数字单独套 data-prov）。
function onDocClick(ev: MouseEvent) {
  const target = ev.target as HTMLElement | null
  const el = target?.closest?.('[data-prov]') as HTMLElement | null
  if (!el) return
  const ids = (el.getAttribute('data-prov') || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  if (!ids.length) return
  store.openPassport(ids, el.getAttribute('data-prov-title') || '数字溯源')
}
onMounted(() => document.addEventListener('click', onDocClick, true))
onBeforeUnmount(() => document.removeEventListener('click', onDocClick, true))

// T16 · 孪生同步协议（twin_sync/1.0）：确定性模拟器，回放时钟驱动 seek。
// 消费点：三维生命周期取色（T08/H-007）、状态数值（H-004）后续从这里取，
// 保证「同一时刻所有视图读到同一份状态」——孪生第二要素。
const twinClient: SyncClient = TWIN_SYNC.newClient()
twinClient.seek(store.replayMi)
watch(
  () => store.replayMi,
  (mi) => twinClient.seek(mi),
)
if (typeof window !== 'undefined') {
  // 验收句柄（tools/sync_check.mjs 只读调用，不进业务流）
  ;(window as unknown as Record<string, unknown>).__twinSync = {
    client: twinClient,
    meta: { ts0: TWIN_SYNC.ts0, tsMax: TWIN_SYNC.tsMax, wells: TWIN_SYNC.wellCount },
    selfTest,
    newClient: TWIN_SYNC.newClient.bind(TWIN_SYNC),
    directFinal: TWIN_SYNC.directFinal.bind(TWIN_SYNC),
  }
  // C2 验收句柄（tools/snap_check.mjs）：喂非刻度/越界值，断言吸附结果
  ;(window as unknown as Record<string, unknown>).__c2 = {
    set(budget: number, risk: number, objective?: string) {
      store.assumptions.budget = budget
      store.assumptions.risk = risk
      if (objective) store.assumptions.objective = objective as never
    },
    state() {
      const p = store.activePoint
      return {
        snapped: store.assumptionSnap.snapped,
        reason: store.assumptionSnap.reason,
        point: p
          ? {
              budget: p.budget,
              risk: p.risk,
              objective: p.objective,
              npv: p.expected_npv ?? null,
            }
          : null,
      }
    },
    ticks: {
      budget: store.BUDGET_TICKS,
      riskTicks: store.RISK_TICKS,
      riskCount: store.RISK_TICKS.length,
      riskMin: store.RISK_TICKS[0] ?? null,
      riskMax: store.RISK_TICKS[store.RISK_TICKS.length - 1] ?? null,
    },
  }
  // T05 验收句柄（tools/gate/prov_check.mjs）：可点数字清单 + 抽屉状态
  ;(window as unknown as Record<string, unknown>).__prov = {
    clickable() {
      return Array.from(document.querySelectorAll('[data-prov]')).map((el) => ({
        prov: el.getAttribute('data-prov'),
        text: (el.textContent || '').trim().slice(0, 40),
      }))
    },
    drawer() {
      return {
        open: store.passportDrawer.open,
        title: store.passportDrawer.title,
        entries: store.passportEntries.map((r: { id: string; entry: { formula: string; source: string; sample_size?: number; label: string } | null }) => ({
          id: r.id,
          hit: !!r.entry,
          label: r.entry?.label ?? null,
          formula: r.entry?.formula ?? null,
          source: r.entry?.source ?? null,
          sampleSize: r.entry?.sample_size ?? null,
        })),
      }
    },
    open(ids: string[]) {
      store.openPassport(ids, '数字溯源')
    },
    close() {
      store.passportDrawer.open = false
    },
  }
}

// 主题 overrides：工程控制台（石墨底 / 青灰强调 / 直角），不用紫蓝渐变
// 投屏模式下把 Naive UI 的基础字号一起抬上去，否则下拉框 / 弹层仍是 12px
const themeOverrides = computed(() => ({
  common: {
    baseColor: '#171b1e',
    cardColor: '#171b1e',
    modalColor: '#171b1e',
    popoverColor: '#1d2226',
    borderColor: '#2c3339',
    textColorBase: '#dde3e6',
    textColor1: '#dde3e6',
    textColor2: '#8a959b',
    textColor3: '#69747a',
    primaryColor: '#7f9db1',
    primaryColorHover: '#96b1c2',
    primaryColorPressed: '#6a879b',
    successColor: '#5f9e78',
    warningColor: '#c9a13a',
    errorColor: '#c1503a',
    borderRadius: '2px',
    fontSize: store.projection ? '15px' : '12px',
  },
}))
</script>

<template>
  <NConfigProvider :theme="darkTheme" :theme-overrides="themeOverrides">
    <NGlobalStyle />
    <div class="shell" :class="{ proj: store.projection }">
      <TopBar />
      <ReplayBar />
      <RouterView />
      <PassportDrawer />
    </div>
  </NConfigProvider>
</template>

<style scoped>
.shell { height: 100%; display: flex; flex-direction: column; }
</style>
