/**
 * T16 · 同步协议 + 模拟器（06_任务清单 T16）
 *
 * 验收原文：**双标签页一致；快照+增量 == 全量重放。**
 *
 * 数据源（只读，随单文件内联）：
 * - `data/twin_states.json`（schema twin_state/1.0，H-004）：77 井卡尔曼快照（s / P / ts）
 * - `data/twin_fsm.json`（schema twin_fsm/1.0，H-007）：77 井 × 月度生命周期序列 [ts, state]
 *
 * 协议 twin_sync/1.0（帧式，服务端为**确定性模拟器**，无网络）：
 * | 帧 | 方向 | 载荷 | 语义 |
 * |---|---|---|---|
 * | hello | C→S | lastTs | 连接并报告已对齐到的月序（null = 冷启动 / 失忆） |
 * | snapshot | S→C | ts, wells | 全量快照（冷启动或对齐重连时下发） |
 * | delta | S→C | ts, changes | 一个月一份增量：仅该月状态变化的井（含新入场井，附 s） |
 * | eof | S→C | ts | 时间轴末端 |
 *
 * 断线重连：客户端带着 lastTs 重连 → 服务端从 lastTs+1 续推增量，客户端状态不失忆；
 * 回退（seek 到更早月份）等价于失忆重连 → 直接下发目标时刻快照对齐，不回放。
 *
 * 颜色口径：照抄 `pipeline/twin_fsm.py` 的 `snapshot_color()`
 * （SHUT→gray；NORMAL/EFFECTIVE→green；CANDIDATE/INEFFECTIVE→red；其余 yellow），
 * 不自造映射。
 */
import fsmRaw from '@/data/twin_fsm.json'
import statesRaw from '@/data/twin_states.json'

// ── 数据形态（导入侧只声明用到的字段，不做全量字面量类型） ──────────────
type FsmWell = { ts: number; fsm_state: string; seq: [number, string][] }
type FsmFile = { schema: string; wells: Record<string, FsmWell> }
type StateWell = { ts: number; s: Record<string, number>; P?: number[][]; sd_q?: number }
type StateFile = { schema: string; s_fields: string[]; wells: Record<string, StateWell> }

const FSM = fsmRaw as unknown as FsmFile
const STATES = statesRaw as unknown as StateFile

export type ColorName = 'green' | 'yellow' | 'red' | 'gray'
export type StateName = string

/** snapshot_color 口径（twin_fsm.py L268–277），不自造 */
export function stateColor(s: StateName): ColorName {
  if (s === 'SHUT') return 'gray'
  if (s === 'NORMAL' || s === 'EFFECTIVE') return 'green'
  if (s === 'CANDIDATE' || s === 'INEFFECTIVE') return 'red'
  return 'yellow'
}

// ── 时间轴（从数据推导，不写死） ─────────────────────────────────────
const APIS = Object.keys(FSM.wells).sort()
const TS0 = Math.min(...APIS.map((a) => FSM.wells[a].seq[0][0]))
const TS_MAX = Math.max(...APIS.map((a) => FSM.wells[a].seq[FSM.wells[a].seq.length - 1][0]))

/** 每井逐月状态表：stateAt[i] = ts = TS0+i 时的状态（null = 该井尚未入场） */
const STATE_AT: Record<string, (StateName | null)[]> = {}
/** 每井逐月「状态建立时刻」：stateTs[i] = 当前状态是哪个月建立的（末次状态转移月，含入场）。
 *  这是本协议的 ts 口径：快照、增量、全量重放三条路径共用，保证指纹可比。 */
const STATE_TS: Record<string, number[]> = {}
for (const api of APIS) {
  const n = TS_MAX - TS0 + 1
  const row: (StateName | null)[] = new Array(n).fill(null)
  for (const [ts, st] of FSM.wells[api].seq) row[ts - TS0] = st
  // 序列断档月沿用前一月状态（状态机的「保持」语义）
  for (let i = 1; i < n; i++) if (row[i] === null && row[i - 1] !== null) row[i] = row[i - 1]
  STATE_AT[api] = row
  const tsRow: number[] = new Array(n).fill(-1)
  let last = -1
  for (let i = 0; i < n; i++) {
    const prev = i > 0 ? row[i - 1] : null
    if (row[i] !== prev) last = TS0 + i // 入场或状态转移
    tsRow[i] = last
  }
  STATE_TS[api] = tsRow
}

export interface WellSnap {
  ts: number
  state: StateName
  color: ColorName
  s: number[]
  sdQ?: number
}
export interface DeltaEntry { state: StateName; color: ColorName; s?: number[] }

export type Frame =
  | { type: 'hello'; lastTs: number | null; serverTs: number }
  | { type: 'snapshot'; ts: number; wells: Record<string, WellSnap> }
  | { type: 'delta'; ts: number; changes: Record<string, DeltaEntry> }
  | { type: 'eof'; ts: number }

function snapAt(api: string, ts: number): WellSnap {
  const i = ts - TS0
  const st = STATE_AT[api][i] ?? FSM.wells[api].seq[0][1]
  const sw = STATES.wells[api]
  return {
    ts: STATE_TS[api][i] > 0 ? STATE_TS[api][i] : ts,
    state: st,
    color: stateColor(st),
    s: STATES.s_fields.map((f: string) => sw.s[f]),
    sdQ: sw.sd_q,
  }
}

// ── 服务端（确定性模拟器） ──────────────────────────────────────────
export interface ConnectOpts { lastTs: number | null; alignTs?: number }

class SyncSession {
  readonly lastTs: number | null
  private cursor: number // 下一个要发 delta 的月序
  private phase: 0 | 1 | 2 = 0 // 0=hello 1=snapshot 2=deltas
  private readonly alignTs: number

  constructor(opts: ConnectOpts) {
    this.lastTs = opts.lastTs
    // 对齐时刻：冷启动默认 TS0；带状态重连从 lastTs 续推；失忆重连可指定目标时刻
    this.alignTs =
      opts.lastTs != null ? opts.lastTs : Math.max(TS0, Math.min(opts.alignTs ?? TS0, TS_MAX))
    this.cursor = this.alignTs + 1
    if (opts.lastTs != null) this.phase = 2 // 有状态：续推
  }

  pull(): Frame | null {
    if (this.phase === 0) {
      this.phase = 2
      const wells: Record<string, WellSnap> = {}
      for (const api of APIS) if (STATE_AT[api][this.alignTs - TS0] != null) wells[api] = snapAt(api, this.alignTs)
      return { type: 'snapshot', ts: this.alignTs, wells }
    }
    if (this.cursor > TS_MAX) return { type: 'eof', ts: TS_MAX }
    const ts = this.cursor++
    const changes: Record<string, DeltaEntry> = {}
    for (const api of APIS) {
      const cur = STATE_AT[api][ts - TS0]
      const prev = ts - 1 - TS0 >= 0 ? STATE_AT[api][ts - 1 - TS0] : null
      if (cur === prev) continue
      const entry: DeltaEntry = { state: cur as StateName, color: stateColor(cur as StateName) }
      if (prev == null && cur != null) entry.s = snapAt(api, ts).s // 新入场井随帧附 s
      changes[api] = entry
    }
    return { type: 'delta', ts, changes }
  }
}

// ── 客户端 ─────────────────────────────────────────────────────────
export class SyncClient {
  readonly state = new Map<string, WellSnap>()
  lastTs: number | null = null
  frames = 0
  private session: SyncSession | null = null

  /** 连接：lastTs 非空 = 带状态续连（断线重连）；空 = 冷启动/失忆（可指定对齐时刻） */
  connect(opts: ConnectOpts): void {
    this.session = new SyncSession(opts)
    this.frames++
  }

  /** 拉一帧并应用；返回该帧或 null（未连接） */
  pollOnce(): Frame | null {
    const f = this.session?.pull()
    if (!f) return null
    this.frames++
    if (f.type === 'snapshot') {
      this.state.clear()
      for (const [api, w] of Object.entries(f.wells)) this.state.set(api, { ...w })
      this.lastTs = f.ts
    } else if (f.type === 'delta') {
      for (const [api, c] of Object.entries(f.changes)) {
        const cur = this.state.get(api)
        this.state.set(api, {
          ts: f.ts,
          state: c.state,
          color: c.color,
          s: c.s ?? cur?.s ?? [],
          sdQ: cur?.sdQ,
        })
      }
      this.lastTs = f.ts
    }
    return f
  }

  /** 推进到目标月序：向后走增量；向前/冷启动走快照对齐 */
  seek(ts: number): void {
    const t = Math.max(TS0, Math.min(ts, TS_MAX))
    if (t === this.lastTs) return
    if (this.lastTs != null && t > this.lastTs) {
      while (this.lastTs != null && this.lastTs < t) {
        const f = this.pollOnce()
        if (!f || f.type === 'eof') break // 无帧可拉（未连接 / 到端）：退出防死循环
      }
      return
    }
    // 失忆重连：直接对齐到 t
    this.connect({ lastTs: null, alignTs: t })
    this.pollOnce()
  }

  /** 从时间轴起点冷启动，逐帧推到末端（「快照+增量」路径） */
  replayFromStart(): void {
    this.connect({ lastTs: null })
    let f: Frame | null
    while ((f = this.pollOnce()) && f.type !== 'eof') { /* 逐帧 */ }
  }

  /** 断线：保留 state 与 lastTs，仅丢弃会话 */
  disconnect(): void { this.session = null }

  /** 状态指纹（跨标签页 / 跨路径一致性比较用） */
  stateHash(): string {
    let h = 0x811c9dc5
    for (const api of APIS) {
      const w = this.state.get(api)
      const sig = w ? `${api}:${w.ts}:${w.state}` : `${api}:-:-`
      for (let i = 0; i < sig.length; i++) {
        h ^= sig.charCodeAt(i)
        h = (h * 0x01000193) >>> 0
      }
    }
    return h.toString(16)
  }

  well(api: string): WellSnap | undefined { return this.state.get(api) }
}

export const TWIN_SYNC = {
  ts0: TS0,
  tsMax: TS_MAX,
  wellCount: APIS.length,
  /** 权威终态（直接从数据全量重放推导，供「快照+增量 == 全量重放」比对） */
  directFinal(): Record<string, { ts: number; state: StateName; color: ColorName }> {
    const out: Record<string, { ts: number; state: StateName; color: ColorName }> = {}
    for (const api of APIS) {
      const seq = FSM.wells[api].seq
      const last = seq[seq.length - 1]
      out[api] = { ts: STATE_TS[api][TS_MAX - TS0], state: last[1], color: stateColor(last[1]) }
    }
    return out
  },
  newClient(): SyncClient { return new SyncClient() },
}

export type TwinSync = typeof TWIN_SYNC

// ── 自检（T16 验收 A/B/C，可在页面内直接调用） ──────────────────────
export interface SelfTestResult {
  aPass: boolean // 快照+增量 == 全量重放
  bPass: boolean // 断线重连对齐
  cPass: boolean // 双路径同刻一致（增量推进 vs 快照对齐）
  hashFull: string
  hashReconnect: string
  hashIncremental: string
  hashAligned: string
  mismatches: string[]
  frames: number
}

export function selfTest(): SelfTestResult {
  const direct = TWIN_SYNC.directFinal()

  // A：冷启动快照 + 逐月增量到末端
  const a = TWIN_SYNC.newClient()
  a.replayFromStart()
  const hashFull = a.stateHash()
  const mismatches: string[] = []
  for (const api of Object.keys(direct)) {
    const w = a.well(api)
    if (!w || w.ts !== direct[api].ts || w.state !== direct[api].state) {
      mismatches.push(`${api}: got ${w ? w.ts + '/' + w.state : 'missing'} want ${direct[api].ts}/${direct[api].state}`)
    }
  }

  // B：推到中段断线，带状态重连续推
  const mid = TS0 + Math.floor((TS_MAX - TS0) / 2)
  const b = TWIN_SYNC.newClient()
  b.connect({ lastTs: null })
  b.pollOnce() // 先收快照帧，确立 lastTs（connect 本身不写 lastTs）
  while (b.lastTs != null && b.lastTs < mid) b.pollOnce()
  const tsAtDrop = b.lastTs
  b.disconnect()
  b.connect({ lastTs: b.lastTs })
  let bf: Frame | null
  while ((bf = b.pollOnce()) && bf.type !== 'eof') { /* 续推 */ }
  const hashReconnect = b.stateHash()

  // C：同刻双路径——增量推进到 k vs 失忆快照直接对齐 k
  const k = TS0 + Math.floor((TS_MAX - TS0) * 0.8)
  const c1 = TWIN_SYNC.newClient()
  c1.connect({ lastTs: null })
  c1.pollOnce() // 同上：先收快照帧
  while (c1.lastTs != null && c1.lastTs < k) c1.pollOnce()
  const c2 = TWIN_SYNC.newClient()
  c2.seek(k)
  const hashIncremental = c1.stateHash()
  const hashAligned = c2.stateHash()

  return {
    aPass: hashFull === hashReconnect && mismatches.length === 0,
    bPass: hashReconnect === hashFull && tsAtDrop === mid,
    cPass: hashIncremental === hashAligned,
    hashFull,
    hashReconnect,
    hashIncremental,
    hashAligned,
    mismatches: mismatches.slice(0, 8),
    frames: a.frames + b.frames + c1.frames + c2.frames,
  }
}
