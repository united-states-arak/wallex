// Is the real minimum notional 5,000 TMN (exchange error text) or 50,000 (market metadata)? Passive order, cancelled at once.
import { WallexError } from '../../src/wallex/rest'
import { log, openOrders, quote, rest, saveLat, show, timed } from './lib'

const q = await quote('BTCTMN')
for (const qty of ['0.0000003', '0.000001']) {
  const price = Math.floor(q.bid * 0.95)
  const body = { symbol: 'BTCTMN', type: 'LIMIT', side: 'BUY', quantity: qty, client_id: `probe-${Date.now().toString(36)}-mn`, price: String(price) }
  log('probe.order', { ...body, notional: Math.round(price * Number(qty)), reason: 'probe: test real min notional with a passive buy, cancel immediately' })
  try {
    const r: any = await timed('place', () => rest.placeOrder(body))
    show(`qty ${qty} notional ${Math.round(price * Number(qty))} accepted`, { status: r.status })
    await Bun.sleep(300)
    show('cancel', ((await rest.cancelOrder(body.client_id)) as any).status)
  } catch (e) {
    show(`qty ${qty} notional ${Math.round(price * Number(qty))} rejected`, e instanceof WallexError ? e.body : String(e))
  }
  await Bun.sleep(300)
}
show('open', await openOrders())
saveLat()
