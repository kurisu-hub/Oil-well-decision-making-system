/**
 * T04 · A2 Worker 客户端封装
 *
 * · 优先 Web Worker（vite `?worker&inline` → base64 内联，单文件 file:// 可跑）；
 * · Worker 构造/运行失败（file:// 沙箱等）→ 主线程兜底跑同一份 anbmModel（mode 标记，如实披露）；
 * · 对外只暴露 infer(input) / bench(inputs) / mode。
 */
import AnbmWorker from './anbm.worker?worker&inline'
import { infer as inferInline, type AnbmParams, type EconParams, type InferInput, type InferResult } from './anbmModel'

export type WorkerMode = 'worker' | 'inline'

export const ANBM_ECON: EconParams = {
  price: 0.323, // 万元/m³（build_bundle_v31.py PRICE_WAN_PER_M3）
  cost: 45.0, // 万元/口（WELL_COST_WAN）
  days: 30.4, // 天/月（DAYS_PER_MONTH）
}

export class AnbmClient {
  mode: WorkerMode = 'worker'
  private worker: Worker | null = null
  private anbm: AnbmParams | null = null
  private seq = 0
  private pending = new Map<number, (v: Record<string, unknown>) => void>()
  private readyPromise: Promise<void> | null = null

  constructor(anbm: AnbmParams) {
    // postMessage 走结构化克隆：Vue reactive 代理可能拒克隆（DataCloneError），
    // 先 JSON 摊平成纯对象（参数是纯数值数据，数值 JSON 往返无损）
    this.anbm = JSON.parse(JSON.stringify(anbm)) as AnbmParams
    try {
      const w = new AnbmWorker()
      w.onmessage = (ev: MessageEvent) => this.onMessage(ev.data)
      w.onerror = () => this.degrade()
      this.worker = w
      this.readyPromise = new Promise<void>((resolve) => {
        this.readyResolve = resolve
        w.postMessage({ type: 'init', anbm: this.anbm, econ: ANBM_ECON })
      })
    } catch {
      this.degrade()
    }
  }

  private readyResolve: (() => void) | null = null

  private degrade() {
    this.worker = null
    this.mode = 'inline'
    this.readyResolve?.()
  }

  private onMessage(data: unknown) {
    const msg = (data ?? {}) as Record<string, unknown>
    if (msg.type === 'ready') {
      this.readyResolve?.()
      return
    }
    if (msg.type === 'result' || msg.type === 'bench') {
      const p = this.pending.get(msg.id as number)
      if (p) {
        this.pending.delete(msg.id as number)
        p(msg)
      }
    }
  }

  private async ensure(): Promise<void> {
    if (this.readyPromise) await this.readyPromise
  }

  async infer(input: InferInput): Promise<{ ms: number; result: InferResult }> {
    await this.ensure()
    if (!this.worker) {
      const t0 = performance.now()
      const result = inferInline(input, this.anbm!, ANBM_ECON)
      return { ms: performance.now() - t0, result }
    }
    const id = ++this.seq
    const msg = (await this.request({ type: 'infer', id, input })) as unknown as { ms: number; result: InferResult }
    return { ms: msg.ms, result: msg.result }
  }

  async bench(inputs: InferInput[]): Promise<{ totalMs: number; per: InferResult[] }> {
    await this.ensure()
    if (!this.worker) {
      const t0 = performance.now()
      const per = inputs.map((input) => inferInline(input, this.anbm!, ANBM_ECON))
      return { totalMs: performance.now() - t0, per }
    }
    const id = ++this.seq
    const msg = (await this.request({ type: 'bench', id, inputs })) as unknown as { totalMs: number; per: InferResult[] }
    return { totalMs: msg.totalMs, per: msg.per }
  }

  private request(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const id = payload.id as number
      this.pending.set(id, resolve)
      this.worker!.postMessage(payload)
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          this.degrade()
          reject(new Error('worker 请求超时，已降级主线程'))
        }
      }, 5000)
    })
  }
}
