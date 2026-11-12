import './style.css'
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import DATA from './data.json'
import { buildLayout } from './layout.js'
import { createTerrain } from './terrain.js'
import { createSky, createMountains, SUN_DIR } from './sky.js'
import { buildWorld } from './world.js'
import { lineChart, donutChart, sparkline } from './charts.js'

/* ==========================================================================
   基础
   ========================================================================== */
const $ = (s) => document.querySelector(s)
const $$ = (s) => Array.from(document.querySelectorAll(s))
const nf = (n, d = 0) => Number(n).toLocaleString('zh-CN', { minimumFractionDigits: d, maximumFractionDigits: d })
const STATE_CN = { green: '可判', yellow: '待定', red: '不可判', gray: '数据不足' }
const STATE_HEX = { green: '#4fd08a', yellow: '#f0b23c', red: '#e8614a', gray: '#7e98a3' }
const ACT_CN = { '压': '建议压裂', '不压': '不建议压裂', '补资料': '补资料后再判' }
const act = (a) => ACT_CN[a] || (a && a.length > 6 ? '证据不足' : a)

const params = new URLSearchParams(location.search)
const quality = params.get('q') || 'high'
const wells = DATA.wells
const byId = (id) => wells.find((w) => w.id === id)

/* ---------- 聚合曲线 ---------- */
const agg = Array.from({ length: 12 }, (_, m) => wells.reduce((a, w) => a + (w.sp?.[m] || 0), 0))
const D = DATA.d_pool || 0.05
const baseSeries = agg.map((_, m) => agg[0] * Math.exp(-D * m))
const sumAgg = agg.reduce((a, b) => a + b, 0)
const sumBase = baseSeries.reduce((a, b) => a + b, 0)
const aggRatio = sumAgg / sumBase

let month = 1
let playing = false
let speed = 1
let playAcc = 0

/* ==========================================================================
   三维
   ========================================================================== */
const canvas = $('#gl')
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' })
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75))
renderer.setSize(innerWidth, innerHeight, false)
renderer.outputColorSpace = THREE.SRGBColorSpace
renderer.toneMapping = THREE.ACESFilmicToneMapping
renderer.toneMappingExposure = 1.0
renderer.shadowMap.enabled = quality !== 'low'
renderer.shadowMap.type = THREE.PCFSoftShadowMap

const gl = renderer.getContext()
const dbg = gl.getExtension('WEBGL_debug_renderer_info')
const gpu = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : ''
const soft = /swiftshader|software|basic render/i.test(gpu)

const scene = new THREE.Scene()
const camera = new THREE.PerspectiveCamera(35, innerWidth / innerHeight, 1, 30000)

const layout = buildLayout(wells, DATA.heroes)
const C = layout.cpf

const VIEWS = {
  overview: { pos: new THREE.Vector3(300, 88, 545), tgt: new THREE.Vector3(120, 40, 292) },
  cpf: { pos: new THREE.Vector3(C.x + 132, 62, C.z + 172), tgt: new THREE.Vector3(C.x - 6, 14, C.z) },
  wide: { pos: new THREE.Vector3(900, 380, 1180), tgt: new THREE.Vector3(20, 60, 140) },
}
const LOGIN_VIEW = { pos: new THREE.Vector3(C.x + 205, 78, C.z + 246), tgt: new THREE.Vector3(C.x - 20, 18, C.z - 28) }
const camOverride = params.get('cam') ? params.get('cam').split(',').map(Number) : null
const tgtOverride = params.get('tgt') ? params.get('tgt').split(',').map(Number) : null
if (camOverride) camera.position.set(camOverride[0], camOverride[1], camOverride[2])
else camera.position.copy(LOGIN_VIEW.pos)

const controls = new OrbitControls(camera, canvas)
controls.target.copy(tgtOverride ? new THREE.Vector3(tgtOverride[0], tgtOverride[1], tgtOverride[2]) : LOGIN_VIEW.tgt)
controls.enableDamping = true
controls.dampingFactor = 0.06
controls.maxPolarAngle = Math.PI * 0.492
controls.minDistance = 40
controls.maxDistance = 2600
controls.autoRotate = false
controls.autoRotateSpeed = 0.18

const sky = createSky(renderer, scene, { quality })
scene.add(sky.sky)
scene.add(createMountains({ quality }))

const terrain = createTerrain({ layout, quality })
scene.add(terrain.mesh)
scene.add(terrain.far)

const world = buildWorld({ scene, layout, terrain, quality })

scene.add(new THREE.HemisphereLight(0xbcd8ee, 0x7d7252, 0.62))
scene.add(new THREE.AmbientLight(0xffffff, 0.16))
const sun = new THREE.DirectionalLight(0xfff2dc, 3.1)
sun.position.copy(SUN_DIR).multiplyScalar(900)
sun.castShadow = true
sun.shadow.mapSize.set(soft ? 1536 : 3072, soft ? 1536 : 3072)
const sc = sun.shadow.camera
sc.left = -560; sc.right = 560; sc.top = 560; sc.bottom = -560
sc.near = 200; sc.far = 2600
sun.shadow.bias = -0.0005
sun.shadow.normalBias = 0.5
scene.add(sun)
scene.add(sun.target)

function focusShadow(x, z, extent) {
  sun.target.position.set(x, 0, z)
  sun.position.copy(SUN_DIR).multiplyScalar(900).add(new THREE.Vector3(x, 0, z))
  sc.left = -extent; sc.right = extent; sc.top = extent; sc.bottom = -extent
  sc.updateProjectionMatrix()
  sun.target.updateMatrixWorld()
  sun.updateMatrixWorld()
}
focusShadow(60, 200, 560)

/* ==========================================================================
   相机动画
   ========================================================================== */
let camAnim = null
function flyTo(pos, tgt, ms = 1600) {
  camAnim = {
    fromP: camera.position.clone(), toP: pos.clone(),
    fromT: controls.target.clone(), toT: tgt.clone(),
    t: 0, ms,
  }
}

/* ==========================================================================
   HUD 文本
   ========================================================================== */
$('#k-pads').textContent = layout.pads.length

const fmtRate = (v) => (v >= 100 ? nf(v, 0) : nf(v, 1))

function setMonth(m, redraw = true) {
  month = m
  const rate = agg[m - 1]
  const cum = agg.slice(0, m).reduce((a, b) => a + b, 0) * 30
  const baseRate = baseSeries[m - 1]
  const dlt = (rate / baseRate - 1) * 100

  $('#k-rate').textContent = fmtRate(rate)
  $('#k-month').textContent = 'M' + String(m).padStart(2, '0')
  $('#k-mnum').textContent = m
  const dEl = $('#k-delta')
  dEl.querySelector('b').textContent = (dlt >= 0 ? '+' : '') + dlt.toFixed(1) + '%'
  dEl.querySelector('i').className = 'up' + (dlt < 0 ? ' dn' : '')
  dEl.querySelector('b').style.color = dlt >= 0 ? '#4fd08a' : '#e8614a'

  $('#m-lab').textContent = 'M' + String(m).padStart(2, '0')
  $('#tl-fill').style.width = ((m - 1) / 11) * 100 + '%'
  $$('#tl-ticks span').forEach((s, i) => s.classList.toggle('on', i === m - 1))
  $('#month').value = m

  $('#b-oil').textContent = fmtRate(rate)
  $('#b-month').textContent = nf(rate * 30, 0)
  $('#b-cum').textContent = (cum / 1e4).toFixed(2)

  if (redraw) {
    drawProd()
    updateTanks(m)
    if (openMod === 'well') drawSpark()
  }
}

function drawProd() {
  lineChart($('#chart-prod'), {
    series: [
      { data: agg, color: '#5fe3d4', width: 1.7, fill: ['rgba(95,227,212,0.28)', 'rgba(95,227,212,0)'] },
      { data: baseSeries, color: '#7e98a3', width: 1.1, dashed: true },
    ],
    cursor: month - 1,
    labels: ['M01', '', '', 'M04', '', '', 'M07', '', '', 'M10', '', 'M12'],
    height: 74,
  })
}

function renderTodo() {
  const todo = [...wells]
    .filter((w) => w.state !== 'gray')
    .sort((a, b) => b.npv - a.npv)
    .slice(0, 4)
  $('#todo').innerHTML = todo.map((w) => `
    <li data-well="${w.id}" style="--c:${STATE_HEX[w.state]}">
      <i></i>
      <em>${w.name} · ${act(w.action)}</em>
      <b>${nf(w.npv, 0)}</b>
    </li>`).join('')
  $$('#todo li').forEach((li) => li.addEventListener('click', () => openModule('well', li.dataset.well)))
}

function renderEquipment() {
  const pumps = world.stats.pumpCount
  const alarm = 1
  const stop = 3
  const run = pumps - alarm - stop
  $('#eq-pump').textContent = pumps
  $('#eq-run').textContent = run
  $('#eq-stop').textContent = stop
  $('#eq-alarm').textContent = alarm
  $('#b-online').textContent = (((pumps - alarm) / pumps) * 100).toFixed(1)

  $('#tanks').innerHTML = Array.from({ length: 6 }, (_, i) => `
    <div class="tank"><div class="bar"><i id="tk-${i}" style="height:50%"></i><em id="tkv-${i}">50%</em></div><span>TK-${String(i + 1).padStart(2, '0')}</span></div>
  `).join('')

  const pads = [...layout.pads].sort((a, b) => b.wells.length - a.wells.length).slice(0, 4)
  const maxN = pads[0]?.wells.length || 1
  $('#flow').innerHTML = pads.map((p, i) => `
    <div class="fr"><span>${p.id}</span><div class="fb"><i id="fl-${i}" style="width:${(p.wells.length / maxN) * 100}%"></i></div><b id="flv-${i}">${p.wells.length} 井</b></div>
  `).join('')
}

function updateTanks(m) {
  const phase = (m - 1) / 11
  for (let i = 0; i < 6; i++) {
    const lv = 0.34 + 0.36 * Math.abs(Math.sin(phase * 2.1 + i * 1.15)) + 0.06 * Math.sin(phase * 6 + i)
    const pct = Math.min(96, Math.max(12, lv * 100))
    const el = $('#tk-' + i)
    const lb = $('#tkv-' + i)
    if (el) el.style.height = pct.toFixed(0) + '%'
    if (lb) lb.textContent = pct.toFixed(0) + '%'
  }
  for (let i = 0; i < 4; i++) {
    const el = $('#fl-' + i)
    if (el) el.style.width = (55 + 40 * Math.abs(Math.sin(phase * 3 + i))).toFixed(0) + '%'
  }
}

function drawDonut() {
  donutChart($('#chart-donut'), [
    { value: DATA.kpi.states.green, color: '#4fd08a' },
    { value: DATA.kpi.states.yellow, color: '#f0b23c' },
    { value: DATA.kpi.states.red, color: '#e8614a' },
    { value: DATA.kpi.states.gray, color: '#7e98a3' },
  ], { value: '77', label: '口井' })
}

function initHud() {
  const k = DATA.kpi
  $('#k-ratio').textContent = k.ratio_median.toFixed(3)
  $('#k-share').textContent = (k.share_ge1 * 100).toFixed(1) + '%'
  $('#k-p25').textContent = k.ratio_p25.toFixed(2)
  $('#k-p75').textContent = k.ratio_p75.toFixed(2)
  $('#k-npv').textContent = nf(k.ai_npv, 1) + ' 万元'
  $('#k-hit').textContent = (k.ai_hit * 100).toFixed(1) + '%'
  const scr = (v) => Math.min(100, (v / 2.5) * 100)
  $('#k-range').style.width = scr(k.ratio_p75) + '%'
  $('#k-tick').style.left = scr(k.ratio_median) + '%'

  $('#tl-ticks').innerHTML = Array.from({ length: 12 }, (_, i) => `<span>M${String(i + 1).padStart(2, '0')}</span>`).join('')
  renderTodo()
  renderEquipment()
  drawDonut()
  setMonth(1)
}

/* ==========================================================================
   标签
   ========================================================================== */
const layerEl = $('#labels')
const labels = []

function makeLabels() {
  layerEl.innerHTML = ''
  labels.length = 0
  const heroMarkers = world.wellMarkers
    .slice()
    .sort((a, b) => {
      if (a.hero !== b.hero) return (b.hero ? 1 : 0) - (a.hero ? 1 : 0)
      const da = Math.hypot(a.x - C.x, a.z - C.z)
      const db = Math.hypot(b.x - C.x, b.z - C.z)
      return da - db
    })
    .slice(0, 12)
  const counts = {}
  heroMarkers.forEach((m) => { counts[m.name] = (counts[m.name] || 0) + 1 })

  heroMarkers.forEach((m) => {
    const d = document.createElement('button')
    d.className = 'wlbl'
    d.style.setProperty('--c', STATE_HEX[m.state] || STATE_HEX.gray)
    const suffix = counts[m.name] > 1 ? `<em>${m.id.slice(-3)}</em>` : ''
    d.innerHTML = `<i></i><b>${m.name}</b>${suffix}`
    d.addEventListener('click', (e) => { e.stopPropagation(); openModule('well', m.id) })
    layerEl.appendChild(d)
    labels.push({ el: d, pos: new THREE.Vector3(m.x, m.y, m.z), type: 'well' })
  })

  const facilities = [
    { t: 'CPF-01', s: '联合站 · 集输 / 分离 / 外输', x: C.x, y: terrain.heightAt(C.x, C.z) + 20, z: C.z - 46 },
    { t: 'RIG-02', s: '钻修井作业', x: world.rigSpot?.x ?? 0, y: (world.rigSpot?.h ?? 0) + 58, z: world.rigSpot?.z ?? 0 },
  ]
  const bigPads = [...layout.pads].sort((a, b) => b.wells.length - a.wells.length).slice(0, 3)
  bigPads.forEach((p) => facilities.push({
    t: p.id, s: `${p.wells.length} 口井 · ${p.hero ? '主井场' : '生产井场'}`,
    x: p.cx, y: (p._H || 0) + 10, z: p.cz,
  }))

  facilities.forEach((f) => {
    const d = document.createElement('div')
    d.className = 'padtag'
    d.innerHTML = `<b>${f.t}</b><span>${f.s}</span>`
    layerEl.appendChild(d)
    labels.push({ el: d, pos: new THREE.Vector3(f.x, f.y, f.z), type: 'tag' })
  })
}

/* ==========================================================================
   井位分布图
   ========================================================================== */
const mm = { last: 0 }
function drawMap() {
  const c = $('#map-canvas')
  if (!c) return
  const rect = c.getBoundingClientRect()
  if (!rect.width) return
  const dpr = Math.min(devicePixelRatio || 1, 2)
  const w = rect.width, h = rect.height
  c.width = Math.round(w * dpr)
  c.height = Math.round(h * dpr)
  const g = c.getContext('2d')
  g.setTransform(dpr, 0, 0, dpr, 0, 0)
  g.clearRect(0, 0, w, h)

  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity
  for (const m of world.wellMarkers) {
    minX = Math.min(minX, m.x); maxX = Math.max(maxX, m.x)
    minZ = Math.min(minZ, m.z); maxZ = Math.max(maxZ, m.z)
  }
  const pad = 12
  const sx = (w - pad * 2) / (maxX - minX || 1)
  const sz = (h - pad * 2) / (maxZ - minZ || 1)
  const k = Math.min(sx, sz)
  const ox = pad + ((w - pad * 2) - (maxX - minX) * k) / 2
  const oz = pad + ((h - pad * 2) - (maxZ - minZ) * k) / 2
  const X = (x) => ox + (x - minX) * k
  const Z = (z) => oz + (z - minZ) * k

  // 网格
  g.strokeStyle = 'rgba(104,196,214,0.10)'
  g.lineWidth = 1
  for (let i = 1; i < 4; i++) {
    g.beginPath(); g.moveTo((w / 4) * i, 0); g.lineTo((w / 4) * i, h); g.stroke()
    g.beginPath(); g.moveTo(0, (h / 4) * i); g.lineTo(w, (h / 4) * i); g.stroke()
  }
  // 主路
  g.strokeStyle = 'rgba(190,206,214,0.35)'
  g.lineWidth = 1.2
  g.beginPath()
  layout.mainRoad.forEach(([x, z], i) => (i ? g.lineTo(X(x), Z(z)) : g.moveTo(X(x), Z(z))))
  g.stroke()
  g.strokeStyle = 'rgba(190,206,214,0.20)'
  g.beginPath()
  layout.crossRoad.forEach(([x, z], i) => (i ? g.lineTo(X(x), Z(z)) : g.moveTo(X(x), Z(z))))
  g.stroke()

  // 井场
  for (const p of layout.pads) {
    g.fillStyle = 'rgba(240,178,60,0.55)'
    g.fillRect(X(p.cx) - 2, Z(p.cz) - 2, 4, 4)
    g.strokeStyle = 'rgba(240,178,60,0.18)'
    g.strokeRect(X(p.cx) - p.w * k / 2, Z(p.cz) - p.d * k / 2, p.w * k, p.d * k)
  }
  // 井位
  for (const m of world.wellMarkers) {
    g.fillStyle = STATE_HEX[m.state] || '#7e98a3'
    g.globalAlpha = m.hero ? 1 : 0.8
    g.beginPath(); g.arc(X(m.x), Z(m.z), m.hero ? 2 : 1.3, 0, 6.283); g.fill()
  }
  g.globalAlpha = 1
  // 联合站
  g.fillStyle = '#5fe3d4'
  g.fillRect(X(C.x) - 3, Z(C.z) - 3, 6, 6)
  g.strokeStyle = 'rgba(95,227,212,0.6)'
  g.strokeRect(X(C.x) - 7, Z(C.z) - 7, 14, 14)

  // 相机
  const cp = camera.position
  const px = X(cp.x), pz = Z(cp.z)
  const tgt = controls.target
  const ang = Math.atan2(Z(tgt.z) - pz, X(tgt.x) - px)
  g.save()
  g.translate(px, pz)
  g.rotate(ang)
  g.fillStyle = 'rgba(232,246,249,0.9)'
  g.beginPath(); g.moveTo(7, 0); g.lineTo(-4, 4); g.lineTo(-4, -4); g.closePath(); g.fill()
  g.strokeStyle = 'rgba(232,246,249,0.35)'
  g.beginPath(); g.moveTo(0, 0); g.lineTo(26, 14); g.moveTo(0, 0); g.lineTo(26, -14); g.stroke()
  g.restore()
}

/* ==========================================================================
   拾取
   ========================================================================== */
const tmpV = new THREE.Vector3()
let hoverId = null
let downAt = 0
let downPos = null

function nearestWell(clientX, clientY, radius = 26) {
  const rect = canvas.getBoundingClientRect()
  let best = null, bestD = radius * radius
  for (const m of world.wellMarkers) {
    tmpV.set(m.x, m.y, m.z).project(camera)
    if (tmpV.z > 1 || tmpV.z < -1) continue
    const x = rect.left + (tmpV.x * 0.5 + 0.5) * rect.width
    const y = rect.top + (-tmpV.y * 0.5 + 0.5) * rect.height
    const d = (x - clientX) ** 2 + (y - clientY) ** 2
    if (d < bestD) { bestD = d; best = { m, x, y } }
  }
  return best
}

canvas.addEventListener('pointermove', (e) => {
  const hit = nearestWell(e.clientX, e.clientY)
  const tip = $('#tip')
  if (!hit) {
    tip.classList.remove('on')
    if (hoverId) { hoverId = null; canvas.style.cursor = 'default' }
    return
  }
  canvas.style.cursor = 'pointer'
  hoverId = hit.m.id
  const w = hit.m.well
  tip.innerHTML = `<b>${w.name}</b> · ${w.api}<br>${STATE_CN[w.state]} · 期望 NPV ${nf(w.npv, 1)} 万元<br><span style="color:#718b96">${w.bucket}</span>`
  tip.style.left = e.clientX + 'px'
  tip.style.top = e.clientY + 'px'
  tip.classList.add('on')
})
canvas.addEventListener('pointerdown', (e) => { downAt = performance.now(); downPos = [e.clientX, e.clientY] })
canvas.addEventListener('pointerup', (e) => {
  if (performance.now() - downAt > 380) return
  if (downPos && Math.hypot(e.clientX - downPos[0], e.clientY - downPos[1]) > 6) return
  const hit = nearestWell(e.clientX, e.clientY)
  if (hit) openModule('well', hit.m.id)
})
canvas.addEventListener('pointerleave', () => {
  $('#tip').classList.remove('on')
  hoverId = null
})

/* ==========================================================================
   抽屉
   ========================================================================== */
const MODULES = {
  well: { i: '01', t: '单井卡', render: renderWell },
  combo: { i: '02', t: '组合结算', render: renderCombo },
  review: { i: '03', t: '数据复盘', render: renderReview },
  report: { i: '04', t: '决策报告', render: renderReport },
  model: { i: '05', t: '模型卡', render: renderModel },
  evidence: { i: '06', t: '证据链', render: renderEvidence },
}
let openMod = null
let currentWell = DATA.heroes[0]
let filterState = 'all'

function openModule(id, wellId) {
  const mod = MODULES[id]
  if (!mod) return
  if (wellId) currentWell = wellId
  $('#dr-index').textContent = mod.i
  $('#dr-title').textContent = mod.t
  $('#dr-body').innerHTML = mod.render()
  $('#dr-body').scrollTop = 0
  $('#drawer').classList.add('open')
  $('#drawer').setAttribute('aria-hidden', 'false')
  document.body.classList.add('has-drawer')
  $$('.dk').forEach((b) => b.classList.toggle('on', b.dataset.mod === id))
  openMod = id
  if (id === 'well') { bindWellList(); drawSpark() }
}

function closeDrawer() {
  $('#drawer').classList.remove('open')
  $('#drawer').setAttribute('aria-hidden', 'true')
  document.body.classList.remove('has-drawer')
  $$('.dk').forEach((b) => b.classList.remove('on'))
  openMod = null
  flyTo(VIEWS.overview.pos, VIEWS.overview.tgt, 1400)
}

function renderWell() {
  const rows = wells
    .filter((w) => (filterState === 'all' ? true : filterState === 'hero' ? w.hero : w.state === filterState))
    .sort((a, b) => (b.hero - a.hero) || b.npv - a.npv)
  return `
  <div class="tabs">
    ${[['all', '全部 77'], ['hero', '主井 8'], ['green', '可判'], ['yellow', '待定'], ['red', '不可判']]
      .map(([k, l]) => `<button class="tab ${filterState === k ? 'on' : ''}" data-f="${k}">${l}</button>`).join('')}
  </div>
  <div class="wlist">
    ${rows.map((w) => `<div class="wl ${w.id === currentWell ? 'on' : ''}" data-well="${w.id}" style="--c:${STATE_HEX[w.state]}">
      <i></i><span class="nm">${w.name}</span><em>${w.api}</em><b>${nf(w.npv, 0)}</b>
    </div>`).join('')}
  </div>
  <div id="wdetail">${wellDetail(byId(currentWell))}</div>`
}

function bindWellList() {
  $$('.tab').forEach((t) => t.addEventListener('click', () => { filterState = t.dataset.f; openModule('well') }))
  $$('.wl').forEach((r) => r.addEventListener('click', () => {
    currentWell = r.dataset.well
    $$('.wl').forEach((x) => x.classList.toggle('on', x.dataset.well === currentWell))
    $('#wdetail').innerHTML = wellDetail(byId(currentWell))
    drawSpark()
    focusWell(currentWell)
  }))
  $('#btn-locate')?.addEventListener('click', () => focusWell(currentWell))
  $('#btn-combo')?.addEventListener('click', () => openModule('combo'))
}

function wellDetail(w) {
  if (!w) return ''
  const cum = w.sp ? w.sp.reduce((a, b) => a + b, 0) * 30 : 0
  return `
  <div class="detail">
    <div class="dt-top">
      <div><h3>${w.name}</h3><p>API ${w.api} · ${w.lon.toFixed(4)}, ${w.lat.toFixed(4)}</p></div>
      <span class="chip" style="--c:${STATE_HEX[w.state]}">${STATE_CN[w.state]}</span>
    </div>
    <div class="dt-grid">
      <div><span>期望 NPV</span><b>${nf(w.npv, 1)}<small>万元</small></b></div>
      <div><span>12 月增油</span><b>${nf(w.oil)}<small>m³</small></b></div>
      <div><span>ROI</span><b>${w.roi.toFixed(2)}</b></div>
      <div><span>置信度</span><b>${(w.conf * 100).toFixed(0)}<small>%</small></b></div>
    </div>
    <div class="blk-h" style="margin:8px 0 2px">事件后 12 个月产量 · m³/d</div>
    <canvas class="spark" id="spark"></canvas>
    <div class="dt-note">
      <b>判据：</b>${w.reason}<br />
      <b>12 月累计：</b>${nf(cum, 0)} m³（按 30 天/月折算）<br />
      <b>所属井场：</b>${w._pad || '—'} · ${w.bucket}<br />
      <b>数据缺口：</b>${w.gap || '无'}
    </div>
    <div class="btn-row">
      <button class="btn" id="btn-locate">三维定位</button>
      <button class="btn" id="btn-combo">加入组合</button>
    </div>
  </div>`
}

function drawSpark() {
  const c = $('#spark')
  if (!c) return
  const w = byId(currentWell)
  if (!w?.sp) return
  sparkline(c, w.sp, '#5fe3d4', month - 1)
}

function renderCombo() {
  const st = DATA.strategies
  const max = Math.max(...st.map((s) => s.expected_npv))
  return `
  <div class="blk">
    <div class="blk-h">三种选井方式 · 同 3 口 / 150 万元预算</div>
    ${st.map((s) => `<div class="bar-row">
      <div class="bar-top"><span>${s.label}</span><b>${nf(s.expected_npv, 1)} 万元</b></div>
      <div class="bar"><i class="${s.id === 'ai' ? '' : s.id === 'random' ? 'cool' : 'warm'}" style="--w:${(s.expected_npv / max) * 100}%"></i></div>
      <div class="bar-top" style="margin-top:5px">
        <span style="color:#718b96">增油 ${nf(s.expected_oil)} m³ · 命中 ${(s.hit_rate * 100).toFixed(1)}%</span>
        <span style="color:#718b96">regret ${s.regret === 0 ? '—' : nf(s.regret, 0)} 万</span>
      </div>
    </div>`).join('')}
    <div class="note">预算 150 万元，AI 组合期望 NPV <b>${nf(DATA.kpi.ai_npv, 2)} 万元</b>，期望增油 <b>${nf(DATA.kpi.ai_oil)} m³</b>，亏损概率 ${(DATA.kpi.ai_loss * 100).toFixed(2)}%。</div>
  </div>
  <div class="blk">
    <div class="blk-h">AI 组合选中的 3 口</div>
    ${st[0].selected.map((id) => {
      const w = byId(id)
      return `<div class="row"><span>${w ? w.name : id} <em style="font-style:normal;color:#5d7484;font-family:var(--mono);font-size:9px">${id}</em></span><b>${w ? nf(w.npv, 1) + ' 万' : ''}</b></div>`
    }).join('')}
  </div>
  <div class="blk">
    <div class="blk-h">组合空间 · 已枚举 ${nf(DATA.combo.n_total)} 组</div>
    <div class="tbl">
      <div class="tr hd" style="grid-template-columns:1fr 72px 54px 50px"><span>组合</span><span style="text-align:right">NPV</span><span style="text-align:right">CVaR</span><span style="text-align:right">regret</span></div>
      ${DATA.combo.top.map((c) => `<div class="tr" style="grid-template-columns:1fr 72px 54px 50px">
        <span class="nm">${c.selected.map((id) => id.replace('CO', '')).join(' · ')}</span>
        <b>${nf(c.expected_npv, 0)}</b><b>${nf(c.cvar, 0)}</b><b>${nf(c.regret, 0)}</b>
      </div>`).join('')}
    </div>
  </div>`
}

function renderReview() {
  const m = DATA.confusion.matrix
  const order = ['green', 'yellow', 'red', 'gray']
  return `
  <div class="blk">
    <div class="blk-h">模型状态 × 实际结果</div>
    <div class="matrix">
      <div class="h">状态</div><div class="h">实际跑赢</div><div class="h">实际未跑赢</div>
      ${order.map((k) => `<div style="color:${STATE_HEX[k]}">${STATE_CN[k]} · ${m[k].n}</div><div><b>${m[k].n_good}</b></div><div><b>${m[k].n_bad}</b></div>`).join('')}
    </div>
    <div class="row" style="margin-top:10px"><span>可判组精确率</span><b>${(m.green.precision * 100).toFixed(1)}%</b></div>
    <div class="row"><span>待定组精确率</span><b>${(m.yellow.precision * 100).toFixed(1)}%</b></div>
    <div class="row"><span>不可判组精确率</span><b>${(m.red.precision * 100).toFixed(1)}%</b></div>
  </div>
  <div class="blk">
    <div class="blk-h">实际分布（不含模型）</div>
    <div class="row"><span>跑赢自身递减基线</span><b>${DATA.confusion.actual_dist.good} 口</b></div>
    <div class="row"><span>未跑赢</span><b>${DATA.confusion.actual_dist.bad} 口</b></div>
    <div class="row"><span>决策覆盖率</span><b>${(DATA.confusion.coverage_of_decisions * 100).toFixed(1)}%</b></div>
    <div class="row"><span>已决策井准确率</span><b>${(DATA.confusion.accuracy_on_decided * 100).toFixed(1)}%</b></div>
  </div>
  <div class="blk">
    <div class="blk-h">基线审计</div>
    <div class="row"><span>实际 / 基线 · 中位</span><b>${DATA.kpi.ratio_median.toFixed(3)}</b></div>
    <div class="row"><span>P25 / P75</span><b>${DATA.kpi.ratio_p25.toFixed(2)} / ${DATA.kpi.ratio_p75.toFixed(2)}</b></div>
    <div class="row"><span>池化衰减率 D</span><b>${DATA.d_pool.toFixed(4)} / 月</b></div>
    <div class="note warn" style="margin-top:10px">逐月共形 90% 区间下界在 ${(DATA.intervals.frac_lower_clipped * 100).toFixed(0)}% 的点上被截到 0——停产月导致，不是单井特性。</div>
  </div>`
}

function renderReport() {
  const k = DATA.kpi
  const ai = DATA.strategies.find((x) => x.id === 'ai') || DATA.strategies[0]
  const picks = ai.selected.map((id) => byId(id)).filter(Boolean)
  return `
  <div class="rep-head">
    <div class="rep-no">WELD-DR-2024-08</div>
    <div class="rep-meta"><span>编制 2026-11-10</span><span>口径 final77</span><span>77 口井 / 924 井月</span></div>
    <h3>Weld 区块完井措施决策报告</h3>
    <p>范围：科罗拉多州 Weld 县 77 口井，事件后 12 个月。结论用于排序与下注，不替代现场论证。</p>
  </div>
  <div class="kstrip">
    <div><span>预算</span><b>${nf(k.budget, 0)}<em>万元</em></b></div>
    <div><span>期望 NPV</span><b>${nf(k.ai_npv, 1)}<em>万元</em></b></div>
    <div><span>12 月增油</span><b>${nf(k.ai_oil, 0)}<em>m³</em></b></div>
    <div><span>命中率</span><b>${(k.ai_hit * 100).toFixed(1)}<em>%</em></b></div>
  </div>
  <div class="blk">
    <div class="blk-h">结论</div>
    <ul class="bul">
      <li>77 口井措施后 12 个月累计产量相对自身递减基线，中位比 <b>${k.ratio_median.toFixed(3)}</b>，<b>${(k.share_ge1 * 100).toFixed(1)}%</b> 的井跑赢基线。</li>
      <li>模型把可判井压到 <b>19 口</b>（精确率 ${(DATA.confusion.matrix.green.precision * 100).toFixed(0)}%），不确定的井显式标成待定 / 不可判。</li>
      <li>同等预算下 AI 组合期望 NPV <b>${nf(k.ai_npv, 1)} 万元</b>，是随机选井的 <b>${(k.ai_npv / DATA.strategies[3].expected_npv).toFixed(1)} 倍</b>。</li>
      <li>三条基线：老师傅 regret ${nf(k.regret_expert, 0)} 万、历史回放 ${nf(k.regret_hist, 0)} 万、随机 ${nf(k.regret_random, 0)} 万。</li>
    </ul>
  </div>
  <div class="blk">
    <div class="blk-h">推荐施工 · 3 口（单井点估计）</div>
    <div class="tbl">
      <div class="tr hd" style="grid-template-columns:1fr 92px 58px"><span>井</span><span style="text-align:right">单井 NPV</span><span style="text-align:right">状态</span></div>
      ${picks.map((w) => `<div class="tr" style="grid-template-columns:1fr 92px 58px">
        <span class="nm">${w.name}<em style="margin-left:6px">${w.id.slice(-4)}</em></span>
        <b>${nf(w.npv, 0)}</b><b style="color:#8fb3c0">${STATE_CN[w.state] || '—'}</b>
      </div>`).join('')}
    </div>
    <div class="note" style="margin-top:8px">组合级期望 NPV 为组合口径（含组合层调整），不与单井点估计直接相加。</div>
  </div>
  <div class="blk">
    <div class="blk-h">风险与边界</div>
    <div class="row"><span>组合亏损概率</span><b>${(ai.loss_prob * 100).toFixed(2)}%</b></div>
    <div class="row"><span>尾部损失 CVaR₅</span><b>${nf(Math.abs(ai.cvar), 1)} 万元</b></div>
    <div class="row"><span>组合命中率</span><b>${(ai.hit_rate * 100).toFixed(1)}%</b></div>
    <div class="note" style="margin-top:8px">数据为 COGCC / ECMC 公开井史（2014-09 ~ 2024-08），事件定义为 COGIS Form 5A 完井 / 再完井。三维设备为行业通用型号示意资产，非本井实物。</div>
  </div>`
}

function renderModel() {
  const met = DATA.metrics || {}
  const keys = Object.keys(met)
  return `
  <div class="blk">
    <div class="blk-h">折外表现 · 77 事件</div>
    <div class="tbl">
      <div class="tr hd" style="grid-template-columns:1fr 58px 58px 54px"><span>模型</span><span style="text-align:right">sMAPE</span><span style="text-align:right">MAE</span><span style="text-align:right">skill</span></div>
      ${keys.map((k) => {
        const m = met[k]
        const s = m.smape ?? m.smape_median
        return `<div class="tr" style="grid-template-columns:1fr 58px 58px 54px">
          <span class="nm">${k}</span><b>${s != null ? s.toFixed(1) : '—'}</b>
          <b>${m.mae_m3d != null ? m.mae_m3d.toFixed(2) : '—'}</b>
          <b>${m.skill_vs_flat != null ? m.skill_vs_flat.toFixed(2) : '—'}</b>
        </div>`
      }).join('')}
    </div>
    <div class="note" style="margin-top:10px">主力模型 LSDRT-v2：sMAPE ${(met['LSDRT-v2']?.smape ?? 0).toFixed(1)}，相对持平基线 skill ${(met['LSDRT-v2']?.skill_vs_flat ?? 0).toFixed(2)}。</div>
  </div>
  <div class="blk">
    <div class="blk-h">共形区间</div>
    <div class="row"><span>目标覆盖率</span><b>${DATA.intervals.target_coverage}</b></div>
    <div class="row"><span>q90 · 中位相对半宽</span><b>${DATA.q90.median.toFixed(2)}</b></div>
    <div class="row"><span>q90 · 上界分位范围</span><b>${DATA.q90.min.toFixed(1)} – ${DATA.q90.max.toFixed(1)}</b></div>
    <div class="row"><span>下界截零比例</span><b>${(DATA.intervals.frac_lower_clipped * 100).toFixed(0)}%</b></div>
  </div>
  <div class="blk">
    <div class="blk-h">已知局限</div>
    <ul class="bul">
      <li>仅 77 口井、单县、10 年，跨区未验证。</li>
      <li>无层位 / 渗透率 / 施工参数，特征只有产量时序。</li>
      <li>零产几乎不可预测：折外 Brier 仅改善 3.17%。</li>
      <li>无实时数据通道，做的是历史回放。</li>
    </ul>
  </div>`
}

function renderEvidence() {
  const ps = DATA.passport.slice(0, 16)
  return `
  <div class="blk">
    <div class="blk-h">证据护照 · ${DATA.passport.length} 条受控指标</div>
    <div class="tbl">
      ${ps.map((p) => `<div class="tr" style="grid-template-columns:1fr 86px"><span class="nm" title="${p.formula || ''}">${p.label}</span><b>${p.value}${p.unit ? ' ' + p.unit : ''}</b></div>`).join('')}
    </div>
  </div>
  <div class="blk">
    <div class="blk-h">来源</div>
    <div class="note">指标均带公式、样本量与源文件，可在 04_数据/ 下按公式复算。数据快照 2022-03-23（井位）+ 2024-08（产量），模型版本 ${DATA.meta.model}。</div>
  </div>`
}

/* ==========================================================================
   交互
   ========================================================================== */
function focusWell(id) {
  const m = world.wellMarkers.find((x) => x.id === id)
  if (!m) return
  const pos = new THREE.Vector3(m.x + 34, m.y + 22, m.z + 44)
  const tgt = new THREE.Vector3(m.x, m.y - 2, m.z)
  flyTo(pos, tgt, 1500)
  focusShadow(m.x, m.z, 150)
}

$$('.dk').forEach((b) => b.addEventListener('click', () => {
  if (openMod === b.dataset.mod) closeDrawer()
  else openModule(b.dataset.mod)
}))
$$('[data-mod]').forEach((b) => {
  if (b.classList.contains('dk')) return
  b.addEventListener('click', () => openModule(b.dataset.mod))
})
$('#dr-close').addEventListener('click', closeDrawer)

$('#immerse').addEventListener('click', () => document.body.classList.toggle('immersed'))
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (document.body.classList.contains('immersed')) document.body.classList.remove('immersed')
    else if (openMod) closeDrawer()
  }
})

$$('.ly').forEach((b) => b.addEventListener('click', () => {
  if (b.dataset.act === 'reset') {
    flyTo(VIEWS.overview.pos, VIEWS.overview.tgt, 1400)
    focusShadow(60, 200, 560)
    return
  }
  const on = !b.classList.contains('on')
  b.classList.toggle('on', on)
  const layer = b.dataset.layer
  if (layer === 'labels') layerEl.style.display = on ? '' : 'none'
  else world.setLayer(layer, on)
}))

$('#month').addEventListener('input', (e) => setMonth(Number(e.target.value)))
$('#play').addEventListener('click', () => {
  playing = !playing
  $('#play').classList.toggle('playing', playing)
})
$$('.sp').forEach((b) => b.addEventListener('click', () => {
  speed = Number(b.dataset.sp)
  $$('.sp').forEach((x) => x.classList.toggle('on', x === b))
}))

$('#login-form').addEventListener('submit', (e) => {
  e.preventDefault()
  const btn = $('#enter')
  btn.disabled = true
  btn.querySelector('span').textContent = '正在接入井区…'
  setTimeout(() => {
    document.body.classList.remove('at-login')
    $('#login').classList.add('out')
    const hud = $('#hud')
    hud.classList.remove('hidden')
    requestAnimationFrame(() => hud.classList.add('in'))
    setTimeout(() => {
      if (camOverride && tgtOverride) {
        camera.position.set(camOverride[0], camOverride[1], camOverride[2])
        controls.target.set(tgtOverride[0], tgtOverride[1], tgtOverride[2])
      } else {
        flyTo(VIEWS.overview.pos, VIEWS.overview.tgt, 3200)
      }
      setTimeout(() => { drawProd(); drawDonut() }, 60)
      setTimeout(() => { drawProd(); drawDonut(); drawMap() }, 520)
      setTimeout(() => { controls.autoRotate = true }, 3400)
    }, 260)
  }, 700)
})

/* ==========================================================================
   主循环
   ========================================================================== */
const clock = new THREE.Clock()
let frames = 0, acc = 0

function updateLabels() {
  if (layerEl.style.display === 'none') return
  const W = innerWidth, H = innerHeight
  for (const L of labels) {
    tmpV.copy(L.pos).project(camera)
    if (tmpV.z > 1 || tmpV.z < -1) { L.el.style.opacity = '0'; continue }
    const x = (tmpV.x * 0.5 + 0.5) * W
    const y = (-tmpV.y * 0.5 + 0.5) * H
    const edge = x < 318 || x > W - 330 || y < 70 || y > H - 118
    L.el.style.opacity = edge ? '0' : (L.type === 'tag' ? '0.85' : '1')
    L.el.style.transform = L.type === 'tag'
      ? `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0) translate(-50%,-50%)`
      : `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0) translate(-50%,-100%)`
  }
}

function loop() {
  const dt = Math.min(clock.getDelta(), 0.1)
  const t = clock.elapsedTime

  if (playing) {
    playAcc += dt * speed
    if (playAcc > 1.1) {
      playAcc = 0
      setMonth(month >= 12 ? 1 : month + 1)
    }
  }

  if (camAnim) {
    camAnim.t += dt * 1000
    const k = Math.min(1, camAnim.t / camAnim.ms)
    const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2
    camera.position.lerpVectors(camAnim.fromP, camAnim.toP, e)
    controls.target.lerpVectors(camAnim.fromT, camAnim.toT, e)
    if (k >= 1) camAnim = null
  }
  controls.update()

  sky.update(t)
  world.update(dt, t)
  updateLabels()
  if (t - mm.last > 0.2) { mm.last = t; drawMap() }
  renderer.render(scene, camera)

  frames++
  acc += dt
  if (acc > 1) {
    window.__stats = { fps: Math.round(frames / acc), tris: renderer.info.render.triangles, calls: renderer.info.render.calls }
    frames = 0
    acc = 0
  }
  requestAnimationFrame(loop)
}

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight
  camera.updateProjectionMatrix()
  renderer.setSize(innerWidth, innerHeight, false)
  drawProd()
  drawDonut()
  drawMap()
})

/* ==========================================================================
   启动
   ========================================================================== */
function clockTick() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  $('#clock').textContent = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  $('#today').textContent = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}
setInterval(clockTick, 1000)
clockTick()

initHud()
makeLabels()
setTimeout(makeLabels, 800)
loop()

if (params.get('auto') === '1') {
  setTimeout(() => $('#login-form').dispatchEvent(new Event('submit', { cancelable: true })), 400)
}

window.__world = { scene, camera, controls, terrain, layout, renderer, world, focusShadow, setMonth }
