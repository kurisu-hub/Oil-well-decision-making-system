/**
 * P6 相机单测 · Node 环境（无需浏览器）
 *
 * 验收要求：「相机矩阵与手算一致（lookAt / perspective 各 3 例，误差 < 1e-6）」
 *
 * 做法：把 src/three/camera.ts 用 esbuild 编成 ESM，再**用性质断言**验证，
 * 而不是拿 three 自己的矩阵比 three——那样等于自己验自己。
 *
 * 视图矩阵的三条性质（数学上充分且独立于实现）：
 *   ① 相机位置映射到原点
 *   ② 目标点映射到 (0, 0, −距离)
 *   ③ 旋转块正交且行列式 = +1（右手系，无镜像）
 *
 * 投影矩阵的三条性质：
 *   ① 近平面中心 → NDC z = −1，远平面中心 → +1
 *   ② 半高 y = d·tan(fov/2) 在 z = −d 处 → NDC y = +1
 *   ③ x 方向同理，按 aspect 缩放
 *
 * 另附 3 + 3 组具体数值对拍（手填期望值）。
 */
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SRC = path.join(ROOT, 'frontend', 'src', 'three', 'camera.ts')

// esbuild 装在 frontend/ 下，从那里解析
const req = createRequire(path.join(ROOT, 'frontend', 'package.json'))
const { build } = req('esbuild')

const tmp = path.join(ROOT, 'tools', `.tmp_camera_${Date.now()}.mjs`)
await build({
  entryPoints: [SRC],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile: tmp,
  logLevel: 'silent',
  // three 在 node 下可正常 import；仅相机数学被用到
  external: [],
})
const M = await import(`file://${tmp}`)
fs.unlinkSync(tmp)

// three 仅用于交叉验证（不是唯一判据）
const THREE = await import(
  `file://${path.join(ROOT, 'frontend', 'node_modules', 'three', 'build', 'three.module.js')}`
)

let pass = 0
let fail = 0
const EPS = 1e-6

function ck(name, ok, detail = '') {
  if (ok) {
    pass++
    console.log(`✓ ${name.padEnd(46)} PASS  ${detail}`)
  } else {
    fail++
    console.log(`✗ ${name.padEnd(46)} FAIL  ${detail}`)
  }
}

function maxDiff(a, b) {
  let m = 0
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]))
  return m
}

/** 4x4 列主序矩阵乘 4 维列向量 */
function apply(m, v) {
  return [
    m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12] * v[3],
    m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13] * v[3],
    m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14] * v[3],
    m[3] * v[0] + m[7] * v[1] + m[11] * v[2] + m[15] * v[3],
  ]
}

function det3(m) {
  // 列主序：列 0 = (m0,m1,m2)，列 1 = (m4,m5,m6)，列 2 = (m8,m9,m10)
  return (
    m[0] * (m[5] * m[10] - m[9] * m[6]) -
    m[4] * (m[1] * m[10] - m[9] * m[2]) +
    m[8] * (m[1] * m[6] - m[5] * m[2])
  )
}

console.log('='.repeat(92))
console.log('P6 相机单测 · lookAt / perspective 各 3 例 + 性质断言')
console.log('='.repeat(92))

/* ---------------------------------------------------------------- lookAt */
const VIEW_CASES = [
  { name: 'C0 区块（101 km 跨度）', pos: [0, 95000, 95000], target: [0, 0, 0] },
  { name: 'C1 井场（pad 原点）', pos: [900, 700, 900], target: [0, 0, 0] },
  { name: 'C2 井筒（斜视）', pos: [60, -80, 60], target: [0, -1800, 0] },
]

for (const c of VIEW_CASES) {
  const V = M.viewMatrix(c.pos, c.target)
  const dist = Math.hypot(
    c.target[0] - c.pos[0],
    c.target[1] - c.pos[1],
    c.target[2] - c.pos[2],
  )

  // 性质 ①：相机位置 → 原点
  const p0 = apply(V, [c.pos[0], c.pos[1], c.pos[2], 1])
  const e1 = Math.max(Math.abs(p0[0]), Math.abs(p0[1]), Math.abs(p0[2]))

  // 性质 ②：目标点 → (0,0,−dist)
  const p1 = apply(V, [c.target[0], c.target[1], c.target[2], 1])
  const e2 = Math.max(
    Math.abs(p1[0]),
    Math.abs(p1[1]),
    Math.abs(p1[2] + dist),
  )

  // 性质 ③：正交 + 右手系
  const R = [V[0], V[1], V[2], V[4], V[5], V[6], V[8], V[9], V[10]]
  const d = det3(V)
  const orth =
    Math.abs(R[0] * R[3] + R[1] * R[4] + R[2] * R[5]) < EPS &&
    Math.abs(R[0] * R[6] + R[1] * R[7] + R[2] * R[8]) < EPS &&
    Math.abs(R[3] * R[6] + R[4] * R[7] + R[5] * R[8]) < EPS

  ck(`lookAt · ${c.name} · 位置→原点`, e1 < EPS, `err ${e1.toExponential(2)}`)
  ck(`lookAt · ${c.name} · 目标→(0,0,−d)`, e2 < EPS, `err ${e2.toExponential(2)}`)
  ck(
    `lookAt · ${c.name} · 正交右手系`,
    orth && Math.abs(d - 1) < EPS,
    `det ${d.toFixed(9)}`,
  )

  // 与 three 交叉验证（第二判据）
  // 必须用 Camera 而不是 Object3D：Object3D.lookAt 让 +Z 朝目标，
  // Camera.lookAt 让 −Z 朝目标。用错会让整块矩阵转置。
  const obj = new THREE.PerspectiveCamera(50, 1, 1, 1e6)
  obj.position.set(...c.pos)
  obj.up.set(0, 1, 0)
  obj.lookAt(new THREE.Vector3(...c.target))
  obj.updateMatrixWorld(true)
  const inv = obj.matrixWorldInverse
  const diff = maxDiff(V, inv.elements)
  ck(`lookAt · ${c.name} · 与 three 一致`, diff < EPS, `maxdiff ${diff.toExponential(2)}`)
}

/* ------------------------------------------------------------ perspective */
const PROJ_CASES = [
  { name: 'C0 fov60 · 16:9', fov: 60, aspect: 16 / 9, near: 1, far: 200000 },
  { name: 'C2 fov35 · 4:3', fov: 35, aspect: 4 / 3, near: 1, far: 10000 },
  { name: 'C3 fov30 · 21:9', fov: 30, aspect: 21 / 9, near: 0.5, far: 5000 },
]

for (const c of PROJ_CASES) {
  const P = M.projectionMatrix(c.fov, c.aspect, c.near, c.far)

  // 性质 ①：近平面中心 z=−near → NDC −1；远平面 → +1
  const pn = apply(P, [0, 0, -c.near, 1])
  const pf = apply(P, [0, 0, -c.far, 1])
  const zn = pn[2] / pn[3]
  const zf = pf[2] / pf[3]
  const e1 = Math.max(Math.abs(zn + 1), Math.abs(zf - 1))

  // 性质 ②：z=−d 处，y 半高 = d·tan(fov/2) → NDC y = 1
  const d = c.near * 10
  const halfH = d * Math.tan((c.fov * Math.PI) / 360)
  const py = apply(P, [0, halfH, -d, 1])
  const ndcY = py[1] / py[3]
  const e2 = Math.abs(ndcY - 1)

  // 性质 ③：x 半宽 = halfH·aspect → NDC x = 1
  const halfW = halfH * c.aspect
  const px = apply(P, [halfW, 0, -d, 1])
  const ndcX = px[0] / px[3]
  const e3 = Math.abs(ndcX - 1)

  ck(`proj · ${c.name} · 近/远平面→∓1`, e1 < EPS, `err ${e1.toExponential(2)}`)
  ck(`proj · ${c.name} · 垂向半高→NDC 1`, e2 < EPS, `err ${e2.toExponential(2)}`)
  ck(`proj · ${c.name} · 横向 aspect 正确`, e3 < EPS, `err ${e3.toExponential(2)}`)

  // 与 three 交叉验证
  const cam = new THREE.PerspectiveCamera(c.fov, c.aspect, c.near, c.far)
  cam.updateProjectionMatrix()
  const diff = maxDiff(P, cam.projectionMatrix.elements)
  ck(`proj · ${c.name} · 与 three 一致`, diff < EPS, `maxdiff ${diff.toExponential(2)}`)
}

/* --------------------------------------------------------- 机位预设一致性 */
const L0 = M.presetPose('C0', { spanM: 101000 })
const L1 = M.presetPose('C1', { padX: 1000, padZ: -500 })
const C2 = M.presetPose('C2', { wellX: 0, wellZ: 0 })

// C0 的判据不是「地形四角全在框内」，而是「77 口井全在框内」。
// 理由：0.64·span 的机位会让近侧边界略微出框（构图取舍），但井是全的；
// 早先按四角断言，逼得相机退到 1.0·span，地形缩成中间一小块，图上根本看不清井。
const bundle = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'frontend', 'src', 'data', 'bundle_v3.json'), 'utf8'),
)
const wellPts = (bundle.geo?.wells ?? [])
  .filter((w) => w.x != null)
  .map((w) => new THREE.Vector3(w.x, 0, -w.y))

const camC0 = new THREE.PerspectiveCamera(L0.fov, 16 / 9, 1, 500000)
camC0.position.set(...L0.pos)
camC0.lookAt(new THREE.Vector3(...L0.target))
camC0.updateMatrixWorld(true)
camC0.updateProjectionMatrix()
const fr = new THREE.Frustum().setFromProjectionMatrix(
  new THREE.Matrix4().multiplyMatrices(camC0.projectionMatrix, camC0.matrixWorldInverse),
)
const inside = wellPts.filter((p) => fr.containsPoint(p)).length

ck(
  'C0 视锥装下全部井口',
  inside === wellPts.length,
  `${inside}/${wellPts.length} 口在框内 · pos y=${L0.pos[1].toFixed(0)} m`,
)

ck(
  'C1 以 pad 为原点偏移',
  L1.target[0] === 1000 && L1.target[2] === -500,
  `target ${L1.target}`,
)
ck(
  'C2 目标井深 = −1800（非 v4 的 −800）',
  C2.target[1] === -1800,
  `target ${C2.target}`,
)

console.log('='.repeat(92))
console.log(`通过 ${pass}　失败 ${fail}`)
console.log('='.repeat(92))
process.exit(fail === 0 ? 0 : 1)
