// Step 2: marketable LIMIT BUY at the ask for ~min notional. Verify fill via balances and the order record.
import { balances, getOrder, log, meta, nz, openOrders, place, quote, rest, saveLat, show } from './lib'

const symbol = process.argv[2] ?? 'BTCTMN'
const tag = process.argv[3] ?? 'b1'
const m = meta[symbol]!
const rawBal = async () => {
  const r: any = await rest.rawBalances()
  return Object.fromEntries([m.base, 'TMN'].map((a) => [a, { value: r.balances[a]?.value, locked: r.balances[a]?.locked }]))
}
const b0 = await balances()
show('balances before', nz(b0))
const q = await quote(symbol)
const price = q.ask
const quantity = Math.ceil(((m.minNotional * 1.1) / price) * 10 ** m.qtyDecimals) / 10 ** m.qtyDecimals
const clientId = `probe-${Date.now().toString(36)}-${tag}`
show('quote', q)
show('order', { symbol, price, quantity, notional: price * quantity, clientId })
const ack = await place({ clientId, symbol, side: 'BUY', price, quantity, reason: 'probe step2: marketable limit buy at ask to test fills' })
show('ack', ack)
if (ack.status === 'REJECTED') {
  saveLat()
  process.exit(2)
}
await Bun.sleep(1000)
const go = await getOrder(clientId)
show('getOrder', { status: go.status, json: go.json })
show('open orders', await openOrders())
show('raw balances (base,TMN)', await rawBal())
const b1 = await balances()
show('balances after', nz(b1))
const tmnSpent = b0.TMN!.free + b0.TMN!.locked - (b1.TMN!.free + b1.TMN!.locked)
const baseGot = (b1[m.base]?.free ?? 0) + (b1[m.base]?.locked ?? 0) - ((b0[m.base]?.free ?? 0) + (b0[m.base]?.locked ?? 0))
show('delta', { tmnSpent, baseGot, ordered: quantity, impliedFeeBase: quantity - baseGot })
log('probe.step2.done', { clientId, symbol, tmnSpent, baseGot, order: go.json?.result })
saveLat()
