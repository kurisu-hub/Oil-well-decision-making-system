// 1366 笔记本实测：首屏 / 字号 / 点击目标 / SVG 裁切 / 单位一致性
// 用法： node tools/probe-1366.mjs [宽] [高]
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const PORT = 9363
const W = Number(process.argv[2] ?? 1366)
const H = Number(process.argv[3] ?? 768)
const file = 'file:///' + resolve('dist/index.html').replace(/\\/g, '/')
const profile = mkdtempSync(join(tmpdir(), 'p1366-'))
const proc = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' })

let id = 0, ws, send
const pending = new Map()
const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true }))?.result?.result?.value ?? null

try {
  for (let i = 0; i < 80; i++) { try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) break } catch {}; await sleep(250) }
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
  const page = list.find((t) => t.type === 'page')
  ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j })
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } }
  send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })) })

  await send('Page.enable'); await send('Runtime.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false })

  // ── 首屏：测 3 次 ────────────────────────────────
  const loads = []
  for (let i = 0; i < 3; i++) {
    await send('Page.navigate', { url: file + '#/?cb=' + Date.now() })
    const t0 = Date.now()
    let ok = false
    while (Date.now() - t0 < 8000) {
      const v = await ev(`!!(document.querySelector('.cockpit') && document.querySelectorAll('.wellnode').length > 0)`)
      if (v === true) { ok = true; break }
      await sleep(40)
    }
    loads.push(ok ? Date.now() - t0 : -1)
    await sleep(400)
  }
  console.log(`\n=== ${W}×${H} 实测 ===`)
  console.log('首屏可交互（3 次）:', loads.join(' / '), 'ms   最大', Math.max(...loads), 'ms')

  // ── 字号 ────────────────────────────────────────
  const fonts = await ev(`(() => {
    const sel = '.kpi-k,.kpi-v,.kv>dt,.kv>dd,.small,.stamp,.tickbtn,.chip,.badge,.fig-no,.fig-cap,.ctl-head span,.wellrow .id,.wellrow .num,.d-title,.kvx>dt,.kvx>dd,.mini,.panel-title';
    const buckets = {};
    document.querySelectorAll(sel).forEach(e => {
      const fs = Math.round(parseFloat(getComputedStyle(e).fontSize) * 10) / 10;
      buckets[fs] = (buckets[fs] || 0) + 1;
    });
    const tiny = [...document.querySelectorAll(sel)].filter(e => parseFloat(getComputedStyle(e).fontSize) < 10)
      .map(e => (e.className || e.tagName) + ':' + Math.round(parseFloat(getComputedStyle(e).fontSize)*10)/10 + 'px');
    return JSON.stringify({ buckets, tinyCount: tiny.length, tinySample: [...new Set(tiny)].slice(0, 12) });
  })()`)
  console.log('\n字号分布:', fonts)

  // ── 点击目标 ─────────────────────────────────────
  const targets = await ev(`(() => {
    const out = [];
    document.querySelectorAll('button, .tickbtn, .chip, .wellrow, .go, .mini, a').forEach(e => {
      const r = e.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return;
      if (r.height < 18 || r.width < 18) out.push((typeof e.className === 'string' ? e.className : e.tagName) + ' ' + Math.round(r.width) + '×' + Math.round(r.height));
    });
    const cnt = {};
    out.forEach(s => cnt[s] = (cnt[s] || 0) + 1);
    return JSON.stringify({ smallCount: out.length, sample: Object.entries(cnt).slice(0, 14) });
  })()`)
  console.log('\n点击目标 <18px:', targets)

  // ── SVG / flex 高度 ──────────────────────────────
  const geo = await ev(`(() => {
    const h = s => { const e = document.querySelector(s); return e ? Math.round(e.getBoundingClientRect().height) : null };
    const w = s => { const e = document.querySelector(s); return e ? Math.round(e.getBoundingClientRect().width) : null };
    const cut = [];
    document.querySelectorAll('.cockpit *').forEach(e => {
      const cs = getComputedStyle(e);
      if (cs.overflow === 'hidden' || cs.overflowY === 'hidden') {
        const over = Math.round(e.scrollHeight - e.clientHeight);
        if (over > 2) cut.push((typeof e.className === 'string' ? e.className : e.tagName) + ':+' + over);
      }
    });
    return JSON.stringify({ scene: h('.scene'), sceneSvgH: h('.scene svg'), sceneSvgW: w('.scene svg'), detail: h('.scene-detail'), detailSvgH: h('.d-svg'), detailSvgW: w('.d-svg'), cut: cut.slice(0, 10) });
  })()`)
  console.log('\nSVG / flex:', geo)

  // ── 单位一致性：M3 / M6 / M12 ────────────────────
  const wlGeom = await ev(`(() => { const e = document.querySelector('.axis-wl svg'); if (!e) return 'null'; const b = e.getBoundingClientRect(); const vb = (e.getAttribute('viewBox')||'0 0 900 168').split(/\\s+/).map(Number); return JSON.stringify({ x: b.x, y: b.y, w: b.width, h: b.height, vbW: vb[2], vbH: vb[3] }) })()`)
  const G = wlGeom && wlGeom !== 'null' ? JSON.parse(wlGeom) : null
  const PAD_L = 62, PAD_R = 14
  const xOf = (mm) => G.x + ((PAD_L + ((G.vbW - PAD_L - PAD_R) * mm) / 12) / G.vbW) * G.w
  const yMid = G.y + G.h * 0.5
  const grab = async (mm) => {
    // 用键盘 ←/→ 定位（比像素换算稳）：先点中拖拽热区聚焦，再从 M12 往左推
    if (G) {
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: G.x + G.w * 0.5, y: G.y + G.h * 0.5, button: 'left', clickCount: 1, buttons: 1 })
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: G.x + G.w * 0.5, y: G.y + G.h * 0.5, button: 'left', clickCount: 1, buttons: 0 })
      await sleep(150)
    }
    for (let i = 0; i < 12; i++) {
      const cur = await ev(`(() => { const t = (document.querySelector('.axis-wl')||{}).innerText||''; const m = t.match(/游标\\s*M(\\d+)/); return m ? m[1] : '12' })()`)
      if (Number(cur) <= mm) break
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 })
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 })
      await sleep(90)
    }
    for (let i = 0; i < 12; i++) {
      const cur = await ev(`(() => { const t = (document.querySelector('.axis-wl')||{}).innerText||''; const m = t.match(/游标\\s*M(\\d+)/); return m ? m[1] : '0' })()`)
      if (Number(cur) >= mm) break
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 })
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 })
      await sleep(90)
    }
    await sleep(300)
    return ev(`(() => {
      const t = (document.querySelector('.axis-wl') || {}).innerText || '';
      const s = t.replace(/\\s+/g, ' ');
      const g = (re) => { const m = s.match(re); return m ? m[1] : null };
      const axis = [...document.querySelectorAll('.axis-wl svg text')].map(e => e.textContent.trim());
      const yl = axis.filter(x => /^[0-9,]+$/.test(x));
      return JSON.stringify({
        游标: g(/游标\\s*(M\\d+)/), 累计: g(/措施累计 ([^ ]+)/), Δ: g(/增量 Δ ([^ ]+)/),
        区间: g(/90% 区间 (\\[[^\\]]+\\])/), 区间单位: g(/90% 区间 \\[[^\\]]+\\]([^ ]*)/),
        y轴刻度: yl.slice(0, 6), y轴单位: axis.find(x => /m³/.test(x)) || null
      });
    })()`)
  }
  console.log('\n单位一致性（逐月）:')
  for (const mm of [0, 3, 6, 12]) console.log('  ', await grab(mm))
} finally {
  try { ws?.close() } catch {}
  try { proc.kill() } catch {}
  try { rmSync(profile, { recursive: true, force: true }) } catch {}
}
