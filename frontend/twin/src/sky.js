/* ==========================================================================
   sky.js · 天空 / 太阳 / 云 / 远山 / 环境光照
   默认「高原午后 · 低角度暖光」，雾色与地平线同源，远山两层压在天际线上
   ========================================================================== */
import * as THREE from 'three'

export const SUN_DIR = new THREE.Vector3(-0.56, 0.70, 0.44).normalize()

const SKY_VERT = /* glsl */`
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_Position.z = gl_Position.w;   // 永远在远平面
}
`

const SKY_FRAG = /* glsl */`
precision highp float;
varying vec3 vDir;
uniform vec3 uSun;
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uGround;
uniform vec3 uSunColor;
uniform float uTime;

float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash(i), b = hash(i + vec2(1.0, 0.0));
  float c = hash(i + vec2(0.0, 1.0)), d = hash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
float fbm(vec2 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 5; i++) {
    s += a * noise(p);
    p = p * 2.07 + vec2(1.7, 9.2);
    a *= 0.5;
  }
  return s;
}

void main() {
  vec3 d = normalize(vDir);
  float h = d.y;

  // 天顶 → 地平线
  float t = pow(clamp(h, 0.0, 1.0), 0.30);
  vec3 col = mix(uHorizon, uZenith, t);

  // 地平线以下（地面反射色）
  col = mix(col, uGround, smoothstep(0.0, -0.10, h));

  // 太阳
  float sd = max(dot(d, uSun), 0.0);
  col += uSunColor * pow(sd, 1400.0) * 26.0;
  col += uSunColor * pow(sd, 24.0) * 0.62;
  col += uSunColor * pow(sd, 4.0) * 0.16;

  // 云：把方向投影到云层平面
  if (h > 0.015) {
    vec2 uv = d.xz / (h + 0.16) * 1.15;
    uv += vec2(uTime * 0.0035, uTime * 0.0012);
    float base = fbm(uv * 0.9);
    float detail = fbm(uv * 3.4 + 4.0);
    float cl = smoothstep(0.56, 0.84, base * 0.78 + detail * 0.30);
    // 靠近地平线云层变厚
    cl *= smoothstep(0.02, 0.16, h);
    float lit = 0.55 + 0.55 * pow(sd, 3.0);
    vec3 cloudCol = mix(vec3(0.62, 0.64, 0.70), vec3(1.0, 0.95, 0.87), lit);
    col = mix(col, cloudCol, cl * 0.7);
  }

  // 地平线亮带
  float band = exp(-abs(h) * 26.0);
  col += uSunColor * band * 0.05 * (0.4 + 0.6 * max(dot(normalize(vec3(d.x, 0.0, d.z)), normalize(vec3(uSun.x, 0.0, uSun.z))), 0.0));

  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
}
`

export function createSky(renderer, scene, { quality = 'high' } = {}) {
  const uniforms = {
    uSun: { value: SUN_DIR.clone() },
    uZenith: { value: new THREE.Color(0x1f5da6) },
    uHorizon: { value: new THREE.Color(0xb3c8dc) },
    uGround: { value: new THREE.Color(0x8a8570) },
    uSunColor: { value: new THREE.Color(0xfff0d6) },
    uTime: { value: 0 },
  }
  const geo = new THREE.SphereGeometry(14000, 48, 32)
  const mat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: SKY_VERT,
    fragmentShader: SKY_FRAG,
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    toneMapped: false,
  })
  const sky = new THREE.Mesh(geo, mat)
  sky.frustumCulled = false
  sky.renderOrder = -1000
  sky.name = 'sky'

  // 独立的天空场景，用来烘环境贴图（不把地形/设备烘进去）
  const skyScene = new THREE.Scene()
  const skyClone = new THREE.Mesh(geo, mat)
  skyClone.frustumCulled = false
  skyScene.add(skyClone)

  // 环境光照：PMREM
  let env = null
  try {
    const pmrem = new THREE.PMREMGenerator(renderer)
    pmrem.compileEquirectangularShader()
    const rt = pmrem.fromScene(skyScene, 0, 1, 20000)
    env = rt.texture
    scene.environment = env
    scene.environmentIntensity = 0.55
    pmrem.dispose()
  } catch (e) {
    console.warn('env map failed', e)
  }

  // 雾：与地平线同色系
  scene.fog = new THREE.FogExp2(0xbcc9d0, 0.00022)

  return {
    sky,
    uniforms,
    env,
    update(t) { uniforms.uTime.value = t },
  }
}

/* ==========================================================================
   远山：两圈山脊，颜色随距离压向雾色
   ========================================================================== */
export function createMountains({ quality = 'high' } = {}) {
  const group = new THREE.Group()
  group.name = 'mountains'

  const layers = [
    { r: 4600, hMin: 220, hMax: 430, color: 0x8b99a6, seg: quality === 'low' ? 90 : 180, y: -30 },
    { r: 6800, hMin: 380, hMax: 780, color: 0xa2aeba, seg: quality === 'low' ? 70 : 140, y: -40 },
  ]

  for (const L of layers) {
    const N = L.seg
    const pos = []
    const col = []
    const base = new THREE.Color(L.color)
    const ridge = []
    for (let i = 0; i <= N; i++) {
      const a = (i / N) * Math.PI * 2
      // 多尺度山脊
      const n1 = Math.sin(a * 2.3 + 1.2) * 0.5 + 0.5
      const n2 = Math.sin(a * 5.7 + 4.1) * 0.5 + 0.5
      const n3 = Math.sin(a * 13.1 + 0.7) * 0.5 + 0.5
      const hh = L.hMin + (L.hMax - L.hMin) * (n1 * 0.55 + n2 * 0.3 + n3 * 0.15)
      const rr = L.r + (Math.sin(a * 3.1) * 0.5 + 0.5) * 900
      ridge.push({ x: Math.cos(a) * rr, z: Math.sin(a) * rr, h: hh })
    }
    for (let i = 0; i < N; i++) {
      const a = ridge[i], b = ridge[i + 1]
      sawtooth(pos, col, a, b, base, L.y)
    }
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3))
    geo.computeVertexNormals()
    const mat = new THREE.MeshBasicMaterial({ vertexColors: true, fog: false })
    const m = new THREE.Mesh(geo, mat)
    m.frustumCulled = false
    group.add(m)
  }
  return group
}

function sawtooth(pos, col, a, b, color, y0) {
  const push = (x, y, z, k) => {
    pos.push(x, y, z)
    const c = color.clone().multiplyScalar(k)
    col.push(c.r, c.g, c.b)
  }
  const kTop = 1.0, kBot = 0.72
  // 两个三角形组成一段山墙
  push(a.x, a.h + y0, a.z, kTop)
  push(b.x, b.h + y0, b.z, kTop)
  push(b.x, y0 - 60, b.z, kBot)
  push(a.x, a.h + y0, a.z, kTop)
  push(b.x, y0 - 60, b.z, kBot)
  push(a.x, y0 - 60, a.z, kBot)
}
