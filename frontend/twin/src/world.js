/* ==========================================================================
   world.js · 油田全场景装配
   · 19 个井场（抽油机 / 井口 / 罐组 / 分离器 / 计量间 / 围栏 / 电力线）
   · 中央联合站（罐区 / 三相分离 / 管汇 / 压缩机 / 中控 / 库房 / 装车 / 火炬）
   · 集输管网 + 道路网 + 电力线 + 冲沟林带 + 草场
   静态件按材质合并（个位数 draw call），抽油机可动件实例化
   ========================================================================== */
import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import * as EQ from './equipment.js'

const V3 = (x, y, z) => new THREE.Vector3(x, y, z)
let rnd = mulberry32(20261110)

function mulberry32(a) {
  return function () {
    a |= 0
    a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/* ==========================================================================
   纹理
   ========================================================================== */
function noiseTex(base, spots, size = 256, strength = 1) {
  const c = document.createElement('canvas')
  c.width = c.height = size
  const g = c.getContext('2d')
  g.fillStyle = base
  g.fillRect(0, 0, size, size)
  for (let i = 0; i < spots; i++) {
    const dark = Math.random() < 0.55
    const v = dark ? 110 + Math.random() * 60 : 190 + Math.random() * 55
    g.fillStyle = `rgba(${v},${v},${v * 0.95},${strength * (0.05 + Math.random() * 0.16)})`
    const r = 0.5 + Math.random() * 2.4
    g.beginPath()
    g.arc(Math.random() * size, Math.random() * size, r, 0, 6.283)
    g.fill()
  }
  const t = new THREE.CanvasTexture(c)
  t.wrapS = t.wrapT = THREE.RepeatWrapping
  t.colorSpace = THREE.SRGBColorSpace
  t.anisotropy = 4
  return t
}

function asphaltTexture() {
  const c = document.createElement('canvas')
  c.width = c.height = 256
  const g = c.getContext('2d')
  g.fillStyle = '#5a5852'
  g.fillRect(0, 0, 256, 256)
  for (let i = 0; i < 16000; i++) {
    const v = 58 + Math.random() * 62
    g.fillStyle = `rgba(${v},${v},${v * 0.96},${0.06 + Math.random() * 0.18})`
    g.fillRect(Math.random() * 256, Math.random() * 256, 1 + Math.random() * 2, 1 + Math.random() * 2)
  }
  const t = new THREE.CanvasTexture(c)
  t.wrapS = t.wrapT = THREE.RepeatWrapping
  t.colorSpace = THREE.SRGBColorSpace
  return t
}

/* ==========================================================================
   静态几何合并器
   ========================================================================== */
class Merger {
  constructor() { this.buckets = new Map() }
  add(obj, matrix) {
    obj.updateMatrixWorld(true)
    obj.traverse((o) => {
      if (!o.isMesh) return
      let g = o.geometry.clone()
      if (g.index) { const ng = g.toNonIndexed(); g.dispose(); g = ng }
      for (const k of Object.keys(g.attributes)) {
        if (!['position', 'normal', 'uv', 'color'].includes(k)) g.deleteAttribute(k)
      }
      if (!g.attributes.normal) g.computeVertexNormals()
      const n = g.attributes.position.count
      if (!g.attributes.uv) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2), 2))
      if (!g.attributes.color) g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3).fill(1), 3))
      const mat = matrix ? matrix.clone() : new THREE.Matrix4()
      g.applyMatrix4(new THREE.Matrix4().multiplyMatrices(mat, o.matrixWorld))
      const key = o.material.uuid
      if (!this.buckets.has(key)) this.buckets.set(key, { mat: o.material, geos: [] })
      this.buckets.get(key).geos.push(g)
    })
  }
  addMesh(geo, mat, matrix) {
    const m = new THREE.Mesh(geo, mat)
    this.add(m, matrix)
  }
  build(parent) {
    for (const [, b] of this.buckets) {
      if (!b.geos.length) continue
      const merged = b.geos.length === 1 ? b.geos[0] : mergeGeometries(b.geos, false)
      if (!merged) { console.warn('merge failed', b.mat.name); continue }
      merged.computeBoundingSphere()
      const mesh = new THREE.Mesh(merged, b.mat)
      mesh.castShadow = true
      mesh.receiveShadow = true
      mesh.name = 'static'
      parent.add(mesh)
      if (b.geos.length > 1) b.geos.forEach((g) => g.dispose())
    }
    this.buckets.clear()
  }
}

/* ==========================================================================
   道路几何
   ========================================================================== */
let heightOf = () => 0

function ribbonGeometry(points, width, yOff, uvScale = 0.09) {
  const curve = new THREE.CatmullRomCurve3(points.map((p) => V3(p[0], 0, p[1])), false, 'catmullrom', 0.25)
  const L = curve.getLength()
  const N = Math.max(8, Math.floor(L / 4))
  const pos = [], uv = [], idx = []
  let dist = 0
  let prev = null
  for (let i = 0; i <= N; i++) {
    const t = i / N
    const p = curve.getPoint(t)
    const tan = curve.getTangent(t)
    const nx = -tan.z, nz = tan.x
    const l = Math.hypot(nx, nz) || 1
    const hx = (nx / l) * width / 2, hz = (nz / l) * width / 2
    if (prev) dist += Math.hypot(p.x - prev.x, p.z - prev.z)
    prev = p
    pos.push(p.x + hx, 0, p.z + hz, p.x - hx, 0, p.z - hz)
    uv.push(0, dist * uvScale, 1, dist * uvScale)
    if (i < N) {
      const a = i * 2
      idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3)
    }
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2))
  geo.setIndex(idx)
  const arr = geo.attributes.position.array
  for (let i = 0; i < arr.length; i += 3) arr[i + 1] = heightOf(arr[i], arr[i + 2]) + yOff
  geo.computeVertexNormals()
  return { geo, curve, L }
}

function dashGeometry(curve, spacing, dash, width, yOff) {
  const L = curve.getLength()
  const n = Math.floor(L / spacing)
  const geos = []
  for (let i = 0; i < n; i++) {
    const d = i * spacing
    if (d + dash > L) break
    const a = curve.getPointAt(d / L)
    const b = curve.getPointAt((d + dash) / L)
    const tan = curve.getTangentAt(d / L)
    const nx = -tan.z, nz = tan.x
    const l = Math.hypot(nx, nz) || 1
    const hx = (nx / l) * width / 2, hz = (nz / l) * width / 2
    const g = new THREE.BufferGeometry()
    const ya = heightOf(a.x, a.z) + yOff
    const yb = heightOf(b.x, b.z) + yOff
    g.setAttribute('position', new THREE.Float32BufferAttribute([
      a.x + hx, ya, a.z + hz, a.x - hx, ya, a.z - hz,
      b.x + hx, yb, b.z + hz, b.x - hx, yb, b.z - hz,
    ], 3))
    g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 1, 1], 2))
    g.setIndex([0, 1, 2, 2, 1, 3])
    g.computeVertexNormals()
    geos.push(g)
  }
  return geos.length ? mergeGeometries(geos, false) : null
}

/* ==========================================================================
   主入口
   ========================================================================== */
export function buildWorld({ scene, layout, terrain, quality = 'high' }) {
  heightOf = terrain.heightAt
  rnd = mulberry32(20261110)

  const root = new THREE.Group()
  scene.add(root)
  const merger = new Merger()
  const dynamic = new THREE.Group()
  root.add(dynamic)

  const stats = { wellCount: 0, padCount: layout.pads.length, pumpCount: 0, pipeLen: 0 }

  const gravelTex = noiseTex('#a49b86', 9000)
  const concreteTex = noiseTex('#b3ac9b', 6000)
  const asphaltTex = asphaltTexture()
  const matGravel = new THREE.MeshStandardMaterial({ map: gravelTex, color: 0xb8b09b, roughness: 0.98, metalness: 0 })
  const matAsphalt = new THREE.MeshStandardMaterial({ map: asphaltTex, color: 0xbdbab2, roughness: 0.95, metalness: 0.02 })
  const matConcrete = new THREE.MeshStandardMaterial({ map: concreteTex, color: 0xcdc7b6, roughness: 0.95, metalness: 0 })
  const matLine = new THREE.MeshStandardMaterial({ color: 0xe6dfcb, roughness: 0.85, metalness: 0, emissive: 0x22221c, emissiveIntensity: 0.2 })
  const matPipe = new THREE.MeshStandardMaterial({ color: 0x6e7672, roughness: 0.55, metalness: 0.55 })
  const matPipeSmall = new THREE.MeshStandardMaterial({ color: 0x7b827c, roughness: 0.6, metalness: 0.45 })

  /* ---------- 禁植区 ---------- */
  const blocks = []
  for (const p of layout.pads) blocks.push({ x: p.cx, z: p.cz, r: Math.hypot(p.w + 40, p.d + 16) / 2 })
  blocks.push({ x: layout.cpf.x, z: layout.cpf.z, r: Math.hypot(layout.cpf.w, layout.cpf.d) / 2 })
  const roadLines = [layout.mainRoad, layout.crossRoad, ...layout.pads.map((p) => p.spur)]
  const isBlocked = (x, z) => {
    for (const b of blocks) if ((x - b.x) ** 2 + (z - b.z) ** 2 < b.r * b.r) return true
    for (const line of roadLines) {
      for (let i = 0; i < line.length - 1; i++) {
        if (distToSeg(x, z, line[i][0], line[i][1], line[i + 1][0], line[i + 1][1]) < 9) return true
      }
    }
    return false
  }

  /* ======================================================================
     1. 道路
     ====================================================================== */
  const roadGroup = new THREE.Group()
  root.add(roadGroup)

  function addRoad(points, width, mat, opts = {}) {
    const shoulder = ribbonGeometry(points, width + 3.6, 0.10, 0.055)
    const sm = new THREE.Mesh(shoulder.geo, matGravel)
    sm.receiveShadow = true
    roadGroup.add(sm)
    const road = ribbonGeometry(points, width, 0.15, 0.085)
    const rm = new THREE.Mesh(road.geo, mat)
    rm.receiveShadow = true
    roadGroup.add(rm)
    if (opts.dash) {
      const dg = dashGeometry(road.curve, 16, 6.5, 0.3, 0.165)
      if (dg) roadGroup.add(new THREE.Mesh(dg, matLine))
    }
    return road.curve
  }

  const mainCurve = addRoad(layout.mainRoad, 9, matAsphalt, { dash: true })
  addRoad(layout.crossRoad, 6.5, matGravel)
  for (const p of layout.pads) addRoad(p.spur, 5.4, matGravel)

  /* ======================================================================
     2. 井场
     ====================================================================== */
  const pumpStates = []
  const wellMarkers = []
  const flameAnchor = new THREE.Vector3()

  const padMatrix = (p, lx, lz) => {
    const c = Math.cos(p.rot), s = Math.sin(p.rot)
    return { x: p.cx + lx * c - lz * s, z: p.cz + lx * s + lz * c }
  }

  function padFence(p, w, d, gateLocal) {
    const pts = [[-w / 2, -d / 2], [w / 2, -d / 2], [w / 2, d / 2], [-w / 2, d / 2], [-w / 2, -d / 2]]
    const gap = 8
    const segs = []
    for (let i = 0; i < 4; i++) {
      const a = pts[i], b = pts[i + 1]
      const horizontal = Math.abs(a[1] - b[1]) < 0.01
      const onSide = horizontal
        ? Math.abs(gateLocal[1] - a[1]) < 2.5 && gateLocal[0] > Math.min(a[0], b[0]) - 1 && gateLocal[0] < Math.max(a[0], b[0]) + 1
        : Math.abs(gateLocal[0] - a[0]) < 2.5 && gateLocal[1] > Math.min(a[1], b[1]) - 1 && gateLocal[1] < Math.max(a[1], b[1]) + 1
      if (!onSide) { segs.push([a, b]); continue }
      if (horizontal) {
        const lo = Math.min(a[0], b[0]), hi = Math.max(a[0], b[0])
        const gx = Math.max(lo + gap, Math.min(hi - gap, gateLocal[0]))
        if (gx - gap > lo) segs.push([a, [gx - gap, a[1]]])
        if (gx + gap < hi) segs.push([[gx + gap, a[1]], b])
      } else {
        const lo = Math.min(a[1], b[1]), hi = Math.max(a[1], b[1])
        const gz = Math.max(lo + gap, Math.min(hi - gap, gateLocal[1]))
        if (gz - gap > lo) segs.push([a, [a[0], gz - gap]])
        if (gz + gap < hi) segs.push([[a[0], gz + gap], b])
      }
    }
    for (const [a, b] of segs) {
      const A = padMatrix(p, a[0], a[1])
      const B = padMatrix(p, b[0], b[1])
      const f = EQ.makeFence([[A.x, A.z], [B.x, B.z]], 2.0)
      merger.add(f, new THREE.Matrix4().makeTranslation(0, terrain.heightAt(A.x, A.z), 0))
    }
  }

  layout.pads.forEach((p) => {
    const H = terrain.heightAt(p.cx, p.cz)
    const W = p.w + 56
    const D = p.d + 24

    // 场坪
    const slabGeo = new THREE.PlaneGeometry(W, D)
    slabGeo.rotateX(-Math.PI / 2)
    scaleUV(slabGeo, W / 7, D / 7)
    const q = new THREE.Quaternion().setFromAxisAngle(V3(0, 1, 0), -p.rot)
    merger.addMesh(slabGeo, matGravel, new THREE.Matrix4().compose(V3(p.cx, H + 0.06, p.cz), q, V3(1, 1, 1)))

    // 路缘
    for (const [lx, lz, w, d] of [
      [0, -D / 2, W, 0.5], [0, D / 2, W, 0.5],
      [-W / 2, 0, 0.5, D], [W / 2, 0, 0.5, D],
    ]) {
      const pos = padMatrix(p, lx, lz)
      merger.addMesh(new THREE.BoxGeometry(w, 0.3, d), matConcrete,
        new THREE.Matrix4().compose(V3(pos.x, H + 0.12, pos.z), q, V3(1, 1, 1)))
    }

    // 井
    p.wells.forEach((w) => {
      const isHero = layout.heroSet.has(w.id)
      const local = w._slot
      const pj = padMatrix(p, local.lx - 1.4, local.lz)
      const wh = padMatrix(p, local.lx + 2.32, local.lz)

      merger.add(EQ.makeWellhead(), placed(null, wh.x, H + 0.1, wh.z, -p.rot).m)

      if (w._pump) {
        const kind = isHero ? 'full' : 'lite'
        const tint = 0.9 + rnd() * 0.18
        if (kind === 'full') {
          const g = EQ.makePumpjack(tint)
          g.position.set(pj.x, H + 0.1, pj.z)
          g.rotation.y = -p.rot
          dynamic.add(g)
          pumpStates.push({ kind: 'full', group: g, parts: g.userData.parts, phase: rnd() * 6.28, speed: 0.9 + rnd() * 0.25 })
        } else {
          const base = new THREE.Matrix4().compose(
            V3(pj.x, H + 0.1, pj.z),
            new THREE.Quaternion().setFromAxisAngle(V3(0, 1, 0), -p.rot),
            V3(1, 1, 1)
          )
          merger.add(getLiteProto().body, base)
          pumpStates.push({ kind: 'lite', base, phase: rnd() * 6.28, speed: 0.9 + rnd() * 0.25 })
        }
        stats.pumpCount++
      }

      // 井口 → 计量阀组 支线
      const header = padMatrix(p, p.w * 0.5 + 2, 0)
      const a = V3(wh.x, H + 0.55, wh.z)
      const b = V3(header.x, H + 0.55, header.z)
      if (a.distanceTo(b) > 1.2) {
        const mid = a.clone().lerp(b, 0.5)
        mid.y = H + 0.4
        const curve = new THREE.CatmullRomCurve3([a, mid, b])
        merger.addMesh(new THREE.TubeGeometry(curve, 8, 0.06, 5, false), matPipeSmall, null)
      }

      wellMarkers.push({
        id: w.id, name: w.name, state: w.state, npv: w.npv, well: w,
        x: wh.x, y: H + 3.6, z: wh.z, hero: isHero, pad: p.id,
      })
      stats.wellCount++
    })

    // 设备区
    const eqX = p.w / 2 + 10
    const t1 = padMatrix(p, eqX, -p.d / 2 + 2)
    merger.add(EQ.makeSmallTank(0.94 + rnd() * 0.1), placed(null, t1.x, H, t1.z, -p.rot).m)
    const t2 = padMatrix(p, eqX, -p.d / 2 + 11)
    merger.add(EQ.makeSmallTank(0.9 + rnd() * 0.12), placed(null, t2.x, H, t2.z, -p.rot).m)

    const sep = padMatrix(p, p.w / 2 + 21, 0)
    merger.add(EQ.makeSeparator(), placed(null, sep.x, H, sep.z, -p.rot + Math.PI / 2).m)

    const mh = padMatrix(p, eqX, p.d / 2 - 2)
    merger.add(EQ.makeMeterHouse(0.97 + rnd() * 0.06), placed(null, mh.x, H, mh.z, -p.rot + Math.PI).m)

    const pole = padMatrix(p, p.w / 2 + 25, p.d / 2 - 3)
    merger.add(EQ.makePowerPole(10, true), placed(null, pole.x, H, pole.z, -p.rot).m)

    const lamp = padMatrix(p, -(p.w / 2 + 9), 0)
    merger.add(EQ.makeLamp(12), placed(null, lamp.x, H, lamp.z, -p.rot).m)

    // 围栏（门朝支路）
    const gateWorld = p.spur[p.spur.length - 1]
    const gl = rotateLocal(gateWorld[0] - p.cx, gateWorld[1] - p.cz, -p.rot)
    const useZ = Math.abs(gl[1]) > Math.abs(gl[0])
    const gate = useZ
      ? [Math.max(-W / 2 + 5, Math.min(W / 2 - 5, gl[0])), Math.sign(gl[1] || 1) * D / 2]
      : [Math.sign(gl[0] || 1) * W / 2, Math.max(-D / 2 + 5, Math.min(D / 2 - 5, gl[1]))]
    padFence(p, W, D, gate)

    p.tag = { x: p.cx, y: H + 4, z: p.cz }
    p._H = H
    p._W = W
    p._D = D
  })

  /* ======================================================================
     3. 中央联合站
     ====================================================================== */
  const C = layout.cpf
  const CH = terrain.heightAt(C.x, C.z)
  const cpfGroup = new THREE.Group()
  root.add(cpfGroup)

  {
    const slabGeo = new THREE.PlaneGeometry(C.w, C.d)
    slabGeo.rotateX(-Math.PI / 2)
    scaleUV(slabGeo, C.w / 12, C.d / 12)
    const m = new THREE.Mesh(slabGeo, matConcrete)
    m.position.set(C.x, CH + 0.07, C.z)
    m.receiveShadow = true
    cpfGroup.add(m)

    // 场坪路缘
    for (const [ox, oz, w, d] of [
      [0, -C.d / 2, C.w, 0.6], [0, C.d / 2, C.w, 0.6],
      [-C.w / 2, 0, 0.6, C.d], [C.w / 2, 0, 0.6, C.d],
    ]) {
      merger.addMesh(new THREE.BoxGeometry(w, 0.34, d), matConcrete,
        new THREE.Matrix4().makeTranslation(C.x + ox, CH + 0.16, C.z + oz))
    }
    // 油污 / 磨损
    const stainTex = radialGlow()
    const stainMat = new THREE.MeshBasicMaterial({ map: stainTex, color: 0x171512, transparent: true, opacity: 0.42, depthWrite: false })
    for (let i = 0; i < 26; i++) {
      const g2 = new THREE.PlaneGeometry(1, 1)
      g2.rotateX(-Math.PI / 2)
      const sx = 4 + rnd() * 16, sz = 3 + rnd() * 10
      g2.scale(sx, 1, sz)
      merger.addMesh(g2, stainMat, new THREE.Matrix4().makeTranslation(
        C.x - 70 + rnd() * 150, CH + 0.145, C.z - 58 + rnd() * 110))
    }

    // 场内道路
    for (const pts of [
      [[C.x - C.w / 2 + 8, C.z + 4], [C.x + C.w / 2 - 8, C.z + 4]],
    ]) {
      const { geo } = ribbonGeometry(pts, 7.5, 0.13, 0.08)
      const mm = new THREE.Mesh(geo, matAsphalt)
      mm.receiveShadow = true
      cpfGroup.add(mm)
    }

    // 站内道路漆线
    const laneMat = new THREE.MeshStandardMaterial({ color: 0xd8b13c, roughness: 0.8, metalness: 0 })
    for (const off of [-4.2, 4.2]) {
      merger.addMesh(new THREE.BoxGeometry(C.w - 22, 0.03, 0.16), laneMat,
        new THREE.Matrix4().makeTranslation(C.x, CH + 0.16, C.z + 4 + off))
    }
    // 停车位
    for (let i = 0; i < 4; i++) {
      merger.addMesh(new THREE.BoxGeometry(0.12, 0.03, 5.4), laneMat,
        new THREE.Matrix4().makeTranslation(C.x + 26 + i * 3.2, CH + 0.16, C.z - 44))
    }

    // 罐区
    const tanks = [[-62, -30], [-40, -30], [-18, -30], [-62, -4], [-40, -4], [-18, -4]]
    tanks.forEach(([lx, lz], i) => {
      merger.add(EQ.makeTank(0.86 + (i % 3) * 0.04), placed(null, C.x + lx, CH, C.z + lz, i * 0.5).m)
    })
    const bundW = 66, bundD = 50, bundX = C.x - 40, bundZ = C.z - 17
    for (const [ox, oz, w, d] of [
      [0, -bundD / 2, bundW, 0.9], [0, bundD / 2, bundW, 0.9],
      [-bundW / 2, 0, 0.9, bundD], [bundW / 2, 0, 0.9, bundD],
    ]) {
      merger.addMesh(new THREE.BoxGeometry(w, 1.15, d), matConcrete,
        new THREE.Matrix4().makeTranslation(bundX + ox, CH + 0.57, bundZ + oz))
    }
    // 防火堤栏杆
    for (let x = -bundW / 2 + 2; x <= bundW / 2 - 2; x += 4) {
      for (const z of [-bundD / 2 - 1.2, bundD / 2 + 1.2]) {
        merger.addMesh(new THREE.CylinderGeometry(0.04, 0.04, 1.0, 5), matPipeSmall,
          new THREE.Matrix4().makeTranslation(bundX + x, CH + 1.6, bundZ + z))
      }
    }

    // 三相分离器 ×5（一段式流程）
    for (let i = 0; i < 5; i++) merger.add(EQ.makeSeparator(), placed(null, C.x + 2, CH, C.z + 22 + i * 13, Math.PI / 2).m)
    // 伴生气洗涤器 / 缓冲罐
    merger.add(EQ.makeSeparator(), placed(null, C.x + 22, CH, C.z + 52, 0).m)
    merger.add(EQ.makeSeparator(), placed(null, C.x + 22, CH, C.z + 64, 0).m)
    // 采出水处理：三只小罐
    for (let i = 0; i < 3; i++) merger.add(EQ.makeSmallTank(0.92), placed(null, C.x - 20 + i * 7.5, CH, C.z + 62, 0).m)
    // 计量橇 / 发球筒
    merger.add(EQ.makeManifold(), placed(null, C.x - 6, CH, C.z + 42, Math.PI / 2).m)
    merger.add(EQ.makePipeRack(18, 3), placed(null, C.x + 20, CH, C.z + 30, Math.PI / 2).m)
    // 管汇 / 管排
    merger.add(EQ.makeManifold(), placed(null, C.x + 26, CH, C.z + 12, 0).m)
    merger.add(EQ.makePipeRack(34, 5), placed(null, C.x + 26, CH, C.z - 8, Math.PI / 2).m)
    merger.add(EQ.makePipeRack(24, 4), placed(null, C.x - 6, CH, C.z + 58, 0).m)
    // 压缩机 / 中控 / 库房 / 装车 / 火炬
    merger.add(EQ.makeCompressor(), placed(null, C.x + 52, CH, C.z + 36, -0.08).m)
    merger.add(EQ.makeControlRoom(1.02), placed(null, C.x + 52, CH, C.z - 42, 0.06).m)
    merger.add(EQ.makeWarehouse(0.98), placed(null, C.x + 50, CH, C.z + 58, 0.03).m)
    merger.add(EQ.makeLoadingRack(), placed(null, C.x - 16, CH, C.z - 58, 0).m)
    merger.add(EQ.makeFlare(), placed(null, C.x + 84, CH, C.z - 10, 0, 1.6).m)
    for (const [lx, lz] of [[-84, 58], [82, 58], [-84, -54], [66, -58]]) {
      merger.add(EQ.makeLamp(16), placed(null, C.x + lx, CH, C.z + lz, 0).m)
    }
    for (const [lx, lz] of [[88, 40], [88, 18]]) {
      merger.add(EQ.makePowerPole(12, true), placed(null, C.x + lx, CH, C.z + lz, 0).m)
    }
    merger.add(EQ.makeTruck(), placed(null, C.x + 27, CH, C.z - 41, Math.PI / 2).m)
    merger.add(EQ.makeTruck(), placed(null, C.x + 30.2, CH, C.z - 41, Math.PI / 2).m)
    merger.add(EQ.makeTruck(), placed(null, C.x + 33.4, CH, C.z - 41, Math.PI / 2).m)
    merger.add(EQ.makeTruck(), placed(null, C.x - 4, CH, C.z - 58, 1.2).m)

    // 围栏（西侧留大门）
    const fw = C.w - 6, fd = C.d - 6
    const segs = [
      [[-fw / 2, -fd / 2], [-fw / 2, -10]], [[-fw / 2, 10], [-fw / 2, fd / 2]],
      [[-fw / 2, fd / 2], [fw / 2, fd / 2]],
      [[fw / 2, fd / 2], [fw / 2, -fd / 2]],
      [[fw / 2, -fd / 2], [-fw / 2, -fd / 2]],
    ]
    for (const [a, b] of segs) {
      const f = EQ.makeFence([[C.x + a[0], C.z + a[1]], [C.x + b[0], C.z + b[1]]], 2.2)
      merger.add(f, new THREE.Matrix4().makeTranslation(0, CH, 0))
    }
    C.tag = { x: C.x, y: CH + 10, z: C.z - C.d / 2 - 10 }

    // 火炬放大到 26m，并挂火焰
    flameAnchor.set(C.x + 84, CH + 26.5, C.z - 10)
  }

  // 钻机：放在离联合站最近的井场外侧，作为竖向地标
  let rigSpot = null
  {
    let best = null, bd = Infinity
    for (const p of layout.pads) {
      const d = Math.hypot(p.cx - C.x, p.cz - C.z)
      if (d < bd && p.wells.length >= 2) { bd = d; best = p }
    }
    if (best) {
      const ang = Math.atan2(best.cz - C.z, best.cx - C.x)
      const rx = best.cx + Math.cos(ang + 1.2) * (best.w / 2 + 46)
      const rz = best.cz + Math.sin(ang + 1.2) * (best.d / 2 + 46)
      const rh = terrain.heightAt(rx, rz)
      merger.addMesh(new THREE.PlaneGeometry(52, 46).rotateX(-Math.PI / 2), matGravel,
        new THREE.Matrix4().makeTranslation(rx, rh + 0.08, rz))
      merger.add(EQ.makeDrillingRig(), placed(null, rx, rh, rz, ang + 0.4).m)
      rigSpot = { x: rx, z: rz, h: rh }
    }
  }

  /* ======================================================================
     4. 管网
     ====================================================================== */
  const pipeGroup = new THREE.Group()
  root.add(pipeGroup)
  const flowCurves = []

  {
    const pts = [
      V3(C.x - 12, CH + 0.8, C.z + 22),
      V3(C.x - 42, terrain.heightAt(C.x - 42, C.z + 90) + 0.8, C.z + 90),
      V3(C.x - 86, terrain.heightAt(C.x - 86, C.z + 260) + 0.8, C.z + 260),
      V3(C.x - 130, terrain.heightAt(C.x - 130, C.z + 520) + 0.8, C.z + 520),
    ]
    const curve = new THREE.CatmullRomCurve3(pts)
    merger.addMesh(new THREE.TubeGeometry(curve, 70, 0.34, 7, false), matPipe, null)
    flowCurves.push({ curve, speed: 0.010, count: 10, big: true })
    stats.pipeLen += curve.getLength()
  }

  layout.pads.forEach((p, i) => {
    const start = padMatrix(p, p.w / 2 + 22, 0)
    const hx = C.x + 16 + (i % 3) * 6
    const hz = C.z + 4 + (i % 4) * 5
    const mid = p.pipe[1]
    const pts = [
      V3(start.x, terrain.heightAt(start.x, start.z) + 0.7, start.z),
      V3(mid[0], terrain.heightAt(mid[0], mid[1]) + 0.7, mid[1]),
      V3(hx, CH + 0.6, hz),
    ]
    const curve = new THREE.CatmullRomCurve3(pts)
    const L = curve.getLength()
    merger.addMesh(new THREE.TubeGeometry(curve, Math.max(20, Math.floor(L / 14)), 0.17, 6, false), matPipe, null)
    // 管墩
    const n = Math.floor(L / 30)
    for (let k = 1; k < n; k++) {
      const q = curve.getPointAt(k / n)
      merger.addMesh(new THREE.BoxGeometry(1.0, 0.7, 1.0), matConcrete,
        new THREE.Matrix4().makeTranslation(q.x, terrain.heightAt(q.x, q.z) + 0.35, q.z))
    }
    flowCurves.push({ curve, speed: 0.018 + rnd() * 0.012, count: Math.max(3, Math.round(L / 150)), big: false })
    stats.pipeLen += L
    p.pipeCurve = curve
  })

  // 流动光点（实例化）
  let dotMesh = null
  const dotState = []
  {
    let total = 0
    for (const fc of flowCurves) total += fc.count
    const geo = new THREE.SphereGeometry(0.36, 6, 5)
    const mat = new THREE.MeshBasicMaterial({ color: 0x8ff2da, transparent: true, opacity: 0.65, blending: THREE.AdditiveBlending, depthWrite: false })
    dotMesh = new THREE.InstancedMesh(geo, mat, total)
    dotMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    dotMesh.frustumCulled = false
    pipeGroup.add(dotMesh)
    let idx = 0
    for (const fc of flowCurves) {
      for (let i = 0; i < fc.count; i++) {
        dotState.push({ idx: idx++, curve: fc.curve, t: i / fc.count, speed: fc.speed, s: fc.big ? 1.5 : 0.9 })
      }
    }
  }

  /* ======================================================================
     5. 电力线
     ====================================================================== */
  {
    const poles = []
    const L = mainCurve.getLength()
    const n = Math.floor(L / 64)
    for (let i = 1; i < n; i++) {
      const t = i / n
      const p = mainCurve.getPointAt(t)
      const tan = mainCurve.getTangentAt(t)
      const nx = -tan.z, nz = tan.x
      const l = Math.hypot(nx, nz) || 1
      const x = p.x + (nx / l) * 17
      const z = p.z + (nz / l) * 17
      const y = terrain.heightAt(x, z)
      const ry = Math.atan2(tan.x, tan.z)
      merger.add(EQ.makePowerPole(11, i % 7 === 0), placed(null, x, y, z, ry).m)
      poles.push({ x, y: y + 10.4, z, ry })
    }
    const wirePts = []
    for (let i = 0; i < poles.length - 1; i++) {
      const a = poles[i], b = poles[i + 1]
      for (const off of [-1.15, 0, 1.15]) {
        const ax = a.x + Math.cos(a.ry) * off, az = a.z - Math.sin(a.ry) * off
        const bx = b.x + Math.cos(b.ry) * off, bz = b.z - Math.sin(b.ry) * off
        const N = 8
        for (let k = 0; k < N; k++) {
          const t0 = k / N, t1 = (k + 1) / N
          const sag = (t) => -1.7 * Math.sin(Math.PI * t)
          wirePts.push(
            ax + (bx - ax) * t0, a.y + (b.y - a.y) * t0 + sag(t0), az + (bz - az) * t0,
            ax + (bx - ax) * t1, a.y + (b.y - a.y) * t1 + sag(t1), az + (bz - az) * t1,
          )
        }
      }
    }
    const wg = new THREE.BufferGeometry()
    wg.setAttribute('position', new THREE.Float32BufferAttribute(wirePts, 3))
    root.add(new THREE.LineSegments(wg, new THREE.LineBasicMaterial({ color: 0x2c2f2e, transparent: true, opacity: 0.8 })))
  }

  /* ======================================================================
     6. 植被
     ====================================================================== */
  const veg = new THREE.Group()
  root.add(veg)
  let grassMat = null

  // 草
  {
    const count = quality === 'low' ? 2500 : quality === 'mid' ? 4500 : 6500
    const geo = grassGeometry()
    const mat = new THREE.MeshStandardMaterial({
      map: grassTexture(), alphaTest: 0.45, side: THREE.DoubleSide,
      roughness: 1, metalness: 0, color: 0x8b8862,
    })
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = { value: 0 }
      shader.vertexShader = 'uniform float uTime;\n' + shader.vertexShader
        .replace('#include <begin_vertex>', `
          #include <begin_vertex>
          #ifdef USE_INSTANCING
            float ph = instanceMatrix[3].x * 0.11 + instanceMatrix[3].z * 0.08;
            transformed.x += sin(uTime * 1.3 + ph) * 0.13 * uv.y;
            transformed.z += cos(uTime * 1.0 + ph * 1.3) * 0.09 * uv.y;
          #endif
        `)
      mat.userData.shader = shader
    }
    grassMat = mat
    const mesh = new THREE.InstancedMesh(geo, mat, count)
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3()
    let n = 0, guard = 0
    while (n < count && guard < count * 10) {
      guard++
      const a = rnd() * 6.283
      const r = Math.sqrt(rnd()) * 900
      const x = Math.cos(a) * r, z = Math.sin(a) * r
      if (isBlocked(x, z)) continue
      const y = terrain.heightAt(x, z)
      q.setFromAxisAngle(V3(0, 1, 0), rnd() * 6.283)
      const s = 0.6 + rnd() * 1.0
      sc.set(s, s * (0.7 + rnd() * 0.9), s)
      m4.compose(V3(x, y, z), q, sc)
      mesh.setMatrixAt(n, m4)
      n++
    }
    mesh.count = n
    veg.add(mesh)
  }

  // 灌木
  {
    const count = quality === 'low' ? 800 : 2400
    const geo = new THREE.IcosahedronGeometry(1, 0)
    geo.scale(1, 0.55, 1)
    geo.translate(0, 0.4, 0)
    geo.computeVertexNormals()
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.98, metalness: 0 })
    const mesh = new THREE.InstancedMesh(geo, mat, count)
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3()
    const col = new THREE.Color()
    let n = 0, guard = 0
    while (n < count && guard < count * 10) {
      guard++
      const x = (rnd() - 0.5) * 3000, z = (rnd() - 0.5) * 3000
      if (isBlocked(x, z)) continue
      const y = terrain.heightAt(x, z)
      q.setFromAxisAngle(V3(0, 1, 0), rnd() * 6.283)
      const s = 0.7 + rnd() * 1.6
      sc.set(s, s * (0.55 + rnd() * 0.7), s)
      m4.compose(V3(x, y, z), q, sc)
      mesh.setMatrixAt(n, m4)
      col.setHSL(0.15 + rnd() * 0.05, 0.16 + rnd() * 0.12, 0.34 + rnd() * 0.13)
      mesh.setColorAt(n, col)
      n++
    }
    mesh.count = n
    mesh.castShadow = false
    veg.add(mesh)
  }

  // 树
  {
    const kinds = [0, 0, 1]
    const protos = kinds.map((k, i) => EQ.makeTree(k, i * 7 + 3))
    const buckets = []
    for (let ki = 0; ki < protos.length; ki++) {
      const meshes = []
      protos[ki].traverse((o) => { if (o.isMesh) meshes.push(o) })
      for (const m of meshes) {
        const im = new THREE.InstancedMesh(m.geometry, m.material, 120)
        im.castShadow = true
        im.receiveShadow = true
        im.count = 0
        veg.add(im)
        buckets.push({ im, kind: ki })
      }
    }
    const spots = []
    for (let x = -2700; x < 2700; x += 30) {
      const z = 880 + 150 * Math.sin(x * 0.0011) + 60 * Math.sin(x * 0.0034)
      if (rnd() < 0.5) spots.push([x + (rnd() - 0.5) * 26, z + (rnd() - 0.5) * 36, 0, 0.85 + rnd() * 0.5])
    }
    for (let i = 0; i < 80; i++) {
      const x = (rnd() - 0.5) * 2900, z = (rnd() - 0.5) * 2900
      if (isBlocked(x, z)) continue
      spots.push([x, z, rnd() < 0.5 ? 1 : 0, 0.8 + rnd() * 0.55])
    }
    for (let i = 0; i < 30; i++) {
      const a = rnd() * 6.283, r = 150 + rnd() * 80
      const x = C.x + Math.cos(a) * r, z = C.z + Math.sin(a) * r
      if (isBlocked(x, z)) continue
      spots.push([x, z, 0, 0.95 + rnd() * 0.45])
    }
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3()
    for (const [x, z, kind, s] of spots) {
      if (isBlocked(x, z)) continue
      const y = terrain.heightAt(x, z)
      q.setFromAxisAngle(V3(0, 1, 0), rnd() * 6.283)
      sc.set(s, s * (0.9 + rnd() * 0.2), s)
      m4.compose(V3(x, y, z), q, sc)
      for (const b of buckets) {
        if (b.kind !== kind || b.im.count >= 120) continue
        b.im.setMatrixAt(b.im.count++, m4)
      }
    }
    for (const b of buckets) b.im.instanceMatrix.needsUpdate = true
  }

  // 农庄
  for (let i = 0; i < 7; i++) {
    const a = rnd() * 6.283, r = 850 + rnd() * 1150
    const x = Math.cos(a) * r, z = Math.sin(a) * r
    if (isBlocked(x, z)) continue
    const y = terrain.heightAt(x, z)
    const ry = rnd() * 6.283
    merger.add(EQ.makeMeterHouse(1.0), placed(null, x, y, z, ry, 1.7).m)
    const bx = x + Math.cos(ry + 1.5) * 24, bz = z + Math.sin(ry + 1.5) * 24
    merger.add(EQ.makeWarehouse(0.92), placed(null, bx, terrain.heightAt(bx, bz), bz, ry + 0.3, 0.6).m)
    const siloMat = new THREE.MeshStandardMaterial({ color: 0xb9b9b2, roughness: 0.55, metalness: 0.5 })
    for (let k = 0; k < 2; k++) {
      const sx = x + Math.cos(ry - 1.2) * (16 + k * 7)
      const sz = z + Math.sin(ry - 1.2) * (16 + k * 7)
      merger.addMesh(new THREE.CylinderGeometry(2.4, 2.4, 13, 14), siloMat,
        new THREE.Matrix4().makeTranslation(sx, terrain.heightAt(sx, sz) + 6.5, sz))
    }
  }

  /* ---------- 火炬火焰 + 烟 ---------- */
  const glowTex = radialGlow()
  const flameOuter = new THREE.Sprite(new THREE.SpriteMaterial({
    map: glowTex, color: 0xff7a20, transparent: true, opacity: 0.85,
    blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
  }))
  flameOuter.scale.set(9, 16, 1)
  flameOuter.position.copy(flameAnchor)
  root.add(flameOuter)
  const flameInner = new THREE.Sprite(new THREE.SpriteMaterial({
    map: glowTex, color: 0xffe08a, transparent: true, opacity: 0.95,
    blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
  }))
  flameInner.scale.set(4.4, 8.5, 1)
  flameInner.position.copy(flameAnchor).add(new THREE.Vector3(0, -1.4, 0))
  root.add(flameInner)
  const smokeSprites = []
  for (let i = 0; i < 9; i++) {
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({
      map: glowTex, color: 0x6a6a66, transparent: true, opacity: 0, depthWrite: false,
    }))
    sp.position.copy(flameAnchor)
    root.add(sp)
    smokeSprites.push({ sp, t: i / 9, drift: (rnd() - 0.5) * 6 })
  }

  /* ======================================================================
     7. 合并 & 实例化
     ====================================================================== */
  merger.build(root)

  const liteMesh = buildLiteInstanced(dynamic, pumpStates)

  /* ======================================================================
     8. 更新 / 图层
     ====================================================================== */
  function update(dt, t) {
    for (const s of pumpStates) {
      const ang = Math.sin(t * s.speed + s.phase)
      const crankA = -t * s.speed * 1.4 + s.phase
      if (s.kind === 'full') {
        if (s.parts.beam) s.parts.beam.rotation.z = ang * 0.155
        if (s.parts.crank) s.parts.crank.rotation.z = crankA
        if (s.parts.rod) s.parts.rod.position.y = 4.6 + ang * 0.55
      } else {
        s.beamA = ang * 0.155
        s.crankA = crankA
        s.rodY = ang * 0.55
      }
    }
    if (liteMesh) {
      const m = new THREE.Matrix4()
      const tr = new THREE.Matrix4()
      const rot = new THREE.Matrix4()
      for (const s of pumpStates) {
        if (s.kind !== 'lite') continue
        const i = s.idx
        rot.makeRotationZ(s.beamA); tr.makeTranslation(0.1, 6.1, 0)
        liteMesh.beam.setMatrixAt(i, m.copy(s.base).multiply(tr).multiply(rot))
        rot.makeRotationZ(s.crankA); tr.makeTranslation(-1.45, 1.55, 0)
        liteMesh.crank.setMatrixAt(i, m.copy(s.base).multiply(tr).multiply(rot))
        tr.makeTranslation(4.55, 4.85 + s.rodY, 0)
        liteMesh.rod.setMatrixAt(i, m.copy(s.base).multiply(tr))
      }
      liteMesh.beam.instanceMatrix.needsUpdate = true
      liteMesh.crank.instanceMatrix.needsUpdate = true
      liteMesh.rod.instanceMatrix.needsUpdate = true
    }

    if (dotMesh) {
      const m = new THREE.Matrix4()
      const sc = new THREE.Vector3()
      for (const d of dotState) {
        d.t += dt * d.speed
        if (d.t > 1) d.t -= 1
        const p = d.curve.getPointAt(d.t)
        sc.setScalar(d.s)
        m.compose(V3(p.x, p.y + 0.06, p.z), IDENT_Q, sc)
        dotMesh.setMatrixAt(d.idx, m)
      }
      dotMesh.instanceMatrix.needsUpdate = true
    }

    if (grassMat?.userData.shader) grassMat.userData.shader.uniforms.uTime.value = t

    // 火炬
    const f = 1 + Math.sin(t * 9.1) * 0.10 + Math.sin(t * 21.7) * 0.06
    flameOuter.scale.set(9 * f, 16 * (1 + Math.sin(t * 7.3) * 0.12), 1)
    flameInner.scale.set(4.4 * f, 8.5 * (1 + Math.sin(t * 12.1) * 0.14), 1)
    for (const s2 of smokeSprites) {
      s2.t += dt * 0.075
      if (s2.t > 1) { s2.t -= 1; s2.drift = (rnd() - 0.5) * 6 }
      const k = s2.t
      s2.sp.position.set(
        flameAnchor.x + s2.drift * k * 1.6 + Math.sin(t * 0.6 + k * 8) * 1.2,
        flameAnchor.y + 4 + k * 62,
        flameAnchor.z + s2.drift * k * 0.8
      )
      const sc = 6 + k * 26
      s2.sp.scale.set(sc, sc, 1)
      s2.sp.material.opacity = Math.max(0, 0.22 * (1 - k) * Math.min(1, k * 6))
    }
  }

  function setLayer(name, on) {
    if (name === 'veg') veg.visible = on
    if (name === 'pipes') pipeGroup.visible = on
  }

  return {
    root, update, setLayer, wellMarkers, stats,
    cpfTag: C.tag, pads: layout.pads,
    focus: { cpf: { x: C.x, y: CH, z: C.z } },
  }
}

/* ==========================================================================
   工具
   ========================================================================== */
const IDENT_Q = new THREE.Quaternion()

function scaleUV(geo, sx, sy) {
  const uv = geo.attributes.uv
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * sx, uv.getY(i) * sy)
  uv.needsUpdate = true
}

function rotateLocal(x, z, a) {
  const c = Math.cos(a), s = Math.sin(a)
  return [x * c - z * s, x * s + z * c]
}

function distToSeg(px, pz, ax, az, bx, bz) {
  const vx = bx - ax, vz = bz - az
  const L2 = vx * vx + vz * vz || 1
  let t = ((px - ax) * vx + (pz - az) * vz) / L2
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(px - (ax + vx * t), pz - (az + vz * t))
}

function placed(obj, x, y, z, ry = 0, s = 1) {
  const m = new THREE.Matrix4()
  m.compose(V3(x, y, z), new THREE.Quaternion().setFromAxisAngle(V3(0, 1, 0), ry), V3(s, s, s))
  return { obj, m }
}

function grassGeometry() {
  const g1 = new THREE.PlaneGeometry(1, 1)
  g1.translate(0, 0.5, 0)
  const g2 = g1.clone()
  g2.rotateY(Math.PI / 2)
  return mergeGeometries([g1, g2], false)
}

function radialGlow() {
  const s = 128
  const c = document.createElement('canvas')
  c.width = c.height = s
  const g = c.getContext('2d')
  const grd = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2)
  grd.addColorStop(0, 'rgba(255,255,255,1)')
  grd.addColorStop(0.22, 'rgba(255,255,255,0.55)')
  grd.addColorStop(0.55, 'rgba(255,255,255,0.12)')
  grd.addColorStop(1, 'rgba(255,255,255,0)')
  g.fillStyle = grd
  g.fillRect(0, 0, s, s)
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  return t
}

function grassTexture() {
  const s = 128
  const c = document.createElement('canvas')
  c.width = c.height = s
  const g = c.getContext('2d')
  g.clearRect(0, 0, s, s)
  for (let i = 0; i < 52; i++) {
    const x = 4 + Math.random() * (s - 8)
    const h = 34 + Math.random() * 88
    const w = 1 + Math.random() * 2.2
    const lean = (Math.random() - 0.5) * 24
    const t = Math.random()
    const col = t < 0.45 ? '124,132,78' : t < 0.78 ? '150,146,96' : '102,114,72'
    g.strokeStyle = `rgba(${col},${0.7 + Math.random() * 0.3})`
    g.lineWidth = w
    g.beginPath()
    g.moveTo(x, s)
    g.quadraticCurveTo(x + lean * 0.4, s - h * 0.6, x + lean, s - h)
    g.stroke()
  }
  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}

/* 轻型抽油机原型（静态件 + 三段可动件几何） */
let _liteProto = null
function getLiteProto() {
  if (_liteProto) return _liteProto
  const g = EQ.makePumpjackLite(1)
  g.updateMatrixWorld(true)
  const parts = g.userData.parts
  const skip = new Set([parts.beam, parts.crank, parts.rod])
  const body = new THREE.Group()
  g.traverse((m) => {
    if (!m.isMesh) return
    let p = m, inSkip = false
    while (p) { if (skip.has(p)) { inSkip = true; break } p = p.parent }
    if (inSkip) return
    const clone = new THREE.Mesh(m.geometry.clone(), m.material)
    clone.applyMatrix4(m.matrixWorld)
    body.add(clone)
  })
  _liteProto = {
    body,
    beamGeo: parts.beam.children[0].geometry,
    crankGeo: parts.crank.children[0].geometry,
    rodGeo: parts.rod.children[0].geometry,
    beamMat: parts.beam.children[0].material,
    crankMat: parts.crank.children[0].material,
    rodMat: parts.rod.children[0].material,
  }
  return _liteProto
}

function buildLiteInstanced(parent, states) {
  const proto = getLiteProto()
  const list = states.filter((s) => s.kind === 'lite')
  if (!list.length) return null
  const beam = new THREE.InstancedMesh(proto.beamGeo, proto.beamMat, list.length)
  const crank = new THREE.InstancedMesh(proto.crankGeo, proto.crankMat, list.length)
  const rod = new THREE.InstancedMesh(proto.rodGeo, proto.rodMat, list.length)
  for (const m of [beam, crank, rod]) {
    m.castShadow = true
    m.receiveShadow = true
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    m.frustumCulled = false
    parent.add(m)
  }
  list.forEach((s, i) => { s.idx = i })
  return { beam, crank, rod }
}
