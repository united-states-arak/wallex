import { getSettings } from '../settings'
import type { Balances, Candle, MarketMeta, Markets, OpenOrder, Quote, Side } from '../types'

export class WallexError extends Error {
  constructor(message: string, readonly status: number, readonly body: unknown) {
    super(message)
  }
}

const num = (v: unknown) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

interface ReqOpts {
  query?: Record<string, string | number | undefined>
  body?: unknown
  auth?: boolean
}

export class WallexRest {
  constructor(
    private readonly key = getSettings().wallex.apiKey,
    private readonly base = getSettings().wallex.baseUrl,
    private readonly timeoutMs = getSettings().wallex.requestTimeoutMs,
  ) {}

  get hasKey() {
    return this.key.length > 0
  }

  private async req(method: string, path: string, opts: ReqOpts = {}): Promise<any> {
    const url = new URL(path, this.base)
    for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v))
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (opts.auth) {
      if (!this.key) throw new WallexError('WALLEX_API_KEY is not set', 0, null)
      headers['x-api-key'] = this.key
    }
    const res = await fetch(url, {
      method,
      headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      signal: AbortSignal.timeout(this.timeoutMs),
    })
    const text = await res.text()
    let json: any
    try {
      json = JSON.parse(text)
    } catch {
      json = text
    }
    if (!res.ok || json?.success === false) {
      throw new WallexError(`${method} ${path} -> ${res.status} ${json?.message ?? ''}`.trim(), res.status, json)
    }
    return json
  }

  async markets(): Promise<Markets> {
    const j = await this.req('GET', '/v1/markets')
    const out: Markets = {}
    for (const s of Object.values<any>(j.result.symbols)) {
      const m: MarketMeta = {
        symbol: s.symbol,
        base: s.baseAsset,
        quote: s.quoteAsset,
        qtyDecimals: num(s.stepSize),
        priceDecimals: num(s.tickSize),
        minQty: num(s.minQty),
        minNotional: num(s.minNotional),
        marketEnabled: Boolean(s.isMarketTypeEnable),
      }
      out[m.symbol] = m
    }
    return out
  }

  async depth(symbol: string): Promise<Quote> {
    const j = await this.req('GET', '/v1/depth', { query: { symbol } })
    const bids: number[] = (j.result.bid ?? []).map((x: any) => num(x.price))
    const asks: number[] = (j.result.ask ?? []).map((x: any) => num(x.price))
    if (!bids.length || !asks.length) throw new WallexError(`empty book for ${symbol}`, 200, j)
    return { bid: Math.max(...bids), ask: Math.min(...asks) }
  }

  async history(symbol: string, fromSec: number, toSec: number): Promise<Candle[]> {
    const j = await this.req('GET', '/v1/udf/history', { query: { symbol, resolution: '1', from: fromSec, to: toSec } })
    if (j.s !== 'ok') return []
    return j.t.map((t: number, i: number) => ({
      t: Number(t),
      o: num(j.o[i]),
      h: num(j.h[i]),
      l: num(j.l[i]),
      c: num(j.c[i]),
      v: num(j.v[i]),
    }))
  }

  async rawBalances(): Promise<unknown> {
    return (await this.req('GET', '/v1/account/balances', { auth: true })).result
  }

  async rawOpenOrders(symbol?: string): Promise<unknown> {
    return (await this.req('GET', '/v1/account/openOrders', { auth: true, query: { symbol } })).result
  }

  async balances(): Promise<Balances> {
    return parseBalances(await this.rawBalances())
  }

  async openOrders(symbol?: string): Promise<OpenOrder[]> {
    return parseOpenOrders(await this.rawOpenOrders(symbol))
  }

  async placeOrder(body: Record<string, string>): Promise<unknown> {
    return (await this.req('POST', '/v1/account/orders', { auth: true, body })).result
  }

  async cancelOrder(clientId: string): Promise<unknown> {
    return (await this.req('DELETE', '/v1/account/orders', { auth: true, body: { clientOrderId: clientId } })).result
  }
}

// Response shapes of the private endpoints are not verified yet. Run `bun run check` with a real key.
export function parseBalances(result: any): Balances {
  const raw = result?.balances ?? result ?? {}
  const entries: [string, any][] = Array.isArray(raw)
    ? raw.map((x: any) => [String(x.asset ?? x.symbol), x])
    : Object.entries(raw).map(([k, v]: [string, any]) => [String(v?.asset ?? k), v])
  const out: Balances = {}
  for (const [asset, v] of entries) {
    const total = num(v?.value ?? v?.total ?? v?.balance)
    const locked = num(v?.locked)
    out[asset] = { free: Math.max(0, total - locked), locked }
  }
  return out
}

export function parseOpenOrders(result: any): OpenOrder[] {
  const list: any[] = result?.orders ?? (Array.isArray(result) ? result : [])
  return list.map((o) => ({
    clientId: String(o.clientOrderId ?? o.client_id ?? o.clientId),
    symbol: String(o.symbol),
    side: String(o.side).toUpperCase() as Side,
    price: num(o.price),
    quantity: num(o.origQty ?? o.quantity),
  }))
}
