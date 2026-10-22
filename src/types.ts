export interface Candle {
  t: number
  o: number
  h: number
  l: number
  c: number
  v: number
}

export type Side = 'BUY' | 'SELL'

export interface OrderReq {
  clientId: string
  symbol: string
  side: Side
  type: 'LIMIT' | 'MARKET'
  price?: number
  quantity: number
  reason: string
  meta?: Record<string, unknown>
}

export interface OrderAck {
  clientId: string
  status: 'NEW' | 'FILLED' | 'REJECTED'
  error?: string
  filledQty?: number
  avgPrice?: number
}

export interface OpenOrder {
  clientId: string
  symbol: string
  side: Side
  price: number
  quantity: number
}

export interface Balance {
  free: number
  locked: number
}

export type Balances = Record<string, Balance>

export interface Quote {
  bid: number
  ask: number
}

export interface MarketMeta {
  symbol: string
  base: string
  quote: string
  qtyDecimals: number
  priceDecimals: number
  minQty: number
  minNotional: number
  marketEnabled: boolean
}

export type Markets = Record<string, MarketMeta>

export interface Exchange {
  readonly mode: 'live' | 'dry' | 'paper'
  balances(): Promise<Balances>
  quote(symbol: string): Promise<Quote>
  place(o: OrderReq): Promise<OrderAck>
  cancel(clientId: string): Promise<void>
  openOrders(symbol?: string): Promise<OpenOrder[]>
}

export interface BarCtx {
  symbol: string
  bars: Candle[]
  ex: Exchange
}

export interface TickCtx {
  symbol: string
  quote: Quote
  now: number
  ex: Exchange
}

export interface Strategy {
  name: string
  onBar(ctx: BarCtx): Promise<OrderReq[]> | OrderReq[]
  // Optional fast path (live and shadow only): check stops between candles using the live quote.
  onTick?(ctx: TickCtx): Promise<OrderReq[]> | OrderReq[]
  // Optional: stop opening new positions (end of run). Existing positions are still managed.
  setEntriesEnabled?(enabled: boolean): void
}
