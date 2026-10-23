import { aggregate } from '../../data/candles'
import type { Candle } from '../../types'

export interface BreakoutParams {
  lookbackHours: number
  emaHours: number
  atrHours: number
  stopAtr: number
  trailAtr: number
  volumeMult: number
  maxChaseAtr: number
  breadthMin: number
  breadthEmaHours: number
  maxHoldHours: number
}

// Per-market hourly state, built incrementally from closed 1m bars. Only closed hours feed the indicators.
export interface HourState {
  hours: Candle[] // closed 1h bars, oldest first (at most 400)
  cur: Candle | null // the hour still forming
  hour: number // index of the forming hour (unix hours)
  atr: number // Wilder ATR over closed hours
  ema: number // trend EMA
  emaPrev: number
  slow: number // slow EMA used by the market breadth gate
  seen: number // closed hours seen
  fresh: boolean // true on the first 1m bar after an hour closed
  booted: boolean
}

export interface BreakoutSignal {
  entryRef: number // last 1m close
  stop: number
  level: number // the broken lookback high
  atr: number
  ema: number
  volumeRatio: number
  breadth: number
  hourClose: number
  rationale: string
}

const MAX_HOURS = 400
const BREADTH_MIN_HOURS = 96

// All markets share one tracker so the breadth gate sees the whole basket.
export class HourlyTracker {
  private readonly syms = new Map<string, HourState>()

  constructor(private readonly p: BreakoutParams) {}

  state(symbol: string): HourState | undefined {
    return this.syms.get(symbol)
  }

  private get(symbol: string): HourState {
    let x = this.syms.get(symbol)
    if (!x) {
      x = { hours: [], cur: null, hour: -1, atr: 0, ema: 0, emaPrev: 0, slow: 0, seen: 0, fresh: false, booted: false }
      this.syms.set(symbol, x)
    }
    return x
  }

  private closeHour(x: HourState, b: Candle) {
    const prev = x.hours[x.hours.length - 1]
    x.hours.push(b)
    if (x.hours.length > MAX_HOURS) x.hours.shift()
    const tr = prev ? Math.max(b.h - b.l, Math.abs(b.h - prev.c), Math.abs(b.l - prev.c)) : b.h - b.l
    x.atr = x.atr === 0 ? tr : (x.atr * (this.p.atrHours - 1) + tr) / this.p.atrHours
    const a = 2 / (this.p.emaHours + 1)
    x.emaPrev = x.ema
    x.ema = x.ema === 0 ? b.c : x.ema + a * (b.c - x.ema)
    const sa = 2 / (this.p.breadthEmaHours + 1)
    x.seen++
    x.slow = x.slow === 0 ? b.c : x.slow + sa * (b.c - x.slow)
    x.fresh = true
  }

  // Seeds a market from a long 1m history (startup warm-up). Only complete hours are used.
  prime(symbol: string, bars: Candle[]) {
    if (!bars.length) return
    const x = this.get(symbol)
    x.hours = []
    x.atr = x.ema = x.emaPrev = x.slow = 0
    x.seen = 0
    const hour = Math.floor(bars[bars.length - 1]!.t / 3600)
    for (const b of aggregate(bars, 60, hour * 3600)) this.closeHour(x, b)
    x.fresh = false
    x.hour = hour
    let cur: Candle | null = null
    for (let i = bars.length - 1; i >= 0 && Math.floor(bars[i]!.t / 3600) === hour; i--) {
      const b = bars[i]!
      cur = cur ? { t: cur.t, o: b.o, h: Math.max(cur.h, b.h), l: Math.min(cur.l, b.l), c: cur.c, v: cur.v + b.v } : { t: hour * 3600, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v }
    }
    x.cur = cur
    x.booted = true
  }

  // Call once per closed 1m bar of `symbol`, in time order. `bars` is the rolling 1m history (last bar = newest closed).
  update(symbol: string, bars: Candle[]): HourState {
    const x = this.get(symbol)
    x.fresh = false
    const last = bars[bars.length - 1]!
    if (!x.booted) {
      this.prime(symbol, bars)
      return x
    }
    const hour = Math.floor(last.t / 3600)
    if (hour !== x.hour) {
      if (x.cur) this.closeHour(x, x.cur)
      x.cur = { t: hour * 3600, o: last.o, h: last.h, l: last.l, c: last.c, v: last.v }
      x.hour = hour
    } else if (x.cur) {
      x.cur.h = Math.max(x.cur.h, last.h)
      x.cur.l = Math.min(x.cur.l, last.l)
      x.cur.c = last.c
      x.cur.v += last.v
    } else {
      x.cur = { t: hour * 3600, o: last.o, h: last.h, l: last.l, c: last.c, v: last.v }
    }
    return x
  }

  // Share of markets (with enough history) whose last closed hour is above their own slow EMA.
  breadth(): number {
    let up = 0
    let n = 0
    for (const x of this.syms.values()) {
      if (x.seen < BREADTH_MIN_HOURS) continue
      n++
      if (x.hours[x.hours.length - 1]!.c > x.slow) up++
    }
    return n ? up / n : 0
  }

  // Evaluated on the first 1m bar after an hour closes. Returns why it did not fire as `null` (silent: most hours do not qualify).
  signal(symbol: string, lastClose: number): BreakoutSignal | null {
    const x = this.syms.get(symbol)
    if (!x || !x.fresh) return null
    const p = this.p
    const h = x.hours
    const n = h.length
    if (n < Math.max(p.emaHours, p.lookbackHours + 2, 30)) return null
    const b = h[n - 1]!
    let hi = 0
    for (let i = n - 1 - p.lookbackHours; i < n - 1; i++) if (h[i]!.h > hi) hi = h[i]!.h
    if (!(b.c > hi)) return null
    if (!(b.c > x.ema && x.ema > x.emaPrev)) return null
    if (b.c - hi > p.maxChaseAtr * x.atr) return null
    let volumeRatio = 0
    if (p.volumeMult > 0) {
      let v = 0
      for (let i = n - 25; i < n - 1; i++) v += h[i]!.v
      const avg = v / 24
      volumeRatio = avg > 0 ? b.v / avg : 0
      if (!(b.v > p.volumeMult * avg)) return null
    }
    const breadth = this.breadth()
    if (p.breadthMin > 0 && breadth < p.breadthMin) return null
    const stop = Math.min(b.c, lastClose) - p.stopAtr * x.atr
    const pct = (v: number) => `${(v * 100).toFixed(0)}%`
    const rationale =
      `${p.lookbackHours}h breakout: the 1h close ${fmt(b.c)} is above the ${p.lookbackHours}h high ${fmt(hi)} on ${volumeRatio.toFixed(1)}x average volume, ` +
      `price is above its rising ${p.emaHours}h EMA (${fmt(x.ema)}) and ${pct(breadth)} of markets are above their ${p.breadthEmaHours}h EMA. ` +
      `Initial stop ${p.stopAtr} ATR below (${fmt(stop)}), trailing stop ${p.trailAtr} ATR below the highest high.`
    return { entryRef: lastClose, stop, level: hi, atr: x.atr, ema: x.ema, volumeRatio, breadth, hourClose: b.c, rationale }
  }

  // Trailing stop for an open position: highest high since entry minus trailAtr * ATR.
  trail(symbol: string, highSinceEntry: number): number | null {
    const x = this.syms.get(symbol)
    if (!x || !(x.atr > 0)) return null
    return highSinceEntry - this.p.trailAtr * x.atr
  }
}

const fmt = (v: number) => (v >= 100 ? Math.round(v).toLocaleString('en-US') : Number(v.toPrecision(5)).toString())
