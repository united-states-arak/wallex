import type { Candle } from '../types'
import { defaultDetectParams, type DetectParams } from './types'

export interface Swing {
  i: number
  t: number
  price: number
}

export interface Fvg {
  m: number
  t: number
  low: number
  high: number
  ce: number
  size: number
}

export interface Level {
  price: number
  kind: string
  rank: number
  known: number
}

export interface Displacement {
  start: number
  end: number
  atrMult: number
  fvgs: Fvg[]
}

export interface Range {
  low: number
  high: number
}

export const ATR_FLOOR_PCT = defaultDetectParams.atrFloorPct
const HOUR = 3600
const DAY = 86_400
const BLOCK = 28_800

export function atrSeries(bars: Candle[], period = defaultDetectParams.atrPeriod): number[] {
  const out = new Array<number>(bars.length)
  const trs = new Array<number>(bars.length)
  let sum = 0
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i]!
    const pc = i > 0 ? bars[i - 1]!.c : b.o
    const tr = Math.max(b.h - b.l, Math.abs(b.h - pc), Math.abs(b.l - pc))
    trs[i] = tr
    sum += tr
    if (i >= period) sum -= trs[i - period]!
    out[i] = sum / Math.min(i + 1, period)
  }
  return out
}

export function atr(bars: Candle[], period = defaultDetectParams.atrPeriod): number {
  const s = atrSeries(bars, period)
  return s.length ? s[s.length - 1]! : 0
}

export const atrFloor = (a: number, price: number, floorPct = ATR_FLOOR_PCT) => Math.max(a, price * floorPct)

// A swing at index i is only returned when n closed bars follow it. Left side is strict, right side is non-strict so flat plateaus flag one bar.
export function swings(bars: Candle[], n: number): { highs: Swing[]; lows: Swing[] } {
  const highs: Swing[] = []
  const lows: Swing[] = []
  for (let i = n; i < bars.length - n; i++) {
    const b = bars[i]!
    let hi = true
    let lo = true
    for (let k = 1; k <= n; k++) {
      const l = bars[i - k]!
      const r = bars[i + k]!
      if (!(b.h > l.h && b.h >= r.h)) hi = false
      if (!(b.l < l.l && b.l <= r.l)) lo = false
    }
    if (hi) highs.push({ i, t: b.t, price: b.h })
    if (lo) lows.push({ i, t: b.t, price: b.l })
  }
  return { highs, lows }
}

// Bullish imbalances only. `from` and `to` bound the middle candle index (inclusive).
export function findFvgs(bars: Candle[], minFvgAtr: number, atrs: number[], from = 1, to = bars.length - 2, floorPct = ATR_FLOOR_PCT): Fvg[] {
  const out: Fvg[] = []
  for (let m = Math.max(1, from); m <= Math.min(to, bars.length - 2); m++) {
    const c1 = bars[m - 1]!
    const c3 = bars[m + 1]!
    if (!(c3.l > c1.h)) continue
    const size = c3.l - c1.h
    if (size < minFvgAtr * atrFloor(atrs[m - 1]!, c1.h, floorPct)) continue
    out.push({ m, t: bars[m]!.t, low: c1.h, high: c3.l, ce: (c1.h + c3.l) / 2, size })
  }
  return out
}

export function strongBody(bars: Candle[], start: number, end: number, dir: 1 | -1, atrPrev: number, mult: number, bodyRatio = defaultDetectParams.bodyRatio): number {
  let hi = -Infinity
  let lo = Infinity
  for (let k = start; k <= end; k++) {
    const b = bars[k]!
    if (dir === 1 ? !(b.c > b.o) : !(b.c < b.o)) return 0
    hi = Math.max(hi, b.h)
    lo = Math.min(lo, b.l)
  }
  const body = Math.abs(bars[end]!.c - bars[start]!.o)
  const range = hi - lo
  if (!(range > 0) || body < bodyRatio * range) return 0
  const x = body / atrPrev
  return x >= mult ? x : 0
}

// Bullish displacement ending at bar d: one or two same-direction candles, body >= mult * ATR, body >= bodyRatio of range, leaving an FVG.
export function displacement(bars: Candle[], d: number, atrs: number[], p: Pick<DetectParams, 'displacementAtr' | 'minFvgAtr'> & Partial<Pick<DetectParams, 'atrFloorPct' | 'bodyRatio'>>): Displacement | null {
  for (const start of [d, d - 1]) {
    if (start < 1) continue
    const atrPrev = atrFloor(atrs[start - 1]!, bars[start]!.o, p.atrFloorPct)
    const atrMult = strongBody(bars, start, d, 1, atrPrev, p.displacementAtr, p.bodyRatio)
    if (atrMult === 0) continue
    const fvgs = findFvgs(bars, p.minFvgAtr, atrs, start, d, p.atrFloorPct)
    if (fvgs.length) return { start, end: d, atrMult, fvgs }
  }
  return null
}

export function isBearDisplacement(bars: Candle[], k: number, atrs: number[], p: Pick<DetectParams, 'displacementAtr'> & Partial<Pick<DetectParams, 'atrFloorPct' | 'bodyRatio'>>): boolean {
  if (k < 1) return false
  const atrPrev = atrFloor(atrs[k - 1]!, bars[k]!.o, p.atrFloorPct)
  return strongBody(bars, k, k, -1, atrPrev, p.displacementAtr, p.bodyRatio) > 0
}

export function isSweep(bar: Candle, level: number, minDepthPct: number): boolean {
  return bar.l <= level * (1 - minDepthPct) && bar.c > level
}

function swingLevels(bars: Candle[], sw: Swing[], tfSec: number, n: number, kind: string, rank: number): Level[] {
  return sw.map((s) => ({ price: s.price, kind, rank, known: bars[s.i + n]!.t + tfSec }))
}

type EqlParams = Partial<Pick<DetectParams, 'eqlTolPct' | 'eqlTolAtr' | 'atrFloorPct'>>

function equalLevels(bars: Candle[], sw: Swing[], atrs: number[], tfSec: number, n: number, side: 'low' | 'high', p: EqlParams, max = 40): Level[] {
  const out: Level[] = []
  const list = sw.slice(-max)
  for (let a = 0; a < list.length; a++) {
    for (let b = a + 1; b < list.length; b++) {
      const sa = list[a]!
      const sb = list[b]!
      const tol = Math.max(sb.price * (p.eqlTolPct ?? defaultDetectParams.eqlTolPct), (p.eqlTolAtr ?? defaultDetectParams.eqlTolAtr) * atrFloor(atrs[sb.i]!, sb.price, p.atrFloorPct))
      if (Math.abs(sa.price - sb.price) > tol) continue
      out.push({
        price: side === 'low' ? Math.min(sa.price, sb.price) : Math.max(sa.price, sb.price),
        kind: side === 'low' ? 'eql' : 'eqh',
        rank: 2,
        known: bars[sb.i + n]!.t + tfSec,
      })
    }
  }
  return out
}

function blockLevels(b1h: Candle[], size: number, kind: string, rank: number, side: 'low' | 'high'): Level[] {
  const out: Level[] = []
  if (!b1h.length) return out
  const first = b1h[0]!.t
  const lastEnd = b1h[b1h.length - 1]!.t + HOUR
  let cur = -1
  let firstT = 0
  let ext = 0
  const flush = () => {
    if (cur < 0) return
    const end = cur + size
    if (end > lastEnd) return
    if (!(first < cur || firstT <= cur + HOUR)) return
    out.push({ price: ext, kind, rank, known: end })
  }
  for (const b of b1h) {
    const bucket = Math.floor(b.t / size) * size
    if (bucket !== cur) {
      flush()
      cur = bucket
      firstT = b.t
      ext = side === 'low' ? b.l : b.h
    } else {
      ext = side === 'low' ? Math.min(ext, b.l) : Math.max(ext, b.h)
    }
  }
  flush()
  return out
}

// side 'low' = sell-side liquidity below price (sweep candidates). side 'high' = buy-side pools above price (targets).
export function liquidityLevels(
  side: 'low' | 'high',
  b15: Candle[],
  b1h: Candle[],
  p: Pick<DetectParams, 'swingN'> & Partial<Pick<DetectParams, 'shortSwingLevels' | 'atrPeriod' | 'eqlTolPct' | 'eqlTolAtr' | 'atrFloorPct'>>,
  b5?: Candle[],
): Level[] {
  const n15 = side === 'low' ? Math.max(2, p.swingN) : p.swingN
  const key = side === 'low' ? 'lows' : 'highs'
  const s15 = swings(b15, n15)[key]
  const s1h = swings(b1h, p.swingN)[key]
  const e15 = swings(b15, p.swingN)[key]
  const a15 = atrSeries(b15, p.atrPeriod)
  const a1h = atrSeries(b1h, p.atrPeriod)
  const short: Level[] = []
  if (p.shortSwingLevels) {
    if (n15 !== p.swingN) short.push(...swingLevels(b15, e15, 900, p.swingN, 'stl15m', 0))
    if (b5) short.push(...swingLevels(b5, swings(b5, 2)[key], 300, 2, 'stl5m', 0))
  }
  return [
    ...short,
    ...swingLevels(b15, s15, 900, n15, 'swing15m', 1),
    ...swingLevels(b1h, s1h, HOUR, p.swingN, 'swing1h', 1),
    ...equalLevels(b15, e15, a15, 900, p.swingN, side, p),
    ...equalLevels(b1h, s1h, a1h, HOUR, p.swingN, side, p),
    ...blockLevels(b1h, DAY, side === 'low' ? 'pdl' : 'pdh', 2, side),
    ...blockLevels(b1h, BLOCK, side === 'low' ? 'asia8h' : 'block8h', 1, side),
  ]
}

export function oteZone(range: Range, p: Pick<DetectParams, 'oteLow' | 'oteHigh'>): Range {
  const r = range.high - range.low
  return { low: range.high - p.oteHigh * r, high: range.high - p.oteLow * r }
}

// 0 = range low, 1 = range high. Longs need < 0.5.
export function rangePosition(range: Range, price: number): number {
  const r = range.high - range.low
  return r > 0 ? (price - range.low) / r : 1
}

export const isDiscount = (range: Range, price: number) => rangePosition(range, price) < 0.5

export type EntryKind = 'ce' | 'overlap' | 'fvg'

export function chooseEntry(fvg: Pick<Fvg, 'low' | 'high' | 'ce'>, ote: Range): { entry: number; kind: EntryKind } {
  if (fvg.ce >= ote.low && fvg.ce <= ote.high) return { entry: fvg.ce, kind: 'ce' }
  const lo = Math.max(fvg.low, ote.low)
  const hi = Math.min(fvg.high, ote.high)
  if (lo <= hi) return { entry: (lo + hi) / 2, kind: 'overlap' }
  return { entry: fvg.ce, kind: 'fvg' }
}
