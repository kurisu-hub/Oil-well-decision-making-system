import { readFileSync, writeFileSync } from 'node:fs'

const dataDir = new URL('../src/data/', import.meta.url)
const read = (name) => JSON.parse(readFileSync(new URL(name, dataDir), 'utf8'))

/** 只创建缺失的演示输入；已有文件可能是本地样本，绝不覆盖。 */
function writeDemo(name, value) {
  try {
    writeFileSync(new URL(name, dataDir), `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' })
    console.log(`已生成 ${name}`)
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
    console.log(`已保留已有的 ${name}`)
  }
}

const wells = [...read('mock_bundle.json').wells, ...read('mock_supplement.json').wells]
const start = 2024 * 12 // 回放协议用 year * 12 + month - 1 表示月份。
const states = { green: 'NORMAL', yellow: 'DECLINE', red: 'CANDIDATE', gray: 'SHUT' }

writeDemo('twin_fsm.json', {
  schema: 'twin_fsm/1.0',
  source: 'synthetic_demo',
  wells: Object.fromEntries(wells.map((well) => {
    const state = states[well.state]
    return [well.api, { ts: start + 1, fsm_state: state, seq: [[start, 'NORMAL'], [start + 1, state]] }]
  })),
})

writeDemo('twin_states.json', {
  schema: 'twin_state/1.0',
  source: 'synthetic_demo',
  s_fields: [],
  wells: Object.fromEntries(wells.map((well) => [well.api, { ts: start + 1, s: {} }])),
})

// 只提供控件档位。演示井没有离线重算结果，查不到时沿用页面的缺值逻辑。
writeDemo('econ_grid.json', {
  version: 'demo',
  generated_at: '示意配置',
  base: { oil_price_cny_per_t: 3800, oil_density_t_per_m3: 0.85, price_wan_per_m3: 0.323, well_cost_wan: 45 },
  price_tiers: [3040, 3800, 4560].map((price) => ({ oil_price_cny_per_t: price })),
  cost_tiers: [36, 45, 54].map((cost) => ({ well_cost_wan: cost })),
  budget_tiers: [45, 90, 135].map((budget) => ({ budget_wan: budget })),
  grid: [],
})
