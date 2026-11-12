import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const PORT = 9347
const file = 'file:///' + resolve('dist/index.html').replace(/\\/g, '/')
const profile = mkdtempSync(join(tmpdir(), 'probe-'))
const proc = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' })

try {
  for (let i = 0; i < 80; i++) { try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) break } catch {}; await sleep(250) }
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
  const page = list.find((t) => t.type === 'page')
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j })
  let id = 0
  const pending = new Map()
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } }
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })) })
  await send('Page.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false })
  await send('Page.navigate', { url: file + '#/' })
  await sleep(1800)
  const expr = `(() => {
    const q = (s) => { const e = document.querySelector(s); return e ? Math.round(e.getBoundingClientRect().height) : null }
    return JSON.stringify({ cockpit: q('.cockpit'), hero: q('.area-hero'), panel: q('.hero-panel'),
      body: q('.hero-body'), slot: q('.scene-slot'), scene: q('.scene'), svg: q('.scene svg'),
      kpi: q('.kpi-strip'), pfc: q('.pfc'), axis: q('.area-axis'), dossier: q('.area-dossier') })
  })()`
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true })
  console.log(r.result?.result?.value)
} finally {
  try { proc.kill() } catch {}
  try { rmSync(profile, { recursive: true, force: true }) } catch {}
}
