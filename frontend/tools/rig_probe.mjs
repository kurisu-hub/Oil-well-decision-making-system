/**
 * rig_probe.mjs · 四连杆驱动验证（three.js + headless Edge）
 *
 * 验的事情：把 pumpjackRig 挂到真实 glb 上，按不同曲柄角渲染，
 * 证明游梁/驴头/光杆确实跟着动，而且四个相位的光杆高度各不相同。
 *
 * 用法：
 *   node rig_probe.mjs --glb <pumpjack_lod0.glb> --out <dir> --src <项目 src/three 目录>
 */
import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, existsSync } from 'node:fs'
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

const glbPath = resolve(arg('glb'))
const outDir = resolve(arg('out', './rig_shots'))
const srcDir = resolve(arg('src'))
const W = Number(arg('w', 1200))
const H = Number(arg('h', 800))
const workDir = resolve(arg('work', './.rigprobe'))

if (!existsSync(glbPath)) { console.error(`找不到 glb: ${glbPath}`); process.exit(2) }
mkdirSync(workDir, { recursive: true })
mkdirSync(outDir, { recursive: true })

const rigTs = join(srcDir, 'pumpjackRig.ts').replace(/\\/g, '/')

const ENTRY = `
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { PumpjackRig, findRigNodes } from '${rigTs}'

const canvas = document.getElementById('c')
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true })
renderer.setPixelRatio(1)
renderer.setSize(window.innerWidth, window.innerHeight, false)
renderer.outputColorSpace = THREE.SRGBColorSpace
renderer.toneMapping = THREE.ACESFilmicToneMapping
renderer.toneMappingExposure = 1.1
renderer.shadowMap.enabled = true

const scene = new THREE.Scene()
scene.background = new THREE.Color(0x0e1317)

const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(120, 120),
  new THREE.MeshStandardMaterial({ color: 0x2a2b28, roughness: 0.95 }),
)
ground.rotation.x = -Math.PI / 2
ground.receiveShadow = true
scene.add(ground)

scene.add(new THREE.HemisphereLight(0x9fc4e8, 0x2a261f, 1.2))
const key = new THREE.DirectionalLight(0xffe6c4, 2.5)
key.position.set(-14, 20, 12)
key.castShadow = true
key.shadow.mapSize.set(2048, 2048)
Object.assign(key.shadow.camera, { left: -14, right: 14, top: 14, bottom: -14, near: 1, far: 80 })
scene.add(key)
const rim = new THREE.DirectionalLight(0xffbb77, 1.4)
rim.position.set(16, 12, -14)
scene.add(rim)

const camera = new THREE.PerspectiveCamera(38, window.innerWidth / window.innerHeight, 0.1, 500)
camera.position.set(13.5, 9.2, 17.5)
camera.lookAt(0, 4.1, 0)

const bin = Uint8Array.from(atob(window.__GLB_B64__), (c) => c.charCodeAt(0))
new GLTFLoader().parse(bin.buffer, '', (gltf) => {
  const root = gltf.scene
  root.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true } })
  scene.add(root)

  let rig = null
  try {
    rig = new PumpjackRig(findRigNodes(root))
    window.__RIG_OK__ = true
    window.__STROKE__ = rig.getStrokeLength()
    window.__NODES__ = {
      beam: !!rig.nodes.beam,
      cranks: rig.nodes.cranks.length,
      pitmans: rig.nodes.pitmans.length,
    }
  } catch (e) {
    window.__RIG_OK__ = false
    window.__RIG_ERR__ = String(e && e.message || e)
  }

  window.__setPhase__ = (deg) => {
    if (!rig) return null
    rig.setCrankAngle((deg * Math.PI) / 180)
    renderer.render(scene, camera)
    const st = rig.getState()
    return { thetaDeg: deg, beamDeg: +st.beamDeg.toFixed(2), rodY: +st.rodY.toFixed(4), phase: +st.phase.toFixed(3) }
  }

  window.__render__ = () => renderer.render(scene, camera)
  window.__render__()
  window.__READY__ = true
}, (err) => { window.__RIG_OK__ = false; window.__RIG_ERR__ = String(err) })
`

const bundle = await esbuild.build({
  stdin: { contents: ENTRY, resolveDir: workDir, loader: 'js' },
  bundle: true,
  format: 'iife',
  minify: true,
  write: false,
  target: ['es2020'],
  nodePaths: [resolve(arg('npm', 'D:/tools/pa_probe'), 'node_modules')],
  loader: { '.ts': 'ts' },
})
const js = bundle.outputFiles[0].text

const b64 = readFileSync(glbPath).toString('base64')
const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
html,body{margin:0;height:100%;background:#0e1317;overflow:hidden}canvas{display:block;width:100%;height:100%}
#hud{position:fixed;left:14px;top:12px;font:12px/1.7 ui-monospace,Consolas,monospace;color:#9fb3c2;
background:rgba(8,12,15,.75);padding:10px 14px;border-left:2px solid #c8a22e}
b{color:#e8d9a8}
</style></head><body><canvas id="c"></canvas><div id="hud">P3 · 四连杆驱动验证<br><span id="m">loading…</span></div>
<script>window.__GLB_B64__="${b64}"</script><script>${js}</script>
<script>setTimeout(()=>{const m=document.getElementById('m');
 if(!window.__RIG_OK__){m.textContent='RIG FAIL: '+(window.__RIG_ERR__||'?');return}
 m.innerHTML='stroke <b>'+window.__STROKE__.toFixed(3)+' m</b> · nodes beam/crank/pitman = <b>'
  +window.__NODES__.beam+'/'+window.__NODES__.cranks+'/'+window.__NODES__.pitmans+'</b>'},600)</script>
</body></html>`

const htmlPath = join(workDir, `rig_${Date.now()}.html`)
writeFileSync(htmlPath, html, 'utf8')
console.log(`[rig] html ${(html.length / 1024 / 1024).toFixed(2)} MB`)

const profile = mkdtempSync(join(tmpdir(), 'edge-rig-'))
const proc = spawn(EDGE, [
  '--headless=new', '--no-first-run', '--no-default-browser-check',
  '--enable-unsafe-swiftshader', '--use-angle=swiftshader',
  '--disable-features=Translate,BackForwardCache',
  `--window-size=${W},${H}`, `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`, 'about:blank',
], { stdio: 'ignore' })

function cleanup() {
  try { proc.kill() } catch {}
  try { rmSync(profile, { recursive: true, force: true }) } catch {}
}

async function waitPage() {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`)
      if (r.ok) {
        const p = (await r.json()).find((t) => t.type === 'page')
        if (p?.webSocketDebuggerUrl) return p
      }
    } catch {}
    await sleep(250)
  }
  throw new Error('Edge 调试端口未就绪')
}

let msgId = 0
let exitCode = 0

try {
  const page = await waitPage()
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', j) })
  const pending = new Map()
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.id && pending.has(msg.id)) {
      const { res, rej } = pending.get(msg.id)
      pending.delete(msg.id)
      msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result)
    }
  })
  const send = (method, params = {}) => new Promise((res, rej) => {
    const id = ++msgId
    pending.set(id, { res, rej })
    ws.send(JSON.stringify({ id, method, params }))
  })
  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
    return r.result?.value
  }

  await send('Page.enable')
  await send('Runtime.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false })
  await send('Page.navigate', { url: 'file:///' + htmlPath.replace(/\\/g, '/') })

  for (let i = 0; i < 40; i++) {
    if (await evalJs('!!window.__READY__')) break
    await sleep(250)
  }

  const ok = await evalJs('window.__RIG_OK__')
  const err = await evalJs('window.__RIG_ERR__ || null')
  if (!ok) {
    console.error('[rig] FAILED:', err)
    exitCode = 1
  } else {
    const nodes = await evalJs('JSON.stringify(window.__NODES__)')
    const stroke = await evalJs('window.__STROKE__')
    console.log(`[rig] nodes ${nodes} · stroke ${Number(stroke).toFixed(4)} m`)

    // 四个相位：0 / 90 / 180 / 270 —— 光杆高度必须各不相同，否则等于没动
    const phases = [0, 90, 180, 270]
    const results = []
    for (const deg of phases) {
      const st = await evalJs(`JSON.stringify(window.__setPhase__(${deg}))`)
      results.push(JSON.parse(st))
      const shot = await send('Page.captureScreenshot', { format: 'png' })
      writeFileSync(join(outDir, `rig_phase_${String(deg).padStart(3, '0')}.png`),
        Buffer.from(shot.data, 'base64'))
    }

    console.log('\n===== RIG_PHASE =====')
    for (const r of results) {
      console.log(`  θ=${String(r.thetaDeg).padStart(3)}°  beam=${String(r.beamDeg).padStart(7)}°  rodY=${String(r.rodY).padStart(8)} m  phase=${r.phase}`)
    }
    const rodYs = results.map((r) => r.rodY)
    const spread = Math.max(...rodYs) - Math.min(...rodYs)
    console.log(`  光杆跨度 ${spread.toFixed(4)} m`)
    console.log(`  ${spread > 0.5 ? 'PASS' : 'FAIL'}  四相位光杆高度应有明显差异（>0.5 m）`)
    console.log('===== END =====\n')
    if (spread <= 0.5) exitCode = 1
  }
  ws.close()
} catch (e) {
  console.error('[rig] error:', e.message)
  exitCode = 3
} finally {
  cleanup()
}

process.exit(exitCode)
