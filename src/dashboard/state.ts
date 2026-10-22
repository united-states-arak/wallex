import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { getSettings, type Settings } from '../settings'

type Obj = Record<string, unknown>

export interface LogEvent extends Obj {
  ts: string
  event: string
}

export interface Limits {
  riskPct: number
  lock1Pnl: number
  lock1Risk: number
  lock2Pnl: number
  lock2Risk: number
  dailyLossHalt: number
  hardDrawdown: number
}

export interface GuardView {
  equity: number
  startEquity: number
  dayPeak: number
  dayPnlPct: number
  totalPnlPct: number
  consecutiveLosses: number
  halted: boolean
  haltReason: string | null
  riskPct: number
}

export interface PositionView {
  symbol: string
  id: string | null
  qty: number
  entry: number
  stop: number
  stop0: number
  tp1: number
  tp2: number | null
  notional: number
  mark: number | null
  tp1Done: boolean
  stopping: boolean
  openedAt: number | null
}

export interface PendingView {
  id: string
  symbol: string
  qty: number
  entry: number
  stop: number
  tp1: number
  tp2: number | null
  notional: number
  expiresAt: number | null
  status: string
  placedAt: number
}

export interface TradeView {
  ts: number
  id: string | null
  symbol: string
  how: string
  qty: number | null
  entry: number | null
  pnlTmn: number | null
  pnlFraction: number | null
  r: number | null
  fees: number | null
  feesEst: boolean
}

export interface SetupRow {
  seq: number
  ts: number
  symbol: string
  status: 'accepted' | 'rejected'
  reason: string
  entry: number | null
  stop: number | null
  tp1: number | null
  netRr: number | null
  notional: number | null
  verdict: string | null
}

export interface AiRow {
  seq: number
  ts: number
  symbol: string
  action: string
  sizeMult: number | null
  reason: string
  source: string
  model: string
  latencyMs: number | null
  toolCalls: string[]
}

export interface OrderRow {
  id: string
  ts: number
  symbol: string
  side: string
  type: string
  price: number | null
  qty: number | null
  reason: string
  via: string
  status: string
  error: string | null
  decisionMs: number | null
}

export interface LogRow {
  seq: number
  ts: number
  event: string
  summary: string
  raw: string
}

export interface ActivityRow {
  seq: number
  ts: number
  kind: string
  tone: 'good' | 'bad' | 'warn' | 'info'
  text: string
}

export interface View {
  seq: number
  lastTs: number
  run: {
    mode: string | null
    symbols: string[]
    sha: string | null
    strategy: string | null
    startedAt: number | null
    runEnd: number | null
    entryCutoffAt: number | null
    flattenAt: number | null
    resumed: boolean
    startEquity: number | null
    reportedPhase: string | null
    stopped: { ts: number; reason: string; flat: boolean | null; endEquity: number | null; positionsLeft: string[] } | null
    flatten: { ts: number; flat: boolean | null; tmn: number | null; remaining: number } | null
  }
  equity: { series: [number, number][]; peak: number | null; last: number | null; lastTs: number | null }
  guard: GuardView | null
  guardTs: number | null
  blockReason: string | null
  hb: {
    ts: number | null
    count: number
    api: { total: number; consecutive: number; byKind: Record<string, number> }
    strategyErrors: number
    holdings: string[]
    barAge: Record<string, number | null>
  }
  positions: PositionView[]
  fills: Record<string, { stop0: number; entry: number; qty: number; ts: number }>
  pending: PendingView[]
  trades: TradeView[]
  setups: SetupRow[]
  setupCounts: { accepted: number; rejected: number }
  reasons: Record<string, number>
  ai: AiRow[]
  aiStats: { n: number; fallback: number; actions: Record<string, number>; latencies: number[] }
  orders: OrderRow[]
  errors: { counts: Record<string, number>; recent: ActivityRow[] }
  activity: ActivityRow[]
  logTail: LogRow[]
  eventCounts: Record<string, number>
}

const CAPS = { series: 2400, trades: 300, setups: 250, ai: 150, orders: 200, errors: 60, activity: 40, log: 1500 }

export const ERROR_EVENTS = new Set([
  'poll.error',
  'daemon.api_error',
  'exit.rejected',
  'daemon.degraded',
  'daemon.strategy_error',
  'daemon.loop_error',
  'daemon.poll_crashed',
  'daemon.persist_error',
  'daemon.shutdown_error',
  'daemon.restore_failed',
  'daemon.unflat_exit',
  'order.error',
  'order.cancel_error',
  'entry.rejected',
  'tp.rejected',
  'exit.no_quote',
  'supervisor.error',
  'exchange.place_failed',
  'dry.rejected',
])

const isObj = (x: unknown): x is Obj => typeof x === 'object' && x !== null && !Array.isArray(x)
const num = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null)
const str = (x: unknown): string | null => (typeof x === 'string' && x !== '' ? x : null)
const strs = (x: unknown): string[] => (Array.isArray(x) ? x.filter((s): s is string => typeof s === 'string') : [])
const ms = (x: unknown): number | null => {
  if (typeof x === 'string') {
    const t = Date.parse(x)
    return Number.isFinite(t) ? t : null
  }
  const n = num(x)
  if (n === null) return null
  return n < 1e12 ? n * 1000 : n
}

export function limitsFromSettings(settings: Settings = getSettings()): Limits {
  const r = settings.risk
  const [t1, t2] = r.lockTiers
  return {
    riskPct: r.riskPct,
    lock1Pnl: t1?.pnl ?? Infinity,
    lock1Risk: t1?.riskPct ?? r.riskPct,
    lock2Pnl: t2?.pnl ?? Infinity,
    lock2Risk: t2?.riskPct ?? r.riskPct,
    dailyLossHalt: r.dayLossHalt,
    hardDrawdown: r.hardDrawdown,
  }
}

export function createView(): View {
  return {
    seq: 0,
    lastTs: 0,
    run: {
      mode: null,
      symbols: [],
      sha: null,
      strategy: null,
      startedAt: null,
      runEnd: null,
      entryCutoffAt: null,
      flattenAt: null,
      resumed: false,
      startEquity: null,
      reportedPhase: null,
      stopped: null,
      flatten: null,
    },
    equity: { series: [], peak: null, last: null, lastTs: null },
    guard: null,
    guardTs: null,
    blockReason: null,
    hb: { ts: null, count: 0, api: { total: 0, consecutive: 0, byKind: {} }, strategyErrors: 0, holdings: [], barAge: {} },
    positions: [],
    fills: {},
    pending: [],
    trades: [],
    setups: [],
    setupCounts: { accepted: 0, rejected: 0 },
    reasons: {},
    ai: [],
    aiStats: { n: 0, fallback: 0, actions: {}, latencies: [] },
    orders: [],
    errors: { counts: {}, recent: [] },
    activity: [],
    logTail: [],
    eventCounts: {},
  }
}

export function parseLine(line: string): LogEvent | null {
  const s = line.trim()
  if (!s || s[0] !== '{') return null
  try {
    const j = JSON.parse(s)
    if (!isObj(j) || typeof j.event !== 'string' || j.event === '') return null
    return { ...j, ts: typeof j.ts === 'string' ? j.ts : '', event: j.event }
  } catch {
    return null
  }
}

export function reasonKey(reason: string): string {
  const parts = reason.split(':').map((p) => p.trim())
  const clean = (p: string) => p.split(/[,(]/)[0]!.replace(/\s*[-\d].*$/, '').trim() || p
  if ((parts[0] === 'guard' || parts[0] === 'sizing') && parts[1]) return `${parts[0]}: ${clean(parts[1])}`
  if (parts[0] === 'no quote') return 'no quote'
  return clean(parts[0] ?? reason) || reason
}

function summarize(ev: Obj): string {
  const out: string[] = []
  for (const [k, v] of Object.entries(ev)) {
    if (k === 'ts' || k === 'sha' || k === 'event') continue
    let s: string
    if (typeof v === 'string') s = v
    else if (typeof v === 'number' || typeof v === 'boolean') s = String(v)
    else if (v === null || v === undefined) continue
    else s = JSON.stringify(v)
    out.push(`${k}=${s.length > 90 ? s.slice(0, 87) + '…' : s}`)
    if (out.join(' ').length > 260) break
  }
  return out.join(' ')
}

function push<T>(arr: T[], item: T, cap: number) {
  arr.push(item)
  if (arr.length > cap + Math.ceil(cap / 4)) arr.splice(0, arr.length - cap)
}

function decimate(series: [number, number][]) {
  if (series.length <= CAPS.series) return
  const last = series[series.length - 1]!
  const kept = series.filter((_, i) => i % 2 === 0)
  if (kept[kept.length - 1] !== last) kept.push(last)
  series.length = 0
  series.push(...kept)
}

function normalizeGuard(g: unknown): GuardView | null {
  if (!isObj(g)) return null
  const equity = num(g.equity)
  const startEquity = num(g.startEquity)
  if (equity === null || startEquity === null) return null
  return {
    equity,
    startEquity,
    dayPeak: num(g.dayPeak) ?? equity,
    dayPnlPct: num(g.dayPnlPct) ?? 0,
    totalPnlPct: num(g.totalPnlPct) ?? equity / startEquity - 1,
    consecutiveLosses: num(g.consecutiveLosses) ?? 0,
    halted: g.halted === true,
    haltReason: str(g.haltReason),
    riskPct: num(g.riskPct) ?? 0.01,
  }
}

function normalizePosition(raw: unknown, marks: Obj | null, prior: PositionView[], fills: View['fills']): PositionView | null {
  if (!isObj(raw)) return null
  const symbol = str(raw.symbol)
  const entry = num(raw.entry)
  const qty = num(raw.qty)
  if (!symbol || entry === null || qty === null) return null
  const stop = num(raw.stop) ?? entry
  const was = prior.find((p) => p.symbol === symbol)
  const id = str(raw.id) ?? was?.id ?? null
  const fill = id ? fills[id] : undefined
  let mark = num(raw.mark) ?? num(raw.bid)
  if (mark === null && marks) {
    const m = marks[symbol]
    mark = num(m) ?? (isObj(m) ? (num(m.bid) ?? num(m.price)) : null)
  }
  return {
    symbol,
    id,
    qty,
    entry,
    stop,
    stop0: fill?.stop0 ?? was?.stop0 ?? stop,
    tp1: num(raw.tp1) ?? entry,
    tp2: num(raw.tp2) ?? was?.tp2 ?? null,
    notional: num(raw.notional) ?? qty * entry,
    mark: mark ?? was?.mark ?? null,
    tp1Done: raw.tp1Done === true || was?.tp1Done === true,
    stopping: was?.stopping ?? false,
    openedAt: was?.openedAt ?? fill?.ts ?? null,
  }
}

const f = (n: number | null, d = 0) => (n === null ? '?' : n.toLocaleString('en-US', { maximumFractionDigits: d }))

export function fold(v: View, input: unknown, rawLine?: string): boolean {
  if (!isObj(input) || typeof input.event !== 'string' || input.event === '') return false
  const ev = input as LogEvent
  const name = ev.event
  const parsed = ms(ev.ts)
  const t = parsed ?? (v.lastTs || Date.now())
  if (parsed !== null && parsed > v.lastTs) v.lastTs = parsed
  const seq = ++v.seq
  v.eventCounts[name] = (v.eventCounts[name] ?? 0) + 1
  const raw = rawLine ?? JSON.stringify(ev)
  push(v.logTail, { seq, ts: t, event: name, summary: summarize(ev), raw: raw.length > 3000 ? raw.slice(0, 3000) + '…' : raw }, CAPS.log)

  const symbol = str(ev.symbol) ?? '?'
  const act = (kind: string, tone: ActivityRow['tone'], text: string) => push(v.activity, { seq, ts: t, kind, tone, text }, CAPS.activity)

  if (ERROR_EVENTS.has(name)) {
    v.errors.counts[name] = (v.errors.counts[name] ?? 0) + 1
    const text = `${str(ev.symbol) ? ev.symbol + ': ' : ''}${str(ev.error) ?? str(ev.reason) ?? name}`
    const row: ActivityRow = { seq, ts: t, kind: name, tone: name === 'daemon.degraded' ? 'bad' : 'warn', text: text.slice(0, 200) }
    push(v.errors.recent, row, CAPS.errors)
    if (name === 'daemon.degraded') act(name, 'bad', `API degraded for ${f(num(ev.failingForSec))}s with positions open`)
  }

  switch (name) {
    case 'daemon.start': {
      const r = v.run
      r.mode = str(ev.mode) ?? r.mode
      r.symbols = strs(ev.symbols)
      r.sha = str(ev.sha) ?? r.sha
      r.strategy = str(ev.strategy) ?? r.strategy
      r.startedAt = t
      r.runEnd = ms(ev.runEnd) ?? r.runEnd
      r.entryCutoffAt = ms(ev.entryCutoffAt) ?? r.entryCutoffAt
      r.flattenAt = ms(ev.flattenAt) ?? r.flattenAt
      r.resumed = ev.resumed === true
      r.startEquity = num(ev.startEquity) ?? r.startEquity
      r.stopped = null
      r.reportedPhase = 'trading'
      act(name, 'info', `Daemon started in ${r.mode ?? '?'} mode${r.resumed ? ' (resumed)' : ''}`)
      break
    }
    case 'daemon.stop':
      v.run.stopped = {
        ts: t,
        reason: str(ev.reason) ?? 'unknown',
        flat: typeof ev.flat === 'boolean' ? ev.flat : null,
        endEquity: num(ev.endEquity),
        positionsLeft: strs(ev.positionsLeft),
      }
      act(name, ev.flat === false ? 'warn' : 'info', `Daemon stopped (${v.run.stopped.reason})${ev.flat === false ? ', positions left open' : ''}`)
      break
    case 'daemon.entries_disabled':
      v.run.reportedPhase = 'entries_off'
      act(name, 'warn', `Entries disabled: ${str(ev.reason) ?? 'cutoff'}`)
      break
    case 'daemon.flatten_phase':
      v.run.reportedPhase = 'flattening'
      act(name, 'warn', 'Flatten phase began')
      break
    case 'daemon.flatten':
      v.run.flatten = { ts: t, flat: typeof ev.flat === 'boolean' ? ev.flat : null, tmn: num(ev.tmn), remaining: Array.isArray(ev.remaining) ? ev.remaining.length : 0 }
      break
    case 'daemon.heartbeat': {
      const hb = v.hb
      hb.ts = t
      hb.count++
      v.run.mode = str(ev.mode) ?? v.run.mode
      const ph = str(ev.phase)
      if (ph) v.run.reportedPhase = ph
      const msToEnd = num(ev.msToEnd)
      if (msToEnd !== null && v.run.runEnd === null) v.run.runEnd = t + msToEnd
      const g = normalizeGuard(ev.guard)
      if (g) {
        v.guard = g
        v.guardTs = t
        v.run.startEquity ??= g.startEquity
      }
      v.blockReason = str(ev.blockReason)
      const marks = isObj(ev.marks) ? ev.marks : null
      if (Array.isArray(ev.positions)) {
        const next = ev.positions.map((p) => normalizePosition(p, marks, v.positions, v.fills)).filter((p): p is PositionView => p !== null)
        v.positions = next
      }
      hb.holdings = strs(ev.holdings)
      if (isObj(ev.barAgeSec)) {
        const ages: Record<string, number | null> = {}
        for (const [s, a] of Object.entries(ev.barAgeSec)) ages[s] = num(a)
        hb.barAge = ages
      }
      if (isObj(ev.api)) {
        hb.api = {
          total: num(ev.api.total) ?? 0,
          consecutive: num(ev.api.consecutive) ?? 0,
          byKind: isObj(ev.api.byKind) ? Object.fromEntries(Object.entries(ev.api.byKind).map(([k, n]) => [k, num(n) ?? 0])) : {},
        }
      }
      hb.strategyErrors = num(ev.strategyErrors) ?? hb.strategyErrors
      const eq = num(ev.equity)
      if (eq !== null && eq > 0) pushEquity(v, t, eq)
      break
    }
    case 'poll.warmup':
      if (str(ev.symbol) && !v.run.symbols.includes(symbol)) v.run.symbols.push(symbol)
      break
    case 'setup.accepted':
    case 'setup.rejected': {
      const accepted = name === 'setup.accepted'
      let reason = accepted ? 'accepted' : (str(ev.reason) ?? 'unknown')
      const verdictObj = isObj(ev.verdict) ? ev.verdict : null
      if (!accepted && verdictObj && reason === 'supervisor veto' && str(verdictObj.reason)) reason = `supervisor veto: ${verdictObj.reason}`
      const key = accepted ? 'accepted' : reasonKey(reason)
      if (accepted) v.setupCounts.accepted++
      else {
        v.setupCounts.rejected++
        v.reasons[key] = (v.reasons[key] ?? 0) + 1
      }
      const row: SetupRow = {
        seq,
        ts: t,
        symbol,
        status: accepted ? 'accepted' : 'rejected',
        reason: accepted ? (str(ev.verdictReason) ?? 'accepted') : reason,
        entry: num(ev.entry),
        stop: num(ev.stop),
        tp1: num(ev.tp1),
        netRr: num(ev.netRr),
        notional: num(ev.notional),
        verdict: accepted ? str(ev.verdict) : null,
      }
      push(v.setups, row, CAPS.setups)
      if (accepted) act(name, 'good', `${symbol} setup accepted${row.verdict ? ` (${row.verdict})` : ''}`)
      break
    }
    case 'ai.verdict': {
      const row: AiRow = {
        seq,
        ts: t,
        symbol,
        action: str(ev.action) ?? 'unknown',
        sizeMult: num(ev.sizeMult),
        reason: str(ev.reason) ?? '',
        source: str(ev.source) ?? 'unknown',
        model: str(ev.model) ?? '',
        latencyMs: num(ev.latencyMs),
        toolCalls: strs(ev.toolCalls),
      }
      push(v.ai, row, CAPS.ai)
      const s = v.aiStats
      s.n++
      if (row.source === 'fallback') s.fallback++
      s.actions[row.action] = (s.actions[row.action] ?? 0) + 1
      if (row.source === 'ai' && row.latencyMs !== null) push(s.latencies, row.latencyMs, 300)
      break
    }
    case 'order.intent': {
      const id = str(ev.clientId) ?? `intent-${seq}`
      let row = v.orders.find((o) => o.id === id)
      if (!row) {
        row = { id, ts: t, symbol, side: '', type: '', price: null, qty: null, reason: '', via: '', status: 'sent', error: null, decisionMs: null }
        push(v.orders, row, CAPS.orders)
      }
      row.side = str(ev.side) ?? row.side
      row.type = str(ev.type) ?? row.type
      row.price = num(ev.price) ?? row.price
      row.qty = num(ev.quantity) ?? row.qty
      row.reason = str(ev.reason) ?? row.reason
      row.via = str(ev.via) ?? row.via
      break
    }
    case 'order.ack': {
      const id = str(ev.clientId) ?? `ack-${seq}`
      let row = v.orders.find((o) => o.id === id)
      if (!row) {
        row = { id, ts: t, symbol, side: '', type: '', price: null, qty: null, reason: '', via: '', status: 'sent', error: null, decisionMs: null }
        push(v.orders, row, CAPS.orders)
      }
      row.status = str(ev.status) ?? row.status
      row.error = str(ev.error)
      row.decisionMs = num(ev.decisionMs)
      break
    }
    case 'pullout.sell': {
      const ack = isObj(ev.ack) ? ev.ack : {}
      push(
        v.orders,
        {
          id: str(ack.clientId) ?? `po-${seq}`,
          ts: t,
          symbol: str(ev.symbol) ?? symbol,
          side: 'SELL',
          type: 'LIMIT',
          price: num(ev.price),
          qty: num(ev.qty),
          reason: 'pullout: convert holdings to TMN',
          via: 'pullout',
          status: str(ack.status) ?? 'sent',
          error: str(ack.error),
          decisionMs: null,
        },
        CAPS.orders,
      )
      break
    }
    case 'pullout.done':
      act(name, 'info', `Pullout finished, ${Array.isArray(ev.remaining) ? ev.remaining.length : 0} holdings remain`)
      break
    case 'entry.placed': {
      const id = str(ev.id) ?? `${symbol}-${seq}`
      const entry = num(ev.entry) ?? 0
      const qty = num(ev.qty) ?? 0
      v.pending = v.pending.filter((p) => p.id !== id && p.symbol !== symbol)
      v.pending.push({
        id,
        symbol,
        qty,
        entry,
        stop: num(ev.stop) ?? entry,
        tp1: num(ev.tp1) ?? entry,
        tp2: num(ev.tp2),
        notional: qty * entry,
        expiresAt: ms(ev.expiresAt),
        status: str(ev.status) ?? 'NEW',
        placedAt: t,
      })
      act(name, 'info', `${symbol} entry placed at ${f(entry, 4)}`)
      break
    }
    case 'entry.filled': {
      const id = str(ev.id)
      const entry = num(ev.entry) ?? 0
      const qty = num(ev.qty) ?? 0
      const stop = num(ev.stop) ?? entry
      v.pending = v.pending.filter((p) => (id ? p.id !== id : true) && p.symbol !== symbol)
      if (id) v.fills[id] = { stop0: stop, entry, qty, ts: t }
      v.positions = v.positions.filter((p) => p.symbol !== symbol)
      v.positions.push({ symbol, id, qty, entry, stop, stop0: stop, tp1: num(ev.tp1) ?? entry, tp2: num(ev.tp2), notional: qty * entry, mark: null, tp1Done: false, stopping: false, openedAt: t })
      act(name, 'info', `${symbol} entry filled at ${f(entry, 4)}`)
      break
    }
    case 'entry.cancelled':
    case 'entry.rejected': {
      const id = str(ev.id)
      v.pending = v.pending.filter((p) => (id ? p.id !== id : p.symbol !== symbol))
      act(name, 'warn', `${symbol} entry ${name === 'entry.cancelled' ? 'cancelled' : 'rejected'}: ${str(ev.reason) ?? str(ev.error) ?? 'unknown'}`)
      break
    }
    case 'tp.filled': {
      const p = v.positions.find((x) => x.symbol === symbol)
      if (p) {
        p.tp1Done = true
        p.stop = num(ev.newStop) ?? p.stop
        const q = num(ev.qty)
        if (q !== null) p.qty = Math.max(0, p.qty - q)
      }
      act(name, 'good', `${symbol} TP1 filled, stop moved to break-even`)
      break
    }
    case 'stop.hit': {
      const p = v.positions.find((x) => x.symbol === symbol)
      if (p) {
        p.stopping = true
        p.mark = num(ev.bid) ?? p.mark
      }
      act(name, 'bad', `${symbol} stop hit (${str(ev.reason) ?? 'stop'})`)
      break
    }
    case 'exit': {
      const id = str(ev.id)
      const entry = num(ev.entry)
      const qty = num(ev.qty)
      const pnlTmn = num(ev.pnlTmn)
      const fill = id ? v.fills[id] : undefined
      const pos = v.positions.find((x) => x.symbol === symbol)
      const stop0 = fill?.stop0 ?? pos?.stop0 ?? null
      let r = num(ev.r)
      if (r === null && pnlTmn !== null && entry !== null && qty !== null && stop0 !== null && entry > stop0 && qty > 0) r = pnlTmn / (qty * (entry - stop0))
      const exactFee = num(ev.fees) ?? num(ev.fee) ?? num(ev.feeTmn)
      const fee = exactFee ?? num(ev.feeTmnEst)
      push(
        v.trades,
        { ts: t, id, symbol, how: str(ev.how) ?? 'exit', qty, entry, pnlTmn, pnlFraction: num(ev.pnlFraction), r, fees: fee, feesEst: exactFee === null && fee !== null },
        CAPS.trades,
      )
      v.positions = v.positions.filter((x) => x.symbol !== symbol)
      const win = (pnlTmn ?? num(ev.pnlFraction) ?? 0) > 0
      act(name, win ? 'good' : 'bad', `${symbol} closed (${str(ev.how) ?? 'exit'}) ${pnlTmn === null ? '' : (win ? '+' : '') + f(pnlTmn) + ' TMN'}`.trim())
      break
    }
    default:
      break
  }
  return true
}

function pushEquity(v: View, t: number, eq: number) {
  const s = v.equity.series
  const last = s[s.length - 1]
  if (last && last[0] === t) last[1] = eq
  else if (!last || t > last[0]) s.push([t, eq])
  decimate(s)
  v.equity.last = eq
  v.equity.lastTs = t
  v.equity.peak = Math.max(v.equity.peak ?? eq, eq)
}

export interface StateFiles {
  run: Obj | null
  guard: Obj | null
  strategy: Obj | null
  files: { name: string; mtime: number }[]
}

function readJson(path: string): Obj | null {
  try {
    const j = JSON.parse(readFileSync(path, 'utf8'))
    return isObj(j) ? j : null
  } catch {
    return null
  }
}

export function readStateFiles(dir: string): StateFiles {
  const out: StateFiles = { run: null, guard: null, strategy: null, files: [] }
  let names: string[] = []
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.json'))
  } catch {
    return out
  }
  const withTime = names
    .map((name) => {
      try {
        return { name, mtime: statSync(join(dir, name)).mtimeMs }
      } catch {
        return null
      }
    })
    .filter((x): x is { name: string; mtime: number } => x !== null)
  out.files = withTime.sort((a, b) => b.mtime - a.mtime)
  const newestRun = out.files.find((x) => x.name.endsWith('-run.json'))
  if (newestRun) {
    const mode = newestRun.name.slice(0, -'-run.json'.length)
    out.run = readJson(join(dir, newestRun.name))
    if (out.run) out.run = { ...out.run, mode }
    out.guard = readJson(join(dir, `${mode}-guard.json`))
    out.strategy = readJson(join(dir, `${mode}-strategy.json`))
  }
  return out
}

function guardFromFile(g: Obj | null, L: Limits): GuardView | null {
  if (!g) return null
  const equity = num(g.equity)
  const startEquity = num(g.startEquity)
  const dayStart = num(g.dayStart)
  if (equity === null || startEquity === null || startEquity <= 0) return null
  const total = equity / startEquity - 1
  const hard = str(g.hardHalt)
  const halted = Boolean(hard) || (num(g.dailyHaltDay) !== null && g.dailyHaltDay === g.day)
  return {
    equity,
    startEquity,
    dayPeak: num(g.dayPeak) ?? equity,
    dayPnlPct: dayStart ? equity / dayStart - 1 : 0,
    totalPnlPct: total,
    consecutiveLosses: num(g.consecutiveLosses) ?? 0,
    halted,
    haltReason: hard ?? (halted ? 'daily loss halt' : null),
    riskPct: total >= L.lock2Pnl ? L.lock2Risk : total >= L.lock1Pnl ? L.lock1Risk : L.riskPct,
  }
}

export interface TailResult {
  lines: string[]
  reset: boolean
  file: string | null
}

export class LogTailer {
  file: string | null = null
  offset = 0
  private carry: Buffer = Buffer.alloc(0)
  constructor(
    private dir: string,
    private initialBytes = 2 * 1024 * 1024,
  ) {}

  private newest(): string | null {
    let names: string[]
    try {
      names = readdirSync(this.dir).filter((n) => n.endsWith('.jsonl'))
    } catch {
      return null
    }
    const pick = (list: string[]) => {
      let best: { n: string; m: number } | null = null
      for (const n of list) {
        try {
          const m = statSync(join(this.dir, n)).mtimeMs
          if (!best || m > best.m || (m === best.m && n > best.n)) best = { n, m }
        } catch {
          // vanished between readdir and stat
        }
      }
      return best?.n ?? null
    }
    return pick(names.filter((n) => n.startsWith('live-'))) ?? pick(names)
  }

  poll(): TailResult {
    const name = this.newest()
    const result: TailResult = { lines: [], reset: false, file: name }
    if (!name) {
      if (this.file) result.reset = true
      this.file = null
      this.offset = 0
      this.carry = Buffer.alloc(0)
      return result
    }
    const path = join(this.dir, name)
    let size: number
    try {
      size = statSync(path).size
    } catch {
      return result
    }
    let skipPartial = false
    if (name !== this.file) {
      result.reset = this.file !== null
      this.file = name
      this.carry = Buffer.alloc(0)
      this.offset = Math.max(0, size - this.initialBytes)
      skipPartial = this.offset > 0
    } else if (size < this.offset) {
      result.reset = true
      this.offset = 0
      this.carry = Buffer.alloc(0)
    }
    if (size === this.offset) return result
    const fd = openSync(path, 'r')
    try {
      const want = Math.min(size - this.offset, 16 * 1024 * 1024)
      const buf = Buffer.alloc(want)
      const got = readSync(fd, buf, 0, want, this.offset)
      this.offset += got
      let data = Buffer.concat([this.carry, buf.subarray(0, got)])
      if (skipPartial) {
        const nl = data.indexOf(10)
        data = nl < 0 ? Buffer.alloc(0) : data.subarray(nl + 1)
      }
      const lastNl = data.lastIndexOf(10)
      if (lastNl < 0) {
        this.carry = skipPartial ? Buffer.alloc(0) : Buffer.from(data)
        return result
      }
      this.carry = Buffer.from(data.subarray(lastNl + 1))
      result.lines = data.subarray(0, lastNl).toString('utf8').split('\n')
    } finally {
      closeSync(fd)
    }
    return result
  }
}

export interface LogQuery {
  event?: string
  q?: string
  limit?: number
}

export interface StoreOptions {
  logDir: string
  stateDir: string
  killFile: string | null
  killLabel?: string
  limits?: Limits
  virtual?: boolean
  clock?: () => number
  clockSpeed?: () => number
  mode?: 'live' | 'demo' | 'replay'
}

const eventMatches = (ev: string, filters: string[]) =>
  filters.length === 0 ||
  filters.some((f) => (f.endsWith('*') ? ev.startsWith(f.slice(0, -1)) : ev === f || ev.startsWith(f + '.')))

export class KillSwitchDisabled extends Error {
  constructor() {
    super('kill switch is disabled (risk.killFile is empty)')
  }
}

export class Store {
  view = createView()
  readonly limits: Limits
  readonly mode: 'live' | 'demo' | 'replay'
  private tailer: LogTailer | null
  private virtualKill = false
  private lastRefresh = 0
  private stateFiles: StateFiles = { run: null, guard: null, strategy: null, files: [] }
  private clock: () => number
  private speed: () => number
  seriesVersion = 0

  constructor(private o: StoreOptions) {
    this.limits = o.limits ?? limitsFromSettings()
    this.mode = o.mode ?? 'live'
    this.tailer = this.mode === 'live' ? new LogTailer(o.logDir) : null
    this.clock = o.clock ?? Date.now
    this.speed = o.clockSpeed ?? (() => 1)
  }

  now() {
    return this.clock()
  }

  get clockSpeed() {
    return this.speed()
  }

  ingest(ev: unknown, raw?: string): boolean {
    const before = this.view.equity.lastTs
    const ok = fold(this.view, ev, raw)
    if (ok && this.view.equity.lastTs !== before) this.seriesVersion++
    return ok
  }

  ingestLine(line: string): boolean {
    const ev = parseLine(line)
    return ev ? this.ingest(ev, line.trim()) : false
  }

  refresh(minAgeMs = 500) {
    const t = Date.now()
    if (t - this.lastRefresh < minAgeMs) return
    this.lastRefresh = t
    this.stateFiles = readStateFiles(this.o.stateDir)
    if (!this.tailer) return
    const r = this.tailer.poll()
    if (r.reset) {
      this.view = createView()
      this.seriesVersion++
    }
    for (const line of r.lines) this.ingestLine(line)
  }

  get currentLogFile() {
    return this.tailer?.file ?? null
  }

  get killLabel() {
    return this.o.killLabel ?? 'STOP'
  }

  get killSwitchConfigured() {
    return this.mode !== 'live' || this.o.killFile !== null
  }

  killSwitch(): boolean {
    if (this.mode !== 'live') return this.virtualKill
    return this.o.killFile !== null && existsSync(this.o.killFile)
  }

  setKillSwitch(enabled: boolean): { enabled: boolean; virtual: boolean } {
    if (this.mode !== 'live') {
      this.virtualKill = enabled
      return { enabled, virtual: true }
    }
    const file = this.o.killFile
    if (file === null) throw new KillSwitchDisabled()
    if (enabled) {
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, `engaged from dashboard at ${new Date().toISOString()}\n`)
    } else rmSync(file, { force: true })
    return { enabled: existsSync(file), virtual: false }
  }

  queryLog(q: LogQuery) {
    const filters = (q.event ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    const needle = (q.q ?? '').trim().toLowerCase()
    const limit = Math.min(1000, Math.max(1, Math.floor(q.limit ?? 200) || 200))
    const rows = this.view.logTail.filter((r) => eventMatches(r.event, filters) && (!needle || r.raw.toLowerCase().includes(needle)))
    const events = Object.entries(this.view.eventCounts)
      .map(([event, count]) => ({ event, count }))
      .sort((a, b) => b.count - a.count)
    return {
      total: rows.length,
      rows: rows.slice(-limit).map(({ seq, ts, event, summary, raw }) => ({ seq, ts, event, summary, raw })),
      events,
    }
  }

  snapshot(opts: { series?: boolean } = {}) {
    return buildSnapshot(this, opts.series !== false)
  }

  get files() {
    return this.stateFiles
  }
}

export type Phase = 'waiting' | 'trading' | 'cutoff' | 'flattening' | 'done'

export function computePhase(run: View['run'], now: number): Phase {
  if (run.stopped) return 'done'
  if (run.runEnd !== null && now >= run.runEnd) return 'done'
  const rank: Record<Phase, number> = { waiting: 0, trading: 1, cutoff: 2, flattening: 3, done: 4 }
  let p: Phase = run.runEnd === null && run.reportedPhase === null ? 'waiting' : 'trading'
  const bump = (c: Phase) => {
    if (rank[c] > rank[p]) p = c
  }
  if (run.entryCutoffAt !== null && now >= run.entryCutoffAt) bump('cutoff')
  if (run.flattenAt !== null && now >= run.flattenAt) bump('flattening')
  if (run.reportedPhase === 'entries_off') bump('cutoff')
  if (run.reportedPhase === 'flattening') bump('flattening')
  return p
}

function percentile(xs: number[], p: number): number | null {
  if (xs.length === 0) return null
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor(p * s.length))]!
}

function buildSnapshot(store: Store, withSeries: boolean) {
  const v = store.view
  const L = store.limits
  const now = store.now()
  const sf = store.files
  const runFile = sf.run
  const run = { ...v.run }
  run.startEquity ??= num(runFile?.startEquity)
  run.runEnd ??= ms(runFile?.runEnd)
  run.sha ??= str(runFile?.sha)
  run.mode ??= str(runFile?.mode)
  run.startedAt ??= ms(runFile?.startedAt)
  const phase = computePhase(run, now)

  const guard = v.guard ?? guardFromFile(sf.guard, L)
  const startEquity = run.startEquity ?? guard?.startEquity ?? null
  const equity = v.equity.last ?? guard?.equity ?? null
  const peak = Math.max(v.equity.peak ?? 0, startEquity ?? 0, equity ?? 0) || null
  const pnlTmn = equity !== null && startEquity !== null ? equity - startEquity : null
  const pnlPct = equity !== null && startEquity ? equity / startEquity - 1 : null
  const dayPeak = guard?.dayPeak ?? peak
  const dayLoss = equity !== null && dayPeak ? Math.max(0, 1 - equity / dayPeak) : null
  const ddStart = equity !== null && startEquity ? Math.max(0, 1 - equity / startEquity) : null
  const ddPeak = equity !== null && peak ? Math.max(0, 1 - equity / peak) : null
  const totalPnl = guard?.totalPnlPct ?? pnlPct ?? 0
  const tier = totalPnl >= L.lock2Pnl - 1e-9 ? 2 : totalPnl >= L.lock1Pnl - 1e-9 ? 1 : 0
  const riskPct = guard?.riskPct ?? (tier === 2 ? L.lock2Risk : tier === 1 ? L.lock1Risk : L.riskPct)

  const killSwitch = store.killSwitch()
  const hbAge = v.hb.ts !== null ? Math.max(0, (now - v.hb.ts) / 1000) : null
  const live = phase !== 'done' && phase !== 'waiting'
  const stale = live && hbAge !== null && hbAge > 120
  const degradedRecent = v.errors.recent.some((e) => e.kind === 'daemon.degraded' && now - e.ts < 300_000)
  let health: 'ok' | 'warn' | 'bad' | 'idle' | 'done' = 'ok'
  const healthWhy: string[] = []
  if (phase === 'done') health = 'done'
  else if (v.hb.ts === null && v.seq === 0) {
    health = 'idle'
    healthWhy.push('No daemon log found yet')
  } else {
    if (stale) {
      health = 'bad'
      healthWhy.push(`Heartbeat is ${Math.round(hbAge!)}s old`)
    }
    if (degradedRecent) {
      health = 'bad'
      healthWhy.push('API degraded while positions are open')
    }
    if (health !== 'bad') {
      if (guard?.halted) healthWhy.push('Risk guard halted entries')
      if (killSwitch) healthWhy.push('Kill switch engaged')
      if (v.hb.api.consecutive > 0) healthWhy.push(`${v.hb.api.consecutive} API calls failing in a row`)
      if (v.hb.strategyErrors > 0) healthWhy.push(`${v.hb.strategyErrors} strategy errors`)
      if (healthWhy.length) health = 'warn'
    }
    if (health === 'ok') healthWhy.push('Heartbeat fresh, API reachable')
  }

  const ages: Record<string, number | null> = {}
  const symbols = run.symbols.length ? run.symbols : Object.keys(v.hb.barAge)
  for (const s of symbols) {
    const a = v.hb.barAge[s]
    ages[s] = a === null || a === undefined || v.hb.ts === null ? null : Math.max(0, a + (now - v.hb.ts) / 1000)
  }

  const positions = v.positions.map((p) => ({
    ...p,
    unrealizedPct: p.mark !== null && p.entry > 0 ? p.mark / p.entry - 1 : null,
    distToStopPct: p.mark !== null && p.mark > 0 ? (p.mark - p.stop) / p.mark : null,
    riskToStopPct: p.entry > 0 ? (p.entry - p.stop) / p.entry : null,
  }))

  const tr = v.trades
  const wins = tr.filter((t) => (t.pnlTmn ?? t.pnlFraction ?? 0) > 0)
  const rs = tr.map((t) => t.r).filter((x): x is number => x !== null)
  const feesKnown = tr.some((t) => t.fees !== null)
  const totalPnlTmn = tr.reduce((a, t) => a + (t.pnlTmn ?? 0), 0)
  const lat = v.aiStats.latencies
  const errTotal = Object.values(v.errors.counts).reduce((a, b) => a + b, 0)
  const c = v.errors.counts

  return {
    now,
    clockSpeed: store.clockSpeed,
    source: store.mode,
    seq: v.seq,
    killSwitch,
    killSwitchVirtual: store.mode !== 'live',
    killSwitchConfigured: store.killSwitchConfigured,
    killFile: store.killLabel,
    limits: L,
    run: { ...run, phase, symbols },
    health: { level: health, reasons: healthWhy, heartbeatAgeSec: hbAge, stale },
    equity: {
      last: equity,
      start: startEquity,
      peak,
      pnlTmn,
      pnlPct,
      dayPnlPct: guard?.dayPnlPct ?? null,
      drawdownFromPeak: ddPeak,
      seriesVersion: store.seriesVersion,
      ...(withSeries ? { series: v.equity.series } : {}),
    },
    guard: guard && { ...guard, blockReason: v.blockReason, tier },
    gauges: {
      dayLoss: { value: dayLoss, limit: L.dailyLossHalt },
      drawdown: { value: ddStart, limit: L.hardDrawdown },
      risk: { value: Math.max(0, totalPnl), tier, riskPct, lock1: L.lock1Pnl, lock2: L.lock2Pnl },
    },
    positions,
    pending: v.pending,
    trades: {
      rows: tr.slice(-100).reverse(),
      count: tr.length,
      wins: wins.length,
      winRate: tr.length ? wins.length / tr.length : null,
      avgR: rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : null,
      totalPnlTmn: tr.length ? totalPnlTmn : null,
      bestTmn: tr.length ? Math.max(...tr.map((t) => t.pnlTmn ?? 0)) : null,
      worstTmn: tr.length ? Math.min(...tr.map((t) => t.pnlTmn ?? 0)) : null,
      fees: feesKnown ? tr.reduce((a, t) => a + (t.fees ?? 0), 0) : null,
      feesEst: tr.some((t) => t.feesEst),
    },
    setups: {
      accepted: v.setupCounts.accepted,
      rejected: v.setupCounts.rejected,
      reasons: Object.entries(v.reasons)
        .map(([reason, count]) => ({ reason, count }))
        .sort((a, b) => b.count - a.count),
      rows: v.setups.slice(-80).reverse(),
    },
    ai: {
      n: v.aiStats.n,
      fallback: v.aiStats.fallback,
      fallbackRate: v.aiStats.n ? v.aiStats.fallback / v.aiStats.n : null,
      avgLatencyMs: lat.length ? lat.reduce((a, b) => a + b, 0) / lat.length : null,
      p95LatencyMs: percentile(lat, 0.95),
      latencies: lat.slice(-40),
      actions: v.aiStats.actions,
      rows: v.ai.slice(-60).reverse(),
    },
    orders: v.orders.slice(-60).reverse(),
    system: {
      symbols: symbols.map((s) => ({ symbol: s, ageSec: ages[s] ?? null })),
      api: v.hb.api,
      strategyErrors: v.hb.strategyErrors,
      holdings: v.hb.holdings,
      heartbeats: v.hb.count,
      flatten: v.run.flatten,
      errors: {
        total: errTotal,
        pollErrors: c['poll.error'] ?? 0,
        apiErrors: c['daemon.api_error'] ?? 0,
        exitRejected: c['exit.rejected'] ?? 0,
        degraded: c['daemon.degraded'] ?? 0,
        counts: c,
        recent: v.errors.recent.slice(-15).reverse(),
      },
      files: sf.files.map((f) => ({ name: f.name, ageSec: Math.max(0, (Date.now() - f.mtime) / 1000) })),
      logFile: store.currentLogFile,
    },
    activity: v.activity.slice(-14).reverse(),
    logEvents: Object.keys(v.eventCounts).length,
  }
}

export type Snapshot = ReturnType<typeof buildSnapshot>
