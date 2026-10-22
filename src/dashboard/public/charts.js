import { esc, fmtClock, fmtCompact, fmtPct, fmtTmn, isNum } from './fmt.js'

const NS = 'http://www.w3.org/2000/svg'
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches
const lerp = (a, b, t) => a + (b - a) * t
const ease = (t) => 1 - Math.pow(1 - t, 3)

export function tween(from, to, ms, apply) {
  if (reduced() || ms <= 0 || from === to || !isNum(from) || !isNum(to)) {
    apply(to)
    return () => {}
  }
  let raf = 0
  const t0 = performance.now()
  const frame = (now) => {
    const k = Math.min(1, (now - t0) / ms)
    apply(lerp(from, to, ease(k)))
    if (k < 1) raf = requestAnimationFrame(frame)
  }
  raf = requestAnimationFrame(frame)
  return () => cancelAnimationFrame(raf)
}

export function countTo(el, to, format, ms = 600) {
  const from = Number(el.dataset.v)
  el.dataset.v = String(to)
  el.textContent = format(isNum(from) ? from : to)
  if (el._stop) el._stop()
  if (!isNum(to)) {
    el.textContent = format(to)
    return
  }
  el._stop = tween(isNum(from) ? from : to, to, ms, (v) => {
    el.textContent = format(v)
  })
}

function downsample(series, max) {
  if (series.length <= max) return series
  const stride = series.length / max
  const out = []
  for (let i = 0; i < max - 1; i++) out.push(series[Math.floor(i * stride)])
  out.push(series[series.length - 1])
  return out
}

function niceTicks(lo, hi, count) {
  const span = hi - lo
  const raw = span / count
  const mag = Math.pow(10, Math.floor(Math.log10(raw)))
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw
  const out = []
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(v)
  return out
}

export function createEquityChart(host) {
  host.innerHTML = `<svg class="eq-svg" aria-hidden="true">
    <defs><linearGradient id="eqFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--accent)" stop-opacity=".32"/><stop offset="1" stop-color="var(--accent)" stop-opacity="0"/></linearGradient></defs>
    <g class="eq-grid"></g><path class="eq-area"/><line class="eq-base"/><text class="eq-base-label"></text><path class="eq-line"/><g class="eq-marks"></g>
    <circle class="eq-live-ring" r="9"/><circle class="eq-live" r="4"/>
    <g class="eq-cross" hidden><line/><circle r="5"/></g></svg><div class="eq-tip" hidden></div>`
  const svg = host.querySelector('svg')
  const $ = (s) => svg.querySelector(s)
  const grid = $('.eq-grid'), area = $('.eq-area'), line = $('.eq-line'), base = $('.eq-base'), baseLabel = $('.eq-base-label')
  const marks = $('.eq-marks'), live = $('.eq-live'), ring = $('.eq-live-ring'), cross = $('.eq-cross'), tip = host.querySelector('.eq-tip')
  host.tabIndex = 0
  host.setAttribute('role', 'img')

  let data = { series: [], start: null, markers: [] }
  let dom = null
  let target = null
  let stop = () => {}
  let sel = null
  const geo = { w: 0, h: 0, l: 10, r: 58, t: 14, b: 24 }

  const x = (t, d) => geo.l + ((t - d.t0) / Math.max(1, d.t1 - d.t0)) * (geo.w - geo.l - geo.r)
  const y = (v, d) => geo.t + (1 - (v - d.lo) / Math.max(1e-9, d.hi - d.lo)) * (geo.h - geo.t - geo.b)

  function domainFor(series, start) {
    let lo = Infinity, hi = -Infinity
    for (const p of series) { if (p[1] < lo) lo = p[1]; if (p[1] > hi) hi = p[1] }
    if (isNum(start)) { lo = Math.min(lo, start); hi = Math.max(hi, start) }
    const minSpan = (isNum(start) ? start : hi) * 0.004
    if (hi - lo < minSpan) { const m = (hi + lo) / 2; lo = m - minSpan / 2; hi = m + minSpan / 2 }
    const pad = (hi - lo) * 0.12
    return { lo: lo - pad, hi: hi + pad, t0: series[0][0], t1: series[series.length - 1][0], last: series[series.length - 1][1] }
  }

  function draw(d) {
    const pts = downsample(data.series, 700)
    const n = pts.length
    const lastY = y(d.last, d)
    const coords = pts.map((p, i) => [x(p[0], d), i === n - 1 ? lastY : y(p[1], d)])
    const dStr = coords.map((c, i) => `${i ? 'L' : 'M'}${c[0].toFixed(1)} ${c[1].toFixed(1)}`).join('')
    line.setAttribute('d', dStr)
    const bottom = geo.h - geo.b
    area.setAttribute('d', `${dStr}L${coords[n - 1][0].toFixed(1)} ${bottom}L${coords[0][0].toFixed(1)} ${bottom}Z`)
    area.setAttribute('fill', 'url(#eqFill)')
    const lx = coords[n - 1][0]
    live.setAttribute('cx', lx); live.setAttribute('cy', lastY)
    ring.setAttribute('cx', lx); ring.setAttribute('cy', lastY)

    let g = ''
    for (const v of niceTicks(d.lo, d.hi, 4)) {
      const yy = y(v, d)
      g += `<line x1="${geo.l}" x2="${geo.w - geo.r + 6}" y1="${yy}" y2="${yy}"/><text x="${geo.w - geo.r + 10}" y="${yy + 3.5}">${fmtCompact(v)}</text>`
    }
    for (let i = 0; i <= 3; i++) {
      const t = d.t0 + ((d.t1 - d.t0) * i) / 3
      g += `<text class="xl" x="${x(t, d)}" y="${geo.h - 6}" text-anchor="${i === 0 ? 'start' : i === 3 ? 'end' : 'middle'}">${fmtClock(t, false)}</text>`
    }
    grid.innerHTML = g

    if (isNum(data.start)) {
      const by = y(data.start, d)
      base.setAttribute('x1', geo.l); base.setAttribute('x2', geo.w - geo.r + 6)
      base.setAttribute('y1', by); base.setAttribute('y2', by)
      baseLabel.setAttribute('x', geo.l + 4); baseLabel.setAttribute('y', by - 5)
      baseLabel.textContent = 'Start'
      base.style.display = ''
    } else { base.style.display = 'none'; baseLabel.textContent = '' }

    let m = ''
    for (const mk of data.markers) {
      if (mk.t < d.t0 || mk.t > d.t1) continue
      let v = d.last
      for (let i = pts.length - 1; i >= 0; i--) if (pts[i][0] <= mk.t) { v = pts[i][1]; break }
      const xx = x(mk.t, d), yy = y(v, d)
      m += mk.win
        ? `<path class="mk win" d="M${xx} ${yy - 11}l5 8.5h-10z"><title>Winning trade</title></path>`
        : `<path class="mk loss" d="M${xx} ${yy + 11}l5 -8.5h-10z"><title>Losing trade</title></path>`
    }
    marks.innerHTML = m
    if (sel !== null) showSel(sel)
  }

  function layout() {
    geo.w = host.clientWidth
    geo.h = host.clientHeight
    svg.setAttribute('viewBox', `0 0 ${geo.w} ${geo.h}`)
    svg.setAttribute('width', geo.w)
    svg.setAttribute('height', geo.h)
  }

  function showSel(i) {
    const s = data.series
    if (!s.length) return
    sel = Math.max(0, Math.min(s.length - 1, i))
    const d = dom
    const p = s[sel]
    const cx = x(p[0], d), cy = y(p[1], d)
    cross.hidden = false
    cross.querySelector('line').setAttribute('x1', cx); cross.querySelector('line').setAttribute('x2', cx)
    cross.querySelector('line').setAttribute('y1', geo.t); cross.querySelector('line').setAttribute('y2', geo.h - geo.b)
    cross.querySelector('circle').setAttribute('cx', cx); cross.querySelector('circle').setAttribute('cy', cy)
    const pnl = isNum(data.start) ? p[1] / data.start - 1 : null
    tip.hidden = false
    tip.innerHTML = `<b>${fmtTmn(p[1])}</b><span>${pnl === null ? '' : fmtPct(pnl, 2, true) + ' vs start'}</span><span>${fmtClock(p[0])}</span>`
    const tw = tip.offsetWidth
    tip.style.left = `${Math.max(4, Math.min(geo.w - tw - 4, cx - tw / 2))}px`
    tip.style.top = `${Math.max(2, cy - 62)}px`
  }

  function clear() {
    sel = null
    cross.hidden = true
    tip.hidden = true
  }

  function indexAt(px) {
    const s = data.series
    const d = dom
    const t = d.t0 + ((px - geo.l) / Math.max(1, geo.w - geo.l - geo.r)) * (d.t1 - d.t0)
    let lo = 0, hi = s.length - 1
    while (lo < hi) { const mid = (lo + hi) >> 1; if (s[mid][0] < t) lo = mid + 1; else hi = mid }
    if (lo > 0 && Math.abs(s[lo - 1][0] - t) < Math.abs(s[lo][0] - t)) lo--
    return lo
  }

  host.addEventListener('pointermove', (e) => { if (dom) showSel(indexAt(e.clientX - host.getBoundingClientRect().left)) })
  host.addEventListener('pointerleave', clear)
  host.addEventListener('blur', clear)
  host.addEventListener('keydown', (e) => {
    if (!dom) return
    const s = data.series
    const cur = sel ?? s.length - 1
    const step = e.shiftKey ? 10 : 1
    if (e.key === 'ArrowLeft') showSel(cur - step)
    else if (e.key === 'ArrowRight') showSel(cur + step)
    else if (e.key === 'Home') showSel(0)
    else if (e.key === 'End') showSel(s.length - 1)
    else if (e.key === 'Escape') clear()
    else return
    e.preventDefault()
  })
  new ResizeObserver(() => { layout(); if (dom) draw(dom) }).observe(host)

  return {
    update(next) {
      data = next
      const s = data.series
      if (!s || s.length < 2) { host.classList.add('is-empty'); host.removeAttribute('aria-label'); return }
      host.classList.remove('is-empty')
      if (!geo.w) layout()
      const to = domainFor(s, data.start)
      const from = dom
      target = to
      stop()
      const last = s[s.length - 1][1]
      const first = s[0][1]
      host.setAttribute('aria-label', `Equity from ${fmtTmn(first)} to ${fmtTmn(last)}. Arrow keys inspect points.`)
      if (!from) { dom = to; draw(dom); return }
      stop = tween(0, 1, 500, (k) => {
        dom = { lo: lerp(from.lo, to.lo, k), hi: lerp(from.hi, to.hi, k), t0: lerp(from.t0, to.t0, k), t1: lerp(from.t1, to.t1, k), last: lerp(from.last, to.last, k) }
        draw(dom)
      })
    },
  }
}

export function sparkline(values, { w = 120, h = 32, fill = true } = {}) {
  const v = (values || []).filter(isNum)
  if (v.length < 2) return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true"><line class="spark-empty" x1="0" x2="${w}" y1="${h / 2}" y2="${h / 2}"/></svg>`
  const lo = Math.min(...v), hi = Math.max(...v)
  const span = hi - lo || 1
  const pts = v.map((n, i) => [(i / (v.length - 1)) * w, h - 3 - ((n - lo) / span) * (h - 6)])
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join('')
  const end = pts[pts.length - 1]
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">${fill ? `<path class="spark-area" d="${d}L${w} ${h}L0 ${h}Z"/>` : ''}<path class="spark-line" d="${d}"/><circle class="spark-dot" cx="${end[0]}" cy="${end[1]}" r="2.4"/></svg>`
}

const G = { cx: 60, cy: 60, r: 46 }
const pol = (deg, r = G.r) => [G.cx + r * Math.cos((deg * Math.PI) / 180), G.cy + r * Math.sin((deg * Math.PI) / 180)]
const ARC = (() => {
  const [sx, sy] = pol(135)
  const [ex, ey] = pol(45)
  return `M${sx.toFixed(2)} ${sy.toFixed(2)}A${G.r} ${G.r} 0 1 1 ${ex.toFixed(2)} ${ey.toFixed(2)}`
})()

export function createGauge(host, { title, hint }) {
  host.classList.add('gauge')
  host.innerHTML = `<svg viewBox="0 0 120 112" aria-hidden="true"><path class="g-track" d="${ARC}" pathLength="100"/><g class="g-ticks"></g><path class="g-value" d="${ARC}" pathLength="100" stroke-dasharray="0 100"/></svg>
    <div class="g-center"><span class="g-val">\u2013</span><span class="g-sub"></span></div>
    <div class="g-foot"><span class="g-title">${esc(title)}</span><span class="g-status"></span></div>`
  const val = host.querySelector('.g-value')
  const ticks = host.querySelector('.g-ticks')
  const label = host.querySelector('.g-val')
  const sub = host.querySelector('.g-sub')
  const status = host.querySelector('.g-status')
  let lastTicks = ''
  return {
    update({ fraction, center, subtext, toneName, statusText, statusGlyph, tickAt = [], aria }) {
      const f = isNum(fraction) ? Math.max(0, Math.min(1, fraction)) : 0
      val.setAttribute('stroke-dasharray', `${(f * 100).toFixed(2)} 100`)
      val.style.opacity = f <= 0.002 ? '0' : '1'
      host.dataset.tone = toneName
      label.textContent = center
      sub.textContent = subtext
      status.innerHTML = `<span aria-hidden="true">${statusGlyph}</span> ${esc(statusText)}`
      const key = tickAt.join(',')
      if (key !== lastTicks) {
        lastTicks = key
        ticks.innerHTML = tickAt
          .map((at) => {
            const deg = 135 + 270 * at
            const [a, b] = pol(deg, G.r - 7)
            const [c, d] = pol(deg, G.r + 7)
            return `<line x1="${a.toFixed(1)}" y1="${b.toFixed(1)}" x2="${c.toFixed(1)}" y2="${d.toFixed(1)}"/>`
          })
          .join('')
      }
      host.setAttribute('role', 'img')
      host.setAttribute('aria-label', aria || `${title}: ${center}, ${statusText}`)
      host.title = hint || ''
    },
  }
}

export function ladder(p) {
  const W = 320, H = 82, pad = 18, track = 32
  const vals = [p.stop, p.entry, p.tp1, p.tp2, p.mark].filter(isNum)
  const lo = Math.min(...vals), hi = Math.max(...vals)
  const span = hi - lo || 1
  const x = (v) => pad + ((v - lo) / span) * (W - pad * 2)
  const band = (a, b, cls) => `<rect class="${cls}" x="${Math.min(x(a), x(b))}" y="${track - 5}" width="${Math.abs(x(b) - x(a))}" height="10" rx="2"/>`
  let s = `<svg class="ladder" viewBox="0 0 ${W} ${H}" role="img" aria-label="Price ladder: stop ${p.stop}, entry ${p.entry}, target 1 ${p.tp1}${isNum(p.mark) ? ', now ' + p.mark : ''}">`
  s += band(p.stop, p.entry, 'lb-risk') + band(p.entry, isNum(p.tp2) ? p.tp2 : p.tp1, 'lb-gain')
  const ticks = [[p.stop, 'Stop', 'stop'], [p.entry, 'Entry', 'entry'], [p.tp1, 'TP1', 'tp']]
  if (isNum(p.tp2)) ticks.push([p.tp2, 'TP2', 'tp'])
  ticks.sort((a, b) => a[0] - b[0])
  let prevX = -100, row = 0
  for (const [v, name, cls] of ticks) {
    row = x(v) - prevX < 38 ? row + 1 : 0
    prevX = x(v)
    s += `<line class="lt ${cls}" x1="${x(v)}" x2="${x(v)}" y1="${track - 11}" y2="${track + 11}"/><text class="ll" x="${x(v)}" y="${track + 24 + (row % 2) * 12}" text-anchor="middle">${name}</text>`
  }
  if (isNum(p.mark)) {
    const mx = x(p.mark)
    s += `<path class="lm" d="M${mx} ${track - 9}l-5 -9h10z"/><text class="ll now" x="${mx}" y="${track - 22}" text-anchor="middle">Now</text>`
  }
  return s + '</svg>'
}
