import { aggregate } from '../data/candles'
import type { Candle } from '../types'
import {
  atrFloor,
  atrSeries,
  chooseEntry,
  displacement,
  isBearDisplacement,
  isDiscount,
  isSweep,
  liquidityLevels,
  oteZone,
  rangePosition,
  swings,
  type Displacement,
  type EntryKind,
  type Level,
  type Range,
  type Swing,
} from './primitives'
import { getSettings } from '../settings'
import type { DetectParams, FindSetup, SetupCandidate, SetupModel } from './types'

export * from './primitives'

const tfCfg = (p: DetectParams, tf: 1 | 5 | 15): { window: number; legMax: number } =>
  tf === 1 ? { window: p.window1m, legMax: p.legMax1m } : tf === 5 ? { window: p.window5m, legMax: p.legMax5m } : { window: p.window15m, legMax: p.legMax15m }

interface Known {
  price: number
  known: number
}

interface Ctx {
  symbol: string
  p: DetectParams
  src: Candle[]
  nowSec: number
  close: number
  sufMax: Float64Array
  levels: Level[]
  pools: Level[]
  bullish: boolean
  sw15: { highs: Known[]; lows: Known[] }
}

interface Zone {
  low: number
  high: number
  ce: number
  t: number
  label: string
}

interface Plan {
  model: SetupModel
  tfMin: number
  b: Candle[]
  d: number
  atrEff: number
  dispAtr: number
  levelRank: number
  sweep: { level: number; kind: string; t: number }
  mss: { level: number; t: number }
  head: string
}

interface Prep {
  zone: Zone
  legEnd: number
  range: Range
  entry: number
  kind: EntryKind
  stopRef: number
}

function tfBars(src: Candle[], min: number, nowSec: number, window: number): Candle[] {
  if (min === 1) return src.length > window ? src.slice(-window) : src
  const out = aggregate(src, min, nowSec)
  if (out.length && src[0]!.t % (min * 60) !== 0) out.shift()
  return out.length > window ? out.slice(-window) : out
}

function lowerBound(arr: Candle[], t: number): number {
  let lo = 0
  let hi = arr.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (arr[mid]!.t < t) lo = mid + 1
    else hi = mid
  }
  return lo
}

function sweptSince(ctx: Ctx, price: number, known: number): boolean {
  const i = lowerBound(ctx.src, known)
  return i < ctx.src.length && ctx.sufMax[i]! >= price
}

function htfBias(b1h: Candle[], p: DetectParams): 'breakdown' | 'bullish' | 'neutral' {
  if (b1h.length < 3) return 'neutral'
  const k = b1h.length - 1
  const atrs = atrSeries(b1h, p.atrPeriod)
  const lows = swings(b1h, p.swingN).lows.filter((s) => s.i + p.swingN <= k - 1)
  const prev = lows[lows.length - 1]
  if (prev && b1h[k]!.c < prev.price && isBearDisplacement(b1h, k, atrs, p)) return 'breakdown'
  const m = Math.min(p.htfBiasBars, b1h.length)
  let sum = 0
  for (let i = b1h.length - m; i < b1h.length; i++) sum += b1h[i]!.c
  return b1h[k]!.c > sum / m ? 'bullish' : 'neutral'
}

// Rising structure on the 15m as known at `atTime`: the last two confirmed swing highs and the last two confirmed swing lows both rise.
function trendUp(ctx: Ctx, atTime: number): boolean {
  const rising = (list: Known[]) => {
    let hi = -1
    let lo = -1
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i]!.known > atTime) continue
      if (hi < 0) hi = i
      else {
        lo = i
        break
      }
    }
    return lo >= 0 && list[hi]!.price > list[lo]!.price
  }
  return rising(ctx.sw15.highs) && rising(ctx.sw15.lows)
}

function sweptLevel(levels: Level[], b: Candle[], s: number, depth: number): Level | null {
  const bar = b[s]!
  let best: Level | null = null
  for (const lv of levels) {
    if (lv.known > bar.t || !isSweep(bar, lv.price, depth)) continue
    if (best && (lv.rank < best.rank || (lv.rank === best.rank && lv.price >= best.price))) continue
    let fresh = true
    for (let k = s - 1; k >= 0 && b[k]!.t >= lv.known; k--) {
      if (b[k]!.l < lv.price) {
        fresh = false
        break
      }
    }
    if (fresh) best = lv
  }
  return best
}

function lastSwingBefore(list: Swing[], maxIdx: number): Swing | null {
  for (let i = list.length - 1; i >= 0; i--) if (list[i]!.i <= maxIdx) return list[i]!
  return null
}

const fmt = (x: number) => String(Number(x.toPrecision(5)))
const kindRank: Record<EntryKind, number> = { ce: 0, overlap: 1, fvg: 2 }
const byKind = (preps: Prep[]) => preps.sort((x, y) => kindRank[x.kind] - kindRank[y.kind])

function tryZone(ctx: Ctx, plan: Plan, c: Prep): SetupCandidate | null {
  const { p, src } = ctx
  const { b, d, tfMin } = plan
  const { zone, legEnd, range, entry, kind } = c
  if (!isDiscount(range, entry) || !(entry < ctx.close)) return null

  const postT = b[legEnd]!.t + tfMin * 60
  let minLow = Infinity
  let minClose = Infinity
  for (let i = lowerBound(src, postT); i < src.length; i++) {
    minLow = Math.min(minLow, src[i]!.l)
    minClose = Math.min(minClose, src[i]!.c)
  }
  const stopBase = plan.model === 'continuation' && minLow < entry ? Math.min(c.stopRef, minLow) : c.stopRef
  const stop = stopBase - p.stopBufferAtr * plan.atrEff
  const risk = entry - stop
  const stopPct = risk / entry
  if (!(stopPct >= p.minStopPct && stopPct <= p.maxStopPct)) return null
  if (minLow <= stop) return null
  if (minLow < entry && (p.freshnessUseClose ? minClose : minLow) <= zone.low) return null

  const pools = ctx.pools.filter((x) => x.price > entry)
  pools.push({ price: range.high, kind: 'range', rank: 0, known: postT })
  pools.sort((x, y) => x.price - y.price)
  const minTp = entry + p.minGrossRr * risk
  let tp1: Level | null = null
  let tp2: Level | null = null
  for (const pool of pools) {
    if (sweptSince(ctx, pool.price, pool.known)) continue
    if (!tp1) {
      if (pool.price >= minTp) tp1 = pool
    } else if (pool.price > tp1.price * 1.002) {
      tp2 = pool
      break
    }
  }
  if (!tp1) return null
  const rr = (tp1.price - entry) / risk

  const hour = Math.floor((b[d]!.t % 86_400) / 3600)
  const scoreParts: Record<string, number> = {
    bias: ctx.bullish ? 1 : 0,
    level: plan.levelRank,
    session: hour >= p.sessionStartHour && hour < p.sessionEndHour ? 1 : 0,
    displacement: plan.dispAtr >= p.strongDisplacementAtr ? 1 : 0,
    fvgOte: kind === 'fvg' ? 0 : 2,
    deepDiscount: rangePosition(range, entry) <= p.deepDiscountPos ? 1 : 0,
    rr3: rr >= p.strongRr ? 1 : 0,
  }
  const score = Object.values(scoreParts).reduce((a, x) => a + x, 0)
  if (score < p.minScore) return null

  const detectedAt = src[src.length - 1]!.t
  return {
    symbol: ctx.symbol,
    model: plan.model,
    detectedAt,
    entry,
    stop,
    tp1: tp1.price,
    ...(tp2 ? { tp2: tp2.price } : {}),
    score,
    scoreParts,
    sweep: { ...plan.sweep, extreme: range.low },
    mss: { level: plan.mss.level, t: plan.mss.t, displacementAtr: plan.dispAtr },
    fvg: { low: zone.low, high: zone.high, ce: zone.ce, t: zone.t },
    dealingRange: range,
    expiresAt: detectedAt + p.setupMaxAgeBars1m * 60,
    invalidateBelow: stop,
    rationale:
      `${plan.head}, ${zone.label} ${fmt(zone.low)}-${fmt(zone.high)} (${kind === 'fvg' ? 'no OTE overlap' : 'in OTE'}), ` +
      `buy ${fmt(entry)} stop ${fmt(stop)} target ${fmt(tp1.price)} (${tp1.kind}) RR ${rr.toFixed(1)}`,
  }
}

function sweepCandidate(ctx: Ctx, b: Candle[], atrs: number[], tfMin: number, s: number, lvl: Level, d: number, disp: Displacement, ref: Swing): SetupCandidate | null {
  const { p } = ctx
  const preps: Prep[] = []
  for (const fvg of [...disp.fvgs].sort((x, y) => y.size - x.size || y.m - x.m)) {
    const legEnd = Math.max(d, fvg.m + 1)
    let low = Infinity
    let high = -Infinity
    for (let k = s; k <= legEnd; k++) {
      low = Math.min(low, b[k]!.l)
      high = Math.max(high, b[k]!.h)
    }
    if (!(high > low)) continue
    const range = { low, high }
    const { entry, kind } = chooseEntry(fvg, oteZone(range, p))
    preps.push({ zone: { ...fvg, label: 'FVG' }, legEnd, range, entry, kind, stopRef: low })
  }
  const plan: Plan = {
    model: 'sweep',
    tfMin,
    b,
    d,
    atrEff: atrFloor(atrs[d]!, b[d]!.c, p.atrFloorPct),
    dispAtr: disp.atrMult,
    levelRank: lvl.rank,
    sweep: { level: lvl.price, kind: lvl.kind, t: b[s]!.t },
    mss: { level: ref.price, t: b[d]!.t },
    head: '',
  }
  for (const c of byKind(preps)) {
    plan.head = `${tfMin}m sell-side sweep of ${lvl.kind} ${fmt(lvl.price)} (low ${fmt(c.range.low)}), MSS close above ${fmt(ref.price)} with ${disp.atrMult.toFixed(1)} ATR displacement`
    const cand = tryZone(ctx, plan, c)
    if (cand) return cand
  }
  return null
}

function continuationCandidate(
  ctx: Ctx,
  b: Candle[],
  atrs: number[],
  tfMin: number,
  d: number,
  disp: Displacement,
  ref: Swing,
  sl: Swing,
): SetupCandidate | null {
  const { p } = ctx
  const preps: Prep[] = []
  const ob = (() => {
    for (let k = disp.start - 1; k >= Math.max(0, disp.start - 3, sl.i); k--) if (b[k]!.c < b[k]!.o) return b[k]!
    return null
  })()
  for (const fvg of [...disp.fvgs].sort((x, y) => y.size - x.size || y.m - x.m)) {
    const legEnd = Math.max(d, fvg.m + 1)
    let low = Infinity
    let high = -Infinity
    for (let k = sl.i; k <= legEnd; k++) {
      low = Math.min(low, b[k]!.l)
      high = Math.max(high, b[k]!.h)
    }
    if (!(high > low)) continue
    const range = { low, high }
    const { entry, kind } = chooseEntry(fvg, oteZone(range, p))
    preps.push({ zone: { ...fvg, label: 'FVG' }, legEnd, range, entry, kind, stopRef: b[fvg.m - 1]!.l })
    if (ob) {
      const zone = { low: ob.c, high: ob.o, ce: (ob.o + ob.c) / 2, t: ob.t, label: 'order block' }
      const o = chooseEntry(zone, oteZone(range, p))
      preps.push({ zone, legEnd, range, entry: o.entry, kind: o.kind, stopRef: ob.l })
    }
  }
  const plan: Plan = {
    model: 'continuation',
    tfMin,
    b,
    d,
    atrEff: atrFloor(atrs[d]!, b[d]!.c, p.atrFloorPct),
    dispAtr: disp.atrMult,
    levelRank: 0,
    sweep: { level: sl.price, kind: 'impulse-low', t: b[sl.i]!.t },
    mss: { level: ref.price, t: b[d]!.t },
    head: `${tfMin}m uptrend BOS: close above ${fmt(ref.price)} with ${disp.atrMult.toFixed(1)} ATR displacement from low ${fmt(sl.price)}`,
  }
  for (const c of byKind(preps)) {
    const cand = tryZone(ctx, plan, c)
    if (cand) return cand
  }
  return null
}

const better = (cand: SetupCandidate | null, best: SetupCandidate | null) =>
  cand && (!best || cand.score > best.score || (cand.score === best.score && cand.mss.t > best.mss.t))

function scanTf(ctx: Ctx, b: Candle[], tfMin: 1 | 5 | 15): SetupCandidate | null {
  const { p } = ctx
  const n = b.length
  if (n < 30) return null
  const { legMax } = tfCfg(p, tfMin)
  const tfSec = tfMin * 60
  const maxAge = p.setupMaxAgeBars1m * 60
  let f = n - 1
  while (f > 0 && ctx.nowSec - (b[f - 1]!.t + tfSec) <= maxAge) f--
  const atrs = atrSeries(b, p.atrPeriod)
  const sw = swings(b, p.swingN)
  let best: SetupCandidate | null = null

  if (p.models.includes('sweep')) {
    for (let s = Math.max(1, f - legMax); s < n; s++) {
      const lvl = sweptLevel(ctx.levels, b, s, p.minSweepDepthPct)
      if (!lvl) continue
      for (let d = s; d <= Math.min(s + legMax, n - 1); d++) {
        if (d > s && b[d]!.c <= lvl.price) break
        const ref = lastSwingBefore(sw.highs, d - 1 - p.swingN)
        if (!ref || ref.i < s - p.mssRefBack || !(b[d]!.c > ref.price)) continue
        const disp = displacement(b, d, atrs, p)
        if (!disp) continue
        if (d >= f) {
          const cand = sweepCandidate(ctx, b, atrs, tfMin, s, lvl, d, disp, ref)
          if (better(cand, best)) best = cand
        }
        break
      }
    }
  }

  if (p.models.includes('continuation')) {
    for (let d = Math.max(f, n - 1 - p.continuationMaxPullbackBars, 2); d < n; d++) {
      const ref = lastSwingBefore(sw.highs, d - 1 - p.swingN)
      if (!ref || ref.i < d - p.bosRefBack || !(b[d]!.c > ref.price)) continue
      let first = true
      for (let k = ref.i + 1; k < d; k++) {
        if (b[k]!.c > ref.price) {
          first = false
          break
        }
      }
      if (!first || !trendUp(ctx, b[d]!.t)) continue
      const disp = displacement(b, d, atrs, p)
      if (!disp) continue
      const sl = lastSwingBefore(sw.lows, Math.min(disp.start - 1, d - p.swingN))
      if (!sl) continue
      const cand = continuationCandidate(ctx, b, atrs, tfMin, d, disp, ref, sl)
      if (better(cand, best)) best = cand
    }
  }
  return best
}

export const findSetup: FindSetup = (symbol, bars1m, params) => {
  const p: DetectParams = { ...getSettings().detect, ...params }
  if (bars1m.length < p.minBars1m) return null
  const src = bars1m.length > p.max1mBars ? bars1m.slice(-p.max1mBars) : bars1m
  const last = src[src.length - 1]!
  const nowSec = last.t + 60
  const b15 = tfBars(src, 15, nowSec, p.window15m)
  const b5 = tfBars(src, 5, nowSec, p.window5m)
  const b1h = tfBars(src, 60, nowSec, p.window1h)
  if (b15.length < 30 || b1h.length < 4) return null

  const bias = htfBias(b1h, p)
  if (bias === 'breakdown') return null

  const sufMax = new Float64Array(src.length)
  let m = -Infinity
  for (let i = src.length - 1; i >= 0; i--) {
    m = Math.max(m, src[i]!.h)
    sufMax[i] = m
  }
  const s15 = swings(b15, p.swingN)
  const toKnown = (list: Swing[]): Known[] => list.map((s) => ({ price: s.price, known: b15[s.i + p.swingN]!.t + 900 }))
  const ctx: Ctx = {
    symbol,
    p,
    src,
    nowSec,
    close: last.c,
    sufMax,
    levels: liquidityLevels('low', b15, b1h, p, b5),
    pools: liquidityLevels('high', b15, b1h, p, b5).sort((a, b) => a.price - b.price),
    bullish: bias === 'bullish',
    sw15: { highs: toKnown(s15.highs), lows: toKnown(s15.lows) },
  }

  let best: SetupCandidate | null = null
  for (const tf of p.scanTimeframes) {
    const b = tf === 15 ? b15 : tf === 5 ? b5 : tfBars(src, 1, nowSec, p.window1m)
    const cand = scanTf(ctx, b, tf)
    if (cand && (!best || cand.score > best.score)) best = cand
  }
  return best
}
