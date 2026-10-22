import type { Candle, MarketMeta, Markets } from '../src/types'

const m = (symbol: string, base: string, quote: string, qtyDecimals: number, priceDecimals: number, minNotional: number, minQty = 0): MarketMeta => ({
  symbol, base, quote, qtyDecimals, priceDecimals, minQty, minNotional, marketEnabled: false,
})

export const meta: Markets = {
  PEPETMN: m('PEPETMN', 'PEPE', 'TMN', 0, 4, 50_000, 1),
  XYZUSDT: m('XYZUSDT', 'XYZ', 'USDT', 2, 4, 5, 0.01),
  USDTTMN: m('USDTTMN', 'USDT', 'TMN', 2, 0, 50_000, 0.01),
}

export const bar = (t: number, o: number, h: number, l: number, c: number): Candle => ({ t, o, h, l, c, v: 1 })
