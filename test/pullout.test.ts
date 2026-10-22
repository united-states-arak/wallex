import { expect, test } from 'bun:test'
import { PaperExchange } from '../src/exchange/paper'
import { planPullout, pullout } from '../src/pullout'
import { meta } from './fixtures'

function seeded() {
  const ex = new PaperExchange(meta, new Set(), { TMN: 100_000, PEPE: 10_000_000, XYZ: 100, USDT: 0.1 })
  ex.setQuote('PEPETMN', 1.19, 1.2)
  ex.setQuote('XYZUSDT', 3.0, 3.01)
  ex.setQuote('USDTTMN', 270_000, 270_100)
  return ex
}

test('plan routes TMN direct, USDT via USDTTMN, and flags dust', async () => {
  const plan = await planPullout(seeded(), meta)
  expect(plan.sells.map((h) => h.symbol).sort()).toEqual(['PEPETMN', 'XYZUSDT'])
  expect(plan.dust.map((h) => h.asset)).toEqual(['USDT'])
})

test('dry plan does not touch balances', async () => {
  const ex = seeded()
  const r = await pullout(ex, meta, { execute: false })
  expect(r.executed).toBe(false)
  expect((await ex.balances()).PEPE!.free).toBe(10_000_000)
})

test('execute converts every sellable asset into TMN', async () => {
  const ex = seeded()
  const r = await pullout(ex, meta, { execute: true, waitMs: 0 })
  const b = await ex.balances()
  expect(r.remaining).toEqual([])
  expect(b.PEPE!.free).toBe(0)
  expect(b.XYZ!.free).toBe(0)
  expect(b.USDT!.free).toBeLessThan(5)
  expect(b.TMN!.free).toBeGreaterThan(100_000 + 10_000_000 * 1.1)
})

test('resting orders are cancelled and their funds sold', async () => {
  const ex = seeded()
  await ex.place({ clientId: 'rest1', symbol: 'PEPETMN', side: 'SELL', type: 'LIMIT', price: 2, quantity: 5_000_000, reason: 'test' })
  expect((await ex.openOrders()).length).toBe(1)
  await pullout(ex, meta, { execute: true, waitMs: 0 })
  expect((await ex.openOrders()).length).toBe(0)
  expect((await ex.balances()).PEPE!.free + (await ex.balances()).PEPE!.locked).toBe(0)
})
