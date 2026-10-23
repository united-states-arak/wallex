import { describe, expect, test } from 'bun:test'
import type { ReviewInput, Supervisor, Verdict } from '../src/ai/types'
import { PaperExchange } from '../src/exchange/paper'
import type { RiskGuard } from '../src/risk/types'
import { createBreakoutStrategy, HourlyTracker } from '../src/strategy/breakout'
import type { Candle, MarketMeta, Markets } from '../src/types'

const mk = (symbol: string): MarketMeta => ({ symbol, base: symbol.replace('TMN', ''), quote: 'TMN', qtyDecimals: 2, priceDecimals: 2, minQty: 0.01, minNotional: 5_000, marketEnabled: false })
const SYMS = ['AAATMN', 'BBBTMN', 'CCCTMN']
const meta: Markets = Object.fromEntries(SYMS.map((s) => [s, mk(s)]))
const T0 = 1_700_000_000 - (1_700_000_000 % 3600)
const PRIME_HOURS = 200
const BREAK_HOUR = PRIME_HOURS // the hour whose volume spikes on AAA

// AAA: steady rise, a volume spike in BREAK_HOUR, 30 more hours of rise, then a slow decline into the trailing stop.
// BBB and CCC: steady rise with flat volume (they keep the market gate open but never break out on volume).
function priceAt(symbol: string, m: number, falling = false): number {
  if (falling && symbol !== 'AAATMN') return 100 - (0.1 * m) / 60
  const rise = 100 + (0.1 * m) / 60
  if (symbol !== 'AAATMN') return rise
  const peakM = (BREAK_HOUR + 31) * 60
  return m <= peakM ? rise : 100 + (0.1 * peakM) / 60 - 0.05 * (m - peakM)
}
function bar(symbol: string, m: number, falling = false): Candle {
  const o = priceAt(symbol, m - 1, falling)
  const c = priceAt(symbol, m, falling)
  const v = symbol === 'AAATMN' && Math.floor(m / 60) === BREAK_HOUR ? 3 : 1
  return { t: T0 + m * 60, o, h: Math.max(o, c) + 0.02, l: Math.min(o, c) - 0.02, c, v }
}

const approve: Supervisor = { review: async () => ({ action: 'approve', sizeMult: 1, reason: 'clean breakout', source: 'ai', model: 'test', latencyMs: 1 }), refreshNews: async () => null }

function run(o: { supervisor?: Supervisor; guard?: RiskGuard; falling?: boolean; endMinute?: number; onMinute?: (m: number, s: ReturnType<typeof createBreakoutStrategy>) => void }) {
  const events: { event: string; data: Record<string, any> }[] = []
  const log = (event: string, data: Record<string, unknown> = {}) => void events.push({ event, data })
  const ex = new PaperExchange(meta, new Set(), { TMN: 5_000_000 }, { maker: 0.0025, taker: 0.003 }, { spreadBps: 10, slippageBps: 10 })
  const strat = createBreakoutStrategy({ meta, log, supervisor: o.supervisor ?? approve, guard: o.guard, fees: { maker: 0.0025, taker: 0.003 } })
  const hist: Record<string, Candle[]> = {}
  for (const s of SYMS) {
    const bars = Array.from({ length: PRIME_HOURS * 60 }, (_, m) => bar(s, m, o.falling))
    for (const b of bars.slice(-5)) ex.onCandle(s, b)
    strat.prime(s, bars)
    hist[s] = bars.slice(-3000)
  }
  return {
    events,
    ex,
    strat,
    async go() {
      for (let m = PRIME_HOURS * 60; m < (o.endMinute ?? (BREAK_HOUR + 34) * 60); m++) {
        for (const s of SYMS) {
          const b = bar(s, m, o.falling)
          ex.onCandle(s, b)
          hist[s]!.push(b)
          if (hist[s]!.length > 3000) hist[s]!.shift()
          await strat.onBar({ symbol: s, bars: hist[s]!, ex })
        }
        o.onMinute?.(m, strat)
      }
    },
  }
}

const of = (events: { event: string; data: Record<string, any> }[], name: string) => events.filter((e) => e.event === name)

describe('breakout strategy', () => {
  test('a volume breakout in a rising market is entered, trailed and closed in profit by the trailing stop', async () => {
    const r = run({})
    await r.go()
    const accepted = of(r.events, 'setup.accepted')
    expect(accepted).toHaveLength(1)
    expect(accepted[0]!.data.symbol).toBe('AAATMN')
    expect(accepted[0]!.data.verdict).toBe('approve')
    expect(accepted[0]!.data.rationale).toContain('breakout')
    expect(accepted[0]!.data.pctOfEquity).toBeLessThanOrEqual(0.5)
    expect(of(r.events, 'entry.filled')).toHaveLength(1)
    expect(of(r.events, 'stop.trail').length).toBeGreaterThan(0)
    const exit = of(r.events, 'exit')[0]!
    expect(exit.data.how).toBe('trailing stop')
    expect(exit.data.pnlTmn).toBeGreaterThan(0)
    expect(exit.data.exit).toBeGreaterThan(exit.data.entry)
    const b = await r.ex.balances()
    expect(b.AAA!.free + b.AAA!.locked).toBeLessThan(0.01)
    expect(b.TMN!.free).toBeGreaterThan(5_000_000)
  })

  test('the stop-based size never risks more than about 1% and never uses more than half the account', async () => {
    const r = run({ endMinute: (BREAK_HOUR + 2) * 60 })
    await r.go()
    const a = of(r.events, 'setup.accepted')[0]!.data
    expect(a.lossPctAtStop).toBeLessThanOrEqual(0.0101)
    expect(a.notional).toBeLessThanOrEqual(2_500_000)
  })

  test('an AI veto blocks the entry and the reason is logged', async () => {
    const veto: Supervisor = { review: async () => ({ action: 'veto', sizeMult: 0, reason: 'exploit headline for AAA', source: 'ai', model: 'test', latencyMs: 1 }), refreshNews: async () => null }
    const r = run({ supervisor: veto, endMinute: (BREAK_HOUR + 2) * 60 })
    await r.go()
    expect(of(r.events, 'entry.placed')).toHaveLength(0)
    const rej = of(r.events, 'setup.rejected')[0]!.data
    expect(rej.reason).toBe('supervisor veto')
    expect(rej.verdictReason).toContain('exploit')
  })

  test('an AI resize shrinks the position and the AI sees the breakout evidence', async () => {
    let seen: ReviewInput | null = null
    const shrink: Supervisor = {
      review: async (i): Promise<Verdict> => {
        seen = i
        return { action: 'resize', sizeMult: 0.5, reason: 'euphoric market', source: 'ai', model: 'test', latencyMs: 1 }
      },
      refreshNews: async () => null,
    }
    const full = run({ endMinute: (BREAK_HOUR + 2) * 60 })
    await full.go()
    const half = run({ supervisor: shrink, endMinute: (BREAK_HOUR + 2) * 60 })
    await half.go()
    const q = (r: ReturnType<typeof run>) => of(r.events, 'setup.accepted')[0]!.data.qty as number
    expect(q(half)).toBeCloseTo(q(full) / 2, 1)
    expect(seen!.setup.model).toBe('breakout')
    expect(seen!.setup.features).toMatchObject({ marketBreadthPct: 100, initialStopAtr: 4, trailingStopAtr: 8 })
  })

  test('the risk guard blocks entries while halted', async () => {
    const guard: RiskGuard = {
      riskPct: () => 0.01,
      updateEquity() {},
      recordTrade() {},
      blockReason: () => 'daily loss halt',
      state: () => ({ equity: 5_000_000, startEquity: 5_000_000, dayPeak: 5_000_000, dayPnlPct: 0, totalPnlPct: 0, consecutiveLosses: 0, halted: true, riskPct: 0.01 }),
    }
    const r = run({ guard, endMinute: (BREAK_HOUR + 2) * 60 })
    await r.go()
    expect(of(r.events, 'entry.placed')).toHaveLength(0)
    expect(of(r.events, 'setup.rejected')[0]!.data.reason).toBe('guard: daily loss halt')
  })

  test('when most of the market is falling the gate stays shut and nothing is bought', async () => {
    const r = run({ falling: true, endMinute: (BREAK_HOUR + 2) * 60 })
    await r.go()
    expect(of(r.events, 'setup.accepted')).toHaveLength(0)
    expect(of(r.events, 'entry.placed')).toHaveLength(0)
  })

  test('an open position and its stop survive a restart', async () => {
    let saved: unknown = null
    const r = run({ endMinute: (BREAK_HOUR + 10) * 60, onMinute: (m, s) => (m === (BREAK_HOUR + 9) * 60 ? (saved = s.getState()) : undefined) })
    await r.go()
    const before = r.strat.openPositions()
    expect(before).toHaveLength(1)
    const fresh = createBreakoutStrategy({ meta, supervisor: approve })
    fresh.restoreState(saved)
    const after = fresh.openPositions()
    expect(after).toHaveLength(1)
    expect(after[0]!.symbol).toBe('AAATMN')
    expect(after[0]!.qty).toBeCloseTo(before[0]!.qty, 6)
  })

  test('a restored state with an unknown market or broken numbers is ignored', () => {
    const s = createBreakoutStrategy({ meta, supervisor: approve })
    s.restoreState({ positions: { XXXTMN: { symbol: 'XXXTMN', phase: 'open', qty: 1, stop: 1, entry: 2 }, AAATMN: { symbol: 'AAATMN', phase: 'open', qty: -1, stop: 1, entry: 2 } } })
    expect(s.openPositions()).toHaveLength(0)
  })
})

describe('hourly tracker', () => {
  const p = { lookbackHours: 96, emaHours: 96, atrHours: 14, stopAtr: 4, trailAtr: 8, volumeMult: 1.5, maxChaseAtr: 3, breadthMin: 0.7, breadthEmaHours: 168, maxHoldHours: 336 }

  test('the forming hour is never used: no signal in the middle of an hour', () => {
    const t = new HourlyTracker(p)
    for (const s of SYMS) t.prime(s, Array.from({ length: PRIME_HOURS * 60 }, (_, m) => bar(s, m)))
    const mid: Candle[] = Array.from({ length: BREAK_HOUR * 60 + 30 }, (_, m) => bar('AAATMN', m))
    for (const b of mid.slice(PRIME_HOURS * 60)) t.update('AAATMN', mid.slice(0, mid.indexOf(b) + 1))
    expect(t.signal('AAATMN', mid[mid.length - 1]!.c)).toBeNull()
  })

  test('breadth counts the share of markets above their slow average', () => {
    const t = new HourlyTracker(p)
    for (const s of SYMS) t.prime(s, Array.from({ length: PRIME_HOURS * 60 }, (_, m) => bar(s, m, s !== 'AAATMN')))
    expect(t.breadth()).toBeCloseTo(1 / 3, 5)
  })
})
