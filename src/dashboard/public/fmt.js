const MINUS = '\u2212'
const int = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 })

export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

export const isNum = (x) => typeof x === 'number' && Number.isFinite(x)

export function fmtInt(n) {
  if (!isNum(n)) return '\u2013'
  const s = int.format(Math.abs(Math.round(n)))
  return n < 0 && Math.round(n) !== 0 ? MINUS + s : s
}

export const fmtTmn = (n) => (isNum(n) ? `${fmtInt(n)} TMN` : '\u2013')

export function fmtSignedTmn(n) {
  if (!isNum(n)) return '\u2013'
  const r = Math.round(n)
  return `${r > 0 ? '+' : r < 0 ? MINUS : ''}${int.format(Math.abs(r))} TMN`
}

export function fmtCompact(n) {
  if (!isNum(n)) return '\u2013'
  const a = Math.abs(n)
  const sign = n < 0 ? MINUS : ''
  if (a >= 1e9) return `${sign}${(a / 1e9).toFixed(2)}B`
  if (a >= 1e6) return `${sign}${(a / 1e6).toFixed(a >= 1e7 ? 1 : 2)}M`
  if (a >= 1e3) return `${sign}${(a / 1e3).toFixed(a >= 1e4 ? 0 : 1)}k`
  return `${sign}${a.toFixed(0)}`
}

export function fmtPct(f, digits = 2, signed = false) {
  if (!isNum(f)) return '\u2013'
  const v = f * 100
  const s = Math.abs(v).toFixed(digits)
  const zero = Number(s) === 0
  const sign = zero ? '' : v < 0 ? MINUS : signed ? '+' : ''
  return `${sign}${s}%`
}

export function fmtPrice(p) {
  if (!isNum(p)) return '\u2013'
  const a = Math.abs(p)
  const digits = a >= 1000 ? 0 : a >= 100 ? 1 : a >= 10 ? 2 : a >= 1 ? 3 : a >= 0.1 ? 4 : a >= 0.01 ? 5 : 6
  return p.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: digits })
}

export function fmtQty(q) {
  if (!isNum(q)) return '\u2013'
  return q.toLocaleString('en-US', { maximumFractionDigits: q >= 100 ? 0 : 3 })
}

export function fmtR(r) {
  if (!isNum(r)) return '\u2013'
  const s = Math.abs(r).toFixed(2)
  return `${r < 0 ? MINUS : r > 0 ? '+' : ''}${s}R`
}

export function fmtDuration(sec) {
  if (!isNum(sec)) return '\u2013'
  const s = Math.max(0, Math.floor(sec))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const r = s % 60
  const p = (x) => String(x).padStart(2, '0')
  return h > 0 ? `${h}:${p(m)}:${p(r)}` : `${p(m)}:${p(r)}`
}

export function fmtAge(sec) {
  if (!isNum(sec)) return '\u2013'
  if (sec < 90) return `${Math.round(sec)}s`
  if (sec < 5400) return `${Math.round(sec / 60)}m`
  return `${(sec / 3600).toFixed(1)}h`
}

export function fmtClock(ms, withSeconds = true) {
  if (!isNum(ms)) return '\u2013'
  const d = new Date(ms)
  const p = (x) => String(x).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}${withSeconds ? ':' + p(d.getSeconds()) : ''}`
}

export function fmtDateTime(ms) {
  if (!isNum(ms)) return '\u2013'
  const d = new Date(ms)
  return `${d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })} ${fmtClock(ms, false)}`
}

export const tone = (n, eps = 1e-12) => (!isNum(n) || Math.abs(n) < eps ? 'flat' : n > 0 ? 'up' : 'down')
export const glyph = (n, eps = 1e-12) => (!isNum(n) || Math.abs(n) < eps ? '\u25AC' : n > 0 ? '\u25B2' : '\u25BC')
