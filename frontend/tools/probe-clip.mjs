// 文字截断清单探针：把每一处 scrollWidth > clientWidth 的元素逐条列出
// 带：路由 / CSS 选择器链 / 文本 / 缺几 px / 父容器栅格 / 字号 / letter-spacing
// 用法： node tools/probe-clip.mjs [宽] [高]
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const PORT = 9391
const W = Number(process.argv[2] ?? 1366)
const H = Number(process.argv[3] ?? 768)
const OUT = resolve('docs/shots/walk')
const fileUrl = 'file:///' + resolve('dist/index.html').replace(/\\/g, '/')

const profile = mkdtempSync(join(tmpdir(), 'clip-'))
const proc = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' })

let id = 0, ws
const pending = new Map()
const send = (m, p = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method: m, params: p })) })
const ev = async (e) => (await send('Runtime.evaluate', { expression: e, returnByValue: true }))?.result?.result?.value ?? null

/** 逐条列出被横向截断的叶子元素 */
const CLIP = `(() => {
  const path = (el) => {
    const seg = [];
    let n = el;
    for (let i = 0; i < 5 && n && n.nodeType === 1 && n.id !== 'app'; i++) {
      let s = n.tagName.toLowerCase();
      const cls = (n.getAttribute('class') || '').trim().split(/\\s+/).filter(Boolean).slice(0, 3);
      if (cls.length) s += '.' + cls.join('.');
      seg.unshift(s); n = n.parentElement;
    }
    return seg.join(' > ');
  };
  const out = [];
  document.querySelectorAll('#app *').forEach(el => {
    // SVG 元素的 clientWidth/scrollWidth 不可靠（会被报成假截断），交给 SVGCHK 用 rect 判定
    if (el.namespaceURI !== 'http://www.w3.org/1999/xhtml') return;
    if (el.children.length) return;
    const t = (el.textContent || '').trim();
    if (!t) return;
    if (!(el.scrollWidth > el.clientWidth + 2 && el.clientWidth > 0)) return;
    const cs = getComputedStyle(el);
    const p = el.parentElement;
    const pcs = p ? getComputedStyle(p) : null;
    const r = el.getBoundingClientRect();
    out.push({
      text: t.slice(0, 24),
      sel: path(el),
      cw: el.clientWidth, sw: el.scrollWidth, need: el.scrollWidth - el.clientWidth,
      fs: Math.round(parseFloat(cs.fontSize)),
      ls: cs.letterSpacing,
      ws: cs.whiteSpace,
      ov: cs.overflow + '/' + (cs.textOverflow || '-'),
      parent: p ? path(p) : '',
      pCols: pcs ? (pcs.gridTemplateColumns || '') : '',
      pW: p ? Math.round(p.getBoundingClientRect().width) : 0,
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }
    });
  });
  return JSON.stringify(out);
})()`

/** 主图几何：确认「修标题换行」没有把主图压扁 */
const GEO = `(() => {
  const h = (s) => { const e = document.querySelector(s); return e ? Math.round(e.getBoundingClientRect().height) : null; };
  const wh = (s) => { const e = document.querySelector(s); if (!e) return null; const r = e.getBoundingClientRect(); return Math.round(r.width) + 'x' + Math.round(r.height); };
  return JSON.stringify({
    axis: h('.area-axis'), wlPanel: h('.wl.axis-wl'), wlTitle: h('.wl.axis-wl .panel-title'),
    wlPlot: wh('.wl.axis-wl .plot'), wlSvg: wh('.wl.axis-wl svg'),
    scene: h('.scene-slot'), sceneSvg: wh('.scene-main svg'), detailSvg: wh('.d-svg'),
    rail: h('.area-rail'), dossier: h('.area-dossier')
  });
})()`

/** SVG 文字：用 getBBox（用户单位）判断是否真的越出 viewBox，或彼此重叠 */
const SVGCHK = `(() => {
  const out = [];
  document.querySelectorAll('#app svg').forEach((svg, si) => {
    const vb = (svg.getAttribute('viewBox') || '').split(/[\\s,]+/).map(Number);
    if (vb.length !== 4 || vb.some(v => !isFinite(v))) return;
    const R = svg.getBoundingClientRect();
    if (!R.width || !R.height) return;
    const cls = (svg.getAttribute('class') || '') || (svg.parentElement && svg.parentElement.className) || '';
    const texts = [...svg.querySelectorAll('text')].filter(t => (t.textContent || '').trim());
    // 用 rect（已含祖先 transform），与 svg 画布矩形直接比 —— getBBox 是局部坐标，会被 translate 骗
    texts.forEach(t => {
      const r = t.getBoundingClientRect();
      if (!r.width || !r.height) return;
      const overL = R.left - r.left, overR = r.right - R.right;
      const overT = R.top - r.top, overB = r.bottom - R.bottom;
      if (Math.max(overL, overR, overT, overB) > 0.5) {
        out.push({
          svg: si, cls: cls.toString().slice(0, 20), viewBox: vb.join(' '),
          scale: Math.round(R.width / vb[2] * 100) / 100,
          text: (t.textContent || '').trim().slice(0, 20),
          fs: t.getAttribute('font-size') || (t.parentElement && t.parentElement.getAttribute('font-size')) || '',
          rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)].join(','),
          over: { L: Math.round(overL), R: Math.round(overR), T: Math.round(overT), B: Math.round(overB) },
          kind: 'outside'
        });
      }
    });
    for (let i = 0; i < texts.length; i++) for (let j = i + 1; j < texts.length; j++) {
      const a = texts[i].getBoundingClientRect(), b = texts[j].getBoundingClientRect();
      if (!a.width || !b.width) continue;
      const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      const oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      if (ox > 1 && oy > 1) {
        out.push({
          svg: si, cls: cls.toString().slice(0, 20), viewBox: vb.join(' '),
          scale: Math.round(R.width / vb[2] * 100) / 100,
          text: (texts[i].textContent || '').trim().slice(0, 12) + ' ⨯ ' + (texts[j].textContent || '').trim().slice(0, 12),
          overlap: Math.round(ox) + 'x' + Math.round(oy), kind: 'overlap'
        });
      }
    }
  });
  return JSON.stringify(out);
})()`

/** chip 字号清单：所有页面统一核对 */
const CHIP = `(() => {
  const out = [];
  document.querySelectorAll('#app .chip').forEach(el => {
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    out.push({
      t: (el.innerText || '').trim().slice(0, 14),
      fs: Math.round(parseFloat(cs.fontSize)),
      h: Math.round(r.height * 10) / 10,
      cls: (el.getAttribute('class') || '').replace('chip', '').trim(),
      ff: cs.fontFamily.split(',')[0].replace(/["']/g, '')
    });
  });
  const agg = {};
  out.forEach(o => { const k = o.fs + 'px/' + o.h + '/' + o.cls; agg[k] = (agg[k] || 0) + 1; });
  return JSON.stringify({ count: out.length, agg, sample: out.slice(0, 10) });
})()`

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
  const p = join(OUT, `clip-${W}-${name}.png`)
  if (s.result?.data) { writeFileSync(p, Buffer.from(s.result.data, 'base64')); return p }
  return null
}

const ROUTES = [
  ['#/', 'cockpit'],
  ['#/portfolio', 'portfolio'],
  ['#/review', 'review'],
  ['#/model-card', 'model-card'],
  ['#/report', 'report'],
]

try {
  for (let i = 0; i < 80; i++) { try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) break } catch {} ; await sleep(250) }
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
  ws = new WebSocket(list.find(t => t.type === 'page').webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id).res(m); pending.delete(m.id) } }
  await send('Page.enable'); await send('Runtime.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false })

  const report = { W, H, proj: {}, chip: {} }
  for (const want of [true, false]) {
    for (const [hash, name] of ROUTES) {
      await send('Page.navigate', { url: fileUrl + hash })
      await sleep(1300)
      await setProj(want)
      const tag = want ? 'proj' : 'norm'
      const clips = JSON.parse(await ev(CLIP) ?? '[]')
      const ovx = await ev(`Math.max(0, document.documentElement.scrollWidth - innerWidth)`)
      const svgBad = JSON.parse(await ev(SVGCHK) ?? '[]')
      const geo = JSON.parse(await ev(GEO) ?? '{}')
      report.proj[`${tag}/${name}`] = { count: clips.length, overflowX: ovx, clips, svgBad, geo }
      await shot(`${tag}-${name}`)
      if (want === false) report.chip[name] = JSON.parse(await ev(CHIP) ?? '{}')
    }
  }
  // 投屏态的 chip 也量一次
  for (const [hash, name] of ROUTES) {
    await send('Page.navigate', { url: fileUrl + hash })
    await sleep(1300)
    await setProj(true)
    report.chip['proj:' + name] = JSON.parse(await ev(CHIP) ?? '{}')
  }

  writeFileSync(join(OUT, `clip-${W}-report.json`), JSON.stringify(report, null, 2))

  console.log(`\n=== ${W}x${H} 文字截断清单 ===`)
  for (const [k, v] of Object.entries(report.proj)) {
    console.log(`\n[${k}] 截断 ${v.count} 处 · 横向溢出 ${v.overflowX}`)
    if (v.geo) console.log(`      几何 axis=${v.geo.axis} wlTitle=${v.geo.wlTitle} wlPlot=${v.geo.wlPlot} scene=${v.geo.scene} sceneSvg=${v.geo.sceneSvg} detail=${v.geo.detailSvg}`)
    v.clips.forEach((c, i) => {
      console.log(`  ${String(i + 1).padStart(2)}. "${c.text}" 缺 ${c.need}px (cw ${c.cw} → sw ${c.sw}) fs=${c.fs} ls=${c.ls}`)
      console.log(`      sel   ${c.sel}`)
      console.log(`      parent ${c.parent} [w=${c.pW}] cols=${c.pCols}`)
    })
    if (v.svgBad?.length) {
      console.log(`  -- SVG 越界/重叠 ${v.svgBad.length} 处 --`)
      v.svgBad.forEach(s => {
        console.log(`      [${s.kind}] "${s.text}" vb=${s.viewBox} scale=${s.scale}`
          + (s.kind === 'outside' ? ` bbox=${s.bbox} fs=${s.fs} over=${JSON.stringify(s.over)}` : ` overlap=${s.overlap}`))
      })
    }
  }
  console.log(`\n=== chip 字号清单 ===`)
  for (const [k, v] of Object.entries(report.chip)) {
    console.log(`  ${k}: n=${v.count} ${JSON.stringify(v.agg)}`)
  }
} finally {
  try { proc.kill() } catch {}
  try { rmSync(profile, { recursive: true, force: true }) } catch {}
}
