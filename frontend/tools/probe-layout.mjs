// DOM 度量探针：折叠/溢出/关键区域高度（不产出截图）
// 用法： node tools/probe-layout.mjs [宽] [高]
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const PORT = 9351
const W = Number(process.argv[2] ?? 1920)
const H = Number(process.argv[3] ?? 1080)
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
  await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false })
  await send('Page.navigate', { url: file + '#/' })
  await sleep(1800)
  const expr = `(() => {
    const one = (s) => document.querySelector(s)
    const h = (s) => { const e = one(s); return e ? Math.round(e.getBoundingClientRect().height) : null }
    const w = (s) => { const e = one(s); return e ? Math.round(e.getBoundingClientRect().width) : null }
    const hidden = (s) => { const e = one(s); return e ? Math.round(e.scrollHeight - e.clientHeight) : null }
    // 可滚动的溢出量：挑出被裁掉的元素，报告最严重的几个
    const cut = []
    document.querySelectorAll('.cockpit *').forEach((e) => {
      const cs = getComputedStyle(e)
      if (cs.overflow === 'hidden' || cs.overflowY === 'hidden') {
        const over = Math.round(e.scrollHeight - e.clientHeight)
        if (over > 2) cut.push((e.className || e.tagName) + ':+' + over)
      }
    })
    return JSON.stringify({
      cockpit: h('.cockpit'), hero: h('.area-hero'), panel: h('.hero-panel'),
      body: h('.hero-body'), slot: h('.scene-slot'), scene: h('.scene'),
      sceneW: w('.scene'), svgW: w('.scene svg'), svgH: h('.scene svg'),
      detail: h('.scene-detail'), detailSvg: h('.d-svg'),
      kpi: h('.kpi-strip'), pfc: h('.pfc'), axis: h('.area-axis'), dossier: h('.area-dossier'),
      rail: h('.area-rail'), railOver: hidden('.area-rail'), dossierOver: hidden('.area-dossier'),
      heroBodyScroll: hidden('.hero-body'), wlSvg: h('.axis-wl svg'), wlH: h('.area-axis'),
      cut: cut.slice(0, 12)
    })
  })()`
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true })
  console.log(r.result?.result?.value)
} finally {
  try { proc.kill() } catch {}
  try { rmSync(profile, { recursive: true, force: true }) } catch {}
}
