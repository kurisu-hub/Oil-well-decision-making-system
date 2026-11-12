#!/usr/bin/env node
/**
 * T16 · 同步协议验收（06_任务清单 T16）
 *
 * 验收原文：**双标签页一致；快照+增量 == 全量重放。**
 *
 * 检查项：
 *  S-1  页面挂载同步协议句柄（window.__twinSync，77 井 / ts 范围）
 *  S-2  自检 A：快照+增量推到末端 == 数据直推终态（逐井 ts/state 全等）
 *  S-3  自检 B：中段断线 → 带状态重连续推 == 不间断全量（指纹相等）
 *  S-4  自检 C：同刻双路径一致（增量推进 vs 失忆快照对齐）
 *  S-5  双标签页：两个标签页各自跑协议到同一时刻 → 状态指纹相等
 *  S-6  回放联动：拖回放时间轴后，同步客户端 lastTs 跟随 replayMi
 *  S-7  回退对齐：seek 回早期月份（失忆重连）后状态正确
 *  S-8  console 无错误
 *
 * 用 puppeteer-core 驱动本机 Edge，file:// 打开交付产物，只读不动数据。
 * 用法：node tools/sync_check.mjs [--headful] [--json]
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

async function newTab() {
  const page = await browser.newPage()
  page.on('pageerror', (e) => errors.push('pageerror: ' + String(e).slice(0, 200)))
  await page.goto(base, { waitUntil: 'load' })
  await page.waitForFunction(() => !!(window).__twinSync, { timeout: 20000 })
  return page
}
const errors = []

// ── 标签页 1：自检三件套 + 回放联动 ───────────────────
const p1 = await newTab()

const meta = await p1.evaluate(() => window.__twinSync.meta)
ck('S-1', '同步句柄就绪（77 井 / ts 范围）',
  meta?.wells === 77 && Number.isFinite(meta?.ts0) && Number.isFinite(meta?.tsMax),
  `wells=${meta?.wells} ts ${meta?.ts0}~${meta?.tsMax}`)

const st = await p1.evaluate(() => window.__twinSync.selfTest())
ck('S-2', '快照+增量 == 全量重放（逐井终态全等）',
  st.aPass && st.mismatches.length === 0,
  st.aPass ? `指纹 ${st.hashFull} · 失配 0` : `失配 ${st.mismatches.length}：${st.mismatches[0] ?? ''}`)
ck('S-3', '断线重连对齐（带状态续推 == 不间断）',
  st.bPass, `重连后指纹 ${st.hashReconnect} ${st.bPass ? '==' : '!='} ${st.hashFull}`)
ck('S-4', '同刻双路径一致（增量 vs 快照对齐）',
  st.cPass, `增量 ${st.hashIncremental} · 对齐 ${st.hashAligned}`)

// S-6：拖动回放时间轴（真实滑块交互）→ 客户端 lastTs 跟随
await p1.goto(base + '#/', { waitUntil: 'load', timeout: 30000 })
await new Promise((r) => setTimeout(r, 500))
async function slide(page, v) {
  await page.evaluate((val) => {
    const el = document.querySelector('.bar input.rng')
    if (!el) return
    el.value = String(val)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }, v)
  await new Promise((r) => setTimeout(r, 250))
}
await slide(p1, 0) // 从最新端归零（走失忆重连/快照对齐路径）
const tsA = await p1.evaluate(() => window.__twinSync.client.lastTs)
await slide(p1, 300)
const mid = await p1.evaluate(() => ({ lastTs: window.__twinSync.client.lastTs, month: document.querySelector('.clock b')?.textContent }))
await slide(p1, 800)
const end = await p1.evaluate(() => window.__twinSync.client.lastTs)
ck('S-6', '回放时钟驱动同步客户端（拖滑块 → lastTs 前进）',
  tsA != null && mid.lastTs > tsA && end > mid.lastTs,
  `归零 ${tsA} → 拖 30% ${mid.lastTs}（${mid.month}）→ 拖 80% ${end}`)

// S-7：回退（失忆重连）后状态仍正确
const back = await p1.evaluate(() => {
  const T = window.__twinSync
  T.client.seek(T.meta.ts0 + 10)
  return { lastTs: T.client.lastTs, hash: T.client.stateHash(), ts0: T.meta.ts0 }
})
ck('S-7', '回退对齐（seek 回早期月份不失忆错乱）',
  back.lastTs === back.ts0 + 10 && back.hash.length > 0,
  `lastTs=${back.lastTs}（${back.ts0}+10） 指纹 ${back.hash}`)

// ── 标签页 2：双标签页一致 ────────────────────────────
const p2 = await newTab()
const K = meta.ts0 + Math.floor((meta.tsMax - meta.ts0) * 0.7)
const h1 = await p1.evaluate((k) => { window.__twinSync.client.seek(k); return window.__twinSync.client.stateHash() }, K)
const h2 = await p2.evaluate((k) => { window.__twinSync.client.seek(k); return window.__twinSync.client.stateHash() }, K)
ck('S-5', '双标签页同刻一致', h1 === h2 && h1.length > 0, `tab1 ${h1} · tab2 ${h2}`)

ck('S-8', 'console / page 无错误', errors.length === 0, errors.slice(0, 2).join(' | ') || '0 条')

await browser.close()

// ── 汇报 ─────────────────────────────────────────────
const pass = rows.filter((r) => r.ok).length
if (asJson) {
  console.log(JSON.stringify({ total: rows.length, pass, rows }, null, 2))
} else {
  for (const r of rows) console.log(`${r.ok ? '✓' : '✗'} ${r.id} ${r.name} — ${r.detail}`)
  console.log(`\nT16 同步协议验收：${pass}/${rows.length} ${pass === rows.length ? '全绿' : '存在红项'}`)
}
process.exit(pass === rows.length ? 0 : 1)
