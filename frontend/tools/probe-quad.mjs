// 四象限对账：把页面渲染的分象限井号导出，和 bundle 直算结果比对
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const PORT = 9391
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const fileUrl = 'file:///' + resolve('dist/index.html').replace(/\\/g, '/')
const profile = mkdtempSync(join(tmpdir(), 'quad-'))
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
  const dom = await ev(`(() => {
    const out = {};
    document.querySelectorAll('#app .quad').forEach(q => {
      const label = q.innerText.split('\\n')[0];
      const ids = (q.innerText.match(/CO\\d+/g) || []);
      out[label] = ids;
    });
    return JSON.stringify(out);
  })()`)
  writeFileSync(resolve('docs/shots/walk/quad-dom.json'), dom)
  console.log('DOM 分象限井数：')
  const o = JSON.parse(dom)
  for (const [k, v] of Object.entries(o)) console.log('  ', k, v.length)
  console.log('\n已写入 docs/shots/walk/quad-dom.json')
} finally {
  try { proc.kill() } catch {}
  try { rmSync(profile, { recursive: true, force: true }) } catch {}
}
