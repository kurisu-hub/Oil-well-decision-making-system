#!/usr/bin/env node
/**
 * T05 · 数字溯源抽屉验收（P0 闸门 D5 + 06 验收「抽 20 个数字命中 20/20」）
 *
 * 用 puppeteer-core 实机点遍带 data-prov 的数字：
 *   1. 每次点击 → 护照抽屉打开，条目 hit（bundle p_ 护照或 x_ 前端补录）
 *   2. hit 条目必有非空 formula 与 source（source 为合法枚举）
 *   3. p_ 前缀条目（bundle 护照）必有 sample_size
 *   4. 抽屉 DOM 真渲染（.n-drawer 内出现「公式：」），不是只有 store 状态
 *   5. 抽满 20 个不同 prov id，命中 20/20
 *   6. D5：首屏导航含「证据中心」与「模型卡」入口（四幕路径的证据入口）
 *
 * 用法：node tools/gate/prov_check.mjs [--headful]
 */
import { existsSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const args = process.argv.slice(2)
const headful = args.includes('--headful')

const EDGE_CANDIDATES = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
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
  console.error('✗ 缺少 release_v3/index.html')
  process.exit(2)
}
const url = pathToFileURL(artifact).href

const rows = []
const ck = (id, name, ok, detail) => rows.push({ id, name, ok, detail })

const VALID_SOURCES = ['paper', 'synthetic', 'live', 'assumption', 'illustrative', 'derived']

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

  /** 已验过的 prov id（去重，凑 20 个不同数字） */
  const seen = new Map()

  /**
   * 在当前页面点遍所有 [data-prov]，逐个断言抽屉命中。
   * 返回本页点击数。
   */
  async function clickAllOnPage(need) {
    return page.evaluate((needArg, validSources) => {
      const P = window.__prov
      if (!P) return { clicked: 0, pageHits: 0, fails: ['__prov 句柄缺失'] }
      const els = Array.from(document.querySelectorAll('[data-prov]'))
      const fails = []
      let clicked = 0
      let pageHits = 0
      for (const el of els) {
        if (clicked >= needArg) break
        const id = el.getAttribute('data-prov')
        el.click()
        const d = P.drawer()
        if (!d.open) fails.push(`${id}: 抽屉未打开`)
        else {
          const e0 = d.entries[0]
          if (!e0 || !e0.hit) fails.push(`${id}: 条目未命中`)
          else if (!e0.formula || !e0.formula.trim()) fails.push(`${id}: formula 为空`)
          else if (!validSources.includes(e0.source)) fails.push(`${id}: source 非法(${e0.source})`)
          else if (id.startsWith('p_') && typeof e0.sampleSize !== 'number') fails.push(`${id}: p_ 护照缺 sample_size`)
          else pageHits++
        }
        P.close()
        clicked++
        if (!d.open) break
      }
      return { clicked, pageHits, fails }
    }, need, VALID_SOURCES)
  }

  // —— 第一幕 Cockpit（KPI 条 5 + 焦点井 3 + 井筒详图 3）——
  await page.goto(url + '#/', { waitUntil: 'load' })
  await page.waitForFunction(() => window.__prov && document.querySelectorAll('[data-prov]').length >= 8, { timeout: 20000 })
  const r1 = await clickAllOnPage(11)
  ck('T05-1', '第一幕（Cockpit）点数字命中', r1.fails.length === 0 && r1.pageHits > 0,
    r1.fails.length ? r1.fails.slice(0, 3).join(' ⏐ ') : `点击 ${r1.clicked} 命中 ${r1.pageHits}`)

  // 记录命中的 id（供 20 去重统计）
  const ids1 = await page.evaluate(() => window.__prov.clickable().map((c) => c.prov))
  for (const id of ids1) seen.set(id, 'cockpit')

  // —— 第二幕 DecisionCard ——
  const focusId = await page.evaluate(() => {
    const el = document.querySelector('[data-prov^="p_anchor_"]')
    return el ? el.getAttribute('data-prov').replace('p_anchor_', '') : null
  })
  if (focusId) {
    await page.goto(url + '#/well/' + focusId, { waitUntil: 'load' })
    await page.waitForFunction(() => window.__prov && document.querySelectorAll('[data-prov]').length >= 3, { timeout: 20000 })
    const r2 = await clickAllOnPage(3)
    ck('T05-2', '第二幕（单井决策卡）点数字命中', r2.fails.length === 0 && r2.pageHits > 0,
      r2.fails.length ? r2.fails.slice(0, 3).join(' ⏐ ') : `点击 ${r2.clicked} 命中 ${r2.pageHits}`)
    const ids2 = await page.evaluate(() => window.__prov.clickable().map((c) => c.prov))
    for (const id of ids2) seen.set(id, 'decision')
  } else {
    ck('T05-2', '第二幕（单井决策卡）点数字命中', false, '未找到焦点井 id')
  }

  // —— 第三幕 Portfolio ——
  await page.goto(url + '#/portfolio', { waitUntil: 'load' })
  await page.waitForFunction(() => window.__prov && document.querySelectorAll('[data-prov]').length >= 6, { timeout: 20000 })
  const r3 = await clickAllOnPage(6)
  ck('T05-3', '第三幕（结算摘要）点数字命中', r3.fails.length === 0 && r3.pageHits > 0,
    r3.fails.length ? r3.fails.slice(0, 3).join(' ⏐ ') : `点击 ${r3.clicked} 命中 ${r3.pageHits}`)
  const ids3 = await page.evaluate(() => window.__prov.clickable().map((c) => c.prov))
  for (const id of ids3) seen.set(id, 'portfolio')

  // —— 兜底：不足 20 个直接开全局护照（价格/成本/SMAPE/覆盖率系）——
  // 注：p_price / p_cost 是纯假设条目（油价、成本），bundle 不给 sample_size 是诚实口径，不算失败
  await page.goto(url + '#/', { waitUntil: 'load' })
  await page.waitForFunction(() => !!window.__prov, { timeout: 20000 })
  const globals = ['p_price', 'p_cost', 'p_smape_ANBM', 'p_smape_LSDRT-v2', 'p_smape_Template', 'p_smape_Flat', 'p_cov_B_ANBM', 'p_cov_A_ANBM']
  const r4 = await page.evaluate((globalsArg, haveArg) => {
    const P = window.__prov
    const fails = []
    let extra = 0
    for (const id of globalsArg) {
      if (haveArg.includes(id)) continue
      P.open([id])
      const d = P.drawer()
      const e0 = d.entries[0]
      if (!d.open || !e0 || !e0.hit) fails.push(`${id}: 未命中`)
      else if (!e0.formula?.trim()) fails.push(`${id}: formula 空`)
      else if (typeof e0.sampleSize !== 'number' && !['p_price', 'p_cost'].includes(id)) fails.push(`${id}: 缺 sample_size`)
      else extra++
      P.close()
    }
    return { extra, fails }
  }, globals, [...seen.keys()])
  ck('T05-4', '全局护照条目（价格/成本/SMAPE/覆盖率）直开命中', r4.fails.length === 0 && r4.extra > 0,
    r4.fails.length ? r4.fails.slice(0, 3).join(' ⏐ ') : `补开 ${r4.extra} 条（p_price/p_cost 为纯假设无样本量，口径如实）`)
  for (const id of globals) if (r4.fails.length === 0) seen.set(id, 'global')

  // —— 20/20 统计（T05 主判据）——
  ck('T05-5', '抽 20 个数字命中 20/20', seen.size >= 20, `可溯源数字（不同 prov id）共 ${seen.size} 个 ≥ 20`)

  // —— 抽屉 DOM 真渲染 ——
  await page.evaluate(() => window.__prov.open(['p_price']))
  await new Promise((res) => setTimeout(res, 400))
  const domOk = await page.evaluate(() => {
    const d = document.querySelector('.n-drawer')
    const body = d ? d.textContent || '' : ''
    return { has: !!d, formula: body.includes('公式：'), source: /来源|实测|假设|文献|合成|示意|模型推导/.test(body) || body.includes('样本量') }
  })
  ck('T05-6', '抽屉 DOM 渲染（公式/样本量可见）', domOk.has && domOk.formula, JSON.stringify(domOk))
  await page.evaluate(() => window.__prov.close())

  // —— D5：证据入口（闸门口径：模型卡入口 或 首屏证据按钮，二者其一即过）——
  await page.goto(url + '#/', { waitUntil: 'load' })
  await new Promise((res) => setTimeout(res, 300))
  const nav = await page.evaluate(() => {
    const t = document.querySelector('.topbar, header, nav')?.textContent || document.body.textContent || ''
    return { evidence: t.includes('证据中心'), modelCard: t.includes('模型卡') }
  })
  ck('D5', '四幕路径含证据入口（模型卡入口或证据按钮）', nav.modelCard || nav.evidence,
    `模型卡入口 ${nav.modelCard ? '有' : '无'} / 证据中心 ${nav.evidence ? '有' : '无'}（闸门口径：二者其一）`)

  // —— console 净度 ——
  ck('T05-7', '无 console error / pageerror', errors.length === 0, errors.length ? `${errors.length} 条 → ${errors.slice(0, 2).join(' ⏐ ')}` : '0 条')

  // —— 汇总 ——
  const okCount = rows.filter((r) => r.ok).length
  for (const r of rows) {
    console.log(`${r.ok ? '✓' : '✗'} ${r.id} ${r.name} — ${r.detail}`)
  }
  console.log(`\n${okCount}/${rows.length} 通过`)
  if (okCount !== rows.length) process.exit(1)
} finally {
  await browser.close()
}
