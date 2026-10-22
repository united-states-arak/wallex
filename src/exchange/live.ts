import type { Balances, Exchange, Markets, OpenOrder, OrderAck, OrderReq, Quote } from '../types'
import { WallexError, type WallexRest } from '../wallex/rest'
import { prepareOrder } from './validate'
import { nullLog, type Log } from '../log'

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
    const ref = o.price ?? (await this.rest.depth(o.symbol))[o.side === 'BUY' ? 'ask' : 'bid']
    const p = prepareOrder(this.meta[o.symbol], this.blocked, o, ref)
    if (!p.ok) return { clientId: o.clientId, status: 'REJECTED', error: p.error }
    const t0 = performance.now()
    try {
      const result = await this.rest.placeOrder(p.body)
      this.log('exchange.place', { body: p.body, ms: Math.round(performance.now() - t0), result })
      return { clientId: o.clientId, status: 'NEW' }
    } catch (e) {
      const error = e instanceof WallexError ? e.message : String(e)
      this.log('exchange.place_failed', { body: p.body, error })
      return { clientId: o.clientId, status: 'REJECTED', error }
    }
  }

  async cancel(clientId: string): Promise<void> {
    await this.rest.cancelOrder(clientId)
    this.log('exchange.cancel', { clientId })
  }
}
