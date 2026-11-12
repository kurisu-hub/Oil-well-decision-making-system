#!/usr/bin/env node
/**
 * E3 · 几何 basis 浮标（T09）
 *
 * 断言（对应 P0_验收闸门 E3：「每个几何体带 basis；无依据者不渲染」）：
 *   E3-1  遍历场景 root：每个可渲染叶子（Mesh / InstancedMesh / LineSegments）
 *         的 userData.basis 均为非空字符串 → 缺一条即 FAIL
 *   E3-2  分类覆盖：terrain / skirt / contours / wellhead / wellbore /
 *         fractures / npv-ring / pipes / surface 至少各 1 条且全带 basis
 *   E3-3  L1 井场同样成立（切层级重建后再遍历一次）
 *   E3-4  交互：悬停地形（画布中心）→ .basis-tip 浮标出现且文本非空
 *   E3-5  交互：悬停井口柱（project 取井口坐标）→ 浮标出现且
 *         data-name 以 wellhead-pillars- 开头
 *   E3-6  移出画布 → 浮标消失（不留残影）
 *   E3-7  console error / pageerror = 0
 *
 * 用法：node tools/gate/scene_basis.mjs
 */
import { existsSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

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
const url = pathToFileURL(artifact).href + '#/scene'

let pass = 0
let fail = 0
const ck = (id, name, ok, detail = '') => {
  if (ok) { pass++; console.log(`✓ ${id} ${name.padEnd(34)} PASS  ${detail}`) }
  else { fail++; console.log(`✗ ${id} ${name.padEnd(34)} FAIL  ${detail}`) }
}

const browser = await puppeteer.launch({
  executablePath: exe,
  headless: 'new',
  args: [
    '--allow-file-access-from-files',
    '--enable-unsafe-swiftshader',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--no-sandbox',
  ],
})
const page = await browser.newPage()
await page.setViewport({ width: 1600, height: 1000 })
const errors = []
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
page.on('pageerror', (e) => errors.push(String(e)))

console.log('='.repeat(84))
console.log('E3 · 几何 basis 浮标（T09）· ' + url)
console.log('='.repeat(84))

await page.goto(url, { waitUntil: 'load', timeout: 30000 })
await page.waitForFunction(() => window.__PERF__?.triangles > 0, { timeout: 20000 })
// D-061 装配后资产异步挂载晚于首帧：等三件主角资产（tank / pumpjack / christmas-tree）齐再扫
await page.waitForFunction(
  () => {
    if (!window.__SCENE3D__?.scene) return false
    let tank = false, pump = false, tree = false
    window.__SCENE3D__.scene.traverse((o) => {
      const n = o.userData?.name
      if (n === 'tank-asset') tank = true
      if (n === 'pumpjack-asset') pump = true
      if (n === 'christmas-tree-asset') tree = true
    })
    return tank && pump && tree
  },
  { timeout: 20000 },
)

/** 遍历 scene（含引擎 root 与资产层）：收集可渲染叶子及其 basis（沿父链追溯） */
const scanLeaves = () => page.evaluate(() => {
  const e = window.__SCENE3D__
  if (!e || !e.root) return { ok: false, leaves: [], bad: [] }
  const leaves = []
  const bad = []
  // 扫整个 scene：engine.root 的程序化几何 + 建模资产层挂的 glb（scene.add 直挂）
  // 灯光等非几何对象被 isMesh/isLine 过滤
  e.scene.traverse((o) => {
    const renderable = o.isMesh || o.isInstancedMesh || o.isLine || o.isLineSegments
    if (!renderable) return
    // 只认叶子：自身没有可渲染 child 的才检查（npv-rings 组的环挂在子 inst 上）
    const hasRenderableChild = (o.children || []).some((c) =>
      c.isMesh || c.isInstancedMesh || c.isLine || c.isLineSegments)
    if (hasRenderableChild) return
    // E3 口径：叶子自身或祖先链任一层带非空 basis 即「可追溯」（与引擎 basisAt 同法）
    let b = null
    let n = '(unnamed)'
    let p = o
    while (p) {
      const ud = p.userData
      if (ud) {
        if (b == null && typeof ud.basis === 'string' && ud.basis.trim()) b = ud.basis
        if (n === '(unnamed)' && typeof ud.name === 'string' && ud.name) n = ud.name
      }
      p = p.parent
    }
    const rec = { name: n, basis: typeof b === 'string' ? b : null }
    leaves.push(rec)
    if (!rec.basis) bad.push(rec.name)
  })
  return { ok: true, leaves, bad }
})

/* ---------------- E3-1 遍历：叶子全带 basis ---------------- */
const s0 = await scanLeaves()
ck('E3-1', 'L0 场景叶子几何全带 basis',
   s0.ok && s0.bad.length === 0,
   s0.ok ? `${s0.leaves.length} 个叶子；缺 basis：${s0.bad.join(',') || '无'}` : '__SCENE3D__ 不可用')

/* ---------------- E3-2 分类覆盖 ---------------- */
const CATS = ['terrain', 'skirt', 'contours', 'wellhead', 'wellbore', 'fractures', 'npv-ring', 'pipes', 'surface', 'tank', 'pumpjack', 'ct_']
const byCat = {}
for (const l of s0.leaves ?? []) {
  // tank 类：建模资产层（tank-asset 根 + glb 节点名 tk_static / tk_liquid）
  const c = /^tk_|tank/.test(l.name) ? 'tank' : CATS.find((k) => l.name.startsWith(k))
  if (c) byCat[c] = (byCat[c] ?? 0) + 1
}
const missing = CATS.filter((c) => !byCat[c])
ck('E3-2', '12 类几何各 ≥ 1 且全带 basis（D-061 装配后含 pumpjack / christmas-tree）', missing.length === 0,
   `命中 ${CATS.filter((c) => byCat[c]).map((c) => `${c}:${byCat[c]}`).join(' · ')}${missing.length ? '；缺 ' + missing.join(',') : ''}`)

/* ---------------- E3-3 L1 井场同样成立 ---------------- */
await page.evaluate(() => {
  ;[...document.querySelectorAll('button')].find((b) => b.textContent?.includes('L1'))?.click()
})
await new Promise((r) => setTimeout(r, 1200))
const s1 = await scanLeaves()
ck('E3-3', 'L1 场景叶子几何全带 basis',
   s1.ok && s1.bad.length === 0,
   s1.ok ? `${s1.leaves.length} 个叶子；缺 basis：${s1.bad.join(',') || '无'}` : 'L1 未渲染')
await page.evaluate(() => {
  ;[...document.querySelectorAll('button')].find((b) => b.textContent?.includes('L0'))?.click()
})
await new Promise((r) => setTimeout(r, 1200))

/* ---------------- E3-4 悬停地形 → 浮标出现 ---------------- */
const box = await page.evaluate(() => {
  const cv = document.querySelector('.scene3d .cv')
  const r = cv.getBoundingClientRect()
  return { x: r.x, y: r.y, w: r.width, h: r.height }
})
const cx = box.x + box.w / 2
const cy = box.y + box.h * 0.42 // 略偏上，避开侧栏/井群密集区，落在地形上
await page.mouse.move(cx, cy)
await new Promise((r) => setTimeout(r, 600))
const tip1 = await page.evaluate(() => {
  const t = document.querySelector('.basis-tip')
  return t ? { name: t.dataset.name, text: t.textContent?.trim() ?? '' } : null
})
ck('E3-4', '悬停地形 → basis 浮标出现', !!tip1 && tip1.text.length > 10,
   tip1 ? `[${tip1.name}] ${tip1.text.slice(0, 40)}…` : '浮标未出现')

/* ---------------- E3-5 悬停井口柱 → wellhead basis ---------------- */
const target = await page.evaluate(() => {
  const e = window.__SCENE3D__
  const sorted = e.sceneJSON.wells.slice().sort((a, b) => b.npv - a.npv)
  for (const w of sorted.slice(0, 12)) {
    const p = e.project(w.id)
    if (p) return { id: w.id, x: p.x, y: p.y }
  }
  return null
})
let tip2 = null
if (target) {
  await page.mouse.move(target.x, target.y)
  await new Promise((r) => setTimeout(r, 600))
  tip2 = await page.evaluate(() => {
    const t = document.querySelector('.basis-tip')
    return t ? { name: t.dataset.name, text: t.textContent?.trim() ?? '' } : null
  })
}
ck('E3-5', '悬停井口柱 → wellhead basis',
   !!tip2 && /^wellhead-pillars-/.test(tip2?.name ?? '') && /anchor|棱数/.test(tip2?.text ?? ''),
   tip2 ? `[${tip2.name}] ${tip2.text.slice(0, 40)}…` : `井口未命中（${target?.id ?? '—'}）`)

/* ---------------- E3-6 移出画布 → 浮标消失 ---------------- */
await page.mouse.move(60, 60) // 画布外（左侧栏区域外缘）
await new Promise((r) => setTimeout(r, 400))
const tip3 = await page.evaluate(() => document.querySelector('.basis-tip') === null)
ck('E3-6', '移出画布浮标消失', tip3)

/* ---------------- E3-7 console error = 0 ---------------- */
ck('E3-7', '全程 console error = 0', errors.length === 0,
   errors.length ? errors[0].slice(0, 90) : '0 条')

console.log('='.repeat(84))
console.log(`通过 ${pass}　失败 ${fail}`)
console.log('='.repeat(84))
await browser.close()
process.exit(fail === 0 ? 0 : 1)
