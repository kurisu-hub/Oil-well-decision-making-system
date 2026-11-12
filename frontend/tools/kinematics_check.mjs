/**
 * kinematics_check.mjs · 四连杆解算验证
 *
 * 不需要装依赖：Node 22 内置 TS type-stripping，直接 import .ts 即可。
 * 用法：node tools/kinematics_check.mjs
 *
 * 判据（任一不过即 FAIL）：
 *   1. 冲程命中 3.66 m（144 in）—— ±2%，曲柄半径已按 S = 2R×(前臂/后臂) 回填到 0.824
 *   2. 曲柄一圈内解算无失败（两圆始终相交）
 *   3. 相邻采样点 C 点跳变 < 0.03 m（说明两解切换没选错支）
 *   4. 游梁摆角落在 40°–70°（144 in 机型的实测区间）
 */
import { sampleStroke, solveFourBar, strokesToOmega, DEFAULT_GEOM } from '../src/three/kinematics.ts'

const TARGET_STROKE = 3.66
const TOL = 0.02

console.log('=== 几何（由建模参数推导）===')
for (const [k, v] of Object.entries(DEFAULT_GEOM)) {
  if (Array.isArray(v)) console.log(`  ${k.padEnd(14)} [${v.map((x) => x.toFixed(3)).join(', ')}]`)
  else console.log(`  ${k.padEnd(14)} ${typeof v === 'number' ? v.toFixed(4) : v}`)
}

const r = sampleStroke(DEFAULT_GEOM, 1440)

console.log('\n=== 解算结果 ===')
console.log(`  冲程 stroke      ${r.stroke.toFixed(4)} m   (目标 ${TARGET_STROKE})`)
console.log(`  光杆最低/最高    ${r.minY.toFixed(4)} / ${r.maxY.toFixed(4)} m`)
console.log(`  游梁摆角         ${r.beamSwingDeg.toFixed(2)}°`)
console.log(`  上死点曲柄角     ${r.topThetaDeg.toFixed(1)}°`)
console.log(`  下死点曲柄角     ${r.botThetaDeg.toFixed(1)}°`)
console.log(`  解算失败数       ${r.failCount}`)
console.log(`  C 点最大跳变     ${(r.maxPinJump * 1000).toFixed(2)} mm`)

const checks = [
  ['冲程命中 ±8%', Math.abs(r.stroke - TARGET_STROKE) / TARGET_STROKE <= TOL, `${r.stroke.toFixed(3)} m vs ${TARGET_STROKE}`],
  ['解算无失败', r.failCount === 0, `${r.failCount} 次`],
  ['C 点无跳变', r.maxPinJump < 0.03, `${(r.maxPinJump * 1000).toFixed(2)} mm < 30 mm`],
  ['摆角在 40–70°', r.beamSwingDeg >= 40 && r.beamSwingDeg <= 70, `${r.beamSwingDeg.toFixed(1)}°`],
]

console.log('\n=== 判据 ===')
let allPass = true
for (const [name, pass, detail] of checks) {
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name.padEnd(18)} ${detail}`)
  if (!pass) allPass = false
}

// 冲次可调性：1–12 /min 的角速度与周期
console.log('\n=== 冲次 → 角速度（T08 用）===')
for (const spm of [1, 3, 6, 9, 12]) {
  const w = strokesToOmega(spm)
  console.log(`  ${String(spm).padStart(2)} /min  →  ${w.toFixed(4)} rad/s   周期 ${(60 / spm).toFixed(1)} s`)
}

// 静态姿态自检：θ0 处应回到初始位置（rodY = 0）
const s0 = solveFourBar(DEFAULT_GEOM.crankPhase0)
console.log('\n=== 静态姿态自检 ===')
console.log(`  θ0 = ${((DEFAULT_GEOM.crankPhase0 * 180) / Math.PI).toFixed(1)}°`)
console.log(`  rodY = ${s0.rodY.toFixed(6)} m   (应为 0)`)
console.log(`  beamDelta = ${((s0.beamDelta * 180) / Math.PI).toFixed(6)}°   (应为 0)`)
console.log(`  后臂铰点 C = [${s0.backPin.map((v) => v.toFixed(4)).join(', ')}]   (建模值 [-3.02, 8.00])`)

const selfOk = Math.abs(s0.rodY) < 1e-3 && Math.abs(s0.beamDelta) < 1e-3
  && Math.hypot(s0.backPin[0] + 3.02, s0.backPin[1] - 8.0) < 1e-3

console.log(`\n${allPass && selfOk ? 'ALL PASS' : 'HAS FAILURE'}`)
process.exit(allPass && selfOk ? 0 : 1)
