export const duration = 40
export const initialMinute = 16

export const phases = [
  { start: 0, name: '作业准备', detail: '记录班次与设备基线' },
  { start: 5, name: '设备启运', detail: '记录设备运行状态变化' },
  { start: 12, name: '参数观察', detail: '跟踪压力、流量与电流' },
  { start: 22, name: '稳定运行', detail: '持续监测生产测点' },
  { start: 34, name: '交接记录', detail: '汇总本次作业事件' },
]

export const metrics = [
  { key: 'pressure', name: '井口压力', tag: 'PT-107', unit: 'MPa', digits: 2, color: '#0d766e' },
  { key: 'flow', name: '管线流量', tag: 'FT-203', unit: 'm³/h', digits: 1, color: '#3261c2' },
  { key: 'current', name: '电机电流', tag: 'IT-301', unit: 'A', digits: 1, color: '#8052aa' },
] as const

export type Metric = (typeof metrics)[number]

export const events = [
  { id: 'ready', minute: 0, type: 'record', title: '作业记录已建立', source: 'A-07 井' },
  { id: 'start', minute: 5, type: 'record', title: '设备进入运行状态', source: 'P-07' },
  { id: 'flow', minute: 14, type: 'alarm', cleared: 19, title: '流量信号短时波动', source: 'FT-203' },
  { id: 'steady', minute: 22, type: 'record', title: '进入稳定运行阶段', source: 'A-07 井' },
  { id: 'pressure', minute: 27, type: 'alarm', cleared: 30, title: '压力测点数据中断', source: 'PT-107' },
  { id: 'handoff', minute: 34, type: 'record', title: '开始汇总交接记录', source: 'A-07 井' },
  { id: 'end', minute: 40, type: 'record', title: '作业回放结束', source: 'A-07 井' },
] as const

/** 将作业开始后的分钟数映射为示例记录的时间，供回放游标和事件共用。 */
export function timeAt(minute: number): string {
  return `09:${String(minute).padStart(2, '0')}`
}

/** 合成固定序列，确保拖回同一分钟能复现同一读数。null 表示该分钟没有压力样本。 */
function sampleAt(minute: number) {
  const ramp = Math.min(1, Math.max(0, (minute - 5) / 7))
  const wave = ramp * Math.sin(minute * 0.96)
  const flowNoise = minute >= 14 && minute < 19 ? Math.cos(minute * 2.3) * 5 : 0
  const round = (value: number) => Number(value.toFixed(2))
  return {
    pressure: minute >= 27 && minute < 30 ? null : round(0.46 + ramp * 1.44 + wave * 0.055),
    flow: round(ramp * 22.6 + wave * 0.95 + flowNoise),
    current: round(ramp * 29.4 + wave * 0.74 + (minute === 6 ? 11 : 0)),
  }
}

export const samples = Array.from({ length: duration + 1 }, (_, minute) => sampleAt(minute))
