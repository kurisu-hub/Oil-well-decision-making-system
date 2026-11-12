// 验证补资料 σ 拖动：在 VOI 滑轨上按相对位置点击 → 读期望净收益 → 截图
// 用法： node tools/shot-voi.mjs <相对位置0~1> <out.png>
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const PORT = 9351
const file = 'file:///' + resolve('dist/index.html').replace(/\\/g, '/')
const FRAC = Number(process.argv[2] ?? 0.85)
const out = resolve(process.argv[3] ?? 'shot-voi.png')

const profile = mkdtempSync(join(tmpdir(), 'voi-'))
const proc = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' })
function cleanup() { try { proc.kill() } catch {}; try { rmSync(profile, { recursive: true, force: true }) } catch {} }

let id = 0, ws, send
const pending = new Map()
try {
  for (let i = 0; i < 80; i++) { try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) break } catch {}; await sleep(250) }
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
  const page = list.find((t) => t.type === 'page')
  ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j })
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } }
  send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })) })

  await send('Page.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false })
  await send('Page.navigate', { url: file + '#/' })
  await sleep(1600)

  const box = await send('Runtime.evaluate', {
    expression: `(() => { const e = document.querySelector('.voi .n-slider'); if (!e) return null; const r = e.getBoundingClientRect(); return JSON.stringify({x:r.x,y:r.y,w:r.width,h:r.height}) })()`,
    returnByValue: true,
  })
  const b = JSON.parse(box.result?.result?.value ?? 'null')
  if (!b) throw new Error('未找到 VOI 滑轨')
  const px = b.x + b.w * FRAC
  const py = b.y + b.h / 2
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: px, y: py, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: px, y: py, button: 'left', buttons: 0 })
  await sleep(500)

  const probe = await send('Runtime.evaluate', { expression: `document.querySelector('.voi').innerText.replace(/\\n/g,' | ')`, returnByValue: true })
  console.log('VOI:', String(probe.result?.result?.value).slice(0, 320))

  const shot = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(out, Buffer.from(shot.result.data, 'base64'))
  console.log(`已截图 → ${out}（σ 拖到 ${Math.round(FRAC * 100)}%）`)
} catch (e) { console.error('失败：', e.message); process.exit(1) } finally { cleanup() }
