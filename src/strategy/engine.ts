import type { Supervisor, Verdict } from '../ai/types'
import { floorTo } from '../exchange/validate'
import { nullLog, type Log } from '../log'
import type { RiskGuard } from '../risk/types'
import { getSettings } from '../settings'
import type { Candle, Exchange, Markets, OrderAck, OrderReq, Strategy, TickCtx } from '../types'

// A trade a signal model wants to open. The engine sizes, reviews, executes and manages it.
export interface Candidate {
  model: string
  entryRef: number // last close when the signal fired
  stop: number // initial stop (absolute price)
  tp?: number // optional resting take-profit limit sell for the whole position
  timeStopBars: number // sell at the bid after this many 1m bars in the position
  riskMult?: number // multiple of the guard's risk per trade (default 1)
  rationale: string // one or two sentences for the decision log and the AI
  features: Record<string, unknown> // evidence shown to the AI and logged
}

// A signal model sees every closed 1m bar and proposes candidates. It never places orders.
export interface SignalModel {
  name: string
  primeDays?: number
  prime?(symbol: string, bars: Candle[]): void
  update(symbol: string, bars: Candle[]): void
  signal(symbol: string, bars: Candle[]): Candidate | null
  trail?(symbol: string, highSinceEntry: number): number | null // trailing stop for an open position of this model
}

export interface EngineOptions {
  entrySlip: number
  stopExitSlip: number
  stopExitSlipMax: number
  maxPositions: number
  maxPositionPct: number
  slippagePct: number
  maxSpreadPct: number
  pendingExpiryBars: number
  maxOrderTmn: number
}

export interface EngineDeps {
  meta: Markets
  guard?: RiskGuard
  supervisor?: Supervisor
  log?: Log
  options?: Partial<EngineOptions>
  fees?: { maker: number; taker: number }
}

type Phase = 'pending' | 'open' | 'exiting'

interface Trade {
  id: string
  symbol: string
  model: string
  phase: Phase
  qty: number
  entry: number
  stop: number
  initialStop: number
  tp?: number
  tpId?: string
  timeStopBars: number
  baseBefore: number
  barsSince: number
  barsHeld: number
  high: number
  exitTries: number
  exitBid: number
  exitReason: string
  equityAtEntry: number
  openedAt: number
  lastLoggedStop: number
  fillSeen?: boolean // the exchange reported (part of) the entry as filled
}

const UNCONFIRMED_FILL_BARS = 3

export type TradeEngine = Strategy & {
  primeDays: number
  prime(symbol: string, bars: Candle[]): void
  getState(): unknown
  restoreState(s: unknown): void
  openPositions(): { symbol: string; model: string; qty: number; entry: number; stop: number; notional: number }[]
}

export function defaultEngineOptions(): EngineOptions {
  const S = getSettings()
  const b = S.strategy.breakout
  return {
    entrySlip: b.entrySlip,
    stopExitSlip: b.stopExitSlip,
    stopExitSlipMax: b.stopExitSlipMax,
    maxPositions: S.risk.maxPositions,
    maxPositionPct: S.risk.maxPositionPct,
    slippagePct: S.risk.slippagePct,
    maxSpreadPct: 0.02,
    pendingExpiryBars: 60,
    maxOrderTmn: S.risk.maxOrderTmn,
  }
}

// One position book for every model: at most one trade per market, a shared position limit, the risk guard and the AI
// supervisor in front of every entry, and identical, fully logged execution for every model.
export function createTradeEngine(name: string, models: SignalModel[], deps: EngineDeps): TradeEngine {
  const o: EngineOptions = { ...defaultEngineOptions(), ...deps.options }
  const S = getSettings()
  const fees = deps.fees ?? { maker: S.fees.maker, taker: S.fees.taker }
  const { meta, guard, supervisor } = deps
  // A failing log sink (disk full, a broken exporter) must never interrupt order handling between a place and its bookkeeping.
  const rawLog = deps.log ?? nullLog
  const log: Log = (event, data) => {
    try {
      rawLog(event, data)
    } catch {}
  }
  const byName = new Map(models.map((m) => [m.name, m]))
  const trades = new Map<string, Trade>()
  let enabled = true

  const baseOf = (s: string) => meta[s]?.base ?? s.replace(/TMN$/, '')
  const baseTotal = async (ex: Exchange, s: string) => {
    const b = (await ex.balances())[baseOf(s)]
    return b ? b.free + b.locked : 0
  }
  const isDust = (s: string, qty: number, px: number) => {
    const m = meta[s]
    if (!m) return qty < 1e-12
    return qty < Math.max(m.minQty, 10 ** -m.qtyDecimals) || qty * px < m.minNotional
  }
  const equityOf = async (ex: Exchange) => {
    const g = guard?.state().equity
    if (g && g > 0) return g
    const bal = await ex.balances()
    let total = (bal.TMN?.free ?? 0) + (bal.TMN?.locked ?? 0)
    for (const [asset, b] of Object.entries(bal)) {
      const qty = b.free + b.locked
      if (asset === 'TMN' || !(qty > 0)) continue
      try {
        total += qty * (await ex.quote(`${asset}TMN`)).bid
      } catch {}
    }
    return total
  }

  const place = async (ex: Exchange, req: OrderReq): Promise<OrderAck> => {
    log('order.intent', { ...req })
    let ack: OrderAck
    try {
      ack = await ex.place(req)
    } catch (e) {
      ack = { clientId: req.clientId, status: 'REJECTED', error: String(e) }
    }
    log('order.ack', { ...ack, mode: ex.mode })
    return ack
  }

  const reject = (symbol: string, model: string, reason: string, extra: Record<string, unknown> = {}) => log('setup.rejected', { symbol, model, reason, ...extra })

  async function enter(ex: Exchange, symbol: string, c: Candidate, last: Candle) {
    const m = meta[symbol]
    if (!m) return reject(symbol, c.model, 'unknown market')
    const now = last.t + 60
    const blocked = guard?.blockReason(now)
    if (blocked) return reject(symbol, c.model, `guard: ${blocked}`)
    const q = await ex.quote(symbol)
    if (!(q.bid > 0 && q.ask >= q.bid)) return reject(symbol, c.model, 'no valid quote')
    if ((q.ask - q.bid) / q.bid > o.maxSpreadPct) return reject(symbol, c.model, `spread ${(((q.ask - q.bid) / q.bid) * 100).toFixed(2)}% above ${o.maxSpreadPct * 100}%`)
    const entry = q.ask
    const stop = c.stop
    if (!(stop > 0 && stop < entry)) return reject(symbol, c.model, 'stop not below entry', { entry, stop })
    if (c.tp !== undefined && !(c.tp > entry)) return reject(symbol, c.model, 'target already reached', { entry, tp: c.tp })

    const equity = await equityOf(ex)
    const freeTmn = (await ex.balances()).TMN?.free ?? 0
    const riskPct = Math.min((guard?.riskPct() ?? 0.01) * (c.riskMult ?? 1), 0.02)
    const price = q.ask * (1 + o.entrySlip)
    const lossPerUnit = entry - stop + entry * fees.taker + stop * fees.taker + entry * o.slippagePct
    // The live adapter refuses a BUY above risk.maxOrderTmn, so size below it instead of having every large entry refused.
    const orderCap = o.maxOrderTmn > 0 ? (o.maxOrderTmn * 0.999) / price : Infinity
    let qty = Math.min((riskPct * equity) / lossPerUnit, (o.maxPositionPct * 0.999 * equity) / price, freeTmn / (price * (1 + fees.taker)), orderCap)
    qty = floorTo(qty, m.qtyDecimals)
    const fits = (x: number) => x > 0 && x >= m.minQty && x * entry >= m.minNotional
    if (!fits(qty)) return reject(symbol, c.model, 'sizing: below the market minimum or no free TMN', { equity, freeTmn })

    const features = { ...c.features, stopDistancePct: Number((((entry - stop) / entry) * 100).toFixed(2)), ...(c.tp ? { targetPct: Number((((c.tp - entry) / entry) * 100).toFixed(2)) } : {}) }
    const candidate = { symbol, model: c.model, entry, stop, ...(c.tp ? { tp1: c.tp } : {}), rationale: c.rationale, features }
    let verdict: Verdict = { action: 'approve', sizeMult: 1, reason: 'no supervisor configured', source: 'fallback', model: 'none', latencyMs: 0 }
    if (supervisor) {
      try {
        verdict = await supervisor.review({
          setup: candidate,
          equityTmn: equity,
          proposedNotionalTmn: qty * entry,
          proposedPctOfEquity: equity > 0 ? (qty * entry) / equity : 0,
          openPositions: [...trades.values()].map((t) => ({ symbol: t.symbol, notionalTmn: t.qty * t.entry })),
          dayPnlPct: guard?.state().dayPnlPct ?? 0,
        })
      } catch (e) {
        log('supervisor.error', { symbol, error: String(e) })
      }
    }
    if (verdict.action === 'veto') return reject(symbol, c.model, 'supervisor veto', { verdict, verdictReason: verdict.reason })
    if (verdict.action === 'resize') {
      const mult = Math.min(1, Math.max(0, Number(verdict.sizeMult)))
      qty = floorTo(qty * (Number.isFinite(mult) ? mult : 0), m.qtyDecimals)
      if (!fits(qty)) return reject(symbol, c.model, 'resized below the market minimum', { verdict })
    }

    const prefix = c.model === 'breakout' ? 'bo' : c.model.slice(0, 2)
    const id = `${prefix}_${symbol.replace(/[^A-Za-z0-9]/g, '').slice(0, 14)}_${last.t}`
    const notional = qty * entry
    log('setup.accepted', {
      symbol,
      model: c.model,
      entry,
      stop,
      tp1: c.tp,
      qty,
      notional,
      pctOfEquity: equity > 0 ? notional / equity : 0,
      riskPct,
      lossPctAtStop: equity > 0 ? (qty * lossPerUnit) / equity : 0,
      rationale: c.rationale,
      features,
      verdict: verdict.action,
      verdictReason: verdict.reason,
    })
    const baseBefore = await baseTotal(ex, symbol)
    const ack = await place(ex, { clientId: id, symbol, side: 'BUY', type: 'LIMIT', price, quantity: qty, reason: `${c.model} entry: ${c.rationale}`.slice(0, 500), meta: { model: c.model, stop, tp: c.tp, verdict: verdict.action } })
    // A timeout or dropped reply can report REJECTED for an order that did reach the exchange. Bought coins must never be
    // left without a stop, so check the book and the balance before forgetting the entry; when that check itself fails,
    // keep it as pending and let the next bar reconcile it.
    let boughtNow = false
    let known = true
    if (ack.status === 'REJECTED') {
      let open = false
      let held = 0
      try {
        open = (await ex.openOrders(symbol)).some((x) => x.clientId === id)
        held = (await baseTotal(ex, symbol)) - baseBefore
      } catch {
        known = false
      }
      if (known && !open && isDust(symbol, held, entry)) {
        log('entry.rejected', { symbol, id, error: ack.error })
        return
      }
      boughtNow = known && !open
      log('entry.uncertain', { symbol, id, error: ack.error, orderOpen: open, held, checked: known })
    }
    const fillSeen = boughtNow || !known || ack.status === 'FILLED' || (ack.filledQty ?? 0) > 0
    // PnL is booked against the real average fill when the exchange reports one, not the ask seen before the AI review.
    const filledAt = ack.avgPrice !== undefined && Number.isFinite(ack.avgPrice) && ack.avgPrice > 0 ? ack.avgPrice : entry
    const t: Trade = { id, symbol, model: c.model, phase: 'pending', qty, entry: filledAt, stop, initialStop: stop, tp: c.tp, timeStopBars: c.timeStopBars, baseBefore, barsSince: 0, barsHeld: 0, high: last.h, exitTries: 0, exitBid: 0, exitReason: '', equityAtEntry: equity, openedAt: now, lastLoggedStop: stop, fillSeen }
    trades.set(symbol, t)
    log('entry.placed', { symbol, id, model: c.model, qty, entry, stop, tp1: c.tp, status: ack.status })
    if (ack.status === 'FILLED' || boughtNow) await becomeOpen(ex, t, last)
  }

  async function becomeOpen(ex: Exchange, t: Trade, last: Candle) {
    const held = (await baseTotal(ex, t.symbol)) - t.baseBefore
    if (isDust(t.symbol, held, last.c)) {
      // The exchange reported a fill but the balance does not show it yet: wait a few bars before calling it unfilled.
      if (t.fillSeen && t.barsSince < UNCONFIRMED_FILL_BARS) {
        log('entry.unconfirmed', { symbol: t.symbol, id: t.id, held, barsSince: t.barsSince })
        return
      }
      trades.delete(t.symbol)
      log('entry.cancelled', { symbol: t.symbol, id: t.id, reason: 'not filled', close: last.c })
      return
    }
    t.phase = 'open'
    t.qty = held
    t.high = last.h
    log('entry.filled', { symbol: t.symbol, id: t.id, model: t.model, qty: held, entry: t.entry, stop: t.stop, tp1: t.tp })
    if (t.tp && t.tp > t.entry) {
      const m = meta[t.symbol]!
      const tpId = `${t.id}_tp`
      const ack = await place(ex, { clientId: tpId, symbol: t.symbol, side: 'SELL', type: 'LIMIT', price: t.tp, quantity: floorTo(held, m.qtyDecimals), reason: `${t.model} take profit` })
      if (ack.status !== 'REJECTED') {
        t.tpId = tpId
        log('tp.placed', { symbol: t.symbol, id: tpId, price: t.tp, qty: held })
      }
    }
  }

  // Cancels this trade's resting sells (take-profit and earlier exit attempts). Their coins are locked, so a new exit for
  // the full quantity would be refused for insufficient balance on every retry while they rest. Returns whether any
  // order was (or may still be) resting, in which case the caller must re-read the balance.
  async function cancelOwnSells(ex: Exchange, t: Trade): Promise<boolean> {
    // The ids we know of are always included, in case the open-order list is unavailable or does not echo our client ids.
    const ids = new Set([t.tpId, t.exitTries > 0 ? `${t.id}_x${t.exitTries}` : undefined].filter((x): x is string => !!x))
    try {
      for (const o of await ex.openOrders(t.symbol)) if (o.clientId.startsWith(`${t.id}_`)) ids.add(o.clientId)
    } catch (e) {
      log('order.open_orders_failed', { symbol: t.symbol, id: t.id, error: String(e) })
    }
    for (const id of ids) {
      try {
        await ex.cancel(id)
      } catch (e) {
        log('order.cancel_failed', { symbol: t.symbol, clientId: id, error: String(e) })
      }
    }
    return ids.size > 0
  }

  async function sellNow(ex: Exchange, t: Trade, held: number, bid: number, reason: string, now: number) {
    const m = meta[t.symbol]!
    if (await cancelOwnSells(ex, t)) {
      held = Math.max(0, (await baseTotal(ex, t.symbol)) - t.baseBefore)
      // the take-profit (or an earlier exit) filled meanwhile; the next bar books the close
      if (isDust(t.symbol, held, bid)) return
    }
    t.tpId = undefined
    t.exitTries += 1
    if (t.exitTries === 1) {
      t.exitBid = bid
      t.exitReason = reason
      log('stop.hit', { symbol: t.symbol, id: t.id, model: t.model, reason, stop: t.stop, bid, qty: held })
    }
    const price = bid * (1 - Math.min(o.stopExitSlipMax, o.stopExitSlip * t.exitTries))
    const quantity = floorTo(held, m.qtyDecimals)
    if (isDust(t.symbol, quantity, price)) {
      // Worth more than the minimum at the bid but not at the exit price: no order can sell it, so stop holding the slot.
      log('exit.unsellable', { symbol: t.symbol, id: t.id, qty: held, price, minNotional: m.minNotional })
      t.phase = 'exiting'
      return closed(t, now, held)
    }
    await place(ex, { clientId: `${t.id}_x${t.exitTries}`, symbol: t.symbol, side: 'SELL', type: 'LIMIT', price, quantity, reason: `exit (${reason})` })
    t.phase = 'exiting'
  }

  function closed(t: Trade, now: number, dust: number) {
    // Only a take-profit that was actually resting can explain a position that vanished without an exit of ours.
    const byTarget = !t.exitReason && t.tpId !== undefined
    const exitPx = byTarget ? t.tp! : t.exitBid > 0 ? t.exitBid : t.entry
    const exitFee = byTarget ? fees.maker : fees.taker
    const cost = t.qty * t.entry * (1 + fees.taker)
    const proceeds = t.qty * exitPx * (1 - exitFee)
    const pnl = proceeds - cost
    const frac = t.equityAtEntry > 0 ? pnl / t.equityAtEntry : 0
    guard?.recordTrade(frac, now)
    if (byTarget) log('tp.filled', { symbol: t.symbol, id: `${t.id}_tp`, price: exitPx, qty: t.qty })
    log('exit', {
      symbol: t.symbol,
      id: t.id,
      model: t.model,
      how: byTarget ? 'take profit' : t.exitReason || 'closed',
      qty: t.qty,
      entry: t.entry,
      exit: exitPx,
      pnlTmn: pnl,
      pnlFraction: frac,
      equityAtEntry: t.equityAtEntry,
      heldHours: Number((t.barsHeld / 60).toFixed(1)),
      dustQty: dust,
      feeTmn: t.qty * t.entry * fees.taker + t.qty * exitPx * exitFee,
    })
    trades.delete(t.symbol)
  }

  async function advance(ex: Exchange, t: Trade, bars: Candle[]) {
    const last = bars[bars.length - 1]!
    const now = last.t + 60
    t.barsSince += 1
    if (t.phase === 'pending') {
      const open = (await ex.openOrders(t.symbol)).some((x) => x.clientId === t.id)
      if (!open) return becomeOpen(ex, t, last)
      if (t.barsSince >= o.pendingExpiryBars || last.c < t.stop || !enabled) {
        try {
          await ex.cancel(t.id)
        } catch (e) {
          // still resting (or just filled): stay pending and look again next bar, so no buy keeps resting untracked
          log('order.cancel_failed', { symbol: t.symbol, clientId: t.id, error: String(e) })
          return
        }
        return becomeOpen(ex, t, last)
      }
      return
    }
    const held = (await baseTotal(ex, t.symbol)) - t.baseBefore
    if (isDust(t.symbol, held, last.c)) return closed(t, now, Math.max(0, held))
    const bid = (await ex.quote(t.symbol)).bid
    if (t.phase === 'exiting') return sellNow(ex, t, held, bid, t.exitReason, now)
    t.barsHeld += 1
    t.high = Math.max(t.high, last.h)
    const trail = byName.get(t.model)?.trail?.(t.symbol, t.high) ?? null
    if (trail !== null && trail > t.stop && trail < last.c) {
      t.stop = trail
      if (t.stop >= t.lastLoggedStop * 1.005) {
        log('stop.trail', { symbol: t.symbol, id: t.id, stop: t.stop, high: t.high })
        t.lastLoggedStop = t.stop
      }
    }
    const reason = last.l <= t.stop ? (t.stop > t.initialStop ? 'trailing stop' : 'stop') : t.barsHeld >= t.timeStopBars ? 'time stop' : ''
    if (reason) await sellNow(ex, t, held, bid, reason, now)
  }

  return {
    name,
    primeDays: Math.max(0, ...models.map((m) => m.primeDays ?? 0)),
    prime(symbol, bars) {
      for (const m of models) m.prime?.(symbol, bars)
      log('strategy.primed', { symbol, bars: bars.length, models: models.map((m) => m.name) })
    },
    setEntriesEnabled(e) {
      enabled = e
    },
    async onBar({ symbol, bars, ex }) {
      if (!bars.length) return []
      for (const m of models) m.update(symbol, bars)
      const t = trades.get(symbol)
      if (t) {
        await advance(ex, t, bars)
        return []
      }
      if (!enabled || trades.size >= o.maxPositions) return []
      for (const m of models) {
        const c = m.signal(symbol, bars)
        if (c) {
          await enter(ex, symbol, c, bars[bars.length - 1]!)
          break
        }
      }
      return []
    },
    // Between candles (live and shadow): sell as soon as the bid touches the stop instead of waiting for the bar close.
    async onTick({ symbol, quote, ex, now }: TickCtx) {
      const t = trades.get(symbol)
      if (!t || t.phase !== 'open' || !(quote.bid > 0) || quote.bid > t.stop) return []
      const held = (await baseTotal(ex, symbol)) - t.baseBefore
      if (!isDust(symbol, held, quote.bid)) await sellNow(ex, t, held, quote.bid, t.stop > t.initialStop ? 'trailing stop' : 'stop', now)
      return []
    },
    getState() {
      const positions: Record<string, Trade> = {}
      const pending: Record<string, Trade> = {}
      for (const t of trades.values()) (t.phase === 'pending' ? pending : positions)[t.symbol] = { ...t }
      return { version: 2, positions, pending }
    },
    restoreState(s) {
      const st = s as { positions?: Record<string, Trade>; pending?: Record<string, Trade> } | null
      if (!st || typeof st !== 'object') return
      const n = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d)
      for (const group of [st.positions, st.pending]) {
        for (const [key, t] of Object.entries(group ?? {})) {
          const ok =
            t && typeof t.symbol === 'string' && typeof t.id === 'string' && !!meta[t.symbol] && t.qty > 0 && t.stop > 0 && t.entry > 0 &&
            Number.isFinite(t.baseBefore) && t.baseBefore >= 0 && (t.phase === 'pending' || t.phase === 'open' || t.phase === 'exiting')
          if (!ok) {
            // Never silent: a dropped position is a holding without a stop (for example a state file of another strategy).
            log('state.restore_skipped', { key, entry: t as unknown as Record<string, unknown> })
            continue
          }
          trades.set(t.symbol, {
            ...t,
            model: t.model ?? 'breakout',
            timeStopBars: n(t.timeStopBars, getSettings().strategy.breakout.maxHoldHours * 60),
            initialStop: n(t.initialStop, t.stop),
            barsSince: n(t.barsSince, 0),
            barsHeld: n(t.barsHeld, 0),
            high: n(t.high, t.entry),
            exitTries: n(t.exitTries, 0),
            exitBid: n(t.exitBid, 0),
            exitReason: typeof t.exitReason === 'string' ? t.exitReason : '',
            equityAtEntry: n(t.equityAtEntry, 0),
            lastLoggedStop: n(t.lastLoggedStop, t.stop),
          })
        }
      }
    },
    openPositions() {
      return [...trades.values()].filter((t) => t.phase !== 'pending').map((t) => ({ symbol: t.symbol, model: t.model, qty: t.qty, entry: t.entry, stop: t.stop, notional: t.qty * t.entry }))
    },
  }
}
