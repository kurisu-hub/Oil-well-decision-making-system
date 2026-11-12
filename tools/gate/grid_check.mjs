#!/usr/bin/env node
/**
 * T17 · 预计算参数网格验收（06 §5D T17：「改假设 → 亚秒出结果，不再重跑管道」）
 *
 *   T17-1  econ_grid_v1 形状：油价/成本/预算 3/3/3 档、9 组合 × 77 井全覆盖（Node 读文件）
 *   T17-2  基准档 (×1.0,×1.0) 逐井 vs bundle.value_npv 最大差 ≤ 0.05 万元（Node 独立复算）
 *   T17-3  组合查表恒等：模型推荐组合所选井基准档网格 NPV 求和 == combo_metrics 期望 NPV（≤ 0.1）
 *   T17-4  前端零公式接线：src 内 roi 反解（revRef）= 0、自由油价滑杆 v-model = 0、store 走 gridNpvAt
 *   T17-5  实机 Cockpit 档位按钮：油价 3 / 成本 3 / 预算 3 渲染（puppeteer + file:// 单文件）
 *   T17-6  改假设亚秒生效：点击油价档 4560 → 工况戳 DOM 更新 < 1000 ms（实机计时）
 *   T17-7  查表端到端正确：adj 模式 + 4560 档下，Portfolio 组合期望 NPV == Node 网格基准值（±0.15）
 *   T17-8  单文件含网格（"econ_grid_v1" 在 release_v3/index.html）且无 pageerror / console error
 *
 * 用法：node tools/gate/grid_check.mjs [--headful]
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const args = process.argv.slice(2)
const headful = args.includes('--headful')

const rows = []
const ck = (id, name, ok, detail) => rows.push({ id, name, ok, detail })

// ---------- T17-1 ~ 4：Node 侧 ----------
const gridPath = join(ROOT, 'frontend', 'src', 'data', 'econ_grid.json')
if (!existsSync(gridPath)) {
  console.error('✗ econ_grid.json 不存在（先跑 pipeline/build_econ_grid.py）')
  process.exit(2)
}
const grid = JSON.parse(readFileSync(gridPath, 'utf8'))
const bundle = JSON.parse(readFileSync(join(ROOT, 'frontend', 'src', 'data', 'bundle_v3.json'), 'utf8'))
const wells = bundle.wells
const ids = wells.map((w) => w.well_id)

{
  const tiersOk =
    grid.version === 'econ_grid_v1' &&
    grid.price_tiers.length === 3 &&
    grid.cost_tiers.length === 3 &&
    grid.budget_tiers.length === 3 &&
    grid.grid.length === 9 &&
    grid.grid.every((e) => Object.keys(e.npv).length === ids.length && ids.every((id) => id in e.npv))
  ck('T17-1', '网格形状：3/3/3 档 · 9 组合 × 77 井全覆盖', tiersOk,
    `油价 ${grid.price_tiers.map((t) => t.oil_price_cny_per_t)} 元/t · 成本 ${grid.cost_tiers.map((t) => t.well_cost_wan)} 万元 · 预算 ${grid.budget_tiers.map((t) => t.budget_wan)} 万元`)
}

{
  const base = grid.grid[4] // p=1, c=1
  let worst = 0
  let worstId = ''
  for (const w of wells) {
    const d = Math.abs(base.npv[w.well_id] - w.value_npv)
    if (d > worst) { worst = d; worstId = w.well_id }
  }
  ck('T17-2', '基准档逐井 vs bundle.value_npv ≤ 0.05', worst <= 0.05,
    `最大差 ${worst.toFixed(4)} 万元 @ ${worstId}（77/77 复算）`)
}

{
  const it0 = bundle.combo_metrics?.items?.[0]
  const base = grid.grid[4]
  const s = it0 ? it0.selected.reduce((acc, id) => acc + base.npv[id], 0) : NaN
  const d = it0 ? Math.abs(s - it0.expected_npv) : Infinity
  ck('T17-3', '组合查表恒等（推荐组合基准档）≤ 0.1', d <= 0.1,
    it0 ? `网格和 ${s.toFixed(2)} vs combo_metrics ${it0.expected_npv}，差 ${d.toFixed(4)}` : 'combo_metrics 缺失')
}

{
  const fe = join(ROOT, 'frontend', 'src')
  const read = (p) => readFileSync(p, 'utf8')
  let revRef = 0
  let freeSlider = 0
  let storeGrid = 0
  const walk = (dir) => {
    if (!existsSync(dir)) return
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      if (statSync(p).isDirectory()) walk(p)
      else if (/\.(ts|vue)$/.test(name)) {
        const t = read(p)
        revRef += (t.match(/revRef/g) || []).length
        freeSlider += (t.match(/v-model:value="store\.assumptions\.(oilPrice|cost)"/g) || []).length
        if (name === 'app.ts' && p.includes('stores')) storeGrid = /gridNpvAt/.test(t) ? 1 : 0
      }
    }
  }
  walk(fe)
  ck('T17-4', '前端零公式：roi 反解 0 处 · 自由油价/成本滑杆 0 处 · store 走 gridNpvAt',
    revRef === 0 && freeSlider === 0 && storeGrid === 1,
    `revRef=${revRef} · freeSlider=${freeSlider} · store.gridNpvAt=${storeGrid}`)
}

// ---------- T17-5 ~ 8：实机 ----------
const EDGE_CANDIDATES = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
]
const exe = EDGE_CANDIDATES.find((p) => existsSync(p))
if (!exe) {
  console.error('✗ 未找到 Edge/Chrome')
  process.exit(2)
}
let puppeteer
try {
  const { createRequire } = await import('node:module')
  const req = createRequire(join(ROOT, 'frontend', 'package.json'))
  puppeteer = req('puppeteer-core')
  if (puppeteer?.default) puppeteer = puppeteer.default
} catch {
  console.error('✗ 缺少 puppeteer-core：在 frontend/ 下 npm i --no-save puppeteer-core')
  process.exit(2)
}

const artifact = join(ROOT, 'release_v3', 'index.html')
if (!existsSync(artifact)) {
  console.error('✗ release_v3/index.html 不存在')
  process.exit(2)
}
const url = pathToFileURL(artifact).href

// T17-7 的 Node 基准：复算 activePoint 选中井集合在 (p=4560, c=45) 下的网格 NPV 和
// activePoint 口径与 store 相同：budget===135 && risk===最小 risk && objective==='npv' 的第一条
const risks = [...new Set((bundle.portfolio?.points ?? []).map((p) => p.risk))].sort((a, b) => a - b)
const pt = (bundle.portfolio?.points ?? []).find(
  (p) => p.budget === 135 && p.risk === risks[0] && p.objective === 'npv',
)
const pTier4560 = grid.price_tiers.findIndex((t) => t.oil_price_cny_per_t === 4560)
const cTier45 = grid.cost_tiers.findIndex((t) => t.well_cost_wan === 45)
const expectedComboNpv = pt
  ? pt.selected.reduce((acc, id) => acc + grid.grid[pTier4560 * 3 + cTier45].npv[id], 0)
  : NaN

const browser = await puppeteer.launch({
  executablePath: exe,
  headless: headful ? false : 'new',
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader', '--allow-file-access-from-files'],
})

try {
  const page = await browser.newPage()
  await page.setViewport({ width: 1600, height: 1000 })
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  page.on('console', (m) => {
    if (m.type() === 'error' && !/favicon|ResizeObserver/i.test(m.text())) errors.push(m.text())
  })

  await page.goto(url + '#/', { waitUntil: 'load' })
  await page.waitForFunction(() => document.body.textContent.includes('控制轨'), { timeout: 20000 })

  // T17-5：档位按钮渲染
  const ticks = await page.evaluate(() => {
    const txt = document.body.textContent || ''
    const has = (...vs) => vs.every((v) => txt.includes(v))
    return {
      price: has('3040', '3800', '4560'),
      cost: has('36', '45', '54'),
      budget: has('90', '135', '180'),
      gridStamp: txt.includes('econ_grid_v1') || txt.includes('预计算网格'),
    }
  })
  ck('T17-5', 'Cockpit 档位按钮渲染（油 3 / 成本 3 / 预算 3）',
    ticks.price && ticks.cost && ticks.budget, JSON.stringify(ticks))

  // T17-6：改假设亚秒生效 —— 先切 adj 模式，再点 4560 档，rAF 轮询工况戳更新
  await page.goto(url + '#/cockpit', { waitUntil: 'load' })
  await page.waitForFunction(() => document.body.textContent.includes('按工况查表'), { timeout: 20000 })
  const latency = await page.evaluate(() => {
    const btns = [...document.querySelectorAll('button')]
    const adjBtn = btns.find((b) => b.textContent.includes('按工况查表'))
    if (!adjBtn) return { ms: -1, err: 'adj 按钮未找到' }
    adjBtn.click()
    const tick = btns.find((b) => b.textContent.trim() === '4560')
    if (!tick) return { ms: -1, err: '4560 档按钮未找到' }
    return new Promise((res) => {
      const t0 = performance.now()
      tick.click()
      const poll = () => {
        const stamps = [...document.querySelectorAll('.stamp')]
        if (stamps.some((el) => el.textContent.includes('econ_grid_v1')) && document.body.textContent.includes('4560')) {
          res({ ms: performance.now() - t0, err: null })
        } else if (performance.now() - t0 > 5000) {
          res({ ms: -1, err: '5 s 内未观察到工况戳更新' })
        } else requestAnimationFrame(poll)
      }
      poll()
    })
  })
  ck('T17-6', '改假设 → 亚秒生效（点击档位到 DOM 更新 < 1000 ms）',
    latency.ms >= 0 && latency.ms < 1000,
    `${latency.err ?? latency.ms.toFixed(0)} ms`)

  // T17-7：查表端到端正确（Portfolio 组合期望 NPV）
  await page.goto(url + '#/portfolio', { waitUntil: 'load' })
  await page.waitForFunction(() => document.querySelector('[data-prov="x_combo_expected_npv"]'), { timeout: 20000 })
  const comboTxt = await page.evaluate(() => {
    const el = document.querySelector('[data-prov="x_combo_expected_npv"]')
    return el ? el.textContent.trim() : ''
  })
  const gotNpv = Number(comboTxt.replace(/[, ]/g, '').replace(/[^\d.\-]/g, ''))
  const dNpv = Number.isFinite(gotNpv) ? Math.abs(gotNpv - expectedComboNpv) : Infinity
  ck('T17-7', '查表端到端：4560 档组合期望 NPV == 网格基准',
    dNpv <= 0.15,
    `页面 ${comboTxt || '空'} vs Node 网格和 ${expectedComboNpv.toFixed(2)}，差 ${Number.isFinite(dNpv) ? dNpv.toFixed(4) : 'N/A'}（选中 ${pt ? pt.selected.length : '?'} 口）`)

  // T17-8：单文件含网格 + console 净度
  const artifactTxt = readFileSync(artifact, 'utf8')
  ck('T17-8', '单文件含 econ_grid_v1 且无 pageerror / console error',
    artifactTxt.includes('econ_grid_v1') && errors.length === 0,
    `artifact 标记 ${artifactTxt.includes('econ_grid_v1') ? '命中' : '缺失'}；错误 ${errors.length} 条${errors.length ? ' → ' + errors.slice(0, 2).join(' ⏐ ') : ''}`)

  const okCount = rows.filter((r) => r.ok).length
  for (const r of rows) console.log(`${r.ok ? '✓' : '✗'} ${r.id} ${r.name} — ${r.detail}`)
  console.log(`\n${okCount}/${rows.length} 通过`)
  if (okCount !== rows.length) process.exit(1)
} finally {
  await browser.close()
}
