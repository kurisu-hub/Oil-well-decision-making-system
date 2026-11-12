// 截图：强制 real 模式（bundle.json 不存在 → 回退 mock）时的版本条红色告警
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const PORT = 9399
const fileUrl = 'file:///' + resolve('dist/index.html').replace(/\\/g, '/')
const OUT = resolve('docs/shots/walk')
const profile = mkdtempSync(join(tmpdir(), 'fb-'))
const proc = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' })

let id = 0, ws
const pending = new Map()
const send = (m, p = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method: m, params: p })) })
const ev = async (e) => (await send('Runtime.evaluate', { expression: e, returnByValue: true }))?.result?.result?.value ?? null

try {
  for (let i = 0; i < 80; i++) { try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) break } catch {} ; await sleep(250) }
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
  ws = new WebSocket(list.find(t => t.type === 'page').webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id).res(m); pending.delete(m.id) } }
  await send('Page.enable'); await send('Runtime.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false })
  await send('Page.navigate', { url: fileUrl + '#/' })
  await sleep(1600)

  const info = await ev(`(() => {
    const t = document.querySelector('#app').innerText
    const m = t.match(/FILE\\s+(\\S+\\.json)/)
    return JSON.stringify({
      alarm: t.includes('已回退 mock'),
      alarmText: (t.match(/⚠[^\\n]*/) || [null])[0],
      file: m ? m[1] : null,
      mode: (t.match(/MODE\\s+(\\S+)/) || [])[1],
      wells: (t.match(/WELLS\\s+(\\d+)/) || [])[1]
    })
  })()`)
  console.log('回退态版本条：', info)

  const s = await send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: 1920, height: 120, scale: 1 } })
  const p = join(OUT, 'verbar-fallback-alarm.png')
  if (s.result?.data) { writeFileSync(p, Buffer.from(s.result.data, 'base64')); console.log('告警截图 →', p) }
} finally {
  try { proc.kill() } catch {}
  try { rmSync(profile, { recursive: true, force: true }) } catch {}
}
