// ICT-plus: the incumbent detector (sweep + MSS + FVG retrace, and BOS continuation) with a different risk shape.
// The detector's structural stop is only 1% to 2.5% away, which is inside normal short-term noise and not far above the
// round-trip cost (0.5% fees plus spread). Entries are kept as they are, but the stop is a fixed distance below entry and the
// single take-profit is a multiple of that distance, so fixed costs are a small share of each trade.
import { createKitStrategy } from '../kit'
import { findSetup } from '../../src/ict/detect'
import type { Markets } from '../../src/types'

const STOP = 0.05 // stop distance below entry (fraction)
const MULT = 2.5 // take-profit at MULT * stop distance above entry
const RISK = 0.015 // equity lost if the stop is hit (kit caps at 0.02)
const EXPIRE = 60 // 1m bars a resting entry waits for its retrace before it is cancelled

export default function create(ctx: { meta: Markets }) {
  const traded = new Set<string>()
  return createKitStrategy({
    name: 'ict-plus',
    meta: ctx.meta,
    signal({ symbol, bars }) {
      const last = bars[bars.length - 1]!
      if ((last.t + 60) % 300 !== 0) return null // the detector input only changes when a 5m bar closes
      const s = findSetup(symbol, bars)
      if (!s) return null
      const key = `${symbol}:${s.sweep.t}:${s.fvg.t}`
      if (traded.has(key)) return null
      traded.add(key)
      const stop = Math.min(s.stop, s.entry * (1 - STOP))
      return { entry: s.entry, stop, tp: s.entry + MULT * (s.entry - stop), expireBars: EXPIRE, riskPct: RISK, tag: s.model }
    },
  })
}
