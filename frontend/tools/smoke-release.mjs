// release 冒烟：直接打开 release/index.html（file://），检查
//   1) 页面能起来、角标 = 实测 pilot · final77
//   2) 版本条 FILE/WELLS/EVENTS 正确、无回退告警
//   3) 四象限 19/35/17/6
//   4) 无任何外部网络请求（断网可跑的硬证据）
//   5) 无 console error
// 用法： node tools/smoke-release.mjs [宽] [高]
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const PORT = 9399
const W = Number(process.argv[2] ?? 1366)
const H = Number(process.argv[3] ?? 768)
const fileUrl = 'file:///' + resolve('../release/index.html').replace(/\\/g, '/')

const profile = mkdtempSync(join(tmpdir(), 'smoke-'))
const proc = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' })

let id = 0, ws
const pending = new Map()
const send = (m, p = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method: m, params: p })) })
const ev = async (e) => (await send('Runtime.evaluate', { expression: e, returnByValue: true }))?.result?.result?.value ?? null

const errs = []
const reqs = []

const CHECK = `(() => {
  const t = document.querySelector('#app')?.innerText || ''
  const q = [...document.querySelectorAll('#app .quad')].map(x => (x.innerText.match(/(W\\d{3}|CO\\d+)/g) || []).length)
  const g = (re) => { const m = t.match(re); return m ? m[1] : null }
  return JSON.stringify({
    badge: (t.match(/实测 pilot[^\\n]*/) || [null])[0],
    file: g(/FILE\\s+(\\S+\\.json)/),
    wells: g(/WELLS\\s+(\\d+)/),
    events: g(/EVENTS\\s+(\\d+)/),
    ds: g(/DS\\s+(\\S+)/),
    alarm: t.includes('已回退'),
    quads: q,
    oneSided: t.includes('单边 90% 区间'),
    baseline: (t.match(/实测基线：实际累计[^\\n]*/) || [null])[0],
    has558: t.includes('55.8%'),
    noAiRecommend: !t.includes('AI 推荐'),
  })
})()`

async function main() {
  for (let i = 0; i < 80; i++) { try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) break } catch {} ; await sleep(250) }
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
  ws = new WebSocket(list.find((t) => t.type === 'page').webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data)
    if (m.id && pending.has(m.id)) { pending.get(m.id).res(m); pending.delete(m.id); return }
    if (m.method === 'Runtime.exceptionThrown') errs.push('exception: ' + (m.params?.exceptionDetails?.text ?? ''))
    if (m.method === 'Runtime.consoleAPICalled' && m.params?.type === 'error')
      errs.push('console: ' + (m.params.args?.[0]?.value ?? ''))
    if (m.method === 'Network.requestWillBeSent') {
      const u = m.params?.request?.url ?? ''
      if (!u.startsWith('file://') && !u.startsWith('data:') && !u.startsWith('blob:')) reqs.push(u)
    }
  }
  await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false })
  // 断网
  await send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 })
  const t0 = Date.now()
  await send('Page.navigate', { url: fileUrl })
  await sleep(1600)
  const tHome = Date.now() - t0
  const r = JSON.parse(await ev(CHECK) ?? '{}')
  console.log(`首屏可交互（断网）: ${tHome} ms`)
  console.log(JSON.stringify(r, null, 1))
  console.log('外部网络请求:', reqs.length, reqs.slice(0, 5))
  console.log('console error:', errs.length, errs.slice(0, 5))

  const ok =
    r.badge?.includes('final77') &&
    r.file === 'pilot_bundle_final77.json' &&
    r.wells === '77' && r.events === '77' &&
    r.alarm === false &&
    JSON.stringify(r.quads) === JSON.stringify([19, 35, 17, 6]) &&
    r.oneSided === true &&
    reqs.length === 0 && errs.length === 0
  console.log(ok ? '\nRELEASE SMOKE: PASS' : '\nRELEASE SMOKE: FAIL')
}

main().then(() => { try { ws?.close() } catch {} proc.kill(); try { rmSync(profile, { recursive: true, force: true }) } catch {} process.exit(0) })
  .catch((e) => { console.error(e); try { proc.kill() } catch {} process.exit(1) })
