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
  paint: new THREE.MeshStandardMaterial({ color: 0xa9b0a6, roughness: 0.66, metalness: 0.16 }),
  paintLight: new THREE.MeshStandardMaterial({ color: 0xa2ada7, roughness: 0.66, metalness: 0.18 }),
  paintDark: new THREE.MeshStandardMaterial({ color: 0x3c4a4a, roughness: 0.72, metalness: 0.26 }),
  galv: new THREE.MeshStandardMaterial({ color: 0x93a4a8, roughness: 0.5, metalness: 0.45 }),
  steel: new THREE.MeshStandardMaterial({ color: 0x6f7d83, roughness: 0.45, metalness: 0.6 }),
  red: new THREE.MeshStandardMaterial({ color: 0x9d3b28, roughness: 0.6, metalness: 0.2 }),
  yellow: new THREE.MeshStandardMaterial({ color: 0xc9a03a, roughness: 0.55, metalness: 0.2 }),
  concrete: new THREE.MeshStandardMaterial({ color: 0x8e8a7d, roughness: 0.97, metalness: 0.02 }),
  dark: new THREE.MeshStandardMaterial({ color: 0x2a3030, roughness: 0.85, metalness: 0.15 }),
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
function bake(list, tint) {
  const buckets = { metal: [], concrete: [], dark: [], emit: [], leaf: [] }
  for (const { g, m } of list) {
    const ng = g.index ? g.toNonIndexed() : g
    if (ng !== g) g.dispose()
    const col = (m.color || new THREE.Color(0xffffff)).clone()
    if (tint) col.multiplyScalar(tint)
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
export function makePumpjack(tint) {
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
  const statics = bake(S, tint)
  const dyn = bake(DS, tint)
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
export function makeTank(tint) {
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
  // 色带（工业储罐常见的中部标识带）
  addCyl(S, R + 0.02, R + 0.02, 1.15, 40, MAT.paintDark, [0, 0.28 + H * 0.66, 0])
  addCyl(S, R + 0.03, R + 0.03, 0.10, 40, MAT.galv, [0, 0.28 + H * 0.66 + 0.6, 0])
  addCyl(S, R + 0.03, R + 0.03, 0.10, 40, MAT.galv, [0, 0.28 + H * 0.66 - 0.6, 0])

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

  const g = bake(S, tint)
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

/* ==========================================================================
   以下为 twin 新增：轻型抽油机 / 电力线 / 管排 / 站房 / 装车 / 树木
   统一约定：原点在底座中心，X 朝前（驴头方向），Y 向上，米制
   ========================================================================== */

/* ---------- 轻型抽油机（远井场 LOD，保留可动部件） ---------- */
export function makePumpjackLite(tint = 1) {
  const S = []
  addBox(S, 8.4, 0.34, 2.3, MAT.concrete, [0, 0.17, 0])
  addBox(S, 7.8, 0.28, 0.26, MAT.paintDark, [0, 0.5, -0.85])
  addBox(S, 7.8, 0.28, 0.26, MAT.paintDark, [0, 0.5, 0.85])
  for (const x of [-3.2, -0.4, 2.6]) addBox(S, 0.22, 0.24, 1.9, MAT.paintDark, [x, 0.52, 0])
  // A 型支架
  for (const z of [-0.86, 0.86]) {
    addRod(S, V3(-1.5, 0.6, z), V3(0.1, 6.05, z * 0.32), 0.1, MAT.paint, 6)
    addRod(S, V3(-2.85, 0.6, z), V3(0.1, 5.35, z * 0.32), 0.075, MAT.paint, 5)
    addRod(S, V3(-1.5, 0.6, z), V3(-2.85, 0.6, z), 0.06, MAT.paintDark, 5)
  }
  addRod(S, V3(0.1, 5.2, -0.3), V3(0.1, 5.2, 0.3), 0.05, MAT.paintDark, 5)
  addRod(S, V3(-1.4, 3.1, -0.6), V3(-1.4, 3.1, 0.6), 0.045, MAT.paintDark, 5)
  // 减速箱 / 电机
  addRound(S, 1.35, 1.2, 1.0, 0.05, MAT.paint, [-1.45, 1.45, 0])
  addCyl(S, 0.3, 0.3, 0.9, 10, MAT.paintDark, [-2.55, 0.92, 0.55], [0, 0, Math.PI / 2])
  addRound(S, 0.9, 0.7, 0.3, 0.1, MAT.paintDark, [-2.0, 1.0, 0.55])

  const beam = new THREE.Group()
  const BS = []
  addBox(BS, 6.9, 0.55, 0.62, MAT.paint, [1.35, 0, 0])
  addBox(BS, 2.2, 0.5, 0.44, MAT.paint, [-2.4, 0, 0])
  // 驴头（弧面）
  const hh = new THREE.CylinderGeometry(1.35, 1.35, 0.72, 18, 1, false, -0.35, 2.2)
  hh.rotateX(Math.PI / 2)
  hh.translate(4.55, -0.4, 0)
  BS.push({ g: hh, m: MAT.paint })
  addBox(BS, 1.5, 0.42, 0.6, MAT.paintDark, [4.3, 0.1, 0])
  // 平衡块（尾端）
  addBox(BS, 1.1, 0.75, 1.1, MAT.paintDark, [-3.1, -0.1, 0])
  beam.add(bake(BS, tint))
  beam.position.set(0.1, 6.1, 0)

  const crank = new THREE.Group()
  const CS = []
  for (const z of [-1.05, 1.05]) {
    addCyl(CS, 0.75, 0.75, 0.16, 16, MAT.paintDark, [0, 0, z])
    addBox(CS, 0.5, 1.5, 0.2, MAT.paintDark, [0, 0.55, z * 0.9])
    addRound(CS, 0.9, 1.1, 0.3, 0.12, MAT.paintDark, [0, 0.85, z * 1.15])
  }
  addCyl(CS, 0.12, 0.12, 2.3, 8, MAT.steel, [0, 0.95, 0], [Math.PI / 2, 0, 0])
  crank.add(bake(CS, tint))
  crank.position.set(-1.45, 1.55, 0)

  const rod = new THREE.Group()
  const RS = []
  addBox(RS, 0.8, 0.1, 0.2, MAT.steel, [0, 0, 0])
  addCyl(RS, 0.04, 0.04, 2.4, 6, MAT.galv, [0, -1.2, 0])
  rod.add(bake(RS, tint))
  rod.position.set(4.55, 4.85, 0)

  const g = new THREE.Group()
  g.add(bake(S, tint), beam, crank, rod)
  g.userData.parts = { beam, crank, rod }
  g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true } })
  return g
}

/* ---------- 电力线杆（木杆 + 横担 + 绝缘子） ---------- */
export function makePowerPole(h = 11, withTransformer = false) {
  const S = []
  addCyl(S, 0.15, 0.22, h, 8, MAT.dark, [0, h / 2, 0])
  // 横担
  addBox(S, 2.6, 0.12, 0.14, MAT.dark, [0, h - 0.55, 0])
  addBox(S, 0.9, 0.1, 0.12, MAT.dark, [0, h - 1.5, 0])
  // 绝缘子
  for (const x of [-1.15, 0, 1.15]) {
    addCyl(S, 0.07, 0.09, 0.22, 6, MAT.white, [x, h - 0.36, 0])
    addCyl(S, 0.1, 0.1, 0.04, 6, MAT.white, [x, h - 0.46, 0])
  }
  // 斜撑
  addRod(S, V3(-1.15, h - 0.55, 0), V3(-0.15, h - 1.5, 0), 0.035, MAT.dark, 4)
  addRod(S, V3(1.15, h - 0.55, 0), V3(0.15, h - 1.5, 0), 0.035, MAT.dark, 4)
  if (withTransformer) {
    addCyl(S, 0.34, 0.34, 1.0, 12, MAT.paintLight, [0.55, h - 3.1, 0])
    addBox(S, 0.5, 0.06, 0.5, MAT.paintDark, [0.55, h - 3.65, 0])
    addCyl(S, 0.06, 0.06, 0.9, 6, MAT.dark, [0.95, h - 2.0, 0])
  }
  const g = bake(S)
  g.traverse((o) => { if (o.isMesh) o.castShadow = true })
  return g
}

/* ---------- 管排（钢架 + 多根管线） ---------- */
export function makePipeRack(len = 24, pipes = 5) {
  const S = []
  const bays = Math.max(2, Math.round(len / 6))
  for (let i = 0; i <= bays; i++) {
    const x = -len / 2 + (len / bays) * i
    for (const z of [-1.0, 1.0]) addBox(S, 0.18, 2.2, 0.18, MAT.paintDark, [x, 1.1, z])
    addBox(S, 0.16, 0.16, 2.3, MAT.paintDark, [x, 2.2, 0])
    addBox(S, 0.16, 0.16, 2.3, MAT.paintDark, [x, 1.55, 0])
  }
  for (let p = 0; p < pipes; p++) {
    const z = -0.75 + p * (1.5 / Math.max(1, pipes - 1))
    const y = 1.65 + (p % 2) * 0.55
    addCyl(S, 0.11, 0.11, len, 10, p % 3 === 0 ? MAT.paintLight : MAT.steel, [0, y, z], [0, 0, Math.PI / 2])
  }
  // 保温层外壳
  addCyl(S, 0.14, 0.14, len, 10, MAT.galv, [0, 2.24, 0.2], [0, 0, Math.PI / 2])
  const g = bake(S)
  g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true } })
  return g
}

/* ---------- 中控楼 / 值班房（14 × 7 × 4） ---------- */
export function makeControlRoom(tint = 1) {
  const S = []
  addRound(S, 15.6, 0.5, 8.4, 0.06, MAT.concrete, [0, 0.25, 0])
  addRound(S, 14, 3.4, 7, 0.06, MAT.white, [0, 2.2, 0])
  // 屋顶
  addRound(S, 14.9, 0.3, 7.9, 0.05, MAT.paintLight, [0, 4.05, 0])
  addBox(S, 14.9, 0.45, 0.22, MAT.paintLight, [0, 4.3, 3.85])
  addBox(S, 14.9, 0.45, 0.22, MAT.paintLight, [0, 4.3, -3.85])
  // 带形窗
  for (const x of [-4.4, -1.5, 1.4, 4.3]) {
    addBox(S, 2.3, 1.35, 0.08, MAT.dark, [x, 2.6, 3.52])
    addBox(S, 2.5, 1.5, 0.04, MAT.galv, [x, 2.6, 3.48])
  }
  // 门 + 雨棚
  addBox(S, 1.4, 2.5, 0.1, MAT.paintDark, [6.0, 1.5, 3.52])
  addBox(S, 2.2, 0.12, 1.2, MAT.galv, [6.0, 3.0, 3.95])
  addBox(S, 0.3, 0.16, 0.2, MAT.lampGlass, [6.0, 2.95, 3.6])
  // 空调 / 屋顶风机
  addBox(S, 1.2, 0.85, 0.8, MAT.galv, [2.4, 4.6, 1.4])
  addCyl(S, 0.42, 0.42, 0.5, 12, MAT.galv, [-3.4, 4.45, -0.6])
  // 天线
  addCyl(S, 0.05, 0.05, 4.2, 6, MAT.galv, [-5.4, 6.2, -1.6])
  addCyl(S, 0.03, 0.03, 1.6, 5, MAT.galv, [-5.4, 7.6, -1.6], [0, 0, 0.5])
  // 散水
  addBox(S, 15.8, 0.12, 0.5, MAT.concrete, [0, 0.08, 4.35])
  const g = bake(S, tint)
  g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true } })
  return g
}

/* ---------- 库房 / 车库（18 × 10 × 5.5，压型钢板） ---------- */
export function makeWarehouse(tint = 1) {
  const S = []
  addRound(S, 19.4, 0.4, 11.4, 0.05, MAT.concrete, [0, 0.2, 0])
  addBox(S, 18, 4.6, 10, MAT.paintLight, [0, 2.7, 0])
  // 竖向压型肋
  for (let x = -8.8; x <= 8.8; x += 0.9) {
    addBox(S, 0.1, 4.5, 0.08, MAT.galv, [x, 2.7, 5.03])
    addBox(S, 0.1, 4.5, 0.08, MAT.galv, [x, 2.7, -5.03])
  }
  // 双坡屋顶
  for (const s of [-1, 1]) {
    const r = new THREE.BoxGeometry(18.4, 1.9, 5.3)
    r.rotateX(s * 0.16)
    r.translate(0, 5.9, s * 2.6)
    S.push({ g: r, m: MAT.paintDark })
  }
  addBox(S, 18.6, 0.16, 0.3, MAT.galv, [0, 6.85, 0])
  // 卷帘门
  for (const x of [-4.6, 3.2]) {
    addBox(S, 4.2, 3.6, 0.12, MAT.paintDark, [x, 2.0, 5.04])
    for (let y = 0.4; y < 3.7; y += 0.28) addBox(S, 4.0, 0.05, 0.05, MAT.galv, [x, y, 5.12])
  }
  // 侧门 + 通风
  addBox(S, 1.0, 2.2, 0.1, MAT.paintDark, [7.4, 1.3, 5.04])
  addBox(S, 0.9, 0.9, 0.2, MAT.galv, [-8.6, 4.4, 4.0])
  const g = bake(S, tint)
  g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true } })
  return g
}

/* ---------- 压缩机撬（8 × 3.4 × 3.2） ---------- */
export function makeCompressor() {
  const S = []
  addRound(S, 8.6, 0.4, 3.8, 0.05, MAT.concrete, [0, 0.2, 0])
  addBox(S, 7.6, 0.3, 3.2, MAT.paintDark, [0, 0.5, 0])
  addRound(S, 7.2, 2.5, 3.0, 0.06, MAT.paintLight, [0, 1.9, 0])
  // 百叶
  for (let y = 0.9; y < 3.0; y += 0.24) addBox(S, 6.2, 0.08, 0.06, MAT.dark, [0, y, 1.53])
  // 电机 / 飞轮
  addCyl(S, 0.55, 0.55, 0.4, 14, MAT.paintDark, [-3.9, 1.15, 0], [0, 0, Math.PI / 2])
  // 进出口管
  addCyl(S, 0.18, 0.18, 2.6, 10, MAT.galv, [2.6, 3.4, 0.8])
  addCyl(S, 0.3, 0.3, 0.2, 12, MAT.galv, [2.6, 4.7, 0.8])
  addCyl(S, 0.14, 0.14, 3.4, 8, MAT.steel, [-2.4, 3.5, -0.7], [0, 0, Math.PI / 2])
  // 消音器
  addCyl(S, 0.42, 0.42, 1.8, 12, MAT.galv, [-4.4, 3.2, -0.7], [0, 0, Math.PI / 2])
  // 栏杆
  for (let x = -3.4; x <= 3.4; x += 1.1) addCyl(S, 0.03, 0.03, 1.0, 5, MAT.galv, [x, 3.55, 1.45])
  addCyl(S, 0.035, 0.035, 7.0, 5, MAT.galv, [0, 4.02, 1.45], [0, 0, Math.PI / 2])
  const g = bake(S)
  g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true } })
  return g
}

/* ---------- 装车鹤管台 ---------- */
export function makeLoadingRack() {
  const S = []
  addRound(S, 10, 0.3, 7, 0.05, MAT.concrete, [0, 0.15, 0])
  for (const x of [-3.6, 3.6]) for (const z of [-2.2, 2.2]) addCyl(S, 0.12, 0.12, 5.2, 8, MAT.paintDark, [x, 2.6, z])
  addBox(S, 9.2, 0.25, 6.2, MAT.paintLight, [0, 5.2, 0])
  addBox(S, 9.4, 0.35, 0.2, MAT.paintDark, [0, 5.45, 3.05])
  // 鹤管
  for (const x of [-2.4, 2.4]) {
    addCyl(S, 0.1, 0.1, 3.4, 8, MAT.galv, [x, 3.4, 1.2], [0.3, 0, 0])
    addCyl(S, 0.08, 0.08, 1.6, 8, MAT.steel, [x, 4.7, 2.2], [1.1, 0, 0])
  }
  // 梯子
  for (const z of [-0.2, 0.2]) addRod(S, V3(4.4, 0, z), V3(4.4, 5.2, z), 0.03, MAT.galv, 4)
  for (let y = 0.3; y < 5.2; y += 0.3) addRod(S, V3(4.4, y, -0.2), V3(4.4, y, 0.2), 0.02, MAT.galv, 4)
  const g = bake(S)
  g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true } })
  return g
}

/* ---------- 小储罐（井场罐组，Φ3.2 × 4.2） ---------- */
export function makeSmallTank(tint = 1) {
  const S = []
  const R = 1.6, H = 4.2
  addCyl(S, R + 0.35, R + 0.35, 0.28, 20, MAT.concrete, [0, 0.14, 0])
  addCyl(S, R, R, H, 24, MAT.paintLight, [0, 0.28 + H / 2, 0])
  addCyl(S, R + 0.05, R + 0.05, 0.08, 24, MAT.paintDark, [0, 0.45, 0])
  addCyl(S, R + 0.05, R + 0.05, 0.08, 24, MAT.paintDark, [0, H + 0.2, 0])
  const roof = new THREE.ConeGeometry(R + 0.1, 0.5, 24)
  roof.translate(0, H + 0.5, 0)
  S.push({ g: roof, m: MAT.paintLight })
  // 爬梯
  for (const z of [-0.25, 0.25]) addRod(S, V3(0, 0.3, R + 0.25 + z * 0), V3(0, H + 0.2, R + 0.25), 0.03, MAT.galv, 4)
  for (let y = 0.5; y < H; y += 0.35) addRod(S, V3(-0.01, y, R + 0.25), V3(0.01, y, R + 0.25), 0.02, MAT.galv, 4)
  // 接口
  addCyl(S, 0.12, 0.12, 0.6, 8, MAT.steel, [0, 0.7, R + 0.1], [Math.PI / 2, 0, 0])
  addCyl(S, 0.08, 0.08, 0.7, 6, MAT.galv, [R * 0.7, H + 0.55, 0])
  const g = bake(S, tint)
  g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true } })
  return g
}

/* ---------- 计量间（3.2 × 2.4 × 2.8） ---------- */
export function makeMeterHouse(tint = 1) {
  const S = []
  addRound(S, 4.0, 0.25, 3.2, 0.04, MAT.concrete, [0, 0.12, 0])
  addRound(S, 3.2, 2.4, 2.4, 0.05, MAT.white, [0, 1.45, 0])
  addRound(S, 3.6, 0.16, 2.8, 0.04, MAT.paintLight, [0, 2.72, 0])
  addBox(S, 0.9, 1.9, 0.08, MAT.paintDark, [0.9, 1.2, 1.22])
  addBox(S, 0.7, 0.5, 0.06, MAT.dark, [-0.9, 1.9, 1.21])
  addBox(S, 0.4, 0.3, 0.2, MAT.galv, [-1.3, 2.9, 0.6])
  const g = bake(S, tint)
  g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true } })
  return g
}

/* ---------- 树（杨树 / 榆树，低多边形但体量对） ---------- */
export function makeTree(kind = 0, seed = 0) {
  const rnd = (n) => {
    const x = Math.sin(seed * 12.9898 + n * 78.233) * 43758.5453
    return x - Math.floor(x)
  }
  const S = []
  const h = kind === 0 ? 9 + rnd(1) * 5 : 5 + rnd(2) * 3
  const trunkH = h * (kind === 0 ? 0.45 : 0.3)
  addCyl(S, 0.18, 0.34, trunkH, 7, MAT.dark, [0, trunkH / 2, 0])
  const n = kind === 0 ? 5 : 4
  for (let i = 0; i < n; i++) {
    const a = rnd(i + 3) * 6.28
    const r = (kind === 0 ? 1.5 : 1.9) * (0.3 + rnd(i + 5))
    const y = trunkH + (h - trunkH) * (0.25 + rnd(i + 7) * 0.6)
    const s = (kind === 0 ? 1.6 : 1.3) * (0.75 + rnd(i + 9) * 0.6)
    const geo = new THREE.IcosahedronGeometry(s, 0)
    geo.scale(1, kind === 0 ? 1.15 : 0.8, 1)
    geo.translate(Math.cos(a) * r, y, Math.sin(a) * r)
    S.push({ g: geo, m: rnd(i) > 0.5 ? MAT.leafA : MAT.leafB })
  }
  const g = bake(S, 1)
  g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true } })
  return g
}

/* ---------- 拖拉机 / 皮卡 ---------- */
export function makeTruck() {
  const S = []
  const body = MAT.white
  addRound(S, 2.0, 0.72, 5.2, 0.12, body, [0, 0.95, 0])
  addRound(S, 1.94, 1.0, 2.0, 0.14, body, [0, 1.65, 1.0])
  addBox(S, 1.86, 0.5, 0.06, MAT.dark, [0, 1.82, 2.01])
  addBox(S, 1.9, 0.5, 0.06, MAT.dark, [0, 1.8, -0.1])
  for (const [x, z] of [[-0.92, 1.55], [0.92, 1.55], [-0.92, -1.65], [0.92, -1.65]]) {
    addCyl(S, 0.42, 0.42, 0.3, 12, MAT.rubber, [x, 0.44, z], [0, 0, Math.PI / 2])
  }
  addBox(S, 1.7, 0.2, 0.5, MAT.steel, [0, 1.32, -2.5])
  const g = bake(S)
  g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true } })
  return g
}

/* 树叶材质 */
MAT.leafA = new THREE.MeshStandardMaterial({ color: 0x4f6236, roughness: 0.95 })
MAT.leafB = new THREE.MeshStandardMaterial({ color: 0x63703c, roughness: 0.95 })
FINISH.set(MAT.leafA, 'leaf')
FINISH.set(MAT.leafB, 'leaf')
FINISH_MAT.leaf = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0.0 })

/* ==========================================================================
   钻机 / 修井机井架（高 38m，四腿桁架 + 天车 + 游车 + 动力撬）
   这是全场唯一的竖向地标，用来压住天际线、给场地一个尺度参照
   ========================================================================== */
export function makeDrillingRig() {
  const S = []
  const H = 52
  const baseHalf = 6.6
  const topHalf = 2.0

  // 基础与底座
  addRound(S, 15, 0.6, 15, 0.08, MAT.concrete, [0, 0.3, 0])
  for (const x of [-5.2, 5.2]) for (const z of [-5.2, 5.2]) addBox(S, 1.0, 1.2, 1.0, MAT.paintDark, [x, 1.2, z])
  addBox(S, 12.4, 0.8, 3.0, MAT.paintDark, [0, 2.0, -4.5])
  addBox(S, 12.4, 0.8, 3.0, MAT.paintDark, [0, 2.0, 4.5])
  addBox(S, 3.0, 0.8, 9.0, MAT.paintDark, [-4.6, 2.0, 0])
  addBox(S, 3.0, 0.8, 9.0, MAT.paintDark, [4.6, 2.0, 0])
  // 钻台
  addBox(S, 11.0, 0.4, 11.0, MAT.paintLight, [0, 4.0, 0])
  for (const s of [-1, 1]) {
    addBox(S, 11.0, 0.18, 0.18, MAT.galv, [0, 4.9, s * 5.4])
    addBox(S, 0.18, 0.18, 11.0, MAT.galv, [s * 5.4, 4.9, 0])
    // 钻台栏杆
    for (let i = -5; i <= 5; i += 1.1) {
      addCyl(S, 0.03, 0.03, 1.0, 4, MAT.galv, [i, 4.7, s * 5.4])
      addCyl(S, 0.03, 0.03, 1.0, 4, MAT.galv, [s * 5.4, 4.7, i])
    }
  }
  // 转盘 + 井口
  addCyl(S, 1.1, 1.1, 0.5, 18, MAT.paintDark, [0, 4.45, 0])
  addCyl(S, 0.65, 0.65, 0.35, 14, MAT.steel, [0, 4.75, 0])

  // 四条主腿（带收分）
  const legs = [[-1, -1], [1, -1], [-1, 1], [1, 1]]
  for (const [sx, sz] of legs) {
    const a = V3(sx * baseHalf, 4.2, sz * baseHalf)
    const b = V3(sx * topHalf, H, sz * topHalf)
    addRod(S, a, b, 0.16, MAT.paint, 6)
    // 副腿
    const a2 = V3(sx * (baseHalf - 1.1), 4.2, sz * (baseHalf - 1.1))
    addRod(S, a2, b, 0.09, MAT.paint, 5)
  }
  // 横撑 + 斜撑（每 3.8m 一层）
  const tAt = (y) => (y - 4.2) / (H - 4.2)
  for (let y = 6; y < H - 1; y += 3.8) {
    const k = tAt(y)
    const h = baseHalf + (topHalf - baseHalf) * k
    // 四面横撑
    addRod(S, V3(-h, y, -h), V3(h, y, -h), 0.07, MAT.paintDark, 4)
    addRod(S, V3(-h, y, h), V3(h, y, h), 0.07, MAT.paintDark, 4)
    addRod(S, V3(-h, y, -h), V3(-h, y, h), 0.07, MAT.paintDark, 4)
    addRod(S, V3(h, y, -h), V3(h, y, h), 0.07, MAT.paintDark, 4)
    // 交叉斜撑
    const k2 = tAt(y + 3.8)
    const h2 = baseHalf + (topHalf - baseHalf) * k2
    addRod(S, V3(-h, y, -h), V3(h2, y + 3.8, -h2), 0.05, MAT.paintDark, 4)
    addRod(S, V3(h, y, -h), V3(-h2, y + 3.8, -h2), 0.05, MAT.paintDark, 4)
    addRod(S, V3(-h, y, h), V3(h2, y + 3.8, h2), 0.05, MAT.paintDark, 4)
    addRod(S, V3(h, y, h), V3(-h2, y + 3.8, h2), 0.05, MAT.paintDark, 4)
  }
  // 天车
  addBox(S, 2.6, 0.35, 2.6, MAT.paintDark, [0, H + 0.2, 0])
  for (const [sx, sz] of legs) addCyl(S, 0.35, 0.35, 0.3, 10, MAT.steel, [sx * 0.9, H + 0.45, sz * 0.9])
  for (const sx of [-0.9, 0.9]) addBox(S, 0.18, 0.5, 2.2, MAT.paintDark, [sx, H + 0.45, 0])
  addBox(S, 0.3, 0.3, 2.4, MAT.galv, [0, H + 0.75, 0])
  // 游车 / 大钩 / 钢丝绳
  addBox(S, 1.2, 0.9, 0.8, MAT.paintDark, [0, 17.5, 0])
  addCyl(S, 0.22, 0.22, 1.2, 8, MAT.steel, [0, 16.4, 0])
  addBox(S, 1.0, 0.5, 0.5, MAT.red, [0, 15.6, 0])
  for (const sx of [-0.5, 0.5]) {
    addRod(S, V3(sx, H + 0.3, 0), V3(sx, 18.0, 0), 0.035, MAT.galv, 4)
    addRod(S, V3(sx, 15.7, 0), V3(sx, 4.9, 0), 0.035, MAT.galv, 4)
  }
  // 立管 / 水龙带
  addCyl(S, 0.14, 0.14, 26, 8, MAT.galv, [3.2, 16, 2.6])
  addCyl(S, 0.2, 0.2, 0.4, 10, MAT.steel, [3.2, 29, 2.6])

  // 绞车 / 泥浆泵 / 发电房
  addBox(S, 4.2, 2.2, 2.6, MAT.paintDark, [-8.5, 1.7, 0])
  addBox(S, 2.6, 1.6, 2.2, MAT.paintDark, [-9.0, 1.5, 3.6])
  addCyl(S, 0.7, 0.7, 2.2, 14, MAT.paintDark, [-9.0, 1.4, -3.4], [0, 0, Math.PI / 2])
  addBox(S, 5.0, 2.6, 2.6, MAT.paintLight, [9.2, 1.9, 1.0])
  addCyl(S, 0.16, 0.16, 1.0, 8, MAT.galv, [9.2, 3.6, 1.0])
  // 管排架
  for (let i = 0; i < 4; i++) addCyl(S, 0.12, 0.12, 9, 8, MAT.steel, [-2.5 + i * 1.4, 0.75, 8.2], [0, 0, Math.PI / 2])
  // 梯子
  for (const z of [-0.35, 0.35]) addRod(S, V3(5.4, 0, z), V3(5.4, 4.4, z), 0.04, MAT.galv, 4)
  for (let y = 0.4; y < 4.3; y += 0.35) addRod(S, V3(5.4, y, -0.35), V3(5.4, y, 0.35), 0.025, MAT.galv, 4)

  const g = bake(S)
  g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true } })
  return g
}
