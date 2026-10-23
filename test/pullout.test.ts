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

test('plan sells through TMN markets only, never a USDT-quoted market, and flags dust', async () => {
  const plan = await planPullout(seeded(), meta)
  expect(plan.sells.map((h) => h.symbol)).toEqual(['PEPETMN'])
  expect(plan.unroutable).toEqual(['XYZ'])
  expect(plan.dust.map((h) => h.asset)).toEqual(['USDT'])
  expect(plan.dust[0]!.qty).toBe(0.1) // dust shows the real holding, not the floored sell quantity
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
  expect(b.XYZ!.free).toBe(100) // no TMN market: reported as unroutable and left alone
  expect(r.unroutable).toEqual(['XYZ'])
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

test('a failing cancel does not stop the pullout', async () => {
  const ex = seeded()
  await ex.place({ clientId: 'rest2', symbol: 'PEPETMN', side: 'SELL', type: 'LIMIT', price: 2, quantity: 1_000_000, reason: 'test' })
  const real = ex.cancel.bind(ex)
  let failed = false
  ex.cancel = async (id: string) => {
    if (!failed) {
      failed = true
      throw new Error('404 not_found_error')
    }
    return real(id)
  }
  const events: string[] = []
  const r = await pullout(ex, meta, { execute: true, waitMs: 0, log: (e) => void events.push(e) })
  expect(events).toContain('pullout.cancel_failed')
  expect(r.executed).toBe(true)
})
