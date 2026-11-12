/**
 * lighting_probe.mjs · T07 验收（D-007 两条判据）
 *
 * 判据一：日轨 / 级联阴影 / SSAO / Bloom / 体积雾 五项各有独立开关，且能单独关闭
 * 判据二：同一场景软件渲染 fps_after ≥ 34
 *
 * 做法：在 headless Edge（SwiftShader 软件光栅）里搭一个三件资产的井场，
 * 先测 baseline（只有环境光 + 单方向光，无阴影无后处理），再测 Tier B 默认配置，
 * 然后逐项关闭拍图 + 记录 fps。
 *
 * 用法（在装了 three/esbuild 的目录下跑）：
 *   node lighting_probe.mjs --assets <assets 目录> --out <截图目录> --src <src/three 目录>
 */
import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import * as esbuild from 'esbuild'

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const PORT = 9353

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`)
  return i > 0 ? process.argv[i + 1] : d
}

const assetsDir = resolve(arg('assets'))
const outDir = resolve(arg('out', './lighting_shots'))
const srcDir = resolve(arg('src'))
const W = Number(arg('w', 1280))
const H = Number(arg('h', 800))
const workDir = resolve(arg('work', './.lightprobe'))
const SAMPLE_MS = Number(arg('sample', 2200))

mkdirSync(outDir, { recursive: true })
mkdirSync(workDir, { recursive: true })

const need = ['pumpjack_lod1.glb', 'christmas_tree_lod1.glb', 'tank_lod1.glb']
for (const f of need) {
  if (!existsSync(join(assetsDir, f))) { console.error(`缺少 ${f}`); process.exit(2) }
}

const b64 = Object.fromEntries(
  need.map((f) => [f, readFileSync(join(assetsDir, f)).toString('base64')]),
)

const p = (f) => join(srcDir, f).replace(/\\/g, '/')

const ENTRY = `
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { buildLighting, sunDirection } from '${p('lighting.ts')}'
import { buildPostFX } from '${p('postfx.ts')}'

const W = ${W}, H = ${H}
const SUN_DBG = ${JSON.stringify(process.env.SUN_DBG || '')}
const canvas = document.getElementById('c')
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true })
renderer.setPixelRatio(1)
renderer.setSize(W, H, false)
renderer.outputColorSpace = THREE.SRGBColorSpace
renderer.toneMapping = THREE.ACESFilmicToneMapping
renderer.toneMappingExposure = 1.0

const scene = new THREE.Scene()
scene.background = new THREE.Color(0x0b1014)

const camera = new THREE.PerspectiveCamera(40, W / H, 0.5, 3000)
// 相机必须站在受光面：太阳在西南（14:12，方位 224°），从东南看就是背光面，整片黑
camera.position.set(-30, 17, 44)
camera.lookAt(2, 3.5, -2)

const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(600, 600),
  // 干燥砂石地典型反照率 0.2–0.3（sRGB ≈ 0x5a），此前 0x23241f 是沥青级别的黑
  new THREE.MeshStandardMaterial({ color: 0x57523f, roughness: 0.96 }),
)
ground.rotation.x = -Math.PI / 2
ground.receiveShadow = true
scene.add(ground)

const loader = new GLTFLoader()
const parse = (b64) => new Promise((res, rej) => {
  const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
  loader.parse(bin.buffer, '', (g) => res(g.scene), rej)
})

async function setup() {
  const [pj, ct, tk] = await Promise.all([
    parse(window.__B64__['pumpjack_lod1.glb']),
    parse(window.__B64__['christmas_tree_lod1.glb']),
    parse(window.__B64__['tank_lod1.glb']),
  ])
  for (const o of [pj, ct, tk]) o.traverse((m) => { if (m.isMesh) { m.castShadow = true; m.receiveShadow = true } })

  pj.position.set(0, 0, 0)
  scene.add(pj)
  for (let i = 0; i < 3; i++) {
    const c = ct.clone(true)
    c.position.set(8 + i * 2.4, 0, -3 - i * 2.2)
    scene.add(c)
  }
  tk.position.set(-17, 0, 9)
  scene.add(tk)

  window.__READY__ = true
}

// ---- baseline 光照：等价于 P6 现状（半球光 + 单方向光，无阴影）----
function buildBaseline() {
  const hemi = new THREE.HemisphereLight(0xa8bccb, 0x1a2026, 1.25)
  scene.add(hemi)
  const dir = new THREE.DirectionalLight(0xffe9cf, 0.85)
  dir.position.set(-420, 860, 580)
  scene.add(dir)
  return { hemi, dir }
}

let baseline = null
let lightRig = null
let fx = null

function clearLights() {
  if (baseline) { scene.remove(baseline.hemi); scene.remove(baseline.dir); baseline = null }
  if (lightRig) { lightRig.dispose(); lightRig = null }
  if (fx) { fx.dispose(); fx = null }
}

function renderOnce() {
  if (fx && fx.enabled) fx.render()
  else renderer.render(scene, camera)
}

function measure(ms) {
  return new Promise((res) => {
    let n = 0
    const t0 = performance.now()
    const loop = () => {
      renderOnce()
      n++
      const dt = performance.now() - t0
      if (dt < ms) requestAnimationFrame(loop)
      else res({ fps: +(n / (dt / 1000)).toFixed(1), frames: n, ms: Math.round(dt) })
    }
    requestAnimationFrame(loop)
  })
}

window.__run__ = async () => {
  const out = { baseline: null, tierB: null, matrix: [], toggle: {} }

  // 1) baseline
  clearLights()
  baseline = buildBaseline()
  await measure(300)          // 预热
  out.baseline = await measure(${SAMPLE_MS})

  // 2) Tier B 默认配置（阴影/后处理应自动关闭）
  clearLights()
  const dbg = SUN_DBG ? Number(SUN_DBG) : null
  if (dbg) console.log('[sun dbg] elevation/azimuth =', JSON.stringify(sunDirection(40.35, 268, 14.2)))
  lightRig = buildLighting(scene, 'B', dbg ? { sun: { intensity: dbg } } : undefined)
  fx = buildPostFX(renderer, scene, camera, 'B')
  lightRig.update(camera)
  await measure(300)
  out.tierB = await measure(${SAMPLE_MS})
  out.toggle = { ...lightRig.getEnabled(), ...fx.getEnabled(), postfxActive: fx.enabled }

  // 3) 五项逐个关闭：每次重建光照，拍图（Tier B 下后处理不激活，所以用 force 验证开关逻辑）
  const keys = ['sun', 'shadow', 'ambient', 'fog']
  const pkeys = ['ssao', 'bloom', 'volumetricFog']
  for (const k of keys) {
    lightRig.setEnabled(k, false)
    lightRig.update(camera)
    renderOnce()
    out.matrix.push({ key: k, label: 'light.' + k, off: true, enabled: lightRig.getEnabled()[k] })
    lightRig.setEnabled(k, true)
  }
  for (const k of pkeys) {
    fx.setEnabled(k, false)
    out.matrix.push({ key: k, label: 'postfx.' + k, off: true, enabled: fx.getEnabled()[k] })
    fx.setEnabled(k, true)
  }
  lightRig.update(camera)
  renderOnce()

  window.__DONE__ = true
  return JSON.stringify(out)
}

// 第二段：Tier A 强制后处理。必须单独一段，否则会把上面用于截图的 Tier B rig 换掉。
window.__runTierA__ = async () => {
  const out = {}
  clearLights()
  lightRig = buildLighting(scene, 'A')
  fx = buildPostFX(renderer, scene, camera, 'A', {}, true)
  lightRig.update(camera)
  out.postfxActive = fx.enabled
  out.passes = fx.getEnabled()
  await measure(400)
  out.fps = await measure(1200)
  return JSON.stringify(out)
}

// 单项截图：CDP 调用后返回 dataURL 由外部取
window.__shot__ = (key) => {
  if (key.startsWith('light.')) {
    const k = key.slice(6)
    lightRig.setEnabled(k, false)
    lightRig.update(camera)
  } else {
    fx.setEnabled(key.slice(7), false)
  }
  renderOnce()
  const url = canvas.toDataURL('image/png')
  // 恢复
  if (key.startsWith('light.')) lightRig.setEnabled(key.slice(6), true)
  else fx.setEnabled(key.slice(7), true)
  lightRig.update(camera)
  renderOnce()
  return url
}

window.__shotCurrent__ = () => { renderOnce(); return canvas.toDataURL('image/png') }

setup().catch((e) => { window.__ERR__ = String(e && e.stack || e); window.__READY__ = true })
`

const bundle = await esbuild.build({
  stdin: { contents: ENTRY, resolveDir: workDir, loader: 'js' },
  bundle: true, format: 'iife', minify: true, write: false, target: ['es2020'],
  nodePaths: [resolve(arg('npm', 'D:/tools/pa_probe'), 'node_modules')],
  loader: { '.ts': 'ts' },
})
const js = bundle.outputFiles[0].text
console.log(`[light] bundle ${(js.length / 1024).toFixed(0)} KB`)

const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
html,body{margin:0;background:#0b1014;overflow:hidden}canvas{display:block}
#hud{position:fixed;left:12px;top:10px;font:12px ui-monospace,Consolas,monospace;color:#9fb3c2;
background:rgba(8,12,15,.75);padding:8px 12px;border-left:2px solid #c8a22e}
</style></head><body><canvas id="c" width="${W}" height="${H}"></canvas>
<div id="hud">T07 · 光照/后处理验收</div>
<script>window.__B64__=${JSON.stringify(b64)}</script>
<script>${js}</script></body></html>`

const htmlPath = join(workDir, `light_${Date.now()}.html`)
writeFileSync(htmlPath, html, 'utf8')

const profile = mkdtempSync(join(tmpdir(), 'edge-light-'))
const proc = spawn(EDGE, [
  '--headless=new', '--no-first-run', '--no-default-browser-check',
  '--enable-unsafe-swiftshader', '--use-angle=swiftshader',
  '--disable-features=Translate,BackForwardCache',
  `--window-size=${W},${H}`, `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`, 'about:blank',
], { stdio: 'ignore' })

const cleanup = () => {
  try { proc.kill() } catch {}
  try { rmSync(profile, { recursive: true, force: true }) } catch {}
}

async function waitPage() {
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`)
      if (r.ok) {
        const pg = (await r.json()).find((t) => t.type === 'page')
        if (pg?.webSocketDebuggerUrl) return pg
      }
    } catch {}
    await sleep(250)
  }
  throw new Error('Edge 未就绪')
}

let exitCode = 0
try {
  const page = await waitPage()
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', j) })
  let id = 0
  const pending = new Map()
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data)
    if (m.id && pending.has(m.id)) {
      const { res, rej } = pending.get(m.id)
      pending.delete(m.id)
      m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result)
    }
  })
  const send = (method, params = {}) => new Promise((res, rej) => {
    const i = ++id
    pending.set(i, { res, rej })
    ws.send(JSON.stringify({ id: i, method, params }))
  })
  const ev = async (expr, awaitP = false) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: awaitP })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description || ''))
    return r.result?.value
  }

  await send('Page.enable')
  await send('Runtime.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false })
  await send('Page.navigate', { url: 'file:///' + htmlPath.replace(/\\/g, '/') })

  for (let i = 0; i < 200; i++) {
    if (await ev('!!window.__READY__')) break
    await sleep(250)
  }
  const err = await ev('window.__ERR__ || null')
  if (err) { console.error('[light] setup error:', err); throw new Error('setup failed') }

  console.log('[light] 模型就位，开始测帧率（软件渲染）…')
  const raw = await ev('window.__run__()', true)
  const res = JSON.parse(raw)

  const before = res.baseline.fps
  const after = res.tierB.fps

  console.log('\n===== T07 验收 =====')
  console.log(`  fps_before（P6 现状光照）        ${before} fps  (${res.baseline.frames} 帧 / ${res.baseline.ms} ms)`)
  console.log(`  fps_after （默认档 = Tier B）    ${after} fps  (${res.tierB.frames} 帧 / ${res.tierB.ms} ms)`)
  console.log(`  变化                           ${(after - before >= 0 ? '+' : '') + (after - before).toFixed(1)} fps`)
  console.log(`  五项开关状态                   ${JSON.stringify(res.toggle)}`)

  console.log('\n  逐项关闭验证（关掉后仍出图）：')
  for (const m of res.matrix) {
    console.log(`    ${m.label.padEnd(22)} off → enabled=${m.enabled}  ${m.enabled === false ? 'OK' : 'FAIL'}`)
  }

  // 拍照：默认 / 逐项关闭
  const shots = [
    ['00_default', 'window.__shotCurrent__()'],
    ...res.matrix.map((m) => [m.label.replace('.', '_'), `window.__shot__('${m.label}')`]),
  ]
  for (const [name, expr] of shots) {
    const url = await ev(expr)
    if (typeof url === 'string' && url.startsWith('data:image/png;base64,')) {
      writeFileSync(join(outDir, `${name}.png`), Buffer.from(url.split(',')[1], 'base64'))
    }
  }
  console.log(`\n  截图 → ${outDir}（${shots.length} 张）`)

  const passFps = after >= 34
  const passToggle = res.matrix.every((m) => m.enabled === false)
  console.log(`\n  判据一 五项可单独关闭            ${passToggle ? 'PASS' : 'FAIL'}`)
  console.log(`  判据二 默认档 fps ≥ 34           ${passFps ? 'PASS' : 'FAIL'}（${after}）`)

  // 第二段：Tier A 强制后处理（软渲染下会很慢，只作「能跑」的功能证明）
  const rawA = await ev('window.__runTierA__()', true)
  const resA = JSON.parse(rawA)
  console.log(`\n  后处理强制启用（Tier A，软件渲染）`)
  console.log(`    postfxActive                   ${resA.postfxActive}`)
  console.log(`    pass 状态                      ${JSON.stringify(resA.passes)}`)
  console.log(`    fps（Tier A 全开）              ${resA.fps.fps} fps · ${resA.fps.frames} 帧`)
  // D-047③：两档 fps 同帧打印，档位结论不许只给一个数
  console.log(`\n  fps 档位（D-047）：默认档 ${after} ${passFps ? 'PASS(≥34)' : 'FAIL'}；Tier A 全开 ${resA.fps.fps} → 能跑 · 不可用于演示（演示走默认档）`)

  // Tier A 全开的图（后处理真实生效）
  const urlA = await ev('window.__shotCurrent__()')
  if (typeof urlA === 'string' && urlA.startsWith('data:')) {
    writeFileSync(join(outDir, '99_tierA_postfx.png'), Buffer.from(urlA.split(',')[1], 'base64'))
  }

  console.log(`\n  ${passFps && passToggle ? 'ALL PASS' : 'HAS FAILURE'}`)
  console.log('===== END =====\n')
  if (!passFps || !passToggle) exitCode = 1

  ws.close()
} catch (e) {
  console.error('[light] error:', e.message)
  exitCode = 3
} finally {
  cleanup()
}

process.exit(exitCode)
