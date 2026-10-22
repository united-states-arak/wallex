import { expect, test } from 'bun:test'
import { findSetup } from '../src/ict/detect'
import type { SetupCandidate } from '../src/ict/types'
import type { Candle } from '../src/types'

const T0 = 19_675 * 86_400

type Bar15 = [number, number, number, number]

// Expand one 15m candle into fifteen 1m candles whose aggregate is exactly o,h,l,c
function expand(t0: number, [o, h, l, c]: Bar15): Candle[] {
  const pts = c >= o ? [o, l, h, c] : [o, h, l, c]
  const out: Candle[] = []
  for (let m = 0; m < 15; m++) {
    const seg = Math.min(2, Math.floor(m / 5))
    const f0 = (m - seg * 5) / 5
    const f1 = (m + 1 - seg * 5) / 5
    const a = pts[seg]! + (pts[seg + 1]! - pts[seg]!) * Math.min(f0, 1)
    const z = pts[seg]! + (pts[seg + 1]! - pts[seg]!) * Math.min(f1, 1)
    out.push({ t: t0 + m * 60, o: a, h: Math.max(a, z), l: Math.min(a, z), c: z, v: 1 })
  }
  return out
}

function path(): Bar15[] {
  const bars: Bar15[] = []
  for (let k = 0; k < 5; k++) {
    const o = 1000 + 12 * k
    bars.push([o, o + 14, o - 2, o + 12])
  }
  for (let k = 5; k < 20; k++) {
    const o = 1060 - 4 * (k - 5)
    bars.push([o, o + 2, o - 6, o - 4])
  }
  bars.push([1000, 1001, 994, 996])
  bars.push([996, 1006, 995, 1004])
  bars.push([1004, 1008, 1002, 1006])
  bars.push([1006, 1007, 998, 1000])
  bars.push([1000, 1002, 996, 998])
  bars.push([998, 1003, 997, 1001])
  bars.push([1001, 1002, 997, 999])
  bars.push([999, 1000, 990, 996])
  bars.push([996, 1022, 995, 1020])
  bars.push([1020, 1030, 1010, 1024])
  return bars
}

function build(bars15: Bar15[], startOffset = 0): Candle[] {
  const out: Candle[] = []
  bars15.forEach((b, k) => out.push(...expand(T0 + startOffset + k * 900, b)))
  return out
}

const retrace: Bar15[] = [
  [1024, 1026, 1012, 1018],
  [1018, 1019, 1004, 1008],
  [1008, 1015, 1006, 1012],
  [1012, 1020, 1011, 1018],
]

const withRetrace = () => build([...path(), ...retrace])

function check(s: SetupCandidate) {
  expect(s.entry).toBeGreaterThanOrEqual(s.fvg.low)
  expect(s.entry).toBeLessThanOrEqual(s.fvg.high)
  expect(s.stop).toBeLessThan(s.sweep.extreme)
  expect(s.sweep.extreme).toBeLessThan(s.sweep.level)
  expect(s.tp1).toBeGreaterThan(s.entry)
  expect((s.tp1 - s.entry) / (s.entry - s.stop)).toBeGreaterThanOrEqual(2)
  const stopPct = (s.entry - s.stop) / s.entry
  expect(stopPct).toBeGreaterThanOrEqual(0.01)
  expect(stopPct).toBeLessThanOrEqual(0.025)
  expect(s.entry).toBeLessThan((s.dealingRange.low + s.dealingRange.high) / 2)
  expect(s.invalidateBelow).toBe(s.stop)
  expect(s.score).toBe(Object.values(s.scoreParts).reduce((a, x) => a + x, 0))
}

test('downtrend, sweep of a prior low, displacement with FVG gives a valid long setup', () => {
  const bars = build([...path(), retrace[0]!])
  const s = findSetup('TESTTMN', bars)
  expect(s).not.toBeNull()
  check(s!)
  expect(s!.symbol).toBe('TESTTMN')
  expect(s!.detectedAt).toBe(bars[bars.length - 1]!.t)
  expect(s!.expiresAt).toBe(s!.detectedAt + 180 * 60)
  expect(s!.model).toBe('sweep')
  expect(s!.mss.displacementAtr).toBeGreaterThanOrEqual(1.2)
  expect(s!.rationale.length).toBeGreaterThan(20)
})

test('no lookahead: result at k never depends on bars after k', () => {
  const full = withRetrace()
  const garbage = full.map((b, i) => (i < 600 ? b : { ...b, o: 1, h: 5000, l: 0.5, c: 4000 }))
  for (const k of [420, 450, 480, 495, 510, 525, 540, 555, 570, 585, 600]) {
    const a = findSetup('X', full.slice(0, k))
    const b = findSetup('X', garbage.slice(0, k))
    expect(b).toEqual(a)
  }
})

test('appending bars after the zone formed never changes sweep, mss or fvg of the candidate', () => {
  const full = withRetrace()
  const seen: SetupCandidate[] = []
  for (let k = 430; k <= full.length; k += 5) {
    const s = findSetup('X', full.slice(0, k))
    if (s) seen.push(s)
  }
  expect(seen.length).toBeGreaterThan(1)
  const first = seen[0]!
  for (const s of seen) {
    check(s)
    expect(s.sweep).toEqual(first.sweep)
    expect(s.mss).toEqual(first.mss)
    expect(s.fvg).toEqual(first.fvg)
    expect(s.entry).toBe(first.entry)
    expect(s.stop).toBe(first.stop)
    expect(s.dealingRange).toEqual(first.dealingRange)
  }
})

test('a breakout (close beyond the level, no close back) is not a sweep', () => {
  const p = path()
  p[27] = [999, 1000, 990, 992]
  expect(findSetup('X', build([...p, retrace[0]!]), { shortSwingLevels: false })).toBeNull()
})

test('a candidate is not returned once price closes through the stop', () => {
  const crash: Bar15[] = [[1024, 1025, 975, 980]]
  expect(findSetup('X', build([...path(), ...crash]))).toBeNull()
})

test('flat zero-volume candles do not crash or produce setups', () => {
  const flat: Candle[] = Array.from({ length: 3000 }, (_, i) => ({ t: T0 + i * 60, o: 100, h: 100, l: 100, c: 100, v: 0 }))
  expect(findSetup('X', flat)).toBeNull()
  expect(findSetup('X', [])).toBeNull()
  expect(findSetup('X', flat.slice(0, 50))).toBeNull()
  const sparse = flat.map((b, i) => (i % 97 === 0 ? { ...b, h: 100.01, l: 99.99, c: 100.01, v: 1 } : b))
  expect(findSetup('X', sparse)).toBeNull()
})

test('findSetup stays fast on 3000 bars', () => {
  const bars = build([...path(), ...retrace])
  const long: Candle[] = []
  for (let r = 0; r < 4; r++) for (const b of bars) long.push({ ...b, t: b.t + r * bars.length * 60 })
  const slice = long.slice(0, 3000)
  findSetup('X', slice)
  const t0 = performance.now()
  for (let i = 0; i < 20; i++) findSetup('X', slice)
  expect((performance.now() - t0) / 20).toBeLessThan(20)
})

function contPath(): Bar15[] {
  const bars: Bar15[] = []
  for (let k = 0; k < 5; k++) {
    const o = 1010 + 10 * k
    bars.push([o, o + 11, o - 1, o + 10])
  }
  for (let k = 0; k < 10; k++) {
    const o = 1060 - 10 * k
    bars.push([o, o + 1, o - 11, o - 10])
  }
  for (let j = 0; j < 9; j++) {
    const b = 960 + 3 * j
    bars.push([b + 2, b + 12, b + 1, b + 11])
    bars.push([b + 11, b + 11, b + 4, b + 5])
    bars.push([b + 5, b + 7, b + 3, b + 4])
  }
  bars.push([988, 992, 978, 989])
  bars.push([989, 1013, 989, 1012])
  bars.push([1012, 1022, 1000, 1018])
  return bars
}

const contRetrace: Bar15[] = [
  [1018, 1020, 1004, 1010],
  [1010, 1011, 998, 1001],
  [1001, 1012, 1000, 1010],
  [1010, 1016, 1008, 1014],
]

const cont = { models: ['continuation' as const] }

test('uptrend BOS with displacement and FVG then pullback gives a continuation setup', () => {
  const bars = build([...contPath(), contRetrace[0]!])
  const s = findSetup('CONTTMN', bars, cont)
  expect(s).not.toBeNull()
  expect(s!.model).toBe('continuation')
  expect(s!.entry).toBeGreaterThanOrEqual(s!.fvg.low)
  expect(s!.entry).toBeLessThanOrEqual(s!.fvg.high)
  expect(s!.stop).toBeLessThan(s!.sweep.extreme)
  expect(s!.tp1).toBeGreaterThan(s!.entry)
  expect((s!.tp1 - s!.entry) / (s!.entry - s!.stop)).toBeGreaterThanOrEqual(2)
  const stopPct = (s!.entry - s!.stop) / s!.entry
  expect(stopPct).toBeGreaterThanOrEqual(0.01)
  expect(stopPct).toBeLessThanOrEqual(0.025)
  expect(s!.entry).toBeLessThan((s!.dealingRange.low + s!.dealingRange.high) / 2)
  expect(s!.mss.level).toBeLessThan(s!.dealingRange.high)
  expect(s!.mss.displacementAtr).toBeGreaterThanOrEqual(1.2)
  expect(s!.score).toBe(Object.values(s!.scoreParts).reduce((a, x) => a + x, 0))
  expect(s!.rationale).toContain('BOS')
  expect(findSetup('CONTTMN', bars, { models: ['sweep'] })?.model ?? 'sweep').toBe('sweep')
})

test('continuation needs a rising 15m structure and no 1H breakdown', () => {
  const p = contPath()
  const flatTrend = p.map((b, i) => (i >= 15 && i < 42 ? ([b[0] - (i - 15) * 3, b[1] - (i - 15) * 3, b[2] - (i - 15) * 3, b[3] - (i - 15) * 3] as Bar15) : b))
  expect(findSetup('X', build([...flatTrend, contRetrace[0]!]), cont)).toBeNull()
})

test('continuation: no lookahead and stable fields as bars are appended', () => {
  const full = build([...contPath(), ...contRetrace])
  const garbage = full.map((b, i) => (i < 720 ? b : { ...b, o: 1, h: 5000, l: 0.5, c: 4000 }))
  const seen: SetupCandidate[] = []
  for (let k = 660; k <= full.length; k += 5) {
    const a = findSetup('X', full.slice(0, k), cont)
    if (k <= 720) expect(findSetup('X', garbage.slice(0, k), cont)).toEqual(a)
    if (a) seen.push(a)
  }
  expect(seen.length).toBeGreaterThan(1)
  for (const s of seen) {
    expect(s.model).toBe('continuation')
    expect(s.mss).toEqual(seen[0]!.mss)
    expect(s.fvg).toEqual(seen[0]!.fvg)
    expect(s.sweep).toEqual(seen[0]!.sweep)
    expect(s.entry).toBe(seen[0]!.entry)
  }
})

test('both models: setup at k is independent of bars after k (default params)', () => {
  for (const full of [withRetrace(), build([...contPath(), ...contRetrace])]) {
    const garbage = full.map((b, i) => (i < 640 ? b : { ...b, o: 1, h: 5000, l: 0.5, c: 4000 }))
    for (let k = 450; k <= 640; k += 10) expect(findSetup('X', garbage.slice(0, k))).toEqual(findSetup('X', full.slice(0, k)))
  }
})

test('1m scanning stays within the 20ms per call budget on 3000 noisy bars', () => {
  let x = 12345
  const rnd = () => ((x = (x * 1103515245 + 12345) % 2147483648) / 2147483648)
  const bars: Candle[] = []
  let price = 1000
  for (let i = 0; i < 3000; i++) {
    const o = price
    price = Math.max(10, price * (1 + (rnd() - 0.5) * 0.006))
    bars.push({ t: T0 + i * 60, o, h: Math.max(o, price) * (1 + rnd() * 0.001), l: Math.min(o, price) * (1 - rnd() * 0.001), c: price, v: 1 })
  }
  const p = { scanTimeframes: [1 as const, 5 as const, 15 as const] }
  findSetup('X', bars, p)
  const t0 = performance.now()
  for (let i = 0; i < 20; i++) findSetup('X', bars.slice(0, 3000 - i), p)
  expect((performance.now() - t0) / 20).toBeLessThan(20)
})

test('flat candles with 1m scanning and both models do not crash', () => {
  const flat: Candle[] = Array.from({ length: 3000 }, (_, i) => ({ t: T0 + i * 60, o: 100, h: 100, l: 100, c: 100, v: 0 }))
  expect(findSetup('X', flat, { scanTimeframes: [1, 5, 15] })).toBeNull()
})
