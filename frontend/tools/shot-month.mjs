// 交互验证：拖动时间轴到指定月份 → 打印世界线/井区/详图读数 → 截图
// 用法： node tools/shot-month.mjs <月份> <out.png> [宽] [高]
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const EDGE = 'C://Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const PORT = 9357
const MONTH = Number(process.argv[2] ?? 6)
const out = resolve(process.argv[3] ?? 'shot-month.png')
const W = Number(process.argv[4] ?? 1920)
const H = Number(process.argv[5] ?? 1080)
const fileUrl = 'file:///' + resolve('dist/index.html').replace(/\\/g, '/')
const profile = mkdtempSync(join(tmpdir(), 'edge-month-'))
const proc = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' })

let id = 0, ws, send
const pending = new Map()
const ev = (expr) => send('Runtime.evaluate', { expression: expr, returnByValue: true })

try {
  for (let i = 0; i < 80; i++) { try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) break } catch {}; await sleep(250) }
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
  const page = list.find((t) => t.type === 'page')
  ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j })
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } }
  send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })) })

  await send('Page.enable'); await send('Runtime.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false })
  await send('Page.navigate', { url: fileUrl + '#/' })
  await sleep(1700)

  // 世界线拖动命中区（透明 rect）几何
  const box = await ev(`(() => {
    const r = document.querySelector(".axis-wl svg");
    if (!r) return 'null';
    const b = r.getBoundingClientRect();
    return JSON.stringify({ x: b.x, y: b.y, w: b.width, h: b.height })
  })()`)
  const g = JSON.parse(box.result?.result?.value ?? 'null')
  if (!g) throw new Error('找不到世界线命中区')
  const PAD_L = 58, PAD_R = 16, VW = 900
  const xOf = (m) => g.x + ((PAD_L + ((VW - PAD_L - PAD_R) * m) / 12) / VW) * g.w
  const yMid = g.y + g.h * 0.5
  for (const type of ['mousePressed', 'mouseMoved', 'mouseReleased']) {
    await send('Input.dispatchMouseEvent', {
      type, x: xOf(MONTH), y: yMid, button: 'left', clickCount: 1, buttons: type === 'mouseReleased' ? 0 : 1,
    })
    await sleep(160)
  }
  await sleep(700)

  const probe = await ev(`(() => {
    const t = (s) => { const e = document.querySelector(s); return e ? e.innerText.replace(/\\s+/g, ' ').trim() : null }
    const svg = document.querySelector('.scene-main svg')
    const fracT = svg ? [...svg.querySelectorAll('.frac')].map(p => {
      const st = p.getAttribute('style') || ''
      const m = st.match(/scale\\(([^)]+)\\)/)
      return m ? Number(m[1]).toFixed(2) : 'na'
    }) : []
    return JSON.stringify({
      wl: t('.axis-wl'),
      detail: (t('.scene-detail') || '').slice(0, 220),
      stamps: [...document.querySelectorAll('.scene .legend .stamp')].map(e => e.innerText.trim()),
      fracScale: [...new Set(fracT)],
      cursor: (document.querySelector('.axis-wl') || {}).innerText?.match(/游标[^|]*?M\\d+/)?.[0] ?? null
    })
  })()`)
  console.log(probe.result?.result?.value)

  const shot = await send('Page.captureScreenshot', { format: 'png' })
  const data = shot.result?.data
  if (!data) throw new Error('截图失败：' + JSON.stringify(shot).slice(0, 300))
  writeFileSync(out, Buffer.from(data, 'base64'))
  console.log('已截图 →', out)
} finally {
  try { ws?.close() } catch {}
  try { proc.kill() } catch {}
  try { rmSync(profile, { recursive: true, force: true }) } catch {}
}
