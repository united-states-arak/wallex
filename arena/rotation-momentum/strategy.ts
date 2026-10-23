// Basket trend regime plus relative-strength pick, low turnover. See NOTES.md.
import { floorTo } from '../../src/exchange/validate'
import type { Candle, Exchange, Markets, Strategy } from '../../src/types'

const ceilTo = (x: number, d: number) => Math.ceil(x * 10 ** d - 1e-9) / 10 ** d

const P = {
  stepH: 12, // decide every 12 hours, on the hour boundary (UTC)
  k: 2, // coins held
  l1: 24, // score = mean of the returns over l1 and l2 hours
  l2: 72,
  sma: 96, // trend average length in hours (own trend and basket regime)
  trail: 0.15, // trailing stop below the high since entry
  size: 0.3, // share of equity per position (arena cap is 0.5)
  cooldownH: 8, // no re-entry of a coin for N hours after selling it
}

interface Pos { qty: number; high: number; exiting: number }

export default function create(ctx: { meta: Markets; symbols: string[] }): Strategy {
  const meta = ctx.meta
  const hc = new Map<string, number[]>() // per symbol: last close of every hour, forward-filled
  const firstHr = new Map<string, number>()
  const last = new Map<string, number>()
  const pos = new Map<string, Pos>()
  const cool = new Map<string, number>()
  const boot = new Set<string>()
  let base = -1
  let lastDecisionHr = -1
  let curHr = 0
  let seq = 0

  const push = (sym: string, c: Candle) => {
    const idx = Math.floor(c.t / 3600) - base
    if (idx < 0) return
    let a = hc.get(sym)
    if (!a) hc.set(sym, (a = []))
    while (a.length < idx) a.push(a.length ? a[a.length - 1]! : c.c)
    a[idx] = c.c
    last.set(sym, c.c)
  }
  const at = (sym: string, hr: number) => {
    const a = hc.get(sym)
    const i = hr - base
    if (!a || i < 0 || hr < (firstHr.get(sym) ?? 1e12)) return NaN
    return a[Math.min(i, a.length - 1)] ?? NaN
  }

  async function sell(ex: Exchange, sym: string, p: Pos, reason: string) {
    const q = await ex.quote(sym)
    const m = meta[sym]!
    p.exiting += 1
    const price = floorTo(q.bid * (1 - Math.min(0.12, 0.005 * (p.exiting - 1))), m.priceDecimals)
    const ack = await ex.place({ clientId: `s${++seq}-${sym}`, symbol: sym, side: 'SELL', type: 'LIMIT', price, quantity: floorTo(p.qty, m.qtyDecimals), reason })
    if (ack.status === 'FILLED') {
      pos.delete(sym)
      cool.set(sym, curHr + P.cooldownH)
    }
  }

  async function decide(ex: Exchange, hr: number) {
    const info = new Map<string, { dev: number; score: number }>()
    let sumDev = 0
    for (const s of ctx.symbols) {
      const now = last.get(s)
      if (!now) continue
      const pa = at(s, hr - P.l1)
      const pb = at(s, hr - P.l2)
      if (!(pa > 0 && pb > 0)) continue
      let sm = 0
      for (let j = 0; j < P.sma; j++) sm += at(s, hr - j)
      sm /= P.sma
      if (!(sm > 0)) continue
      const dev = Math.log(now / sm)
      info.set(s, { dev, score: (now / pa - 1 + (now / pb - 1)) / 2 })
      sumDev += dev
    }
    if (info.size < 8) return
    const regimeOn = sumDev / info.size > 0 // basket trades above its own trend
    const ranked = [...info.keys()].sort((a, b) => info.get(b)!.score - info.get(a)!.score)

    if (!regimeOn) for (const [s, p] of [...pos]) await sell(ex, s, p, 'regime off')
    for (const [s, p] of [...pos]) if (p.exiting) await sell(ex, s, p, 'retry exit')
    if (!regimeOn || pos.size >= P.k) return

    const bal = await ex.balances()
    let eq = bal.TMN?.free ?? 0
    for (const [s, p] of pos) eq += p.qty * (last.get(s) ?? 0)
    for (let i = 0; i < ranked.length && i < P.k && pos.size < P.k; i++) {
      const s = ranked[i]!
      const r = info.get(s)!
      if (pos.has(s) || r.score <= 0 || r.dev <= 0 || (cool.get(s) ?? -1) > hr) continue
      const q = await ex.quote(s)
      const m = meta[s]!
      const free = (await ex.balances()).TMN?.free ?? 0
      const qty = floorTo(Math.min((P.size * eq) / q.ask, free / (q.ask * 1.0031)), m.qtyDecimals)
      if (!(qty >= m.minQty) || qty * q.ask < m.minNotional) continue
      const id = `b${++seq}-${s}`
      const ack = await ex.place({ clientId: id, symbol: s, side: 'BUY', type: 'LIMIT', price: ceilTo(q.ask, m.priceDecimals), quantity: qty, reason: 'rotation entry' })
      if (ack.status === 'FILLED') pos.set(s, { qty, high: q.ask, exiting: 0 })
      else if (ack.status === 'NEW') await ex.cancel(id)
    }
  }

  return {
    name: 'rotation-momentum',
    async onBar({ symbol, bars, ex }) {
      const c = bars[bars.length - 1]!
      if (!boot.has(symbol)) {
        boot.add(symbol)
        if (base < 0) base = Math.floor(bars[0]!.t / 3600) - 100
        firstHr.set(symbol, Math.floor(bars[0]!.t / 3600) + 1)
        for (const b of bars) push(symbol, b)
      } else push(symbol, c)

      const hr = Math.floor(c.t / 3600)
      const p = pos.get(symbol)
      if (p) {
        curHr = hr
        if (c.h > p.high) p.high = c.h
        if (p.exiting || c.l <= p.high * (1 - P.trail)) await sell(ex, symbol, p, 'trailing stop')
      }
      if (hr % P.stepH === 0 && hr !== lastDecisionHr && c.t % 3600 >= 60) {
        lastDecisionHr = hr
        curHr = hr
        await decide(ex, hr)
      }
      return []
    },
  }
}
