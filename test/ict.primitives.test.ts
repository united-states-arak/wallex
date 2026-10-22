import { expect, test } from 'bun:test'
import {
  atr,
  atrSeries,
  chooseEntry,
  displacement,
  findFvgs,
  isDiscount,
  isSweep,
  liquidityLevels,
  oteZone,
  rangePosition,
  swings,
} from '../src/ict/detect'
import { defaultDetectParams } from '../src/ict/types'
import type { Candle } from '../src/types'

const c = (i: number, o: number, h: number, l: number, cl: number, size = 900): Candle => ({ t: i * size, o, h, l, c: cl, v: 1 })

test('atr averages true range and ignores flat candles gracefully', () => {
  const bars = [c(0, 10, 12, 8, 11), c(1, 11, 13, 10, 12), c(2, 12, 12, 12, 12)]
  expect(atr(bars, 14)).toBeCloseTo((4 + 3 + 0) / 3, 10)
  expect(atr([], 14)).toBe(0)
  const flat = Array.from({ length: 20 }, (_, i) => c(i, 5, 5, 5, 5))
  expect(atr(flat)).toBe(0)
  expect(atrSeries(bars, 2)[2]).toBeCloseTo((3 + 0) / 2, 10)
})

test('swings are only returned once n closed bars follow them', () => {
  const bars = [c(0, 10, 11, 9, 10), c(1, 10, 15, 10, 14), c(2, 14, 13, 8, 9), c(3, 9, 12, 9, 11), c(4, 11, 14, 10, 13)]
  const s1 = swings(bars, 1)
  expect(s1.highs.map((s) => s.i)).toEqual([1])
  expect(s1.lows.map((s) => s.i)).toEqual([2])
  const s1short = swings(bars.slice(0, 3), 1)
  expect(s1short.highs.map((s) => s.i)).toEqual([1])
  expect(s1short.lows).toEqual([])
  expect(swings(bars, 2).highs).toEqual([])
  expect(swings(bars.slice(0, 2), 1).highs).toEqual([])
})

test('flat candles produce no swings', () => {
  const flat = Array.from({ length: 30 }, (_, i) => c(i, 5, 5, 5, 5))
  expect(swings(flat, 1)).toEqual({ highs: [], lows: [] })
  expect(swings(flat, 2)).toEqual({ highs: [], lows: [] })
})

test('findFvgs finds bullish 3-candle gaps above the minimum size', () => {
  const bars = [c(0, 100, 101, 99, 100), c(1, 100, 112, 100, 111), c(2, 111, 115, 106, 114), c(3, 114, 115, 113, 114)]
  const atrs = atrSeries(bars)
  const f = findFvgs(bars, 0.15, atrs)
  expect(f).toHaveLength(1)
  expect(f[0]).toMatchObject({ m: 1, low: 101, high: 106, ce: 103.5 })
  expect(findFvgs(bars, 50, atrs)).toHaveLength(0)
})

test('displacement needs a big body, 60% of range, and an FVG', () => {
  const p = defaultDetectParams
  const base = Array.from({ length: 20 }, (_, i) => c(i, 100, 101, 99, 100))
  const good = [...base, c(20, 100, 111, 100, 110), c(21, 110, 115, 104, 114)]
  const d = displacement(good, 20, atrSeries(good), p)
  expect(d).not.toBeNull()
  expect(d!.atrMult).toBeGreaterThan(p.displacementAtr)
  expect(d!.fvgs[0]!.ce).toBeCloseTo(102.5, 10)

  const wicky = [...base, c(20, 100, 120, 100, 110), c(21, 110, 115, 104, 114)]
  expect(displacement(wicky, 20, atrSeries(wicky), p)).toBeNull()

  const noGap = [...base, c(20, 100, 111, 100, 110), c(21, 110, 115, 100.5, 114)]
  expect(displacement(noGap, 20, atrSeries(noGap), p)).toBeNull()

  const small = [...base, c(20, 100, 101.5, 100, 101.4), c(21, 101.4, 104, 101.2, 103)]
  expect(displacement(small, 20, atrSeries(small), p)).toBeNull()
})

test('isSweep needs a poke and a close back above; a close beyond is a breakout', () => {
  expect(isSweep(c(0, 100, 101, 98, 100.5), 99, 0.0002)).toBe(true)
  expect(isSweep(c(0, 100, 101, 98, 98.5), 99, 0.0002)).toBe(false)
  expect(isSweep(c(0, 100, 101, 98.99, 100), 99, 0.0002)).toBe(false)
  expect(isSweep(c(0, 100, 101, 99, 100), 99, 0.0002)).toBe(false)
})

test('liquidity levels include previous-day lows, 8h block lows and equal lows', () => {
  const H = 3600
  const day = 19_675 * 86_400
  const b1h: Candle[] = []
  for (let k = 0; k < 40; k++) {
    const base = 1000 + (k % 5)
    b1h.push({ t: day + k * H, o: base, h: base + 3, l: base - 3 - (k === 5 ? 20 : 0), c: base, v: 1 })
  }
  const b15: Candle[] = []
  for (let k = 0; k < 160; k++) {
    const lo = k === 10 || k === 20 ? 990 : 1000 + (k % 4)
    b15.push({ t: day + k * 900, o: 1005, h: 1010, l: lo, c: 1005, v: 1 })
  }
  const lows = liquidityLevels('low', b15, b1h, defaultDetectParams)
  const kinds = new Set(lows.map((l) => l.kind))
  expect(kinds.has('pdl')).toBe(true)
  expect(kinds.has('asia8h')).toBe(true)
  expect(kinds.has('eql')).toBe(true)
  expect(kinds.has('swing15m')).toBe(true)
  const pdl = lows.find((l) => l.kind === 'pdl')!
  expect(pdl.price).toBe(977)
  expect(pdl.known).toBe(day + 86_400)
  const highs = liquidityLevels('high', b15, b1h, defaultDetectParams)
  expect(highs.some((l) => l.kind === 'pdh')).toBe(true)
})

test('dealing range, OTE zone, premium/discount and entry choice', () => {
  const range = { low: 100, high: 140 }
  const ote = oteZone(range, defaultDetectParams)
  expect(ote.low).toBeCloseTo(140 - 0.79 * 40, 10)
  expect(ote.high).toBeCloseTo(140 - 0.62 * 40, 10)
  expect(rangePosition(range, 120)).toBe(0.5)
  expect(isDiscount(range, 119.9)).toBe(true)
  expect(isDiscount(range, 120)).toBe(false)
  expect(chooseEntry({ low: 108, high: 116, ce: 112 }, ote)).toEqual({ entry: 112, kind: 'ce' })
  expect(chooseEntry({ low: 104, high: 110, ce: 107 }, ote).kind).toBe('overlap')
  expect(chooseEntry({ low: 125, high: 130, ce: 127.5 }, ote).kind).toBe('fvg')
})
