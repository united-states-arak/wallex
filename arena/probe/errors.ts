// Error shapes: cancel a filled order, cancel an unknown id, get an unknown id, place below min notional (passive price).
import { WallexError } from '../../src/wallex/rest'
import { balances, getOrder, log, nz, openOrders, quote, rest, saveLat, show, timed } from './lib'

const err = (e: unknown) => (e instanceof WallexError ? { message: e.message, status: e.status, body: e.body } : String(e))
for (const id of ['probe-mvl4mkgh-s1', 'probe-does-not-exist-xyz']) {
  log('probe.cancel', { clientId: id, reason: 'probe errors: cancel a filled/unknown order to see the error shape' })
  try {
    show(`cancel ${id}`, await timed('cancel', () => rest.cancelOrder(id)))
  } catch (e) {
    show(`cancel ${id} threw`, err(e))
  }
}
const g = await getOrder('probe-does-not-exist-xyz')
show('getOrder unknown', { status: g.status, json: g.json })
const q = await quote('BTCTMN')
const body = { symbol: 'BTCTMN', type: 'LIMIT', side: 'BUY', quantity: '0.00000001', client_id: `probe-${Date.now().toString(36)}-tiny`, price: String(Math.floor(q.bid * 0.95)) }
log('probe.order', { ...body, reason: 'probe errors: passive order below min notional (~210 TMN) to see the rejection shape' })
try {
  show('place tiny result', await timed('place', () => rest.placeOrder(body)))
} catch (e) {
  show('place tiny threw', err(e))
}
const open = await openOrders()
show('open', open)
for (const o of open) if (o.clientId === body.client_id) show('cancel tiny', await rest.cancelOrder(o.clientId))
show('balances', nz(await balances()))
saveLat()
