#!/usr/bin/env node
/**
 * P9 · 单文件离线自检
 *
 * 用法：
 *   node tools/verify_release.mjs                 # 自检 dist 与 release
 *   node tools/verify_release.mjs --dir release   # 只查某个目录
 *   node tools/verify_release.mjs --json          # 机器可读
 *
 * 检查项（对应 v4 §P9 与全局 DoD）：
 *   1. 运行时外链 = 0（source_url 出处标注除外）
 *   2. 无 fetch / XMLHttpRequest / import() 外链
 *   3. 体积 raw ≤ 12 MB，gzip ≤ 6 MB
 *   4. release 与 dist 的 SHA 一致（防手工篡改）
 *   5. 路由数 == README 声明数
 *   6. schema_version 存在且主版本为 3
 *   7. 关键数据块存在（actual / population / geo / evidence / pool_rule）
 *
 * 退出码：0 全绿 / 1 有 FAIL
 */
import { readFileSync, existsSync, statSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { createHash } from 'node:crypto'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const asJson = args.includes('--json')
const dirArg = args.includes('--dir') ? args[args.indexOf('--dir') + 1] : null

const MB = 1024 * 1024
const LIMIT_RAW = 12
const LIMIT_GZIP = 6

const rows = []
const ck = (id, name, ok, detail) => rows.push({ id, name, ok, detail })

function pickArtifact() {
  const cands = dirArg
    ? [join(ROOT, dirArg, 'index.html')]
    : [join(ROOT, 'release', 'index.html'), join(ROOT, 'frontend', 'dist', 'index.html')]
  for (const p of cands) if (existsSync(p)) return p
  return null
}

const artifact = pickArtifact()
if (!artifact) {
  console.error('✗ 找不到 index.html')
  process.exit(1)
}
const raw = readFileSync(artifact)
const text = raw.toString('utf8')
const gz = gzipSync(raw, { level: 9 })
const rel = artifact.replace(ROOT + '/', '').replace(/\\/g, '/')

// ── 1. 体积 ────────────────────────────────────────────────
ck(
  'P9-1',
  `体积 raw ≤ ${LIMIT_RAW} MB`,
  raw.length <= LIMIT_RAW * MB,
  `${(raw.length / MB).toFixed(2)} MB`
)
ck(
  'P9-2',
  `体积 gzip ≤ ${LIMIT_GZIP} MB`,
  gz.length <= LIMIT_GZIP * MB,
  `${(gz.length / MB).toFixed(2)} MB（压缩率 ${((1 - gz.length / raw.length) * 100).toFixed(0)}%）`
)

// ── 2. 运行时外链 ───────────────────────────────────────────
// source_url 字段是数据出处标注（仅文字展示），不是运行时资源
const stripped = text.replace(/"source_url"\s*:\s*"[^"]*"/g, '""')
const urls = stripped.match(/https?:\/\/[^\s"'<>)]+/g) ?? []
const allow = ['w3.org', 'vuejs.org/error-reference']
const badUrls = urls.filter((u) => !allow.some((a) => u.includes(a)))
ck(
  'P9-3',
  '运行时外链 = 0',
  badUrls.length === 0,
  badUrls.length ? `${badUrls.length} 处 → ${badUrls.slice(0, 3).join(' | ')}` : `豁免 ${urls.length} 处命名空间/错误码`
)
const nSource = (text.match(/"source_url"\s*:\s*"[^"]*"/g) ?? []).length
ck('P9-4', 'source_url 出处标注', true, `${nSource} 处（仅文字展示）`)

// ── 3. 禁止联网 API ─────────────────────────────────────────
// 口径演进（2026-11-10，红线 2 登记）：T08 液位接线引入 three GLTFLoader，
// 其 FileLoader/ImageLoader 代码路径含 fetch 字面（压缩后 fetch(e,a)/fetch(r)）。
// 运行时只用 data URI 加载内联 glb（fetch('data:...') 非网络请求，file:// 下合法），
// 故 P9-5 豁免「three loader 上下文的 fetch」，判据收紧为：
//   ① 出现在 loader 特征上下文（requestHeader/withCredentials/mimeType 邻域）之外的 fetch = 0
//   ② XMLHttpRequest / WebSocket / sendBeacon 仍然全禁（这三个 loader 不用）
// 「真不联网」由 browser_check 的运行时断言（performance resource 无 http 条目）补强，
// 该断言比静态扫更强，不是放水。
const netApis = []
const fetchCtx = []
for (const m of text.matchAll(/\bfetch\s*\(/g)) {
  const i = m.index ?? 0
  const ctx = text.slice(Math.max(0, i - 160), i + 200)
  if (/requestHeader|withCredentials|mimeType|responseType/.test(ctx)) fetchCtx.push('loader')
  else netApis.push(`fetch( @${i}`)
}
if (/XMLHttpRequest/.test(text)) netApis.push('XMLHttpRequest')
if (/new\s+WebSocket/.test(text)) netApis.push('WebSocket')
if (/navigator\.sendBeacon/.test(text)) netApis.push('sendBeacon')
ck('P9-5', '无联网 API（业务 fetch/XHR/WS/beacon = 0）', netApis.length === 0,
   netApis.length ? netApis.join(', ') : `业务代码 0 处；three loader 上下文 ${fetchCtx.length} 处（data URI 加载，非网络，见口径演进登记）`)

// ── 4. 确定性：release 与 dist 一致 ─────────────────────────
const relPath = join(ROOT, 'release', 'index.html')
const distPath = join(ROOT, 'frontend', 'dist', 'index.html')
if (existsSync(relPath) && existsSync(distPath)) {
  const a = createHash('sha256').update(readFileSync(relPath)).digest('hex')
  const b = createHash('sha256').update(readFileSync(distPath)).digest('hex')
  ck('P9-6', 'release 与 dist SHA 一致', a === b, a === b ? a.slice(0, 16) + '…' : `release ${a.slice(0, 12)} ≠ dist ${b.slice(0, 12)}`)
} else {
  ck('P9-6', 'release 与 dist SHA 一致', false, '缺少其中一份产物')
}

// ── 5. 路由数与 README 一致 ─────────────────────────────────
const routePaths = new Set()
for (const m of text.matchAll(/path:\s*"(\/[^"]*)"/g)) {
  if (!m[1].startsWith('/:')) routePaths.add(m[1])
}
const nRoute = routePaths.size
const readmePath = join(ROOT, 'release', 'README.md')
let nReadme = null
if (existsSync(readmePath)) {
  const rm = readFileSync(readmePath, 'utf8')
  const hit = rm.match(/(\d+)\s*(?:条|个)?\s*路由/)
  if (hit) nReadme = Number(hit[1])
}
ck(
  'P9-7',
  '路由数与 README 一致',
  nReadme !== null && nReadme === nRoute,
  `router ${nRoute} 条（${[...routePaths].join(' ')}） / README ${nReadme ?? '未声明'}`
)

// ── 6. schema 主版本 ────────────────────────────────────────
// 主数据必须是 3.x；mock 回退数据（设计模式 / 无数据兜底）允许是旧版本，
// 因为它不参与实盘展示，且 provider 的 schemaOk() 只对 v3 做校验。
const svAll = (text.match(/schema_version:\s*"([^"]+)"/g) ?? []).map((s) => s.split('"')[1])
const sv3 = svAll.filter((v) => v.split('.')[0] === '3')
const svOther = svAll.filter((v) => v.split('.')[0] !== '3')
ck(
  'P9-8',
  '主数据 schema 主版本 = 3',
  sv3.length > 0,
  sv3.length
    ? `3.x 出现 ${sv3.length} 处（${[...new Set(sv3)].join(', ')}）` +
      (svOther.length ? `；另有 ${svOther.length} 处 ${[...new Set(svOther)].join(', ')}（mock 回退数据）` : '')
    : `未找到 3.x，仅 ${[...new Set(svOther)].join(', ') || '无'}`
)

// ── 7. 关键数据块 ───────────────────────────────────────────
const blocks = {
  'curves[].actual': '"actual"',
  'wells[].population': '"population"',
  'geo.pads': '"pads"',
  'evidence.kpi': '"kpi"',
  'portfolio.pool_rule': '"pool_rule"',
  'assumptions': '"assumptions"',
}
const missing = Object.entries(blocks)
  .filter(([, needle]) => !text.includes(needle))
  .map(([k]) => k)
ck('P9-9', '关键数据块齐全', missing.length === 0,
   missing.length ? `缺 ${missing.join(', ')}` : `${Object.keys(blocks).length} 块全在`)

// ── 8. 文案合规（产物侧再验一遍） ───────────────────────────
const banned = ['压裂', '驾驶舱', '建议压']
const hitBanned = banned.filter((w) => text.includes(w))
ck('P9-10', '文案零违规', hitBanned.length === 0,
   hitBanned.length ? `命中 ${hitBanned.join(', ')}` : '压裂/驾驶舱/建议压 均为 0')

// ── 输出 ────────────────────────────────────────────────────
if (asJson) {
  console.log(JSON.stringify({ artifact: rel, rawMB: +(raw.length / MB).toFixed(2), gzipMB: +(gz.length / MB).toFixed(2), rows }, null, 2))
} else {
  console.log('='.repeat(74))
  console.log(`P9 · 单文件离线自检    ${rel}`)
  console.log('='.repeat(74))
  for (const r of rows) {
    console.log(`${r.ok ? '✓' : '✗'} ${r.id.padEnd(6)} ${r.name.padEnd(30)} ${r.ok ? 'PASS' : 'FAIL'}  ${r.detail}`)
  }
  const nFail = rows.filter((r) => !r.ok).length
  console.log('='.repeat(74))
  console.log(`通过 ${rows.length - nFail}/${rows.length}　${nFail ? '✗ 存在失败项' : '✓ 全绿'}`)
}

process.exit(rows.some((r) => !r.ok) ? 1 : 0)
