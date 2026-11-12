// 验收脚本：用本机 Edge 无头模式逐条核对 P0 验收清单。
// 用法： node tools/verify.mjs [dist/index.html 绝对路径]
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const PORT = 9334
const target = resolve(process.argv[2] ?? 'dist/index.html')
if (!existsSync(target)) { console.error('找不到产物：', target); process.exit(2) }
const fileUrl = 'file:///' + target.replace(/\\/g, '/')

const profile = mkdtempSync(join(tmpdir(), 'edge-verify-'))
const proc = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' })

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  → ' + detail : ''}`)
}

async function waitPort() {
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) return } catch {}
    await sleep(250)
  }
  throw new Error('Edge 调试端口未就绪')
}

function cleanup() {
  try { proc.kill() } catch {}
  try { rmSync(profile, { recursive: true, force: true }) } catch {}
}

let ws, send, problems = [], route = ''

async function evalJs(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.text)
  return r.result?.result?.value
}

async function openPage(hash) {
  route = hash
  await send('Page.navigate', { url: fileUrl + hash })
}

async function waitReady(timeout = 8000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeout) {
    const n = await evalJs('document.querySelectorAll("#app .panel").length')
    if (n > 0) return Date.now() - t0
    await sleep(50)
  }
  return -1
}

try {
  await waitPort()
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
  const page = list.find((t) => t.type === 'page')
  ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j })

  let id = 0
  const pending = new Map()
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data)
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return }
    if (m.method === 'Runtime.consoleAPICalled') {
      const t = m.params.type
      if (t === 'error' || t === 'warning') {
        problems.push({ route, level: t, text: (m.params.args ?? []).map((a) => a.value ?? a.description ?? '').join(' ') })
      }
    }
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails ?? {}
      problems.push({ route, level: 'exception', text: `${d.text} ${d.exception?.description ?? ''}` })
    }
  }
  send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })) })

  await send('Runtime.enable'); await send('Log.enable'); await send('Page.enable')

  // —— 1. 首页 3 秒内可交互 ——
  await openPage('#/')
  const tHome = await waitReady()
  check('首页 3 秒内可交互', tHome >= 0 && tHome < 3000, `${tHome} ms`)

  // —— 0. 判定当前数据源（mock / real_pilot / real）——
  const modeProbe = await evalJs(`(() => {
    const t = document.querySelector('#app').innerText
    if (t.includes('实测 pilot')) return 'real_pilot'
    if (t.includes('示意数据')) return 'mock'
    if (t.includes('实测全量')) return 'real'
    return 'unknown'
  })()`)
  const DATA_MODE = String(modeProbe).trim()
  console.log(`\n[数据源] ${DATA_MODE}\n`)
  const isMock = DATA_MODE === 'mock'

  // —— 2. 四象限 ——
  // mock：四象限都必须有井（示意数据按设计铺满）
  // real/real_pilot：允许某象限无井，但必须**诚实显示暂无**，不得编造
  const quads = await evalJs(`(() => {
    const m = [...document.querySelectorAll('#app .quad')].map(q => {
      const t = q.innerText
      return { label: t.split('\\n')[0], na: t.includes('暂无'), rows: (t.match(/(W\\d{3}|CO\\d+)/g) || []).length }
    })
    return JSON.stringify(m)
  })()`)
  const q = JSON.parse(quads)
  if (isMock) {
    check('四象限都有井（mock）', q.length === 4 && q.every((x) => !x.na && x.rows >= 1),
      q.map((x) => `${x.label}:${x.rows}`).join(' '))
  } else {
    const total = q.reduce((s, x) => s + x.rows, 0)
    check('四象限渲染完整且空象限诚实标注暂无（实测）',
      q.length === 4 && total > 0 && q.every((x) => x.rows >= 1 || x.na),
      q.map((x) => `${x.label}:${x.rows}${x.na ? '(暂无)' : ''}`).join(' '))
  }

  // —— 3. 数据模式角标可见 ——
  const badge = await evalJs(`(() => {
    const t = document.querySelector('#app').innerText
    return JSON.stringify({ mock: t.includes('示意数据'), pilot: t.includes('实测 pilot'),
                            fallback: t.includes('已回退') })
  })()`)
  const bg = JSON.parse(badge)
  check(`数据模式角标可见（${DATA_MODE}）`,
    isMock ? bg.mock : (bg.pilot && !bg.fallback), JSON.stringify(bg))

  // —— 3b. 数据版本条：active file / n_wells / n_events 必须与磁盘上的生效 bundle 一致 ——
  // v1、v2 已归档出 src/data，所以 active 只能是 bundle.json 或 pilot_bundle_v2c_fixed.json
  const ver = await evalJs(`(() => {
    const t = document.querySelector('#app').innerText
    const m = t.match(/FILE\\s+(\\S+\\.json)/)
    const w = t.match(/WELLS\\s+(\\d+)/)
    const e = t.match(/EVENTS\\s+(\\d+)/)
    const d = t.match(/DS\\s+(\\S+)/)
    return JSON.stringify({ file: m ? m[1] : null, wells: w ? +w[1] : null,
                            events: e ? +e[1] : null, ds: d ? d[1] : null,
                            alarm: t.includes('已回退 mock') })
  })()`)
  const vv = JSON.parse(ver)
  // 与 provider.ts 的 resolve() 同序：mock 强制 → mock_bundle；否则 bundle.json > final77 > v2c > mock
  const expectFile =
    DATA_MODE === 'mock'
      ? 'mock_bundle.json'
      : existsSync('src/data/bundle.json')
        ? 'bundle.json'
        : existsSync('src/data/pilot_bundle_final77.json')
          ? 'pilot_bundle_final77.json'
          : existsSync('src/data/pilot_bundle_v2c_fixed.json')
            ? 'pilot_bundle_v2c_fixed.json'
            : 'mock_bundle.json'
  const expectJson = JSON.parse(readFileSync(`src/data/${expectFile}`, 'utf8'))
  const expectWells = expectJson.meta?.n_wells ?? null
  const expectEvents = expectJson.meta?.n_events ?? null
  check('数据版本条：active file 与生效 bundle 一致',
    vv.file === expectFile, `页面=${vv.file} 期望=${expectFile}`)
  check('数据版本条：n_wells / n_events 与生效 bundle 一致',
    vv.wells === expectWells && vv.events === expectEvents,
    `页面=${vv.wells}/${vv.events} 期望=${expectWells}/${expectEvents}`)
  check('数据版本条：未误报回退告警', vv.alarm === false, `alarm=${vv.alarm}`)
  // 总装收口：active 必须是 final77（不改名成 bundle.json；也不得退回 v2c）
  check('数据版本条：active = pilot_bundle_final77.json',
    vv.file === 'pilot_bundle_final77.json' && DATA_MODE === 'real_pilot',
    `file=${vv.file} mode=${DATA_MODE}`)
  // 角标必须写「实测 pilot · final77」（release 标记优先于 event_definition）
  const badge2 = await evalJs(`(() => {
    const t = document.querySelector('#app').innerText
    const i = t.indexOf('实测 pilot')
    return JSON.stringify({ tag: i >= 0 ? t.slice(i, i + 24) : null })
  })()`)
  const bb = JSON.parse(badge2)
  check('角标文案 = 实测 pilot · final77',
    !!bb.tag && bb.tag.includes('final77'), `角标=${JSON.stringify(bb.tag)}`)
  check('归档生效：src/data 下不再有 v1 / v2 pilot 文件，且已移入 src/data/archive/',
    !existsSync('src/data/pilot_bundle.json') && !existsSync('src/data/pilot_bundle_v2.json') &&
    existsSync('src/data/archive/pilot_bundle_v1.json') &&
    existsSync('src/data/archive/pilot_bundle_v2.json'),
    `v1=${existsSync('src/data/pilot_bundle.json')} v2=${existsSync('src/data/pilot_bundle_v2.json')} ` +
    `archived=${existsSync('src/data/archive/pilot_bundle_v1.json') && existsSync('src/data/archive/pilot_bundle_v2.json')}`)

  // 状态必须以 bundle 的 well.state 为准（2026-10-27 修：前端曾现算成 26/1/0/50，与 bundle 19/35/17/6 不符）
  if (!isMock) {
    const st = { green: 0, yellow: 0, red: 0, gray: 0 }
    for (const w of expectJson.wells ?? []) st[w.state] = (st[w.state] ?? 0) + 1
    const want = [st.green, st.yellow, st.red, st.gray]
    check('状态以 bundle 为准（前端不现算）：四象限计数 = well.state 分布',
      q.length === 4 && want.every((n, i) => q[i].rows === n),
      `页面=${q.map((x) => x.rows).join('/')} bundle=${want.join('/')}`)
    // 收口口径：红态必须出现（模型判红，需复核），不得被吞成灰
    check('红态（不建议）必须出现且计数与 bundle 一致',
      st.red > 0 && q[2].rows === st.red, `bundle_red=${st.red} 页面=${q[2].rows}`)
    check('四象限 = 19/35/17/6（final77 口径）',
      want.join('/') === '19/35/17/6', `bundle=${want.join('/')}`)
  }

  // —— 4. 单井 1 秒内打开 ——
  await openPage('#/well/W001')
  const tWell = await waitReady()
  check('单井 1 秒内打开', tWell >= 0 && tWell < 1000, `${tWell} ms`)

  // —— 5. 决策卡六要素 ——
  const card = await evalJs(`(() => {
    const t = document.querySelector('#app').innerText
    return JSON.stringify({
      curve: document.querySelectorAll('#app canvas').length >= 1,
      breakEven: t.includes('保本线'),
      lag: t.includes('见效滞后'),
      fingerprint: t.includes('固有随机') && t.includes('数据不足') && t.includes('模型分歧') && t.includes('经济参数'),
      evidence: t.includes('相似事件') || t.includes('距离'),
      gaps: t.includes('数据缺口'),
      oneSided: t.includes('单边 90% 区间') || t.includes('单边 90%')
    })
  })()`)
  const c = JSON.parse(card)
  check('决策卡含 曲线/保本线/滞后/指纹/证据链/缺口',
    c.curve && c.breakEven && c.lag && c.fingerprint && c.evidence && c.gaps, JSON.stringify(c))
  // 实测 bundle 的下界恒被截断到 0（已定性为非负截断）→ 必须标“单边区间”，不许假装双边
  if (!isMock) {
    const expectOneSided = (expectJson.intervals?.kind ?? '') === 'one_sided_lower_clipped_at_zero'
    check('90% 区间口径标注与 bundle 一致（下界截断 → 单边区间）',
      expectOneSided ? c.oneSided : true,
      `intervals.kind=${expectJson.intervals?.kind ?? '（无）'} 页面标注=${c.oneSided}`)
  }

  // —— 6. 数字护照可点开任意数字 ——
  await evalJs(`[...document.querySelectorAll('button')].find(b => b.innerText.includes('打开数字护照')).click()`)
  await sleep(600)
  const pp = await evalJs(`(() => {
    const t = document.body.innerText
    return JSON.stringify({ open: t.includes('公式'), formula: t.includes('mean(最近 3 个非零月日产油)') || t.includes('P(NPV>0)'), na: t.includes('暂无') })
  })()`)
  const p = JSON.parse(pp)
  check('数字护照抽屉可打开且含公式', p.open && p.formula, JSON.stringify(p))

  // —— 7. 第三幕：你栏求和 + 其余查表；不命中即暂无 ——
  await openPage('#/portfolio'); await waitReady()
  const pf = await evalJs(`(() => {
    const t = document.querySelector('#app').innerText
    return JSON.stringify({
      matched: t.includes('组合指标命中'),
      youCalc: t.includes('求和 + 查表'),
      src: document.querySelector('[data-combo-source]')?.dataset.comboSource ?? null
    })
  })()`)
  const pfv = JSON.parse(pf)
  check('第三幕：你栏按“求和 + 查表”结算', pfv.matched && pfv.youCalc,
    `命中=${pfv.matched} 来源=${pfv.src}`)

  // 实测模式：组合表只覆盖 topN 口井，先从 bundle 里读出这 topN 的 well_id
  let comboWellIds = []
  if (!isMock) {
    // 顺序必须与 provider.ts 的解析优先级一致：
    // bundle.json(正式全量) > pilot_bundle_final77.json(final77 收口版)
    // > pilot_bundle_v2c_fixed.json(v2c) —— 与 provider.ts 的优先级必须一致
    // v1 / v2 已归档到仓库根 archive/，不再参与构建，这里也不再读
    for (const f of ['src/data/bundle.json', 'src/data/pilot_bundle_final77.json',
                     'src/data/pilot_bundle_v2c_fixed.json']) {
      if (!existsSync(f)) continue
      try {
        const j = JSON.parse(readFileSync(f, 'utf8'))
        const s = new Set()
        for (const it of j?.combo_metrics?.items ?? []) for (const w of it.selected ?? []) s.add(w)
        comboWellIds = [...s].sort()
        break
      } catch { /* 读不到就退化 */ }
    }
  }

  // 未命中分支：
  //  mock 模式选一口不进网格的井（W004）→ 应为「组合指标暂无」
  //  实测模式组合表覆盖 C(topN,3) 全表，topN 内的任意 3 井都必然命中 → 改判「命中」
  await evalJs(`(() => {
    const rows = [...document.querySelectorAll('#app .cand')]
    if (!rows.length) return 0
    const boxOf = (r) => r.querySelector('.n-checkbox') || r.querySelector('input')
    if (${isMock}) {
      // mock：选一口不进网格的井（W004）
      const pick = rows.find(r => r.innerText.includes('W004'))
      const box = pick && boxOf(pick)
      if (!box) return 0
      box.click(); return 1
    }
    return 0
  })()`)
  await sleep(300)

  // 实测：组合表只覆盖 C(topN,3) 的 topN 口井，而候选列表是全量井
  // → 必须选**组合表覆盖到的**井，否则必然查不到（那是正确行为，不是 bug）
  // 注意：候选列表对「池外井 / 超过 k 口」会禁用勾选，Vue 需要在每次点击后重渲染，
  // 所以这里必须像真实用户一样逐次点击、每次点击之间留出渲染时间，不能同步连点。
  if (!isMock) {
    await evalJs(`(() => {
      const rows = [...document.querySelectorAll('#app .cand')]
      rows.forEach(r => {
        const b = r.querySelector('.n-checkbox') || r.querySelector('input')
        if (b && (b.className || '').includes('checked')) b.click()
      })
      return 1
    })()`)
    await sleep(400)
    for (const id of comboWellIds.slice(0, 3)) {
      await evalJs(`(() => {
        const row = [...document.querySelectorAll('#app .cand')]
          .find(r => r.innerText.includes(${JSON.stringify(id)}))
        const b = row && (row.querySelector('.n-checkbox') || row.querySelector('input'))
        if (!b) return 0
        b.click(); return 1
      })()`)
      await sleep(300)
    }
  }
  await sleep(500)
  const pf2 = await evalJs(`(() => {
    const t = document.querySelector('#app').innerText
    return JSON.stringify({ na: t.includes('组合指标暂无'), hit: t.includes('组合指标命中') })
  })()`)
  const pf2v = JSON.parse(pf2)
  if (isMock) {
    check('第三幕：组合查表未命中 → 显示“暂无”', pf2v.na === true, JSON.stringify(pf2v))
  } else {
    check('第三幕：topN 内任意 3 井均在 C(topN,3) 全表中命中（实测）',
      pf2v.hit === true, JSON.stringify(pf2v))
  }

  // —— 8. 第四幕四块有示意内容 ——
  await openPage('#/review'); await waitReady()
  const rv = await evalJs(`(() => {
    const t = document.querySelector('#app').innerText
    return JSON.stringify({
      voi: t.includes('信息价值') && t.includes('翻绿概率'),
      lc: t.includes('学习曲线') && !t.includes('暂无 · 等待模型侧产出 learning_curve'),
      bt: t.includes('历史回放') && !t.includes('暂无 · 等待模型侧产出 backtest'),
      ab: t.includes('规律消融') && !t.includes('暂无 · 等待模型侧产出 ablation'),
      lc_na: t.includes('学习曲线') && t.includes('暂无 · 等待模型侧产出 learning_curve'),
      bt_na: t.includes('历史回放') && t.includes('暂无 · 等待模型侧产出 backtest'),
      ab_na: t.includes('规律消融') && t.includes('暂无 · 等待模型侧产出 ablation'),
      illus: (t.match(/示意/g) || []).length
    })
  })()`)
  const rvv = JSON.parse(rv)
  if (isMock) {
    check('第四幕：VOI/学习曲线/回放/消融 均有内容（示意）',
      rvv.voi && rvv.lc && rvv.bt && rvv.ab, JSON.stringify(rvv))
    check('第四幕：示意角标已打', rvv.illus >= 3, `示意×${rvv.illus}`)
  } else {
    // 实测模式按设计不加载示意补充：三块必须**诚实显示暂无**，且不得打示意角标
    check('第四幕：VOI 有内容；学习曲线/回放/消融 诚实显示暂无（实测）',
      rvv.voi && rvv.lc_na && rvv.bt_na && rvv.ab_na, JSON.stringify(rvv))
    check('第四幕：实测模式下不得出现示意角标', rvv.illus === 0, `示意×${rvv.illus}`)
  }

  // —— 9. 报告 A4 ——
  await openPage('#/report'); await waitReady()
  const rp = await evalJs(`(() => {
    const t = document.querySelector('#app').innerText
    return JSON.stringify({ head: t.includes('压裂措施决策报告'), sign: t.includes('签字'), na: t.includes('暂无') })
  })()`)
  const rpv = JSON.parse(rp)
  check('报告含页眉与签字栏', rpv.head && rpv.sign)

  // —— 10. 1920 / 1366 布局不崩 ——
  for (const [w, h] of [[1920, 1080], [1366, 768]]) {
    await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false })
    await openPage('#/'); await waitReady()
    const o = await evalJs(`JSON.stringify({
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      panels: document.querySelectorAll('#app .panel').length
    })`)
    const ov = JSON.parse(o)
    check(`${w}×${h} 布局不崩`, ov.panels > 0 && ov.overflow <= 2, `横向溢出 ${ov.overflow}px, panels=${ov.panels}`)
  }
  await send('Emulation.clearDeviceMetricsOverride')

  // —— 11. 断网可跑 ——
  await send('Network.enable')
  await send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 })
  await openPage('#/')
  const tOff = await waitReady()
  check('断网（offline）下首页可跑', tOff >= 0, `${tOff} ms`)
  await openPage('#/review')
  const tOff2 = await waitReady()
  check('断网（offline）下第四幕可跑', tOff2 >= 0, `${tOff2} ms`)
  await send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 })

  // —— 12. 无 console error ——
  const errs = problems.filter((p) => p.level !== 'warning')
  check('无 console error / 未捕获异常', errs.length === 0,
    errs.length ? errs.slice(0, 5).map((e) => `${e.route}:${e.text.slice(0, 120)}`).join(' ｜ ') : '0 条')
} catch (e) {
  check('脚本执行', false, e.message)
} finally {
  cleanup()
}

const failed = results.filter((r) => !r.ok)
console.log(`\n合计 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}`)
process.exit(failed.length ? 1 : 0)
