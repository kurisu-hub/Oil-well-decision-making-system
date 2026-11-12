/* ==========================================================================
   terrain.js · 高平原地形
   · 程序化高程（fbm）+ 井场/联合站平整
   · 2048² 宏观地表贴图（农田拼块 / 条田 / 中心支轴 / 土路 / 井场）
   · 细节噪声在 shader 里叠两层，近看有颗粒、远看有田块
   ========================================================================== */
import * as THREE from 'three'

const SIZE = 6000

/* ---------------- 噪声 ---------------- */
function hash2(ix, iy) {
  let h = Math.imul(ix, 374761393) + Math.imul(iy, 668265263)
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}
function vnoise(x, y) {
  const ix = Math.floor(x), iy = Math.floor(y)
  const fx = x - ix, fy = y - iy
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy)
  const a = hash2(ix, iy), b = hash2(ix + 1, iy), c = hash2(ix, iy + 1), d = hash2(ix + 1, iy + 1)
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy
}
function fbm(x, y, oct = 4) {
  let s = 0, amp = 0.5, f = 1, norm = 0
  for (let i = 0; i < oct; i++) {
    s += amp * vnoise(x * f, y * f)
    norm += amp
    f *= 2.03
    amp *= 0.5
  }
  return s / norm
}
const smoothstep = (a, b, x) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

/* ---------------- 基础高程 ---------------- */
function baseHeight(x, z) {
  let h = (fbm(x * 0.00082, z * 0.00082, 4) - 0.5) * 44
  h += (fbm(x * 0.0031, z * 0.0031, 3) - 0.5) * 8.5
  h += (fbm(x * 0.0125, z * 0.0125, 2) - 0.5) * 1.5
  // 季节性冲沟（东西向，浅凹）
  const vz = 880 + 150 * Math.sin(x * 0.0011) + 60 * Math.sin(x * 0.0034)
  h -= 8.5 * Math.exp(-Math.pow((z - vz) / 150, 2))
  // 北侧缓坡抬升，给天际一点层次
  h += 7 * smoothstep(300, 1500, -z)
  return h
}

/* ---------------- 矩形距离（圆角） ---------------- */
function rectDist(x, z, w, d, rot) {
  let dx = x, dz = z
  if (rot) {
    const c = Math.cos(-rot), s = Math.sin(-rot)
    dx = x * c - z * s
    dz = x * s + z * c
  }
  const qx = Math.abs(dx) - w / 2
  const qz = Math.abs(dz) - d / 2
  const ox = Math.max(qx, 0), oz = Math.max(qz, 0)
  return Math.hypot(ox, oz) + Math.min(Math.max(qx, qz), 0)
}

/* ---------------- 生成器 ---------------- */
export function createTerrain({ layout, quality = 'high' }) {
  const SEG = quality === 'low' ? 200 : quality === 'mid' ? 260 : 320
  const RES = quality === 'low' ? 1536 : 4096

  // 平整区：井场 + 联合站
  const flats = []
  for (const p of layout.pads) {
    flats.push({ x: p.cx, z: p.cz, w: p.w + 16, d: p.d + 16, rot: p.rot, r: 34, h: baseHeight(p.cx, p.cz) })
  }
  flats.push({
    x: layout.cpf.x, z: layout.cpf.z, w: layout.cpf.w + 10, d: layout.cpf.d + 10,
    rot: 0, r: 46, h: baseHeight(layout.cpf.x, layout.cpf.z),
  })

  function heightAt(x, z) {
    let h = baseHeight(x, z)
    for (const f of flats) {
      const d = rectDist(x - f.x, z - f.z, f.w, f.d, f.rot)
      if (d < f.r) {
        const w = 1 - smoothstep(f.r * 0.35, f.r, d)
        h = h * (1 - w) + f.h * w
      }
    }
    return h
  }

  function normalAt(x, z, e = 2.5) {
    const hL = heightAt(x - e, z), hR = heightAt(x + e, z)
    const hD = heightAt(x, z - e), hU = heightAt(x, z + e)
    const n = new THREE.Vector3(hL - hR, 2 * e, hD - hU).normalize()
    return n
  }

  /* ---------- 宏观地表贴图 ---------- */
  const macroTex = makeMacroTexture(layout, RES, heightAt)

  /* ---------- 细节贴图 ---------- */
  const detailTex = makeDetailTexture()

  /* ---------- 网格 ---------- */
  const geo = new THREE.PlaneGeometry(SIZE, SIZE, SEG, SEG)
  geo.rotateX(-Math.PI / 2)
  const pos = geo.attributes.position
  const colors = new Float32Array(pos.count * 3)
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), z = pos.getZ(i)
    pos.setY(i, heightAt(x, z))
    const n = normalAt(x, z, 6)
    const slope = 1 - n.y
    const rock = smoothstep(0.10, 0.34, slope)
    const dry = 0.86 + 0.14 * fbm(x * 0.004, z * 0.004, 3)
    const shade = 0.92 + 0.16 * fbm(x * 0.02, z * 0.02, 2)
    // 岩石色 vs 土色
    const r = (0.94 * (1 - rock) + 0.72 * rock) * dry * shade
    const g = (0.94 * (1 - rock) + 0.68 * rock) * dry * shade
    const b = (0.88 * (1 - rock) + 0.60 * rock) * dry * shade
    colors[i * 3] = r
    colors[i * 3 + 1] = g
    colors[i * 3 + 2] = b
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  geo.computeVertexNormals()

  // 微起伏：让地面在掠射光下有颗粒，不像塑料
  const microTex = makeMicroTexture()
  microTex.repeat.set(620, 620)

  const mat = new THREE.MeshStandardMaterial({
    map: macroTex,
    vertexColors: true,
    roughness: 0.96,
    metalness: 0.0,
    bumpMap: microTex,
    bumpScale: 0.55,
    dithering: true,
  })
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.detailMap = { value: detailTex }
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform sampler2D detailMap;')
      .replace('#include <map_fragment>', `
        vec4 sampledDiffuseColor = texture2D( map, vMapUv );
        float d1 = texture2D( detailMap, vMapUv * 620.0 ).r;
        float d2 = texture2D( detailMap, vMapUv * 96.0 ).r;
        float d3 = texture2D( detailMap, vMapUv * 23.0 ).r;
        // 干湿/枯荣差异：偏黄 vs 偏绿，而不是单纯明暗
        vec3 dryTint = vec3(1.06, 1.02, 0.86);
        vec3 wetTint = vec3(0.86, 0.96, 0.80);
        vec3 tint = mix(dryTint, wetTint, smoothstep(0.35, 0.68, d3));
        sampledDiffuseColor.rgb *= tint * (0.72 + 0.56 * d1) * (0.82 + 0.34 * d2);
        diffuseColor *= sampledDiffuseColor;
      `)
  }

  const mesh = new THREE.Mesh(geo, mat)
  mesh.receiveShadow = true
  mesh.name = 'terrain'

  // 远景底板，避免地形边缘露出虚空
  const far = new THREE.Mesh(
    new THREE.PlaneGeometry(26000, 26000),
    new THREE.MeshBasicMaterial({ color: 0xbcc9d0, fog: false })
  )
  far.rotation.x = -Math.PI / 2
  far.position.y = -40
  far.receiveShadow = false

  return { mesh, far, heightAt, normalAt, macroTex, size: SIZE, flats }
}

/* ==========================================================================
   宏观贴图：把「科罗拉多高平原的农田」画进 2048²
   ========================================================================== */
function makeMacroTexture(layout, RES, heightAt) {
  const c = document.createElement('canvas')
  c.width = c.height = RES
  const g = c.getContext('2d')
  const S = RES / SIZE
  const px = (x) => (x + SIZE / 2) * S
  const py = (z) => (z + SIZE / 2) * S

  /* --- 底色：干草场 --- */
  g.fillStyle = '#8b8459'
  g.fillRect(0, 0, RES, RES)
  for (let i = 0; i < 9000; i++) {
    const x = Math.random() * RES, y = Math.random() * RES
    const r = 6 + Math.random() * 70
    const t = Math.random()
    const col = t < 0.30 ? '104,116,72' : t < 0.55 ? '150,140,94' : t < 0.8 ? '124,112,80' : '92,100,66'
    const grd = g.createRadialGradient(x, y, 0, x, y, r)
    grd.addColorStop(0, `rgba(${col},${0.16 + Math.random() * 0.26})`)
    grd.addColorStop(1, `rgba(${col},0)`)
    g.fillStyle = grd
    g.beginPath(); g.arc(x, y, r, 0, 6.283); g.fill()
  }
  // 干草斑块
  for (let i = 0; i < 2600; i++) {
    const x = Math.random() * RES, y = Math.random() * RES
    const r = 3 + Math.random() * 26
    g.fillStyle = `rgba(${172 + Math.random() * 30 | 0},${158 + Math.random() * 26 | 0},108,${0.05 + Math.random() * 0.12})`
    g.beginPath(); g.ellipse(x, y, r, r * (0.4 + Math.random() * 0.6), Math.random() * 3, 0, 6.283); g.fill()
  }

  /* --- 条田：一英里分区再切四块 --- */
  const SECTION = 1609 * 0.92 // 与井位同一压缩比
  const PALETTE = [
    [150, 146, 98], [176, 160, 112], [192, 176, 132], [126, 134, 84],
    [112, 100, 70], [160, 146, 100], [108, 120, 76], [198, 182, 140],
    [136, 146, 96], [168, 152, 108], [96, 104, 70], [186, 172, 128],
  ]
  const nx = Math.ceil(SIZE / SECTION) + 2
  for (let i = -1; i < nx; i++) {
    for (let j = -1; j < nx; j++) {
      const bx = -SIZE / 2 + i * SECTION
      const bz = -SIZE / 2 + j * SECTION
      // 每分区 2×2 条田，随机合并
      for (let u = 0; u < 2; u++) {
        for (let v = 0; v < 2; v++) {
          if (Math.random() < 0.12) continue
          const x0 = bx + u * SECTION / 2 + 6 + Math.random() * 8
          const z0 = bz + v * SECTION / 2 + 6 + Math.random() * 8
          const w = SECTION / 2 - 14 - Math.random() * 10
          const d = SECTION / 2 - 14 - Math.random() * 10
          const col = PALETTE[(Math.random() * PALETTE.length) | 0]
          const a = 0.55 + Math.random() * 0.3
          g.fillStyle = `rgba(${col[0]},${col[1]},${col[2]},${a})`
          g.fillRect(px(x0), py(z0), w * S, d * S)
          // 犁沟
          if (Math.random() < 0.72) {
            const vertical = Math.random() < 0.5
            g.strokeStyle = `rgba(${col[0] * 0.82 | 0},${col[1] * 0.82 | 0},${col[2] * 0.8 | 0},0.30)`
            g.lineWidth = Math.max(1, 1.2)
            const step = (5 + Math.random() * 5) * S
            g.beginPath()
            if (vertical) {
              for (let xx = px(x0); xx < px(x0 + w); xx += step) { g.moveTo(xx, py(z0)); g.lineTo(xx, py(z0 + d)) }
            } else {
              for (let yy = py(z0); yy < py(z0 + d); yy += step) { g.moveTo(px(x0), yy); g.lineTo(px(x0 + w), yy) }
            }
            g.stroke()
          }
        }
      }
    }
  }

  /* --- 中心支轴灌溉（圆形地块） --- */
  for (let k = 0; k < 5; k++) {
    const x = (Math.random() - 0.5) * SIZE * 0.82
    const z = (Math.random() - 0.5) * SIZE * 0.82
    const r = 170 + Math.random() * 130
    const grd = g.createRadialGradient(px(x), py(z), r * 0.15 * S, px(x), py(z), r * S)
    grd.addColorStop(0, 'rgba(104,126,68,0.62)')
    grd.addColorStop(0.82, 'rgba(112,132,74,0.58)')
    grd.addColorStop(1, 'rgba(116,120,78,0.25)')
    g.fillStyle = grd
    g.beginPath(); g.arc(px(x), py(z), r * S, 0, 6.283); g.fill()
    g.strokeStyle = 'rgba(78,92,56,0.45)'
    g.lineWidth = Math.max(1, 2 * S)
    g.beginPath(); g.arc(px(x), py(z), r * S * 0.97, 0, 6.283); g.stroke()
    // 支轴臂
    g.strokeStyle = 'rgba(120,120,104,0.35)'
    g.lineWidth = Math.max(1, 1.5 * S)
    const a = Math.random() * 6.28
    g.beginPath(); g.moveTo(px(x), py(z)); g.lineTo(px(x + Math.cos(a) * r), py(z + Math.sin(a) * r)); g.stroke()
  }

  /* --- 分区土路（一英里网格） --- */
  g.lineCap = 'butt'
  for (let i = -1; i < nx; i++) {
    const p = px(-SIZE / 2 + i * SECTION)
    g.strokeStyle = 'rgba(196,180,146,0.55)'
    g.lineWidth = Math.max(1.6, 2.6 * S)
    g.beginPath(); g.moveTo(p, 0); g.lineTo(p, RES); g.stroke()
    g.beginPath(); g.moveTo(0, p); g.lineTo(RES, p); g.stroke()
  }

  /* --- 冲沟 / 河沟 --- */
  g.strokeStyle = 'rgba(74,88,56,0.62)'
  g.lineWidth = 7 * S
  g.beginPath()
  for (let x = -SIZE / 2; x <= SIZE / 2; x += 40) {
    const z = 880 + 150 * Math.sin(x * 0.0011) + 60 * Math.sin(x * 0.0034)
    x === -SIZE / 2 ? g.moveTo(px(x), py(z)) : g.lineTo(px(x), py(z))
  }
  g.stroke()
  g.strokeStyle = 'rgba(150,146,108,0.4)'
  g.lineWidth = 13 * S
  g.globalAlpha = 0.35
  g.stroke()
  g.globalAlpha = 1

  /* --- 井场（碎石地坪） --- */
  for (const p of layout.pads) {
    g.save()
    g.translate(px(p.cx), py(p.cz))
    g.rotate(p.rot)
    const w = (p.w + 12) * S, d = (p.d + 12) * S
    g.fillStyle = 'rgba(150,143,124,0.95)'
    g.fillRect(-w / 2, -d / 2, w, d)
    g.strokeStyle = 'rgba(120,114,98,0.8)'
    g.lineWidth = 2
    g.strokeRect(-w / 2, -d / 2, w, d)
    g.restore()
    // 支路
    g.strokeStyle = 'rgba(178,166,138,0.95)'
    g.lineWidth = 4.4 * S
    g.beginPath()
    p.spur.forEach(([x, z], i) => (i ? g.lineTo(px(x), py(z)) : g.moveTo(px(x), py(z))))
    g.stroke()
  }

  /* --- 联合站场坪 --- */
  {
    const w = layout.cpf.w * S, d = layout.cpf.d * S
    g.fillStyle = 'rgba(158,152,136,0.97)'
    g.fillRect(px(layout.cpf.x) - w / 2, py(layout.cpf.z) - d / 2, w, d)
    g.strokeStyle = 'rgba(190,182,160,0.9)'
    g.lineWidth = 3
    g.strokeRect(px(layout.cpf.x) - w / 2, py(layout.cpf.z) - d / 2, w, d)
  }

  /* --- 主路 / 纵路 --- */
  const drawRoad = (pts, width, color) => {
    g.strokeStyle = color
    g.lineWidth = width * S
    g.lineJoin = 'round'
    g.lineCap = 'round'
    g.beginPath()
    pts.forEach(([x, z], i) => (i ? g.lineTo(px(x), py(z)) : g.moveTo(px(x), py(z))))
    g.stroke()
  }
  drawRoad(layout.mainRoad, 9.5, 'rgba(92,90,84,0.92)')
  drawRoad(layout.mainRoad, 7.2, 'rgba(70,70,66,0.95)')
  drawRoad(layout.crossRoad, 6.4, 'rgba(176,164,138,0.9)')

  /* --- 细噪点 --- */
  const img = g.getImageData(0, 0, RES, RES)
  const data = img.data
  for (let i = 0; i < data.length; i += 4) {
    const n = (Math.random() - 0.5) * 14
    data[i] += n; data[i + 1] += n; data[i + 2] += n * 0.8
  }
  g.putImageData(img, 0, 0)

  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.anisotropy = 8
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping
  return tex
}

/* ---------------- 细节噪声贴图 ---------------- */
function makeDetailTexture() {
  const s = 256
  const c = document.createElement('canvas')
  c.width = c.height = s
  const g = c.getContext('2d')
  const img = g.createImageData(s, s)
  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      // 可平铺的 value noise（取四角混合）
      const v = 0.5 * vnoise(x * 0.09, y * 0.09) + 0.3 * vnoise(x * 0.23, y * 0.23) + 0.2 * vnoise(x * 0.6, y * 0.6)
      const i = (y * s + x) * 4
      const c8 = Math.max(0, Math.min(255, v * 255))
      img.data[i] = img.data[i + 1] = img.data[i + 2] = c8
      img.data[i + 3] = 255
    }
  }
  g.putImageData(img, 0, 0)
  const t = new THREE.CanvasTexture(c)
  t.wrapS = t.wrapT = THREE.RepeatWrapping
  t.colorSpace = THREE.NoColorSpace
  return t
}

/* ---------------- 微起伏贴图 ---------------- */
function makeMicroTexture() {
  const s = 256
  const c = document.createElement('canvas')
  c.width = c.height = s
  const g = c.getContext('2d')
  const img = g.createImageData(s, s)
  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      const v = 0.45 * vnoise(x * 0.35, y * 0.35) + 0.35 * vnoise(x * 0.9, y * 0.9) + 0.2 * vnoise(x * 2.1, y * 2.1)
      const i = (y * s + x) * 4
      const c8 = Math.max(0, Math.min(255, v * 255))
      img.data[i] = img.data[i + 1] = img.data[i + 2] = c8
      img.data[i + 3] = 255
    }
  }
  g.putImageData(img, 0, 0)
  const t = new THREE.CanvasTexture(c)
  t.wrapS = t.wrapT = THREE.RepeatWrapping
  t.colorSpace = THREE.NoColorSpace
  return t
}

export { SIZE as TERRAIN_SIZE, fbm, vnoise, smoothstep }
