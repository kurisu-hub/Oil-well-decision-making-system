// 交互验证：按文本点击控制轨档位 → 探针读数 → 截图
// 用法： node tools/shot-step.mjs <out.png> <选择器> <文本1> [文本2...]
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const PORT = 9341
const target = resolve('dist/index.html')
const fileUrl = 'file:///' + target.replace(/\\/g, '/')
const out = resolve(process.argv[2] ?? 'shot-step.png')
const SEL = process.argv[3] ?? '.area-rail .tickbtn'
const TEXTS = process.argv.slice(4)
const W = Number(process.env.SHOT_W ?? 1920)
const H = Number(process.env.SHOT_H ?? 1080)

const profile = mkdtempSync(join(tmpdir(), 'edge-step-'))
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

  const before = await send('Runtime.evaluate', {
    expression: `(() => {
      const pf = document.querySelector('.pfc');
      const chips = [...document.querySelectorAll('.area-rail .chip')].map(c => c.innerText.trim());
      return JSON.stringify({
        combo: pf ? pf.innerText.split('\\n').slice(0,14).join(' | ') : 'NO-PFC',
        plan: chips.join(',')
      })
    })()`, returnByValue: true,
  })
  console.log('[改前]', before.result?.result?.value)

  for (const t of TEXTS) {
    const r = await send('Runtime.evaluate', {
      expression: `(() => {
        const els = [...document.querySelectorAll(${JSON.stringify(SEL)})];
        const hit = els.find(e => (e.innerText || '').trim() === ${JSON.stringify(t)});
        if (!hit) return 'NOT-FOUND';
        hit.click(); return 'OK';
      })()`, returnByValue: true,
    })
    await sleep(400)
    console.log(`点击「${t}」→`, r.result?.result?.value)
  }
  await sleep(600)

  const after = await send('Runtime.evaluate', {
    expression: `(() => {
      const pf = document.querySelector('.pfc');
      const chips = [...document.querySelectorAll('.area-rail .chip')].map(c => c.innerText.trim());
      const voi = document.querySelector('.voi');
      return JSON.stringify({
        combo: pf ? pf.innerText.split('\\n').slice(0,14).join(' | ') : 'NO-PFC',
        plan: chips.join(','),
        voi: voi ? voi.innerText.replace(/\\n/g,' | ').slice(0,240) : 'NO-VOI'
      })
    })()`, returnByValue: true,
  })
  console.log('[改后]', after.result?.result?.value)

  const shot = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(out, Buffer.from(shot.result.data, 'base64'))
  console.log(`已截图 → ${out}`)
} catch (e) { console.error('失败：', e.message); process.exit(1) } finally { cleanup() }
