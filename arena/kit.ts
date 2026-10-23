// Optional execution kit. A strategy supplies only signals (and optionally a trailing/exit rule); the kit handles
// sizing, the limit entry, the take-profit limit sell, the stop and the time stop, identically for everyone.
// Uses only the Exchange interface, so it behaves the same in backtest and live.
import { getSettings } from '../src/settings'
import { floorTo } from '../src/exchange/validate'
import type { Candle, Exchange, Markets, Strategy } from '../src/types'

export interface Signal {
  entry: number // limit price. With `taker: true` it is ignored and the order is a marketable limit at the ask
  stop: number // below entry. Checked on every closed 1m bar: the position is sold when the bar's low is at or under it
  tp?: number // optional resting limit sell for the whole position
  taker?: boolean // enter now at the ask (pays the taker fee and the spread) instead of waiting for a limit fill
  expireBars?: number // cancel an unfilled limit entry after this many 1m bars (default 60)
  timeStopBars?: number // sell at the bid after this many 1m bars in the position
  riskPct?: number // equity lost if the stop is hit, fees included (default 0.01, never above 0.02)
  tag?: string
}

export interface PosView {
  symbol: string
  entry: number
  stop: number
  tp?: number
  qty: number
  barsHeld: number
  highSinceEntry: number
  lastClose: number
  tag?: string
}

export interface KitOpts {
  name: string
  meta: Markets
  // Called on a closed 1m bar of `symbol` while it has no position or pending entry and a slot is free.
  // `bars` is the live rolling 1m history (oldest first, at most ~3000 bars). Do not mutate it. Must not look ahead.
  signal(ctx: { symbol: string; bars: Candle[]; openSlots: number }): Signal | null | Promise<Signal | null>
  // Called on every closed 1m bar while in a position. Return a new (higher) stop, or exit: true to sell now.
  manage?(pos: PosView, ctx: { bars: Candle[] }): { stop?: number; exit?: boolean } | void
  maxPositions?: number // default 2 (the arena enforces 2 anyway)
  maxPositionPct?: number // default 0.5
}

type Phase = 'pending' | 'open' | 'exiting'
interface St {
  phase: Phase
  sig: Signal
  entryId: string
  tpId?: string
  qty: number
  entry: number
  stop: number
  tp?: number
  baseBefore: number
  barsSince: number
  barsHeld: number
  high: number
  exitTries: number
}

export function createKitStrategy(o: KitOpts): Strategy {
  const S = getSettings()
  const fees = { maker: S.fees.maker, taker: S.fees.taker }
  const maxPositions = o.maxPositions ?? 2
  const maxPct = o.maxPositionPct ?? 0.5
  const states = new Map<string, St>()
  let enabled = true
  let n = 0

  const baseOf = (s: string) => o.meta[s]?.base ?? s.replace(/TMN$/, '')
  const baseTotal = async (ex: Exchange, s: string) => {
    const b = (await ex.balances())[baseOf(s)]
    return b ? b.free + b.locked : 0
  }
  const isDust = (s: string, qty: number, px: number) => {
    const m = o.meta[s]
    if (!m) return qty < 1e-9
    return qty < Math.max(m.minQty, 10 ** -m.qtyDecimals) || qty * px < m.minNotional
  }
  const equity = async (ex: Exchange) => {
    const bal = await ex.balances()
    let total = (bal.TMN?.free ?? 0) + (bal.TMN?.locked ?? 0)
    for (const [asset, b] of Object.entries(bal)) {
      const qty = b.free + b.locked
      if (asset === 'TMN' || !(qty > 0)) continue
      try {
        total += qty * (await ex.quote(`${asset}TMN`)).bid
      } catch {}
    }
    return { total, freeTmn: bal.TMN?.free ?? 0 }
  }

  async function tryOpen(ex: Exchange, symbol: string, sig: Signal, last: Candle) {
    const m = o.meta[symbol]
    if (!m) return
    const q = await ex.quote(symbol)
    const entry = sig.taker ? q.ask : sig.entry
    if (!(sig.stop > 0 && sig.stop < entry)) return
    const { total, freeTmn } = await equity(ex)
    const risk = Math.min(sig.riskPct ?? 0.01, 0.02) * total
    const lossPerUnit = entry - sig.stop + entry * fees.maker + sig.stop * fees.taker + entry * 0.001
    const price = sig.taker ? q.ask * 1.002 : entry
    let qty = risk / lossPerUnit
    qty = Math.min(qty, (maxPct * 0.999 * total) / price, freeTmn / (price * (1 + fees.taker)))
    qty = floorTo(qty, m.qtyDecimals)
    if (!(qty > 0) || qty < m.minQty || qty * entry < m.minNotional) return
    const id = `k${++n}-${symbol}-${last.t}`
    const baseBefore = await baseTotal(ex, symbol)
    const ack = await ex.place({ clientId: id, symbol, side: 'BUY', type: 'LIMIT', price, quantity: qty, reason: sig.tag ?? 'entry' })
    if (ack.status === 'REJECTED') return
    const st: St = { phase: 'pending', sig, entryId: id, qty, entry, stop: sig.stop, tp: sig.tp, baseBefore, barsSince: 0, barsHeld: 0, high: last.h, exitTries: 0 }
    states.set(symbol, st)
    if (ack.status === 'FILLED') await becomeOpen(ex, symbol, st, last)
  }

  async function becomeOpen(ex: Exchange, symbol: string, st: St, last: Candle) {
    const held = (await baseTotal(ex, symbol)) - st.baseBefore
    if (isDust(symbol, held, last.c)) {
      states.delete(symbol)
      return
    }
    st.phase = 'open'
    st.qty = held
    st.entry = st.sig.taker ? st.entry : st.sig.entry
    st.high = last.h
    if (st.tp && st.tp > st.entry) {
      const ack = await ex.place({ clientId: `${st.entryId}-tp`, symbol, side: 'SELL', type: 'LIMIT', price: st.tp, quantity: held, reason: 'take profit' })
      if (ack.status !== 'REJECTED') st.tpId = `${st.entryId}-tp`
    }
  }

  async function sellNow(ex: Exchange, symbol: string, st: St, held: number) {
    if (st.tpId) {
      await ex.cancel(st.tpId)
      st.tpId = undefined
    }
    const q = await ex.quote(symbol)
    st.exitTries += 1
    const price = q.bid * (1 - Math.min(0.12, 0.005 * st.exitTries))
    const m = o.meta[symbol]!
    await ex.place({ clientId: `${st.entryId}-x${st.exitTries}`, symbol, side: 'SELL', type: 'LIMIT', price, quantity: floorTo(held, m.qtyDecimals), reason: 'exit' })
    st.phase = 'exiting'
  }

  async function advance(ex: Exchange, symbol: string, st: St, bars: Candle[]) {
    const last = bars[bars.length - 1]!
    st.barsSince += 1
    if (st.phase === 'pending') {
      const open = (await ex.openOrders(symbol)).some((x) => x.clientId === st.entryId)
      if (!open) return becomeOpen(ex, symbol, st, last)
      if (st.barsSince >= (st.sig.expireBars ?? 60) || last.c < st.stop) {
        await ex.cancel(st.entryId)
        return becomeOpen(ex, symbol, st, last)
      }
      return
    }
    const held = (await baseTotal(ex, symbol)) - st.baseBefore
    if (isDust(symbol, held, last.c)) {
      states.delete(symbol)
      return
    }
    if (st.phase === 'exiting') return sellNow(ex, symbol, st, held)
    st.barsHeld += 1
    st.high = Math.max(st.high, last.h)
    const view: PosView = { symbol, entry: st.entry, stop: st.stop, tp: st.tp, qty: held, barsHeld: st.barsHeld, highSinceEntry: st.high, lastClose: last.c, tag: st.sig.tag }
    const mg = o.manage?.(view, { bars })
    if (mg?.stop && mg.stop > st.stop && mg.stop < last.c) st.stop = mg.stop
    const timeUp = st.sig.timeStopBars !== undefined && st.barsHeld >= st.sig.timeStopBars
    if (last.l <= st.stop || mg?.exit || timeUp) await sellNow(ex, symbol, st, held)
  }

  return {
    name: o.name,
    setEntriesEnabled(e) {
      enabled = e
    },
    async onBar({ symbol, bars, ex }) {
      const st = states.get(symbol)
      if (st) {
        await advance(ex, symbol, st, bars)
        return []
      }
      if (!enabled || states.size >= maxPositions) return []
      const sig = await o.signal({ symbol, bars, openSlots: maxPositions - states.size })
      if (sig) await tryOpen(ex, symbol, sig, bars[bars.length - 1]!)
      return []
    },
  }
}
