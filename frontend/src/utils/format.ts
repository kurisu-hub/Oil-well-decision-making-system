export function n(v: unknown, digits = 0): string {
  if (typeof v !== 'number' || !Number.isFinite(v)) return '暂无'
  return v.toLocaleString('zh-CN', { minimumFractionDigits: digits, maximumFractionDigits: digits })
}

export function pct(v: unknown, digits = 0): string {
  if (typeof v !== 'number' || !Number.isFinite(v)) return '暂无'
  return (v * 100).toFixed(digits) + '%'
}

export function signed(v: unknown, digits = 0): string {
  if (typeof v !== 'number' || !Number.isFinite(v)) return '暂无'
  const s = v.toFixed(digits)
  return v > 0 ? '+' + s : s
}

export function isNone(v: unknown): boolean {
  return v === null || v === undefined || v === '' || (typeof v === 'number' && !Number.isFinite(v))
}
