// 冒烟测试：用本机 Edge 无头模式走通四幕，收集 console error / 未捕获异常。
// 用法： node tools/smoke.mjs [dist/index.html 的绝对路径]
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const PORT = 9333

const target = resolve(process.argv[2] ?? 'dist/index.html')
if (!existsSync(target)) {
  console.error('找不到产物：', target)
  process.exit(2)
}
const fileUrl = 'file:///' + target.replace(/\\/g, '/')

const routes = [
  ['#/', '第一幕 区块价值全景'],
  ['#/well/W001', '第二幕 单井决策卡 W001'],
  ['#/well/W004', '第二幕 单井决策卡 W004(示意)'],
  ['#/portfolio', '第三幕 措施会结算'],
  ['#/review', '第四幕 数据与复盘'],
  ['#/report', '报告 A4'],
]

const profile = mkdtempSync(join(tmpdir(), 'edge-smoke-'))
const proc = spawn(
  EDGE,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    'about:blank',
  ],
  { stdio: 'ignore' },
)

async function waitPort() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`)
      if (r.ok) return
    } catch {}
    await sleep(300)
  }
  throw new Error('Edge 调试端口未就绪')
}

function cleanup() {
  try { proc.kill() } catch {}
  try { rmSync(profile, { recursive: true, force: true }) } catch {}
}

let failed = false

try {
  await waitPort()
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
  const page = list.find((t) => t.type === 'page')
  if (!page) throw new Error('没有 page 目标')

  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j })

  let id = 0
  const pending = new Map()
  const problems = []
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg)
      pending.delete(msg.id)
      return
    }
    if (msg.method === 'Runtime.consoleAPICalled') {
      const type = msg.params.type
      if (type === 'error' || type === 'warning') {
        const text = (msg.params.args ?? []).map((a) => a.value ?? a.description ?? '').join(' ')
        problems.push({ route, type, text })
      }
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails ?? {}
      problems.push({ route, type: 'exception', text: d.text + ' ' + (d.exception?.description ?? '') })
    }
    if (msg.method === 'Log.entryAdded') {
      const e = msg.params.entry
      if (e.level === 'error') problems.push({ route, type: 'log', text: e.text })
    }
  }

  // Runtime/Log/Page 域是事件来源，必须先 enable
  const send = (method, params = {}) =>
    new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })) })

  await send('Runtime.enable')
  await send('Log.enable')
  await send('Page.enable')

  let route = ''
  for (const [hash, name] of routes) {
    route = name
    await send('Page.navigate', { url: fileUrl + hash })
    await sleep(1400)
    const res = await send('Runtime.evaluate', {
      expression: `JSON.stringify({
        path: location.hash,
        text: (document.querySelector('#app')?.innerText || '').slice(0, 400),
        panels: document.querySelectorAll('.panel').length,
        canvas: document.querySelectorAll('canvas').length,
        na: (document.querySelector('#app')?.innerText.match(/暂无/g) || []).length
      })`,
      returnByValue: true,
    })
    const v = res.result?.result?.value ? JSON.parse(res.result.result.value) : {}
    const ok = (v.panels ?? 0) > 0
    if (!ok) failed = true
    console.log(
      `${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(24)} panels=${v.panels ?? 0} canvas=${v.canvas ?? 0} 暂无×${v.na ?? 0}`,
    )
    if (process.env.SMOKE_VERBOSE) console.log('     文本片段：', (v.text ?? '').replace(/\n/g, ' | ').slice(0, 220))
  }

  await sleep(500)
  const errs = problems.filter((p) => p.type === 'error' || p.type === 'exception')
  const warns = problems.filter((p) => p.type === 'warning')
  console.log('\n--- console 汇总 ---')
  console.log(`error/exception: ${errs.length}  warning: ${warns.length}`)
  for (const p of errs.slice(0, 12)) console.log(`  [${p.type}] ${p.route}: ${p.text.slice(0, 200)}`)
  if (process.env.SMOKE_VERBOSE) for (const p of warns.slice(0, 8)) console.log(`  [warn] ${p.route}: ${p.text.slice(0, 160)}`)
  if (errs.length) failed = true
} catch (e) {
  console.error('冒烟测试异常：', e.message)
  failed = true
} finally {
  cleanup()
}

console.log(failed ? '\n结果：FAIL' : '\n结果：PASS')
process.exit(failed ? 1 : 0)
