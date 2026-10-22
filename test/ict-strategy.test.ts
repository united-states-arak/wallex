import { describe, expect, test } from 'bun:test'
import type { Supervisor, Verdict } from '../src/ai/types'
import { PaperExchange } from '../src/exchange/paper'
import type { FindSetup, SetupCandidate } from '../src/ict/types'
import type { Log } from '../src/log'
import type { GuardState, RiskGuard } from '../src/risk/types'
import { createIctStrategy, type IctStrategy } from '../src/strategy/ict'
import type { Candle } from '../src/types'
import { bar, meta } from './fixtures'

const SYM = 'PEPETMN'
const START = 5_000_000
const T0 = 1_700_000_000

const flat = (i: number, p = 1) => bar(T0 + i * 60, p, p, p, p)

function candidate(over: Partial<SetupCandidate> = {}): SetupCandidate {
  const entry = over.entry ?? 1
  return {
    model: 'sweep',
    symbol: SYM,
    detectedAt: T0,
    entry,
    stop: entry * 0.98,
    tp1: entry * 1.06,
    score: 7,
    scoreParts: {},
    sweep: { level: 0.99, kind: 'test', extreme: 0.985, t: T0 + 60 },
    mss: { level: 1, t: T0 + 120, displacementAtr: 2 },
    fvg: { low: 0.99, high: 1.01, ce: entry, t: T0 + 180 },
    dealingRange: { low: 0.95, high: 1.1 },
    expiresAt: T0 + 3600,
    invalidateBelow: 0.9,
    rationale: 'stub setup',
    ...over,
  }
}

// Returns the setup on every bar from the 5th one on, like a detector that keeps seeing the same pattern.
const stub = (c: SetupCandidate = candidate()): FindSetup => (_s, bars) => (bars.length >= 5 ? c : null)

function guardStub(block: () => string | null = () => null) {
  const trades: number[] = []
  const g: RiskGuard = {
    blockReason: block,
    riskPct: () => 0.01,
    updateEquity: () => {},
    recordTrade: (p) => void trades.push(p),
    state: () => ({ dayPnlPct: 0 }) as GuardState,
  }
  return { g, trades }
}

function logs() {
  const events: { event: string; data: Record<string, unknown> }[] = []
  const log: Log = (event, data = {}) => void events.push({ event, data })
  return { log, events }
}

function setup(opts: { findSetup?: FindSetup; supervisor?: Supervisor; guard?: RiskGuard; log?: Log } = {}) {
  const ex = new PaperExchange(meta, new Set(), { TMN: START })
  const strat = createIctStrategy({ findSetup: stub(), meta, ...opts })
  const history: Candle[] = []
  const feed = async (c: Candle) => {
    ex.onCandle(SYM, c)
    history.push(c)
    await strat.onBar({ symbol: SYM, bars: history, ex })
  }
  return { ex, strat, feed, history }
}

const buys = (ex: PaperExchange) => ex.fills.filter((f) => f.side === 'BUY')
const sellOrders = async (ex: PaperExchange) => (await ex.openOrders(SYM)).filter((o) => o.side === 'SELL')

// Bars 0..4 flat, entry order goes in on bar 4, fills on bar 5.
async function toFilled(feed: (c: Candle) => Promise<void>) {
  for (let i = 0; i < 5; i++) await feed(flat(i))
  await feed(bar(T0 + 5 * 60, 1, 1, 0.999, 1))
}

describe('ict strategy', () => {
  test('winning cycle: entry fills, TP limits placed, TP hit, gain about 2x risk', async () => {
    const guard = guardStub()
    const { events, log } = logs()
    const { ex, feed, strat } = setup({ guard: guard.g, log })
    await toFilled(feed)

    expect(buys(ex).length).toBe(1)
    const tps = await sellOrders(ex)
    expect(tps.length).toBe(2)
    expect(tps.every((o) => Math.abs(o.price - 1.06) < 1e-9)).toBe(true)
    const qty = buys(ex)[0]!.qty
    expect(tps.reduce((s, o) => s + o.quantity, 0)).toBe(qty)
    expect(Math.abs(tps[0]!.quantity - tps[1]!.quantity)).toBeLessThanOrEqual(1)
    expect(strat.openPositions()[0]!.qty).toBe(qty)

    await feed(bar(T0 + 6 * 60, 1, 1.07, 1, 1.065))
    expect(strat.openPositions().length).toBe(0)
    expect((await ex.openOrders()).length).toBe(0)

    const gain = (ex.equity() - START) / START
    const risk = 0.01
    expect(gain).toBeGreaterThan(0)
    expect(gain / risk).toBeGreaterThan(1.7)
    expect(gain / risk).toBeLessThan(2.3)
    expect(guard.trades.length).toBe(1)
    expect(guard.trades[0]!).toBeGreaterThan(0.015)
    expect(guard.trades[0]!).toBeCloseTo(gain, 3)
    for (const e of ['setup.accepted', 'entry.placed', 'entry.filled', 'tp.placed', 'exit']) expect(events.some((x) => x.event === e)).toBe(true)
    const orders = events.filter((x) => x.event === 'order.intent')
    expect(orders.every((x) => String(x.data.reason).length > 0)).toBe(true)
    const exit = events.find((x) => x.event === 'exit')!.data
    expect(exit.feeTmn).toBeGreaterThan(0)
    expect(exit).not.toHaveProperty('feeTmnEst')
    expect(String(orders[0]!.data.clientId)).toMatch(/^[A-Za-z0-9-]{1,36}$/)
  })

  test('after TP1 the stop moves to break-even and exits the rest', async () => {
    const { ex, feed, strat } = setup({ findSetup: stub(candidate({ tp2: 1.12 })) })
    await toFilled(feed)
    await feed(bar(T0 + 6 * 60, 1, 1.07, 1.03, 1.05))
    const pos = strat.openPositions()[0]!
    expect(pos.stop).toBeCloseTo(1.006, 6)
    expect(pos.qty).toBeLessThan(buys(ex)[0]!.qty)
    await feed(bar(T0 + 7 * 60, 1.05, 1.05, 1.0, 1.0))
    expect(strat.openPositions().length).toBe(0)
    expect((await ex.balances()).PEPE?.free ?? 0).toBe(0)
    expect(ex.equity()).toBeGreaterThan(START * 0.995)
  })

  test('stop-out loses between 0.9% and 1.0% of equity when the cap does not bind', async () => {
    const guard = guardStub()
    const { ex, feed, strat } = setup({ guard: guard.g })
    await toFilled(feed)
    await feed(bar(T0 + 6 * 60, 1, 1, 0.975, 0.98))
    expect(strat.openPositions().length).toBe(0)
    expect((await ex.openOrders()).length).toBe(0)
    const loss = (START - ex.equity()) / START
    expect(loss).toBeGreaterThan(0.009)
    expect(loss).toBeLessThan(0.0101)
    expect(guard.trades[0]!).toBeLessThan(-0.008)
  })

  test('tick below the stop exits without waiting for the bar', async () => {
    const { ex, feed, strat } = setup()
    await toFilled(feed)
    await strat.onTick!({ symbol: SYM, quote: { bid: 0.99, ask: 0.991 }, now: T0 + 400, ex })
    expect(strat.openPositions().length).toBe(1)
    ex.setQuote(SYM, 0.979, 0.98)
    await strat.onTick!({ symbol: SYM, quote: { bid: 0.979, ask: 0.98 }, now: T0 + 410, ex })
    expect(strat.openPositions().length).toBe(0)
    expect((await ex.balances()).PEPE?.free ?? 0).toBe(0)
  })

  test('pending entry is cancelled on expiry and funds are released', async () => {
    const { events, log } = logs()
    const c = candidate({ entry: 0.95, expiresAt: T0 + 8 * 60 })
    const { ex, feed, strat } = setup({ findSetup: stub(c), log })
    for (let i = 0; i < 6; i++) await feed(flat(i))
    expect((await ex.openOrders(SYM)).length).toBe(1)
    for (let i = 6; i < 12; i++) await feed(flat(i))
    expect((await ex.openOrders(SYM)).length).toBe(0)
    expect((await ex.balances()).TMN!.free).toBeCloseTo(START, 3)
    expect(strat.openPositions().length).toBe(0)
    const cancelled = events.find((x) => x.event === 'entry.cancelled')
    expect(cancelled?.data.reason).toBe('expired')
    expect(buys(ex).length).toBe(0)
  })

  test('pending entry is cancelled when disabled or invalidated', async () => {
    const a = setup({ findSetup: stub(candidate({ entry: 0.95 })) })
    for (let i = 0; i < 6; i++) await a.feed(flat(i))
    expect((await a.ex.openOrders(SYM)).length).toBe(1)
    a.strat.setEntriesEnabled!(false)
    await a.feed(flat(6))
    expect((await a.ex.openOrders(SYM)).length).toBe(0)

    const b = setup({ findSetup: stub(candidate({ entry: 0.95, invalidateBelow: 0.99 })) })
    for (let i = 0; i < 6; i++) await b.feed(flat(i))
    expect((await b.ex.openOrders(SYM)).length).toBe(1)
    await b.feed(bar(T0 + 6 * 60, 1, 1, 0.985, 0.985))
    expect((await b.ex.openOrders(SYM)).length).toBe(0)
  })

  test('supervisor veto blocks the order, resize halves the quantity', async () => {
    const verdict = (v: Partial<Verdict>): Supervisor => ({
      review: async () => ({ action: 'approve', sizeMult: 1, reason: 'test', source: 'ai', model: 'm', latencyMs: 1, ...v }),
      refreshNews: async () => null,
    })
    const run = async (sup?: Supervisor) => {
      const s = setup({ supervisor: sup, findSetup: stub(candidate({ entry: 0.95 })) })
      for (let i = 0; i < 6; i++) await s.feed(flat(i))
      return s.ex.openOrders(SYM)
    }
    const { events, log } = logs()
    const vetoed = setup({ supervisor: verdict({ action: 'veto', sizeMult: 0, reason: 'bad news' }), log, findSetup: stub(candidate({ entry: 0.95 })) })
    for (let i = 0; i < 6; i++) await vetoed.feed(flat(i))
    expect((await vetoed.ex.openOrders(SYM)).length).toBe(0)
    expect(events.find((x) => x.event === 'setup.rejected')?.data.reason).toBe('supervisor veto')

    const full = await run(verdict({ action: 'approve' }))
    const half = await run(verdict({ action: 'resize', sizeMult: 0.5 }))
    const over = await run(verdict({ action: 'resize', sizeMult: 3 }))
    expect(full.length).toBe(1)
    expect(half.length).toBe(1)
    expect(Math.abs(half[0]!.quantity - full[0]!.quantity / 2)).toBeLessThanOrEqual(1)
    expect(over[0]!.quantity).toBe(full[0]!.quantity)
  })

  test('guard.blockReason blocks entry', async () => {
    const { events, log } = logs()
    const guard = guardStub(() => 'daily loss halt')
    const { ex, feed } = setup({ guard: guard.g, log })
    for (let i = 0; i < 8; i++) await feed(flat(i))
    expect((await ex.openOrders()).length).toBe(0)
    const rej = events.filter((x) => x.event === 'setup.rejected')
    expect(rej.length).toBe(1)
    expect(String(rej[0]!.data.reason)).toContain('daily loss halt')
  })

  test('gates reject wide spread and poor net RR', async () => {
    const { events, log } = logs()
    const poor = setup({ findSetup: stub(candidate({ tp1: 1.03 })), log })
    for (let i = 0; i < 6; i++) await poor.feed(flat(i))
    expect((await poor.ex.openOrders()).length).toBe(0)
    expect(events.find((x) => x.event === 'setup.rejected')?.data.reason).toBe('net RR too low')

    const wide = setup({ log })
    for (let i = 0; i < 4; i++) await wide.feed(flat(i))
    wide.ex.onCandle(SYM, flat(4))
    wide.ex.setQuote(SYM, 0.98, 1)
    await wide.strat.onBar({ symbol: SYM, bars: [...wide.history, flat(4)], ex: wide.ex })
    expect((await wide.ex.openOrders()).length).toBe(0)
    expect(events.some((x) => x.data.reason === 'spread too wide')).toBe(true)
  })

  test('same setup is not re-entered after a stop-out', async () => {
    const { ex, feed, strat } = setup()
    await toFilled(feed)
    await feed(bar(T0 + 6 * 60, 1, 1, 0.975, 0.98))
    for (let i = 7; i < 15; i++) await feed(flat(i))
    expect(buys(ex).length).toBe(1)
    expect((await ex.openOrders()).length).toBe(0)
    expect(strat.openPositions().length).toBe(0)
  })

  test('max positions caps concurrent entries', async () => {
    const { ex, feed } = setup({ findSetup: stub(candidate({ entry: 0.95 })) })
    for (let i = 0; i < 6; i++) await feed(flat(i))
    expect((await ex.openOrders(SYM)).length).toBe(1)
    const s = createIctStrategy({ findSetup: stub(candidate({ entry: 0.95 })), meta, options: { maxPositions: 0 } })
    const ex2 = new PaperExchange(meta, new Set(), { TMN: START })
    const h: Candle[] = []
    for (let i = 0; i < 6; i++) {
      ex2.onCandle(SYM, flat(i))
      h.push(flat(i))
      await s.onBar({ symbol: SYM, bars: h, ex: ex2 })
    }
    expect((await ex2.openOrders()).length).toBe(0)
  })

  test('state round-trips through JSON and resumes managing the position', async () => {
    const a = setup()
    await toFilled(a.feed)
    const snap = JSON.parse(JSON.stringify(a.strat.getState()))
    expect(snap.positions[SYM]).toBeDefined()
    expect(snap.traded.length).toBe(1)

    const b: IctStrategy = createIctStrategy({ findSetup: stub(), meta })
    b.restoreState(snap)
    expect(b.openPositions()).toEqual(a.strat.openPositions())
    const bars = [...a.history]
    const c = bar(T0 + 6 * 60, 1, 1.07, 1, 1.065)
    a.ex.onCandle(SYM, c)
    bars.push(c)
    await b.onBar({ symbol: SYM, bars, ex: a.ex })
    expect(b.openPositions().length).toBe(0)
    expect((a.ex.equity() - START) / START).toBeGreaterThan(0.015)
    // restored traded keys block a re-entry
    for (let i = 7; i < 12; i++) {
      const f = flat(i)
      a.ex.onCandle(SYM, f)
      bars.push(f)
      await b.onBar({ symbol: SYM, bars, ex: a.ex })
    }
    expect(buys(a.ex).length).toBe(1)

    const p = createIctStrategy({ findSetup: stub(candidate({ entry: 0.95 })), meta })
    const ex = new PaperExchange(meta, new Set(), { TMN: START })
    const h: Candle[] = []
    for (let i = 0; i < 6; i++) {
      ex.onCandle(SYM, flat(i))
      h.push(flat(i))
      await p.onBar({ symbol: SYM, bars: h, ex })
    }
    const pendingSnap = JSON.parse(JSON.stringify(p.getState()))
    expect(Object.keys(pendingSnap.pending)).toEqual([SYM])
  })

  test('restoreState tolerates unknown input', () => {
    const s = createIctStrategy({ findSetup: stub(), meta })
    for (const bad of [undefined, null, 5, 'x', [], {}, { positions: 3, pending: [], traded: 'a' }, { positions: { X: { symbol: 1 } } }]) {
      s.restoreState(bad)
      expect(s.openPositions()).toEqual([])
    }
  })

  test('a rejected entry ack drops the setup', async () => {
    const { events, log } = logs()
    const { ex, feed } = setup({ log, findSetup: stub(candidate({ entry: 0.95 })) })
    ex.place = async (o) => ({ clientId: o.clientId, status: 'REJECTED', error: 'blocked' })
    for (let i = 0; i < 8; i++) await feed(flat(i))
    expect(events.filter((x) => x.event === 'entry.rejected').length).toBe(1)
  })
})
