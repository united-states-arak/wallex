// Washout bounce (mean reversion). Long only.
// When a market drops 3.5% or more within an hour (measured on closed 15m bars), buy at the ask and rest a maker
// limit sell 4% above. Stop 6% below, time stop after 8 hours. No entry while most of the basket is falling together.
import { createKitStrategy } from '../kit'
import type { Candle, Markets, Strategy } from '../../src/types'

const P = {
  tf: 15, // signal bar minutes
  lb: 60, // return lookback in minutes
  drop: 0.035, // enter when the lookback return is at or below -drop
  tpPct: 0.04, // maker limit sell this far above entry
  stopPct: 0.06, // stop this far below entry (also sets the position size through the kit's risk rule)
  holdBars: 32, // time stop, in signal bars (8h)
  breadthDrop: 0.02, // a market counts as "falling" if its lookback return is below -this
  breadthMax: 0.5, // skip entries when more than this share of the basket is falling
  risk: 0.02, // equity at risk per trade (kit maximum)
}

interface Sym {
  b: number
  h: number
  l: number
  c: number
  closes: number[]
  fresh: number // timestamp of the 1m bar on which the last signal bar closed
  ret: number
}

export default function create(ctx: { meta: Markets }): Strategy {
  const S = new Map<string, Sym>()
  const sec = P.tf * 60
  const k = Math.max(1, Math.round(P.lb / P.tf))

  function finalize(x: Sym, t: number) {
    x.closes.push(x.c)
    if (x.closes.length > k + 2) x.closes.shift()
    const cl = x.closes
    if (cl.length <= k) return
    x.ret = x.c / cl[cl.length - 1 - k]! - 1
    x.fresh = t
  }

  function update(symbol: string, c: Candle) {
    let x = S.get(symbol)
    if (!x) {
      x = { b: -1, h: 0, l: 0, c: 0, closes: [], fresh: -1, ret: 0 }
      S.set(symbol, x)
    }
    const b = Math.floor(c.t / sec)
    if (b !== x.b) {
      if (x.b >= 0) finalize(x, c.t) // bucket ended without its last minute (data gap)
      x.b = b
    }
    x.c = c.c
    if (c.t % sec === sec - 60) {
      finalize(x, c.t)
      x.b = -2 // bucket done; the next bar opens a new one
    }
  }

  const inner = createKitStrategy({
    name: 'mean-reversion',
    meta: ctx.meta,
    signal({ symbol, bars }) {
      const x = S.get(symbol)!
      if (x.fresh !== bars[bars.length - 1]!.t || x.ret > -P.drop) return null
      let falling = 0
      let total = 0
      for (const y of S.values()) {
        if (y.fresh < 0) continue
        total++
        if (y.ret < -P.breadthDrop) falling++
      }
      if (total > 0 && falling / total > P.breadthMax) return null
      const entry = x.c
      return {
        entry,
        stop: entry * (1 - P.stopPct),
        tp: entry * (1 + P.tpPct),
        taker: true,
        timeStopBars: P.holdBars * P.tf,
        riskPct: P.risk,
        tag: 'washout',
      }
    },
  })

  return {
    name: inner.name,
    setEntriesEnabled: inner.setEntriesEnabled,
    async onBar(a) {
      update(a.symbol, a.bars[a.bars.length - 1]!)
      return inner.onBar(a)
    },
  }
}
