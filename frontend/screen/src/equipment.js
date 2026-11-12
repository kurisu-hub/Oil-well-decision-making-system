/* ==========================================================================
   设备资产库 · 程序化高精度模型（米制，Z 轴向上建模后统一转为 Y-up）
   目标：在 300–800 px 的屏幕上仍能读出「抽油机 / 井口 / 储罐」的结构
   ========================================================================== */
import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'

const V3 = (x, y, z) => new THREE.Vector3(x, y, z)

/* ---------------- 材质库（全局复用，减少 shader 编译） ---------------- */
const MAT = {
  paint: new THREE.MeshStandardMaterial({ color: 0x8b9a9d, roughness: 0.6, metalness: 0.22 }),
  paintLight: new THREE.MeshStandardMaterial({ color: 0x707c7d, roughness: 0.64, metalness: 0.2 }),
  paintDark: new THREE.MeshStandardMaterial({ color: 0x33454d, roughness: 0.7, metalness: 0.28 }),
  galv: new THREE.MeshStandardMaterial({ color: 0x93a4a8, roughness: 0.5, metalness: 0.45 }),
  steel: new THREE.MeshStandardMaterial({ color: 0x6f7d83, roughness: 0.45, metalness: 0.6 }),
  red: new THREE.MeshStandardMaterial({ color: 0xa33b2c, roughness: 0.52, metalness: 0.25 }),
  yellow: new THREE.MeshStandardMaterial({ color: 0xc9a03a, roughness: 0.55, metalness: 0.2 }),
  concrete: new THREE.MeshStandardMaterial({ color: 0x4b4b45, roughness: 0.97, metalness: 0.02 }),
  dark: new THREE.MeshStandardMaterial({ color: 0x1d2a30, roughness: 0.85, metalness: 0.15 }),
  rubber: new THREE.MeshStandardMaterial({ color: 0x14191c, roughness: 0.95, metalness: 0.05 }),
  glass: new THREE.MeshStandardMaterial({ color: 0xffc98a, emissive: 0xffb35c, emissiveIntensity: 1.0, roughness: 0.3, metalness: 0 }),
  lampGlass: new THREE.MeshStandardMaterial({ color: 0xfff0d0, emissive: 0xffe1a8, emissiveIntensity: 3.2, roughness: 0.2, metalness: 0 }),
  white: new THREE.MeshStandardMaterial({ color: 0xd8dcd6, roughness: 0.5, metalness: 0.1 }),
}

/* ---------------- 几何工具 ---------------- */
function addBox(list, w, h, d, mat, pos, rot) {
  const g = new THREE.BoxGeometry(w, h, d)
  apply(g, pos, rot)
  list.push({ g, m: mat })
}
function addRound(list, w, h, d, r, mat, pos, rot) {
  const g = new RoundedBoxGeometry(w, h, d, 2, r)
  apply(g, pos, rot)
  list.push({ g, m: mat })
}
function addCyl(list, rt, rb, h, seg, mat, pos, rot) {
  const g = new THREE.CylinderGeometry(rt, rb, h, seg)
  apply(g, pos, rot)
  list.push({ g, m: mat })
}
function addSphere(list, r, mat, pos, seg = 10) {
  const g = new THREE.SphereGeometry(r, seg, Math.max(6, seg >> 1))
  apply(g, pos)
  list.push({ g, m: mat })
}
/** 两点之间的圆管（支撑、栏杆、拉筋） */
function addRod(list, a, b, r, mat, seg = 6) {
  const dir = V3(b.x - a.x, b.y - a.y, b.z - a.z)
  const len = dir.length()
  if (len < 1e-4) return
  const g = new THREE.CylinderGeometry(r, r, len, seg)
  const q = new THREE.Quaternion().setFromUnitVectors(V3(0, 1, 0), dir.normalize())
  g.applyQuaternion(q)
  g.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2)
  list.push({ g, m: mat })
}
function apply(g, pos, rot) {
  if (rot) g.rotateX(rot[0] || 0), g.rotateY(rot[1] || 0), g.rotateZ(rot[2] || 0)
  if (pos) g.translate(pos[0] || 0, pos[1] || 0, pos[2] || 0)
}
/** 按「表面类型」合并：金属 / 混凝土 / 暗件 / 自发光，控制 draw call */
const FINISH = new Map([
  [MAT.paint, 'metal'], [MAT.paintLight, 'metal'], [MAT.paintDark, 'metal'],
  [MAT.galv, 'metal'], [MAT.steel, 'metal'], [MAT.red, 'metal'],
  [MAT.yellow, 'metal'], [MAT.white, 'metal'],
  [MAT.concrete, 'concrete'],
  [MAT.dark, 'dark'], [MAT.rubber, 'dark'],
  [MAT.glass, 'emit'], [MAT.lampGlass, 'emit'],
])
const FINISH_MAT = {
  metal: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.58, metalness: 0.3 }),
  concrete: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.96, metalness: 0.02 }),
  dark: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.84, metalness: 0.12 }),
  emit: new THREE.MeshStandardMaterial({ vertexColors: true, emissive: 0xffc078, emissiveIntensity: 1.1, roughness: 0.35, metalness: 0 }),
}
function bake(list) {
  const buckets = { metal: [], concrete: [], dark: [], emit: [] }
  for (const { g, m } of list) {
    const ng = g.index ? g.toNonIndexed() : g
    if (ng !== g) g.dispose()
    const col = m.color || new THREE.Color(0xffffff)
    const n = ng.attributes.position.count
    const arr = new Float32Array(n * 3)
    for (let i = 0; i < n; i++) { arr[i * 3] = col.r; arr[i * 3 + 1] = col.g; arr[i * 3 + 2] = col.b }
    ng.setAttribute('color', new THREE.BufferAttribute(arr, 3))
    buckets[FINISH.get(m) || 'metal'].push(ng)
  }
  const group = new THREE.Group()
  for (const key of Object.keys(buckets)) {
    const gs = buckets[key]
    if (!gs.length) continue
    const merged = gs.length > 1 ? mergeGeometries(gs, false) : gs[0]
    if (!merged) { console.warn('merge failed', key); continue }
    const mesh = new THREE.Mesh(merged, FINISH_MAT[key])
    mesh.castShadow = key !== 'emit'
    mesh.receiveShadow = true
    group.add(mesh)
    if (gs.length > 1) gs.forEach((g) => g.dispose())
  }
  return group
}
function arcShape(rOut, rIn, a0, a1, steps = 22) {
  const s = new THREE.Shape()
  for (let i = 0; i <= steps; i++) {
    const a = a0 + ((a1 - a0) * i) / steps
    const p = [Math.cos(a) * rOut, Math.sin(a) * rOut]
    i ? s.lineTo(p[0], p[1]) : s.moveTo(p[0], p[1])
  }
  for (let i = steps; i >= 0; i--) {
    const a = a0 + ((a1 - a0) * i) / steps
    s.lineTo(Math.cos(a) * rIn, Math.sin(a) * rIn)
  }
  s.closePath()
  return s
}

/* ==========================================================================
   抽油机（游梁式，C-320 级：长 9.1m / 高 7.6m / 宽 2.5m）
   本地坐标：X 向前（驴头方向），Z 为宽度，Y 向上，原点在底座中心
   ========================================================================== */
export function makePumpjack() {
  const S = []          // 静态件
  const L = 0.28        // 主钢梁厚

  /* --- 混凝土基础 --- */
  addRound(S, 9.4, 0.34, 2.9, 0.05, MAT.concrete, [0.2, 0.17, 0])

  /* --- 底座撬架（工字梁 + 横撑 + 地脚） --- */
  for (const z of [-1.0, 1.0]) {
    addBox(S, 8.6, 0.3, 0.22, MAT.paintDark, [0, 0.5, z])
    addBox(S, 8.6, 0.1, 0.5, MAT.paintDark, [0, 0.36, z])
    for (const x of [-3.9, -1.3, 1.3, 3.9]) addBox(S, 0.36, 0.12, 0.6, MAT.dark, [x, 0.3, z])
  }
  for (const x of [-3.6, -0.6, 2.2, 3.6]) addBox(S, 0.2, 0.22, 2.1, MAT.paintDark, [x, 0.52, 0])

  /* --- 支架（Samson post）：两条 A 形腿 + 交叉拉筋 --- */
  const footF = [-1.55, 0.62, 0.0]
  const apex = [0.15, 6.15, 0]
  for (const z of [-0.92, 0.92]) {
    const foot = V3(-1.5, 0.62, z)
    const top = V3(0.15, 6.15, z * 0.3)
    addRod(S, foot, top, 0.11, MAT.paint, 8)
    // 第二根后腿，形成 A 形
    const back = V3(-2.9, 0.62, z)
    addRod(S, back, V3(0.15, 5.4, z * 0.3), 0.085, MAT.paint, 6)
    addRod(S, foot, back, 0.07, MAT.paintDark, 6)
  }
  // 横向拉筋
  for (const y of [2.0, 3.6, 5.2]) {
    const k = (y - 0.62) / (6.15 - 0.62)
    const x = -1.5 + (0.15 + 1.5) * k
    const zz = 0.92 - 0.92 * 0.7 * k
    addRod(S, V3(x, y, -zz), V3(x, y, zz), 0.055, MAT.paintDark, 6)
  }
  // 斜撑
  for (const s of [-1, 1]) {
    addRod(S, V3(-2.6, 0.62, 0.92 * s), V3(-0.9, 3.4, 0.92 * s), 0.05, MAT.paintDark, 5)
  }

  /* --- 顶部轴承座 --- */
  addBox(S, 1.5, 0.42, 0.5, MAT.paintDark, [0.15, 6.22, 0])
  addCyl(S, 0.3, 0.3, 1.35, 16, MAT.steel, [0.15, 6.22, 0], [Math.PI / 2, 0, 0])

  /* --- 驴头 + 游梁（动态组，绕轴承中心摆动） --- */
  const beam = new THREE.Group()
  beam.position.set(0.15, 6.22, 0)

  const BS = []
  // 游梁主体：前后两段（前段略向上翘）
  addBox(BS, 5.6, 0.46, 0.64, MAT.paint, [0.25, 0, 0])
  addBox(BS, 0.7, 0.58, 0.62, MAT.paintDark, [3.0, 0.02, 0])
  // 游梁端部加强
  addBox(BS, 0.6, 0.5, 0.6, MAT.paintDark, [2.85, 0, 0])
  // 尾部配重梁
  addBox(BS, 0.55, 0.46, 0.66, MAT.paintDark, [-2.72, -0.02, 0])

  // 驴头：厚月牙板（凸面朝前，开口朝后）
  const hhShape = arcShape(1.06, 0.40, -1.06, 1.06, 26)
  const hhGeo = new THREE.ExtrudeGeometry(hhShape, { depth: 0.62, bevelEnabled: true, bevelSize: 0.025, bevelThickness: 0.025, bevelSegments: 1, curveSegments: 3 })
  hhGeo.translate(0, 0, -0.31)
  hhGeo.translate(3.12, 0, 0)
  BS.push({ g: hhGeo, m: MAT.paint })
  // 驴头两侧夹板
  for (const z of [-0.33, 0.33]) {
    const side = new THREE.ExtrudeGeometry(arcShape(1.10, 0.36, -1.12, 1.12, 22), { depth: 0.04, bevelEnabled: false })
    side.translate(0, 0, z - 0.02)
    side.translate(3.12, 0, 0)
    BS.push({ g: side, m: MAT.paintDark })
  }
  // 游梁与驴头之间的连接颈（只保留细颈，避免填满月牙）
  addBox(BS, 0.34, 0.34, 0.58, MAT.paint, [3.34, 0, 0])
  // 外缘包边
  for (const z of [-0.31, 0.31]) {
    const ring = arcShape(1.11, 1.05, -1.10, 1.10, 20)
    const g = new THREE.ExtrudeGeometry(ring, { depth: 0.03, bevelEnabled: false })
    g.translate(3.12, 0, z)
    BS.push({ g, m: MAT.paintDark })
  }

  beam.add(bake(BS))

  /* --- 曲柄 + 平衡块（动态，绕减速箱输出轴旋转） --- */
  const crank = new THREE.Group()
  const CKS = []
  const shaft = V3(-1.45, 1.55, 0)
  // 曲柄臂
  for (const z of [-1.18, 1.18]) {
    addBox(CKS, 0.36, 2.6, 0.2, MAT.paintDark, [0, 0.5, z])
    addCyl(CKS, 0.24, 0.24, 0.26, 12, MAT.steel, [0, -0.6, z])
  }
  // 平衡块（两块厚板，装在曲柄外侧）
  for (const z of [-1.4, 1.4]) {
    addRound(CKS, 1.55, 2.0, 0.34, 0.22, MAT.paintDark, [-0.18, 0.62, z])
    addBox(CKS, 1.15, 0.1, 0.36, MAT.paint, [-0.18, 0.62, z])
  }
  // 曲柄销
  addCyl(CKS, 0.14, 0.14, 2.35, 10, MAT.steel, [0, 1.55, 0], [Math.PI / 2, 0, 0])
  crank.position.copy(shaft)
  crank.add(bake(CKS))

  /* --- 减速箱 / 电机 / 皮带罩 --- */
  const DS = []
  addRound(DS, 1.5, 1.35, 1.05, 0.06, MAT.paint, [-1.45, 1.55, 0])
  addBox(DS, 1.6, 0.16, 1.15, MAT.paintDark, [-1.45, 2.25, 0])
  addCyl(DS, 0.1, 0.1, 0.5, 8, MAT.steel, [-1.45, 1.55, 0.6], [Math.PI / 2, 0, 0])
  // 电机
  addCyl(DS, 0.34, 0.34, 1.05, 14, MAT.paintDark, [-2.65, 0.95, 0.62], [0, 0, Math.PI / 2])
  addCyl(DS, 0.38, 0.38, 0.1, 14, MAT.dark, [-3.18, 0.95, 0.62], [0, 0, Math.PI / 2])
  addBox(DS, 1.0, 0.5, 0.5, MAT.paintDark, [-2.65, 0.62, 0.62])
  // 皮带罩
  addRound(DS, 1.1, 0.85, 0.35, 0.14, MAT.paintDark, [-2.0, 1.05, 0.62])

  /* --- 平台 / 爬梯 / 护栏（支架侧面） --- */
  for (const z of [-0.55, 0.55]) {
    addRod(DS, V3(-1.05, 0.62, z), V3(-1.05, 5.6, z), 0.035, MAT.galv, 5)
  }
  for (let y = 1.0; y < 5.6; y += 0.34) addRod(DS, V3(-1.05, y, -0.55), V3(-1.05, y, 0.55), 0.022, MAT.galv, 4)
  // 爬梯扶手
  for (const z of [-0.62, 0.62]) {
    addRod(DS, V3(-1.05, 0.62, z), V3(-1.05, 4.6, z), 0.026, MAT.galv, 4)
  }

  /* --- 井口光杆 / 悬绳器 --- */
  const rod = new THREE.Group()
  const RS = []
  addBox(RS, 0.9, 0.12, 0.22, MAT.steel, [0, 0, 0])
  addCyl(RS, 0.045, 0.045, 2.7, 8, MAT.galv, [0, -1.35, 0])
  addBox(RS, 0.16, 0.18, 0.16, MAT.paintDark, [0, 0.14, 0])
  rod.add(bake(RS))
  rod.position.set(3.72, 4.6, 0)

  // 悬绳（两根钢丝绳，从驴头两角到悬绳器）
  const bridle = new THREE.Group()

  /* --- 组装 --- */
  const g = new THREE.Group()
  const statics = bake(S)
  const dyn = bake(DS)
  g.add(statics, dyn, beam, crank, rod, bridle)
  g.userData.parts = { beam, crank, rod }
  g.userData.anchor = { x: 3.72, y: 6.22, z: 0 }   // 驴头枢轴（用于动效）

  // 把静态组统一抬到底座平面
  g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true } })
  return g
}

/* ==========================================================================
   井口 / 采油树（总高 2.35m）
   ========================================================================== */
export function makeWellhead() {
  const S = []
  addRound(S, 1.55, 0.22, 1.55, 0.03, MAT.concrete, [0, 0.11, 0])

  // 套管头 → 油管头 → 主阀 → 四通
  addCyl(S, 0.30, 0.30, 0.16, 18, MAT.steel, [0, 0.30, 0])
  addCyl(S, 0.19, 0.19, 0.46, 16, MAT.steel, [0, 0.60, 0])
  addCyl(S, 0.34, 0.34, 0.10, 18, MAT.galv, [0, 0.86, 0])
  addCyl(S, 0.24, 0.24, 0.18, 16, MAT.steel, [0, 1.00, 0])
  addCyl(S, 0.32, 0.32, 0.09, 18, MAT.galv, [0, 1.14, 0])
  // 法兰螺栓
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2
    addCyl(S, 0.026, 0.026, 0.14, 5, MAT.dark, [Math.cos(a) * 0.28, 1.14, Math.sin(a) * 0.28])
  }
  // 主阀体 + 手轮
  addRound(S, 0.34, 0.46, 0.34, 0.05, MAT.paintDark, [0, 1.40, 0])
  addCyl(S, 0.06, 0.06, 0.42, 8, MAT.steel, [0.36, 1.40, 0], [0, 0, Math.PI / 2])
  addCyl(S, 0.24, 0.24, 0.035, 20, MAT.red, [0.60, 1.40, 0], [0, 0, Math.PI / 2])
  for (let i = 0; i < 2; i++) {
    addBox(S, 0.04, 0.6, 0.03, MAT.red, [0.62, 1.40, 0], [0, 0, (i / 2) * Math.PI])
  }
  // 四通 + 翼阀
  addRound(S, 0.30, 0.30, 0.30, 0.04, MAT.steel, [0, 1.72, 0])
  addCyl(S, 0.12, 0.12, 0.7, 12, MAT.steel, [0, 1.72, 0.35], [Math.PI / 2, 0, 0])
  addCyl(S, 0.21, 0.21, 0.032, 18, MAT.red, [0, 1.72, 0.72], [Math.PI / 2, 0, 0])
  // 压力表（带支管）
  addCyl(S, 0.035, 0.035, 0.5, 8, MAT.galv, [-0.28, 1.92, 0], [0, 0, Math.PI / 2])
  addCyl(S, 0.12, 0.12, 0.055, 14, MAT.white, [-0.53, 1.92, 0], [0, 0, Math.PI / 2])
  addCyl(S, 0.13, 0.13, 0.045, 14, MAT.paintDark, [-0.57, 1.92, 0], [0, 0, Math.PI / 2])
  // 顶部丝堵
  addCyl(S, 0.13, 0.13, 0.2, 12, MAT.galv, [0, 1.98, 0])

  const g = bake(S)
  g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true } })
  return g
}

/* ==========================================================================
   拱顶储罐（9.1m 直径 × 9.1m 高，带螺旋梯 + 顶部护栏 + 罐顶附件）
   ========================================================================== */
export function makeTank() {
  const S = []
  const R = 4.55
  const H = 9.0
  addRound(S, 10.4, 0.28, 10.4, 0.08, MAT.concrete, [0, 0.14, 0])

  // 罐壁（分四圈，圈间加环缝）
  addCyl(S, R, R, H, 40, MAT.paintLight, [0, 0.28 + H / 2, 0])
  for (let i = 1; i < 4; i++) {
    addCyl(S, R + 0.035, R + 0.035, 0.05, 40, MAT.paintDark, [0, 0.28 + (H / 4) * i, 0])
  }
  // 罐底圈梁
  addCyl(S, R + 0.09, R + 0.09, 0.22, 40, MAT.paintDark, [0, 0.39, 0])

  // 锥顶
  const roof = new THREE.ConeGeometry(R + 0.22, 0.95, 40)
  roof.translate(0, 0.28 + H + 0.45, 0)
  S.push({ g: roof, m: MAT.paintLight })
  addCyl(S, R + 0.24, R + 0.24, 0.09, 40, MAT.paintDark, [0, 0.28 + H + 0.02, 0])
  // 罐顶附件
  addCyl(S, 0.30, 0.30, 0.35, 12, MAT.steel, [1.1, 9.6, 1.0])
  addCyl(S, 0.42, 0.42, 0.06, 14, MAT.galv, [1.1, 9.78, 1.0])
  addCyl(S, 0.06, 0.06, 1.4, 8, MAT.galv, [-1.4, 9.8, -0.8])

  // 顶部护栏
  for (let i = 0; i < 28; i++) {
    const a = (i / 28) * Math.PI * 2
    const x = Math.cos(a) * (R + 0.02)
    const z = Math.sin(a) * (R + 0.02)
    addCyl(S, 0.025, 0.025, 0.72, 5, MAT.galv, [x, 9.3 + 0.36, z])
  }
  for (const y of [9.98, 10.28]) {
    const pts = []
    for (let i = 0; i <= 40; i++) {
      const a = (i / 40) * Math.PI * 2
      pts.push(V3(Math.cos(a) * (R + 0.02), y, Math.sin(a) * (R + 0.02)))
    }
    for (let i = 0; i < pts.length - 1; i++) addRod(S, pts[i], pts[i + 1], 0.022, MAT.galv, 4)
  }

  // 螺旋梯（每 22° 一级，绕 330°）
  const treads = 26
  const a0 = -0.35
  const turns = 2.1
  const y0 = 0.55
  const y1 = H + 0.1
  const prev = []
  for (let i = 0; i <= treads; i++) {
    const t = i / treads
    const a = a0 + t * Math.PI * 2 * turns
    const y = y0 + (y1 - y0) * t
    const x = Math.cos(a) * (R + 0.55)
    const z = Math.sin(a) * (R + 0.55)
    addBox(S, 0.9, 0.05, 0.3, MAT.galv, [x, y, z], [0, -a, 0])
    // 外侧扶手立柱
    if (i % 2 === 0) addCyl(S, 0.022, 0.022, 1.0, 5, MAT.galv, [Math.cos(a) * (R + 0.98), y + 0.5, Math.sin(a) * (R + 0.98)])
    prev.push({ a, y })
  }
  // 外侧扶手（两道）
  for (const dy of [0.55, 1.0]) {
    for (let i = 0; i < prev.length - 1; i++) {
      const p = prev[i], q = prev[i + 1]
      addRod(S,
        V3(Math.cos(p.a) * (R + 0.98), p.y + dy, Math.sin(p.a) * (R + 0.98)),
        V3(Math.cos(q.a) * (R + 0.98), q.y + dy, Math.sin(q.a) * (R + 0.98)),
        0.022, MAT.galv, 4)
    }
  }
  // 螺旋梯外侧斜梁
  for (let i = 0; i < prev.length - 1; i++) {
    const p = prev[i], q = prev[i + 1]
    addRod(S,
      V3(Math.cos(p.a) * (R + 0.98), p.y, Math.sin(p.a) * (R + 0.98)),
      V3(Math.cos(q.a) * (R + 0.98), q.y, Math.sin(q.a) * (R + 0.98)),
      0.03, MAT.paintDark, 4)
  }
  // 顶部平台
  addBox(S, 1.7, 0.08, 1.2, MAT.galv, [R + 0.55, H + 0.3, 0])

  // 罐壁人孔 + 接管
  addCyl(S, 0.32, 0.32, 0.10, 16, MAT.paintDark, [0, 1.4, R + 0.04], [Math.PI / 2, 0, 0])
  addCyl(S, 0.24, 0.24, 0.12, 14, MAT.paintDark, [0, 1.4, R + 0.10], [Math.PI / 2, 0, 0])
  addCyl(S, 0.16, 0.16, 1.1, 12, MAT.steel, [1.4, 0.9, R + 0.05], [Math.PI / 2, 0, 0])
  addCyl(S, 0.26, 0.26, 0.06, 14, MAT.galv, [1.4, 0.9, R + 0.6], [Math.PI / 2, 0, 0])

  const g = bake(S)
  g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true } })
  return g
}

/* ==========================================================================
   卧式分离器（1.2m × 5.2m）
   ========================================================================== */
export function makeSeparator() {
  const S = []
  const R = 0.62
  addRound(S, 6.2, 0.3, 2.2, 0.05, MAT.concrete, [0, 0.15, 0])
  // 筒体
  addCyl(S, R, R, 4.6, 22, MAT.paintLight, [0, 1.25, 0], [0, 0, Math.PI / 2])
  addSphere(S, R, MAT.paintLight, [2.3, 1.25, 0], 18)
  addSphere(S, R, MAT.paintLight, [-2.3, 1.25, 0], 18)
  // 鞍座
  for (const x of [-1.5, 1.5]) {
    addBox(S, 0.35, 0.7, 1.3, MAT.paintDark, [x, 0.62, 0])
  }
  // 接管
  addCyl(S, 0.16, 0.16, 0.5, 12, MAT.steel, [0.4, 1.95, 0])
  addCyl(S, 0.24, 0.24, 0.06, 14, MAT.galv, [0.4, 2.2, 0])
  addCyl(S, 0.14, 0.14, 1.2, 12, MAT.steel, [-1.6, 1.2, 0.9], [0, 0, 0])
  // 液位计
  addCyl(S, 0.06, 0.06, 1.1, 8, MAT.glass, [2.25, 2.2, 0])
  addCyl(S, 0.09, 0.09, 0.1, 8, MAT.galv, [2.25, 2.75, 0])
  // 铭牌
  addBox(S, 0.5, 0.28, 0.02, MAT.white, [0, 1.62, R + 0.02])

  const g = bake(S)
  g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true } })
  return g
}

/* ==========================================================================
   高杆灯 / 防爆灯
   ========================================================================== */
export function makeLamp(height = 18) {
  const S = []
  addRound(S, 1.1, 0.4, 1.1, 0.04, MAT.concrete, [0, 0.2, 0])
  addCyl(S, 0.28, 0.28, 0.16, 12, MAT.paintDark, [0, 0.48, 0])
  addCyl(S, 0.11, 0.17, height, 10, MAT.paint, [0, height / 2 + 0.4, 0])
  // 灯盘
  addBox(S, 1.9, 0.16, 0.7, MAT.paintDark, [0, height + 0.4, 0])
  for (const x of [-0.6, 0, 0.6]) {
    addBox(S, 0.34, 0.18, 0.5, MAT.lampGlass, [x, height + 0.28, 0])
    addBox(S, 0.4, 0.06, 0.56, MAT.paintDark, [x, height + 0.44, 0])
  }
  const g = bake(S)
  g.traverse((o) => { if (o.isMesh) { o.castShadow = true } })
  return g
}

/* ==========================================================================
   值班房 / 计量间（12m × 4.2m × 3.2m，带门窗与屋顶）
   ========================================================================== */
export function makeCabin() {
  const S = []
  addRound(S, 13.4, 0.5, 5.4, 0.05, MAT.concrete, [0, 0.25, 0])
  addRound(S, 12, 3.0, 4.2, 0.06, MAT.paintLight, [0, 2.0, 0])
  // 屋顶挑檐
  addRound(S, 12.9, 0.28, 4.9, 0.05, MAT.paintDark, [0, 3.65, 0])
  addRound(S, 12.4, 0.16, 4.5, 0.04, MAT.dark, [0, 3.86, 0])
  // 门窗
  for (const x of [-3.4, 2.2]) {
    addBox(S, 1.5, 1.1, 0.06, MAT.glass, [x, 2.35, 2.12])
    addBox(S, 1.66, 1.26, 0.04, MAT.paintDark, [x, 2.35, 2.09])
  }
  addBox(S, 1.2, 2.2, 0.08, MAT.paintDark, [4.6, 1.4, 2.12])
  addBox(S, 0.9, 0.06, 0.06, MAT.galv, [4.9, 1.2, 2.18])
  // 空调外机 + 管道
  addBox(S, 0.9, 0.6, 0.45, MAT.galv, [-5.0, 1.0, 2.4])
  addBox(S, 0.12, 2.8, 0.12, MAT.galv, [5.5, 1.9, 2.2])
  // 门廊灯
  addBox(S, 0.3, 0.18, 0.2, MAT.lampGlass, [4.6, 2.7, 2.2])

  const g = bake(S)
  g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true } })
  return g
}

/* ==========================================================================
   围栏（按段生成，含立柱 + 三道横杆 + 斜撑）
   ========================================================================== */
export function makeFence(points, height = 2.0) {
  const S = []
  for (let i = 0; i < points.length - 1; i++) {
    const a = V3(points[i][0], 0, points[i][1])
    const b = V3(points[i + 1][0], 0, points[i + 1][1])
    const len = a.distanceTo(b)
    const seg = Math.max(1, Math.round(len / 3.2))
    for (let k = 0; k <= seg; k++) {
      const t = k / seg
      const x = a.x + (b.x - a.x) * t
      const z = a.z + (b.z - a.z) * t
      addCyl(S, 0.045, 0.055, height, 6, MAT.steel, [x, height / 2, z])
    }
    for (const y of [0.45, 1.05, 1.8]) {
      addRod(S, V3(a.x, y, a.z), V3(b.x, y, b.z), 0.02, MAT.steel, 4)
    }
  }
  const g = bake(S)
  g.traverse((o) => { if (o.isMesh) o.castShadow = true })
  return g
}

/* ==========================================================================
   放空火炬（高度 16m，含塔架与火焰位）
   ========================================================================== */
export function makeFlare() {
  const S = []
  addRound(S, 2.6, 0.35, 2.6, 0.06, MAT.concrete, [0, 0.18, 0])
  addCyl(S, 0.22, 0.30, 16, 12, MAT.paintDark, [0, 8.2, 0])
  addCyl(S, 0.30, 0.30, 0.5, 12, MAT.steel, [0, 16.2, 0])
  // 三条斜撑
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2
    addRod(S, V3(Math.cos(a) * 1.1, 0.35, Math.sin(a) * 1.1), V3(Math.cos(a) * 0.25, 10.5, Math.sin(a) * 0.25), 0.05, MAT.paintDark, 5)
  }
  // 点火管
  addCyl(S, 0.04, 0.04, 14, 6, MAT.galv, [0.4, 7.5, 0])
  const g = bake(S)
  g.traverse((o) => { if (o.isMesh) { o.castShadow = true } })
  return g
}

/* ==========================================================================
   管排 / 阀组（集输区）
   ========================================================================== */
export function makeManifold() {
  const S = []
  addRound(S, 9.0, 0.3, 3.4, 0.05, MAT.concrete, [0, 0.15, 0])
  // 主管
  addCyl(S, 0.2, 0.2, 8.2, 14, MAT.steel, [0, 0.95, 0], [0, 0, Math.PI / 2])
  // 支管 + 阀门
  for (let i = 0; i < 4; i++) {
    const x = -3.2 + i * 2.1
    addCyl(S, 0.09, 0.09, 1.5, 10, MAT.steel, [x, 1.35, 0])
    addCyl(S, 0.15, 0.15, 0.24, 10, MAT.paintDark, [x, 1.55, 0])
    addCyl(S, 0.13, 0.13, 0.03, 12, MAT.red, [x, 1.62, 0.22], [Math.PI / 2, 0, 0])
    addBox(S, 0.26, 0.26, 0.26, MAT.galv, [x, 0.95, 0])
  }
  // 管墩
  for (const x of [-3.6, -1.2, 1.2, 3.6]) addBox(S, 0.4, 0.55, 0.7, MAT.concrete, [x, 0.48, 0])

  const g = bake(S)
  g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true } })
  return g
}
