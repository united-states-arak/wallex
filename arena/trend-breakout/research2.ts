// Event study, train days 0:80 only. Forward return after breakout events, net of 1.0% round-trip cost.
import { load, START, SYMS } from './research'

const DAY = 86400
const d = load(START, START + 80 * DAY)
const COST = 0.01
const T = d.BNBTMN!.length

// equal-weight basket index of hourly returns
const idx: number[] = [1]
for (let i = 1; i < T; i++) {
  let r = 0
  for (const s of SYMS) r += d[s]![i]!.c / d[s]![i - 1]!.c - 1
  idx.push(idx[i - 1]! * (1 + r / SYMS.length))
}

function ema(a: number[], n: number) {
  const k = 2 / (n + 1)
  const o: number[] = [a[0]!]
  for (let i = 1; i < a.length; i++) o.push(o[i - 1]! + k * (a[i]! - o[i - 1]!))
  return o
}
const atr = (s: string, n = 14) => {
  const h = d[s]!
  const o: number[] = [h[0]!.h - h[0]!.l]
  for (let i = 1; i < h.length; i++) {
    const tr = Math.max(h[i]!.h - h[i]!.l, Math.abs(h[i]!.h - h[i - 1]!.c), Math.abs(h[i]!.l - h[i - 1]!.c))
    o.push((o[i - 1]! * (n - 1) + tr) / n)
  }
  return o
}
const idxEma = (n: number) => ema(idx, n)

interface Ev { s: string; i: number }
function events(N: number, o: { emaN?: number; vol?: number; mkt?: number; comp?: number }) {
  const ev: Ev[] = []
  const ie = idxEma(o.mkt ?? 48)
  for (const s of SYMS) {
    const h = d[s]!
    const e = ema(h.map((b) => b.c), o.emaN ?? 96)
    const a = atr(s)
    let last = -999
    for (let i = 250; i < h.length - 1; i++) {
      let hi = 0
      for (let j = i - N; j < i; j++) hi = Math.max(hi, h[j]!.h)
      if (!(h[i]!.c > hi)) continue
      if (i - last < 6) continue
      if (o.emaN && !(h[i]!.c > e[i]! && e[i]! > e[i - 1]!)) continue
      if (o.vol) {
        let v = 0
        for (let j = i - 24; j < i; j++) v += h[j]!.v
        if (!(h[i]!.v > (o.vol * v) / 24)) continue
      }
      if (o.mkt && !(idx[i]! > ie[i]!)) continue
      if (o.comp) {
        // compression: ATR now relative to ATR 5 days ago-average
        let m = 0
        for (let j = i - 120; j < i; j++) m += a[j]!
        if (!(a[i - 1]! < (o.comp * m) / 120)) continue
      }
      last = i
      ev.push({ s, i })
    }
  }
  return ev
}

function fwd(ev: Ev[], H: number) {
  const r = ev.filter((x) => x.i + H < T).map((x) => d[x.s]![x.i + H]!.c / d[x.s]![x.i]!.c - 1 - COST)
  const n = r.length
  const m = r.reduce((a, b) => a + b, 0) / Math.max(1, n)
  const w = r.filter((x) => x > 0).length / Math.max(1, n)
  return `H${H}: ${(m * 100).toFixed(2).padStart(6)}% w${(w * 100).toFixed(0)}`
}
// trailing sim: stop = entry - K*atr, trail highest close - M*atr (hourly), exits at stop price - checked at hourly lows
function trail(ev: Ev[], K: number, M: number, maxH = 168) {
  const r: number[] = []
  const cache: Record<string, number[]> = {}
  for (const x of ev) {
    const h = d[x.s]!
    const a = (cache[x.s] ??= atr(x.s))
    const entry = h[x.i]!.c
    const A = a[x.i]!
    let stop = entry - K * A
    let hi = entry
    let exit = 0
    for (let j = x.i + 1; j < h.length && j <= x.i + maxH; j++) {
      if (h[j]!.l <= stop) {
        exit = Math.min(stop, h[j]!.o)
        break
      }
      hi = Math.max(hi, h[j]!.h)
      stop = Math.max(stop, hi - M * A)
      exit = h[j]!.c
    }
    if (exit) r.push(exit / entry - 1 - COST)
  }
  const n = r.length
  const m = r.reduce((p, q) => p + q, 0) / Math.max(1, n)
  const w = r.filter((q) => q > 0).length / Math.max(1, n)
  return `trail K${K} M${M}: ${(m * 100).toFixed(2).padStart(6)}% w${(w * 100).toFixed(0)}`
}

const variants: Array<[string, number, Parameters<typeof events>[1]]> = [
  ['N120', 120, {}],
  ['N240', 240, {}],
  ['N120 mkt168', 120, { mkt: 168 }],
  ['N240 mkt168', 240, { mkt: 168 }],
  ['N72 mkt168', 72, { mkt: 168 }],
  ['N48 mkt336', 48, { mkt: 336 }],
  ['N120 mkt336', 120, { mkt: 336 }],
]
for (const [name, N, o] of variants) {
  const ev = events(N, o)
  const half = (a: number, b: number) => ev.filter((x) => x.i >= a && x.i < b)
  console.log(name.padEnd(18), String(ev.length).padStart(4), [24, 72, 168].map((H) => fwd(ev, H)).join(' | '), '|', trail(ev, 3, 5), '| halves', trail(half(0, 960), 3, 5), '/', trail(half(960, 2000), 3, 5))
}
