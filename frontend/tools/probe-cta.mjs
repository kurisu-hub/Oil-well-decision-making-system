// 补验：1366 / 1920 下「导出报告」入口是否可见可点（走查脚本 S5 用 URL 直跳，未验点击）
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const PORT = 9377
const W = Number(process.argv[2] ?? 1366)
const H = Number(process.argv[3] ?? 768)
const fileUrl = 'file:///' + resolve('dist/index.html').replace(/\\/g, '/')

const profile = mkdtempSync(join(tmpdir(), 'cta-'))
const proc = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' })

let id = 0, ws
const pending = new Map()
const send = (method, params = {}) => new Promise((res, rej) => {
  const i = ++id; pending.set(i, { res, rej })
  ws.send(JSON.stringify({ id: i, method, params }))
})
const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true }))?.result?.result?.value ?? null

try {
  for (let i = 0; i < 80; i++) { try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) break } catch {} ; await sleep(250) }
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
  const page = list.find(t => t.type === 'page')
  ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id).res(m); pending.delete(m.id) } }

  await send('Page.enable'); await send('Runtime.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false })

  const out = {}
  for (const [label, hash] of [['第一幕', '#/panorama'], ['第三幕', '#/portfolio'], ['第四幕', '#/review']]) {
    await send('Page.navigate', { url: fileUrl + hash })
    await sleep(1200)
    const probe = await ev(`(() => {
      const r = [];
      document.querySelectorAll('button, a, [role=button]').forEach(b => {
        const t = (b.innerText || '').trim();
        if (!/报告|导出|打印/.test(t)) return;
        const bb = b.getBoundingClientRect(); const cs = getComputedStyle(b);
        r.push({ t: t.slice(0,14), w: Math.round(bb.width), h: Math.round(bb.height), y: Math.round(bb.y), disp: cs.display, detached: b.offsetParent === null });
      });
      const sr = document.querySelector('.side-right');
      return { ctas: r, sideRight: sr ? getComputedStyle(sr).display : 'n/a' };
    })()`)
    out[label] = probe
  }

  // 实测：在第三幕点顶栏「导出报告」，看是否一次进入报告页
  await send('Page.navigate', { url: fileUrl + '#/portfolio' })
  await sleep(1200)
  const box = await ev(`(() => {
    const b = [...document.querySelectorAll('button, a')].find(x => /导出报告/.test(x.innerText||''));
    if (!b) return null; const r = b.getBoundingClientRect();
    return { x: r.x + r.width/2, y: r.y + r.height/2 };
  })()`)
  let hashAfter = 'no-button'
  if (box) {
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1, buttons: 1 })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1, buttons: 0 })
    await sleep(700)
    hashAfter = await ev('location.hash')
  }
  console.log(`\n=== ${W}x${H} 报告入口实测 ===`)
  console.log(JSON.stringify(out, null, 2))
  console.log('第三幕点顶栏「导出报告」→ hash =', hashAfter)
} finally {
  try { proc.kill() } catch {}
  try { rmSync(profile, { recursive: true, force: true }) } catch {}
}
