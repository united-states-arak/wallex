import './env'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { loadCandles } from '../src/data/candles'
import { PaperExchange } from '../src/exchange/paper'
import { loadBlocked } from '../src/exchange/validate'
import { nullLog } from '../src/log'
import { pullout } from '../src/pullout'
import { getSettings } from '../src/settings'
import type { Balances, Candle, Exchange, Markets, OpenOrder, OrderAck, OrderReq, Quote, Strategy } from '../src/types'
import { WallexRest } from '../src/wallex/rest'

// ---- Fixed by the arena. Every strategy sees the same data, window split, markets, costs and risk rules. ----
const DAY = 86_400
export const END = Date.parse('2026-10-22T00:00:00Z') / 1000
export const START = END - 180 * DAY
export const SPLIT = START + 120 * DAY // train: START..SPLIT (120 days). test: SPLIT..END (60 days, final ranking only)
export const SYMBOLS = ['PEPETMN', 'PUMPTMN', 'USOONTMN', 'BNBTMN', 'ETHTMN', 'XRPTMN', 'ARBTMN', 'DOGETMN', 'ADATMN', 'STMN', 'SOLTMN', 'APETMN', 'TRXTMN', 'LTCTMN', 'AAVETMN']
const MAX_POSITIONS = 2 // open positions plus pending entries
const MAX_POSITION_PCT = 0.5 // one position (held plus resting buys) may be at most this share of equity
const WARMUP = 3 * DAY

const { values: a } = parseArgs({
  options: {
    strategy: { type: 'string' },
    window: { type: 'string', default: 'train' },
    days: { type: 'string' }, // use only the last N days of the window (faster development runs)
    span: { type: 'string' }, // train sub-range in days from the start, e.g. 0:80 or 80:120 (for validating inside the train period)
    symbols: { type: 'string' },
    json: { type: 'boolean', default: false },
  },
})
if (!a.strategy) throw new Error('usage: bun arena/run.ts --strategy arena/<you>/strategy.ts [--window train|test|all] [--days N] [--symbols A,B] [--json]')
const window = a.window as 'train' | 'test' | 'all'
if (!['train', 'test', 'all'].includes(window)) throw new Error('--window must be train, test or all')
if (window !== 'train' && process.env.ARENA_FINAL !== '1') {
  throw new Error('the test window is held out for the final ranking and is run by the judge only. Use --window train.')
}

let from = window === 'test' ? SPLIT : START
let to = window === 'train' ? SPLIT : END
if (a.days) from = Math.max(from, to - Number(a.days) * DAY)
if (a.span) {
  const [x, y] = a.span.split(':').map(Number)
  if (window !== 'train' || !(x! >= 0 && y! > x! && y! <= 120)) throw new Error('--span a:b needs --window train and 0 <= a < b <= 120 (days from the start)')
  from = START + x! * DAY
  to = START + y! * DAY
}
const symbols = a.symbols ? a.symbols.split(',').map((s) => s.trim()) : SYMBOLS

const rest = new WallexRest()
const meta: Markets = await rest.markets()
const blocked = loadBlocked()
const startTmn = getSettings().paper.startTmn
const ex = new PaperExchange(meta, blocked, { TMN: startTmn })

// ---- Rules enforced on every order, whichever way the strategy places it. ----
const violations: Record<string, number> = {}
const bad = (kind: string, clientId: string): OrderAck => {
  violations[kind] = (violations[kind] ?? 0) + 1
  return { clientId, status: 'REJECTED', error: `arena rule: ${kind}` }
}
const allowed = new Set(SYMBOLS)
const gex: Exchange = {
  get mode() {
    return ex.mode
  },
  balances: (): Promise<Balances> => ex.balances(),
  quote: (s: string): Promise<Quote> => ex.quote(s),
  openOrders: (s?: string): Promise<OpenOrder[]> => ex.openOrders(s),
  cancel: (id: string) => ex.cancel(id),
  async place(o: OrderReq): Promise<OrderAck> {
    if (o.type !== 'LIMIT') return bad('only LIMIT orders (market orders are disabled on Wallex)', o.clientId)
    if (!allowed.has(o.symbol)) return bad('symbol outside the arena universe', o.clientId)
    if (o.side === 'BUY') {
      const equity = ex.equity()
      const bals = await ex.balances()
      const open = await ex.openOrders()
      const held = new Set<string>()
      for (const x of open) if (x.side === 'BUY') held.add(x.symbol)
      for (const [asset, b] of Object.entries(bals)) {
        const sym = `${asset}TMN`
        if (asset === 'TMN' || !allowed.has(sym)) continue
        const q = await ex.quote(sym).catch(() => null)
        if (q && (b.free + b.locked) * q.bid >= (meta[sym]?.minNotional ?? 0)) held.add(sym)
      }
      if (!held.has(o.symbol) && held.size >= MAX_POSITIONS) return bad(`more than ${MAX_POSITIONS} open positions plus pending entries`, o.clientId)
      const base = meta[o.symbol]!.base
      const q = await ex.quote(o.symbol).catch(() => null)
      const heldValue = q ? ((bals[base]?.free ?? 0) + (bals[base]?.locked ?? 0)) * q.bid : 0
      const resting = open.filter((x) => x.side === 'BUY' && x.symbol === o.symbol).reduce((s, x) => s + x.price * x.quantity, 0)
      if (heldValue + resting + o.quantity * (o.price ?? 0) > MAX_POSITION_PCT * equity * 1.000001) return bad(`position above ${MAX_POSITION_PCT * 100}% of equity`, o.clientId)
    }
    return ex.place(o)
  },
}

// ---- Strategy ----
const mod = await import(resolve(a.strategy))
const create = mod.default ?? mod.create
if (typeof create !== 'function') throw new Error(`${a.strategy} must export default (or create): (ctx) => Strategy`)
const strategy: Strategy = await create({ meta, startTmn, symbols })

// ---- Data ----
const bars: Record<string, Candle[]> = {}
for (const s of symbols) bars[s] = await loadCandles(rest, s, from - WARMUP, to)
const feed = Object.entries(bars)
  .flatMap(([symbol, list]) => list.map((c) => ({ symbol, c })))
  .sort((x, y) => x.c.t - y.c.t || x.symbol.localeCompare(y.symbol))

// ---- Run ----
const maxHistory = getSettings().data.historyBars
const hist: Record<string, Candle[]> = {}
let peak = startTmn
let maxDd = 0
let expSum = 0
let expN = 0
const daily: number[] = []
let lastDay = -1
const t0 = performance.now()
for (const { symbol, c } of feed) {
  ex.onCandle(symbol, c)
  const h = (hist[symbol] ??= [])
  h.push(c)
  if (h.length > maxHistory) h.shift()
  if (c.t >= from) {
    const orders = await strategy.onBar({ symbol, bars: h, ex: gex })
    for (const o of orders) await gex.place(o)
    const eq = ex.equity()
    const tmnBal = ex['bal']?.TMN as { free: number; locked: number } | undefined
    if (tmnBal && eq > 0) {
      expSum += Math.max(0, 1 - (tmnBal.free + tmnBal.locked) / eq)
      expN++
    }
    peak = Math.max(peak, eq)
    maxDd = Math.max(maxDd, (peak - eq) / peak)
    const day = Math.floor(c.t / DAY)
    if (day !== lastDay) {
      daily.push(eq)
      lastDay = day
    }
  }
}
const dd = maxDd
await pullout(ex, meta, { execute: true, waitMs: 0, log: nullLog })
const endTmn = (await ex.balances()).TMN?.free ?? 0

// ---- Round trips from fills (average cost, fees included). A trip ends when the position is back to zero. ----
interface Trip { symbol: string; pnl: number; pct: number; t0: number; t1: number }
const trips: Trip[] = []
const book: Record<string, { qty: number; cost: number; paid: number; pnl: number; t0: number }> = {}
for (const f of ex.fills) {
  const b = (book[f.symbol] ??= { qty: 0, cost: 0, paid: 0, pnl: 0, t0: f.t })
  if (f.side === 'BUY') {
    if (b.qty < 1e-12) b.t0 = f.t
    b.qty += f.qty
    b.cost += f.qty * f.price + f.fee
    b.paid += f.qty * f.price + f.fee
  } else {
    const avg = b.cost / b.qty
    b.pnl += f.qty * f.price - f.fee - avg * f.qty
    b.cost -= avg * f.qty
    b.qty -= f.qty
    if (b.qty < 1e-9 * Math.max(1, f.qty)) {
      trips.push({ symbol: f.symbol, pnl: b.pnl, pct: b.paid > 0 ? b.pnl / b.paid : 0, t0: b.t0, t1: f.t })
      book[f.symbol] = { qty: 0, cost: 0, paid: 0, pnl: 0, t0: f.t }
    }
  }
}
const wins = trips.filter((t) => t.pnl > 0)
const grossWin = wins.reduce((s, t) => s + t.pnl, 0)
const grossLoss = trips.filter((t) => t.pnl <= 0).reduce((s, t) => s - t.pnl, 0)
const rets = daily.slice(1).map((e, i) => e / daily[i]! - 1)
const mean = rets.reduce((s, x) => s + x, 0) / Math.max(1, rets.length)
const sd = Math.sqrt(rets.reduce((s, x) => s + (x - mean) ** 2, 0) / Math.max(1, rets.length - 1))
const days = (to - from) / DAY
const perSymbol: Record<string, { trips: number; pnl: number }> = {}
for (const t of trips) {
  const p = (perSymbol[t.symbol] ??= { trips: 0, pnl: 0 })
  p.trips++
  p.pnl += Math.round(t.pnl)
}
const out = {
  strategy: strategy.name,
  window: a.span ? `train days ${a.span}` : a.days ? `${window} (last ${a.days}d)` : window,
  from: new Date(from * 1000).toISOString().slice(0, 10),
  to: new Date(to * 1000).toISOString().slice(0, 10),
  symbols: symbols.length,
  returnPct: +(((endTmn - startTmn) / startTmn) * 100).toFixed(2),
  maxDrawdownPct: +(dd * 100).toFixed(2),
  roundTrips: trips.length,
  tripsPerDay: +(trips.length / days).toFixed(2),
  winRatePct: +((wins.length / Math.max(1, trips.length)) * 100).toFixed(1),
  avgTripPct: +((trips.reduce((s, t) => s + t.pct, 0) / Math.max(1, trips.length)) * 100).toFixed(2),
  profitFactor: grossLoss > 0 ? +(grossWin / grossLoss).toFixed(2) : grossWin > 0 ? 99 : 0,
  sharpeDaily: sd > 0 ? +((mean / sd) * Math.sqrt(365)).toFixed(2) : 0,
  avgExposurePct: +((expSum / Math.max(1, expN)) * 100).toFixed(1), // share of equity held in coins, averaged over bars
  feesTmn: Math.round(ex.fills.reduce((s, f) => s + f.fee, 0)),
  volumeTmn: Math.round(ex.fills.reduce((s, f) => s + f.qty * f.price, 0)),
  ruleViolations: violations,
  seconds: Math.round((performance.now() - t0) / 1000),
  perSymbol,
}
if (a.json) console.log(JSON.stringify(out))
else console.log(out)
