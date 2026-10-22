import { describe, expect, test } from 'bun:test'
import type { FindSetup, SetupCandidate } from '../src/ict/types'
import { defaultGrid, metricsFromLog, pickBest, renderTable, walkForward, type EntryResult, type RunMetrics } from '../src/research/walk'
import type { Candle } from '../src/types'
import { meta } from './fixtures'

const SYM = 'PEPETMN'
const T0 = 1_700_000_000 - (1_700_000_000 % 60)
const N = 700
const SPLIT = 0.57
const splitIdx = Math.floor(N * SPLIT)

const summary = { returnPct: 1, maxDrawdownPct: 2, feesTmn: 3, volumeTmn: 4 }
const ev = (event: string, data: Record<string, unknown>) => ({ event, data })

describe('metricsFromLog', () => {
  test('win rate, R and expectancy', () => {
    const events = [
      ev('setup.accepted', {}),
      ev('setup.rejected', { reason: 'net RR too low' }),
      ev('setup.rejected', { reason: 'net RR too low' }),
      ev('setup.rejected', { reason: 'no quote: Error: x' }),
      ev('setup.rejected', { reason: 'guard: loss pause: 3 losses in a row, resumes in 9 min' }),
      ev('exit.rejected', {}),
      ev('tp.rejected', {}),
      ev('entry.placed', { id: 'a', qty: 1000, entry: 1, stop: 0.98 }), // risk 20
      ev('entry.placed', { id: 'b', qty: 500, entry: 1, stop: 0.96 }), // risk 20
      ev('entry.placed', { id: 'c', qty: 1000, entry: 1, stop: 0.98 }), // risk 20
      ev('exit', { id: 'a', pnlTmn: 40, pnlFraction: 0.004, qty: 1000, entry: 1 }), // +2R
      ev('exit', { id: 'b', pnlTmn: -20, pnlFraction: -0.002, qty: 500, entry: 1 }), // -1R
      ev('exit', { id: 'c', pnlTmn: -10, pnlFraction: -0.001, qty: 1000, entry: 1 }), // -0.5R
    ]
    const m = metricsFromLog(events, summary)
    expect(m.trades).toBe(3)
    expect(m.winRate).toBeCloseTo(1 / 3)
    expect(m.avgR).toBeCloseTo((2 - 1 - 0.5) / 3)
    expect(m.expectancyPct).toBeCloseTo(((0.004 - 0.002 - 0.001) / 3) * 100)
    expect(m.execRejects).toBe(2)
    expect(m.setupsAccepted).toBe(1)
    expect(m.setupsRejected).toBe(4)
    expect(m.rejectedByReason).toEqual({ 'net RR too low': 2, 'no quote': 1, 'guard: loss pause': 1 })
    expect(m.returnPct).toBe(1)
    expect(m.feesTmn).toBe(3)
  })

  test('no trades gives zeros', () => {
    const m = metricsFromLog([], summary)
    expect([m.trades, m.winRate, m.avgR, m.expectancyPct]).toEqual([0, 0, 0, 0])
  })
})

const metrics = (o: Partial<RunMetrics>): RunMetrics => ({
  trades: 0, winRate: 0, avgR: 0, expectancyPct: 0, returnPct: 0, maxDrawdownPct: 0, feesTmn: 0, volumeTmn: 0,
  setupsAccepted: 0, setupsRejected: 0, execRejects: 0, rejectedByReason: {}, ...o,
})
const res = (name: string, train: Partial<RunMetrics>, test: Partial<RunMetrics> = {}): EntryResult => ({
  entry: { name },
  train: metrics(train),
  test: metrics(test),
})

describe('pickBest', () => {
  test('best train return among entries with enough trades', () => {
    const r = [res('a', { trades: 9, returnPct: 3 }), res('b', { trades: 4, returnPct: 50 }), res('c', { trades: 6, returnPct: 5 })]
    expect(pickBest(r)).toEqual({ index: 2, basis: 'return' })
  })

  test('falls back to lowest drawdown when nobody has enough trades', () => {
    const r = [res('a', { trades: 2, returnPct: 9, maxDrawdownPct: 4 }), res('b', { trades: 1, returnPct: -1, maxDrawdownPct: 1 })]
    expect(pickBest(r)).toEqual({ index: 1, basis: 'drawdown' })
  })

  test('test numbers never change the pick', () => {
    const train = [{ trades: 7, returnPct: 2 }, { trades: 7, returnPct: 4 }]
    const a = pickBest([res('a', train[0]!, { returnPct: 99 }), res('b', train[1]!, { returnPct: -99 })])
    const b = pickBest([res('a', train[0]!, { returnPct: -99 }), res('b', train[1]!, { returnPct: 99 })])
    expect(a).toEqual(b)
  })
})

// Fires a fresh long setup at the last close on every bar, unless the entry asks for minScore 99.
const setup = (bars: Candle[]): SetupCandidate => {
  const last = bars[bars.length - 1]!
  return {
    symbol: SYM, model: 'sweep', detectedAt: last.t, entry: 1, stop: 0.98, tp1: 1.06, score: 7, scoreParts: {},
    sweep: { level: 0.99, kind: 'test', extreme: 0.985, t: last.t },
    mss: { level: 1, t: last.t, displacementAtr: 2 },
    fvg: { low: 0.99, high: 1.01, ce: 1, t: last.t },
    dealingRange: { low: 0.95, high: 1.1 },
    expiresAt: last.t + 600, invalidateBelow: 0.9, rationale: 'stub',
  }
}
const stub: FindSetup = (_s, bars, params) => (params?.minScore === 99 || bars.length < 5 ? null : setup(bars))

// 20-bar cycles: dip through 1.0 to fill, then a run to 1.07 (target hit) or a drop to 0.96 (stop hit).
function series(winAfter: (i: number) => boolean): Candle[] {
  const out: Candle[] = []
  for (let i = 0; i < N; i++) {
    const k = i % 20
    const t = T0 + i * 60
    let c: Candle = { t, o: 1, h: 1.001, l: 0.999, c: 1, v: 1 }
    if (k === 3) c = { t, o: 1, h: 1.001, l: 0.994, c: 0.998, v: 1 }
    else if (k >= 4 && k <= 8) c = winAfter(i) ? { t, o: 1.0, h: 1.07, l: 0.999, c: 1.07, v: 1 } : { t, o: 0.99, h: 0.995, l: 0.95, c: 0.96, v: 1 }
    else if (k === 9) c = { t, o: 1, h: 1.001, l: 0.999, c: 1, v: 1 }
    out.push(c)
  }
  return out
}

const grid = [{ name: 'on', detect: { minScore: 5 } }, { name: 'off', detect: { minScore: 99 } }]
const run = (bars: Candle[]) =>
  walkForward({
    bars: { [SYM]: bars },
    fromSec: T0,
    toSec: T0 + N * 60,
    split: SPLIT,
    grid,
    ctx: { meta, blocked: new Set(), risk: 0.01, startTmn: 5_000_000, findSetup: stub },
  })

describe('walkForward', () => {
  const winTrain = series(() => true)
  const loseTest = series(() => false)

  test('grid detect params reach the detector and train drives the pick', async () => {
    const w = await run(winTrain)
    expect(w.results.map((r) => r.entry.name)).toEqual(['on', 'off'])
    expect(w.results[1]!.train.trades).toBe(0)
    expect(w.results[0]!.train.trades).toBeGreaterThanOrEqual(5)
    expect(w.results[0]!.train.returnPct).toBeGreaterThan(0)
    expect(w.results[0]!.train.winRate).toBeGreaterThan(0.5)
    expect(w.results[0]!.train.avgR).toBeGreaterThan(0)
    expect(w.picked).toMatchObject({ name: 'on', basis: 'return' })
    expect(w.trainRange[1]).toBe(w.testRange[0])
  })

  test('changing only the test window leaves train numbers and the pick untouched', async () => {
    const a = await run(winTrain)
    const b = await run(loseTest.map((c, i) => (i < splitIdx ? winTrain[i]! : c)))
    expect(b.results.map((r) => r.train)).toEqual(a.results.map((r) => r.train))
    expect(b.picked).toEqual(a.picked)
    expect(JSON.stringify(b.results[0]!.test)).not.toBe(JSON.stringify(a.results[0]!.test))
    expect(b.results[0]!.test.returnPct).toBeLessThan(a.results[0]!.test.returnPct)
  })

  test('train numbers do not depend on anything after the split', async () => {
    const a = await run(winTrain)
    const garbage = winTrain.map((c, i) => (i >= splitIdx ? { ...c, h: c.h * 3, l: c.l / 3, c: c.c * 2 } : c))
    const b = await run(garbage)
    expect(b.results.map((r) => r.train)).toEqual(a.results.map((r) => r.train))
  })

  test('table lists every entry on both windows', async () => {
    const t = renderTable(await run(winTrain))
    expect(t.match(/\| train \|/g)).toHaveLength(grid.length)
    expect(t.match(/\| test \|/g)).toHaveLength(grid.length)
    expect(t).toContain('(picked)')
  })
})

test('default grid has unique names', () => {
  expect(new Set(defaultGrid.map((g) => g.name)).size).toBe(defaultGrid.length)
})
