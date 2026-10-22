import { cfg } from '../config'
import type { Balances, Exchange, Markets, OpenOrder, OrderAck, OrderReq, Quote } from '../types'
import type { WallexRest } from '../wallex/rest'
import { prepareOrder } from './validate'
import type { Log } from '../log'

// Dry run: real reads, real validation, the exact request is logged but never sent.
export class DryExchange implements Exchange {
  readonly mode = 'dry' as const

  constructor(
    private readonly rest: WallexRest,
    private readonly meta: Markets,
    private readonly blocked: Set<string>,
    private readonly log: Log,
  ) {}

  async balances(): Promise<Balances> {
    return this.rest.hasKey ? this.rest.balances() : { TMN: { free: cfg.startTmn, locked: 0 } }
  }

  quote(symbol: string): Promise<Quote> {
    return this.rest.depth(symbol)
  }

  async openOrders(): Promise<OpenOrder[]> {
    return []
  }

  async place(o: OrderReq): Promise<OrderAck> {
    const q = await this.rest.depth(o.symbol)
    const p = prepareOrder(this.meta[o.symbol], this.blocked, o, o.side === 'BUY' ? q.ask : q.bid)
    if (!p.ok) {
      this.log('dry.rejected', { clientId: o.clientId, error: p.error, reason: o.reason })
      return { clientId: o.clientId, status: 'REJECTED', error: p.error }
    }
    const bal = await this.balances()
    const m = this.meta[o.symbol]!
    const need = o.side === 'BUY' ? p.order.quantity * (p.order.price ?? q.ask) * (1 + cfg.takerFee) : p.order.quantity
    const have = bal[o.side === 'BUY' ? m.quote : m.base]?.free ?? 0
    if (have < need) {
      const error = `insufficient ${o.side === 'BUY' ? m.quote : m.base}: have ${have}, need ${need}`
      this.log('dry.rejected', { clientId: o.clientId, error })
      return { clientId: o.clientId, status: 'REJECTED', error }
    }
    this.log('dry.would_send', { method: 'POST', path: '/v1/account/orders', body: p.body, reason: o.reason, meta: o.meta })
    return { clientId: o.clientId, status: 'NEW' }
  }

  async cancel(clientId: string): Promise<void> {
    this.log('dry.would_send', { method: 'DELETE', path: '/v1/account/orders', body: { clientOrderId: clientId } })
  }
}
