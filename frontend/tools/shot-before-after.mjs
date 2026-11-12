// before / after 对照：同一页面、同一分辨率，靠「运行时注入还原样式」复现修复前状态
// 用法： node tools/shot-before-after.mjs [宽] [高]
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const PORT = 9395
const W = Number(process.argv[2] ?? 1366)
const H = Number(process.argv[3] ?? 768)
const OUT = resolve('docs/shots/walk')
const fileUrl = 'file:///' + resolve('dist/index.html').replace(/\\/g, '/')

/* 修复前的规则（与本次改动一一对应，只用于复现 before，不写进产物） */
const REVERT = `
.proj .panel-title { flex-wrap: nowrap !important; margin-bottom: 10px !important; }
.proj .panel-title .fig-cap { white-space: nowrap !important; overflow: hidden !important; text-overflow: ellipsis !important; }
.proj svg.chart text[font-size="8"], .proj svg.chart g[font-size="8"] { font-size: 11px !important; }
.proj svg.chart text[font-size="10"] { font-size: 13px !important; }
@media (max-width: 1440px) { .proj .bar-row { grid-template-columns: 132px 1fr 56px !important; } }
.bar-lab { overflow: hidden !important; text-overflow: ellipsis !important; white-space: nowrap !important; line-height: 1.45 !important; }
.d-head { flex-wrap: nowrap !important; }
.d-title { flex: 0 1 auto !important; overflow: hidden !important; text-overflow: ellipsis !important; }
.col.small > .row { flex-wrap: nowrap !important; }
.col.small > .row > .grow.muted { flex: 1 1 0 !important; }
.proj { --chip-fs: 10px !important; --chip-h: 18px !important; }
@media (max-width: 1440px) { .proj .cockpit { grid-template-rows: minmax(0, 1fr) minmax(140px, 168px) !important; } }
`

const FIND = `(() => {
  const out = [];
  document.querySelectorAll('#app *').forEach(el => {
    if (el.namespaceURI !== 'http://www.w3.org/1999/xhtml') return;
    if (el.children.length) return;
    const t = (el.textContent || '').trim();
    if (!t) return;
    if (!(el.scrollWidth > el.clientWidth + 2 && el.clientWidth > 0)) return;
    const r = el.getBoundingClientRect();
    out.push({ t: t.slice(0, 22), x: r.x, y: r.y, w: r.width, h: r.height, need: el.scrollWidth - el.clientWidth, svgy: false });
  });
  // SVG：文字越出 svg 画布
  document.querySelectorAll('#app svg').forEach(svg => {
    const R = svg.getBoundingClientRect(); if (!R.width || !R.height) return;
    svg.querySelectorAll('text').forEach(t => {
      const txt = (t.textContent || '').trim(); if (!txt) return;
      const r = t.getBoundingClientRect(); if (!r.width) return;
      const over = Math.max(R.left - r.left, r.right - R.right, R.top - r.top, r.bottom - R.bottom);
      if (over > 0.5) {
        out.push({ t: txt.slice(0, 22), x: r.x, y: r.y, w: r.width, h: r.height, need: Math.round(over), svgy: true });
      }
    });
  });
  return JSON.stringify(out);
})()`

/** 把找到的位置画成红框 + 编号，肉眼可对照 */
const MARK = (list) => `(() => {
  document.querySelectorAll('.ba-mark').forEach(e => e.remove());
  const host = document.createElement('div');
  host.className = 'ba-mark';
  host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:99999';
  ${JSON.stringify(list)}.forEach((o, i) => {
    const d = document.createElement('div');
    d.style.cssText = 'position:absolute;border:2px solid #ff4d4d;left:' + (o.x - 2) + 'px;top:' + (o.y - 2)
      + 'px;width:' + (o.w + 4) + 'px;height:' + (o.h + 4) + 'px';
    const lab = document.createElement('div');
    lab.textContent = (i + 1) + ' · ' + o.t + ' 缺' + o.need + 'px';
    lab.style.cssText = 'position:absolute;left:' + (o.x - 2) + 'px;top:' + (o.y - 16)
      + 'px;background:#ff4d4d;color:#fff;font:11px/14px monospace;padding:0 3px;white-space:nowrap';
    host.appendChild(d); host.appendChild(lab);
  });
  document.body.appendChild(host);
  return ${JSON.stringify(list)}.length;
})()`

const profile = mkdtempSync(join(tmpdir(), 'ba-'))
const proc = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' })

let id = 0, ws
const pending = new Map()
const send = (m, p = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method: m, params: p })) })
const ev = async (e) => (await send('Runtime.evaluate', { expression: e, returnByValue: true }))?.result?.result?.value ?? null
const sleep2 = sleep

async function shot(name) {
  const s = await send('Page.captureScreenshot', { format: 'png' })
  const p = join(OUT, `ba-${W}-${name}.png`)
  if (s.result?.data) { writeFileSync(p, Buffer.from(s.result.data, 'base64')); return p }
  return null
}

async function setProj(want) {
  for (let i = 0; i < 3; i++) {
    if (!!(await ev(`!!document.querySelector('.shell.proj')`)) === want) return
    const box = await ev(`(() => { const b=[...document.querySelectorAll('button')].find(x=>/投屏/.test(x.innerText||'')); if(!b) return null; const r=b.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`)
    if (!box) return
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1, buttons: 1 })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1, buttons: 0 })
    await sleep(800)
  }
}

try {
  for (let i = 0; i < 80; i++) { try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) break } catch {} ; await sleep(250) }
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
  ws = new WebSocket(list.find(t => t.type === 'page').webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id).res(m); pending.delete(m.id) } }
  await send('Page.enable'); await send('Runtime.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false })

  await send('Page.navigate', { url: fileUrl + '#/' })
  await sleep(1300)
  await setProj(true)

  // —— before：注入还原样式，复现修复前状态 ——
  await ev(`(() => { const s = document.createElement('style'); s.id='ba-revert'; s.textContent = ${JSON.stringify(REVERT)}; document.head.appendChild(s); return 1 })()`)
  await sleep2(700)
  // 顺带把 svg.chart 的画布 / 文本几何打出来，确认「2,215」到底是真截断还是误报
  const chart = await ev(`(() => {
    const s = document.querySelector('#app .pfc svg.chart'); if (!s) return 'no chart';
    const R = s.getBoundingClientRect();
    const ts = [...s.querySelectorAll('text')].map(t => {
      const r = t.getBoundingClientRect();
      return (t.textContent||'').trim().slice(0,10) + '@' + Math.round(r.left-R.left) + '..' + Math.round(r.right-R.left)
        + ' (top ' + Math.round(r.top-R.top) + ')';
    });
    return 'svg w=' + Math.round(R.width) + ' h=' + Math.round(R.height) + ' | ' + ts.join(' ; ');
  })()`)
  console.log('chart(before):', chart)
  const before = JSON.parse(await ev(FIND) ?? '[]')
  await ev(MARK(before))
  const pB = await shot('before-cockpit')
  console.log(`before: 截断 ${before.length} 处 →`, pB)
  before.forEach((b, i) => console.log(`   ${String(i + 1).padStart(2)}. "${b.t}" 缺 ${b.need}px @(${Math.round(b.x)},${Math.round(b.y)})${b.svgy ? ' [SVG]' : ''}`))

  // —— after：移除还原样式 ——
  await ev(`(() => { const s = document.getElementById('ba-revert'); if (s) s.remove(); document.querySelectorAll('.ba-mark').forEach(e => e.remove()); return 1 })()`)
  await sleep2(700)
  const after = JSON.parse(await ev(FIND) ?? '[]')
  const pA = await shot('after-cockpit')
  console.log(`\nafter : 截断 ${after.length} 处 →`, pA)
  after.forEach((b, i) => console.log(`   ${String(i + 1).padStart(2)}. "${b.t}" 缺 ${b.need}px @(${Math.round(b.x)},${Math.round(b.y)})${b.svgy ? ' [SVG]' : ''}`))

  // chip 前后对照（同一页，投屏档）
  const chipOf = `(() => { const e=[...document.querySelectorAll('#app .chip')]; if(!e.length) return null; const c=getComputedStyle(e[0]); const r=e[0].getBoundingClientRect(); return JSON.stringify({n:e.length, fs:Math.round(parseFloat(c.fontSize)), h:Math.round(r.height)}); })()`
  await ev(`(() => { const s=document.createElement('style'); s.id='ba-revert2'; s.textContent='.proj{--chip-fs:10px !important;--chip-h:18px !important;}'; document.head.appendChild(s); return 1 })()`)
  await sleep2(400)
  console.log('\nchip before(还原) =', await ev(chipOf))
  await ev(`(() => { const s=document.getElementById('ba-revert2'); if(s) s.remove(); return 1 })()`)
  await sleep2(400)
  console.log('chip after (当前) =', await ev(chipOf))
} finally {
  try { proc.kill() } catch {}
  try { rmSync(profile, { recursive: true, force: true }) } catch {}
}
