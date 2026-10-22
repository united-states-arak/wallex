import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { cfg } from './config'
import { DryExchange } from './exchange/dry'
import { LiveExchange } from './exchange/live'
import { PaperExchange } from './exchange/paper'
import { loadBlocked } from './exchange/validate'
import { gitSha, nullLog, type Log } from './log'
import { planPullout, pullout, routeFor } from './pullout'
import { runPoll } from './runner/poll'
import { createGuard, defaultLimits, writeJsonAtomic, type Guard, type GuardLimits } from './risk/guard'
import { getSettings, loadSettings, settingsHash } from './settings'
import type { BarCtx, Exchange, Markets, OrderAck, OrderReq, Strategy, TickCtx } from './types'
import type { WallexRest } from './wallex/rest'

export interface StatefulStrategy extends Strategy {
  getState?(): unknown
  restoreState?(s: unknown): void
  openPositions?(): unknown[]
}

export type DaemonRest = Pick<WallexRest, 'history' | 'depth' | 'markets'> & { hasKey?: boolean }

export interface DaemonOpts {
  rest: DaemonRest
  mode: 'live' | 'paper' | 'dry'
  symbols: string[]
  makeStrategy: (ctx: { guard: Guard; meta: Markets; log: Log }) => StatefulStrategy
  log?: Log
  // Test hooks: use a ready-made exchange / market list instead of building them from `rest`.
  ex?: Exchange
  meta?: Markets
  blocked?: Set<string>
  // Unix ms. Defaults to run.end (RUN_END), then now + run.defaultHours.
  runEnd?: number
  entryCutoffMin?: number
  flattenMin?: number
  startEquity?: number
  stateDir?: string
  limits?: Partial<GuardLimits>
  tickMs?: number
  pollMs?: number
  verifyMs?: number
  pulloutWaitMs?: number
  degradedAfterMs?: number
  // Reuse state files of an earlier process with the same RUN_END (default true).
  resume?: boolean
  signals?: boolean
  signal?: AbortSignal
}

export interface DaemonResult {
  reason: 'run_end' | 'signal'
  startEquity: number
  endEquity: number | null
  flat: boolean
  positionsLeft: string[]
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const nowSec = () => Math.floor(Date.now() / 1000)

export function resolveSchedule(
  over: { runEnd?: number; entryCutoffMin?: number; flattenMin?: number } = {},
  env: Record<string, string | undefined> = process.env,
  nowMs = Date.now(),
) {
  // run.* comes from the settings (config files, RUN_END / ENTRY_CUTOFF_MIN / FLATTEN_MIN, STARCOACH__run__*).
  const run = (env === process.env ? getSettings() : loadSettings({ env })).run
  let runEnd = over.runEnd
  let defaulted = false
  if (runEnd === undefined) {
    if (run.end) {
      runEnd = Date.parse(run.end)
      if (!Number.isFinite(runEnd)) throw new Error(`run.end (RUN_END) is not a valid ISO time: ${run.end}`)
    } else {
      runEnd = nowMs + run.defaultHours * 3_600_000
      defaulted = true
    }
  }
  return {
    runEnd,
    defaulted,
    entryCutoffMin: over.entryCutoffMin ?? run.entryCutoffMin,
    flattenMin: over.flattenMin ?? run.flattenMin,
  }
}

export function mutex() {
  let tail: Promise<unknown> = Promise.resolve()
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const run = tail.then(fn)
    tail = run.catch(() => {})
    return run
  }
}

// Total account value in TMN. Throws when any holding cannot be priced, so callers never feed a wrong equity to the guard.
export async function computeEquity(ex: Exchange, meta: Markets) {
  const bals = await ex.balances()
  const bid = async (symbol: string) => (await ex.quote(symbol)).bid
  let equity = 0
  const holdings: string[] = []
  for (const [asset, b] of Object.entries(bals)) {
    const qty = b.free + b.locked
    if (!(qty > 0)) continue
    if (asset === 'TMN') {
      equity += qty
      continue
    }
    holdings.push(asset)
    const route = routeFor(asset, meta)
    if (!route) continue
    equity += route.endsWith('TMN') ? qty * (await bid(route)) : qty * (await bid(route)) * (await bid('USDTTMN'))
  }
  return { equity, holdings }
}

// Strategies place orders through the Exchange they are given, so entries are counted (and, after the cutoff, refused) here.
export function guardedExchange(ex: Exchange, o: { guard: Pick<Guard, 'recordEntry'>; now: () => number; entriesOn?: () => boolean; onRefuse?: (r: OrderReq) => void }): Exchange {
  return {
    get mode() {
      return ex.mode
    },
    balances: () => ex.balances(),
    quote: (s) => ex.quote(s),
    openOrders: (s) => ex.openOrders(s),
    cancel: (id) => ex.cancel(id),
    async place(req: OrderReq): Promise<OrderAck> {
      const entry = req.side === 'BUY'
      if (entry && o.entriesOn && !o.entriesOn()) {
        o.onRefuse?.(req)
        return { clientId: req.clientId, status: 'REJECTED', error: 'entries disabled' }
      }
      const ack = await ex.place(req)
      if (entry && ack.status !== 'REJECTED') o.guard.recordEntry(o.now())
      return ack
    },
  }
}

// For backtest, shadow and dry: keeps the guard informed of equity and entries without a daemon.
export function withGuardFeed(strategy: StatefulStrategy, guard: Guard, meta: Markets): StatefulStrategy {
  let now = 0
  const feed = async (ex: Exchange) => {
    try {
      const equity = ex instanceof PaperExchange ? ex.equity() : (await computeEquity(ex, meta)).equity
      guard.updateEquity(equity, now)
    } catch {
      // equity unknown this bar, the guard keeps its last value
    }
  }
  const counted = (ex: Exchange) => guardedExchange(ex, { guard, now: () => now })
  const wrapped: StatefulStrategy = {
    name: strategy.name,
    async onBar(ctx: BarCtx) {
      now = (ctx.bars[ctx.bars.length - 1]?.t ?? 0) + 60
      await feed(ctx.ex)
      return strategy.onBar({ ...ctx, ex: counted(ctx.ex) })
    },
    getState: () => strategy.getState?.(),
    restoreState: (s) => strategy.restoreState?.(s),
    openPositions: () => strategy.openPositions?.() ?? [],
  }
  if (strategy.onTick) {
    wrapped.onTick = (ctx: TickCtx) => {
      now = ctx.now
      return strategy.onTick!({ ...ctx, ex: counted(ctx.ex) })
    }
  }
  if (strategy.setEntriesEnabled) wrapped.setEntriesEnabled = (e) => strategy.setEntriesEnabled!(e)
  return wrapped
}

// What a saved strategy state still holds: open positions or pending entry orders (empty when flat).
export function stateExposure(state: unknown): string[] {
  if (!state || typeof state !== 'object') return []
  const out: string[] = []
  for (const key of ['positions', 'pending']) {
    const v = (state as Record<string, unknown>)[key]
    const names = Array.isArray(v) ? v.map((_, i) => String(i)) : v && typeof v === 'object' ? Object.keys(v) : []
    if (names.length) out.push(`${key}: ${names.join(',')}`)
  }
  return out
}

function readJson(path: string): any {
  try {
    return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null
  } catch {
    return null
  }
}

async function placeOrders(orders: OrderReq[], ex: Exchange, log: Log, via: string) {
  const t0 = performance.now()
  for (const o of orders) {
    log('order.intent', { ...o, via })
    try {
      const ack = await ex.place(o)
      log('order.ack', { ...ack, mode: ex.mode, decisionMs: Math.round(performance.now() - t0) })
    } catch (e) {
      log('order.error', { clientId: o.clientId, symbol: o.symbol, error: String(e) })
    }
  }
}

export async function runDaemon(opts: DaemonOpts): Promise<DaemonResult> {
  const log = opts.log ?? nullLog
  const { mode, symbols } = opts
  const S = getSettings()
  const tickMs = opts.tickMs ?? S.wallex.tickMs
  const basePollMs = opts.pollMs ?? S.wallex.pollMs
  const verifyMs = opts.verifyMs ?? 60_000
  const degradedAfterMs = opts.degradedAfterMs ?? 5 * 60_000
  const stateDir = opts.stateDir ?? S.logging.stateDir
  const sched = resolveSchedule({ runEnd: opts.runEnd, entryCutoffMin: opts.entryCutoffMin, flattenMin: opts.flattenMin })
  const { runEnd } = sched
  const cutoffAt = runEnd - sched.entryCutoffMin * 60_000
  const flattenAt = runEnd - sched.flattenMin * 60_000
  if (runEnd <= Date.now()) throw new Error(`RUN_END ${new Date(runEnd).toISOString()} is already in the past`)
  if (mode === 'live' && sched.defaulted) log('daemon.warn', { warn: 'RUN_END not set, defaulting to now + 24h' })

  const meta = opts.meta ?? (await opts.rest.markets())
  const blocked = opts.blocked ?? loadBlocked()
  let ex = opts.ex
  if (!ex) {
    if (mode === 'live') {
      if (!opts.rest.hasKey) throw new Error('live start aborted: WALLEX_API_KEY is not set')
      ex = new LiveExchange(opts.rest as WallexRest, meta, blocked, log)
    } else if (mode === 'dry') ex = new DryExchange(opts.rest as WallexRest, meta, blocked, log)
    else ex = new PaperExchange(meta, blocked)
  }
  const exchange: Exchange = ex
  const paperEx = exchange instanceof PaperExchange ? exchange : undefined

  let startBals
  try {
    startBals = await exchange.balances()
  } catch (e) {
    throw new Error(`start aborted: cannot read balances: ${String(e)}`)
  }
  const tmn = startBals.TMN
  if (mode === 'live' && !tmn) throw new Error('live start aborted: balances have no TMN entry. Check the API key permissions and run `bun run check`.')
  if (mode === 'live' && !(tmn!.free + tmn!.locked > 0)) throw new Error('live start aborted: TMN balance is zero')

  mkdirSync(stateDir, { recursive: true })
  const runPath = `${stateDir}/${mode}-run.json`
  const guardPath = `${stateDir}/${mode}-guard.json`
  const strategyPath = `${stateDir}/${mode}-strategy.json`
  const runEndIso = new Date(runEnd).toISOString()
  const prev = readJson(runPath)
  const resumed = opts.resume !== false && prev?.runEnd === runEndIso && Number.isFinite(prev?.startEquity)
  // A different RUN_END normally starts clean. Open positions or pending entries in the saved state are never dropped:
  // forgetting them would leave bought coins without stops.
  const savedStrategy = readJson(strategyPath)
  const exposure = resumed ? [] : stateExposure(savedStrategy?.state)
  const stateKept = exposure.length > 0
  if (!resumed) {
    rmSync(guardPath, { force: true })
    if (stateKept) {
      log('daemon.state_kept', { path: strategyPath, exposure, prevRunEnd: prev?.runEnd ?? null, runEnd: runEndIso })
      console.error(
        `!!! WARNING: ${strategyPath} holds ${exposure.join('; ')} from an earlier run (RUN_END ${prev?.runEnd ?? 'unknown'}, now ${runEndIso}). ` +
          'The state is KEPT so those positions keep their stops. If they were already sold (for example with pullout --yes), delete that file to start clean.',
      )
    } else rmSync(strategyPath, { force: true })
  }
  const startEquity: number = resumed
    ? prev.startEquity
    : (opts.startEquity ?? (mode === 'live' ? tmn!.free + tmn!.locked : cfg.startTmn))
  writeJsonAtomic(runPath, { runEnd: runEndIso, startEquity, startedAt: resumed ? prev.startedAt : new Date().toISOString(), sha: gitSha })

  const killFile = (opts.limits?.killFile ?? defaultLimits().killFile) || null
  const guard = createGuard({ startEquity, statePath: guardPath, limits: opts.limits })
  const strategy = opts.makeStrategy({ guard, meta, log })
  if (resumed || stateKept) {
    const saved = savedStrategy
    if (saved && 'state' in saved) {
      try {
        strategy.restoreState?.(saved.state)
      } catch (e) {
        log('daemon.restore_failed', { error: String(e) })
      }
    }
  }

  let stopping: string | null = null
  let entriesOn = true
  let flattening = false
  let warm = false
  let flatDone = false
  let lastFlatten = 0
  let lastHoldings: string[] = []
  let strategyErrors = 0
  let lastDegradedLog = 0
  let killOn = false
  const lastCandleT: Record<string, number> = {}
  const lastBid: Record<string, number> = {}
  const lastClose: Record<string, number> = {}
  const api = { total: 0, consecutive: 0, failingSince: null as number | null, byKind: {} as Record<string, number> }
  const symFail: Record<string, { n: number; nextAt: number }> = {}
  const exclusive = mutex()
  const done = () => stopping !== null || Date.now() >= runEnd

  const apiOk = () => {
    api.consecutive = 0
    api.failingSince = null
  }
  const apiFail = (kind: string, e: unknown, extra: Record<string, unknown> = {}) => {
    api.total++
    api.consecutive++
    api.byKind[kind] = (api.byKind[kind] ?? 0) + 1
    api.failingSince ??= Date.now()
    log('daemon.api_error', { kind, error: String(e), consecutive: api.consecutive, ...extra })
  }

  const openPositions = () => strategy.openPositions?.() ?? []
  const phase = () => (flattening ? 'flattening' : entriesOn ? 'trading' : 'entries_off')

  const applyPhase = (t: number) => {
    if (entriesOn && (t >= cutoffAt || stopping)) {
      entriesOn = false
      try {
        strategy.setEntriesEnabled?.(false)
      } catch (e) {
        log('daemon.strategy_error', { where: 'setEntriesEnabled', error: String(e) })
      }
      log('daemon.entries_disabled', { reason: stopping ? 'shutdown' : 'entry cutoff', cutoffAt: new Date(cutoffAt).toISOString() })
    }
    if (!flattening && t >= flattenAt && !stopping) {
      flattening = true
      log('daemon.flatten_phase', { flattenAt: new Date(flattenAt).toISOString() })
    }
  }

  const guardedEx = guardedExchange(exchange, {
    guard,
    now: nowSec,
    entriesOn: () => entriesOn && !flattening && Date.now() < cutoffAt,
    onRefuse: (r) => log('daemon.entry_dropped', { clientId: r.clientId, symbol: r.symbol, phase: phase() }),
  })

  const wrapped: StatefulStrategy = {
    name: strategy.name,
    async onBar(ctx: BarCtx) {
      if (flattening) return []
      try {
        return await strategy.onBar(ctx)
      } catch (e) {
        strategyErrors++
        log('daemon.strategy_error', { where: 'onBar', symbol: ctx.symbol, error: String(e) })
        return []
      }
    },
  }
  if (strategy.onTick) {
    wrapped.onTick = async (ctx: TickCtx) => {
      if (flattening) return []
      try {
        return await strategy.onTick!(ctx)
      } catch (e) {
        strategyErrors++
        log('daemon.strategy_error', { where: 'onTick', symbol: ctx.symbol, error: String(e) })
        return []
      }
    }
  }

  const persist = () => {
    try {
      writeJsonAtomic(strategyPath, { savedAt: new Date().toISOString(), state: strategy.getState?.() ?? null })
      guard.save()
    } catch (e) {
      log('daemon.persist_error', { error: String(e) })
    }
  }

  const cycle = async () => {
    warm = true
    const t = Date.now()
    applyPhase(t)
    let equity: number | null = null
    try {
      const r = await computeEquity(exchange, meta)
      equity = r.equity
      lastHoldings = r.holdings
      if (equity > 0) guard.updateEquity(equity, nowSec())
      apiOk()
    } catch (e) {
      apiFail('equity', e)
    }
    persist()
    if (killFile) {
      const on = existsSync(killFile)
      if (on !== killOn) {
        killOn = on
        log(on ? 'daemon.kill_switch' : 'daemon.kill_switch_released', { killFile })
      }
    }
    const ages: Record<string, number | null> = {}
    for (const s of symbols) ages[s] = lastCandleT[s] ? nowSec() - (lastCandleT[s]! + 60) : null
    const marks: Record<string, number> = {}
    for (const s of symbols) {
      const m = lastBid[s] ?? lastClose[s]
      if (m !== undefined) marks[s] = m
    }
    log('daemon.heartbeat', {
      mode,
      phase: phase(),
      equity: equity === null ? null : Math.round(equity),
      guard: guard.state(),
      blockReason: guard.blockReason(nowSec()),
      positions: openPositions().map((p) => {
        const sym = (p as { symbol?: unknown }).symbol
        const mark = typeof sym === 'string' ? marks[sym] : undefined
        return mark === undefined ? p : { ...(p as object), mark }
      }),
      marks,
      holdings: lastHoldings,
      barAgeSec: ages,
      api: { total: api.total, consecutive: api.consecutive, byKind: api.byKind },
      strategyErrors,
      msToEnd: runEnd - t,
    })
  }

  const checkDegraded = (t: number) => {
    if (api.failingSince === null || t - api.failingSince < degradedAfterMs || t - lastDegradedLog < 60_000) return
    if (openPositions().length === 0 && lastHoldings.length === 0) return
    lastDegradedLog = t
    const data = { failingForSec: Math.round((t - api.failingSince) / 1000), positions: openPositions(), holdings: lastHoldings }
    log('daemon.degraded', data)
    console.error(`!!! DEGRADED: API failing for ${data.failingForSec}s while positions are open. Stops are NOT being executed. Check the network or sell manually.`)
  }

  const tickAll = async (t: number) => {
    for (const symbol of symbols) {
      if (done()) return
      const f = (symFail[symbol] ??= { n: 0, nextAt: 0 })
      if (t < f.nextAt) continue
      try {
        let quote
        if (paperEx) {
          quote = await opts.rest.depth(symbol)
          paperEx.setQuote(symbol, quote.bid, quote.ask)
        } else quote = await exchange.quote(symbol)
        if (Number.isFinite(quote.bid) && quote.bid > 0) lastBid[symbol] = quote.bid
        await exclusive(async () => {
          const orders = (await wrapped.onTick?.({ symbol, quote, now: nowSec(), ex: guardedEx })) ?? []
          await placeOrders(orders, guardedEx, log, 'tick')
        })
        apiOk()
        f.n = 0
        f.nextAt = 0
      } catch (e) {
        f.n++
        const wait = Math.min(60_000, tickMs * 2 ** Math.min(f.n, 10))
        f.nextAt = Date.now() + wait
        apiFail('quote', e, { symbol, backoffMs: wait })
      }
    }
  }

  const flattenStep = async (t: number) => {
    if (t - lastFlatten < verifyMs || (flatDone && mode === 'dry')) return
    lastFlatten = t
    await exclusive(async () => {
      try {
        const report = await pullout(exchange, meta, { execute: true, waitMs: opts.pulloutWaitMs, log })
        flatDone = report.remaining.length === 0
        log('daemon.flatten', { flat: flatDone, tmn: Math.round(report.tmn), remaining: report.remaining, dust: report.dust, unroutable: report.unroutable })
        if (!flatDone) console.error(`WARNING: flatten incomplete, still holding ${report.remaining.map((h) => h.asset).join(', ')}. Retrying.`)
        apiOk()
      } catch (e) {
        apiFail('flatten', e)
      }
    })
  }

  const sleepUntilDone = async (ms: number) => {
    const until = Date.now() + ms
    while (!done() && Date.now() < until) await sleep(Math.min(250, until - Date.now()))
  }

  const tickLoop = async () => {
    while (!done()) {
      const t = Date.now()
      try {
        applyPhase(t)
        if (flattening) await flattenStep(t)
        else if (warm && wrapped.onTick) await tickAll(t)
        checkDegraded(t)
      } catch (e) {
        log('daemon.loop_error', { error: String(e) })
      }
      await sleepUntilDone(tickMs)
    }
  }

  const rest: Pick<WallexRest, 'history'> = {
    async history(symbol, from, to) {
      try {
        const bars = await opts.rest.history(symbol, from, to)
        for (const c of bars)
          if (c.t > (lastCandleT[symbol] ?? 0)) {
            lastCandleT[symbol] = c.t
            if (Number.isFinite(c.c) && c.c > 0) lastClose[symbol] = c.c
          }
        apiOk()
        return bars
      } catch (e) {
        apiFail('history', e, { symbol })
        throw e
      }
    },
  }

  const pollLoop = async () => {
    while (!done()) {
      try {
        await runPoll({
          rest,
          symbols,
          strategy: wrapped,
          ex: guardedEx,
          log,
          paper: paperEx,
          durationMs: Math.max(0, runEnd - Date.now()) + 1_000,
          pollMs: () => (api.consecutive > 0 ? Math.min(60_000, basePollMs * 2 ** Math.min(api.consecutive, 6)) : basePollMs),
          onCycle: async () => {
            try {
              await cycle()
            } catch (e) {
              log('daemon.loop_error', { where: 'cycle', error: String(e) })
            }
          },
          exclusive,
          shouldStop: done,
        })
      } catch (e) {
        log('daemon.poll_crashed', { error: String(e) })
        await sleepUntilDone(Math.min(60_000, basePollMs * 2 ** Math.min(api.consecutive, 6)))
      }
    }
  }

  const onSignal = (name: string) => {
    if (stopping) {
      console.error(`second ${name}, exiting immediately`)
      process.exit(1)
    }
    stopping = name
    console.error(`${name} received: stopping entries, cancelling pending entry orders, saving state`)
  }
  const sigint = () => onSignal('SIGINT')
  const sigterm = () => onSignal('SIGTERM')
  if (opts.signals !== false) {
    process.on('SIGINT', sigint)
    process.on('SIGTERM', sigterm)
  }
  opts.signal?.addEventListener('abort', () => {
    stopping ??= 'abort'
  })

  log('daemon.start', {
    sha: gitSha,
    mode,
    symbols,
    runEnd: runEndIso,
    entryCutoffAt: new Date(cutoffAt).toISOString(),
    flattenAt: new Date(flattenAt).toISOString(),
    startEquity,
    resumed,
    stateKept,
    configHash: settingsHash(S),
    killFile,
    strategy: strategy.name,
    startHoldings: Object.entries(startBals)
      .filter(([a, b]) => a !== 'TMN' && b.free + b.locked > 0)
      .map(([a]) => a),
  })
  applyPhase(Date.now())

  try {
    await Promise.all([pollLoop(), tickLoop()])
  } finally {
    process.off('SIGINT', sigint)
    process.off('SIGTERM', sigterm)
  }

  const reason = stopping ? 'signal' : 'run_end'
  if (stopping) {
    applyPhase(Date.now())
    try {
      for (const o of await exchange.openOrders()) {
        if (o.side !== 'BUY') continue
        await exchange.cancel(o.clientId)
        log('daemon.cancel_entry', { clientId: o.clientId, symbol: o.symbol })
      }
    } catch (e) {
      log('daemon.shutdown_error', { error: String(e) })
    }
  }
  persist()

  let endEquity: number | null = null
  let positionsLeft: string[] = []
  try {
    const r = await computeEquity(exchange, meta)
    endEquity = r.equity
    positionsLeft = (await planPullout(exchange, meta)).sells.map((h) => h.asset)
  } catch (e) {
    log('daemon.shutdown_error', { error: String(e) })
    positionsLeft = lastHoldings
  }
  const flat = positionsLeft.length === 0
  if (!flat) {
    const msg = stopping
      ? `positions remain open: ${positionsLeft.join(', ')}. Stops are monitored by this process only, so they are now UNPROTECTED. Restart the daemon or run pullout --yes.`
      : `RUN_END reached but still holding: ${positionsLeft.join(', ')}. Run pullout --yes now.`
    log('daemon.unflat_exit', { reason, positionsLeft })
    console.error(`!!! WARNING: ${msg}`)
  }
  log('daemon.stop', { reason, startEquity, endEquity, flat, positionsLeft })
  return { reason, startEquity, endEquity, flat, positionsLeft }
}
