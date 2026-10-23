import { describe, expect, test } from 'bun:test'
import { orderSanity } from '../src/exchange/live'
import type { Log } from '../src/log'
import { runPoll } from '../src/runner/poll'
import { createTradeEngine, type Candidate, type SignalModel } from '../src/strategy/engine'
import type { Balances, Candle, Exchange, Markets, OpenOrder, OrderAck, OrderReq } from '../src/types'

// Order-lifecycle tests against a scripted exchange that behaves like live Wallex: the buy fee is taken in the base coin,
// sells lock their coins while they rest, and replies can be late, partial or lost.
const meta: Markets = { AAATMN: { symbol: 'AAATMN', base: 'AAA', quote: 'TMN', qtyDecimals: 2, priceDecimals: 2, minQty: 0.01, minNotional: 5_000, marketEnabled: false } }
const ID = 'bo_AAATMN_1'

class ScriptedExchange implements Exchange {
  readonly mode = 'live' as const
  bal: Balances = { TMN: { free: 10_000_000, locked: 0 }, AAA: { free: 0, locked: 0 } }
  q = { bid: 100, ask: 100.1 }
  open: OpenOrder[] = []
  placed: OrderReq[] = []
  acks: OrderAck[] = []
  cancelled: string[] = []
  onPlace?: (o: OrderReq) => OrderAck | Promise<OrderAck>
  onCancel?: (id: string) => void

  async balances() {
    return structuredClone(this.bal)
  }
  async quote() {
    return { ...this.q }
  }
  async openOrders(symbol?: string) {
    return this.open.filter((o) => !symbol || o.symbol === symbol).map((o) => ({ ...o }))
  }
  async place(o: OrderReq) {
    this.placed.push(o)
    const ack = this.onPlace ? await this.onPlace(o) : this.fill(o)
    this.acks.push(ack)
    return ack
  }
  async cancel(id: string) {
    this.onCancel?.(id)
    this.cancelled.push(id)
    const i = this.open.findIndex((o) => o.clientId === id)
    if (i < 0) return
    const [o] = this.open.splice(i, 1)
    if (o!.side === 'SELL') {
      this.bal.AAA!.locked -= o!.quantity
      this.bal.AAA!.free += o!.quantity
    }
  }
  // Default: everything fills at once. Buys are credited net of the 0.3% fee, like live Wallex.
  fill(o: OrderReq): OrderAck {
    if (o.side === 'BUY') {
      this.bal.TMN!.free -= o.quantity * o.price!
      this.bal.AAA!.free += o.quantity * 0.997
      return { clientId: o.clientId, status: 'FILLED', filledQty: o.quantity }
    }
    if (o.quantity > this.bal.AAA!.free + 1e-9) return { clientId: o.clientId, status: 'REJECTED', error: 'insufficient balance' }
    this.bal.AAA!.free -= o.quantity
    this.bal.TMN!.free += o.quantity * o.price!
    return { clientId: o.clientId, status: 'FILLED', filledQty: o.quantity }
  }
  // A sell that fills only `part` of its quantity and rests with the remainder locked.
  rest(o: OrderReq, part: number): OrderAck {
    if (o.quantity > this.bal.AAA!.free + 1e-9) return { clientId: o.clientId, status: 'REJECTED', error: 'insufficient balance' }
    const remaining = o.quantity - part
    this.bal.AAA!.free -= o.quantity
    this.bal.AAA!.locked += remaining
    this.bal.TMN!.free += part * o.price!
    this.open.push({ clientId: o.clientId, symbol: o.symbol, side: 'SELL', price: o.price!, quantity: remaining })
    return { clientId: o.clientId, status: 'NEW', filledQty: part }
  }
}

const T0 = 1_700_000_000 - (1_700_000_000 % 3600)
const bar = (i: number, c = 100, l = c - 0.5): Candle => ({ t: T0 + i * 60, o: c, h: c + 0.5, l, c, v: 1 })

// Fires one candidate on the first bar it sees.
function oneShot(c: Partial<Candidate> = {}): SignalModel {
  let fired = false
  return {
    name: 'm',
    update() {},
    signal() {
      if (fired) return null
      fired = true
      return { model: 'm', entryRef: 100, stop: 95, timeStopBars: 10_000, rationale: 'test', features: {}, ...c }
    },
  }
}

function setup(o: { model?: SignalModel; options?: Record<string, number>; log?: Log } = {}) {
  const events: { event: string; data: Record<string, any> }[] = []
  const log: Log = o.log ?? ((event, data = {}) => void events.push({ event, data }))
  const ex = new ScriptedExchange()
  const engine = createTradeEngine('t', [o.model ?? oneShot()], { meta, log, fees: { maker: 0.0025, taker: 0.003 }, options: o.options })
  let i = 0
  const bars: Candle[] = []
  const step = async (c = 100, l = c - 0.5) => {
    bars.push(bar(i++, c, l))
    await engine.onBar({ symbol: 'AAATMN', bars, ex })
  }
  const of = (name: string) => events.filter((e) => e.event === name)
  return { ex, engine, events, step, of }
}

const openTrade = (over: Record<string, unknown> = {}) => ({
  positions: {
    AAATMN: { id: ID, symbol: 'AAATMN', model: 'm', phase: 'open', qty: 1000, entry: 100, stop: 95, initialStop: 95, timeStopBars: 10_000, baseBefore: 0, barsSince: 0, barsHeld: 0, high: 100, exitTries: 0, exitBid: 0, exitReason: '', equityAtEntry: 10_000_000, openedAt: 0, lastLoggedStop: 95, ...over },
  },
})

describe('trade engine order lifecycle', () => {
  test('a partly filled exit is cancelled before the retry, so the remainder is not refused for locked coins', async () => {
    const r = setup()
    r.engine.restoreState(openTrade())
    r.ex.bal.AAA = { free: 1000, locked: 0 }
    r.ex.q = { bid: 94, ask: 94.1 }
    r.ex.onPlace = (o) => (o.clientId.endsWith('_x1') ? r.ex.rest(o, 500) : r.ex.fill(o))
    await r.step(94, 93.5) // stop hit: x1 sells half and rests with the rest
    await r.step(94, 93.5) // retry
    expect(r.ex.cancelled).toContain(`${ID}_x1`)
    const x2 = r.ex.placed.find((o) => o.clientId === `${ID}_x2`)!
    expect(x2.quantity).toBe(500)
    expect(r.ex.acks.find((a) => a.clientId === `${ID}_x2`)!.status).toBe('FILLED')
    await r.step(94)
    expect(r.of('exit')).toHaveLength(1)
    expect(r.engine.openPositions()).toHaveLength(0)
  })

  test('a take-profit whose cancel failed is cancelled again on the next exit attempt', async () => {
    const r = setup()
    r.engine.restoreState(openTrade({ tp: 110, tpId: `${ID}_tp` }))
    r.ex.bal.AAA = { free: 0, locked: 1000 }
    r.ex.open.push({ clientId: `${ID}_tp`, symbol: 'AAATMN', side: 'SELL', price: 110, quantity: 1000 })
    let failures = 1
    r.ex.onCancel = () => {
      if (failures-- > 0) throw new Error('network timeout')
    }
    r.ex.q = { bid: 94, ask: 94.1 }
    await r.step(94, 93.5)
    expect(r.ex.acks.find((a) => a.clientId === `${ID}_x1`)!.status).toBe('REJECTED')
    await r.step(94, 93.5)
    expect(r.ex.open).toHaveLength(0)
    expect(r.ex.acks.find((a) => a.clientId === `${ID}_x2`)!.status).toBe('FILLED')
    await r.step(94)
    expect(r.of('exit')[0]!.data.how).toBe('stop')
  })

  test('a FILLED entry whose coins have not reached the balance yet is kept, not forgotten', async () => {
    const r = setup()
    let credit = 0
    r.ex.onPlace = (o) => {
      if (o.side !== 'BUY') return r.ex.fill(o)
      credit = o.quantity * 0.997
      return { clientId: o.clientId, status: 'FILLED', filledQty: o.quantity }
    }
    await r.step()
    expect(r.of('entry.unconfirmed')).toHaveLength(1)
    expect(r.of('entry.cancelled')).toHaveLength(0)
    r.ex.bal.AAA!.free += credit
    await r.step()
    const pos = r.engine.openPositions()
    expect(pos).toHaveLength(1)
    expect(pos[0]!.qty).toBeCloseTo(credit, 6)
  })

  test('an entry reported FILLED that never shows up is dropped after a few bars', async () => {
    const r = setup()
    r.ex.onPlace = (o) => ({ clientId: o.clientId, status: 'FILLED', filledQty: o.quantity })
    for (let k = 0; k < 4; k++) await r.step()
    expect(r.of('entry.cancelled')).toHaveLength(1)
    expect(r.engine.getState()).toMatchObject({ positions: {}, pending: {} })
  })

  test('an entry whose reply was lost but which did fill is adopted with its stop', async () => {
    const r = setup()
    r.ex.onPlace = (o) => {
      r.ex.fill(o)
      throw new Error('request timed out')
    }
    await r.step()
    expect(r.of('entry.uncertain')).toHaveLength(1)
    expect(r.of('entry.filled')).toHaveLength(1)
    expect(r.engine.openPositions()).toMatchObject([{ symbol: 'AAATMN', stop: 95 }])
  })

  test('the position is booked at the average fill the exchange reports', async () => {
    const r = setup()
    r.ex.onPlace = (o) => ({ ...r.ex.fill(o), ...(o.side === 'BUY' ? { avgPrice: 100.05 } : {}) })
    await r.step()
    expect(r.engine.openPositions()[0]!.entry).toBe(100.05)
  })

  test('a clean rejection is still just a rejection', async () => {
    const r = setup()
    r.ex.onPlace = (o) => ({ clientId: o.clientId, status: 'REJECTED', error: 'insufficient balance' })
    await r.step()
    expect(r.of('entry.rejected')).toHaveLength(1)
    expect(r.engine.getState()).toMatchObject({ positions: {}, pending: {} })
  })

  test('a position that vanished without a resting take-profit is not booked as a take-profit win', async () => {
    const r = setup()
    r.engine.restoreState(openTrade({ tp: 110 }))
    r.ex.bal.AAA = { free: 0, locked: 0 } // sold by hand
    await r.step()
    const exit = r.of('exit')[0]!.data
    expect(exit.how).toBe('closed')
    expect(r.of('tp.filled')).toHaveLength(0)
  })

  test('a remainder that no exit order can sell frees its slot instead of retrying forever', async () => {
    const r = setup()
    r.engine.restoreState(openTrade({ qty: 50.2 }))
    r.ex.bal.AAA = { free: 50.2, locked: 0 } // 5,020 TMN at the bid, 4,995 at the first exit price
    await r.step(100, 94)
    expect(r.of('exit.unsellable')).toHaveLength(1)
    expect(r.ex.placed.filter((o) => o.side === 'SELL')).toHaveLength(0)
    expect(r.engine.openPositions()).toHaveLength(0)
  })

  test('a failed cancel of an expired entry keeps it pending instead of throwing', async () => {
    const r = setup({ model: { name: 'm', update() {}, signal: () => null } })
    r.engine.restoreState({ pending: { AAATMN: { ...openTrade().positions.AAATMN, phase: 'pending', barsSince: 59 } } })
    r.ex.open.push({ clientId: ID, symbol: 'AAATMN', side: 'BUY', price: 100, quantity: 1000 })
    r.ex.onCancel = () => {
      throw new Error('network timeout')
    }
    await r.step()
    expect(r.of('order.cancel_failed')).toHaveLength(1)
    expect(Object.keys((r.engine.getState() as { pending: object }).pending)).toEqual(['AAATMN'])
    r.ex.onCancel = undefined
    await r.step()
    expect(r.ex.open).toHaveLength(0)
    expect(r.of('entry.cancelled')).toHaveLength(1)
  })

  test('entries are sized below risk.maxOrderTmn instead of being refused by the live adapter', async () => {
    const r = setup({ options: { maxOrderTmn: 1_000_000 } })
    await r.step()
    const buy = r.ex.placed.find((o) => o.side === 'BUY')!
    expect(buy.quantity * buy.price!).toBeLessThanOrEqual(1_000_000)
    expect(r.of('entry.filled')).toHaveLength(1)
  })

  test('a failing log sink does not lose a placed entry', async () => {
    const r = setup({
      log: () => {
        throw new Error('disk full')
      },
    })
    await r.step()
    expect(r.engine.openPositions()).toHaveLength(1)
  })

  test('saved trades that cannot be restored are logged, never dropped silently', () => {
    const r = setup()
    const st = openTrade()
    delete (st.positions.AAATMN as Record<string, unknown>).baseBefore
    r.engine.restoreState(st)
    expect(r.engine.openPositions()).toHaveLength(0)
    expect(r.of('state.restore_skipped')).toHaveLength(1)
  })
})

test('order sanity also caps the value of a market buy', () => {
  const limits = { maxOrderTmn: 3_000_000, maxPriceDeviation: 0.03 }
  const o = { clientId: 'x', symbol: 'DOGETMN', side: 'BUY' as const, type: 'MARKET' as const, quantity: 40_000, reason: 't' }
  expect(orderSanity(o, { bid: 100, ask: 101 }, limits)).toMatch(/maxOrderTmn/)
  expect(orderSanity({ ...o, quantity: 100 }, { bid: 100, ask: 101 }, limits)).toBeNull()
  expect(orderSanity({ ...o, side: 'SELL' }, { bid: 100, ask: 101 }, limits)).toBeNull()
})

test('a market without warm-up bars is polled over a bounded range, not from 1970', async () => {
  const froms: number[] = []
  const now = Math.floor(Date.now() / 1000)
  await runPoll({
    rest: {
      history: async (_s: string, from: number) => {
        froms.push(from)
        return []
      },
    },
    symbols: ['AAATMN'],
    strategy: { name: 'noop', onBar: () => [] },
    ex: new ScriptedExchange(),
    log: () => {},
    durationMs: 0,
    pollMs: 0,
    once: true,
  })
  expect(froms).toHaveLength(2)
  expect(froms[1]!).toBeGreaterThan(now - 2 * 86_400)
})
