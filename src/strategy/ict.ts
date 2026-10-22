import { floorTo } from '../exchange/validate'
import type { Supervisor, Verdict } from '../ai/types'
import { findSetup as defaultFindSetup } from '../ict/detect'
import type { DetectParams, FindSetup, SetupCandidate } from '../ict/types'
import { nullLog, type Log } from '../log'
import type { GuardState, RiskGuard } from '../risk/types'
import { positionSize } from '../risk/size'
import { getSettings } from '../settings'
import type { BarCtx, Candle, Exchange, Markets, OrderAck, OrderReq, Strategy, TickCtx } from '../types'

export interface IctOptions {
  maxPositions: number
  slippagePct: number
  maxSpreadPct: number
  minNetRr: number
  tp1Fraction: number
  timeStopBars: number
  stopExitSlip: number
  stopExitSlipMax: number
  breakEvenBuffer: number // stop after TP1 sits this far above entry (about the round-trip fees) so the remainder cannot lose
}

export interface IctDeps {
  guard?: RiskGuard
  supervisor?: Supervisor
  findSetup?: FindSetup
  detect?: Partial<DetectParams>
  log?: Log
  meta?: Markets
  options?: Partial<IctOptions>
  fees?: { maker: number; taker: number }
}

export type IctStrategy = Strategy & {
  getState(): unknown
  restoreState(s: unknown): void
  openPositions(): { symbol: string; qty: number; entry: number; stop: number; tp1: number; notional: number }[]
}

const defaultOptions = (): IctOptions => {
  const S = getSettings()
  return { maxPositions: S.risk.maxPositions, slippagePct: S.risk.slippagePct, ...S.strategy.ict }
}

interface Pending {
  symbol: string
  id: string
  qty: number
  entry: number
  stop: number
  tp1: number
  tp2?: number
  expiresAt: number
  invalidateBelow: number
  baseBefore: number
  equity: number
  reason: string
}

interface Position {
  symbol: string
  id: string
  qty: number
  entry: number
  stop: number
  initialStop: number
  tp1: number
  tp2: number
  q1: number
  q2: number
  baseBefore: number
  filledAt: number
  stopFrom: number
  equityAtEntry: number
  tpsPlaced: boolean
  tpIds: string[]
  tp1Done: boolean
  soldAcc: number
  realized: number
  exitFees?: number
  exiting?: { id: string; reason: string; price: number; attempt: number }
  reason: string
}

interface State {
  positions: Record<string, Position>
  pending: Record<string, Pending>
  traded: string[]
}

const trivialGuard = (): RiskGuard => {
  const riskPct = getSettings().risk.riskPct
  let equity = 0
  return {
    blockReason: () => null,
    riskPct: () => riskPct,
    updateEquity: (e) => {
      equity = e
    },
    recordTrade: () => {},
    state: (): GuardState => ({
      equity,
      startEquity: equity,
      dayPeak: equity,
      dayPnlPct: 0,
      totalPnlPct: 0,
      consecutiveLosses: 0,
      halted: false,
      riskPct,
    }),
  }
}

const approveAll: Supervisor = {
  review: async () => ({ action: 'approve', sizeMult: 1, reason: 'no supervisor configured', source: 'fallback', model: 'none', latencyMs: 0 }),
  refreshNews: async () => null,
}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x)
const finite = (...xs: unknown[]) => xs.every((x) => typeof x === 'number' && Number.isFinite(x))

export function createIctStrategy(deps: IctDeps = {}): IctStrategy {
  const o: IctOptions = { ...defaultOptions(), ...deps.options }
  const fees = deps.fees ?? getSettings().fees
  const guard = deps.guard ?? trivialGuard()
  const supervisor = deps.supervisor ?? approveAll
  const findSetup = deps.findSetup ?? defaultFindSetup
  const log = deps.log ?? nullLog
  const meta = deps.meta ?? {}

  let positions: Record<string, Position> = {}
  let pending: Record<string, Pending> = {}
  let traded = new Set<string>()
  let entriesEnabled = true
  const lastRejected = new Map<string, string>()

  let chain: Promise<unknown> = Promise.resolve()
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const r = chain.then(fn)
    chain = r.catch(() => {})
    return r
  }

  const baseOf = (symbol: string) => meta[symbol]?.base ?? symbol.replace(/(TMN|USDT)$/, '')
  const decimals = (symbol: string) => meta[symbol]?.qtyDecimals ?? 8
  const baseTotal = async (ex: Exchange, symbol: string) => {
    const b = (await ex.balances())[baseOf(symbol)]
    return b ? b.free + b.locked : 0
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

  const cancel = async (ex: Exchange, id: string) => {
    try {
      await ex.cancel(id)
    } catch (e) {
      log('order.cancel_error', { clientId: id, error: String(e) })
    }
  }

  const equityTmn = async (ex: Exchange): Promise<number> => {
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

  const countOpen = () => Object.keys(positions).length + Object.keys(pending).length

  const isDust = (p: Position, remaining: number) => {
    const m = meta[p.symbol]
    if (!m) return remaining < 1e-9
    return remaining < Math.max(m.minQty, 10 ** -m.qtyDecimals) || remaining * p.entry * 0.98 < m.minNotional
  }

  // Updates sold quantity and realized proceeds from the balance, detects TP1 and full close.
  async function sync(ex: Exchange, p: Position, barTime: number, now: number) {
    const open = await ex.openOrders(p.symbol)
    const live = new Set(open.map((x) => x.clientId))
    const remaining = Math.min(p.qty, Math.max(0, (await baseTotal(ex, p.symbol)) - p.baseBefore))
    const sold = p.qty - remaining
    const d = sold - p.soldAcc
    if (d > 1e-12) {
      if (p.exiting) {
        p.realized += d * p.exiting.price * (1 - fees.taker)
        if (p.exitFees !== undefined) p.exitFees += d * p.exiting.price * fees.taker
      } else {
        const at1 = Math.max(0, Math.min(d, p.q1 - p.soldAcc))
        p.realized += (at1 * p.tp1 + (d - at1) * p.tp2) * (1 - fees.maker)
        if (p.exitFees !== undefined) p.exitFees += (at1 * p.tp1 + (d - at1) * p.tp2) * fees.maker
      }
      p.soldAcc = sold
    }

    if (!p.exiting && !p.tp1Done && p.tpsPlaced && p.tpIds[0] && !live.has(p.tpIds[0]) && sold >= p.q1 * 0.999) {
      p.tp1Done = true
      const be = p.entry * (1 + o.breakEvenBuffer)
      if (be > p.stop) p.stop = be
      p.stopFrom = barTime + 60
      log('tp.filled', { symbol: p.symbol, id: p.tpIds[0], qty: p.q1, price: p.tp1, newStop: p.stop })
    }

    const resting = open.some((x) => x.side === 'SELL' && (p.tpIds.includes(x.clientId) || x.clientId === p.exiting?.id))
    if (isDust(p, remaining) && !resting) {
      delete positions[p.symbol]
      const cost = p.qty * p.entry * (1 + fees.maker)
      const pnl = p.realized - cost
      const frac = p.equityAtEntry > 0 ? pnl / p.equityAtEntry : 0
      const entryFee = p.qty * p.entry * fees.maker
      // Positions restored from older state files have no running exit-fee total, so their exit fees are estimated from proceeds.
      const feeFields =
        p.exitFees !== undefined
          ? { feeTmn: entryFee + p.exitFees }
          : { feeTmnEst: entryFee + (p.realized * (p.exiting ? fees.taker : fees.maker)) / (1 - (p.exiting ? fees.taker : fees.maker)) }
      guard.recordTrade(frac, now)
      log('exit', {
        symbol: p.symbol,
        id: p.id,
        how: p.exiting?.reason ?? 'take profit',
        qty: p.qty,
        entry: p.entry,
        pnlTmn: pnl,
        pnlFraction: frac,
        equityAtEntry: p.equityAtEntry,
        dustQty: remaining,
        ...feeFields,
      })
      return true
    }
    return false
  }

  async function placeTps(ex: Exchange, p: Position) {
    const m = meta[p.symbol]
    const dec = decimals(p.symbol)
    const sellable = (q: number) => q > 0 && (!m || (q >= m.minQty && q * p.entry * 0.98 >= m.minNotional))
    let q1 = floorTo(p.qty * o.tp1Fraction, dec)
    let q2 = floorTo(p.qty - q1, dec)
    if (!sellable(q1) || !sellable(q2)) {
      q1 = floorTo(p.qty, dec)
      q2 = 0
    }
    p.q1 = q1
    p.q2 = q2
    p.tpsPlaced = true
    const legs = [{ id: `${p.id}-t1`, qty: q1, price: p.tp1, tag: 'TP1' }]
    if (q2 > 0) legs.push({ id: `${p.id}-t2`, qty: q2, price: p.tp2, tag: 'TP2' })
    p.tpIds = []
    for (const leg of legs) {
      const ack = await place(ex, {
        clientId: leg.id,
        symbol: p.symbol,
        side: 'SELL',
        type: 'LIMIT',
        price: leg.price,
        quantity: leg.qty,
        reason: `${leg.tag} for ${p.id}: ${p.reason}`,
        meta: { entry: p.entry, stop: p.stop },
      })
      if (ack.status === 'REJECTED') {
        log('tp.rejected', { symbol: p.symbol, id: leg.id, error: ack.error })
        continue
      }
      p.tpIds.push(leg.id)
      log('tp.placed', { symbol: p.symbol, id: leg.id, qty: leg.qty, price: leg.price })
    }
  }

  async function exitPosition(ex: Exchange, p: Position, reason: string, now: number) {
    for (const id of [...p.tpIds, p.exiting?.id ?? '']) if (id) await cancel(ex, id)
    p.tpIds = []
    const attempt = (p.exiting?.attempt ?? -1) + 1
    const bal = (await ex.balances())[baseOf(p.symbol)]
    const qty = floorTo(Math.min(bal?.free ?? 0, p.qty - p.soldAcc), decimals(p.symbol))
    if (!(qty > 0)) return
    let bid: number
    try {
      bid = (await ex.quote(p.symbol)).bid
    } catch (e) {
      log('exit.no_quote', { symbol: p.symbol, error: String(e) })
      p.exiting = { id: p.exiting?.id ?? '', reason: p.exiting?.reason ?? reason, price: p.exiting?.price ?? p.stop, attempt: attempt - 1 }
      return
    }
    const slip = Math.min(o.stopExitSlipMax, o.stopExitSlip * (1 + attempt))
    const price = bid * (1 - slip)
    const id = `${p.id}-x${attempt}`
    if (attempt === 0) log('stop.hit', { symbol: p.symbol, reason, stop: p.stop, bid, qty, now })
    const ack = await place(ex, {
      clientId: id,
      symbol: p.symbol,
      side: 'SELL',
      type: 'LIMIT',
      price,
      quantity: qty,
      reason: `${reason} exit for ${p.id}: ${p.reason}`,
      meta: { stop: p.stop, entry: p.entry, bid, attempt },
    })
    const fillPx = ack.status === 'FILLED' && ack.avgPrice ? ack.avgPrice : price
    p.exiting = { id, reason: p.exiting?.reason ?? reason, price: fillPx, attempt }
    if (ack.status === 'REJECTED') log('exit.rejected', { symbol: p.symbol, id, error: ack.error })
  }

  async function managePosition(ex: Exchange, p: Position, last: Candle | null, bid: number | null, now: number) {
    if (await sync(ex, p, last?.t ?? now, now)) return
    if (p.exiting) {
      const open = await ex.openOrders(p.symbol)
      if (!open.some((x) => x.clientId === p.exiting!.id)) await exitPosition(ex, p, p.exiting.reason, now)
    } else {
      let why: string | null = null
      if (last && last.t >= p.stopFrom && last.l <= p.stop) why = 'stop'
      else if (bid !== null && bid <= p.stop) why = 'stop'
      else if (last && (last.t - p.filledAt) / 60 >= o.timeStopBars && last.c < p.entry) why = 'time stop'
      if (why) await exitPosition(ex, p, why, now)
      else if (!p.tpsPlaced) await placeTps(ex, p)
    }
    await sync(ex, p, last?.t ?? now, now)
  }

  function toPosition(pd: Pending, filled: number, barTime: number): Position {
    return {
      symbol: pd.symbol,
      id: pd.id,
      qty: filled,
      entry: pd.entry,
      stop: pd.stop,
      initialStop: pd.stop,
      tp1: pd.tp1,
      tp2: pd.tp2 ?? pd.tp1,
      q1: 0,
      q2: 0,
      baseBefore: pd.baseBefore,
      filledAt: barTime,
      stopFrom: barTime,
      equityAtEntry: pd.equity,
      tpsPlaced: false,
      tpIds: [],
      tp1Done: false,
      soldAcc: 0,
      realized: 0,
      exitFees: 0,
      reason: pd.reason,
    }
  }

  async function filledQty(ex: Exchange, pd: Pending, afterCancel: boolean): Promise<number> {
    if (!afterCancel && (await ex.openOrders(pd.symbol)).some((x) => x.clientId === pd.id)) return 0
    const delta = (await baseTotal(ex, pd.symbol)) - pd.baseBefore
    return delta > 0 ? Math.min(delta, pd.qty) : 0
  }

  async function managePending(ex: Exchange, pd: Pending, last: Candle, now: number) {
    const adopt = (qty: number) => {
      delete pending[pd.symbol]
      const pos = toPosition(pd, qty, last.t)
      positions[pd.symbol] = pos
      log('entry.filled', { symbol: pd.symbol, id: pd.id, qty, entry: pd.entry, stop: pd.stop, tp1: pd.tp1, tp2: pd.tp2 })
      return pos
    }
    const q = await filledQty(ex, pd, false)
    if (q > 0) {
      adopt(q)
      return
    }
    let why: string | null = null
    const block = guard.blockReason(now)
    if (last.c < pd.invalidateBelow) why = 'invalidated'
    else if (now > pd.expiresAt) why = 'expired'
    else if (!entriesEnabled) why = 'entries disabled'
    else if (block) why = `guard: ${block}`
    if (!why) return
    await cancel(ex, pd.id)
    const late = await filledQty(ex, pd, true)
    if (late > 0) {
      adopt(late)
      return
    }
    delete pending[pd.symbol]
    log('entry.cancelled', { symbol: pd.symbol, id: pd.id, reason: why, close: last.c, now })
  }

  async function seek(ctx: BarCtx, last: Candle, now: number, equity: number) {
    const { symbol, bars, ex } = ctx
    const setup: SetupCandidate | null = await findSetup(symbol, bars, deps.detect)
    if (!setup) return
    const key = `${symbol}:${setup.sweep.t}:${setup.fvg.t}`
    if (traded.has(key)) return
    const reject = (reason: string, extra: Record<string, unknown> = {}) => {
      const sig = key + reason
      if (lastRejected.get(symbol) === sig) return
      lastRejected.set(symbol, sig)
      log('setup.rejected', { symbol, key, reason, entry: setup.entry, stop: setup.stop, tp1: setup.tp1, ...extra })
    }

    const block = guard.blockReason(now)
    if (block) return reject(`guard: ${block}`)

    let q
    try {
      q = await ex.quote(symbol)
    } catch (e) {
      return reject(`no quote: ${String(e)}`)
    }
    const spread = (q.ask - q.bid) / q.bid
    if (!(spread <= o.maxSpreadPct)) return reject('spread too wide', { spread, max: o.maxSpreadPct })

    const { entry, stop, tp1 } = setup
    if (!(stop > 0 && stop < entry && tp1 > entry)) return reject('invalid levels')
    const win = (tp1 - entry) / entry - fees.maker - fees.maker
    const loss = (entry - stop) / entry + fees.maker + fees.taker + o.slippagePct
    const netRr = win / loss
    if (!(netRr >= o.minNetRr)) return reject('net RR too low', { netRr, win, loss, min: o.minNetRr })

    const m = meta[symbol]
    if (!m) return reject('no market meta')
    const riskPct = guard.riskPct()
    const size = positionSize({ equity, entry, stop, qtyDecimals: m.qtyDecimals, minNotional: m.minNotional, riskPct, slipPct: o.slippagePct, makerFee: fees.maker, takerFee: fees.taker })
    if (!size.ok) return reject(`sizing: ${size.reason}`)

    let qty = size.qty
    const proposed = qty * entry
    let verdict: Verdict
    try {
      verdict = await supervisor.review({
        setup,
        equityTmn: equity,
        proposedNotionalTmn: proposed,
        proposedPctOfEquity: equity > 0 ? proposed / equity : 0,
        openPositions: Object.values(positions).map((p) => ({ symbol: p.symbol, notionalTmn: (p.qty - p.soldAcc) * p.entry })),
        dayPnlPct: guard.state().dayPnlPct,
      })
    } catch (e) {
      log('supervisor.error', { symbol, error: String(e) })
      verdict = { action: 'approve', sizeMult: 1, reason: `supervisor error: ${String(e)}`, source: 'fallback', model: 'none', latencyMs: 0 }
    }
    if (verdict.action === 'veto') return reject('supervisor veto', { verdict })
    if (verdict.action === 'resize') {
      const mult = Math.min(1, Math.max(0, Number(verdict.sizeMult)))
      qty = floorTo(qty * (Number.isFinite(mult) ? mult : 0), m.qtyDecimals)
      if (!(qty > 0 && qty >= m.minQty && qty * entry >= m.minNotional)) return reject('resized below minimum', { verdict, qty })
    }

    const bal = await ex.balances()
    const freeTmn = bal.TMN?.free ?? 0
    if (freeTmn < qty * entry * (1 + fees.maker)) return reject('insufficient free TMN', { freeTmn, needed: qty * entry * (1 + fees.maker) })

    const id = `ict-${symbol.replace(/[^A-Za-z0-9]/g, '').slice(0, 14)}-${last.t}`
    const sizing = { qty, notional: qty * entry, pctOfEquity: equity > 0 ? (qty * entry) / equity : 0, capped: size.capped, lossPctAtStop: size.lossPct * (qty / size.qty), riskPct, netRr }
    log('setup.accepted', { symbol, key, ...sizing, entry, stop, tp1, tp2: setup.tp2, verdict: verdict.action, verdictReason: verdict.reason })

    const baseBefore = await baseTotal(ex, symbol)
    traded.add(key)
    const ack = await place(ex, {
      clientId: id,
      symbol,
      side: 'BUY',
      type: 'LIMIT',
      price: entry,
      quantity: qty,
      reason: setup.rationale,
      meta: { setup, sizing, verdict, equity },
    })
    if (ack.status === 'REJECTED') {
      log('entry.rejected', { symbol, id, error: ack.error })
      return
    }
    pending[symbol] = {
      symbol,
      id,
      qty,
      entry,
      stop,
      tp1,
      tp2: setup.tp2,
      expiresAt: setup.expiresAt,
      invalidateBelow: setup.invalidateBelow,
      baseBefore,
      equity,
      reason: setup.rationale,
    }
    log('entry.placed', { symbol, id, qty, entry, stop, tp1, tp2: setup.tp2, expiresAt: setup.expiresAt, status: ack.status })
    if (ack.status === 'FILLED') await managePending(ex, pending[symbol]!, last, now)
  }

  async function handleBar(ctx: BarCtx) {
    const { symbol, bars, ex } = ctx
    const last = bars[bars.length - 1]
    if (!last) return
    const now = last.t + 60
    const equity = await equityTmn(ex)
    guard.updateEquity(equity, now)

    const pd = pending[symbol]
    if (pd) await managePending(ex, pd, last, now)
    const pos = positions[symbol]
    if (pos) await managePosition(ex, pos, last, null, now)
    if (!pending[symbol] && !positions[symbol] && entriesEnabled && countOpen() < o.maxPositions) await seek(ctx, last, now, equity)
  }

  async function handleTick(ctx: TickCtx) {
    const p = positions[ctx.symbol]
    if (!p || p.exiting || !(ctx.quote.bid <= p.stop)) return
    await managePosition(ctx.ex, p, null, ctx.quote.bid, ctx.now)
  }

  return {
    name: 'ict',
    async onBar(ctx) {
      await serial(() => handleBar(ctx))
      return []
    },
    async onTick(ctx) {
      await serial(() => handleTick(ctx))
      return []
    },
    setEntriesEnabled(enabled) {
      entriesEnabled = enabled
    },
    getState(): State {
      return JSON.parse(JSON.stringify({ positions, pending, traded: [...traded].slice(-500) }))
    },
    restoreState(s) {
      positions = {}
      pending = {}
      traded = new Set()
      if (!isObj(s)) return
      if (isObj(s.positions))
        for (const [k, v] of Object.entries(s.positions))
          if (isObj(v) && typeof v.symbol === 'string' && finite(v.qty, v.entry, v.stop, v.tp1, v.tp2, v.baseBefore, v.soldAcc, v.realized, v.q1, v.q2))
            positions[k] = structuredClone(v) as unknown as Position
      if (isObj(s.pending))
        for (const [k, v] of Object.entries(s.pending))
          if (isObj(v) && typeof v.symbol === 'string' && typeof v.id === 'string' && finite(v.qty, v.entry, v.stop, v.tp1, v.baseBefore, v.expiresAt, v.invalidateBelow))
            pending[k] = structuredClone(v) as unknown as Pending
      if (Array.isArray(s.traded)) for (const k of s.traded) if (typeof k === 'string') traded.add(k)
    },
    openPositions() {
      return Object.values(positions).map((p) => {
        const qty = p.qty - p.soldAcc
        return { symbol: p.symbol, qty, entry: p.entry, stop: p.stop, tp1: p.tp1, notional: qty * p.entry }
      })
    },
  }
}
