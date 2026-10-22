import { getSettings } from '../settings'
import type { Balances, Candle, Exchange, Markets, OpenOrder, OrderAck, OrderReq, Quote } from '../types'
import { prepareOrder } from './validate'

const eps = (x: number) => Math.abs(x) * 1e-9 + 1e-12

export interface Fill {
  t: number
  clientId: string
  symbol: string
  side: 'BUY' | 'SELL'
  price: number
  qty: number
  fee: number
  role: 'maker' | 'taker'
  reason: string
}

interface Resting extends OpenOrder {
  lock: number
  lockAsset: string
  reason: string
}

// Fees are charged in the quote asset for both sides. Limit fills need price to trade
// through the level by one tick. The spread around a candle close is an assumption (paper.spreadBps).
export class PaperExchange implements Exchange {
  readonly mode = 'paper' as const
  readonly fills: Fill[] = []
  now = Math.floor(Date.now() / 1000)
  private bal: Balances = {}
  private resting = new Map<string, Resting>()
  private quotes = new Map<string, Quote>()

  private readonly spreadBps: number
  private readonly slippageBps: number

  constructor(
    private readonly meta: Markets,
    private readonly blocked: Set<string> = new Set(),
    seed: Record<string, number> = { TMN: getSettings().paper.startTmn },
    private readonly fees = { maker: getSettings().fees.maker, taker: getSettings().fees.taker },
    assumptions: { spreadBps?: number; slippageBps?: number } = {},
  ) {
    this.spreadBps = assumptions.spreadBps ?? getSettings().paper.spreadBps
    this.slippageBps = assumptions.slippageBps ?? getSettings().paper.slippageBps
    for (const [asset, free] of Object.entries(seed)) this.bal[asset] = { free, locked: 0 }
  }

  async balances(): Promise<Balances> {
    return structuredClone(this.bal)
  }

  async quote(symbol: string): Promise<Quote> {
    const q = this.quotes.get(symbol)
    if (!q) throw new Error(`no quote for ${symbol}`)
    return q
  }

  async openOrders(symbol?: string): Promise<OpenOrder[]> {
    return [...this.resting.values()]
      .filter((r) => !symbol || r.symbol === symbol)
      .map(({ clientId, symbol, side, price, quantity }) => ({ clientId, symbol, side, price, quantity }))
  }

  setQuote(symbol: string, bid: number, ask: number) {
    this.quotes.set(symbol, { bid, ask })
  }

  onCandle(symbol: string, c: Candle) {
    this.now = c.t + 60
    const half = (this.spreadBps / 10_000) / 2
    this.quotes.set(symbol, { bid: c.c * (1 - half), ask: c.c * (1 + half) })
    const m = this.meta[symbol]
    if (!m) return
    const tick = 10 ** -m.priceDecimals
    for (const r of [...this.resting.values()]) {
      if (r.symbol !== symbol) continue
      const crossed = r.side === 'BUY' ? c.l <= r.price - tick : c.h >= r.price + tick
      if (crossed) this.fill(r, r.price, 'maker', true)
    }
  }

  async place(o: OrderReq): Promise<OrderAck> {
    const q = this.quotes.get(o.symbol)
    if (!q) return this.reject(o, `no quote for ${o.symbol}`)
    const p = prepareOrder(this.meta[o.symbol], this.blocked, o, o.side === 'BUY' ? q.ask : q.bid)
    if (!p.ok) return this.reject(o, p.error)
    const m = this.meta[o.symbol]!
    const ord = p.order
    const slip = this.slippageBps / 10_000

    const marketable =
      ord.type === 'MARKET' || (ord.side === 'BUY' ? ord.price! >= q.ask : ord.price! <= q.bid)
    if (marketable) {
      const px = ord.type === 'MARKET' ? (ord.side === 'BUY' ? q.ask * (1 + slip) : q.bid * (1 - slip)) : ord.side === 'BUY' ? q.ask : q.bid
      const cost = ord.quantity * px
      if (ord.side === 'BUY' && (this.bal[m.quote]?.free ?? 0) < cost * (1 + this.fees.taker)) return this.reject(o, 'insufficient funds')
      if (ord.side === 'SELL' && (this.bal[m.base]?.free ?? 0) < ord.quantity - eps(ord.quantity)) return this.reject(o, 'insufficient funds')
      const r: Resting = { clientId: ord.clientId, symbol: ord.symbol, side: ord.side, price: px, quantity: ord.quantity, lock: 0, lockAsset: '', reason: o.reason }
      this.fill(r, px, 'taker', false)
      return { clientId: ord.clientId, status: 'FILLED', filledQty: ord.quantity, avgPrice: px }
    }

    const lockAsset = ord.side === 'BUY' ? m.quote : m.base
    const lock = ord.side === 'BUY' ? ord.quantity * ord.price! * (1 + this.fees.maker) : ord.quantity
    const b = (this.bal[lockAsset] ??= { free: 0, locked: 0 })
    if (b.free < lock - eps(lock)) return this.reject(o, 'insufficient funds')
    b.free = Math.max(0, b.free - lock)
    b.locked += lock
    this.resting.set(ord.clientId, { clientId: ord.clientId, symbol: ord.symbol, side: ord.side, price: ord.price!, quantity: ord.quantity, lock, lockAsset, reason: o.reason })
    return { clientId: ord.clientId, status: 'NEW' }
  }

  async cancel(clientId: string): Promise<void> {
    const r = this.resting.get(clientId)
    if (!r) return
    const b = this.bal[r.lockAsset]!
    b.locked -= r.lock
    b.free += r.lock
    this.resting.delete(clientId)
  }

  equity(): number {
    let total = 0
    for (const [asset, b] of Object.entries(this.bal)) {
      const qty = b.free + b.locked
      if (qty === 0) continue
      if (asset === 'TMN') total += qty
      else total += qty * this.tmnBid(asset)
    }
    return total
  }

  private tmnBid(asset: string): number {
    const direct = this.quotes.get(`${asset}TMN`)
    if (direct) return direct.bid
    const usdt = this.quotes.get(`${asset}USDT`)
    const rate = this.quotes.get('USDTTMN')
    return usdt && rate ? usdt.bid * rate.bid : 0
  }

  private reject(o: OrderReq, error: string): OrderAck {
    return { clientId: o.clientId, status: 'REJECTED', error }
  }

  private fill(r: Resting, price: number, role: 'maker' | 'taker', fromLock: boolean) {
    const m = this.meta[r.symbol]!
    const rate = role === 'maker' ? this.fees.maker : this.fees.taker
    const gross = r.quantity * price
    const fee = gross * rate
    const quote = (this.bal[m.quote] ??= { free: 0, locked: 0 })
    const base = (this.bal[m.base] ??= { free: 0, locked: 0 })
    if (r.side === 'BUY') {
      if (fromLock) quote.locked -= r.lock
      else quote.free -= gross + fee
      if (fromLock) quote.free += r.lock - gross - fee
      base.free += r.quantity
    } else {
      if (fromLock) base.locked -= r.lock
      else base.free -= r.quantity
      quote.free += gross - fee
    }
    this.resting.delete(r.clientId)
    this.fills.push({ t: this.now, clientId: r.clientId, symbol: r.symbol, side: r.side, price, qty: r.quantity, fee, role, reason: r.reason })
  }
}
