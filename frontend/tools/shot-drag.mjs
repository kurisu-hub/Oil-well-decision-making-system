// 交互验证：在世界线图上模拟拖动到指定月份，再截图
// 用法： node tools/shot-drag.mjs <月份> <out.png> [宽] [高]
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const PORT = 9339
const target = resolve('dist/index.html')
const fileUrl = 'file:///' + target.replace(/\\/g, '/')
const MONTH = Number(process.argv[2] ?? 6)
const out = resolve(process.argv[3] ?? 'shot-drag.png')
const W = Number(process.argv[4] ?? 1920)
const H = Number(process.argv[5] ?? 1080)

const profile = mkdtempSync(join(tmpdir(), 'edge-drag-'))
const proc = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' })
function cleanup() { try { proc.kill() } catch {}; try { rmSync(profile, { recursive: true, force: true }) } catch {} }
async function waitPort() {
  for (let i = 0; i < 80; i++) { try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) return } catch {}; await sleep(250) }
  throw new Error('Edge 调试端口未就绪')
}
let id = 0, ws, send
const pending = new Map()

try {
  await waitPort()
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
  const page = list.find((t) => t.type === 'page')
  ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j })
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } }
  send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })) })

  await send('Page.enable'); await send('Runtime.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false })
  await send('Page.navigate', { url: fileUrl + '#/' })
  await sleep(1600)

  // 世界线图 plot 的屏幕坐标
  const box = await send('Runtime.evaluate', {
    expression: `(() => { const r = document.querySelector('.wl .plot svg').getBoundingClientRect(); return JSON.stringify({x:r.x,y:r.y,w:r.width,h:r.height}) })()`,
    returnByValue: true,
  })
  const { x, y, w, h } = JSON.parse(box.result?.result?.value ?? '{}')
  // viewBox 900 宽，X0=58, X1=884 → 月份 m 的屏幕 x
  const frac = 58 + (884 - 58) * (MONTH / 12)
  const px = x + (frac / 900) * w
  const py = y + h * 0.4

  const down = await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: px, y: py, button: 'left', clickCount: 1, pointerType: 'mouse' })
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: px, y: py, buttons: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: px, y: py, button: 'left', buttons: 0 })
  await sleep(400)

  // 读出当前游标月份验证
  const probe = await send('Runtime.evaluate', { expression: `document.querySelector('.wl .readout').innerText`, returnByValue: true })
  console.log('readout:', String(probe.result?.result?.value).split('\n').slice(0, 3).join(' | '))

  const shot = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(out, Buffer.from(shot.result.data, 'base64'))
  console.log(`已截图 → ${out}（拖到 M${MONTH}）`)
} catch (e) { console.error('失败：', e.message); process.exit(1) } finally { cleanup() }
