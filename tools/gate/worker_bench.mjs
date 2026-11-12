#!/usr/bin/env node
/**
 * T04 · A2 Worker 前端推理验收（P0 闸门 A2 + 06 验收「任意输入 < 100 ms；与离线预测误差 < 1e-6」）
 *
 * 实机（puppeteer + file:// 单文件）检查：
 *   1. Worker 模式真实生效（mode === 'worker'，非主线程兜底）
 *   2. 面板真实渲染（DWG-COMP-007 新井试算面板在 DOM 里）
 *   3. 77 口井（events.csv 真实输入）逐口 infer，P95 延迟 < 100 ms
 *   4. Worker 输出 vs Node 参照实现（同公式同输入）：bucket / 12 月曲线 / 基线 / ΔN / NPV 全部 < 1e-6
 *   5. 新井任意输入（含极端档）同样 < 100 ms 且与参照一致
 *   6. console error / pageerror = 0
 *
 * 参照实现口径（与本文件独立重写，防「自己抄自己」）：
 *   ŷ(t) = anchor × c_bucket(t)（bundle.final_model.models.ANBM）
 *   baseline(k) = anchor × exp(−D_fit·k)
 *   ΔN = (Σŷ − Σ基线) × 30.4；NPV = ΔN × 0.323 − 45
 *
 * 用法：node tools/gate/worker_bench.mjs [--headful]
 */
import { existsSync, readFileSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const args = process.argv.slice(2)
const headful = args.includes('--headful')

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
if (!existsSync(artifact)) process.exit(2)
const url = pathToFileURL(artifact).href

// ---------- Node 参照实现（独立重写） ----------
const bundle = JSON.parse(readFileSync(join(ROOT, 'frontend', 'src', 'data', 'bundle_v3.json'), 'utf8'))
const ANBM = bundle.final_model.models.ANBM
const PRICE = 0.323
const COST = 45.0
const DAYS = 30.4

function refBucket(base) {
  let k = 0
  for (let j = 1; j < ANBM.bins.length - 1; j++) if (ANBM.bins[j] <= base) k++
  return k
}

function refInfer(anchor, dFit) {
  const b = refBucket(anchor)
  const c = ANBM.curves[String(b)] ?? ANBM.global_curve
  const curve = []
  const baseline = []
  let sp = 0
  let sb = 0
  for (let t = 0; t < 12; t++) {
    const p = anchor * c[t]
    const bl = anchor * Math.exp(-dFit * (t + 1))
    curve.push(p)
    baseline.push(bl)
    sp += p
    sb += bl
  }
  const dN = (sp - sb) * DAYS
  return { bucket: b, curve, baseline, dN, npv: dN * PRICE - COST }
}

// ---------- 77 口真实输入（events.csv：anchor + D_fit） ----------
const evLines = readFileSync(join(ROOT, '..', '04_数据', 'events.csv'), 'utf8').trim().split('\n')
const evHdr = evLines[0].split(',')
const iAnchor = evHdr.indexOf('anchor')
const iD = evHdr.indexOf('D_fit')
const inputs77 = evLines.slice(1).map((l) => {
  const r = l.split(',')
  return { anchor: Number(r[iAnchor]), dFit: Number(r[iD]) }
})
if (inputs77.length !== 77) {
  console.error(`✗ events.csv 行数异常：${inputs77.length} ≠ 77`)
  process.exit(2)
}

// 新井任意输入（含四档边界 + 极端）
const newInputs = [
  { anchor: 0.51, dFit: 0.15 },
  { anchor: 1.4543, dFit: 0.02 },
  { anchor: 2.95, dFit: 0.4 },
  { anchor: 8.0, dFit: 0.9 },
  { anchor: 0.05, dFit: 0.0 },
]

const rows = []
const ck = (id, name, ok, detail) => rows.push({ id, name, ok, detail })

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
  await page.waitForFunction(() => window.__worker, { timeout: 20000 })

  // 1. Worker 模式
  const mode = await page.evaluate(() => window.__worker.mode())
  ck('A2-1', 'Worker 模式真实生效（非主线程兜底）', mode === 'worker', `mode = ${mode}`)

  // 2. 面板渲染
  const panel = await page.evaluate(() => {
    const el = document.querySelector('.fig-no')
    const body = document.body.textContent || ''
    return { hasCap: body.includes('新井试算'), hasBtn: body.includes('试算') }
  })
  ck('A2-2', '新井试算面板渲染（DWG-COMP-007）', panel.hasCap && panel.hasBtn, JSON.stringify(panel))

  // 3+4. 77 口逐口 infer：延迟 + 数值一致性
  const bench = await page.evaluate(async (inputs) => {
    const times = []
    const results = []
    for (const input of inputs) {
      const r = await window.__worker.infer(input)
      times.push(r.ms)
      results.push(r.result)
    }
    const sorted = [...times].sort((a, b) => a - b)
    const p50 = sorted[Math.floor(sorted.length * 0.5)]
    const p95 = sorted[Math.floor(sorted.length * 0.95)]
    const max = sorted[sorted.length - 1]
    return { times, results, p50, p95, max }
  }, inputs77)

  ck('A2-3', '77 口换井推理 P95 < 100 ms', bench.p95 < 100,
    `P50 ${bench.p50.toFixed(2)} / P95 ${bench.p95.toFixed(2)} / max ${bench.max.toFixed(2)} ms（Worker 模式）`)

  let worst = 0
  let worstAt = ''
  let badBucket = 0
  for (let i = 0; i < 77; i++) {
    const ref = refInfer(inputs77[i].anchor, inputs77[i].dFit)
    const got = bench.results[i]
    if (got.bucket !== ref.bucket) badBucket++
    for (const key of ['dN', 'npv']) {
      const e = Math.abs(got[key] - ref[key])
      if (e > worst) { worst = e; worstAt = `well#${i}:${key}` }
    }
    for (let t = 0; t < 12; t++) {
      const e = Math.max(Math.abs(got.curve[t] - ref.curve[t]), Math.abs(got.baseline[t] - ref.baseline[t]))
      if (e > worst) { worst = e; worstAt = `well#${i}:m${t + 1}` }
    }
  }
  ck('A2-4', 'Worker vs 离线参照 < 1e-6（77 口 × 曲线/基线/ΔN/NPV）', worst < 1e-6 && badBucket === 0,
    `最大偏差 ${worst.toExponential(2)} @ ${worstAt}；分桶不一致 ${badBucket} 口`)

  // 5. 新井任意输入
  const newBench = await page.evaluate(async (inputs) => {
    const out = []
    for (const input of inputs) {
      const r = await window.__worker.infer(input)
      out.push({ ms: r.ms, result: r.result })
    }
    return out
  }, newInputs)
  let newWorst = 0
  const newMaxMs = Math.max(...newBench.map((r) => r.ms))
  for (let i = 0; i < newInputs.length; i++) {
    const ref = refInfer(newInputs[i].anchor, newInputs[i].dFit)
    const got = newBench[i].result
    newWorst = Math.max(
      newWorst,
      Math.abs(got.npv - ref.npv),
      Math.abs(got.dN - ref.dN),
      ...got.curve.map((v, t) => Math.abs(v - ref.curve[t])),
      ...got.baseline.map((v, t) => Math.abs(v - ref.baseline[t])),
    )
    if (got.bucket !== ref.bucket) newWorst = Math.max(newWorst, 1)
  }
  ck('A2-5', '新井任意输入（含四档边界）< 100 ms 且一致', newMaxMs < 100 && newWorst < 1e-6,
    `最大延迟 ${newMaxMs.toFixed(2)} ms；最大偏差 ${newWorst.toExponential(2)}`)

  // 6. console 净度
  ck('A2-6', '无 console error / pageerror', errors.length === 0,
    errors.length ? `${errors.length} 条 → ${errors.slice(0, 2).join(' ⏐ ')}` : '0 条')

  const okCount = rows.filter((r) => r.ok).length
  for (const r of rows) console.log(`${r.ok ? '✓' : '✗'} ${r.id} ${r.name} — ${r.detail}`)
  console.log(`\n${okCount}/${rows.length} 通过`)
  if (okCount !== rows.length) process.exit(1)
} finally {
  await browser.close()
}
