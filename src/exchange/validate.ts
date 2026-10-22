import { readFileSync } from 'node:fs'
import { cfg } from '../config'
import type { MarketMeta, OrderReq } from '../types'

export const floorTo = (x: number, decimals: number) => {
  const f = 10 ** decimals
  return Math.floor(x * f + 1e-9) / f
}

export const roundTo = (x: number, decimals: number) => {
  const f = 10 ** decimals
  return Math.round(x * f) / f
}

export function loadBlocked(file = cfg.blockedFile): Set<string> {
  return new Set(
    readFileSync(file, 'utf8')
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean),
  )
}

export type Prepared = { ok: true; order: OrderReq; body: Record<string, string> } | { ok: false; error: string }

export function prepareOrder(
  meta: MarketMeta | undefined,
  blocked: Set<string>,
  o: OrderReq,
  refPrice: number,
): Prepared {
  const fail = (error: string): Prepared => ({ ok: false, error })
  if (!meta) return fail(`unknown market ${o.symbol}`)
  if (o.side === 'BUY' && blocked.has(o.symbol)) return fail(`market ${o.symbol} is not allowed in the challenge`)
  if (o.type === 'MARKET' && !meta.marketEnabled) return fail(`market orders disabled on ${o.symbol}, use a marketable limit`)

  const quantity = floorTo(o.quantity, meta.qtyDecimals)
  if (!(quantity > 0) || quantity < meta.minQty) return fail(`quantity ${quantity} below min ${meta.minQty}`)

  let price: number | undefined
  if (o.type === 'LIMIT') {
    price = o.price === undefined ? NaN : roundTo(o.price, meta.priceDecimals)
    if (!(price > 0)) return fail('limit order needs a positive price')
  }

  const notional = quantity * (price ?? refPrice)
  if (notional < meta.minNotional) return fail(`notional ${Math.round(notional)} below min ${meta.minNotional}`)

  const order: OrderReq = { ...o, quantity, price }
  const body: Record<string, string> = {
    symbol: o.symbol,
    type: o.type,
    side: o.side,
    quantity: quantity.toFixed(meta.qtyDecimals),
    client_id: o.clientId,
  }
  if (price !== undefined) body.price = price.toFixed(meta.priceDecimals)
  return { ok: true, order, body }
}
