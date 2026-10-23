// Step 4: exit with a marketable LIMIT SELL at the bid (as the stop-exit does). Verify fill and flatness.
import { balances, getOrder, log, meta, nz, openOrders, place, quote, saveLat, show } from './lib'
import { floorTo } from '../../src/exchange/validate'

const symbol = process.argv[2] ?? 'BTCTMN'
const tag = process.argv[3] ?? 's1'
const m = meta[symbol]!
const b0 = await balances()
const held = (b0[m.base]?.free ?? 0) + (b0[m.base]?.locked ?? 0)
show('balances before', nz(b0))
const q = await quote(symbol)
const price = q.bid
const quantity = floorTo(held, m.qtyDecimals)
const clientId = `probe-${Date.now().toString(36)}-${tag}`
show('quote', q)
show('order', { symbol, price, quantity, notional: price * quantity, clientId })
const ack = await place({ clientId, symbol, side: 'SELL', price, quantity, reason: 'probe step4: marketable limit sell at bid (stop-exit path) to flatten' })
show('ack', ack)
if (ack.status === 'REJECTED') {
  saveLat()
  process.exit(2)
}
await Bun.sleep(1000)
const go = await getOrder(clientId)
show('getOrder', go.json?.result)
show('open', await openOrders())
const b1 = await balances()
show('balances after', nz(b1))
show('delta', { tmnGot: b1.TMN!.free + b1.TMN!.locked - (b0.TMN!.free + b0.TMN!.locked), baseLeft: (b1[m.base]?.free ?? 0) + (b1[m.base]?.locked ?? 0) })
log('probe.step4.done', { clientId, symbol, order: go.json?.result })
saveLat()
