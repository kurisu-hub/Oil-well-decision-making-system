// 3 分钟决策路径走查：逐步计时 + 截图 + 读数探针
// 用法： node tools/walk.mjs [宽] [高] [前缀]
// 产物： docs/shots/walk-<前缀>-<步号>.png + 控制台报告
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const PORT = 9361
const W = Number(process.argv[2] ?? 1920)
const H = Number(process.argv[3] ?? 1080)
const PFX = process.argv[4] ?? String(W)
const OUT = resolve('docs/shots/walk')
mkdirSync(OUT, { recursive: true })
const fileUrl = 'file:///' + resolve('dist/index.html').replace(/\\/g, '/')

const profile = mkdtempSync(join(tmpdir(), 'walk-'))
const proc = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' })

let id = 0, ws, send
const pending = new Map()
const report = { size: `${W}x${H}`, steps: [], checks: [], notes: [] }
const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true }))?.result?.result?.value ?? null

async function shot(name) {
  const s = await send('Page.captureScreenshot', { format: 'png' })
  const p = join(OUT, `walk-${PFX}-${name}.png`)
  if (!s.result?.data) { report.notes.push('截图失败 ' + name); return null }
  writeFileSync(p, Buffer.from(s.result.data, 'base64'))
  return p
}

/** 轮询等待页面状态满足，最多 maxMs；返回耗时 ms 与是否成功 */
async function until(expr, maxMs = 3000, label = '') {
  const t0 = Date.now()
  while (Date.now() - t0 < maxMs) {
    const v = await ev(`(() => { try { return (${expr}) ? '1' : '' } catch (e) { return '' } })()`)
    if (v === '1') return { ms: Date.now() - t0, ok: true }
    await sleep(50)
  }
  return { ms: Date.now() - t0, ok: false, label }
}

/** 在页面里按可见文本找元素并原生点击；返回是否找到 */
async function clickText(sel, text, { exact = false } = {}) {
  return (await ev(`(() => {
    const t = ${JSON.stringify(text)};
    const els = [...document.querySelectorAll(${JSON.stringify(sel)})];
    const hit = els.find(e => {
      const s = (e.innerText || e.textContent || '').trim();
      return ${exact ? 's === t' : 's.includes(t)'};
    });
    if (!hit) return 'none';
    hit.scrollIntoView({ block: 'center' });
    hit.click();
    return 'ok';
  })()`)) === 'ok'
}

/** 真实鼠标点击（走命中测试，能发现被遮挡 / 目标过小的问题） */
async function clickAt(sel, text, { exact = false } = {}) {
  const box = await ev(`(() => {
    const t = ${JSON.stringify(text)};
    const els = [...document.querySelectorAll(${JSON.stringify(sel)})];
    const hit = els.find(e => {
      const s = (e.innerText || e.textContent || '').trim();
      return ${exact ? 's === t' : 's.includes(t)'};
    });
    if (!hit) return 'null';
    hit.scrollIntoView({ block: 'center' });
    const r = hit.getBoundingClientRect();
    return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2, w: Math.round(r.width), h: Math.round(r.height) });
  })()`)
  if (!box || box === 'null') return null
  const g = JSON.parse(box)
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: g.x, y: g.y })
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: g.x, y: g.y, button: 'left', clickCount: 1, buttons: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: g.x, y: g.y, button: 'left', clickCount: 1, buttons: 0 })
  return g
}

function step(name, ms, extra = {}) {
  report.steps.push({ name, ms, ...extra })
  console.log(`  ${String(ms).padStart(5)} ms  ${name}${extra.note ? '  ← ' + extra.note : ''}`)
}

try {
  for (let i = 0; i < 80; i++) { try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) break } catch {}; await sleep(250) }
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
  const page = list.find((t) => t.type === 'page')
  ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j })
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } }
  send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })) })

  await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false })

  console.log(`\n=== 3 分钟路径走查 @ ${W}×${H} ===\n`)

  // ── S0 首屏可交互 ──────────────────────────────
  const t0 = Date.now()
  await send('Page.navigate', { url: fileUrl + '#/' })
  const nav = await until(`document.querySelector('.cockpit') && document.querySelectorAll('.wellnode').length > 0`, 8000, '首屏')
  step('S0 首页可交互（第一幕全景）', Date.now() - t0, { ok: nav.ok, note: nav.ok ? '' : '超时未渲染' })
  await sleep(900)
  const s0 = await shot('1-panorama')
  report.checks.push({ k: 'S0 截图', v: s0 })

  // 首屏读数
  const kpi0 = await ev(`(() => { const t=[...document.querySelectorAll('.kpi-strip .kpi')].map(e=>e.innerText.replace(/\\n/g,'=')); return JSON.stringify(t) })()`)
  report.checks.push({ k: 'S0 KPI', v: kpi0 })

  // ── S1 点一口黄灯井 → 焦点切换（第一幕内） ──────
  const yellowId = await ev(`(() => {
    const q = [...document.querySelectorAll('.quad')].find(e => e.innerText.includes('数据不足'));
    const r = q && q.querySelector('.wellrow');
    return r ? r.querySelector('.id').innerText.trim() : null;
  })()`)
  report.checks.push({ k: 'S1 目标黄灯井', v: yellowId })
  let t1 = Date.now()
  const g1 = await clickAt('.wellrow', yellowId ?? '', { exact: false })
  const r1 = await until(`document.querySelector('.scene-detail .d-id .id') && document.querySelector('.scene-detail .d-id .id').innerText.trim() === ${JSON.stringify(yellowId)}`, 2500)
  if (!r1.ok) { // 需要第二次点击 → 记为 P0
    await clickAt('.wellrow', yellowId ?? '')
    const r1b = await until(`document.querySelector('.scene-detail .d-id .id') && document.querySelector('.scene-detail .d-id .id').innerText.trim() === ${JSON.stringify(yellowId)}`, 2500)
    step('S1 点黄灯井 → 焦点切换', Date.now() - t1, { ok: r1b.ok, note: '第一次点击未生效，需点两次', target: g1 })
  } else {
    step('S1 点黄灯井 → 焦点切换', Date.now() - t1, { ok: true, target: g1 })
  }
  await sleep(500)
  await shot('2-yellow-focus')

  // ── S2 打开单井决策卡（第二幕） ──────────────────
  t1 = Date.now()
  const g2 = await clickAt('.area-dossier .wellrow.active button.go, .area-dossier button', '', {})
  let r2 = await until(`location.hash.startsWith('#/well/')`, 2500)
  if (!r2.ok) {
    const g2b = await clickAt('.area-dossier button', '单井决策卡')
    r2 = await until(`location.hash.startsWith('#/well/')`, 2500)
    step('S2 打开单井决策卡', Date.now() - t1, { ok: r2.ok, note: r2.ok ? '第一次点击落空，第二次命中' : '两次都没进', target: g2 ?? g2b })
  } else {
    step('S2 打开单井决策卡', Date.now() - t1, { ok: true, target: g2 })
  }
  const wel = await until(`document.querySelector('.layout.two')`, 2500)
  await sleep(700)
  await shot('3-well-card')
  const cardProbe = await ev(`(() => {
    const t = document.body.innerText.replace(/\\s+/g,' ');
    return JSON.stringify({
      hash: location.hash,
      hasCurve: t.includes('曲线') || t.includes('世界线'),
      hasFingerprint: t.includes('不确定性'),
      hasEvidence: t.includes('证据'),
      na: (t.match(/暂无/g) || []).length
    })
  })()`)
  report.checks.push({ k: 'S2 单井卡', v: cardProbe })

  // ── S3 第三幕：措施会结算 ────────────────────────
  t1 = Date.now()
  await send('Page.navigate', { url: fileUrl + '#/portfolio' })
  const r3 = await until(`document.querySelector('.layout') && document.body.innerText.includes('措施会结算')`, 4000)
  step('S3 进入第三幕（措施会结算）', Date.now() - t1, { ok: r3.ok })
  await sleep(800)
  await shot('4-portfolio')
  const pf = await ev(`(() => {
    const t = document.body.innerText.replace(/\\s+/g,' ');
    const m = t.match(/(combo_metrics|portfolio\\.points)/);
    return JSON.stringify({
      src: m ? m[1] : null,
      na: (t.match(/暂无/g) || []).length,
      selected: (document.querySelectorAll('.chip, .wellrow.active, input[type=checkbox]:checked') || []).length
    })
  })()`)
  report.checks.push({ k: 'S3 结算', v: pf })

  // ── S4 第四幕：VOI ──────────────────────────────
  t1 = Date.now()
  await send('Page.navigate', { url: fileUrl + '#/review' })
  const r4 = await until(`document.querySelector('.layout') && document.body.innerText.includes('补资料')`, 4000)
  step('S4 进入第四幕（VOI）', Date.now() - t1, { ok: r4.ok })
  await sleep(800)
  await shot('5-review-voi')
  const rv = await ev(`(() => {
    const t = document.body.innerText.replace(/\\s+/g,' ');
    return JSON.stringify({ voi: t.includes('补资料'), na: (t.match(/暂无/g)||[]).length })
  })()`)
  report.checks.push({ k: 'S4 VOI', v: rv })

  // ── S5 报告 ────────────────────────────────────
  t1 = Date.now()
  await send('Page.navigate', { url: fileUrl + '#/report' })
  const r5 = await until(`document.body.innerText.includes('打印') || document.body.innerText.includes('签字')`, 4000)
  step('S5 导出报告', Date.now() - t1, { ok: r5.ok })
  await sleep(900)
  await shot('6-report')

  // ── 回第一幕，验证两个 bug ───────────────────────
  await send('Page.navigate', { url: fileUrl + '#/' })
  await until(`document.querySelector('.axis-wl svg')`, 5000)
  await sleep(900)

  // 拖到 M6
  const wlGeom = await ev(`(() => { const e = document.querySelector('.axis-wl svg'); if (!e) return 'null'; const b = e.getBoundingClientRect(); const vb = (e.getAttribute('viewBox')||'0 0 900 168').split(/\\s+/).map(Number); return JSON.stringify({ x: b.x, y: b.y, w: b.width, h: b.height, vbW: vb[2], vbH: vb[3] }) })()`)
  const G = wlGeom && wlGeom !== 'null' ? JSON.parse(wlGeom) : null
  const PAD_L = 62, PAD_R = 14
  const xOf = (mm) => G.x + ((PAD_L + ((G.vbW - PAD_L - PAD_R) * mm) / 12) / G.vbW) * G.w
  if (G) {
    const yMid = G.y + G.h * 0.5
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: xOf(6), y: yMid, button: 'left', clickCount: 1, buttons: 1 })
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: xOf(6), y: yMid, button: 'left', clickCount: 1, buttons: 1 })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: xOf(6), y: yMid, button: 'left', clickCount: 1, buttons: 0 })
    await sleep(700)
  }
  await shot('7-m6-interval')
  const bug = await ev(`(() => {
    const wl = document.querySelector('.axis-wl');
    const t = wl ? wl.innerText.replace(/\\s+/g,' ') : '';
    const ci = t.match(/90% 区间 \\[([^\\]]+)\\]\\s*([^ ]*)/);
    const inc = t.match(/增量 Δ ([^ ]+)/);
    const prog = t.match(/进度 (\\d+)%/);
    const axis = [...document.querySelectorAll('.axis-wl svg text')].map(e=>e.textContent.trim()).filter(s=>/^M\\d+$/.test(s));
    // 坐标轴单位标签
    const unit = [...document.querySelectorAll('.axis-wl .panel-title, .axis-wl .fig-unit, .axis-wl .small')].map(e=>e.innerText.trim()).slice(0,4);
    return JSON.stringify({ raw: t.slice(0, 400), ci: ci?ci[1]:null, ciUnit: ci?ci[2]:null, inc: inc?inc[1]:null, prog: prog?prog[1]:null, axisTicks: axis.length, unit })
  })()`)
  report.checks.push({ k: 'BUG1 90% 区间 @M6', v: bug })
  console.log('\n--- 世界线读数 @M6 ---\n' + bug)

  // SVG 裁切 / flex 高度
  const clip = await ev(`(() => {
    const h = (s) => { const e = document.querySelector(s); return e ? Math.round(e.getBoundingClientRect().height) : null };
    const w = (s) => { const e = document.querySelector(s); return e ? Math.round(e.getBoundingClientRect().width) : null };
    const cut = [];
    document.querySelectorAll('.cockpit *').forEach(e => {
      const cs = getComputedStyle(e);
      if (cs.overflow === 'hidden' || cs.overflowY === 'hidden') {
        const over = Math.round(e.scrollHeight - e.clientHeight);
        if (over > 2) cut.push((typeof e.className === 'string' ? e.className : e.tagName) + ':+' + over);
      }
    });
    return JSON.stringify({ scene: h('.scene'), sceneSvg: h('.scene svg'), detail: h('.scene-detail'), detailSvg: h('.d-svg'), detailSvgW: w('.d-svg'), cut: cut.slice(0,10) });
  })()`)
  report.checks.push({ k: 'BUG3 SVG 裁切 / flex 高度', v: clip })
  console.log('\n--- 裁切/高度 ---\n' + clip)

  writeFileSync(join(OUT, `walk-${PFX}-report.json`), JSON.stringify(report, null, 2))
  console.log('\n报告 →', join(OUT, `walk-${PFX}-report.json`))
} finally {
  try { ws?.close() } catch {}
  try { proc.kill() } catch {}
  try { rmSync(profile, { recursive: true, force: true }) } catch {}
}
