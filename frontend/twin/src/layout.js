/* ==========================================================================
   layout.js · 油田总图
   77 口真实井位（COGCC）→ 井场聚类 → 场站 / 道路 / 管网骨架
   坐标：1 单位 = 1 米，X 东，Z 南（数据 y 取负）
   ========================================================================== */

const CLUSTER_R = 190      // 聚类半径（真实坐标，米）
const SCALE = 0.92         // 真实坐标 → 世界坐标压缩比
const ROT = -0.20          // 全场旋转（弧度），让主轴向画面斜切

function rotate(x, z, a) {
  const c = Math.cos(a), s = Math.sin(a)
  return [x * c - z * s, x * s + z * c]
}

/* ---------- 并查集聚类 ---------- */
function cluster(wells) {
  const n = wells.length
  const parent = Array.from({ length: n }, (_, i) => i)
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])))
  const uni = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[rb] = ra }

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const dx = wells[i].x - wells[j].x
      const dy = wells[i].y - wells[j].y
      if (dx * dx + dy * dy < CLUSTER_R * CLUSTER_R) uni(i, j)
    }
  }
  const map = new Map()
  wells.forEach((w, i) => {
    const r = find(i)
    if (!map.has(r)) map.set(r, [])
    map.get(r).push(i)
  })
  return [...map.values()]
}

/* ---------- 让井场不压到主路 / 联合站 ---------- */
function resolveOverlaps(pads, obstacles) {
  for (let iter = 0; iter < 40; iter++) {
    let moved = false
    for (const p of pads) {
      for (const o of obstacles) {
        const dx = p.cx - o.x, dz = p.cz - o.z
        const rad = p.radius + o.r
        const d = Math.hypot(dx, dz)
        if (d < rad && d > 0.01) {
          const push = (rad - d) * 0.55
          p.cx += (dx / d) * push
          p.cz += (dz / d) * push
          moved = true
        }
      }
      for (const q of pads) {
        if (q === p) continue
        const dx = p.cx - q.cx, dz = p.cz - q.cz
        const rad = p.radius + q.radius + 26
        const d = Math.hypot(dx, dz)
        if (d < rad && d > 0.01) {
          const push = (rad - d) * 0.5
          p.cx += (dx / d) * push
          p.cz += (dz / d) * push
          moved = true
        }
      }
    }
    if (!moved) break
  }
}

/* ---------- 主路：斜穿全场的沥青路 ---------- */
const MAIN_ROAD = [
  [-2050, -760], [-1600, -560], [-1180, -430], [-820, -330],
  [-520, -215], [-300, -90], [-120, 30], [90, 90],
  [340, 110], [640, 150], [980, 260], [1320, 430], [1720, 590],
]

const CROSS_ROAD = [
  [-260, -1450], [-250, -1050], [-200, -760], [-175, -470],
  [-150, -200], [-120, 30], [-60, 300], [20, 640], [80, 980], [110, 1350],
]

/* ---------- 折线工具 ---------- */
export function polylineLength(pts) {
  let L = 0
  for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1])
  return L
}

export function nearestOnPolyline(pts, x, z) {
  let best = { x: pts[0][0], z: pts[0][1], d: Infinity, seg: 0, t: 0 }
  for (let i = 0; i < pts.length - 1; i++) {
    const ax = pts[i][0], az = pts[i][1], bx = pts[i + 1][0], bz = pts[i + 1][1]
    const vx = bx - ax, vz = bz - az
    const L2 = vx * vx + vz * vz || 1
    let t = ((x - ax) * vx + (z - az) * vz) / L2
    t = Math.max(0, Math.min(1, t))
    const px = ax + vx * t, pz = az + vz * t
    const d = Math.hypot(x - px, z - pz)
    if (d < best.d) best = { x: px, z: pz, d, seg: i, t }
  }
  return best
}

/* ---------- 主入口 ---------- */
export function buildLayout(wells, heroes) {
  const heroSet = new Set(heroes)
  const groups = cluster(wells)

  // 中心与旋转
  const cx0 = wells.reduce((a, w) => a + w.x, 0) / wells.length
  const cy0 = wells.reduce((a, w) => a + w.y, 0) / wells.length

  // 先算每口井的世界坐标（压缩 + 旋转）
  const worldOf = (w) => {
    const [rx, rz] = rotate((w.x - cx0) * SCALE, -(w.y - cy0) * SCALE, ROT)
    return [rx, rz]
  }

  // 聚类 → 井场
  const pads = groups.map((idxs, gi) => {
    const ws = idxs.map((i) => wells[i])
    const pts = ws.map(worldOf)
    const cx = pts.reduce((a, p) => a + p[0], 0) / pts.length
    const cz = pts.reduce((a, p) => a + p[1], 0) / pts.length
    const n = ws.length
    const cols = n <= 2 ? n : n <= 6 ? 2 : n <= 9 ? 3 : 3
    const rows = Math.ceil(n / cols)
    const sx = 21, sz = 19
    const w = (cols - 1) * sx + 26
    const d = (rows - 1) * sz + 26
    const angled = gi % 3 === 1
    return {
      id: `PAD-${String.fromCharCode(65 + (gi % 26))}${gi >= 26 ? gi : ''}`,
      idx: gi,
      wells: ws,
      cx, cz,
      cols, rows, sx, sz,
      w: Math.max(w, 34),
      d: Math.max(d, 30),
      radius: Math.hypot(w, d) / 2 + 20,
      rot: angled ? Math.PI / 2 : 0,
      hero: ws.some((w2) => heroSet.has(w2.id)),
      name: ws[0].name,
      // 抽油机数量：主井场多，小井场少
      pumps: Math.min(n, n >= 10 ? 6 : n >= 6 ? 4 : n >= 3 ? 3 : n),
    }
  })

  pads.sort((a, b) => Math.hypot(a.cx, a.cz) - Math.hypot(b.cx, b.cz))
  pads.forEach((p, i) => { p.id = `PAD-${String.fromCharCode(65 + (i % 26))}` })

  // 联合站：靠中心、避开井场
  let cpf = { x: 0, z: 0 }
  {
    const cands = []
    for (let gx = -600; gx <= 600; gx += 60) {
      for (let gz = -600; gz <= 600; gz += 60) {
        let min = Infinity
        for (const p of pads) min = Math.min(min, Math.hypot(p.cx - gx, p.cz - gz) - p.radius)
        const score = min - Math.hypot(gx, gz) * 0.25
        cands.push({ x: gx, z: gz, score, min })
      }
    }
    cands.sort((a, b) => b.score - a.score)
    const best = cands.find((c) => c.min > 120) || cands[0]
    cpf = { x: best.x, z: best.z }
  }

  // 联合站与井场互相避让
  resolveOverlaps(pads, [{ x: cpf.x, z: cpf.z, r: 150 }])


  // 井场再落位：槽位排布
  for (const p of pads) {
    const order = [...p.wells].sort((a, b) => (heroSet.has(b.id) ? 1 : 0) - (heroSet.has(a.id) ? 1 : 0))
    order.forEach((w, i) => {
      const c = i % p.cols
      const r = Math.floor(i / p.cols)
      const lx = (c - (p.cols - 1) / 2) * p.sx
      const lz = (r - (p.rows - 1) / 2) * p.sz
      const [rx, rz] = p.rot ? [lz, -lx] : [lx, lz]
      w._pos = { x: p.cx + rx, z: p.cz + rz }
      w._pad = p.id
      w._slot = { c, r, lx, lz }
      w._pump = i < p.pumps
    })
    p.heroIds = p.wells.filter((w) => heroSet.has(w.id)).map((w) => w.id)
  }

  // 道路（世界坐标）
  const roadOf = (pts) => pts.map(([x, z]) => {
    const [rx, rz] = rotate((x - cx0) * 0.0 + x, z, 0) // 主路直接用世界坐标
    return [rx, rz]
  })
  // 主路坐标本身已是世界坐标；只做一次整体平移对齐井位分布
  const shift = { x: 0, z: 0 }
  const mainRoad = MAIN_ROAD.map(([x, z]) => [x + shift.x, z + shift.z])
  const crossRoad = CROSS_ROAD.map(([x, z]) => [x + shift.x, z + shift.z])

  // 井场支路：接到最近的主路 / 纵路
  for (const p of pads) {
    const a = nearestOnPolyline(mainRoad, p.cx, p.cz)
    const b = nearestOnPolyline(crossRoad, p.cx, p.cz)
    const near = a.d <= b.d ? a : b
    const dx = p.cx - near.x, dz = p.cz - near.z
    const len = Math.hypot(dx, dz) || 1
    const mx = near.x + dx * 0.45 - (dz / len) * 12
    const mz = near.z + dz * 0.45 + (dx / len) * 12
    p.spur = [[near.x, near.z], [mx, mz], [p.cx, p.cz]]
    p.spurLen = Math.hypot(dx, dz)
  }

  // 管网：井场 → 联合站（带一个折点，沿地面走）
  for (const p of pads) {
    const mx = (p.cx + cpf.x) / 2 + (p.cz - cpf.z) * 0.12
    const mz = (p.cz + cpf.z) / 2 - (p.cx - cpf.x) * 0.12
    p.pipe = [[p.cx, p.cz], [mx, mz], [cpf.x, cpf.z]]
    p.dist = Math.hypot(p.cx - cpf.x, p.cz - cpf.z)
  }

  const bbox = pads.reduce((b, p) => ({
    minX: Math.min(b.minX, p.cx - p.w), maxX: Math.max(b.maxX, p.cx + p.w),
    minZ: Math.min(b.minZ, p.cz - p.d), maxZ: Math.max(b.maxZ, p.cz + p.d),
  }), { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity })

  return {
    pads,
    cpf: { ...cpf, w: 184, d: 136 },
    mainRoad,
    crossRoad,
    bbox,
    center: { x: 0, z: 0 },
    worldOf,
    heroSet,
  }
}
