/* ==========================================================================
   charts.js · 轻量 canvas 图表（无第三方依赖，DPR 自适应）
   ========================================================================== */

function setup(canvas, h) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  const rect = canvas.getBoundingClientRect()
  const w = Math.round(rect.width) || canvas.clientWidth || 300
  const hh = h || Math.round(rect.height) || canvas.clientHeight || 80
  canvas.width = Math.round(w * dpr)
  canvas.height = Math.round(hh * dpr)
  const g = canvas.getContext('2d')
  g.setTransform(dpr, 0, 0, dpr, 0, 0)
  g.clearRect(0, 0, w, hh)
  return { g, w, h: hh }
}

export function lineChart(canvas, opts) {
  const { g, w, h } = setup(canvas, opts.height)
  const pad = { l: 2, r: 2, t: 6, b: 13 }
  const series = opts.series || []
  const all = series.flatMap((s) => s.data)
  const max = Math.max(...all, 1e-6)
  const min = Math.min(0, ...all)
  const X = (i, n) => pad.l + (i / Math.max(1, n - 1)) * (w - pad.l - pad.r)
  const Y = (v) => pad.t + (1 - (v - min) / (max - min || 1)) * (h - pad.t - pad.b)

  // 网格
  g.strokeStyle = 'rgba(120,190,205,0.12)'
  g.lineWidth = 1
  for (let k = 0; k <= 2; k++) {
    const y = pad.t + (k / 2) * (h - pad.t - pad.b)
    g.beginPath(); g.moveTo(pad.l, y); g.lineTo(w - pad.r, y); g.stroke()
  }

  for (const s of series) {
    const n = s.data.length
    if (n < 2) continue
    if (s.fill) {
      const grd = g.createLinearGradient(0, pad.t, 0, h - pad.b)
      grd.addColorStop(0, s.fill[0])
      grd.addColorStop(1, s.fill[1])
      g.beginPath()
      s.data.forEach((v, i) => (i ? g.lineTo(X(i, n), Y(v)) : g.moveTo(X(i, n), Y(v))))
      g.lineTo(X(n - 1, n), h - pad.b)
      g.lineTo(X(0, n), h - pad.b)
      g.closePath()
      g.fillStyle = grd
      g.fill()
    }
    g.beginPath()
    s.data.forEach((v, i) => (i ? g.lineTo(X(i, n), Y(v)) : g.moveTo(X(i, n), Y(v))))
    g.strokeStyle = s.color
    g.lineWidth = s.width || 1.6
    if (s.dashed) g.setLineDash([3, 4])
    g.stroke()
    g.setLineDash([])
  }

  // 游标
  if (opts.cursor != null && series[0]) {
    const n = series[0].data.length
    const i = Math.max(0, Math.min(n - 1, opts.cursor))
    const x = X(i, n)
    g.strokeStyle = 'rgba(240,178,60,0.65)'
    g.setLineDash([2, 3])
    g.beginPath(); g.moveTo(x, pad.t); g.lineTo(x, h - pad.b); g.stroke()
    g.setLineDash([])
    g.fillStyle = '#f0b23c'
    g.beginPath(); g.arc(x, Y(series[0].data[i]), 2.4, 0, 6.283); g.fill()
  }

  // x 轴刻度
  if (opts.labels) {
    g.fillStyle = 'rgba(126,152,163,0.75)'
    g.font = '8px ui-monospace, Consolas, monospace'
    opts.labels.forEach((t, i) => {
      const x = X(i, opts.labels.length)
      const tw = g.measureText(t).width
      g.fillText(t, Math.max(0, Math.min(w - tw, x - tw / 2)), h - 2)
    })
  }
}

export function donutChart(canvas, segments, center) {
  const { g, w, h } = setup(canvas, canvas.clientHeight || 132)
  const cx = w / 2, cy = h / 2
  const R = Math.min(w, h) / 2 - 4
  const r = R - 11
  const total = segments.reduce((a, s) => a + s.value, 0) || 1
  let a0 = -Math.PI / 2
  const gap = 0.035
  segments.forEach((s) => {
    const a1 = a0 + (s.value / total) * Math.PI * 2
    g.beginPath()
    g.arc(cx, cy, R, a0 + gap / 2, a1 - gap / 2)
    g.arc(cx, cy, r, a1 - gap / 2, a0 + gap / 2, true)
    g.closePath()
    g.fillStyle = s.color
    g.fill()
    // 内侧高光
    g.strokeStyle = 'rgba(255,255,255,0.10)'
    g.lineWidth = 0.6
    g.stroke()
    a0 = a1
  })
  // 刻度环
  g.strokeStyle = 'rgba(120,190,205,0.14)'
  g.lineWidth = 1
  g.beginPath(); g.arc(cx, cy, R + 2.5, 0, 6.283); g.stroke()
  if (center) {
    g.fillStyle = '#e8f6f9'
    g.font = '600 22px ui-monospace, Consolas, monospace'
    g.textAlign = 'center'
    g.fillText(center.value, cx, cy + 2)
    g.fillStyle = 'rgba(126,152,163,0.9)'
    g.font = '9px "PingFang SC", "Microsoft YaHei", sans-serif'
    g.fillText(center.label, cx, cy + 16)
    g.textAlign = 'left'
  }
}

export function sparkline(canvas, values, color, cursor) {
  const { g, w, h } = setup(canvas, canvas.clientHeight || 62)
  const pad = 5
  const max = Math.max(...values, 1e-6)
  const X = (i) => pad + (i / Math.max(1, values.length - 1)) * (w - pad * 2)
  const Y = (v) => h - pad - (v / max) * (h - pad * 2)
  const grd = g.createLinearGradient(0, 0, 0, h)
  grd.addColorStop(0, 'rgba(95,227,212,0.32)')
  grd.addColorStop(1, 'rgba(95,227,212,0)')
  g.beginPath()
  values.forEach((v, i) => (i ? g.lineTo(X(i), Y(v)) : g.moveTo(X(i), Y(v))))
  g.lineTo(X(values.length - 1), h - pad)
  g.lineTo(X(0), h - pad)
  g.closePath()
  g.fillStyle = grd
  g.fill()
  g.beginPath()
  values.forEach((v, i) => (i ? g.lineTo(X(i), Y(v)) : g.moveTo(X(i), Y(v))))
  g.strokeStyle = color || '#5fe3d4'
  g.lineWidth = 1.4
  g.stroke()
  if (cursor != null) {
    const i = Math.max(0, Math.min(values.length - 1, cursor))
    g.strokeStyle = 'rgba(240,178,60,0.7)'
    g.setLineDash([2, 3])
    g.beginPath(); g.moveTo(X(i), 2); g.lineTo(X(i), h - pad); g.stroke()
    g.setLineDash([])
    g.fillStyle = '#f0b23c'
    g.beginPath(); g.arc(X(i), Y(values[i]), 2.3, 0, 6.283); g.fill()
  }
}

export function barsChart(canvas, values, color) {
  const { g, w, h } = setup(canvas, canvas.clientHeight || 80)
  const n = values.length
  const max = Math.max(...values, 1e-6)
  const bw = (w - (n - 1) * 4) / n
  values.forEach((v, i) => {
    const bh = (v / max) * (h - 10)
    const x = i * (bw + 4)
    const grd = g.createLinearGradient(0, h - bh, 0, h)
    grd.addColorStop(0, color || '#5fe3d4')
    grd.addColorStop(1, 'rgba(95,227,212,0.15)')
    g.fillStyle = grd
    g.fillRect(x, h - bh, bw, bh)
  })
}
