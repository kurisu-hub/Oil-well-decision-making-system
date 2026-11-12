// 投屏模式探针：开/关对比 —— 字号分档、点击目标、场景高度、横向溢出
// 用法： node tools/probe-proj.mjs [宽] [高]
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const PORT = 9387
const W = Number(process.argv[2] ?? 1920)
const H = Number(process.argv[3] ?? 1080)
const OUT = resolve('docs/shots/walk')
const fileUrl = 'file:///' + resolve('dist/index.html').replace(/\\/g, '/')

const profile = mkdtempSync(join(tmpdir(), 'proj-'))
const proc = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' })

let id = 0, ws
const pending = new Map()
const send = (m, p = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method: m, params: p })) })
const ev = async (e) => (await send('Runtime.evaluate', { expression: e, returnByValue: true }))?.result?.result?.value ?? null

const MEASURE = `(() => {
  const px = (el) => parseFloat(getComputedStyle(el).fontSize);
  const buckets = {};
  document.querySelectorAll('#app *').forEach(el => {
    if (!el.textContent || !el.textContent.trim()) return;
    if (!el.getBoundingClientRect().height) return;
    const f = Math.round(px(el));
    buckets[f] = (buckets[f] || 0) + 1;
  });
  const small = [];
  document.querySelectorAll('#app button, #app a, #app .chip, #app .tab, #app .n-button').forEach(el => {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return;
    if (r.height < 24) small.push({ t: (el.innerText||el.className||'').toString().trim().slice(0,16), w: Math.round(r.width), h: Math.round(r.height) });
  });
  const g = (s) => { const e = document.querySelector(s); if (!e) return null; const r = e.getBoundingClientRect(); return Math.round(r.height); };
  const svgOf = (s) => { const e = document.querySelector(s + ' svg'); if (!e) return null; const r = e.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; };
  // 折行异常：一字一行时「行数 ≈ 字数」，用来在没有肉眼的情况下发现挤爆的栏
  const wrapped = [];
  document.querySelectorAll('#app *').forEach(el => {
    if (el.children.length) return;
    const t = (el.textContent || '').trim();
    if (!t || t.length < 3) return;
    const r = el.getBoundingClientRect();
    if (!r.height || !r.width) return;
    const fs = parseFloat(getComputedStyle(el).fontSize);
    const lines = Math.round(r.height / (fs * 1.45));
    if (lines >= t.length && r.width < 220) {
      wrapped.push({ t: t.slice(0, 18), w: Math.round(r.width), h: Math.round(r.height), lines, len: t.length, fs });
    }
  });
  // 横向被截断（文字溢出容器，没换行也没省略号）
  const clipped = [];
  document.querySelectorAll('#app *').forEach(el => {
    if (el.children.length) return;
    const t = (el.textContent || '').trim();
    if (!t) return;
    if (el.scrollWidth > el.clientWidth + 2 && el.clientWidth > 0) {
      clipped.push({ t: t.slice(0, 18), cw: el.clientWidth, sw: el.scrollWidth });
    }
  });

  // 只看不滚动的图元是否被裁；.panel 自身 overflow:auto，内容超高属于正常内滚，不算裁切
  const cut = [];
  document.querySelectorAll('#app .scene-slot, #app .d-svg, #app .plot, #app .scene-main svg, #app .axis-wl svg').forEach(e => {
    const r = e.getBoundingClientRect();
    if (r.height > 0 && (r.bottom > innerHeight + 1 || r.right > innerWidth + 1)) cut.push((e.className||'').toString().slice(0,24) + ':' + Math.round(r.bottom - innerHeight));
  });
  return JSON.stringify({
    buckets, smallCount: small.length, small: small.slice(0, 8),
    scene: g('.scene-slot'), sceneSvg: svgOf('.scene-main'), detailSvg: svgOf('.d-svg'),
    wrappedCount: wrapped.length, wrapped: wrapped.slice(0, 6),
    clippedCount: clipped.length, clipped: clipped.slice(0, 6),
    overflowX: Math.max(0, document.documentElement.scrollWidth - innerWidth),
    panels: document.querySelectorAll('#app .panel').length,
    cut,
    proj: !!document.querySelector('.shell.proj'),
    sideRight: (() => { const e = document.querySelector('.side-right'); return e ? getComputedStyle(e).display : 'n/a'; })()
  });
})()`

/** 把投屏开关拨到目标态（走真实按钮点击） */
async function setProj(want) {
  for (let i = 0; i < 3; i++) {
    const isProj = await ev(`!!document.querySelector('.shell.proj')`)
    if (!!isProj === want) return
    const box = await ev(`(() => {
      const b = [...document.querySelectorAll('button')].find(x => /投屏/.test(x.innerText||''));
      if (!b) return null; const r = b.getBoundingClientRect();
      return { x: r.x + r.width/2, y: r.y + r.height/2 };
    })()`)
    if (!box) return
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1, buttons: 1 })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1, buttons: 0 })
    await sleep(800)
  }
}

async function shot(name) {
  const s = await send('Page.captureScreenshot', { format: 'png' })
  const p = join(OUT, `proj-${W}-${name}.png`)
  if (s.result?.data) { writeFileSync(p, Buffer.from(s.result.data, 'base64')); return p }
  return null
}

try {
  for (let i = 0; i < 80; i++) { try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) break } catch {} ; await sleep(250) }
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
  ws = new WebSocket(list.find(t => t.type === 'page').webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id).res(m); pending.delete(m.id) } }
  await send('Page.enable'); await send('Runtime.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false })

  const out = {}
  for (const hash of ['#/', '#/portfolio']) {
    await send('Page.navigate', { url: fileUrl + hash })
    await sleep(1400)
    await setProj(false)
    out[hash + ' 关闭'] = JSON.parse(await ev(MEASURE) ?? '{}')
    await shot(hash === '#/' ? 'off-cockpit' : 'off-portfolio')

    // 打开投屏（走真实按钮点击；按目标态校正，保证开/关都测到）
    await setProj(true)
    out[hash + ' 投屏'] = JSON.parse(await ev(MEASURE) ?? '{}')
    await shot(hash === '#/' ? 'on-cockpit' : 'on-portfolio')
  }
  console.log(`\n=== ${W}x${H} 投屏模式对比 ===`)
  for (const [k, v] of Object.entries(out)) {
    console.log('\n[' + k + ']')
    console.log('  字号分档', JSON.stringify(v.buckets))
    console.log('  <24px 点击目标', v.smallCount, JSON.stringify(v.small))
    console.log('  scene', v.scene, 'sceneSvg', JSON.stringify(v.sceneSvg), 'detailSvg', JSON.stringify(v.detailSvg))
    console.log('  横向溢出', v.overflowX, '裁切', JSON.stringify(v.cut), '右栏', v.sideRight, 'proj=', v.proj)
    console.log('  一字一行', v.wrappedCount, JSON.stringify(v.wrapped))
    console.log('  文字溢出', v.clippedCount, JSON.stringify(v.clipped))
  }
} finally {
  try { proc.kill() } catch {}
  try { rmSync(profile, { recursive: true, force: true }) } catch {}
}
