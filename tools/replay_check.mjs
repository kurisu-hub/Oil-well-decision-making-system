#!/usr/bin/env node
/**
 * T01 · 历史回放器验收（06_任务清单 T01）
 *
 * 验收原文：**拖时间轴，三处数字同时变；暂停后不再变化。**
 * 三处 = ① 曲线游标（WorldLine「游标 M{n}/12」）
 *        ② 三维推演（SceneView「推演 t = M{n}」+ fracScale/surfaceLift/npv）
 *        ③ 回放 KPI（已入场 n/77 · 满 12 月 n）
 *
 * 用 puppeteer-core 驱动本机 Edge，以 file:// 打开交付产物，只读 DOM，不改数据。
 *
 * 用法：node tools/replay_check.mjs [--headful] [--json]
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
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
].find((p) => existsSync(p))
if (!EDGE) { console.error('✗ 未找到 Edge/Chrome'); process.exit(2) }

const { createRequire } = await import('node:module')
const req = createRequire(join(ROOT, 'frontend', 'package.json'))
let puppeteer
try { puppeteer = req('puppeteer-core'); if (puppeteer?.default) puppeteer = puppeteer.default }
catch { console.error('✗ 缺少 puppeteer-core：cd frontend && npm i --no-save puppeteer-core'); process.exit(2) }

const artifact = join(ROOT, 'release', 'index.html')
if (!existsSync(artifact)) { console.error('✗ 缺少 release/index.html'); process.exit(2) }
const base = pathToFileURL(artifact).href

const rows = []
const ck = (id, name, ok, detail) => rows.push({ id, name, ok, detail: String(detail) })

const browser = await puppeteer.launch({
  executablePath: EDGE,
  headless: headful ? false : 'new',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
  defaultViewport: { width: 1600, height: 1000 },
})
const page = await browser.newPage()
const errors = []
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)) })
page.on('pageerror', (e) => errors.push('pageerror: ' + String(e).slice(0, 200)))

/** 读回放条与控制台读数 */
async function readState() {
  return page.evaluate(() => {
    const q = (s) => document.querySelector(s)
    const when = q('.bar .when b')?.textContent?.trim() ?? ''
    const kpi = q('.bar .kpi')?.textContent?.replace(/\s+/g, ' ').trim() ?? ''
    const entered = Number((kpi.match(/已入场\s*(\d+)/) ?? [])[1] ?? NaN)
    const observed = Number((kpi.match(/满\s*12\s*月\s*(\d+)/) ?? [])[1] ?? NaN)
    const body = document.body.innerText
    const cursor = Number((body.match(/游标\s*M(\d+)\/12/) ?? [])[1] ?? NaN)
    const simT = Number((body.match(/推演\s*t\s*=\s*M(\d+)/) ?? [])[1] ?? NaN)
    const bar = q('.bar')
    const m = Number(bar?.getAttribute('data-m') ?? NaN) // 全局游标（任意路由可读）
    const mi = Number(bar?.getAttribute('data-mi') ?? NaN)
    const focus = bar?.getAttribute('data-focus') ?? ''
    return { when, entered, observed, cursor, simT, m, mi, focus, playing: !!q('.bar .btn.play.on') }
  })
}

/** 把滑块设到 0–1000 的某个位置 */
async function seek(v) {
  await page.evaluate((val) => {
    const el = document.querySelector('.bar input.rng')
    if (!el) return
    el.value = String(val)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }, v)
  await new Promise((r) => setTimeout(r, 250))
}

await page.goto(base + '#/', { waitUntil: 'networkidle2', timeout: 30000 })
await page.waitForFunction(() => !!document.querySelector('.bar .when b'), { timeout: 15000 })
await new Promise((r) => setTimeout(r, 400))

// ── 1. 组件与默认态 ────────────────────────────────
const s0 = await readState()
ck('R-1', '回放条全站渲染', !!s0.when, `数据时刻 ${s0.when}`)
ck('R-2', '默认停在数据集末端', s0.when === '2024-08', `期望 2024-08，实测 ${s0.when}`)
ck('R-3', '初始游标 = M12（焦点井已过 12 月）', s0.cursor === 12, `游标 M${s0.cursor}/12`)

// ── 2. 拖动：三处同时变 ────────────────────────────
await seek(300) // ≈ 2017 年
const s1 = await readState()
ck('R-4', '拖动 → 数据时刻变', s1.when !== s0.when, `${s0.when} → ${s1.when}`)
ck('R-5', '拖动 → 曲线游标变（同源 ①）', s1.m !== s0.m, `M${s0.m} → M${s1.m}（焦点 ${s0.focus}→${s1.focus}）`)
ck('R-6', '拖动 → 回放 KPI 变（同源 ③）',
  s1.entered !== s0.entered || s1.observed !== s0.observed,
  `已入场 ${s0.entered}→${s1.entered} · 满12月 ${s0.observed}→${s1.observed}`)

// ── 3. 三维推演（#/scene）也要跟着走 ───────────────
await page.evaluate(() => { location.hash = '#/scene' })
await page.waitForFunction(() => /推演\s*t\s*=\s*M/.test(document.body.innerText), { timeout: 15000 })
await new Promise((r) => setTimeout(r, 400))
const s2 = await readState()
ck('R-7', '三维推演 t 与全局游标同值（同源 ②）',
  Number.isFinite(s2.simT) && s2.simT === s2.m, `推演 t=M${s2.simT}，全局游标 M${s2.m}`)
await seek(700)
const s3 = await readState()
ck('R-8', '拖动 → 三维推演变（同源 ②）', s3.simT !== s2.simT, `t=M${s2.simT} → M${s3.simT}`)

// ── 4. 播放 / 暂停 ─────────────────────────────────
await seek(0)
const beforePlay = await readState()
await page.click('.bar .btn.play')
await new Promise((r) => setTimeout(r, 1300))
const during = await readState()
ck('R-9', '播放 1.3 s 后时钟前进（1× ≈ 1 月/秒）',
  during.when !== beforePlay.when, `${beforePlay.when} → ${during.when}`)
ck('R-10', '播放中按钮为暂停态', during.playing, `playing=${during.playing}`)

await page.click('.bar .btn.play') // 暂停
const pausedAt = await readState()
await new Promise((r) => setTimeout(r, 1200))
const afterPause = await readState()
ck('R-11', '暂停后不再变化',
  pausedAt.when === afterPause.when && pausedAt.m === afterPause.m,
  `${pausedAt.when}/M${pausedAt.m} → ${afterPause.when}/M${afterPause.m}`)

// ── 5. 文案红线 + 无报错 ───────────────────────────
const txt = await page.evaluate(() => document.body.innerText)
ck('R-12', '不出现「实时/实时数据」字样', !/实时/.test(txt), /实时/.test(txt) ? '出现违规字样' : '0 处')
ck('R-13', 'console 无错误', errors.length === 0, errors.slice(0, 2).join(' | ') || '0 条')

// ── 6. T02 数据时刻条（顶部常驻） ──────────────────
const readBadge = () => page.evaluate(() => {
  const el = document.querySelector('.clock')
  return { text: el?.textContent?.replace(/\s+/g, ' ').trim() ?? '', exists: !!el }
})
const badge = await readBadge()
ck('R-14', '时刻条常驻顶栏', badge.exists, badge.text || '未找到 .clock')
ck('R-15', '时刻条格式「数据时刻 · 数据集 · 历史回放」',
  /数据时刻\s*\d{4}-\d{2}\s*·\s*数据集\s*2014-09~2024-08\s*·\s*历史回放/.test(badge.text),
  badge.text)
await seek(150)
const badge2 = await readBadge()
ck('R-16', '时刻条随回放变化', badge2.text !== badge.text, `${badge.text.slice(0, 24)} → ${badge2.text.slice(0, 24)}`)

// ── 6. 焦点跟随开关（D-040 判据） ────────────────────
await page.evaluate(() => { location.hash = '#/' })
await page.waitForFunction(() => /游标\s*M\d+\/12/.test(document.body.innerText), { timeout: 15000 })
await new Promise((r) => setTimeout(r, 400))
async function readCursor() {
  return Number((document.body.innerText.match(/游标\s*M(\d+)\/12/) ?? [])[1] ?? NaN)
}
async function clickFollow() {
  await page.evaluate(() => {
    const btn = document.querySelector('.bar .btn.follow')
    if (btn) btn.click()
  })
  await new Promise((r) => setTimeout(r, 250))
}
// 默认开启：任意月份游标 ∈ M0–M12（D-040：开启时相邻月份游标随事件变化）
const curOn = await page.evaluate(readCursor)
ck('R-17a', '焦点跟随开启时游标 ∈ M0–M12',
  Number.isFinite(curOn) && curOn >= 0 && curOn <= 12, `M${curOn}`)
// 关闭：拖时间轴游标必须停在原值
await clickFollow() // 关
const curBefore = await page.evaluate(readCursor)
await seek(600)
await seek(120)
const curAfter = await page.evaluate(readCursor)
ck('R-17b', '关闭焦点跟随后拖动游标不动',
  curAfter === curBefore, `关前 M${curBefore} → 拖 60%/12% 后 M${curAfter}`)
await clickFollow() // 恢复开（留默认态）
const curRe = await page.evaluate(readCursor)
ck('R-17c', '恢复开启后游标仍合法',
  Number.isFinite(curRe) && curRe >= 0 && curRe <= 12, `M${curRe}`)

await browser.close()

const pass = rows.filter((r) => r.ok).length
if (asJson) {
  console.log(JSON.stringify({ rows, pass, total: rows.length }, null, 2))
} else {
  for (const r of rows) console.log(`${r.ok ? '✓' : '✗'} ${r.id.padEnd(5)} ${r.name.padEnd(30)} ${r.detail}`)
  console.log('='.repeat(74))
  console.log(`通过 ${pass}/${rows.length}${pass === rows.length ? '　✓ 全绿' : '　✗ 有红项'}`)
}
process.exit(pass === rows.length ? 0 : 1)
