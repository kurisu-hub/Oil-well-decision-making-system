// 探测：四象限阈值是否被滑杆改写（怀疑 npvThreshold 被夹到滑杆下限 -120）
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const PORT = 9395
const fileUrl = 'file:///' + resolve('dist/index.html').replace(/\\/g, '/')
const profile = mkdtempSync(join(tmpdir(), 'thr-'))
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
  await sleep(1800)

  const out = await ev(`(() => {
    const t = document.querySelector('#app').innerText;
    const grab = (re) => { const m = t.match(re); return m ? m[1] : null; };
    // 控制轨里的阈值读数
    const labels = [...document.querySelectorAll('.ctl-head')].map(h => h.innerText.replace(/\\s+/g,' ').trim());
    const sliders = [...document.querySelectorAll('.n-slider')].map(s => ({
      rail: s.className, val: s.getAttribute('aria-valuenow') || s.querySelector('[role=slider]')?.getAttribute('aria-valuenow') || null
    }));
    const quads = [...document.querySelectorAll('.quad')].map(q => q.innerText.split('\\n')[0] + ':' + (q.innerText.match(/CO\\d+/g)||[]).length);
    return JSON.stringify({
      npvThrText: grab(/NPV 阈值\\s*(-?\\d+)/),
      confThrText: grab(/P\\s*(\\d+)%/),
      kpi: grab(/建议压\\s*(\\d+)/),
      labels: labels.slice(0, 8),
      sliders: sliders.slice(0, 8),
      quads
    });
  })()`)
  console.log(out)
} finally {
  try { proc.kill() } catch {}
  try { rmSync(profile, { recursive: true, force: true }) } catch {}
}
