/**
 * glb_probe.mjs · glb → three.js 加载链路验证（单文件内联路径）
 *
 * 做三件事：
 *   1. 把 glb 转 base64 内联进一个自包含 HTML（不起服务器，直接 file:// 打开）
 *      —— 这正是 P3「单文件预算」那条要走的路径，先验掉
 *   2. headless Edge 加载，渲染一帧，截图
 *   3. 从页面里取回 three.js 侧实测：三角面 / draw call / 包围盒 / 材质数 / 解析耗时
 *
 * 用法：
 *   node glb_probe.mjs --glb <path.glb> --out <shot.png> [--w 1400] [--h 900]
 */
import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import * as esbuild from 'esbuild'

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const PORT = 9341

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`)
  return i > 0 ? process.argv[i + 1] : def
}

const glbPath = resolve(arg('glb'))
const outPath = resolve(arg('out', 'probe.png'))
const W = Number(arg('w', 1400))
const H = Number(arg('h', 900))
const INSTANCES = Number(arg('instances', 1))
const workDir = resolve(arg('work', './.probe'))

if (!existsSync(glbPath)) {
  console.error(`找不到 glb: ${glbPath}`)
  process.exit(2)
}

mkdirSync(workDir, { recursive: true })

// ---------------------------------------------------------------- 1. 打包 three

const ENTRY = `
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'

const INSTANCES = ${INSTANCES}
const t0 = performance.now()
const canvas = document.getElementById('c')
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true })
renderer.setPixelRatio(1)
renderer.setSize(window.innerWidth, window.innerHeight, false)
renderer.outputColorSpace = THREE.SRGBColorSpace
renderer.toneMapping = THREE.ACESFilmicToneMapping
renderer.toneMappingExposure = 1.15
renderer.shadowMap.enabled = true
renderer.shadowMap.type = THREE.PCFSoftShadowMap

const scene = new THREE.Scene()
scene.background = new THREE.Color(0x0e1317)
scene.fog = new THREE.Fog(0x0e1317, 60, 180)

// 地面（接收阴影，给设备一个落脚参照）
const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(120, 120),
  new THREE.MeshStandardMaterial({ color: 0x2a2b28, roughness: 0.95, metalness: 0.0 }),
)
ground.rotation.x = -Math.PI / 2
ground.receiveShadow = true
scene.add(ground)

// 三点光
const hemi = new THREE.HemisphereLight(0x9fc4e8, 0x2a261f, 1.15)
scene.add(hemi)
const key = new THREE.DirectionalLight(0xffe6c4, 2.6)
key.position.set(-14, 20, 12)
key.castShadow = true
key.shadow.mapSize.set(2048, 2048)
const d = 14
Object.assign(key.shadow.camera, { left: -d, right: d, top: d, bottom: -d, near: 1, far: 80 })
key.shadow.bias = -0.0006
scene.add(key)
const rim = new THREE.DirectionalLight(0xffbb77, 1.5)
rim.position.set(16, 12, -14)
scene.add(rim)

const camera = new THREE.PerspectiveCamera(38, window.innerWidth / window.innerHeight, 0.1, 500)

const glbB64 = window.__GLB_B64__
const bin = Uint8Array.from(atob(glbB64), (c) => c.charCodeAt(0))

const loader = new GLTFLoader()
loader.parse(bin.buffer, '', (gltf) => {
  const root = gltf.scene
  scene.add(root)

  const bbox = new THREE.Box3().setFromObject(root)
  const size = bbox.getSize(new THREE.Vector3())
  const center = bbox.getCenter(new THREE.Vector3())

  let tris = 0, meshes = 0, instanced = 0
  const materials = new Set()
  const nodesWithId = []
  root.traverse((o) => {
    if (o.isMesh) {
      meshes += 1
      if (o.isInstancedMesh) instanced += 1
      const g = o.geometry
      tris += g.index ? g.index.count / 3 : g.attributes.position.count / 3
      const ms = Array.isArray(o.material) ? o.material : [o.material]
      ms.forEach((m) => m && materials.add(m.name || m.uuid))
    }
    if (o.userData && o.userData.pa_id) nodesWithId.push({ name: o.name, id: o.userData.pa_id })
  })

  // 相机：按包围盒自动取景（与 P6 的 C1 井场机位同构）
  const dist = Math.max(size.x, size.y, size.z) * 1.55
  camera.position.set(center.x + dist * 0.80, center.y + dist * 0.62, center.z + dist * 0.95)
  camera.lookAt(center.x, center.y * 0.92, center.z)
  camera.near = 0.1
  camera.far = 600
  camera.updateProjectionMatrix()

  // 材质修正：glTF 导入后统一给金属一点环境强度
  root.traverse((o) => {
    if (!o.isMesh) return
    o.castShadow = true
    o.receiveShadow = true
  })

  // ---- 实例化校验：同型号只存 1 份几何，用 InstancedMesh 复用 ----
  // 判据不是"看起来能实例化"，是 draw call 不随台数线性增长：
  //   非实例化 8 台 = 17 × 8 = 136 call；实例化后应仍是 17 call。
  let instInfo = null
  if (INSTANCES > 1) {
    const single = []
    root.traverse((o) => { if (o.isMesh) single.push(o) })
    const inst = new THREE.Group()
    const m4 = new THREE.Matrix4()
    for (const m of single) {
      const im = new THREE.InstancedMesh(m.geometry, m.material, INSTANCES)
      im.castShadow = true
      im.receiveShadow = true
      for (let i = 0; i < INSTANCES; i++) {
        const col = i % 4
        const row = Math.floor(i / 4)
        m4.makeTranslation(col * 15 - 22, 0, row * 17 - 8)
        im.setMatrixAt(i, m4)
      }
      im.instanceMatrix.needsUpdate = true
      inst.add(im)
    }
    scene.remove(root)
    scene.add(inst)
    const b2 = new THREE.Box3().setFromObject(inst)
    const c2 = b2.getCenter(new THREE.Vector3())
    const s2 = b2.getSize(new THREE.Vector3())
    const dist2 = Math.max(s2.x, s2.y, s2.z) * 1.15
    camera.position.set(c2.x + dist2 * 0.62, c2.y + dist2 * 0.52, c2.z + dist2 * 0.95)
    camera.lookAt(c2.x, c2.y, c2.z)
    camera.updateProjectionMatrix()
    instInfo = {
      instances: INSTANCES,
      instancedMeshes: inst.children.length,
      callsIfNotInstanced: single.length * INSTANCES,
    }
  }

  renderer.render(scene, camera)
  const gl = renderer.getContext()
  const parseMs = Math.round(performance.now() - t0)

  window.__GLB_INFO__ = {
    ok: true,
    bbox: [+size.x.toFixed(4), +size.y.toFixed(4), +size.z.toFixed(4)],
    bboxMin: [+bbox.min.x.toFixed(4), +bbox.min.y.toFixed(4), +bbox.min.z.toFixed(4)],
    bboxMax: [+bbox.max.x.toFixed(4), +bbox.max.y.toFixed(4), +bbox.max.z.toFixed(4)],
    triangles: Math.round(tris),
    meshes,
    instancedMeshes: instanced,
    materials: materials.size,
    materialNames: [...materials],
    drawCalls: renderer.info.render.calls,
    programs: renderer.info.programs ? renderer.info.programs.length : -1,
    nodesWithId,
    instancing: instInfo,
    parseMs,
    glbBytes: bin.byteLength,
    glRenderer: gl.getParameter(gl.RENDERER),
    camera: {
      position: [+camera.position.x.toFixed(2), +camera.position.y.toFixed(2), +camera.position.z.toFixed(2)],
      target: [+center.x.toFixed(2), +center.y.toFixed(2), +center.z.toFixed(2)],
    },
    anims: gltf.animations.map((a) => a.name),
  }
}, (err) => {
  window.__GLB_INFO__ = { ok: false, error: String(err && err.message || err) }
})
`

const bundle = await esbuild.build({
  stdin: { contents: ENTRY, resolveDir: workDir, loader: 'js' },
  bundle: true,
  format: 'iife',
  minify: true,
  write: false,
  target: ['es2020'],
})
const js = bundle.outputFiles[0].text

// ---------------------------------------------------------------- 2. 造单文件 HTML

const b64 = readFileSync(glbPath).toString('base64')
const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
html,body{margin:0;height:100%;background:#0e1317;overflow:hidden}
canvas{display:block;width:100%;height:100%}
#hud{position:fixed;left:14px;top:12px;font:12px/1.6 ui-monospace,Consolas,monospace;color:#8fa3b3;
     background:rgba(8,12,15,.72);padding:10px 14px;border-left:2px solid #c8a22e;pointer-events:none}
b{color:#e8d9a8;font-weight:600}
</style></head><body>
<canvas id="c"></canvas>
<div id="hud">P3 · 抽油机 glb → three.js 链路验证<br>
<span id="m">loading…</span></div>
<script>window.__GLB_B64__="${b64}"</script>
<script>${js}</script>
<script>
setTimeout(()=>{const i=window.__GLB_INFO__;const m=document.getElementById('m');
 if(!i){m.textContent='NO INFO';return}
 if(!i.ok){m.textContent='ERR: '+i.error;return}
 m.innerHTML='bbox <b>'+i.bbox.join(' × ')+'</b> m · tris <b>'+i.triangles+'</b> · draw <b>'+i.drawCalls+'</b>'
  +'<br>glb <b>'+(i.glbBytes/1024).toFixed(0)+' KB</b> 内联 · 解析 <b>'+i.parseMs+' ms</b>';},900)
</script>
</body></html>`

// 文件名带时间戳：同名 HTML 会被 Edge 的 disk cache 命中，
// 导致第二件资产读到的是上一件的 __GLB_INFO__（实测踩过，tank 报出 pumpjack 的 bbox）。
const htmlPath = join(workDir, `probe_${Date.now()}.html`)
writeFileSync(htmlPath, html, 'utf8')
console.log(`[probe] html ${(html.length / 1024 / 1024).toFixed(2)} MB → ${htmlPath}`)

// ---------------------------------------------------------------- 3. headless Edge

const profile = mkdtempSync(join(tmpdir(), 'edge-probe-'))
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
  // 注意：/json/version 的 webSocketDebuggerUrl 是 **browser** 级 target，
  // 在它上面调 Page.enable 会报 "'Page.enable' wasn't found"。
  // 必须从 /json/list 里挑 type === "page" 的那条。
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`)
      if (r.ok) {
        const list = await r.json()
        const page = list.find((t) => t.type === 'page')
        if (page && page.webSocketDebuggerUrl) return page
      }
    } catch {}
    await sleep(250)
  }
  throw new Error('Edge 调试端口未就绪（没有 page target）')
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

  const fileUrl = 'file:///' + htmlPath.replace(/\\/g, '/')
  await send('Page.navigate', { url: fileUrl })
  await sleep(4200)

  const evalRes = await send('Runtime.evaluate', {
    expression: 'JSON.stringify(window.__GLB_INFO__ || null)',
    returnByValue: true,
  })
  const info = JSON.parse(evalRes.result.value || 'null')
  console.log('\n===== GLB_PROBE_INFO =====')
  console.log(JSON.stringify(info, null, 2))
  console.log('===== END =====\n')

  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, Buffer.from(shot.data, 'base64'))
  console.log(`[probe] shot → ${outPath}`)

  if (!info || !info.ok) exitCode = 1
  ws.close()
} catch (e) {
  console.error('[probe] failed:', e.message)
  exitCode = 3
} finally {
  cleanup()
}

process.exit(exitCode)
