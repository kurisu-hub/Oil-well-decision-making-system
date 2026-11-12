// 定位用：把指定 SVG 内所有 <text> 的屏幕矩形 + 局部坐标打出来，用来判断到底谁压谁
// 用法： node tools/probe-rect.mjs [宽] [高]
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const PORT = 9397
const W = Number(process.argv[2] ?? 1366)
const H = Number(process.argv[3] ?? 768)
const fileUrl = 'file:///' + resolve('dist/index.html').replace(/\\/g, '/')

const profile = mkdtempSync(join(tmpdir(), 'rect-'))
const proc = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' })

let id = 0, ws
const pending = new Map()
const send = (m, p = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method: m, params: p })) })
const ev = async (e) => (await send('Runtime.evaluate', { expression: e, returnByValue: true }))?.result?.result?.value ?? null

const DUMP = `(() => {
  const out = [];
  document.querySelectorAll('#app svg').forEach((svg, si) => {
    const vb = (svg.getAttribute('viewBox') || '').split(/[\\s,]+/).map(Number);
    const r = svg.getBoundingClientRect();
    const texts = [...svg.querySelectorAll('text')].filter(t => (t.textContent || '').trim());
    texts.forEach(t => {
      const b = t.getBoundingClientRect();
      out.push({
        svg: si,
        cls: svg.getAttribute('class') || '',
        vb: vb.join(' '),
        svgRect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)].join(','),
        txt: (t.textContent || '').trim().slice(0, 16),
        x: t.getAttribute('x'), y: t.getAttribute('y'), fs: t.getAttribute('font-size'),
        rect: [Math.round(b.x), Math.round(b.y), Math.round(b.width), Math.round(b.height)].join(',')
      });
    });
  });
  return JSON.stringify(out);
})()`

async function main() {
  for (let i = 0; i < 80; i++) { try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) break } catch {} ; await sleep(250) }
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
  const page = list.find((t) => t.type === 'page')
  ws = new WebSocket(page.webSocketDebuggerUrl) // Node 22 全局 WebSocket
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id).res(m); pending.delete(m.id) } }
  await send('Page.enable'); await send('Runtime.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false })
  await send('Page.navigate', { url: fileUrl })
  await sleep(1500)
  // 投屏打开（第 4 参传 norm 则关掉）
  const mode = process.argv[4] ?? 'proj'
  await ev(`(() => { localStorage.setItem('weld.projection','${mode === 'proj' ? '1' : '0'}'); return 1 })()`)
  await send('Page.navigate', { url: fileUrl })
  await sleep(1500)

  const rows = JSON.parse(await ev(DUMP) ?? '[]')
  writeFileSync('docs/shots/walk/rect-dom.json', JSON.stringify(rows, null, 1))
  console.log('total texts', rows.length)
  const want = ['目的层', '套管鞋', '缝长', '0.76', '0.46', '相对深度', 'm³', '2,033', 'M6', '措施推进']
  for (const r of rows) {
    if (want.some((w) => r.txt.includes(w))) {
      console.log(`svg${r.svg}[${r.cls}] vb=${r.vb} svgRect=${r.svgRect} | "${r.txt}" x=${r.x} y=${r.y} fs=${r.fs} rect=${r.rect}`)
    }
  }
}

main().then(() => { try { ws?.close() } catch {} proc.kill(); try { rmSync(profile, { recursive: true, force: true }) } catch {} process.exit(0) })
  .catch((e) => { console.error(e); try { proc.kill() } catch {} process.exit(1) })
