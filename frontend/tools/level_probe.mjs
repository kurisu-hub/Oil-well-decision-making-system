/**
 * level_probe.mjs · T08 液位接线端到端验证（真实引擎 + 真实资产运行层）
 *
 * 链路：Scene3DEngine.init → setScene(合成 SceneJSON) → attachTank(glb 内联)
 *       → setSiteOil(全站日产油) → tk_liquid 实测 scale/position
 *
 * 判据（任一不过即 FAIL）：
 *   1. attachTank 成功且拿到 pa_id（glb extras → sidecar 同键）
 *   2. setSiteOil(44.06) → 液位 pct = levelFromSiteOil(44.06)（±0.001），底边钉在罐底
 *   3. setSiteOil(100) → pct 变大（数据变 → 液位动，不是静态贴图）
 *   4. 引擎 perf 正常出数（资产挂进冻结引擎后没有把渲染搞挂）
 *
 * 用法：node tools/level_probe.mjs --out <shot.png> [--glb <tank.glb>]
 */
import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import * as esbuild from 'esbuild'

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const PORT = 9347

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`)
  return i > 0 ? process.argv[i + 1] : def
}

// import.meta.url 的 pathname 是百分号编码的（工创最终版 → %E5...），
// 不 decode 的话所有派生路径全部 ENOENT（第一次跑就栽在这）
const frontendRoot = resolve(
  decodeURIComponent(new URL('..', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1')),
)
const glbPath = resolve(arg('glb', join(frontendRoot, 'src/assets/tank_lod0.glb')))
const outPath = resolve(arg('out', 'level_probe.png'))
const W = Number(arg('w', 1280))
const H = Number(arg('h', 800))
const workDir = resolve(arg('work', './.levelprobe'))
mkdirSync(workDir, { recursive: true })

// 被测 TS 源码先拷进 ASCII 探针目录：esbuild 对中文绝对路径的 import 说明符
// 会做百分号编码后无法解析（实测踩过），相对路径 + ASCII 目录是稳的。
const srcSnap = join(workDir, 'src')
mkdirSync(srcSnap, { recursive: true })
for (const f of ['engine.ts', 'camera.ts', 'assetRuntime.ts', 'tankLevel.ts', 'lighting.ts', 'pumpjackRig.ts', 'kinematics.ts']) {
  // 不用 cpSync：fs shim 对部分目标路径会抛 ESRCH；read/write 全程没出过问题
  writeFileSync(join(srcSnap, f), readFileSync(join(frontendRoot, 'src/three', f)))
}

const ENTRY_JS = `
import * as THREE from 'three'
import { Scene3DEngine } from './src/engine.ts'
import { attachTank, TANK_LIQ } from './src/assetRuntime.ts'
import { levelFromSiteOil, TANK_GAUGE_LIQ } from './src/tankLevel.ts'
import { buildLighting } from './src/lighting.ts'

const out = { steps: [], ok: false }
const log = (step, data) => out.steps.push({ step, ...data })

async function run() {
  const canvas = document.getElementById('c')
  const engine = new Scene3DEngine()
  const r = engine.init(canvas)
  log('init', { tier: r.tier, ms: r.ms })

  // 合成 SceneJSON：结构同 buildScene 产物（两个 pad 四口井），坐标刻意拉开
  const wells = [
    { id: 'W1', x: -30, z: -18, anchor: 6.2, md: 2200, state: 'green', pred: Array(12).fill(4), base: Array(12).fill(5), actual: Array(12).fill(3.6), npv: 800, padId: 'P1' },
    { id: 'W2', x: -24, z: -12, anchor: 4.1, md: 2100, state: 'yellow', pred: Array(12).fill(3), base: Array(12).fill(4), actual: Array(12).fill(2.5), npv: 400, padId: 'P1' },
    { id: 'W3', x: 28, z: 16, anchor: 2.0, md: 2400, state: 'red', pred: Array(12).fill(1), base: Array(12).fill(2), actual: Array(12).fill(0.8), npv: 100, padId: 'P2' },
    { id: 'W4', x: 34, z: 22, anchor: 3.3, md: 2300, state: 'green', pred: Array(12).fill(2), base: Array(12).fill(3), actual: Array(12).fill(1.9), npv: 300, padId: 'P2' },
  ]
  const sceneJSON = {
    version: '1.0', tier: r.tier, level: 'L0',
    extent: { x: [-60, 60], z: [-60, 60] },
    wells,
    pads: [
      { id: 'P1', cx: -27, cz: -15, wellIds: ['W1', 'W2'], span: 20, pred: 7 },
      { id: 'P2', cx: 31, cz: 19, wellIds: ['W3', 'W4'], span: 20, pred: 3 },
    ],
    pipes: [{ from: 'P1', to: 'P2' }],
    surface: { rows: 8, cols: 8, grid: Array(64).fill(0.02) },
    basis: { fracHalfMaxM: 200, fracBasis: 'probe', wellheadBasis: 'probe', terrainBasis: 'probe', verticalExaggeration: 1 },
  }
  engine.setScene(sceneJSON)
  log('setScene', { done: true })

  // 挂储罐（glb 以 data URI 进来 —— 与单文件内联同路径）
  const tankUrl = 'data:model/gltf-binary;base64,' + window.__TANK_B64__
  const tank = await attachTank(engine, { url: tankUrl, position: [0, 0, 68] })
  log('attachTank', { id: tank.id, liquidFound: true })

  const readLiquid = () => {
    const node = engine.getScene().getObjectByName('tk_liquid')
    return { sy: node.scale.y, py: node.position.y }  // 不取整：verdict 容差 1e-6 级，取整会假失败
  }
  // D-054：磁翻板立管液柱（tk_gauge_liquid），与罐内液位同 pct
  const readGauge = () => {
    const node = engine.getScene().getObjectByName('tk_gauge_liquid')
    if (!node) return null
    return { sy: node.scale.y, py: node.position.y }
  }
  const gaugeHeightM = (g) => (g ? g.sy * (TANK_GAUGE_LIQ.top - TANK_GAUGE_LIQ.base) : -1)

  // 判据 2：全站 44.06 m³/d（bundle 实测口径）
  tank.setSiteOil(44.06)
  engine.getScene().updateMatrixWorld(true)
  const l1 = readLiquid()
  const g1 = readGauge()
  const want1 = levelFromSiteOil(44.06)
  log('siteOil44', { liquid: l1, gauge: g1, wantPct: +want1.toFixed(4), tankInfo: tank.info() })

  // 判据 3：产量变大 → 液位升
  tank.setSiteOil(100)
  engine.getScene().updateMatrixWorld(true)
  const l2 = readLiquid()
  const want2 = levelFromSiteOil(100)
  log('siteOil100', { liquid: l2, wantPct: +want2.toFixed(4), tankInfo: tank.info() })

  // 诊断：两种液位下的实测世界包围盒（液面顶）
  const bb = new THREE.Box3().setFromObject(engine.getScene().getObjectByName('tk_liquid'))
  log('liquidBBox', { min: bb.min.toArray().map((v) => +v.toFixed(3)), max: bb.max.toArray().map((v) => +v.toFixed(3)) })

  const perf = engine.getPerf()
  log('perf', perf)

  // T07 光照 rig 狗粮：H-011 说的「阿墨接 engine」就是这个接法（此处探针代接）
  const lightRig = buildLighting(engine.getScene(), 'B')
  // 不调 rig.update(camera)：那需要真实 THREE.Camera（阴影盒跟随相机）。
  // 探针里太阳 target 默认原点，合成场景够用；正式接入由阿墨在每帧传 engine 相机。

  // 相机推到罐前（走冻结 API setCamera，Pose 直传），出可视化证据帧。
  // 注意 OrbitControls maxPolarAngle=67.4°：极角超限会被 update() 压平贴地穿裙边（实测踩过）
  engine.setCamera({ pos: [16, 20, 94], target: [0, 4, 68], fov: 35 })
  // 诊断：setCamera 后相机实际落点（绕过 TS private，运行时直读 __SCENE3D__）
  const dbgCam = window.__SCENE3D__
  log('camAfterSet', dbgCam ? {
    pos: dbgCam.camera.position.toArray().map((v) => +v.toFixed(1)),
    tgt: dbgCam.controls ? dbgCam.controls.target.toArray().map((v) => +v.toFixed(1)) : null,
    fov: dbgCam.camera.fov,
  } : 'no __SCENE3D__')
  engine.setScene(sceneJSON)   // 重建一次，模拟「setScene 后资产仍在」（tank 挂在 scene 而非 root）
  const after = readLiquid()
  const gAfter = readGauge()
  log('liquidSurvivesSetScene', { liquid: after, gauge: gAfter, unchanged: Math.abs(after.sy - l2.sy) < 1e-9 })
  await new Promise((res) => setTimeout(res, 300))

  out.verdict = {
    attachOk: !!tank.id && tank.id !== 'TK-UNKNOWN',
    pct1: Math.abs(l1.sy - want1) < 0.001,
    bottomPinned1: Math.abs(l1.sy * TANK_LIQ.base + l1.py - TANK_LIQ.base) < 1e-6,
    pct2: Math.abs(l2.sy - want2) < 0.001,
    rises: l2.sy > l1.sy,
    survives: Math.abs(after.sy - l2.sy) < 1e-9,
    perfOk: perf.triangles > 0,
    // ---- D-054 验收：立管液柱高度 ÷ 立管量程 == setTankLevel 入参 pct，容差 ≤ 0.01，setScene 重建后仍成立 ----
    gaugeFound: !!g1,
    gaugePct: !!g1 && Math.abs(gaugeHeightM(g1) / (TANK_GAUGE_LIQ.top - TANK_GAUGE_LIQ.base) - l1.sy) <= 0.01,
    gaugeBottomPinned: !!g1 && Math.abs(g1.sy * TANK_GAUGE_LIQ.base + g1.py - TANK_GAUGE_LIQ.base) < 1e-6,
    gaugeSurvives: !!gAfter && Math.abs(gAfter.sy - l2.sy) <= 0.01,  // setScene 前最后设的是 100 → 0.98，存活即仍为 0.98
  }
  out.ok = Object.values(out.verdict).every(Boolean)
  window.__LEVEL_INFO__ = out
}

run().catch((e) => { window.__LEVEL_INFO__ = { ok: false, fatal: String(e && e.stack || e) } })
`

const bundle = await esbuild.build({
  stdin: { contents: ENTRY_JS, resolveDir: workDir, loader: 'js', sourcefile: 'entry.js' },
  bundle: true,
  format: 'iife',
  minify: false,
  write: false,
  target: ['es2020'],
})
const js = bundle.outputFiles[0].text

const b64 = readFileSync(glbPath).toString('base64')
const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
html,body{margin:0;height:100%;background:#10151a;overflow:hidden}
canvas{display:block;width:100%;height:100%}
</style></head><body>
<canvas id="c"></canvas>
<script>window.__TANK_B64__="${b64}"</script>
<script>${js}</script>
</body></html>`

// 带时间戳：同名 HTML 会命中 Edge disk cache，读到上一轮的 __LEVEL_INFO__（glb_probe 踩过）
const htmlPath = join(workDir, `level_${Date.now()}.html`)
writeFileSync(htmlPath, html, 'utf8')
console.log(`[probe] html ${(html.length / 1024 / 1024).toFixed(2)} MB → ${htmlPath}`)

const profile = mkdtempSync(join(tmpdir(), 'edge-lv-'))
const proc = spawn(EDGE, [
  '--headless=new', '--no-first-run', '--no-default-browser-check',
  '--enable-unsafe-swiftshader', '--use-angle=swiftshader',
  '--disable-features=Translate,BackForwardCache',
  `--window-size=${W},${H}`,
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  'about:blank',
], { stdio: 'ignore' })

function cleanup() {
  try { proc.kill() } catch {}
  try { rmSync(profile, { recursive: true, force: true }) } catch {}
}

async function waitPort() {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`)
      if (r.ok) {
        const list = await r.json()
        const page = list.find((t) => t.type === 'page')
        if (page?.webSocketDebuggerUrl) return page
      }
    } catch {}
    await sleep(250)
  }
  throw new Error('Edge 调试端口未就绪')
}

let msgId = 0
function mkClient(ws) {
  const pending = new Map()
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.id && pending.has(msg.id)) {
      const { resolve: res, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : res(msg.result)
    }
  })
  return (method, params = {}) =>
    new Promise((res, reject) => {
      const id = ++msgId
      pending.set(id, { resolve: res, reject })
      ws.send(JSON.stringify({ id, method, params }))
    })
}

let exitCode = 0
try {
  const page = await waitPort()
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej) })
  const send = mkClient(ws)

  await send('Page.enable')
  await send('Runtime.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false })

  await send('Page.navigate', { url: 'file:///' + htmlPath.replace(/\\/g, '/') })
  await sleep(6000)

  const evalRes = await send('Runtime.evaluate', {
    expression: 'JSON.stringify(window.__LEVEL_INFO__ || null)',
    returnByValue: true,
  })
  const info = JSON.parse(evalRes.result.value || 'null')
  console.log('\n===== LEVEL_PROBE_INFO =====')
  console.log(JSON.stringify(info, null, 2))
  console.log('===== END =====')

  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, Buffer.from(shot.data, 'base64'))
  console.log(`[probe] shot → ${outPath}`)

  if (!info?.ok) exitCode = 1
  ws.close()
} catch (e) {
  console.error('[probe] failed:', e.message)
  exitCode = 3
} finally {
  cleanup()
}
process.exit(exitCode)
