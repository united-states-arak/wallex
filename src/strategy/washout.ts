import { getSettings } from '../settings'
import type { Candle } from '../types'
import type { SignalModel } from './engine'

export interface WashoutParams {
  signalMinutes: number
  lookbackMinutes: number
  dropPct: number
  takeProfitPct: number
  stopPct: number
  maxHoldMinutes: number
  crashDropPct: number
  crashBreadthMax: number
  riskMult: number
}

interface Sym {
  bucket: number
  close: number
  closes: number[] // closes of finished signal bars
  fresh: number // time of the 1m bar on which the last signal bar closed
  ret: number // return over the lookback, on closed signal bars
}

// Washout bounce: when a market falls fast (3.5% or more in an hour on closed 15m bars) it tends to retrace part of the
// move within hours. Buy at once, rest a take-profit limit 4% above, stop 6% below, time stop 8 hours. No entry while
// most of the basket is falling together (a market-wide crash, not an overshoot).
export function createWashoutModel(options: Partial<WashoutParams> = {}): SignalModel {
  const p: WashoutParams = { ...getSettings().strategy.washout, ...options }
  const sec = p.signalMinutes * 60
  const k = Math.max(1, Math.round(p.lookbackMinutes / p.signalMinutes))
  const syms = new Map<string, Sym>()

  const finish = (x: Sym, t: number) => {
    x.closes.push(x.close)
    if (x.closes.length > k + 2) x.closes.shift()
    if (x.closes.length <= k) return
    x.ret = x.close / x.closes[x.closes.length - 1 - k]! - 1
    x.fresh = t
  }

  const step = (symbol: string, c: Candle) => {
    let x = syms.get(symbol)
    if (!x) {
      x = { bucket: -1, close: 0, closes: [], fresh: -1, ret: 0 }
      syms.set(symbol, x)
    }
    const b = Math.floor(c.t / sec)
    if (b !== x.bucket) {
      if (x.bucket >= 0) finish(x, c.t) // the previous bucket ended without its last minute (data gap)
      x.bucket = b
    }
    x.close = c.c
    if (c.t % sec === sec - 60) {
      finish(x, c.t)
      x.bucket = -2
    }
  }

  return {
    name: 'washout',
    primeDays: 1,
    prime(symbol, bars) {
      syms.delete(symbol)
      for (const c of bars.slice(-(k + 3) * p.signalMinutes)) step(symbol, c)
    },
    update: (symbol, bars) => step(symbol, bars[bars.length - 1]!),
    signal(symbol: string, bars: Candle[]) {
      const x = syms.get(symbol)
      const last = bars[bars.length - 1]!
      if (!x || x.fresh !== last.t || x.ret > -p.dropPct) return null
      let falling = 0
      let total = 0
      for (const y of syms.values()) {
        if (y.fresh < 0) continue
        total++
        if (y.ret < -p.crashDropPct) falling++
      }
      const breadth = total > 0 ? falling / total : 0
      if (breadth > p.crashBreadthMax) return null
      const ref = x.close
      const pct = (v: number) => `${(v * 100).toFixed(1)}%`
      return {
        model: 'washout',
        entryRef: ref,
        stop: ref * (1 - p.stopPct),
        tp: ref * (1 + p.takeProfitPct),
        timeStopBars: p.maxHoldMinutes,
        riskMult: p.riskMult,
        rationale:
          `Washout: the price fell ${pct(-x.ret)} in ${p.lookbackMinutes} minutes (closed ${p.signalMinutes}m bars) while only ${pct(breadth)} of markets are falling, ` +
          `so the drop is specific to this market and tends to retrace. Target ${pct(p.takeProfitPct)} above, stop ${pct(p.stopPct)} below, time stop ${p.maxHoldMinutes / 60} h.`,
        features: { dropPct: Number((-x.ret * 100).toFixed(2)), lookbackMinutes: p.lookbackMinutes, marketsFallingPct: Math.round(breadth * 100), targetPctFromRef: p.takeProfitPct * 100, stopPctFromRef: p.stopPct * 100 },
      }
    },
  }
}
