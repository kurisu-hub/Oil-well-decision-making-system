// 第三幕真选井探针：默认组合命中？「顺手选可见列表前三口」会不会落空？
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const PORT = 9381
const W = Number(process.argv[2] ?? 1366)
const H = Number(process.argv[3] ?? 768)
const OUT = resolve('docs/shots/walk')
const fileUrl = 'file:///' + resolve('dist/index.html').replace(/\\/g, '/')

const profile = mkdtempSync(join(tmpdir(), 'act3-'))
const proc = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' })

let id = 0, ws
const pending = new Map()
const send = (m, p = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method: m, params: p })) })
const ev = async (e) => (await send('Runtime.evaluate', { expression: e, returnByValue: true }))?.result?.result?.value ?? null

const READ = `(() => {
  const t = document.body.innerText.replace(/\\s+/g,' ');
  const boxes = [...document.querySelectorAll('.row.cand')];
  const checked = boxes.filter(r => {
    const c = r.querySelector('.n-checkbox');
    return c && (c.getAttribute('aria-checked') === 'true' || c.classList.contains('n-checkbox--checked'));
  }).map(r => (r.querySelector('.mono')||{}).innerText || '');
  // 五栏表：取表头与每列首行数据行
  const tbl = [...document.querySelectorAll('table')].find(t => /你|基础|保守/.test(t.innerText));
  let cols = [], you = null;
  if (tbl) {
    cols = [...tbl.querySelectorAll('thead th')].map(th => th.innerText.trim());
    const rows = [...tbl.querySelectorAll('tbody tr')];
    you = rows.map(tr => [...tr.querySelectorAll('td')].map(td => td.innerText.trim()));
  }
  return JSON.stringify({
    checked,
    hit: /组合指标命中/.test(t),
    miss: /未命中|暂无组合/.test(t),
    src: (t.match(/combo_metrics|portfolio\\.points/)||[null])[0],
    cols, you,
    naCount: (t.match(/暂无/g)||[]).length
  });
})()`

async function shot(name) {
  const s = await send('Page.captureScreenshot', { format: 'png' })
  const p = join(OUT, `act3-${W}-${name}.png`)
  if (s.result?.data) { writeFileSync(p, Buffer.from(s.result.data, 'base64')); return p }
  return null
}
async function clickNthCand(n) {
  const box = await ev(`(() => {
    const rows = [...document.querySelectorAll('.row.cand')];
    const r = rows[${n}]; if (!r) return null;
    const c = r.querySelector('.n-checkbox-box') || r.querySelector('.n-checkbox');
    if (!c) return null; const b = c.getBoundingClientRect();
    return { x: b.x + b.width/2, y: b.y + b.height/2 };
  })()`)
  if (!box) return false
  return clickBox(box)
}
/** 点第 n 个「可勾选」的候选行（跳过被禁用的池外井）—— 模拟真实用户只能点亮的那些 */
async function clickNthEnabled(nth) {
  const box = await ev(`(() => {
    const rows = [...document.querySelectorAll('.row.cand')].filter(r => {
      const c = r.querySelector('.n-checkbox');
      return c && !(c.className || '').includes('disabled');
    });
    const r = rows[${nth}]; if (!r) return null;
    const c = r.querySelector('.n-checkbox-box') || r.querySelector('.n-checkbox');
    if (!c) return null; const b = c.getBoundingClientRect();
    return { x: b.x + b.width/2, y: b.y + b.height/2, id: (r.querySelector('.mono')||{}).innerText };
  })()`)
  if (!box) return null
  await clickBox(box)
  await sleep(300)
  return box.id
}
async function clickBox(box) {
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1, buttons: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1, buttons: 0 })
  await sleep(180)
  return true
}

try {
  for (let i = 0; i < 80; i++) { try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) break } catch {} ; await sleep(250) }
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
  const page = list.find(t => t.type === 'page')
  ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id).res(m); pending.delete(m.id) } }
  await send('Page.enable'); await send('Runtime.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false })

  const res = {}
  await send('Page.navigate', { url: fileUrl + '#/portfolio' })
  await sleep(1500)

  // A：开局默认
  res.A_默认 = JSON.parse(await ev(READ) ?? '{}')
  await shot('a-default')

  // B：全部取消，再「顺手选可见列表前三口」
  const n = await ev(`document.querySelectorAll('.row.cand').length`)
  for (let i = 0; i < n; i++) {
    const on = await ev(`(() => { const r=[...document.querySelectorAll('.row.cand')][${i}]; const c=r.querySelector('.n-checkbox'); return c && (c.getAttribute('aria-checked')==='true'||c.classList.contains('n-checkbox--checked')) })()`)
    if (on) await clickNthCand(i)
  }
  res.B_清空后已选 = JSON.parse(await ev(READ) ?? '{}').checked
  res.B_候选井总数 = n
  res.B_禁用井数 = await ev(`[...document.querySelectorAll('.row.cand')].filter(r => { const c=r.querySelector('.n-checkbox'); return c && (c.className||'').includes('disabled') }).length`)
  const picked = []
  for (let i = 0; i < 3; i++) { const id = await clickNthEnabled(i); if (id) picked.push(id.trim()) }
  res.B_可勾前三口 = picked
  await sleep(400)
  res.B_顺手前三口 = JSON.parse(await ev(READ) ?? '{}')
  await shot('b-first3')

  // C：试着勾第 4 口，验证 k 口上限是否拦住
  const extra = await clickNthEnabled(3)
  await sleep(300)
  res.C_勾第4口 = { tried: extra, after: JSON.parse(await ev(READ) ?? '{}').checked }
  await shot('c-overflow')

  console.log(`\n=== ${W}x${H} 第三幕选井实测 ===`)
  console.log(JSON.stringify(res, null, 2))
} finally {
  try { proc.kill() } catch {}
  try { rmSync(profile, { recursive: true, force: true }) } catch {}
}
