import './style.css'
import DATA from './data.json'
import ASSET_DATA from './assets.json'
import { createWorld } from './scene.js'

const $ = (s) => document.querySelector(s)
const $$ = (s) => Array.from(document.querySelectorAll(s))
const nf = (n, d = 0) => Number(n).toLocaleString('zh-CN', { minimumFractionDigits: d, maximumFractionDigits: d })
const STATE_CN = { green: '可判', yellow: '待定', red: '不可判', gray: '数据不足' }
const ACT_CN = { '压': '建议压裂', '不压': '不建议压裂', '补资料': '补资料后再判' }
const act = (a) => ACT_CN[a] || (a && a.length > 6 ? '证据不足' : a)
const STATE_HEX = { green: '#3ecf86', yellow: '#e0ad42', red: '#e85a41', gray: '#6b8494' }

const wells = DATA.wells
const byId = (id) => wells.find((w) => w.id === id)
let world = null
let currentWell = DATA.heroes[0]
let month = 1

/* ============================ 世界 ============================ */
async function boot() {
  try {
    world = await createWorld({
      canvas: $('#gl'),
      wells,
      heroes: DATA.heroes,
      onFps: ({ fps, tris }) => {
        $('#fps').textContent = fps
        $('#tris').textContent = nf(Math.round(tris / 1000)) + 'k'
      },
      onPick: (w) => { if (w) openModule('well', w.id) },
      onHover: (w, ev) => {
        const tip = $('#tip')
        if (!w || !ev) { tip.classList.remove('on'); return }
        tip.innerHTML = `<b>${w.name}</b> · ${w.api}<br>${STATE_CN[w.state]} · 期望 NPV ${nf(w.npv, 1)} 万元`
        tip.style.left = ev.clientX + 'px'
        tip.style.top = ev.clientY + 'px'
        tip.classList.add('on')
      },
    })
    window.__world = world
  } catch (e) {
    console.error(e)
    $('#gl').style.display = 'none'
    document.body.style.background = 'radial-gradient(circle at 50% 40%, #0a1e28, #03080c 70%)'
  }
}

/* ============================ 登录 ============================ */
$('#login-form').addEventListener('submit', (e) => {
  e.preventDefault()
  const btn = $('#enter')
  btn.disabled = true
  btn.querySelector('span').textContent = '正在接入井区…'
  setTimeout(() => {
    document.body.classList.remove('at-login')
    $('#login').classList.add('out')
    const hud = $('#hud')
    hud.classList.remove('hidden')
    requestAnimationFrame(() => hud.classList.add('in'))
  }, 520)
})

/* ============================ HUD ============================ */
function renderHud() {
  const k = DATA.kpi
  $('#k-ratio').textContent = k.ratio_median.toFixed(3)
  $('#k-share').textContent = (k.share_ge1 * 100).toFixed(1) + '%'
  $('#k-p25').textContent = k.ratio_p25.toFixed(2)
  $('#k-p75').textContent = k.ratio_p75.toFixed(2)
  // 0 → 2.5 线性刻度上的 P25–P75 带与中位刻度
  const sc = (v) => Math.min(100, (v / 2.5) * 100)
  $('#k-range').style.width = sc(k.ratio_p75) + '%'
  $('#k-tick').style.left = sc(k.ratio_median) + '%'
  $('#k-npv').textContent = nf(k.ai_npv, 2)
  $('#k-oil').textContent = nf(k.ai_oil) + ' m³'
  $('#k-hit').textContent = (k.ai_hit * 100).toFixed(1) + '%'

  const todo = [...wells]
    .filter((w) => w.state !== 'gray')
    .sort((a, b) => b.npv - a.npv)
    .slice(0, 3)
  $('#todo').innerHTML = todo
    .map(
      (w) => `<li data-well="${w.id}">
        <i style="--c:${STATE_HEX[w.state]}"></i>
        <em>${w.name} · ${act(w.action)}</em>
        <b>${nf(w.npv, 0)}</b>
      </li>`
    )
    .join('')
  $('#todo').querySelectorAll('li').forEach((li) => {
    li.addEventListener('click', () => openModule('well', li.dataset.well))
  })
}

function clock() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  $('#clock').textContent = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  $('#today').textContent = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}
setInterval(clock, 1000)
clock()

/* 沉浸 */
$('#immerse').addEventListener('click', () => document.body.classList.toggle('immersed'))

/* 时间轴 */
$('#month').addEventListener('input', (e) => {
  month = Number(e.target.value)
  $('#m-lab').textContent = 'M' + String(month).padStart(2, '0')
  if (currentWell) drawSpark()
})

/* ============================ 抽屉 ============================ */
const MODULES = {
  well: { i: '01', t: '单井卡', render: renderWell },
  combo: { i: '02', t: '组合结算', render: renderCombo },
  review: { i: '03', t: '数据复盘', render: renderReview },
  report: { i: '04', t: '决策报告', render: renderReport },
  model: { i: '05', t: '模型卡', render: renderModel },
  evidence: { i: '06', t: '证据链', render: renderEvidence },
  asset: { i: '07', t: '数字资产', render: renderAssets },
}

let openMod = null

function openModule(id, wellId) {
  const mod = MODULES[id]
  if (!mod) return
  if (document.body.classList.contains('build-mode')) toggleBuild(false)
  if (wellId) currentWell = wellId
  $('#dr-index').textContent = mod.i
  $('#dr-title').textContent = mod.t
  $('#dr-body').innerHTML = mod.render()
  $('#dr-body').scrollTop = 0
  $('#drawer').classList.add('open')
  $('#drawer').setAttribute('aria-hidden', 'false')
  document.body.classList.add('has-drawer')
  $$('.dk').forEach((b) => b.classList.toggle('on', b.dataset.mod === id))
  openMod = id
  if (id === 'well') bindWellList()
  if (id === 'well') drawSpark()
  if (id === 'asset') { bindAssetRows(); showAssetDetail(ASSET_DATA.assets[0].tag) }
}

function closeDrawer() {
  $('#drawer').classList.remove('open')
  $('#drawer').setAttribute('aria-hidden', 'true')
  document.body.classList.remove('has-drawer')
  $$('.dk').forEach((b) => b.classList.remove('on'))
  openMod = null
  if (world) world.resetView()
}

$$('.dk').forEach((b) => b.addEventListener('click', () => {
  if (openMod === b.dataset.mod) closeDrawer()
  else openModule(b.dataset.mod)
}))
$$('[data-mod]').forEach((b) => {
  if (b.classList.contains('dk')) return
  b.addEventListener('click', () => openModule(b.dataset.mod))
})
$('#dr-close').addEventListener('click', closeDrawer)
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (document.body.classList.contains('build-mode')) toggleBuild(false)
    else if (document.body.classList.contains('immersed')) document.body.classList.remove('immersed')
    else if (openMod) closeDrawer()
  }
})

/* ---------- 单井卡 ---------- */
let filterState = 'all'

function renderWell() {
  const rows = wells
    .filter((w) => (filterState === 'all' ? true : filterState === 'hero' ? w.hero : w.state === filterState))
    .sort((a, b) => (b.hero - a.hero) || b.npv - a.npv)
  return `
  <div class="tabs">
    ${[['all', '全部 77'], ['hero', '前排 8'], ['green', '可判'], ['yellow', '待定'], ['red', '不可判']]
      .map(([k, l]) => `<button class="tab ${filterState === k ? 'on' : ''}" data-f="${k}">${l}</button>`)
      .join('')}
  </div>
  <div class="wlist">
    ${rows
      .map(
        (w) => `<div class="wl ${w.id === currentWell ? 'on' : ''}" data-well="${w.id}">
          <i style="--c:${STATE_HEX[w.state]}"></i>
          <span class="nm">${w.name}</span>
          <em>${w.api}</em>
          <b>${nf(w.npv, 0)}</b>
        </div>`
      )
      .join('')}
  </div>
  <div id="wdetail">${wellDetail(byId(currentWell))}</div>`
}

function bindWellList() {
  $$('.tab').forEach((t) => t.addEventListener('click', () => {
    filterState = t.dataset.f
    openModule('well')
  }))
  $$('.wl').forEach((r) => r.addEventListener('click', () => {
    currentWell = r.dataset.well
    $$('.wl').forEach((x) => x.classList.toggle('on', x.dataset.well === currentWell))
    $('#wdetail').innerHTML = wellDetail(byId(currentWell))
    drawSpark()
    if (world) world.focusWell(currentWell)
  }))
  $('#btn-locate')?.addEventListener('click', () => world && world.focusWell(currentWell))
  $('#btn-combo')?.addEventListener('click', () => openModule('combo'))
}

function wellDetail(w) {
  if (!w) return ''
  const cum = w.sp ? w.sp.reduce((a, b) => a + b, 0) : 0
  return `
  <div class="detail">
    <div class="dt-top">
      <div>
        <h3>${w.name}</h3>
        <p>API ${w.api} · ${w.lon.toFixed(4)}, ${w.lat.toFixed(4)} · ${w.bucket}</p>
      </div>
      <span class="chip" style="--c:${STATE_HEX[w.state]}">${STATE_CN[w.state]}</span>
    </div>
    <div class="dt-grid">
      <div><span>期望 NPV</span><b>${nf(w.npv, 1)}<small>万元</small></b></div>
      <div><span>12 月增油</span><b>${nf(w.oil)}<small>m³</small></b></div>
      <div><span>ROI</span><b>${w.roi.toFixed(2)}</b></div>
      <div><span>置信度</span><b>${(w.conf * 100).toFixed(0)}<small>%</small></b></div>
    </div>
    <div class="blk-h" style="margin:6px 0 2px">事件后 12 个月预测 · m³/d</div>
    <canvas class="spark" id="spark"></canvas>
    <div class="dt-note">
      <b>判据：</b>${w.reason}<br />
      <b>预测累计：</b>${nf(cum, 1)} m³（12 个月求和）<br />
      <b>数据缺口：</b>${w.gap || '无'}
    </div>
    <div class="btn-row">
      <button class="btn" id="btn-locate">三维定位</button>
      <button class="btn" id="btn-combo">加入组合</button>
    </div>
  </div>`
}

function drawSpark() {
  const c = $('#spark')
  if (!c) return
  const w = byId(currentWell)
  if (!w || !w.sp) return
  const dpr = window.devicePixelRatio || 1
  const W = c.clientWidth || 420
  const H = 62
  c.width = W * dpr
  c.height = H * dpr
  const g = c.getContext('2d')
  g.scale(dpr, dpr)
  g.clearRect(0, 0, W, H)

  const vals = w.sp
  const max = Math.max(...vals, 0.001)
  const pad = 4
  const x = (i) => pad + (i / (vals.length - 1)) * (W - pad * 2)
  const y = (v) => H - 6 - (v / max) * (H - 14)

  // 网格
  g.strokeStyle = 'rgba(120,200,220,0.12)'
  g.lineWidth = 1
  g.beginPath()
  g.moveTo(pad, H - 6)
  g.lineTo(W - pad, H - 6)
  g.stroke()

  // 面积
  const grd = g.createLinearGradient(0, 0, 0, H)
  grd.addColorStop(0, 'rgba(86,213,230,0.35)')
  grd.addColorStop(1, 'rgba(86,213,230,0)')
  g.beginPath()
  vals.forEach((v, i) => (i ? g.lineTo(x(i), y(v)) : g.moveTo(x(i), y(v))))
  g.lineTo(x(vals.length - 1), H - 6)
  g.lineTo(x(0), H - 6)
  g.closePath()
  g.fillStyle = grd
  g.fill()

  // 线
  g.beginPath()
  vals.forEach((v, i) => (i ? g.lineTo(x(i), y(v)) : g.moveTo(x(i), y(v))))
  g.strokeStyle = '#56d5e6'
  g.lineWidth = 1.4
  g.stroke()

  // 游标
  const i = Math.min(vals.length - 1, month - 1)
  g.strokeStyle = 'rgba(240,178,60,0.75)'
  g.setLineDash([2, 3])
  g.beginPath()
  g.moveTo(x(i), 2)
  g.lineTo(x(i), H - 6)
  g.stroke()
  g.setLineDash([])
  g.fillStyle = '#f0b23c'
  g.beginPath()
  g.arc(x(i), y(vals[i]), 2.6, 0, Math.PI * 2)
  g.fill()

  g.fillStyle = 'rgba(240,178,60,0.95)'
  g.font = '9px Consolas, monospace'
  const label = `M${i + 1} ${vals[i].toFixed(2)}`
  const tw = g.measureText(label).width
  g.fillText(label, Math.min(W - tw - 2, x(i) + 6), 10)
}

/* ---------- 组合结算 ---------- */
function renderCombo() {
  const st = DATA.strategies
  const max = Math.max(...st.map((s) => s.expected_npv))
  return `
  <div class="blk">
    <div class="blk-h">三种选井方式 · 同 3 口 / 150 万元预算</div>
    ${st.map((s) => `
      <div class="bar-row">
        <div class="bar-top">
          <span>${s.label}</span>
          <b>${nf(s.expected_npv, 1)} 万元</b>
        </div>
        <div class="bar"><i class="${s.id === 'ai' ? '' : s.id === 'random' ? 'cool' : 'warm'}" style="--w:${(s.expected_npv / max) * 100}%"></i></div>
        <div class="bar-top" style="margin-top:5px">
          <span style="color:#6f8794">增油 ${nf(s.expected_oil)} m³ · 命中 ${(s.hit_rate * 100).toFixed(1)}%</span>
          <span style="color:#6f8794">regret ${s.regret === 0 ? '—' : nf(s.regret, 0)} 万</span>
        </div>
      </div>`).join('')}
  </div>

  <div class="blk">
    <div class="blk-h">AI 组合选中的 3 口（单井点估计）</div>
    ${st[0].selected.map((id) => {
      const w = byId(id)
      return `<div class="row">
        <span>${w ? w.name : id} <em style="font-style:normal;color:#5d7484;font-family:var(--mono);font-size:9.5px">${id}</em></span>
        <b>${w ? nf(w.npv, 1) + ' 万' : ''}</b>
      </div>`
    }).join('')}
    <div class="note" style="margin-top:12px">
      预算 ${DATA.kpi.budget} 万元，期望组合 NPV <b>${nf(DATA.kpi.ai_npv, 2)} 万元</b>，
      期望增油 <b>${nf(DATA.kpi.ai_oil)} m³</b>，亏损概率 ${(DATA.kpi.ai_loss * 100).toFixed(2)}%。
      相较低效选择，AI 组合把 regret 从 ${nf(DATA.kpi.regret_random, 0)} 万压到 0。
      注：上表单井点估计之和与组合级期望不同口径，不做加总。
    </div>
  </div>

  <div class="blk">
    <div class="blk-h">组合空间 · 已枚举 ${nf(DATA.combo.n_total)} 组</div>
    <div class="tbl">
      <div class="tr hd" style="grid-template-columns:1fr 74px 58px 52px">
        <span>组合</span><span style="text-align:right">NPV 万</span><span style="text-align:right">CVaR</span><span style="text-align:right">regret</span>
      </div>
      ${DATA.combo.top.map((c) => `
        <div class="tr" style="grid-template-columns:1fr 74px 58px 52px">
          <span class="nm">${c.selected.map((id) => id.replace('CO', '')).join(' · ')}</span>
          <b>${nf(c.expected_npv, 0)}</b>
          <b>${nf(c.cvar, 0)}</b>
          <b>${nf(c.regret, 0)}</b>
        </div>`).join('')}
    </div>
  </div>`
}

/* ---------- 数据复盘 ---------- */
function renderReview() {
  const m = DATA.confusion.matrix
  const order = ['green', 'yellow', 'red', 'gray']
  return `
  <div class="blk">
    <div class="blk-h">模型状态 × 实际结果</div>
    <div class="matrix">
      <div class="h">状态</div><div class="h">实际跑赢</div><div class="h">实际未跑赢</div>
      ${order.map((k) => `
        <div style="color:${STATE_HEX[k]}">${STATE_CN[k]} · ${m[k].n}</div>
        <div><b>${m[k].n_good}</b></div>
        <div><b>${m[k].n_bad}</b></div>`).join('')}
    </div>
    <div class="row" style="margin-top:10px"><span>可判组精确率</span><b>${(m.green.precision * 100).toFixed(1)}%</b></div>
    <div class="row"><span>待定组精确率</span><b>${(m.yellow.precision * 100).toFixed(1)}%</b></div>
    <div class="row"><span>不可判组精确率</span><b>${(m.red.precision * 100).toFixed(1)}%</b></div>
  </div>

  <div class="blk">
    <div class="blk-h">实际分布（不含模型）</div>
    <div class="row"><span>跑赢自身递减基线</span><b>${DATA.confusion.actual_dist.good} 口</b></div>
    <div class="row"><span>未跑赢</span><b>${DATA.confusion.actual_dist.bad} 口</b></div>
    <div class="row"><span>决策覆盖率</span><b>${(DATA.confusion.coverage_of_decisions * 100).toFixed(1)}%</b></div>
    <div class="row"><span>已决策井准确率</span><b>${(DATA.confusion.accuracy_on_decided * 100).toFixed(1)}%</b></div>
    <div class="note" style="margin-top:10px">${DATA.confusion.note}</div>
  </div>

  <div class="blk">
    <div class="blk-h">基线审计</div>
    <div class="row"><span>实际 / 基线 · 中位</span><b>${DATA.kpi.ratio_median.toFixed(3)}</b></div>
    <div class="row"><span>P25 / P75</span><b>${DATA.kpi.ratio_p25.toFixed(2)} / ${DATA.kpi.ratio_p75.toFixed(2)}</b></div>
    <div class="row"><span>衰减率 D（池化）</span><b>${DATA.d_pool.toFixed(4)} / 月</b></div>
    <div class="note warn" style="margin-top:10px">
      逐月共形 90% 区间下界在 ${DATA.intervals.frac_lower_clipped ? (DATA.intervals.frac_lower_clipped * 100).toFixed(0) : '100'}% 的点上被截到 0——
      停产月导致，不是单井特性。井级结论按 12 个月累计量的经验分布判。
    </div>
  </div>`
}

/* ---------- 决策报告 ---------- */
function renderReport() {
  const k = DATA.kpi
  const ai = DATA.strategies.find((x) => x.id === 'ai') || DATA.strategies[0]
  const picks = ai.selected.map((id) => DATA.wells.find((w) => w.id === id)).filter(Boolean)
  const avg = picks.reduce((a, w) => a + w.npv, 0) / (picks.length || 1)
  return `
  <div class="rep-head">
    <div class="rep-no">WELD-DR-2024-08</div>
    <div class="rep-meta"><span>编制 2026-11-10</span><span>口径 final77</span><span>77 口井 / 924 井月</span></div>
    <h3>Weld 区块完井措施决策报告</h3>
    <p>范围：科罗拉多州 Weld 县 77 口井，事件后 12 个月。结论用于排序与下注，不替代现场论证。</p>
  </div>

  <div class="kstrip">
    <div><span>预算</span><b>${nf(k.budget, 0)}<em>万元</em></b></div>
    <div><span>期望 NPV</span><b>${nf(k.ai_npv, 1)}<em>万元</em></b></div>
    <div><span>12 月增油</span><b>${nf(k.ai_oil, 0)}<em>m³</em></b></div>
    <div><span>命中率</span><b>${(k.ai_hit * 100).toFixed(1)}<em>%</em></b></div>
  </div>

  <div class="blk">
    <div class="blk-h">结论</div>
    <ul class="bul">
      <li>77 口井措施后 12 个月累计产量相对自身递减基线，中位比 <b>${k.ratio_median.toFixed(3)}</b>，<b>${(k.share_ge1 * 100).toFixed(1)}%</b> 的井跑赢基线。</li>
      <li>模型把可判井压到 <b>19 口</b>（精确率 ${(DATA.confusion.matrix.green.precision * 100).toFixed(0)}%），把不确定的井显式标成待定 / 不可判，不硬给结论。</li>
      <li>同等预算下 AI 组合期望 NPV <b>${nf(k.ai_npv, 1)} 万元</b>，是随机选井的 <b>${(k.ai_npv / DATA.strategies[3].expected_npv).toFixed(1)} 倍</b>。</li>
      <li>三条基线对比：老师傅 regret ${nf(k.regret_expert, 0)} 万、历史回放 ${nf(k.regret_hist, 0)} 万、随机 ${nf(k.regret_random, 0)} 万。</li>
    </ul>
  </div>

  <div class="blk">
    <div class="blk-h">推荐施工 · 3 口（单井点估计）</div>
    <div class="tbl">
      <div class="tr hd" style="grid-template-columns:1fr 96px 62px">
        <span>井</span><span style="text-align:right">单井 NPV</span><span style="text-align:right">状态</span>
      </div>
      ${picks.map((w) => `<div class="tr" style="grid-template-columns:1fr 96px 62px">
        <span class="nm">${w.name}<em style="margin-left:6px">${w.id.slice(-4)}</em></span>
        <b>${nf(w.npv, 0)}</b>
        <b style="color:#8fb3c0">${STATE_CN[w.state] || '—'}</b>
      </div>`).join('')}
    </div>
    <div class="note" style="margin-top:8px">
      组合级期望 NPV ${nf(ai.expected_npv, 1)} 万元为组合口径（含组合层调整），不与上表单井点估计直接相加。
    </div>
  </div>

  <div class="blk">
    <div class="blk-h">建议动作</div>
    <div class="row"><span>可判（19 口）</span><b>优先施工 · 取 NPV 前 3</b></div>
    <div class="row"><span>待定（35 口）</span><b>补静态参数后再判</b></div>
    <div class="row"><span>不可判（17 口）</span><b>暂缓 · 先查停产月</b></div>
    <div class="row"><span>数据不足（6 口）</span><b>不进入组合</b></div>
  </div>

  <div class="blk">
    <div class="blk-h">风险与边界</div>
    <div class="row"><span>组合亏损概率</span><b>${(ai.loss_prob * 100).toFixed(2)}%</b></div>
    <div class="row"><span>尾部损失 CVaR₅</span><b>${nf(Math.abs(ai.cvar), 1)} 万元</b></div>
    <div class="row"><span>组合命中率</span><b>${(ai.hit_rate * 100).toFixed(1)}%</b></div>
    <div class="row"><span>局部井下界截零</span><b>${(DATA.intervals.frac_lower_clipped * 100).toFixed(0)}%</b></div>
    <div class="note" style="margin-top:8px">
      亏损概率与 CVaR 来自共享 3 月因子的依赖抽样（非独立假设）；区间为两部共形，覆盖率见模型卡。
      组合枚举 C(20,3)=1,140，无抽样误差。
    </div>
  </div>

  <div class="blk">
    <div class="blk-h">口径与免责</div>
    <div class="note">
      数据为 COGCC / ECMC 公开井史（2014-09 ~ 2024-08），事件定义为 COGIS Form 5A 完井/再完井，
      以 recompletion 为主。模型输出为历史回放下的折外预测，非实时孪生，也不构成施工建议。
      三维设备为行业通用型号示意资产，非本井实物。
    </div>
    <div class="rep-sign">
      <span>编制 · 数据组</span><span>复核 · 算法组</span><span>签发 · 项目负责人</span>
    </div>
  </div>`
}

/* ---------- 模型卡 ---------- */
function renderModel() {
  const met = DATA.metrics || {}
  const rows = Object.keys(met)
  return `
  <div class="blk">
    <div class="blk-h">折外表现 · 77 事件</div>
    <div class="tbl">
      <div class="tr hd" style="grid-template-columns:1fr 62px 62px 62px">
        <span>模型</span><span style="text-align:right">sMAPE</span><span style="text-align:right">MAE</span><span style="text-align:right">skill</span>
      </div>
      ${rows.map((k) => {
        const m = met[k]
        const s = m.smape ?? m.smape_median
        return `<div class="tr" style="grid-template-columns:1fr 62px 62px 62px">
          <span class="nm">${k}</span>
          <b>${s != null ? s.toFixed(1) : '—'}</b>
          <b>${m.mae_m3d != null ? m.mae_m3d.toFixed(2) : '—'}</b>
          <b>${m.skill_vs_flat != null ? m.skill_vs_flat.toFixed(2) : '—'}</b>
        </div>`
      }).join('')}
    </div>
    <div class="note" style="margin-top:10px">
      主力模型 LSDRT-v2：sMAPE ${(met['LSDRT-v2']?.smape ?? 0).toFixed(1)}，相对持平基线 skill ${(met['LSDRT-v2']?.skill_vs_flat ?? 0).toFixed(2)}。
      全套对比见 P15 TabPFN 对比。
    </div>
  </div>

  <div class="blk">
    <div class="blk-h">共形区间</div>
    <div class="row"><span>目标覆盖率</span><b>${DATA.intervals.target_coverage}</b></div>
    <div class="row"><span>q90 · 中位相对半宽</span><b>${DATA.q90.median.toFixed(2)}</b></div>
    <div class="row"><span>q90 · 上界分位范围</span><b>${DATA.q90.min.toFixed(1)} – ${DATA.q90.max.toFixed(1)}</b></div>
    <div class="row"><span>下界截零比例</span><b>${(DATA.intervals.frac_lower_clipped * 100).toFixed(0)}%</b></div>
  </div>

  <div class="blk">
    <div class="blk-h">已知局限</div>
    <ul class="bul">
      <li>仅 77 口井、单县、10 年，跨区未验证。</li>
      <li>无层位 / 渗透率 / 施工参数，特征只有产量时序。</li>
      <li>零产几乎不可预测：折外 Brier 仅改善 3.17%。</li>
      <li>无实时数据通道，做的是历史回放。</li>
    </ul>
  </div>`
}

/* ---------- 证据链 ---------- */
function renderEvidence() {
  const ps = DATA.passport.slice(0, 14)
  return `
  <div class="blk">
    <div class="blk-h">证据护照 · ${DATA.passport.length} 条受控指标</div>
    <div class="tbl">
      ${ps.map((p) => `
        <div class="tr" style="grid-template-columns:1fr 78px">
          <span class="nm" title="${p.formula || ''}">${p.label}</span>
          <b>${p.value}${p.unit ? ' ' + p.unit : ''}</b>
        </div>`).join('')}
    </div>
  </div>
  <div class="blk">
    <div class="blk-h">来源</div>
    <div class="note">
      指标均带公式、样本量与源文件，可在 04_数据/ 下按公式复算。
      数据快照 2022-03-23（井位）+ 2024-08（产量），模型版本 ${DATA.meta.model}。
    </div>
  </div>`
}

/* ---------- 数字资产 ---------- */
function renderAssets() {
  const list = ASSET_DATA.assets
  const docs = list.reduce((n, a) => n + a.docs.length, 0)
  const phaseNames = ASSET_DATA.meta.phase_names
  return `
  <div class="blk">
    <div class="blk-h">交付概览 · ${ASSET_DATA.meta.site}</div>
    <div class="kstrip">
      <div><span>资产总数</span><b>${list.length}<em>项</em></b></div>
      <div><span>施工阶段</span><b>${phaseNames.length}<em>阶段</em></b></div>
      <div><span>计划工期</span><b>${ASSET_DATA.meta.total_days}<em>天</em></b></div>
      <div><span>交付文档</span><b>${docs}<em>份</em></b></div>
    </div>
    <div class="note">${ASSET_DATA.meta.note}</div>
  </div>

  <div class="blk">
    <div class="blk-h">资产详情</div>
    <div id="asset-detail" class="asset-detail">点下方任一行：相机推到该资产，并在 3D 中高亮。</div>
  </div>

  <div class="blk">
    <div class="blk-h">资产台账 · 点击定位 / 高亮</div>
    <div class="tbl">
      <div class="tr hd" style="grid-template-columns:64px 1fr 54px 46px">
        <span>编号</span><span>名称 / 规格</span><span style="text-align:right">阶段</span><span style="text-align:right">状态</span>
      </div>
      ${list.map((a) => `
        <div class="tr asset-row" data-tag="${a.tag}" style="grid-template-columns:64px 1fr 54px 46px">
          <span class="tag">${a.tag}</span>
          <span class="nm">${a.name}<em style="display:block;margin-top:2px">${a.spec}</em></span>
          <b style="color:#7f9aa8">P${a.phase}</b>
          <b style="color:#3ecf86">${a.status}</b>
        </div>`).join('')}
    </div>
  </div>

  <div class="blk">
    <div class="blk-h">4D 建造</div>
    <div class="note">
      顶栏「4D」进入建造模拟：按 120 天计划逐日推进，设备按安装阶段依次出现。
      阶段：${phaseNames.join(' → ')}。
    </div>
  </div>`
}

function showAssetDetail(tag) {
  const a = ASSET_DATA.assets.find((x) => x.tag === tag)
  if (!a) return
  const el = document.querySelector('#asset-detail')
  if (el) {
        el.innerHTML = `<div class="ad-top"><b>${a.tag}</b><span>${a.name}</span></div>
          <div class="ad-rows">
            <div><span>规格</span><b>${a.spec}</b></div>
            <div><span>材质</span><b>${a.material || '—'}</b></div>
            <div><span>重量</span><b>${a.weight_t ? a.weight_t + ' t' : '—'}</b></div>
            <div><span>尺寸</span><b>${a.dims_m}</b></div>
            <div><span>安装</span><b>D${a.start_day}–D${a.end_day} · ${ASSET_DATA.meta.phase_names[a.phase - 1]}</b></div>
          </div>
          <div class="asset-docs">${a.docs.map((d) => `<span>${d}</span>`).join('')}</div>`
  }
}

function bindAssetRows() {
  $$('#dr-body .asset-row').forEach((row) => {
    row.addEventListener('click', () => {
      $$('#dr-body .asset-row').forEach((r) => r.classList.remove('on'))
      row.classList.add('on')
      const tag = row.dataset.tag
      world?.focusAsset(tag)
      showAssetDetail(tag)
    })
  })
}

/* ---------- 4D 建造 ---------- */
let buildDay = 0
let buildTimer = null
const BUILD_TOTAL = ASSET_DATA.meta.total_days
const BUILD_PHASES = ASSET_DATA.meta.phase_ranges
const BUILD_NAMES = ASSET_DATA.meta.phase_names

function phaseIndex(d) {
  for (let i = 0; i < BUILD_PHASES.length; i++) {
    const [a, b] = BUILD_PHASES[i]
    if (d < b || i === BUILD_PHASES.length - 1) return i
  }
  return 0
}
function setBuildDay(d) {
  buildDay = Math.max(0, Math.min(BUILD_TOTAL, d))
  world?.setBuildDay(buildDay)
  $('#bb-range').value = buildDay
  $('#bb-day').textContent = 'D' + String(buildDay).padStart(3, '0')
  const i = phaseIndex(buildDay)
  $('#bb-phase').textContent = BUILD_NAMES[i]
  $('#bb-sub').textContent = `PHASE ${i + 1} / ${BUILD_NAMES.length}`
}
function stopBuildPlay() {
  if (buildTimer) clearInterval(buildTimer)
  buildTimer = null
  $('#bb-play').textContent = '▶'
}
function playBuild() {
  if (buildTimer) return
  if (buildDay >= BUILD_TOTAL) setBuildDay(0)
  $('#bb-play').textContent = '❚❚'
  buildTimer = setInterval(() => {
    setBuildDay(buildDay + 1)
    if (buildDay >= BUILD_TOTAL) stopBuildPlay()
  }, 70)
}
function toggleBuild(force) {
  const on = force ?? !document.body.classList.contains('build-mode')
  document.body.classList.toggle('build-mode', on)
  $('#build-toggle').classList.toggle('on', on)
  $('#buildbar').setAttribute('aria-hidden', String(!on))
  if (on) {
    closeDrawer()
    world?.setBuildMode(true)
    setBuildDay(0)
    playBuild()
  } else {
    stopBuildPlay()
    world?.setBuildMode(false)
  }
}
$('#build-toggle').addEventListener('click', () => toggleBuild())
$('#bb-exit').addEventListener('click', () => toggleBuild(false))
$('#bb-play').addEventListener('click', () => (buildTimer ? stopBuildPlay() : playBuild()))
$('#bb-range').addEventListener('input', (e) => { stopBuildPlay(); setBuildDay(Number(e.target.value)) })

/* ============================ 启动 ============================ */
document.body.classList.add('at-login')
renderHud()
boot()
