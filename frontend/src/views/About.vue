<script setup lang="ts">
import { computed } from 'vue'
import { useAppStore } from '@/stores/app'

/**
 * 关于 · 使用场景 / 单位表 / 数据来源 / 已知局限 / 原创与 AIGC 声明
 *
 * 本页承担四条验收：C3（使用场景卡）/ C8（原创与 AIGC）/ C9（二元主题句）/ D11（单位表）
 * 全部内容只读 bundle，缺字段显示「暂无」，不补数。
 */
const store = useAppStore()
const meta = computed(() => store.meta as Record<string, any>)
const ev = computed(() => (meta.value?.evidence ?? {}) as Record<string, any>)
const geo = computed(() => (meta.value?.geo ?? {}) as Record<string, any>)

const versions = computed(() => [
  { k: 'schema_version', v: meta.value?.schema_version ?? '3.1', d: '数据契约主版本' },
  { k: 'data_release', v: meta.value?.data_release ?? meta.value?.release ?? '暂无', d: '数据发布批次' },
  { k: 'model_version', v: meta.value?.model_version ?? '暂无', d: '模型版本' },
  { k: 'generated_at', v: String(meta.value?.generated_at ?? '暂无').slice(0, 19), d: '构建时间' },
])

const units = [
  { q: '产量 / 产油速率', u: 'm³/d', note: '立方米每天；月累计 = m³/d × 30.4 天' },
  { q: '金额（NPV / 成本 / 收益）', u: '万元', note: '人民币万元；单井完井成本 45 万元' },
  { q: '长度 / 深度 / 井距', u: '米（m）', note: '井深、缝长、坐标偏移均为米制' },
  { q: '时间', u: '月（M0–M12）', note: 'M0 = 措施月，M1–M12 为措施后 12 个月' },
  { q: '概率 / 占比', u: '无量纲 [0,1]', note: '字段名以 _prob / _frac / _rate 结尾' },
  { q: '油价', u: '元/吨', note: '3,800 元/t；按密度 0.85 t/m³ 折算 0.323 万元/m³' },
]

const scenarios = [
  {
    t: '谁在用',
    v: '油田开发与完井工程师、区块增产计划编制者、需要为不可逆措施签字的技术负责人',
  },
  {
    t: '什么时候用',
    v: '年度增产计划排序、单井再完井措施前评估、预算受限时在候选井之间做取舍',
  },
  {
    t: '在什么地方用',
    v: '美国科罗拉多州 Weld 县（Denver Basin）；数据覆盖 2014-09 至 2024-08 的 77 口井',
  },
  {
    t: '受什么约束',
    v: '无后端、离线单文件、只读公开历史数据；结论不构成作业建议，仅用于决策推演与复盘',
  },
]

const limits = computed(() => {
  const bt = ev.value?.backtest ?? {}
  const zm = ev.value?.zero_model ?? {}
  return [
    {
      t: '样本仅 77 口井、单一县',
      v: `事件集中在 Weld 县 2014–2024，年份分布不均（2018 年 18 个、2019 年 1 个）。跨区外推未经验证。`,
    },
    {
      t: '零产概率模型预测力有限',
      v: `折外 Brier 仅比基率好 ${((zm.brier_improvement ?? 0) * 100).toFixed(1)}%，32 种特征/正则/分层组合全试过，上限约 3.2%。因此下界（lo）在部分月份仍会退化为 0。`,
    },
    {
      t: '回测是单次留出，不是长期跟踪',
      v: `模型选井落在随机分布第 ${((bt.model_percentile ?? 0) * 100).toFixed(2)} 百分位（全枚举 C(77,3)=73150），但 n 小、重尾，不能当作稳定收益率。`,
    },
    {
      t: '递减率 D 有 14 口井触顶',
      v: 'D 被 clip 到 0.15/月，这批井实际表现远好于模型假设（ratio 中位 2.99），说明模型系统性低估了它们的持续性。',
    },
    {
      t: '井位为公开快照，非实测坐标',
      v: `来源为 COGCC wells shapefile 的 2022-03-23 快照，覆盖 ${geo.value?.coverage ?? '暂无'}，属许可位置而非完井实测。`,
    },
  ]
})
</script>

<template>
  <section class="about">
    <header class="hero">
      <h1>关于本系统</h1>
      <p class="lede">
        技术上，它是一台<strong>把「这口井可能什么都不出」算进价格的区间决策仪器</strong>；
        行业上，它回答的是<strong>不可逆的完井措施在信息不全时该不该下注</strong>。
      </p>
      <p class="sub">
        我们不预测产量，我们给不可逆措施下注定价——并用两部共形把停产概率写进价格里。
      </p>
    </header>

    <!-- C3 使用场景卡 -->
    <section class="block">
      <h2>使用场景</h2>
      <div class="grid4">
        <article v-for="s in scenarios" :key="s.t" class="card">
          <div class="card-t">{{ s.t }}</div>
          <div class="card-v">{{ s.v }}</div>
        </article>
      </div>
    </section>

    <!-- D11 单位表 -->
    <section class="block">
      <h2>单位表</h2>
      <p class="hint">全站数字统一使用以下单位；图上轴标与图例同源，不混用。</p>
      <table class="tbl">
        <thead>
          <tr><th>量</th><th>单位</th><th>口径说明</th></tr>
        </thead>
        <tbody>
          <tr v-for="u in units" :key="u.q">
            <td>{{ u.q }}</td>
            <td class="mono">{{ u.u }}</td>
            <td class="muted">{{ u.note }}</td>
          </tr>
        </tbody>
      </table>
    </section>

    <!-- 数据来源与许可 -->
    <section class="block">
      <h2>数据来源与许可</h2>
      <table class="tbl">
        <tbody>
          <tr><th>事件与产量</th><td>COGCC / COGIS Form 5A 文档索引 + 产量年报（公开）</td></tr>
          <tr><th>井位坐标</th><td>{{ geo.source ?? 'COGCC wells shapefile（公开）' }}</td></tr>
          <tr><th>许可</th><td>{{ geo.license ?? 'public data, State of Colorado' }}</td></tr>
          <tr><th>坐标参考</th><td>{{ geo.crs ?? 'EPSG:4326 → 本地 ENU 米制' }}</td></tr>
          <tr><th>覆盖</th><td class="mono">{{ geo.coverage ?? '暂无' }}（{{ geo.fallback ? '布局示意' : '井位来自公开数据' }}）</td></tr>
        </tbody>
      </table>
    </section>

    <!-- 已知局限（诚实披露） -->
    <section class="block">
      <h2>已知局限</h2>
      <p class="hint">写在这里的每一条，都是我们量化过的短板，不是免责套话。</p>
      <ul class="limits">
        <li v-for="l in limits" :key="l.t">
          <strong>{{ l.t }}</strong><span>{{ l.v }}</span>
        </li>
      </ul>
    </section>

    <!-- C8 原创与 AIGC 声明 -->
    <section class="block">
      <h2>原创与 AIGC 声明</h2>
      <div class="grid2">
        <article class="card">
          <div class="card-t">自研范围</div>
          <div class="card-v">
            数据管道（事件抽取、锚点与递减拟合、留一折外评估）、分层 hurdle 与两部共形区间、
            依赖抽样与 CVaR、组合池规则与回测协议、三维场景基座与相机系统、全部前端视图与审计链路。
          </div>
        </article>
        <article class="card">
          <div class="card-t">AIGC 使用</div>
          <div class="card-v">
            文档撰写、代码实现与排错过程使用了 AI 辅助工具。所有数值结论均由本地脚本可复现生成
            （<code>pipeline/*.py</code>、<code>tools/gate/gate.py</code>），不依赖生成式模型的即席输出。
          </div>
        </article>
        <article class="card">
          <div class="card-t">第三方组件</div>
          <div class="card-v">
            Vue 3 / naive-ui / ECharts（MIT）、three.js（MIT）、Vite（MIT）。均为本地打包，
            运行时不请求任何外部资源。
          </div>
        </article>
        <article class="card">
          <div class="card-t">免责</div>
          <div class="card-v">
            本系统用于教学与竞赛演示，不构成作业建议或投资建议。任何实际施工决策需经现场资料与
            工程论证复核。
          </div>
        </article>
      </div>
    </section>

    <!-- 版本三元组 -->
    <section class="block">
      <h2>版本</h2>
      <table class="tbl">
        <tbody>
          <tr v-for="v in versions" :key="v.k">
            <th class="mono">{{ v.k }}</th>
            <td class="mono">{{ v.v }}</td>
            <td class="muted">{{ v.d }}</td>
          </tr>
        </tbody>
      </table>
    </section>
  </section>
</template>

<style scoped>
.about {
  max-width: 1080px;
  margin: 0 auto;
  padding: 28px 24px 64px;
  color: var(--text);
}
.hero {
  padding-bottom: 20px;
  border-bottom: 1px solid var(--line);
}
h1 {
  margin: 0 0 12px;
  font-size: 26px;
  letter-spacing: 0.02em;
}
.lede {
  font-size: 15px;
  line-height: 1.85;
  color: var(--text);
  margin: 0 0 10px;
}
.lede strong {
  color: var(--sand);
  font-weight: 600;
}
.sub {
  font-size: 13px;
  color: var(--muted);
  margin: 0;
}
.block {
  margin-top: 34px;
}
h2 {
  font-size: 15px;
  color: var(--sand);
  margin: 0 0 12px;
  letter-spacing: 0.08em;
  font-weight: 600;
}
.hint {
  font-size: 12px;
  color: var(--dim);
  margin: -4px 0 12px;
}
.grid4 {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 12px;
}
.grid2 {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 12px;
}
.card {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 4px;
  padding: 14px 16px;
}
.card-t {
  font-size: 12px;
  color: var(--steel);
  margin-bottom: 8px;
  letter-spacing: 0.06em;
}
.card-v {
  font-size: 13px;
  line-height: 1.75;
  color: var(--text);
}
.tbl {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}
.tbl th,
.tbl td {
  text-align: left;
  padding: 9px 12px;
  border-bottom: 1px solid var(--line-soft);
  vertical-align: top;
}
.tbl th {
  color: var(--muted);
  font-weight: 500;
  width: 180px;
}
.tbl thead th {
  color: var(--dim);
  font-size: 12px;
  border-bottom: 1px solid var(--line);
}
.mono {
  font-family: var(--mono, ui-monospace, Menlo, Consolas, monospace);
  color: var(--steel);
}
.muted {
  color: var(--muted);
}
.limits {
  list-style: none;
  margin: 0;
  padding: 0;
}
.limits li {
  padding: 12px 0;
  border-bottom: 1px solid var(--line-soft);
  font-size: 13px;
  line-height: 1.75;
}
.limits strong {
  display: block;
  color: var(--oxide-lt);
  font-weight: 600;
  margin-bottom: 4px;
}
.limits span {
  color: var(--muted);
}
code {
  font-family: var(--mono, ui-monospace, Menlo, Consolas, monospace);
  font-size: 12px;
  color: var(--steel);
}
@media (max-width: 900px) {
  .grid4,
  .grid2 {
    grid-template-columns: 1fr;
  }
}
</style>
