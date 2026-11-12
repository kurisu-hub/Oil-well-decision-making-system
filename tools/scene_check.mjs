/**
 * P6 实机验证 · three.js 场景
 *
 * 验四个东西（都是闸门验不了的）：
 *   1. file:// 下 WebGL 能否起来（E1 的核心风险）
 *   2. 首帧时长 + 三角面数（A1：≥50k）
 *   3. 连续帧率（Tier A ≥60 / Tier B ≥30）
 *   4. 反复 init/dispose 是否泄漏 WebGL context（10 次）
 *
 * 用法：node tools/scene_check.mjs
 */
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const req = createRequire(path.join(ROOT, 'frontend', 'package.json'))
const puppeteer = req('puppeteer-core')

const EDGE = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
].find((p) => fs.existsSync(p))

const FILE = path.join(ROOT, 'release', 'index.html').replace(/\\/g, '/')
const OUT = path.join(ROOT, 'tools', 'scene')
fs.mkdirSync(OUT, { recursive: true })

let pass = 0
let fail = 0
const ck = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`✓ ${name.padEnd(40)} PASS  ${detail}`) }
  else { fail++; console.log(`✗ ${name.padEnd(40)} FAIL  ${detail}`) }
}

const browser = await puppeteer.launch({
  executablePath: EDGE,
  headless: 'new',
  args: [
    '--allow-file-access-from-files',
    '--enable-unsafe-swiftshader',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--window-size=1440,900',
    '--no-sandbox',
  ],
})

const page = await browser.newPage()
await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 })

const errors = []
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
page.on('pageerror', (e) => errors.push(String(e)))

console.log('='.repeat(80))
console.log('P6 三维场景 · 实机验证（file:// + WebGL）')
console.log('='.repeat(80))

const t0 = Date.now()
await page.goto(`file://${FILE}#/scene`, { waitUntil: 'load', timeout: 30000 })
const loadMs = Date.now() - t0

// 等 WebGL 起来
const ok = await page.waitForFunction(
  () => {
    const p = window.__PERF__
    return !!p && p.triangles > 0
  },
  { timeout: 15000, polling: 100 },
).then(() => true).catch(() => false)

ck('file:// 下 WebGL 可启动', ok, `加载 ${loadMs} ms`)
if (!ok) {
  const txt = await page.evaluate(() => document.body.innerText.slice(0, 300))
  console.log('  页面文本：', txt.replace(/\s+/g, ' '))
  await browser.close()
  process.exit(1)
}

const first = await page.evaluate(() => window.__PERF__)
ck('三角面 ≥ 50k（A1）', first.triangles >= 50000,
   `${first.triangles.toLocaleString()} 三角 · ${first.drawCalls} draw call · Tier ${first.tier}`)

// 采样 3 秒帧率（在截图之前采——headless swiftshader 下 screenshot 会拖垮滚动均值，
// 旧版把采样放在 3 次截图后，测出来的是截图开销不是场景帧率）
await new Promise((r) => setTimeout(r, 3000))
const s1 = await page.evaluate(() => window.__PERF__)
await new Promise((r) => setTimeout(r, 3000))
const s2 = await page.evaluate(() => window.__PERF__)
const fpsNow = s2.fps
// D-043 口径：fps 判定权归 BOARD §1-B 档位表（默认档 🟢 38.2 / Tier A 全开 ⚠️ 不可演示），
// 真机 ≥60 归 T19（需独显）。本脚本跑在 headless swiftshader 上，数值只作环境参考，不判 PASS/FAIL——
// 静默放宽或静默判红都不诚实，改为 WARN 登记。
console.log(`⚠ WARN  帧率参考（swiftshader，不判定）      ${fpsNow} fps · Tier ${s2.tier}（判定见 §1-B 档位 / T19 实机）`)

// 截图（L0）
await page.screenshot({ path: path.join(OUT, 'L0_region.png') })

// 切到 L1
await page.evaluate(() => {
  const btns = [...document.querySelectorAll('button')].filter((b) => b.textContent?.includes('L1'))
  btns[0]?.click()
})
await new Promise((r) => setTimeout(r, 1500))
const l1 = await page.evaluate(() => window.__PERF__)
await page.screenshot({ path: path.join(OUT, 'L1_pad.png') })
ck('L1 井场可切换并渲染', l1.triangles > 0,
   `${l1.triangles.toLocaleString()} 三角 · level ${l1.level}`)

// 机位切换 + t 联动
await page.evaluate(() => {
  const b = [...document.querySelectorAll('button')].find((x) => x.textContent?.trim() === 'C2')
  b?.click()
})
await new Promise((r) => setTimeout(r, 900))
await page.screenshot({ path: path.join(OUT, 'L1_wellbore.png') })

// 注意：Vue 的 DOM 更新是异步的（nextTick）。设完值立刻读会读到旧文本，
// 之前就因此误判「联动没生效」。这里每次设值后等两帧再读。
const setAndRead = async (v) => {
  await page.evaluate((val) => {
    // 推演滑杆 = SceneView 的 range max=12（class 同名 input.rng 有两个：
    // T01 回放条的比例滑杆 max=1000 排在 DOM 前面，抓 class 会误抓——
    // 设 3/12 都落在数据集开头 → t 恒 0（本轮红条根因）。用 max=12 钉死。
    const r = document.querySelector('input[type=range][max="12"]')
    r.value = String(val)
    r.dispatchEvent(new Event('input', { bubbles: true }))
  }, v)
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
  return page.evaluate(() => [...document.querySelectorAll('dd')].slice(0, 3).map((d) => d.textContent))
}
const a = await setAndRead(3)
const b = await setAndRead(12)
const linkage = { a, b }
ck('t 联动（三个返回值同时变）',
   JSON.stringify(a) !== JSON.stringify(b),
   `t=3 ${a.join(' / ')} → t=12 ${b.join(' / ')}`)

// dispose 泄漏：进出 10 次
const before = errors.length
for (let i = 0; i < 10; i++) {
  await page.goto(`file://${FILE}#/`, { waitUntil: 'load' })
  await page.goto(`file://${FILE}#/scene`, { waitUntil: 'load' })
  await page.waitForFunction(() => window.__PERF__?.triangles > 0, { timeout: 12000, polling: 100 })
    .catch(() => {})
}
const newErr = errors.slice(before)
const leak = newErr.filter((e) => /context|Too many|WEBGL_lose/i.test(e))
ck('10 次 init/dispose 无 context 泄漏', leak.length === 0,
   leak.length ? leak[0].slice(0, 90) : `新增错误 ${newErr.length} 条`)

ck('全程 console error = 0', errors.length === 0,
   errors.length ? errors[0].slice(0, 90) : '0 条')

console.log('='.repeat(80))
console.log(`通过 ${pass}　失败 ${fail}`)
console.log(`截图：${path.relative(ROOT, OUT)}/L0_region.png · L1_pad.png · L1_wellbore.png`)
console.log('='.repeat(80))

await browser.close()
process.exit(fail === 0 ? 0 : 1)
