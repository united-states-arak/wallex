// Trend-breakout: 1h Donchian breakout in an uptrend, ATR initial stop, chandelier trailing stop.
import { createKitStrategy } from '../kit'
import { aggregate } from '../../src/data/candles'
import type { Candle, Markets, Strategy } from '../../src/types'

const P = {
  N: 96, // breakout lookback (1h bars)
  EMA: 96, // trend filter EMA length (1h bars)
  ATR: 14,
  K: 4, // initial stop, ATR multiples
  M: 8, // trail, ATR multiples from highest high
  VOL: 1.5, // breakout-hour volume vs 24h average (0 = off)
  CHASE: 3, // max distance of close above the breakout level, ATR multiples
  MKT: 0.7, // min share of markets whose 1h close is above their own slow EMA (0 = off)
  MEMA: 168, // slow EMA length for the breadth filter (1h bars)
  RISK: 0.01,
  MAXH: 336, // time stop, hours
}

interface Sym {
  h: Candle[] // closed 1h bars
  cur: Candle | null
  hour: number
  atr: number
  ema: number
  emaPrev: number
  fresh: boolean
  slow: number
  seen: number
  boot: boolean
  level: number
  chg24: number
}

export default function create(ctx: { meta: Markets }): Strategy {
  const syms = new Map<string, Sym>()
  const get = (s: string) => {
    let x = syms.get(s)
    if (!x) {
      x = { h: [], cur: null, hour: -1, atr: 0, ema: 0, emaPrev: 0, fresh: false, slow: 0, seen: 0, boot: false, level: 0, chg24: 0 }
      syms.set(s, x)
    }
    return x
  }

  const closeHour = (x: Sym, b: Candle) => {
    const h = x.h
    const prev = h[h.length - 1]
    h.push(b)
    if (h.length > 400) h.shift()
    const tr = prev ? Math.max(b.h - b.l, Math.abs(b.h - prev.c), Math.abs(b.l - prev.c)) : b.h - b.l
    x.atr = x.atr === 0 ? tr : (x.atr * (P.ATR - 1) + tr) / P.ATR
    const a = 2 / (P.EMA + 1)
    x.emaPrev = x.ema
    x.ema = x.ema === 0 ? b.c : x.ema + a * (b.c - x.ema)
    const sa = 2 / (P.MEMA + 1)
    x.seen++
    x.slow = x.slow === 0 ? b.c : x.slow + sa * (b.c - x.slow)
    x.fresh = true
  }

  const update = (symbol: string, bars: Candle[]) => {
    const x = get(symbol)
    x.fresh = false
    const last = bars[bars.length - 1]!
    const hour = Math.floor(last.t / 3600)
    if (!x.boot) {
      x.boot = true
      const hist = aggregate(bars, 60, hour * 3600)
      for (const b of hist) closeHour(x, b)
      x.fresh = false
      x.hour = hour
      x.cur = null
      for (let i = bars.length - 1; i >= 0 && Math.floor(bars[i]!.t / 3600) === hour; i--) {
        const b = bars[i]!
        x.cur = x.cur ? { ...x.cur, t: b.t, o: b.o, h: Math.max(x.cur.h, b.h), l: Math.min(x.cur.l, b.l), v: x.cur.v + b.v } : { ...b }
      }
      if (x.cur) x.cur.t = hour * 3600
      return x
    }
    if (hour !== x.hour) {
      if (x.cur) closeHour(x, x.cur)
      x.cur = { t: hour * 3600, o: last.o, h: last.h, l: last.l, c: last.c, v: last.v } as Candle
      x.hour = hour
    } else if (x.cur) {
      x.cur.h = Math.max(x.cur.h, last.h)
      x.cur.l = Math.min(x.cur.l, last.l)
      x.cur.c = last.c
      x.cur.v += last.v
    }
    return x
  }

  const breadth = () => {
    let up = 0
    let n = 0
    for (const x of syms.values()) {
      if (x.seen < 96) continue
      n++
      if (x.h[x.h.length - 1]!.c > x.slow) up++
    }
    return n ? up / n : 0
  }

  const kit = createKitStrategy({
    name: 'trend-breakout',
    meta: ctx.meta,
    signal({ symbol, bars }) {
      const x = syms.get(symbol)!
      if (!x.fresh) return null
      const h = x.h
      const n = h.length
      if (n < Math.max(P.EMA, P.N + 2, 30)) return null
      const b = h[n - 1]!
      let hi = 0
      for (let i = n - 1 - P.N; i < n - 1; i++) if (h[i]!.h > hi) hi = h[i]!.h
      if (!(b.c > hi)) return null
      if (!(b.c > x.ema && x.ema > x.emaPrev)) return null
      if (b.c - hi > P.CHASE * x.atr) return null
      if (P.VOL > 0) {
        let v = 0
        for (let i = n - 25; i < n - 1; i++) v += h[i]!.v
        if (!(b.v > (P.VOL * v) / 24)) return null
      }
      if (P.MKT > 0 && breadth() < P.MKT) return null
      x.level = hi
      const entry = bars[bars.length - 1]!.c
      const stop = Math.min(b.c, entry) - P.K * x.atr
      return { entry, stop, taker: true, riskPct: P.RISK, timeStopBars: P.MAXH * 60, tag: 'brk' }
    },
    manage(pos) {
      const x = syms.get(pos.symbol)!
      if (!(x.atr > 0)) return
      return { stop: pos.highSinceEntry - P.M * x.atr }
    },
  })

  return {
    name: kit.name,
    setEntriesEnabled: kit.setEntriesEnabled,
    async onBar(a) {
      update(a.symbol, a.bars)
      return kit.onBar(a)
    },
  }
}
