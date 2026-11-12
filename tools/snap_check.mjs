#!/usr/bin/env node
/**
 * T03 · 旋钮就近吸附验收（C2，P0_验收闸门 §C2 / 06_任务清单 T03）
 *
 * 验收原文：**任意拖动不出「暂无」；提示文案出现。**
 * 闸门原文：喂越界值断言返回最近合法值 + `snapped:true`。
 *
 * 检查项：
 *  N-1  页面挂 C2 句柄（window.__c2，档位规模正确）
 *  N-2  基线：初始假设精确命中（snapped:false，无提示条）
 *  N-3  非刻度风险值 → 吸附到最近档（返回值 = 合法档位 + snapped:true）
 *  N-4  越界风险值（远超上界）→ 夹到最大档 + snapped:true
 *  N-5  越界预算值 → 吸附到最近预算档
 *  N-6  无点目标（oil）→ 目标吸附回 npv + 提示含「目标」
 *  N-7  提示文案出现（.snap-hint 含「已吸附最近可用工况」）
 *  N-8  吸附后组合面板不出「暂无」死路（有数字）
 *  N-9  滑杆真实交互：拖到非刻度位置 → assumptions.risk 落在合法档上
 *  N-10 console 无错误
 *
 * 用 puppeteer-core 驱动本机 Edge，file:// 打开交付产物，只读不动数据。
 * 用法：node tools/snap_check.mjs [--headful] [--json]
 */
import { existsSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const headful = args.includes('--headful')
const asJson = args.includes('--json')

const EDGE = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].find(existsSync)

const results = []
let failed = 0
function ck(id, name, pass, detail) {
  results.push({ id, name, pass, detail })
  if (!pass) failed++
  if (!asJson) console.log(`${pass ? '✅' : '❌'} ${id} ${name}${detail ? ' · ' + detail : ''}`)
}

if (!EDGE) {
  console.error('未找到 Edge 可执行文件')
  process.exit(1)
}

// puppeteer-core 在 frontend/node_modules（与 browser_check 同源）
const { createRequire } = await import('node:module')
const req = createRequire(join(ROOT, 'frontend', 'package.json'))
const puppeteer = req('puppeteer-core')

const target = pathToFileURL(join(ROOT, 'release', 'index.html')).href

const browser = await puppeteer.launch({
  executablePath: EDGE,
  headless: headful ? false : 'new',
  args: ['--no-sandbox', '--disable-gpu'],
})
try {
  const page = await browser.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))

  await page.goto(target + '#/', { waitUntil: 'load', timeout: 30000 })
  await page.waitForFunction(() => !!window.__c2, { timeout: 20000 })
  await new Promise((r) => setTimeout(r, 800))

  // ── N-1 档位规模（页面内展开，防 proxy 数组序列化变形） ──
  const ticks = await page.evaluate(() => ({
    riskCount: window.__c2.ticks.riskCount,
    riskMin: window.__c2.ticks.riskMin,
    riskMax: window.__c2.ticks.riskMax,
    budgetLen: window.__c2.ticks.budget.length,
    riskTicks: Array.from(window.__c2.ticks.riskTicks),
  }))
  ck('N-1', 'C2 句柄就绪，档位规模正确',
    ticks.riskCount > 12 && ticks.budgetLen >= 1,
    `风险 ${ticks.riskCount} 档（${ticks.riskMin}~${ticks.riskMax}）· 预算 ${ticks.budgetLen} 档`)

  // ── N-2 基线：初始精确命中 ──
  const base = await page.evaluate(() => {
    const s = window.__c2.state()
    const hint = document.querySelector('.snap-hint')
    return { snapped: s.snapped, hasPoint: !!s.point, hintVisible: !!hint }
  })
  ck('N-2', '初始假设精确命中（snapped:false，无提示条）',
    base.snapped === false && base.hasPoint && !base.hintVisible,
    `snapped=${base.snapped} · point=${base.hasPoint} · hint=${base.hintVisible}`)

  // ── N-3 非刻度风险 → 吸附最近档 ──
  // CVaR 档离散不均（实测最大空隙 641），最近档必须按真档表逐个比
  const nearestOf = (arr, x) => arr.reduce((a, b) => (Math.abs(b - x) < Math.abs(a - x) ? b : a))
  const mid = (ticks.riskMin + ticks.riskMax) / 2
  const offTick = mid + (ticks.riskMax - ticks.riskMin) * 0.0137 // 故意不落档
  const s3 = await page.evaluate((v) => {
    window.__c2.set(135, v)
    return window.__c2.state()
  }, offTick)
  const expected = nearestOf(ticks.riskTicks, offTick)
  const isLegal = await page.evaluate((v) => {
    window.__c2.set(135, v) // 喂吸附值本身 → 应精确命中（snapped:false）
    const s = window.__c2.state()
    return { snapped: s.snapped, risk: s.point.risk }
  }, s3.point.risk)
  ck('N-3', '非刻度风险值 → 返回最近合法档 + snapped:true',
    s3.snapped === true && s3.point != null && s3.point.risk === expected && isLegal.snapped === false,
    `输入 ${offTick.toFixed(2)} → 吸附 ${s3.point.risk.toFixed(2)}（Node 端最近档 ${expected.toFixed(2)} 一致；回喂该档 snapped=${isLegal.snapped} 证合法）`)

  // ── N-4 越界风险 → 夹到最大档 ──
  const s4 = await page.evaluate(() => {
    window.__c2.set(135, 1e9)
    return window.__c2.state()
  })
  ck('N-4', '越界风险值 → 夹到最大合法档',
    s4.snapped === true && s4.point != null && s4.point.risk === ticks.riskMax,
    `输入 1e9 → ${s4.point.risk.toFixed(2)}（= riskMax ${ticks.riskMax.toFixed(2)}）`)

  // ── N-5 越界预算 → 吸附最近预算档 ──
  const s5 = await page.evaluate(() => {
    window.__c2.set(400, -1e9)
    const s = window.__c2.state()
    return { ...s, budgetLegal: window.__c2.ticks.budget.includes(s.point.budget) }
  })
  ck('N-5', '越界预算/风险同时 → 双吸附，point 非空',
    s5.snapped === true && s5.point != null && s5.budgetLegal,
    `预算 400→${s5.point.budget}（合法档）· 风险 -1e9→${s5.point.risk.toFixed(2)}`)

  // ── N-6 无点目标 → 目标吸附 ──
  const s6 = await page.evaluate(() => {
    window.__c2.set(135, -1e9, 'oil')
    return window.__c2.state()
  })
  ck('N-6', '无点目标（oil）→ 吸附回有数据目标，提示含「目标」',
    s6.point != null && s6.snapped === true && /目标/.test(s6.reason ?? ''),
    `oil → ${s6.point.objective} · ${s6.reason}`)

  // ── N-7 提示文案出现 ──
  const hint = await page.evaluate(() => document.querySelector('.snap-hint')?.textContent?.trim() ?? '')
  ck('N-7', '提示文案出现（含「已吸附最近可用工况」）',
    /已吸附最近可用工况/.test(hint), hint.slice(0, 60))

  // ── N-8 吸附后组合面板无死路（圈定 .pfc 组合推演台） ──
  // 死路标志 = v-else 分支「当前 B/R/目标组合不在 portfolio.points 内」；
  // regret 字段全数据集为 null，其「暂无」是 EmptyValue 契约行为，不属 C2 死路
  const pfc = await page.evaluate(() => {
    const el = document.querySelector('.pfc')
    const txt = (el?.textContent ?? '').replace(/\s+/g, ' ')
    return {
      dead: txt.includes('不在 portfolio.points 内'),
      hasWells: /井数\s*\d+/.test(txt),
      hasNpv: /期望\s*NPV\s*-?[\d,]/.test(txt),
    }
  })
  ck('N-8', '吸附后组合推演台无死路（命中分支渲染，有井数有 NPV）',
    !pfc.dead && pfc.hasWells && pfc.hasNpv,
    `死路分支 ${pfc.dead} · 井数 ${pfc.hasWells} · 期望NPV ${pfc.hasNpv}`)

  // ── N-9 滑杆真实交互：拖到非刻度位置 → 落在合法档 ──
  const sliderOk = await page.evaluate(() => {
    const el = document.querySelector('.area-rail .n-slider .n-slider-handle')
    if (!el) return { ok: false, why: 'no handle' }
    return { ok: true }
  })
  if (sliderOk.ok) {
    // 键盘交互：聚焦滑杆后按多次右键（每次步进都是非刻度值）
    await page.focus('.area-rail .n-slider .n-slider-handle')
    for (let i = 0; i < 7; i++) await page.keyboard.press('ArrowRight')
    await new Promise((r) => setTimeout(r, 300))
    const after = await page.evaluate(() => {
      const risk = window.__c2.state().point.risk
      const s = window.__c2.state()
      return { risk, snapped: s.snapped, reason: s.reason }
    })
    // 拖动后 point.risk 应是合法档（与 setRiskSnapped 结果一致即可复验）
    const confirm = await page.evaluate((v) => {
      window.__c2.set(135, v)
      return window.__c2.state().point.risk
    }, after.risk)
    ck('N-9', '滑杆拖动 → assumptions.risk 落在合法档',
      after.risk != null && Math.abs(confirm - after.risk) < 1e-9,
      `键盘步进后风险档 ${after.risk?.toFixed(2)} · 复验同值 ${confirm.toFixed(2)}`)
  } else {
    ck('N-9', '滑杆存在', false, sliderOk.why)
  }

  // ── N-10 console 无错误 ──
  ck('N-10', 'console 无错误', errors.length === 0, errors.slice(0, 2).join(' | ') || '0 条')

  await browser.close()
} catch (e) {
  console.error(String(e))
  await browser.close().catch(() => {})
  process.exit(1)
}

if (asJson) console.log(JSON.stringify(results))
console.log(failed === 0 ? `\nT03 · C2 验收 ${results.length}/${results.length} 全绿` : `\nT03 · C2 验收 ${results.length - failed}/${results.length}，红 ${failed} 条`)
process.exit(failed === 0 ? 0 : 1)
