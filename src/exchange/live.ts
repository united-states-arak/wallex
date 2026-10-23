import type { Balances, Exchange, Markets, OpenOrder, OrderAck, OrderReq, Quote } from '../types'
import { WallexError, type WallexRest } from '../wallex/rest'
import { prepareOrder } from './validate'
import { nullLog, type Log } from '../log'
import { getSettings } from '../settings'

const num = (v: unknown) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

// Reads the order object Wallex returns from place (HTTP 201). A marketable order comes back already FILLED.
// The average price is executedSum / executedQty: `executedPrice` echoes the limit price, not the fill.
export function parsePlaceResult(clientId: string, r: unknown): OrderAck {
  const o = (r ?? {}) as Record<string, unknown>
  const status = String(o.status ?? '').toUpperCase()
  const filledQty = num(o.executedQty)
  const avgPrice = filledQty > 0 ? num(o.executedSum) / filledQty : undefined
  return { clientId, status: status === 'FILLED' ? 'FILLED' : 'NEW', ...(filledQty > 0 ? { filledQty, avgPrice } : {}) }
}

// Last line of defence before an order leaves the process, independent of the strategy and its sizing: a BUY that is
// far larger than the account could use, or priced far away from the live book, is refused. SELL orders are never
// blocked so a position can always be closed (stop exits and pullout use deliberate discounts up to 12%).
export function orderSanity(o: OrderReq, q: Quote, limits: { maxOrderTmn: number; maxPriceDeviation: number }): string | null {
  if (o.side !== 'BUY') return null
  // A market buy has no price of its own: value it at the ask so the size cap still applies.
  const value = (o.type === 'LIMIT' && o.price !== undefined ? o.price : q.ask) * o.quantity
  if (o.symbol.endsWith('TMN') && value > limits.maxOrderTmn) return `order value ${Math.round(value)} TMN above risk.maxOrderTmn ${limits.maxOrderTmn}`
  if (o.type !== 'LIMIT' || o.price === undefined) return null
  if (q.ask > 0 && o.price > q.ask * (1 + limits.maxPriceDeviation)) return `buy price ${o.price} more than ${limits.maxPriceDeviation * 100}% above the ask ${q.ask}`
  if (q.bid > 0 && o.price < q.bid * 0.5) return `buy price ${o.price} less than half the bid ${q.bid}`
  return null
}

export class LiveExchange implements Exchange {
  readonly mode = 'live' as const

  constructor(
    private readonly rest: WallexRest,
    private readonly meta: Markets,
    private readonly blocked: Set<string>,
    private readonly log: Log = nullLog,
  ) {}

  balances(): Promise<Balances> {
    return this.rest.balances()
  }

  quote(symbol: string): Promise<Quote> {
    return this.rest.depth(symbol)
  }

  openOrders(symbol?: string): Promise<OpenOrder[]> {
    return this.rest.openOrders(symbol)
  }

  async place(o: OrderReq): Promise<OrderAck> {
    const q = o.side === 'BUY' || o.price === undefined ? await this.rest.depth(o.symbol) : null
    const ref = o.price ?? q![o.side === 'BUY' ? 'ask' : 'bid']
    const p = prepareOrder(this.meta[o.symbol], this.blocked, o, ref)
    if (!p.ok) return { clientId: o.clientId, status: 'REJECTED', error: p.error }
    if (q) {
      const R = getSettings().risk
      const refused = orderSanity(p.order, q, { maxOrderTmn: R.maxOrderTmn, maxPriceDeviation: R.maxPriceDeviation })
      if (refused) {
        this.log('exchange.order_refused', { body: p.body, reason: refused, bid: q.bid, ask: q.ask })
        return { clientId: o.clientId, status: 'REJECTED', error: `safety check: ${refused}` }
      }
    }
    const t0 = performance.now()
    try {
      const result = await this.rest.placeOrder(p.body)
      const ack = parsePlaceResult(o.clientId, result)
      this.log('exchange.place', { body: p.body, ms: Math.round(performance.now() - t0), status: ack.status, filledQty: ack.filledQty, avgPrice: ack.avgPrice, result })
      return ack
    } catch (e) {
      const error = e instanceof WallexError ? e.message : String(e)
      this.log('exchange.place_failed', { body: p.body, error, detail: e instanceof WallexError ? e.body : undefined })
      return { clientId: o.clientId, status: 'REJECTED', error }
    }
  }

  async cancel(clientId: string): Promise<void> {
    await this.rest.cancelOrder(clientId)
    this.log('exchange.cancel', { clientId })
  }
}
