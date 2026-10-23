import { isSecureUrl, readCapped } from '../security/http'
import { redactString } from '../security/redact'
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

const MAX_RESPONSE_BYTES = 8_000_000 // the full market list is about 1 MB
const SYMBOL = /^[A-Z0-9]{2,20}$/
const CLIENT_ID = /^[A-Za-z0-9_-]{1,64}$/

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
  ) {
    // The API key travels in a header, so the exchange must be reached over TLS.
    if (!isSecureUrl(base)) throw new WallexError(`wallex.baseUrl must use https: ${base}`, 0, null)
  }

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
      // never follow a redirect: it could carry the key header to another host
      redirect: 'error',
    })
    const text = await readCapped(res, MAX_RESPONSE_BYTES)
    let json: any
    try {
      json = JSON.parse(text)
    } catch {
      json = text
    }
    if (!res.ok || json?.success === false) {
      const detail = redactString(String(json?.message ?? '')).slice(0, 300)
      throw new WallexError(`${method} ${url.pathname} -> ${res.status} ${detail}`.trim(), res.status, json)
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
        // Verified live: TMN markets report minNotional in rial (50000) while the exchange enforces 5,000 toman
        // ("حداقل معامله ... 5000 تومان است"), and orders of 6,286 TMN were accepted. Stored in toman.
        minNotional: s.quoteAsset === 'TMN' ? num(s.minNotional) / 10 : num(s.minNotional),
        marketEnabled: Boolean(s.isMarketTypeEnable),
      }
      out[m.symbol] = m
    }
    return out
  }

  async depth(symbol: string): Promise<Quote> {
    if (!SYMBOL.test(symbol)) throw new WallexError(`invalid symbol ${JSON.stringify(symbol)}`, 0, null)
    const j = await this.req('GET', '/v1/depth', { query: { symbol } })
    const bids: number[] = (j.result.bid ?? []).map((x: any) => num(x.price))
    const asks: number[] = (j.result.ask ?? []).map((x: any) => num(x.price))
    if (!bids.length || !asks.length) throw new WallexError(`empty book for ${symbol}`, 200, j)
    return { bid: Math.max(...bids), ask: Math.min(...asks) }
  }

  async history(symbol: string, fromSec: number, toSec: number): Promise<Candle[]> {
    if (!SYMBOL.test(symbol)) throw new WallexError(`invalid symbol ${JSON.stringify(symbol)}`, 0, null)
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
    return (await this.req('GET', '/v1/account/openOrders', { auth: true, query: { symbol, per_page: 100 } })).result
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
    if (!CLIENT_ID.test(clientId)) throw new WallexError(`invalid client id ${JSON.stringify(clientId)}`, 0, null)
    return (await this.req('DELETE', '/v1/account/orders', { auth: true, body: { clientOrderId: clientId } })).result
  }

  // One order by client id, with its real fills and fee (the cancel reply reports fee 0 even for a filled order).
  async order(clientId: string): Promise<unknown> {
    if (!CLIENT_ID.test(clientId)) throw new WallexError(`invalid client id ${JSON.stringify(clientId)}`, 0, null)
    return (await this.req('GET', `/v1/account/orders/${encodeURIComponent(clientId)}`, { auth: true })).result
  }
}

// Response shapes verified against the live API (balances: `value` is the total including `locked`).
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
