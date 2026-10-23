// Step 1: passive LIMIT BUY ~5% below bid at ~min notional, verify in open orders, cancel, verify gone.
import { balances, cancel, getOrder, log, meta, nz, openOrders, place, quote, rawOpen, saveLat, show } from './lib'

const symbol = process.argv[2] ?? 'BTCTMN'
const idStyle = process.argv[3] ?? 'hyphen'
const m = meta[symbol]!
const b0 = await balances()
show('balances before', nz(b0))
const q = await quote(symbol)
const price = Math.floor(q.bid * 0.95)
const quantity = Math.ceil(((m.minNotional * 1.1) / price) * 10 ** m.qtyDecimals) / 10 ** m.qtyDecimals
const ts = Date.now().toString(36)
const clientId = idStyle === 'hyphen' ? `probe-${ts}-p1` : `probe_${ts}_p1`
show('quote', q)
show('order', { symbol, price, quantity, notional: price * quantity, clientId })
const ack = await place({ clientId, symbol, side: 'BUY', price, quantity, reason: 'probe step1: passive buy 5% below bid to test place + open-orders parser' })
show('ack', ack)
if (ack.status === 'REJECTED') {
  saveLat()
  process.exit(2)
}
await Bun.sleep(500)
show('raw open orders', await rawOpen())
const open = await openOrders()
show('parsed open orders', open)
const mine = open.find((o) => o.clientId === clientId)
show('match', { found: !!mine, ok: mine && mine.symbol === symbol && mine.side === 'BUY' && mine.price === price && mine.quantity === quantity })
const go = await getOrder(clientId)
show('getOrder', { status: go.status, ms: go.ms, rl: go.rl, json: go.json })
const b1 = await balances()
show('balances while resting', nz(b1))
const c = await cancel(clientId, 'probe step1: cancel passive buy')
show('cancel', c)
await Bun.sleep(500)
const after = await openOrders()
show('open after cancel', after)
const go2 = await getOrder(clientId)
show('getOrder after cancel', { status: go2.status, json: go2.json })
show('balances after', nz(await balances()))
log('probe.step1.done', { clientId, gone: !after.some((o) => o.clientId === clientId) })
saveLat()
