/**
 * P7 五动词验收 · 实机
 *
 * 验：
 *   1. 首页 3 s 内出现 WebGL（A1）
 *   2. 选择：点井 → 决策卡出现（population / p₀ / NPV 区间）
 *   3. 对照：A/B 两口井并排，形状符号不同
 *   4. 下注：3 口 → 期望 vs 实测 + regret
 *   5. 灰度：状态形状冗余（4 种棱数）
 *   6. 五机位各出 1 张图
 *
 * 用法：node tools/p7_check.mjs
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
const OUT = path.join(ROOT, 'tools', 'p7')
fs.mkdirSync(OUT, { recursive: true })

let pass = 0
let fail = 0
const ck = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`✓ ${name.padEnd(42)} PASS  ${detail}`) }
  else { fail++; console.log(`✗ ${name.padEnd(42)} FAIL  ${detail}`) }
}

const browser = await puppeteer.launch({
  executablePath: EDGE,
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
await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 })

const errors = []
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
page.on('pageerror', (e) => errors.push(String(e)))

console.log('='.repeat(84))
console.log('P7 五动词 · 实机验收')
console.log('='.repeat(84))

/* ---------------------------------------------- 1. 首页 3 s 内出 WebGL */
const t0 = Date.now()
await page.goto(`file://${FILE}#/`, { waitUntil: 'load', timeout: 30000 })
const homeMs = Date.now() - t0
const home3d = await page
  .waitForFunction(() => window.__PERF__?.triangles > 0, { timeout: 8000, polling: 100 })
  .then(() => true)
  .catch(() => false)
const homeElapsed = Date.now() - t0
ck('A1 首页 3 s 内出现 WebGL', home3d && homeElapsed < 3000,
   `${homeElapsed} ms（load ${homeMs} ms）`)
await page.screenshot({ path: path.join(OUT, 'home_3d.png') })

/* ------------------------------------------------------------- 2. 选择 */
await page.goto(`file://${FILE}#/scene`, { waitUntil: 'load', timeout: 30000 })
await page.waitForFunction(() => window.__PERF__?.triangles > 0, { timeout: 15000 })

// 找一口在视锥内的井，投影到屏幕再点
const target = await page.evaluate(() => {
  const e = window.__SCENE3D__
  const ids = e.sceneJSON.wells.map((w) => w.id)
  // 选预测 NPV 最高的那口（一定在 C0 框内）
  const sorted = e.sceneJSON.wells.slice().sort((a, b) => b.npv - a.npv)
  for (const w of sorted.slice(0, 12)) {
    const p = e.project(w.id)
    if (p) return { id: w.id, ...p }
  }
  return { id: ids[0], x: null, y: null }
})
ck('可投影到井口坐标', target.x != null, `${target.id} @ ${Math.round(target.x ?? 0)},${Math.round(target.y ?? 0)}`)

await page.mouse.click(target.x, target.y)
await new Promise((r) => setTimeout(r, 1200))
const cardText = await page.evaluate(() => document.body.innerText)
ck('选择：决策卡出现', /决策卡/.test(cardText) && /零产概率/.test(cardText),
   cardText.match(/决策卡[^\n]*/)?.[0] ?? '')
ck('决策卡含 population / p₀ / NPV 区间',
   /事件类型/.test(cardText) && /p₀/.test(cardText) && /NPV 区间/.test(cardText))
await page.screenshot({ path: path.join(OUT, 'verb_select.png') })

/* ------------------------------------------------------------- 3. 对照 */
const clickBtn = async (kw) => {
  await page.evaluate((k) => {
    ;[...document.querySelectorAll('button')].find((b) => b.textContent?.includes(k))?.click()
  }, kw)
  await new Promise((r) => setTimeout(r, 350))
}
const resetCam = async () => {
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => x.textContent?.trim() === 'C0')
    b?.click()
  })
  await new Promise((r) => setTimeout(r, 1000))
}

await clickBtn('对照 A/B')
// 选择动词把相机飞到了井口近景，切模式后必须先回 C0，否则其他井都在框外
await resetCam()

const pickTwo = async () => {
  const pts = await page.evaluate(() => {
    const e = window.__SCENE3D__
    const sorted = e.sceneJSON.wells.slice().sort((a, b) => b.npv - a.npv)
    const out = []
    for (const w of sorted) {
      const p = e.project(w.id)
      if (p) out.push({ id: w.id, ...p })
      if (out.length >= 2) break
    }
    return out
  })
  for (const p of pts) {
    await page.mouse.click(p.x, p.y)
    await new Promise((r) => setTimeout(r, 350))
  }
  return pts
}
/**
 * L0 视距下同 pad 的井只差 5 m，投影到同一像素——连点两次会命中同一口，
 * 表现成"选了又取消"。所以按 14 px 网格去重，挑屏幕上真正分得开的井。
 */
const distinctByPx = async (n) => page.evaluate((count) => {
  const e = window.__SCENE3D__
  const sorted = e.sceneJSON.wells.slice().sort((a, b) => b.npv - a.npv)
  const seen = new Set()
  const out = []
  for (const w of sorted) {
    const p = e.project(w.id)
    if (!p) continue
    const key = `${Math.round(p.x / 14)}:${Math.round(p.y / 14)}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ id: w.id, ...p })
    if (out.length >= count) break
  }
  return out
}, n)

/**
 * 点到够数为止：候选点按屏幕网格去重后逐个点，每点一次读引擎里真实的选中环数
 * （selection rings 的 children 数 = picked.length）。
 * 这样不受「同一像素叠着几口井」影响——点到哪口不重要，重要的是能攒够 N 口。
 */
const clickUntil = async (n) => {
  const cands = await page.evaluate(() => {
    const e = window.__SCENE3D__
    const sorted = e.sceneJSON.wells.slice().sort((a, b) => b.npv - a.npv)
    const seen = new Set()
    const out = []
    for (const w of sorted) {
      const p = e.project(w.id)
      if (!p) continue
      const key = `${Math.round(p.x / 30)}:${Math.round(p.y / 30)}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ id: w.id, ...p })
    }
    return out
  })
  for (const p of cands) {
    const count = await page.evaluate(() => window.__SCENE3D__?.selGroup?.children.length ?? 0)
    if (count >= n) break
    await page.mouse.click(p.x, p.y)
    await new Promise((r) => setTimeout(r, 280))
  }
  return page.evaluate(() => window.__SCENE3D__?.selGroup?.children.length ?? 0)
}

await clickUntil(2)
const cmpText = await page.evaluate(() => document.body.innerText)
// 断言「表格里出现两口不同的井」，而不是「必须是我点的那两口」——
// 同一像素上可能叠着别的井口，raycast 打到哪口都算合法交互。
const cmpIds = await page.evaluate(() => {
  const tr = document.querySelector('.cmp tbody tr')
  if (!tr) return []
  const tds = [...tr.querySelectorAll('td')].map((td) => td.textContent?.trim() ?? '')
  return tds.slice(1, 3)
})
ck('对照：A/B 两列都有井号',
   /对照 A\/B/.test(cmpText) && cmpIds.length === 2 && !!cmpIds[0] && !!cmpIds[1] && cmpIds[0] !== cmpIds[1],
   cmpIds.join(' vs '))
ck('对照：差异用状态符号（▲●■◇）',
   /[▲●■◇]/.test(cmpText) && /预测误差/.test(cmpText))
await page.screenshot({ path: path.join(OUT, 'verb_compare.png') })

/* ------------------------------------------------------------- 4. 下注 */
await clickBtn('下注 3 口')
await resetCam()
await clickUntil(3)
await new Promise((r) => setTimeout(r, 600))
const betText = await page.evaluate(() => document.body.innerText)
const hasSettle = /下注结算/.test(betText) && /期望（Σ 点估计）/.test(betText)
ck('下注：结算面板出现 期望 vs 实测', hasSettle && /实测（事后）/.test(betText))
ck('下注：显示 regret 与 oracle', /oracle 上界/.test(betText) && /regret/.test(betText))

const settle = await page.evaluate(() => {
  const grab = (label) => {
    const dts = [...document.querySelectorAll('dt')]
    for (const dt of dts) {
      if (dt.textContent?.trim() === label) {
        const v = dt.nextElementSibling?.textContent?.trim() ?? ''
        return Number(v.replace(/[^\d.\-]/g, ''))
      }
    }
    return null
  }
  return {
    npv: grab('期望（Σ 点估计）'),
    realized: grab('实测（事后）'),
    oracle: grab('oracle 上界'),
    regret: grab('regret'),
  }
})
const regretOk =
  settle.regret != null && settle.oracle != null && settle.realized != null &&
  Math.abs(settle.regret - (settle.oracle - settle.realized)) < 1.5
ck('下注：regret = oracle − 实测（自洽）', regretOk, JSON.stringify(settle))
await page.screenshot({ path: path.join(OUT, 'verb_bet.png') })

/* --------------------------------------------------------- 5. 形状冗余 */
const shapes = await page.evaluate(() => {
  const e = window.__SCENE3D__
  const out = {}
  e.root.children.forEach((c) => {
    if (c.isInstancedMesh && c.geometry?.parameters?.radialSegments != null) {
      const r = c.geometry.parameters.radialSegments
      out[r] = (out[r] ?? 0) + c.count
    }
  })
  return out
})
const segKeys = Object.keys(shapes).map(Number).sort((a, b) => a - b)
ck('状态用 4 种棱数（灰度可辨）', segKeys.length >= 4,
   `径向段数 ${segKeys.join(' / ')}，实例 ${Object.values(shapes).join(' / ')}`)

// 灰度截图：只用于人工目检，断言在上述代码层
await page.evaluate(() => {
  document.documentElement.style.filter = 'grayscale(1)'
})
await new Promise((r) => setTimeout(r, 500))
await page.screenshot({ path: path.join(OUT, 'grayscale.png') })
await page.evaluate(() => {
  document.documentElement.style.filter = ''
})

/* --------------------------------------------------------- 6. 五机位 */
const SHOTS = [
  ['C0', 'L0'], ['C1', 'L1'], ['C2', 'L1'], ['C3', 'L1'], ['C4', 'L1'],
]
for (const [cam, lvl] of SHOTS) {
  if (lvl === 'L1') {
    await page.evaluate(() => {
      ;[...document.querySelectorAll('button')].find((b) => b.textContent?.includes('L1'))?.click()
    })
    await new Promise((r) => setTimeout(r, 900))
  } else {
    await page.evaluate(() => {
      ;[...document.querySelectorAll('button')].find((b) => b.textContent?.includes('L0'))?.click()
    })
    await new Promise((r) => setTimeout(r, 900))
  }
  await page.evaluate((c) => {
    const b = [...document.querySelectorAll('button')].find((x) => x.textContent?.trim() === c)
    b?.click()
  }, cam)
  await new Promise((r) => setTimeout(r, 1100))
  await page.screenshot({ path: path.join(OUT, `cam_${cam}.png`) })
}
const files = fs.readdirSync(OUT).filter((f) => f.startsWith('cam_'))
ck('五机位各出 1 张图', files.length === 5, files.join(' '))

ck('全程 console error = 0', errors.length === 0, errors.length ? errors[0].slice(0, 80) : '0 条')

console.log('='.repeat(84))
console.log(`通过 ${pass}　失败 ${fail}`)
console.log(`图：${path.relative(ROOT, OUT)}/`)
console.log('='.repeat(84))
await browser.close()
process.exit(fail === 0 ? 0 : 1)
