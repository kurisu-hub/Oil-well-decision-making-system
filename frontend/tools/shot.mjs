// 截图脚本：无头 Edge + CDP 原生截图，不依赖 puppeteer
// 用法： node tools/shot.mjs <hash> <out.png> [宽] [高] [等待毫秒]
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const PORT = 9337
const target = resolve('dist/index.html')
if (!existsSync(target)) { console.error('找不到产物，先 npm run build'); process.exit(2) }
const fileUrl = 'file:///' + target.replace(/\\/g, '/')

const hash = process.argv[2] ?? '#/'
const out = resolve(process.argv[3] ?? 'shot.png')
const W = Number(process.argv[4] ?? 1920)
const H = Number(process.argv[5] ?? 1080)
const WAIT = Number(process.argv[6] ?? 1200)

const profile = mkdtempSync(join(tmpdir(), 'edge-shot-'))
const proc = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' })

function cleanup() { try { proc.kill() } catch {} ; try { rmSync(profile, { recursive: true, force: true }) } catch {} }

async function waitPort() {
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) return } catch {}
    await sleep(250)
  }
  throw new Error('Edge 调试端口未就绪')
}

let id = 0
let ws, send
const pending = new Map()

try {
  await waitPort()
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
  const page = list.find((t) => t.type === 'page')
  ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j })
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } }
  send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })) })

  await send('Page.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false })
  await send('Page.navigate', { url: fileUrl + hash })
  await sleep(WAIT)

  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  const b64 = shot.result?.data
  if (!b64) throw new Error('CDP 未返回图像数据：' + JSON.stringify(shot).slice(0, 200))
  writeFileSync(out, Buffer.from(b64, 'base64'))
  console.log(`已截图 → ${out}  (${W}×${H}, hash=${hash})`)
} catch (e) {
  console.error('截图失败：', e.message)
  process.exit(1)
} finally {
  cleanup()
}
