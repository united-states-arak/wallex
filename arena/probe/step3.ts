// Step 3: resting take-profit LIMIT SELL a few % above market for the held quantity; verify open + locked; cancel via LiveExchange.
import { balances, cancel, getOrder, log, meta, nz, openOrders, place, quote, rest, saveLat, show } from './lib'
import { floorTo } from '../../src/exchange/validate'

const symbol = process.argv[2] ?? 'BTCTMN'
const m = meta[symbol]!
const b0 = await balances()
const held = (b0[m.base]?.free ?? 0) + (b0[m.base]?.locked ?? 0)
show('balances before', nz(b0))
const q = await quote(symbol)
const price = Math.floor(q.ask * 1.03)
const quantity = floorTo(held, m.qtyDecimals)
const clientId = `probe-${Date.now().toString(36)}-tp`
show('order', { symbol, price, quantity, notional: price * quantity, clientId })
const ack = await place({ clientId, symbol, side: 'SELL', price, quantity, reason: 'probe step3: resting take-profit sell 3% above ask to test locked balance' })
show('ack', ack)
if (ack.status === 'REJECTED') {
  saveLat()
  process.exit(2)
}
await Bun.sleep(500)
const open = await openOrders()
show('open', open)
const mine = open.find((o) => o.clientId === clientId)
show('match', { found: !!mine, ok: mine && mine.side === 'SELL' && mine.price === price && mine.quantity === quantity })
const r: any = await rest.rawBalances()
show('raw base/TMN while resting', { [m.base]: { value: r.balances[m.base].value, locked: r.balances[m.base].locked }, TMN: { value: r.balances.TMN.value, locked: r.balances.TMN.locked } })
show('parsed while resting', nz(await balances()))
const c = await cancel(clientId, 'probe step3: cancel take-profit', 'ex')
show('cancel', c)
await Bun.sleep(500)
show('open after', await openOrders())
show('getOrder', (await getOrder(clientId)).json?.result?.status)
show('balances after', nz(await balances()))
log('probe.step3.done', { clientId })
saveLat()
