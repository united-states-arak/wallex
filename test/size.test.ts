import { expect, test } from 'bun:test'
import { positionSize } from '../src/risk/size'

const base = { equity: 5_000_000, qtyDecimals: 0, minNotional: 50_000, makerFee: 0.0025, takerFee: 0.003, slipPct: 0.001 }

test('stop-out loses 1% of equity when the cap does not bind', () => {
  for (const s of [0.015, 0.02, 0.025]) {
    const entry = 1.2
    const r = positionSize({ ...base, entry, stop: entry * (1 - s) })
    expect(r.ok).toBe(true)
    expect(r.capped).toBe(false)
    expect(r.lossPct).toBeGreaterThan(0.0099)
    expect(r.lossPct).toBeLessThanOrEqual(0.01)
  }
})

test('wider stop gives a smaller position', () => {
  const a = positionSize({ ...base, entry: 1.2, stop: 1.2 * 0.98 })
  const b = positionSize({ ...base, entry: 1.2, stop: 1.2 * 0.975 })
  expect(b.notional).toBeLessThan(a.notional)
})

test('cap binds on a tight stop and risk stays below 1%', () => {
  const r = positionSize({ ...base, entry: 1.2, stop: 1.2 * 0.99 })
  expect(r.capped).toBe(true)
  expect(r.notional).toBeLessThanOrEqual(2_500_000)
  expect(r.lossPct).toBeLessThan(0.01)
})

test('skips a position below minNotional', () => {
  const r = positionSize({ ...base, equity: 100_000, entry: 1.2, stop: 1.2 * 0.98 })
  expect(r.ok).toBe(false)
})

test('rejects a stop above entry', () => {
  expect(positionSize({ ...base, entry: 1.2, stop: 1.3 }).ok).toBe(false)
})
