// A deliberately plain example of the kit: buy when the 15m close crosses above its 20-bar average, stop under the
// recent low, 2R target. It is a template, not a contender. Copy it, then replace `signal`.
import { createKitStrategy } from '../kit'
import { aggregate } from '../../src/data/candles'
import type { Markets } from '../../src/types'

export default function create(ctx: { meta: Markets }) {
  return createKitStrategy({
    name: 'example-sma',
    meta: ctx.meta,
    signal({ bars }) {
      if (bars.length < 600) return null
      const m15 = aggregate(bars.slice(-700), 15, bars[bars.length - 1]!.t + 60) // closed 15m bars only
      if (m15.length < 25) return null
      const closes = m15.map((b) => b.c)
      const sma = (end: number) => closes.slice(end - 20, end).reduce((s, x) => s + x, 0) / 20
      const n = closes.length
      const crossed = closes[n - 2]! <= sma(n - 1) && closes[n - 1]! > sma(n)
      const last = bars[bars.length - 1]!
      if (!crossed || last.t % 900 !== 840) return null // act once, on the last minute of the 15m bar
      const low = Math.min(...m15.slice(-6).map((b) => b.l))
      const entry = last.c
      if (entry - low < entry * 0.01 || entry - low > entry * 0.04) return null
      return { entry, stop: low * 0.999, tp: entry + 2 * (entry - low), taker: true, timeStopBars: 360 }
    },
  })
}
