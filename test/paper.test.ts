import { expect, test } from 'bun:test'
import { aggregate } from '../src/data/candles'
import { PaperExchange } from '../src/exchange/paper'
import { prepareOrder } from '../src/exchange/validate'
import { runBacktest } from '../src/runner/backtest'
import { nullLog } from '../src/log'
import type { Strategy } from '../src/types'
import { bar, meta } from './fixtures'

test('limit buy fills only when price trades through by one tick, with maker fee', async () => {
  const ex = new PaperExchange(meta, new Set(), { TMN: 1_000_000 }, { maker: 0.0025, taker: 0.003 })
  ex.onCandle('PEPETMN', bar(0, 1.2, 1.2, 1.2, 1.2))
  const ack = await ex.place({ clientId: 'b1', symbol: 'PEPETMN', side: 'BUY', type: 'LIMIT', price: 1.1, quantity: 100_000, reason: 't' })
  expect(ack.status).toBe('NEW')
  ex.onCandle('PEPETMN', bar(60, 1.2, 1.2, 1.1, 1.15))
  expect(ex.fills.length).toBe(0)
  ex.onCandle('PEPETMN', bar(120, 1.15, 1.15, 1.0999, 1.12))
  expect(ex.fills.length).toBe(1)
  expect(ex.fills[0]!.role).toBe('maker')
  expect(ex.fills[0]!.fee).toBeCloseTo(100_000 * 1.1 * 0.0025, 6)
})

test('order on bar i never fills from bar i', async () => {
  const strat: Strategy = {
    name: 'buy-once',
    onBar: ({ bars }) =>
      bars.length === 1 ? [{ clientId: 'x1', symbol: 'PEPETMN', side: 'BUY', type: 'LIMIT', price: 1.1, quantity: 100_000, reason: 'test' }] : [],
  }
  const bars = { PEPETMN: [bar(0, 1.2, 1.2, 1.0, 1.2), bar(60, 1.2, 1.2, 1.2, 1.2)] }
  const s = await runBacktest({ bars, meta, blocked: new Set(), strategy: strat, log: nullLog, startTmn: 1_000_000 })
  expect(s.fills).toBe(0)
})

test('backtest buys, then flattens to TMN with fees counted', async () => {
  const strat: Strategy = {
    name: 'buy-once',
    onBar: ({ bars }) =>
      bars.length === 1 ? [{ clientId: 'x1', symbol: 'PEPETMN', side: 'BUY', type: 'LIMIT', price: 1.1, quantity: 100_000, reason: 'test' }] : [],
  }
  const bars = { PEPETMN: [bar(0, 1.2, 1.2, 1.2, 1.2), bar(60, 1.2, 1.2, 1.05, 1.12), bar(120, 1.12, 1.3, 1.12, 1.3)] }
  const s = await runBacktest({ bars, meta, blocked: new Set(), strategy: strat, log: nullLog, startTmn: 1_000_000 })
  expect(s.fills).toBeGreaterThanOrEqual(2)
  expect(s.feesTmn).toBeGreaterThan(0)
  expect(s.endTmn).toBeGreaterThan(900_000)
})

test('prepareOrder enforces blocked market, min notional, rounding', () => {
  const o = { clientId: 'c', symbol: 'PEPETMN', side: 'BUY' as const, type: 'LIMIT' as const, price: 1.23456, quantity: 100_000.9, reason: 't' }
  const ok = prepareOrder(meta.PEPETMN, new Set(), o, 1.2)
  expect(ok.ok && ok.body.price).toBe('1.2346')
  expect(ok.ok && ok.body.quantity).toBe('100000')
  expect(prepareOrder(meta.PEPETMN, new Set(['PEPETMN']), o, 1.2).ok).toBe(false)
  expect(prepareOrder(meta.PEPETMN, new Set(), { ...o, quantity: 100 }, 1.2).ok).toBe(false)
  expect(prepareOrder(meta.PEPETMN, new Set(['PEPETMN']), { ...o, side: 'SELL' }, 1.2).ok).toBe(true)
})

test('aggregate builds closed buckets only', () => {
  const bars = Array.from({ length: 7 }, (_, i) => bar(i * 60, 1, 1 + i, 1 - i * 0.01, 1 + i * 0.1))
  const five = aggregate(bars, 5, 7 * 60)
  expect(five.length).toBe(1)
  expect(five[0]!.h).toBe(5)
  expect(five[0]!.o).toBe(1)
})
