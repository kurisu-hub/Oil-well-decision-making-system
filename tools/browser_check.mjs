#!/usr/bin/env node
/**
 * P9 · 浏览器实机自检（闸门验不了的部分）
 *
 * 用 puppeteer-core 驱动本机 Edge，以 `file://` 打开交付产物，逐路由检查：
 *   1. 页面能否加载（file:// 下 Worker/Blob/CORS 的坑静态扫不出）
 *   2. console error / pageerror 计数
 *   3. 8 条路由是否都能渲染出预期标题
 *   4. 关键页面有没有真实数据（表格行数、KPI 数字）
 *   5. 首屏可交互时间
 *
 * 用法：
 *   node tools/browser_check.mjs
 *   node tools/browser_check.mjs --headful     # 看窗口
 *   node tools/browser_check.mjs --json
 *
 * 依赖：puppeteer-core（本地验证工具，不进 package.json、不参与构建）
 */
import { existsSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const headful = args.includes('--headful')
const asJson = args.includes('--json')

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
  // ESM 不认 NODE_PATH，从 frontend/ 的依赖树里解析
  const { createRequire } = await import('node:module')
  const req = createRequire(join(ROOT, 'frontend', 'package.json'))
  puppeteer = req('puppeteer-core')
  if (puppeteer?.default) puppeteer = puppeteer.default
} catch {
  console.error('✗ 缺少 puppeteer-core：在 frontend/ 下 npm i --no-save puppeteer-core')
  process.exit(2)
}

const artifact = join(ROOT, 'release', 'index.html')
if (!existsSync(artifact)) {
  console.error('✗ 缺少 release/index.html')
  process.exit(2)
}
const url = pathToFileURL(artifact).href

const rows = []
const ck = (id, name, ok, detail) => rows.push({ id, name, ok, detail })

const browser = await puppeteer.launch({
  executablePath: exe,
  headless: headful ? false : 'new',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
  defaultViewport: { width: 1600, height: 1000 },
})

const page = await browser.newPage()
const errors = []
const warnings = []
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text().slice(0, 200))
  if (m.type() === 'warning') warnings.push(m.text().slice(0, 160))
})
page.on('pageerror', (e) => errors.push('pageerror: ' + String(e).slice(0, 200)))
page.on('requestfailed', (r) => {
  // file:// 下对本地文件的请求失败才是问题；外网请求出现即视为联网
  if (/^https?:/.test(r.url())) errors.push('外网请求: ' + r.url().slice(0, 120))
})

// ── 1. 首屏 ────────────────────────────────────────────────
const t0 = Date.now()
await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 })
await page.waitForFunction(() => document.body && document.body.innerText.length > 50, { timeout: 15000 })
const tReady = Date.now() - t0
ck('B-1', 'file:// 可启动', true, `首屏就绪 ${tReady} ms`)
ck('B-2', '首屏 < 2.0 s', tReady < 2000, `${tReady} ms`)

const title = await page.title()
ck('B-3', '页面标题正确', title.includes('完井措施决策沙盘'), title)

// ── 2. 路由遍历 ────────────────────────────────────────────
const ROUTES = [
  { hash: '#/', key: '区块价值全景', name: '决策沙盘' },
  { hash: '#/portfolio', key: '措施会结算', name: '组合下注' },
  { hash: '#/review', key: '数据与复盘', name: '复盘' },
  { hash: '#/report', key: '决策报告', name: '报告' },
  { hash: '#/model-card', key: '模型卡', name: '模型卡' },
  { hash: '#/evidence', key: '证据中心', name: '证据中心' },
  { hash: '#/about', key: '关于本系统', name: '关于' },
]

for (const r of ROUTES) {
  const before = errors.length
  await page.evaluate((h) => { window.location.hash = h }, r.hash)
  await new Promise((res) => setTimeout(res, 500))
  const txt = await page.evaluate(() => document.body.innerText)
  const ok = txt.includes(r.key)
  const newErr = errors.length - before
  ck(`B-R:${r.name}`, `路由 ${r.hash} 渲染`, ok && newErr === 0,
     ok ? (newErr ? `渲染但报 ${newErr} 条错误` : '正常') : `未找到「${r.key}」`)
}

// ── 3. 深链路：单井页 ─────────────────────────────────────
{
  const before = errors.length
  await page.evaluate(() => { window.location.hash = '#/well/CO12336656' })
  await new Promise((res) => setTimeout(res, 600))
  const txt = await page.evaluate(() => document.body.innerText)
  const ok = txt.length > 100 && txt.includes('CO12336656') || txt.includes('NPV')
  ck('B-R:单井页', '路由 /well/:id 渲染', ok && errors.length === before,
     ok ? '正常' : '内容异常')
}

// ── 4. 数据真实性（证据页表格） ───────────────────────────
await page.evaluate(() => { window.location.hash = '#/evidence' })
await new Promise((res) => setTimeout(res, 600))
const evStats = await page.evaluate(() => {
  const tables = document.querySelectorAll('table')
  const rowsN = document.querySelectorAll('tbody tr').length
  const text = document.body.innerText
  return {
    tables: tables.length,
    rows: rowsN,
    hasPctile: /\d+\.\d+%/.test(text),
    hasCvar: text.includes('CVaR') || text.includes('cvar') || text.includes('-3'),
    hasKpi: text.includes('绿盘') || text.includes('precision') || text.includes('分位'),
    textLen: text.length,
  }
})
ck('B-4', '证据页有真实表格', evStats.tables >= 3 && evStats.rows >= 15,
   `${evStats.tables} 表 / ${evStats.rows} 行`)
ck('B-5', '证据页数字已渲染', evStats.hasPctile && evStats.textLen > 800,
   `文本 ${evStats.textLen} 字，百分位样式 ${evStats.hasPctile}`)

// ── 5. 关于页 / 单位表 ───────────────────────────────────
await page.evaluate(() => { window.location.hash = '#/about' })
await new Promise((res) => setTimeout(res, 500))
const about = await page.evaluate(() => {
  const t = document.body.innerText
  return {
    units: ['m³/d', '万元', '米'].filter((u) => t.includes(u)),
    scenario: t.includes('谁在用') && t.includes('在什么地方用'),
    aigc: t.includes('AIGC'),
    limits: t.includes('已知局限'),
  }
})
ck('B-6', '关于页单位表齐全', about.units.length === 3, about.units.join(' / '))
ck('B-7', '关于页场景卡 + AIGC + 局限', about.scenario && about.aigc && about.limits,
   `场景 ${about.scenario} / AIGC ${about.aigc} / 局限 ${about.limits}`)

// ── 6. console 净度 ────────────────────────────────────────
const realErrors = errors.filter((e) => !/favicon|ResizeObserver/i.test(e))
ck('B-8', '无 console error', realErrors.length === 0,
   realErrors.length ? `${realErrors.length} 条 → ${realErrors.slice(0, 2).join(' ⏐ ')}` : '0 条')

// ── 7. 运行时无网络请求（P9-5 口径演进后的硬证明，2026-11-10）──
//    静态扫豁免了 three loader 的 fetch 字面；本断言在实机页面里查
//    performance 资源条目：只允许 data:/blob:，出现 http(s):// 即 FAIL。
const netResources = await page.evaluate(() =>
  performance.getEntriesByType('resource')
    .map((r) => r.name)
    .filter((n) => /^https?:/i.test(n)),
)
ck('B-9', '运行时无网络请求', netResources.length === 0,
   netResources.length ? `${netResources.length} 条 → ${netResources.slice(0, 3).join(' | ')}` : 'performance 资源全为 data:/blob:')

await browser.close()

if (asJson) {
  console.log(JSON.stringify({ url, rows, warnings: warnings.slice(0, 5) }, null, 2))
} else {
  console.log('='.repeat(74))
  console.log('P9 · 浏览器实机自检（file://）')
  console.log('='.repeat(74))
  for (const r of rows) {
    console.log(`${r.ok ? '✓' : '✗'} ${r.id.padEnd(12)} ${r.name.padEnd(24)} ${r.ok ? 'PASS' : 'FAIL'}  ${r.detail}`)
  }
  const nFail = rows.filter((r) => !r.ok).length
  console.log('='.repeat(74))
  console.log(`通过 ${rows.length - nFail}/${rows.length}　${nFail ? '✗ 存在失败项' : '✓ 全绿'}`)
}
process.exit(rows.some((r) => !r.ok) ? 1 : 0)
