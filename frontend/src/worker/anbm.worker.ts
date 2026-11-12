/**
 * T04 · A2 Worker 前端推理 —— Web Worker 入口
 *
 * 协议（单向请求-响应，带自增 id）：
 *   main → worker { type: 'init',   anbm, econ }                      → { type:'ready' }
 *   main → worker { type: 'infer', id, input }                        → { type:'result', id, ms, result }
 *   main → worker { type: 'bench', id, inputs }                       → { type:'bench', id, totalMs, per[]: {ms,result} }
 *
 * init 参数来自 bundle.final_model.models.ANBM + 经济常数（主线程传入，不重复内联大 JSON）。
 */
import { infer, type AnbmParams, type EconParams, type InferInput, type InferResult } from './anbmModel'

let anbm: AnbmParams | null = null
let econ: EconParams | null = null

self.onmessage = (ev: MessageEvent) => {
  const msg = ev.data as Record<string, unknown>
  const type = msg.type as string

  if (type === 'init') {
    anbm = msg.anbm as AnbmParams
    econ = msg.econ as EconParams
    ;(self as unknown as Worker).postMessage({ type: 'ready' })
    return
  }

  if (type === 'infer') {
    const id = msg.id as number
    const t0 = performance.now()
    const result = infer(msg.input as InferInput, anbm!, econ!)
    const ms = performance.now() - t0
    ;(self as unknown as Worker).postMessage({ type: 'result', id, ms, result })
    return
  }

  if (type === 'bench') {
    const id = msg.id as number
    const inputs = msg.inputs as InferInput[]
    const t0 = performance.now()
    const per = inputs.map((input) => infer(input, anbm!, econ!))
    const totalMs = performance.now() - t0
    ;(self as unknown as Worker).postMessage({ type: 'bench', id, totalMs, per })
    return
  }
}

export type { InferResult }
