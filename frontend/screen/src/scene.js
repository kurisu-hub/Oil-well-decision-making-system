/* ==========================================================================
   WELD TWIN · 三维井场（three.js）
   资产：equipment.js 程序化设备（抽油机 / 井口 / 储罐 / 分离器 / 值班房 / 火炬…）
   布局：6 井主井场 + 2 井副井场 + 集输罐区 + 值班房 + 管排 + 围栏
   ========================================================================== */
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import ASSET_DATA from './assets.json'
import {
  makePumpjack, makeWellhead, makeTank, makeSeparator,
  makeLamp, makeCabin, makeFence, makeFlare, makeManifold,
} from './equipment.js'

const STATE_COLOR = { green: 0x3ecf86, yellow: 0xe0ad42, red: 0xe85a41, gray: 0x6b8494 }
const V = (x, y, z) => new THREE.Vector3(x, y, z)

const VIEW = {
  from: V(320, 230, 400),
  to: V(45, 12, 54),
  target: V(0, 8, -15),
}

/* ---------- 程序纹理 ---------- */
function gravelTexture() {
  const s = 512
  const c = document.createElement('canvas')
  c.width = c.height = s
  const g = c.getContext('2d')
  g.fillStyle = '#403f39'
  g.fillRect(0, 0, s, s)
  for (let i = 0; i < 26000; i++) {
    const v = 42 + Math.random() * 62
    g.fillStyle = `rgba(${v | 0},${(v - 2) | 0},${(v - 8) | 0},${0.35 + Math.random() * 0.5})`
    const r = 0.6 + Math.random() * 2.1
    g.beginPath()
    g.arc(Math.random() * s, Math.random() * s, r, 0, 6.283)
    g.fill()
  }
  for (let k = 0; k < 56; k++) {
    const x = Math.random() * s, y = Math.random() * s, r = 50 + Math.random() * 150
    const gg = g.createRadialGradient(x, y, 0, x, y, r)
    const warm = Math.random() > 0.45
    gg.addColorStop(0, warm
      ? `rgba(${104 + Math.random() * 26 | 0},${92 + Math.random() * 22 | 0},64,0.12)`
      : `rgba(${54 + Math.random() * 20 | 0},${62 + Math.random() * 18 | 0},46,0.12)`)
    gg.addColorStop(1, 'rgba(0,0,0,0)')
    g.fillStyle = gg
    g.beginPath(); g.arc(x, y, r, 0, 6.283); g.fill()
  }
  const t = new THREE.CanvasTexture(c)
  t.wrapS = t.wrapT = THREE.RepeatWrapping
  t.repeat.set(6, 6)
  t.colorSpace = THREE.SRGBColorSpace
  t.anisotropy = 4
  return t
}

function padTexture() {
  const s = 512
  const c = document.createElement('canvas')
  c.width = c.height = s
  const g = c.getContext('2d')
  g.fillStyle = '#4a4942'
  g.fillRect(0, 0, s, s)
  for (let i = 0; i < 30000; i++) {
    const v = 48 + Math.random() * 56
    g.fillStyle = `rgba(${v | 0},${(v - 3) | 0},${(v - 10) | 0},${0.4 + Math.random() * 0.45})`
    g.beginPath()
    g.arc(Math.random() * s, Math.random() * s, 0.6 + Math.random() * 1.8, 0, 6.283)
    g.fill()
  }
  const t = new THREE.CanvasTexture(c)
  t.wrapS = t.wrapT = THREE.RepeatWrapping
  t.colorSpace = THREE.SRGBColorSpace
  t.anisotropy = 4
  return t
}

function glowTexture() {
  const s = 160
  const c = document.createElement('canvas')
  c.width = c.height = s
  const g = c.getContext('2d')
  const grd = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2)
  grd.addColorStop(0, 'rgba(255,255,255,1)')
  grd.addColorStop(0.16, 'rgba(255,255,255,0.72)')
  grd.addColorStop(0.42, 'rgba(255,255,255,0.18)')
  grd.addColorStop(1, 'rgba(255,255,255,0)')
  g.fillStyle = grd
  g.fillRect(0, 0, s, s)
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  return t
}

function skyTexture() {
  const c = document.createElement('canvas')
  c.width = 8; c.height = 512
  const g = c.getContext('2d')
  // 画布顶部 = 天顶，中部 = 地平线，底部 = 地面以下
  const grd = g.createLinearGradient(0, 0, 0, 512)
  grd.addColorStop(0.00, '#010509')
  grd.addColorStop(0.26, '#04101a')
  grd.addColorStop(0.40, '#0a1f2c')
  grd.addColorStop(0.455, '#173440')
  grd.addColorStop(0.485, '#2c4a54')
  grd.addColorStop(0.50, '#35525a')
  grd.addColorStop(0.515, '#2b4046')
  grd.addColorStop(0.55, '#1e2a28')
  grd.addColorStop(0.64, '#121714')
  grd.addColorStop(1.00, '#080b09')
  g.fillStyle = grd
  g.fillRect(0, 0, 8, 512)
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  return t
}

function shadowTexture() {
  const s = 128
  const c = document.createElement('canvas')
  c.width = c.height = s
  const g = c.getContext('2d')
  const grd = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2)
  grd.addColorStop(0, 'rgba(0,0,0,0.66)')
  grd.addColorStop(0.45, 'rgba(0,0,0,0.28)')
  grd.addColorStop(1, 'rgba(0,0,0,0)')
  g.fillStyle = grd
  g.fillRect(0, 0, s, s)
  return new THREE.CanvasTexture(c)
}

/* ---------- 工具 ---------- */
function padGroup(w, d, y = 0.06, tex) {
  const g = new THREE.Group()
  const slab = new THREE.Mesh(
    new THREE.BoxGeometry(w, 0.2, d),
    new THREE.MeshStandardMaterial({ map: tex, bumpMap: tex, bumpScale: 0.35, color: 0x827f70, roughness: 0.99, metalness: 0.02 })
  )
  slab.position.y = y
  slab.receiveShadow = true
  g.add(slab)

  const mark = new THREE.LineBasicMaterial({ color: 0x54d8e8, transparent: true, opacity: 0.42 })
  const pts = []
  const L = 4
  ;[[-1, -1], [1, -1], [-1, 1], [1, 1]].forEach(([sx, sz]) => {
    const x0 = (sx * w) / 2 - sx * 0.8
    const z0 = (sz * d) / 2 - sz * 0.8
    pts.push(V(x0, y + 0.12, z0), V(x0 - sx * L, y + 0.12, z0))
    pts.push(V(x0, y + 0.12, z0), V(x0, y + 0.12, z0 - sz * L))
  })
  for (const zz of [-0.25, 0.25]) {
    pts.push(V(-w / 2 + 3, y + 0.12, d * zz), V(w / 2 - 3, y + 0.12, d * zz))
  }
  g.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts), mark))

  const hz = []
  for (let x = -w / 2 + 2; x < w / 2 - 2; x += 6) {
    hz.push(V(x, y + 0.11, d / 2 - 0.4), V(x + 3, y + 0.11, d / 2 - 0.4))
    hz.push(V(x, y + 0.11, -d / 2 + 0.4), V(x + 3, y + 0.11, -d / 2 + 0.4))
  }
  g.add(new THREE.LineSegments(
    new THREE.BufferGeometry().setFromPoints(hz),
    new THREE.LineBasicMaterial({ color: 0xe0ad42, transparent: true, opacity: 0.3 })
  ))
  return g
}

function roadStrip(points, width, color = 0x1a2126) {
  const curve = new THREE.CatmullRomCurve3(points.map((p) => V(p[0], 0.05, p[1])), false, 'catmullrom', 0.16)
  const N = Math.max(24, Math.floor(curve.getLength() / 8))
  const pos = []
  const idx = []
  for (let i = 0; i <= N; i++) {
    const t = i / N
    const p = curve.getPoint(t)
    const tan = curve.getTangent(t)
    const n = V(-tan.z, 0, tan.x).normalize().multiplyScalar(width / 2)
    pos.push(p.x + n.x, 0.05, p.z + n.z, p.x - n.x, 0.05, p.z - n.z)
    if (i < N) {
      const a = i * 2
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2)
    }
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  geo.setIndex(idx)
  geo.computeVertexNormals()
  const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color, roughness: 0.92, metalness: 0.04 }))
  m.receiveShadow = true
  return m
}

function tubeLine(points, radius, color) {
  const curve = new THREE.CatmullRomCurve3(points.map((p) => V(p[0], p[1] ?? 0.8, p[2])), false, 'catmullrom', 0.25)
  const geo = new THREE.TubeGeometry(curve, Math.max(18, Math.floor(curve.getLength() / 5)), radius, 6, false)
  const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color, roughness: 0.5, metalness: 0.55 }))
  m.castShadow = true
  return { mesh: m, curve }
}

/* ---------- 主入口 ---------- */
export async function createWorld({ canvas, wells, heroes, onFps, onPick, onHover }) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'high-performance' })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.6))
  renderer.setSize(window.innerWidth, window.innerHeight, false)
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = 1.42

  const gl = renderer.getContext()
  const dbg = gl.getExtension('WEBGL_debug_renderer_info')
  const gpuName = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : ''
  const soft = /swiftshader|software|basic render/i.test(gpuName)
  renderer.shadowMap.enabled = !soft
  renderer.shadowMap.type = THREE.PCFSoftShadowMap

  const scene = new THREE.Scene()
  scene.background = new THREE.Color(0x02070b)
  scene.fog = new THREE.FogExp2(0x2d4a55, 0.0026)

  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(5200, 32, 20),
    new THREE.MeshBasicMaterial({ map: skyTexture(), side: THREE.BackSide, fog: false, depthWrite: false })
  )
  scene.add(sky)

  const fovFor = (w) => (w < 1400 ? 50 : w < 1560 ? 46 : 42)
  const camera = new THREE.PerspectiveCamera(fovFor(window.innerWidth), window.innerWidth / window.innerHeight, 0.5, 12000)
  camera.position.copy(VIEW.from)
  camera.lookAt(VIEW.target)

  const controls = new OrbitControls(camera, renderer.domElement)
  controls.target.copy(VIEW.target)
  controls.enableDamping = true
  controls.dampingFactor = 0.055
  controls.minDistance = 45
  controls.maxDistance = 1000
  controls.minPolarAngle = 0.1
  controls.maxPolarAngle = Math.PI * 0.482
  controls.autoRotate = true
  controls.autoRotateSpeed = 0.1
  controls.panSpeed = 0.6

  /* ---- 光 ---- */
  scene.add(new THREE.HemisphereLight(0x8fb6cc, 0x141310, 0.55))
  scene.add(new THREE.AmbientLight(0x3a2f24, 0.35))
  const key = new THREE.DirectionalLight(0xffd2a2, 4.6)
  key.position.set(200, 120, 160)
  if (!soft) {
    key.castShadow = true
    key.shadow.mapSize.set(2048, 2048)
    const c = key.shadow.camera
    c.left = -180; c.right = 180; c.top = 180; c.bottom = -180
    c.near = 40; c.far = 900
    key.shadow.bias = -0.0004
    key.shadow.normalBias = 0.35
  }
  scene.add(key)

  const rim = new THREE.DirectionalLight(0x49bede, 1.35)
  rim.position.set(-220, 80, -200)
  scene.add(rim)

  const fill = new THREE.DirectionalLight(0x6f9fbb, 0.34)
  fill.position.set(-140, 50, 200)
  scene.add(fill)

  const back = new THREE.DirectionalLight(0x69c6e0, 0.55)
  back.position.set(-40, 55, -180)
  scene.add(back)

  const front = new THREE.DirectionalLight(0xbfd6e0, 0.7)
  front.position.set(80, 34, 150)
  scene.add(front)

  const warmRim = new THREE.DirectionalLight(0xff8a4a, 1.2)
  warmRim.position.set(-190, 40, -110)
  scene.add(warmRim)

  const warm = new THREE.PointLight(0xff9a3c, 140, 260, 2)
  warm.position.set(150, 20, 8)
  scene.add(warm)

  /* ---- 地面 ---- */
  const gravel = gravelTexture()
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(4200, 4200, 1, 1),
    new THREE.MeshStandardMaterial({ map: gravel, bumpMap: gravel, bumpScale: 0.5, color: 0x9a9a8c, roughness: 0.98, metalness: 0.02 })
  )
  ground.rotation.x = -Math.PI / 2
  ground.receiveShadow = !soft
  scene.add(ground)

  // 远景台地
  const butteMat = new THREE.MeshStandardMaterial({ color: 0x0c171d, roughness: 1, metalness: 0 })
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2 + 0.35
    const r = 1300 + Math.random() * 900
    const h = 20 + Math.random() * 38
    const b = new THREE.Mesh(new THREE.CylinderGeometry(90 + Math.random() * 120, 150 + Math.random() * 140, h, 8), butteMat)
    b.position.set(Math.cos(a) * r, h / 2 - 12, Math.sin(a) * r)
    b.rotation.y = Math.random() * 3
    scene.add(b)
  }

  // 星点
  const starGeo = new THREE.BufferGeometry()
  const sp = []
  for (let i = 0; i < 900; i++) {
    const a = Math.random() * Math.PI * 2
    const r = 2200 + Math.random() * 2200
    sp.push(Math.cos(a) * r, 260 + Math.random() * 1400, Math.sin(a) * r)
  }
  starGeo.setAttribute('position', new THREE.Float32BufferAttribute(sp, 3))
  scene.add(new THREE.Points(starGeo, new THREE.PointsMaterial({
    map: glowTexture(), color: 0xa8d6e8, size: 7, sizeAttenuation: true,
    transparent: true, opacity: 0.4, depthWrite: false, blending: THREE.AdditiveBlending,
  })))

  // 落日辉光
  const sunGlow = new THREE.Sprite(new THREE.SpriteMaterial({
    map: glowTexture(), color: 0xff7a34, transparent: true, opacity: 0.18,
    blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
  }))
  sunGlow.scale.set(1500, 380, 1)
  sunGlow.position.set(-760, 48, -1450)
  scene.add(sunGlow)

  /* ---- 道路 ---- */
  scene.add(roadStrip([[-220, 24], [-120, 20], [-10, 24], [80, 20], [190, 24]], 9))
  scene.add(roadStrip([[-6, 24], [-8, 60]], 5.5))
  scene.add(roadStrip([[84, 20], [92, -20], [96, -54]], 5.5))
  const dashMat = new THREE.MeshBasicMaterial({ color: 0x6f98a6, transparent: true, opacity: 0.35 })
  for (let x = -210; x < 190; x += 12) {
    const d = new THREE.Mesh(new THREE.PlaneGeometry(4.2, 0.32), dashMat)
    d.rotation.x = -Math.PI / 2
    d.position.set(x, 0.08, 24 - x * 0.008)
    scene.add(d)
  }

  /* ---- 井场 ---- */
  const padTex = padTexture()
  padTex.repeat.set(26, 7)

  const PAD_A = { w: 158, d: 40, x: 0, z: -12 }
  const PAD_B = { w: 0, d: 0, x: 0, z: 0 }
  const apron = new THREE.Mesh(
    new THREE.PlaneGeometry(PAD_A.w + 10, PAD_A.d + 8),
    new THREE.MeshStandardMaterial({ color: 0x6a6558, roughness: 1 })
  )
  apron.rotation.x = -Math.PI / 2
  apron.position.set(PAD_A.x, 0.02, PAD_A.z)
  apron.receiveShadow = true
  scene.add(apron)
  const padA = padGroup(PAD_A.w, PAD_A.d, 0.06, padTex)
  padA.position.set(PAD_A.x, 0, PAD_A.z)
  scene.add(padA)
  const padTop = 0.17

  /* ---- 数字资产台账：注册表 ---- */
  const assetList = []
  const assetByTag = new Map()
  let buildMode = false
  function reg(tag, obj, noScale = false) {
    const meta = ASSET_DATA.assets.find((a) => a.tag === tag)
    if (!meta) return obj
    obj.userData.assetId = tag
    obj.traverse((o) => { o.userData.assetId = tag })
    const item = { tag, obj, meta, baseScale: obj.scale.clone(), noScale }
    assetList.push(item)
    assetByTag.set(tag, item)
    return obj
  }
  reg('PAD-01', padA, true)

  // 轮胎印
  const trackMat = new THREE.MeshBasicMaterial({ color: 0x2a2a26, transparent: true, opacity: 0.5, depthWrite: false })
  for (const off of [-1.4, 1.4]) {
    const track = new THREE.Mesh(new THREE.PlaneGeometry(140, 0.5), trackMat)
    track.rotation.x = -Math.PI / 2
    track.position.set(0, 0.175, PAD_A.z + 6 + off)
    scene.add(track)
  }
  // 油污
  for (let i = 0; i < 9; i++) {
    const stain = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ map: shadowTexture(), color: 0x0a0c0b, transparent: true, opacity: 0.5, depthWrite: false })
    )
    stain.rotation.x = -Math.PI / 2
    stain.scale.set(2 + Math.random() * 5, 2 + Math.random() * 4, 1)
    stain.position.set(-70 + Math.random() * 140, 0.178, PAD_A.z - 14 + Math.random() * 26)
    scene.add(stain)
  }

  /* ---- 罐区 ---- */
  const FARM = { x: 10, z: -72 }
  const bund = new THREE.Mesh(
    new THREE.BoxGeometry(46, 0.24, 34),
    new THREE.MeshStandardMaterial({ map: gravel, bumpMap: gravel, bumpScale: 0.35, color: 0x8f8f82, roughness: 0.99 })
  )
  bund.position.set(FARM.x, 0.12, FARM.z)
  bund.receiveShadow = !soft
  scene.add(bund)
  const bundEdge = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.BoxGeometry(46, 0.24, 34)),
    new THREE.LineBasicMaterial({ color: 0x54d8e8, transparent: true, opacity: 0.25 })
  )
  bundEdge.position.set(FARM.x, 0.12, FARM.z)
  scene.add(bundEdge)
  reg('BND-01', bund, true)

  const tanks = [
    [FARM.x - 11, FARM.z - 5],
    [FARM.x + 3, FARM.z - 5],
    [FARM.x - 4, FARM.z + 11],
  ]
  tanks.forEach((p, i) => {
    const t = makeTank()
    t.position.set(p[0], 0.24, p[1])
    t.rotation.y = i * 0.7
    scene.add(t)
    reg(`TK-10${i + 1}`, t)
  })

  /* ---- 值班房 / 分离器 / 管排 / 火炬 ---- */
  const cabin = makeCabin()
  cabin.position.set(-72, 0.06, -52)
  cabin.rotation.y = 0.16
  scene.add(cabin)
  reg('BLD-01', cabin)

  const sep = makeSeparator()
  sep.position.set(-52, 0.06, -32)
  sep.rotation.y = 0.1
  scene.add(sep)
  reg('SEP-101', sep)

  const man = makeManifold()
  man.position.set(4, 0.06, -42)
  scene.add(man)
  reg('MAN-101', man)

  const flare = makeFlare()
  flare.position.set(56, 0.06, -54)
  scene.add(flare)
  reg('FLR-01', flare)

  const flame = new THREE.Sprite(new THREE.SpriteMaterial({
    map: glowTexture(), color: 0xff8a2a, transparent: true, opacity: 0.9,
    blending: THREE.AdditiveBlending, depthWrite: false,
  }))
  flame.position.set(56, 17.2, -54)
  flame.scale.setScalar(11)
  scene.add(flame)
  const flameCore = new THREE.Sprite(new THREE.SpriteMaterial({
    map: glowTexture(), color: 0xffe08a, transparent: true, opacity: 0.95,
    blending: THREE.AdditiveBlending, depthWrite: false,
  }))
  flameCore.position.set(56, 16.6, -54)
  flameCore.scale.setScalar(5)
  scene.add(flameCore)

  /* ---- 围栏 ---- */
  const fenceGroup = new THREE.Group()
  fenceGroup.add(makeFence([[-56, 20], [-56, 56], [22, 56], [22, 52]]))
  fenceGroup.add(makeFence([[-62, -34], [-62, 14]]))
  scene.add(fenceGroup)
  reg('FEN-01', fenceGroup, true)
  
  

  /* ---- 灯具 ---- */
  const glowTex = glowTexture()
  const lampPositions = [
    [-48, 16], [26, 16], [52, 10],
    [-40, -30],
  ]
  lampPositions.forEach(([x, z], li) => {
    const l = makeLamp(14)
    l.position.set(x, 0, z)
    scene.add(l)
    if (li < 4) reg(`LMP-0${li + 1}`, l)
    const pool = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ map: glowTex, color: 0xffb060, transparent: true, opacity: 0.32, blending: THREE.AdditiveBlending, depthWrite: false })
    )
    pool.rotation.x = -Math.PI / 2
    pool.scale.set(26, 26, 1)
    pool.position.set(x, 0.14, z + 3)
    scene.add(pool)

    const halo = new THREE.Sprite(new THREE.SpriteMaterial({
      map: glowTex, color: 0xffd7a0, transparent: true, opacity: 0.22,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }))
    halo.scale.setScalar(6)
    halo.position.set(x, 14.4, z)
    scene.add(halo)
    const cone = new THREE.Mesh(
      new THREE.ConeGeometry(4.6, 12, 18, 1, true),
      new THREE.MeshBasicMaterial({ color: 0xffc27a, transparent: true, opacity: 0.008, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false })
    )
    cone.position.set(x, 7.4, z)
    scene.add(cone)
  })

  // 前景备用管排（景深）
  const rack = new THREE.Group()
  rack.position.set(-34, 0, 24)
  for (let i = 0; i < 5; i++) {
    const pipe = new THREE.Mesh(
      new THREE.CylinderGeometry(0.17, 0.17, 13, 8),
      new THREE.MeshStandardMaterial({ color: 0x6a7a80, roughness: 0.55, metalness: 0.55 })
    )
    pipe.rotation.z = Math.PI / 2
    pipe.position.set(0, 0.42 + i * 0.02, i * 0.46 - 0.9)
    pipe.castShadow = true
    rack.add(pipe)
  }
  for (const x of [-4.5, 0, 4.5]) {
    const s2 = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.35, 2.6), new THREE.MeshStandardMaterial({ color: 0x3a3630, roughness: 0.95 }))
    s2.position.set(x, 0.18, 0)
    rack.add(s2)
  }
  scene.add(rack)

  // 站牌
  const signCanvas = document.createElement('canvas')
  signCanvas.width = 512; signCanvas.height = 256
  const sg = signCanvas.getContext('2d')
  sg.fillStyle = '#0d1a20'; sg.fillRect(0, 0, 512, 256)
  sg.strokeStyle = '#3fd0e0'; sg.lineWidth = 4; sg.strokeRect(14, 14, 484, 228)
  sg.fillStyle = '#8fe6f5'; sg.font = 'bold 56px Consolas, monospace'
  sg.fillText('WELD BLOCK', 40, 96)
  sg.fillStyle = '#d8e8ee'; sg.font = '30px Consolas, monospace'
  sg.fillText('CPF-01  ·  GATHERING', 40, 148)
  sg.fillStyle = '#6f8f9c'; sg.font = '22px Consolas, monospace'
  sg.fillText('77 WELLS  /  924 WELL-MONTHS', 40, 196)
  const signTex = new THREE.CanvasTexture(signCanvas)
  signTex.colorSpace = THREE.SRGBColorSpace
  const sign = new THREE.Group()
  const panel = new THREE.Mesh(
    new THREE.PlaneGeometry(5.6, 2.8),
    new THREE.MeshBasicMaterial({ map: signTex, transparent: true, opacity: 0.95 })
  )
  panel.position.y = 3.4
  sign.add(panel)
  const signBack = new THREE.Mesh(new THREE.BoxGeometry(5.9, 3.05, 0.18), new THREE.MeshStandardMaterial({ color: 0x1a2a30, roughness: 0.8 }))
  signBack.position.set(0, 3.4, -0.12)
  sign.add(signBack)
  for (const x of [-2.8, 2.8]) {
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.11, 3.4, 8), new THREE.MeshStandardMaterial({ color: 0x6a7d84, roughness: 0.6, metalness: 0.4 }))
    post.position.set(x, 1.7, 0)
    sign.add(post)
  }
  sign.position.set(-42, 0, 6)
  sign.rotation.y = 0.55
  scene.add(sign)
  reg('SGN-01', sign)

  // 值班皮卡（停在值班房前）
  const truck = new THREE.Group()
  const bodyMat = new THREE.MeshStandardMaterial({ color: 0xb8bdba, roughness: 0.5, metalness: 0.25 })
  const bed = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.7, 5.0), bodyMat)
  bed.position.y = 0.95
  truck.add(bed)
  const cab = new THREE.Mesh(new THREE.BoxGeometry(2.0, 1.0, 1.9), bodyMat)
  cab.position.set(0, 1.7, 1.3)
  truck.add(cab)
  const glass = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.55, 0.08), new THREE.MeshStandardMaterial({ color: 0x2a3a40, roughness: 0.2, metalness: 0.6 }))
  glass.position.set(0, 1.85, 2.26)
  truck.add(glass)
  for (const [x, z] of [[-0.95, 1.5], [0.95, 1.5], [-0.95, -1.5], [0.95, -1.5]]) {
    const w = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.42, 0.32, 12), new THREE.MeshStandardMaterial({ color: 0x14191c, roughness: 0.95 }))
    w.rotation.z = Math.PI / 2
    w.position.set(x, 0.42, z)
    truck.add(w)
  }
  truck.position.set(-34, 0.06, -30)
  truck.rotation.y = 1.35
  scene.add(truck)
  reg('TRK-01', truck)

  /* ---- 主角井：抽油机 + 井口 ---- */
  const blobTex = shadowTexture()
  const blobGeo = new THREE.PlaneGeometry(1, 1)
  function blob(x, z, w, d, y = 0.22, op = 0.5) {
    const m = new THREE.Mesh(blobGeo, new THREE.MeshBasicMaterial({
      map: blobTex, color: 0x000000, transparent: true, opacity: op, depthWrite: false,
    }))
    m.rotation.x = -Math.PI / 2
    m.scale.set(w, d, 1)
    m.position.set(x, y, z)
    scene.add(m)
  }

  const heroWells = heroes.map((id) => wells.find((w) => w.id === id)).filter(Boolean)
  const pumps = []
  const picks = []
  const pulseItems = []

  heroWells.forEach((w, i) => {
    const onA = i < 6
    const x = -65 + i * 17.4
    const z = PAD_A.z + 8

    const pj = makePumpjack()
    pj.position.set(x - 1.4, padTop, z)
    pj.traverse((o) => { if (o.isMesh) o.userData.wellId = w.id })
    pj.userData.wellId = w.id
    scene.add(pj)
    picks.push(pj)
    reg(`PJ-${String(i + 1).padStart(2, '0')}`, pj)

    const wh = makeWellhead()
    wh.position.set(x + 2.32, padTop, z)
    wh.traverse((o) => { if (o.isMesh) o.userData.wellId = w.id })
    wh.userData.wellId = w.id
    scene.add(wh)
    picks.push(wh)
    reg(`WH-${String(i + 1).padStart(2, '0')}`, wh)

    blob(x - 1.4, z, 24, 14, 0.215, 0.42)

    const parts = pj.userData.parts
    pumps.push({ ...parts, phase: Math.random() * 6.28, speed: 0.82 + Math.random() * 0.12 })

    const col = STATE_COLOR[w.state] || STATE_COLOR.gray
    const orb = new THREE.Sprite(new THREE.SpriteMaterial({
      map: glowTex, color: col, transparent: true, opacity: 0.7,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }))
    orb.scale.setScalar(2.2)
    orb.position.set(x + 2.32, 2.95, z)
    orb.userData.wellId = w.id
    scene.add(orb)
    picks.push(orb)

    const beam = new THREE.Sprite(new THREE.SpriteMaterial({
      map: glowTex, color: col, transparent: true, opacity: 0.12,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }))
    beam.scale.set(4, 26, 1)
    beam.position.set(x + 2.32, 14, z)
    scene.add(beam)

    const ring = new THREE.Mesh(
      new THREE.RingGeometry(6.4, 7.2, 48),
      new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.4, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false })
    )
    ring.rotation.x = -Math.PI / 2
    ring.position.set(x + 2.32, padTop + 0.04, z)
    scene.add(ring)

    pulseItems.push({ orb, ring, beam, phase: Math.random() * 6.28 })
    w._pos = { x: x + 2.32, z }
  })

  /* ---- 管网 ---- */
  const pipeGroup = new THREE.Group()
  scene.add(pipeGroup)
  const trunk = tubeLine([[-78, 0.8, 18], [-30, 0.8, 18.6], [20, 0.8, 18.4], [62, 0.8, 18.2], [92, 0.8, 14]], 0.34, 0x4a5c64)
  pipeGroup.add(trunk.mesh)
  const trunkGlow = new THREE.Mesh(
    trunk.mesh.geometry,
    new THREE.MeshBasicMaterial({ color: 0x39cfe2, transparent: true, opacity: 0.1, blending: THREE.AdditiveBlending, depthWrite: false })
  )
  trunkGlow.scale.setScalar(2.0)
  pipeGroup.add(trunkGlow)

  heroWells.forEach((w) => {
    const p = w._pos
    const { mesh } = tubeLine([[p.x, 0.75, p.z + 1], [p.x + 0.6, 0.75, p.z + 8], [p.x + 0.9, 0.75, 18]], 0.17, 0x3d4e55)
    pipeGroup.add(mesh)
  })
  pipeGroup.add(tubeLine([[92, 0.8, 14], [92, 0.8, -40], [56, 0.8, -58], [22, 0.8, -58]], 0.3, 0x3d4e55).mesh)
  pipeGroup.add(tubeLine([[22, 0.8, -58], [22, 0.8, -60]], 0.24, 0x3d4e55).mesh)
  reg('PIP-01', pipeGroup, true)

  const flowDots = []
  const dotGeo = new THREE.SphereGeometry(0.3, 6, 6)
  const dotMat = new THREE.MeshBasicMaterial({ color: 0x6fe6d2, transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false })
  for (let i = 0; i < 14; i++) {
    const d = new THREE.Mesh(dotGeo, dotMat)
    scene.add(d)
    flowDots.push({ mesh: d, curve: trunk.curve, t: Math.random(), speed: 0.025 + Math.random() * 0.02 })
  }

  const bgWells = wells.filter((w) => !heroes.includes(w.id))

  /* ---- 地表碎块 ---- */
  const m4 = new THREE.Matrix4()
  const q = new THREE.Quaternion()
  const scrub = new THREE.InstancedMesh(
    new THREE.ConeGeometry(0.9, 1.3, 5),
    new THREE.MeshStandardMaterial({ color: 0x232e26, roughness: 1 }),
    260
  )
  for (let i = 0; i < 260; i++) {
    const a = Math.random() * Math.PI * 2
    const r = 100 + Math.pow(Math.random(), 0.7) * 420
    const sc = 0.5 + Math.random() * 0.9
    q.setFromAxisAngle(V(0, 1, 0), Math.random() * 6.28)
    m4.compose(V(Math.cos(a) * r, 0.5, Math.sin(a) * r), q, V(sc, sc * (0.7 + Math.random()), sc))
    scrub.setMatrixAt(i, m4)
  }
  scrub.instanceMatrix.needsUpdate = true
  scene.add(scrub)

  /* ---- 浮尘 ---- */
  const dustGeo = new THREE.BufferGeometry()
  const dp = []
  for (let i = 0; i < 320; i++) {
    const a = Math.random() * Math.PI * 2
    const r = Math.pow(Math.random(), 0.6) * 300
    dp.push(Math.cos(a) * r, 2 + Math.random() * 55, Math.sin(a) * r)
  }
  dustGeo.setAttribute('position', new THREE.Float32BufferAttribute(dp, 3))
  const dust = new THREE.Points(dustGeo, new THREE.PointsMaterial({
    map: glowTex, color: 0x9fdcf0, size: 2.6, sizeAttenuation: true,
    transparent: true, opacity: 0.1, depthWrite: false, blending: THREE.AdditiveBlending,
  }))
  scene.add(dust)

  /* ---- 井位标牌 ---- */
  const layer = document.createElement('div')
  layer.className = 'wlabels'
  document.body.appendChild(layer)
  const nameCount = {}
  heroWells.forEach((w) => { nameCount[w.name] = (nameCount[w.name] || 0) + 1 })
  const labels = heroWells.map((w, idx) => {
    const d = document.createElement('button')
    d.className = 'wlbl'
    d.style.setProperty('--c', `#${(STATE_COLOR[w.state] || STATE_COLOR.gray).toString(16).padStart(6, '0')}`)
    const suffix = nameCount[w.name] > 1 ? `<em>${w.id.slice(-3)}</em>` : ''
    d.innerHTML = `<i></i><b>${w.name}</b>${suffix}`
    d.addEventListener('click', (ev) => { ev.stopPropagation(); onPick && onPick(w) })
    layer.appendChild(d)
    return { w, d, i: idx, v: new THREE.Vector3() }
  })

  /* ---- 井场名牌 ---- */
  const padTags = [
    { x: -66, z: 14, t: 'WELD-PAD-A', s: '6 WELLS' },
    { x: -36, z: 64, t: 'WELD-PAD-B', s: '2 WELLS' },
    { x: 2, z: -48, t: 'CPF-01', s: 'GATHERING' },
  ].map((p) => {
    const d = document.createElement('div')
    d.className = 'padtag'
    d.innerHTML = `<b>${p.t}</b><span>${p.s}</span>`
    layer.appendChild(d)
    return { ...p, d, v: new THREE.Vector3() }
  })

  /* ---- 选中环 ---- */
  const selRing = new THREE.Mesh(
    new THREE.RingGeometry(8, 9.4, 64),
    new THREE.MeshBasicMaterial({ color: 0x9ff2ff, transparent: true, opacity: 0.9, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false })
  )
  selRing.rotation.x = -Math.PI / 2
  selRing.visible = false
  scene.add(selRing)

  /* ---- 拾取 ---- */
  const raycaster = new THREE.Raycaster()
  const ndc = new THREE.Vector2()
  let hovered = null
  let downAt = 0

  function pickAt(ev) {
    const r = renderer.domElement.getBoundingClientRect()
    ndc.x = ((ev.clientX - r.left) / r.width) * 2 - 1
    ndc.y = -((ev.clientY - r.top) / r.height) * 2 + 1
    raycaster.setFromCamera(ndc, camera)
    const hits = raycaster.intersectObjects(picks, true)
    if (!hits.length) return null
    let o = hits[0].object
    while (o && !o.userData.wellId) o = o.parent
    return o ? o.userData.wellId : null
  }

  renderer.domElement.addEventListener('pointermove', (ev) => {
    if (ev.buttons) return
    const id = pickAt(ev)
    if (id !== hovered) {
      hovered = id
      renderer.domElement.style.cursor = id ? 'pointer' : 'default'
    }
    onHover && onHover(id ? wells.find((w) => w.id === id) : null, ev)
  })
  renderer.domElement.addEventListener('pointerdown', () => { downAt = performance.now() })
  renderer.domElement.addEventListener('pointerup', (ev) => {
    if (performance.now() - downAt > 340) return
    const id = pickAt(ev)
    if (id && onPick) onPick(wells.find((w) => w.id === id))
  })
  renderer.domElement.addEventListener('pointerleave', () => onHover && onHover(null))

  controls.addEventListener('start', () => { controls.autoRotate = false; camAnim = null })

  /* ---- 相机动画 ---- */
  let camAnim = null
  function animCam(to, target, ms = 1100) {
    camAnim = { from: camera.position.clone(), to, target: target || controls.target.clone(), t: 0, ms }
    controls.autoRotate = false
  }
  function focusWell(id) {
    const w = wells.find((x) => x.id === id)
    if (!w) return
    const px = w._pos ? w._pos.x : w.x * 0.42
    const pz = w._pos ? w._pos.z : w.y * 0.42
    selRing.position.set(px, 0.3, pz)
    selRing.visible = true
    animCam(V(px + 20, 14, pz + 26), V(px, 4.5, pz), 1200)
  }

  /* ---- 4D 建造 / 资产定位 ---- */
  const buildView = { from: V(104, 72, 116), target: V(0, 0, -18) }
  let boxHelper = null
  function applyBuild(day) {
    for (const a of assetList) {
      const started = day >= a.meta.start_day
      a.obj.visible = started
      if (!started) continue
      if (a.noScale) { a.obj.scale.copy(a.baseScale); continue }
      const k = Math.min(1, (day - a.meta.start_day) / Math.max(1, a.meta.end_day - a.meta.start_day))
      const e = 1 - Math.pow(1 - k, 3)
      a.obj.scale.copy(a.baseScale).multiplyScalar(0.8 + 0.2 * e)
    }
  }
  function setBuildMode(on) {
    buildMode = on
    document.body.classList.toggle('build-mode', on)
    labels.forEach((L) => { L.d.style.display = on ? 'none' : '' })
    padTags.forEach((P) => { P.d.style.display = on ? 'none' : '' })
    pulseItems.forEach((it) => { it.orb.visible = !on; it.ring.visible = !on; it.beam.visible = !on })
    flowDots.forEach((d) => { d.mesh.visible = !on })
    if (on) {
      selRing.visible = false
      if (boxHelper) boxHelper.visible = false
      applyBuild(0)
      animCam(buildView.from, buildView.target, 1400)
    } else {
      applyBuild(999)
      animCam(VIEW.to.clone(), VIEW.target.clone(), 1200)
    }
  }
  function setBuildDay(day) {
    const d = Math.max(0, Math.min(ASSET_DATA.meta.total_days, day))
    applyBuild(d)
    return d
  }
  function highlightAsset(tag) {
    const a = assetByTag.get(tag)
    if (!a) return
    if (!boxHelper) {
      boxHelper = new THREE.BoxHelper(a.obj, 0x7fe9ff)
      boxHelper.material.transparent = true
      boxHelper.material.opacity = 0.9
      scene.add(boxHelper)
    }
    boxHelper.setFromObject(a.obj)
    boxHelper.visible = true
  }
  function focusAsset(tag) {
    const a = assetByTag.get(tag)
    if (!a) return
    a.obj.visible = true
    const box = new THREE.Box3().setFromObject(a.obj)
    const c = new THREE.Vector3()
    box.getCenter(c)
    const sz = new THREE.Vector3()
    box.getSize(sz)
    const d = Math.max(sz.x, sz.y, sz.z) * 1.5 + 16
    animCam(V(c.x + d * 0.6, c.y + d * 0.45, c.z + d * 0.75), c.clone(), 1100)
    highlightAsset(tag)
  }

  /* ---- 主循环 ---- */
  const clock = new THREE.Clock()
  let frames = 0
  let acc = 0
  const intro = { t: 0, dur: 3.6, active: true }

  function frame() {
    const dt = Math.min(clock.getDelta(), 0.05)
    const t = clock.elapsedTime

    if (intro.active) {
      intro.t += dt
      const k = Math.min(1, intro.t / intro.dur)
      const e = 1 - Math.pow(1 - k, 3)
      camera.position.lerpVectors(VIEW.from, VIEW.to, e)
      camera.lookAt(VIEW.target)
      if (k >= 1) {
        intro.active = false
        controls.update()
        controls.autoRotate = true
      }
    } else if (camAnim) {
      camAnim.t += dt * 1000
      const k = Math.min(1, camAnim.t / camAnim.ms)
      const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2
      camera.position.lerpVectors(camAnim.from, camAnim.to, e)
      controls.target.lerp(camAnim.target, 0.14)
      if (k >= 1) camAnim = null
      controls.update()
    } else {
      controls.update()
    }

    pumps.forEach((p) => {
      const ang = Math.sin(t * p.speed + p.phase)
      if (p.beam) p.beam.rotation.z = ang * 0.15
      if (p.crank) p.crank.rotation.z = -t * p.speed * 1.6 + p.phase
      if (p.rod) p.rod.position.y = 4.6 + ang * 0.5
    })

    pulseItems.forEach((it) => {
      const k = 0.5 + 0.5 * Math.sin(t * 1.2 + it.phase)
      it.orb.material.opacity = 0.42 + k * 0.4
      it.orb.scale.setScalar(1.9 + k * 0.8)
      it.beam.material.opacity = 0.06 + k * 0.05
      it.ring.material.opacity = 0.24 + k * 0.2
    })

    flowDots.forEach((d) => {
      d.t += dt * d.speed
      if (d.t > 1) d.t -= 1
      const p = d.curve.getPoint(d.t)
      d.mesh.position.set(p.x, 0.84, p.z)
    })

    flame.scale.setScalar(10 + Math.sin(t * 9) * 1.4 + Math.sin(t * 23) * 0.8)
    flameCore.scale.setScalar(4.6 + Math.sin(t * 13) * 1.0)
    warm.intensity = 130 + Math.sin(t * 11) * 26 + Math.sin(t * 27) * 10
    dust.rotation.y = t * 0.008
    selRing.material.opacity = 0.5 + 0.4 * Math.sin(t * 3)
    selRing.scale.setScalar(1 + 0.03 * Math.sin(t * 3))

    const W = window.innerWidth
    const H = window.innerHeight
    labels.forEach((L) => {
      L.v.set(L.w._pos.x, 11, L.w._pos.z).project(camera)
      if (!(L.v.z < 1 && L.v.z > -1)) { L.d.style.opacity = '0'; return }
      const x = (L.v.x * 0.5 + 0.5) * W
      const y = (-L.v.y * 0.5 + 0.5) * H
      const edge = x < 300 || x > W - 310
      L.d.style.opacity = edge ? '0' : '1'
      L.d.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)`
    })

    padTags.forEach((P) => {
      P.v.set(P.x, 0.4, P.z).project(camera)
      if (!(P.v.z < 1 && P.v.z > -1)) { P.d.style.opacity = '0'; return }
      const x = (P.v.x * 0.5 + 0.5) * W
      const y = (-P.v.y * 0.5 + 0.5) * H
      P.d.style.opacity = x < 300 || x > W - 310 ? '0' : '0.85'
      P.d.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)`
    })

    renderer.render(scene, camera)

    frames++
    acc += dt
    if (acc >= 0.5) {
      onFps && onFps({ fps: Math.round(frames / acc), tris: renderer.info.render.triangles, calls: renderer.info.render.calls, soft })
      frames = 0
      acc = 0
    }
    requestAnimationFrame(frame)
  }

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight
    camera.fov = fovFor(window.innerWidth)
    camera.updateProjectionMatrix()
    renderer.setSize(window.innerWidth, window.innerHeight, false)
  })

  frame()

  return {
    focusWell,
    focusAsset,
    highlightAsset,
    setBuildMode,
    setBuildDay,
    buildMode: () => buildMode,
    resetView() {
      selRing.visible = false
      animCam(VIEW.to.clone(), VIEW.target.clone(), 1200)
    },
    soft,
  }
}
