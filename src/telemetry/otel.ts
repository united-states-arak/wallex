import type { Attributes, Histogram, ObservableResult } from '@opentelemetry/api'
import { PrometheusExporter } from '@opentelemetry/exporter-prometheus'
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http'
import { resourceFromAttributes } from '@opentelemetry/resources'
import { MeterProvider, PeriodicExportingMetricReader, type MetricReader } from '@opentelemetry/sdk-metrics'
import type { Log } from '../log'
import { loadSettings, type Settings } from '../settings'

// Percentages are fractions (0.01 = 1%), like the guard. Times are seconds unless the name says ms.
export interface TelemetryOpts {
  mode: string
  sha: string
  symbols: string[]
  runEndSec?: number
  startEquity: number
  disabled?: boolean
  port?: number
  host?: string
  otlpIntervalMs?: number
}

export type TelemetryLog = Log & {
  close(): Promise<void>
  // Scrape URL once the server is listening, null when disabled or the server could not start.
  url: string | null
  ready: Promise<void>
}

const num = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null)
const obj = (x: unknown): Record<string, unknown> => (typeof x === 'object' && x !== null && !Array.isArray(x) ? (x as Record<string, unknown>) : {})

// "guard: daily loss halt: equity 9 is 12% below" -> "guard_daily_loss_halt". Digits and free text are dropped to keep cardinality low.
export function slugReason(raw: unknown): string {
  const parts = String(raw ?? '').toLowerCase().split(':').map((p) => p.trim())
  const head = (parts[0] === 'guard' || parts[0] === 'sizing') && parts[1] ? `${parts[0]}_${parts[1]}` : (parts[0] ?? '')
  const slug = head.replace(/[^a-z]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40)
  return slug || 'unknown'
}

class Bounded {
  private seen = new Set<string>()
  constructor(private max: number) {}
  norm(v: string) {
    if (this.seen.has(v)) return v
    if (this.seen.size >= this.max) return 'other'
    this.seen.add(v)
    return v
  }
}

const TRACKED_EVENTS = new Set([
  'entry.placed', 'entry.filled', 'entry.cancelled', 'tp.placed', 'tp.filled', 'stop.hit', 'exit.no_quote',
  'daemon.flatten', 'daemon.entries_disabled', 'daemon.flatten_phase', 'daemon.strategy_error', 'daemon.loop_error',
  'daemon.poll_crashed', 'daemon.persist_error', 'daemon.unflat_exit', 'daemon.stop', 'supervisor.error',
  'pullout.plan', 'pullout.sell', 'pullout.cancel', 'pullout.done',
])

interface Beat {
  at: number
  equity: number | null
  guardEquity: number | null
  dayPeak: number | null
  dayPnl: number | null
  totalPnl: number | null
  risk: number | null
  losses: number | null
  halted: boolean
  haltReason: string
  positions: number
  notional: number
  barAge: Record<string, number | null>
}

// OTLP/HTTP metrics URL for a configured endpoint: a base URL gets the standard path appended, a full one is kept.
const metricsUrl = (endpoint: string) => (/\/v1\/metrics\/?$/.test(endpoint) ? endpoint : `${endpoint.replace(/\/+$/, '')}/v1/metrics`)

// Telemetry settings come from the `telemetry` section; OTEL_SDK_DISABLED, OTEL_PROMETHEUS_* and OTEL_EXPORTER_OTLP_* are aliases for it.
// Read fresh so a changed environment is honoured when telemetry is attached.
export function attachTelemetry(log: Log, opts: TelemetryOpts): TelemetryLog {
  const passthrough = (): TelemetryLog =>
    Object.assign(((event: string, data?: Record<string, unknown>) => log(event, data)) as Log, {
      path: log.path,
      url: null,
      ready: Promise.resolve(),
      close: async () => {},
    })
  try {
    const conf = loadSettings().telemetry
    if (opts.disabled || !conf.enabled) return passthrough()
    return build(log, opts, conf)
  } catch (e) {
    console.error(`telemetry disabled: ${String(e)}`)
    return passthrough()
  }
}

function build(log: Log, opts: TelemetryOpts, conf: Settings['telemetry']): TelemetryLog {
  const startedAt = Date.now()
  const host = opts.host ?? conf.prometheusHost
  const port = opts.port ?? conf.prometheusPort

  const prom = new PrometheusExporter({ host, port, preventServerStart: true, withoutScopeInfo: true })
  const readers: MetricReader[] = [prom]
  if (conf.otlpEndpoint) {
    // headers (OTEL_EXPORTER_OTLP_HEADERS) are read from the environment by the exporter itself
    readers.push(new PeriodicExportingMetricReader({ exporter: new OTLPMetricExporter({ url: metricsUrl(conf.otlpEndpoint) }), exportIntervalMillis: opts.otlpIntervalMs ?? conf.otlpIntervalMs }))
  }
  const provider = new MeterProvider({
    resource: resourceFromAttributes({ 'service.name': 'starcoach-trader', 'service.version': opts.sha, 'git.sha': opts.sha, mode: opts.mode }),
    readers,
  })
  const meter = provider.getMeter('starcoach')

  let startEquity = opts.startEquity
  let runEndMs: number | null = opts.runEndSec ? opts.runEndSec * 1000 : null
  let beat: Beat | null = null

  const reasons = new Bounded(20)
  const kinds = new Bounded(20)
  const models = new Bounded(8)
  const verdictActions = new Bounded(8)
  const verdictSources = new Bounded(4)

  // Gauges are read at scrape time so ages keep growing between heartbeats.
  const gauge = (name: string, help: string, read: () => number | null) =>
    meter.createObservableGauge(name, { description: help }).addCallback((r: ObservableResult) => {
      try {
        const v = read()
        if (v !== null && Number.isFinite(v)) r.observe(v)
      } catch {}
    })
  const labelled = (name: string, help: string, read: () => [number, Attributes][]) =>
    meter.createObservableGauge(name, { description: help }).addCallback((r: ObservableResult) => {
      try {
        for (const [v, a] of read()) if (Number.isFinite(v)) r.observe(v, a)
      } catch {}
    })

  labelled('starcoach_up', 'Process is running', () => [[1, { mode: opts.mode, sha: opts.sha }]])
  gauge('starcoach_start_equity_tmn', 'Equity at run start', () => startEquity)
  gauge('starcoach_equity_tmn', 'Account value in TMN', () => beat?.equity ?? beat?.guardEquity ?? null)
  gauge('starcoach_pnl_pct', 'Total PnL vs start equity, fraction', () => beat?.totalPnl ?? null)
  gauge('starcoach_day_pnl_pct', 'Day PnL, fraction', () => beat?.dayPnl ?? null)
  gauge('starcoach_drawdown_pct', 'Drawdown from day peak, fraction', () =>
    beat && beat.guardEquity !== null && beat.dayPeak ? Math.max(0, 1 - beat.guardEquity / beat.dayPeak) : null,
  )
  gauge('starcoach_risk_pct', 'Current risk per trade, fraction of equity', () => beat?.risk ?? null)
  labelled('starcoach_guard_halted', 'Risk guard halted (1) or not (0)', () =>
    beat ? [[beat.halted ? 1 : 0, { reason: beat.halted ? beat.haltReason : 'none' }]] : [],
  )
  gauge('starcoach_open_positions', 'Open positions', () => beat?.positions ?? null)
  gauge('starcoach_exposure_pct', 'Open notional / equity', () => {
    const eq = beat?.equity ?? beat?.guardEquity
    return beat && eq ? beat.notional / eq : null
  })
  gauge('starcoach_run_seconds_remaining', 'Seconds until RUN_END', () => (runEndMs === null ? null : Math.max(0, (runEndMs - Date.now()) / 1000)))
  gauge('starcoach_heartbeat_age_seconds', 'Seconds since the last daemon heartbeat (since start before the first one)', () => (Date.now() - (beat?.at ?? startedAt)) / 1000)
  labelled('starcoach_last_bar_age_seconds', 'Age of the newest closed 1m bar per symbol', () => {
    const now = Date.now()
    return opts.symbols.map((s): [number, Attributes] => {
      const age = beat?.barAge[s]
      return [age === undefined || age === null ? (now - startedAt) / 1000 : age + (now - beat!.at) / 1000, { symbol: s }]
    })
  })
  gauge('starcoach_consecutive_losses', 'Consecutive losing trades', () => beat?.losses ?? null)

  const orders = meter.createCounter('starcoach_orders_total', { description: 'Order acks by symbol, side and status' })
  const closed = meter.createCounter('starcoach_trades_closed_total', { description: 'Closed trades' })
  const setups = meter.createCounter('starcoach_setups_total', { description: 'ICT setups accepted or rejected' })
  const verdicts = meter.createCounter('starcoach_ai_verdicts_total', { description: 'Supervisor verdicts' })
  const apiErrors = meter.createCounter('starcoach_api_errors_total', { description: 'Exchange API errors' })
  const pollErrors = meter.createCounter('starcoach_poll_errors_total', { description: 'Poll errors per symbol' })
  const execRejected = meter.createCounter('starcoach_exec_rejected_total', { description: 'Exit, TP or entry orders rejected' })
  const degraded = meter.createCounter('starcoach_daemon_degraded_total', { description: 'Degraded-with-open-position warnings' })
  const events = meter.createCounter('starcoach_events_total', { description: 'Selected lifecycle events' })
  const pnlHist = meter.createHistogram('starcoach_trade_pnl_pct', {
    description: 'Closed trade PnL as fraction of equity at entry',
    advice: { explicitBucketBoundaries: [-0.02, -0.015, -0.01, -0.005, 0, 0.005, 0.01, 0.02, 0.04] },
  })
  const aiLatency = meter.createHistogram('starcoach_ai_latency_ms', {
    description: 'Supervisor review latency',
    advice: { explicitBucketBoundaries: [100, 500, 1000, 2000, 5000, 10000, 20000, 30000, 60000] },
  })
  const decisionLatency = meter.createHistogram('starcoach_decision_latency_ms', {
    description: 'Strategy decision to order ack',
    advice: { explicitBucketBoundaries: [10, 50, 100, 250, 500, 1000, 2500, 5000, 10000] },
  })
  const orderLatency = meter.createHistogram('starcoach_order_latency_ms', {
    description: 'Exchange place call latency',
    advice: { explicitBucketBoundaries: [50, 100, 250, 500, 1000, 2000, 5000, 10000] },
  })

  // The SDK's Histogram.record() drops negative values (OTel histograms are meant for durations), but a trade PnL is signed.
  // _record skips only that check; the bucket aggregation handles negatives. Falls back to record() if a future SDK renames it.
  const recordSigned = (h: Histogram, v: number) => {
    const raw = (h as unknown as { _record?: (v: number) => void })._record
    if (typeof raw === 'function') raw.call(h, v)
    else h.record(v)
  }

  // Create series at 0 so increase() sees the first real event.
  for (const kind of ['exit', 'tp', 'entry']) execRejected.add(0, { kind })
  degraded.add(0)
  setups.add(0, { outcome: 'accepted', reason: 'ok', model: 'none' })
  verdicts.add(0, { action: 'approve', source: 'fallback' })
  verdicts.add(0, { action: 'approve', source: 'ai' })

  const intents = new Map<string, { symbol: string; side: string }>()
  const verdictModel = new Map<string, string>()
  const remember = <V>(m: Map<string, V>, k: string, v: V) => {
    m.delete(k)
    m.set(k, v)
    if (m.size > 500) m.delete(m.keys().next().value!)
  }

  const handlers: Record<string, (d: Record<string, unknown>) => void> = {
    'daemon.start'(d) {
      const se = num(d.startEquity)
      if (se !== null && se > 0) startEquity = se
      const end = typeof d.runEnd === 'string' ? Date.parse(d.runEnd) : NaN
      if (Number.isFinite(end)) runEndMs = end
    },
    'daemon.heartbeat'(d) {
      const g = obj(d.guard)
      const positions = Array.isArray(d.positions) ? d.positions : []
      const barAge: Record<string, number | null> = {}
      for (const [s, v] of Object.entries(obj(d.barAgeSec))) barAge[s] = num(v)
      const kill = typeof d.blockReason === 'string' && d.blockReason.startsWith('kill switch')
      beat = {
        at: Date.now(),
        equity: num(d.equity),
        guardEquity: num(g.equity),
        dayPeak: num(g.dayPeak),
        dayPnl: num(g.dayPnlPct),
        totalPnl: num(g.totalPnlPct),
        risk: num(g.riskPct),
        losses: num(g.consecutiveLosses),
        halted: g.halted === true || kill,
        haltReason: kill ? 'kill_switch' : slugReason(g.haltReason ?? 'halted'),
        positions: positions.length,
        notional: positions.reduce<number>((a, p) => a + (num(obj(p).notional) ?? 0), 0),
        barAge,
      }
      const toEnd = num(d.msToEnd)
      if (toEnd !== null) runEndMs = beat.at + toEnd
    },
    'daemon.degraded'() {
      degraded.add(1)
    },
    'daemon.api_error'(d) {
      apiErrors.add(1, { kind: kinds.norm(slugReason(d.kind)) })
    },
    'exchange.place_failed'() {
      apiErrors.add(1, { kind: 'place' })
    },
    'order.error'() {
      apiErrors.add(1, { kind: 'order' })
    },
    'exchange.place'(d) {
      const ms = num(d.ms)
      if (ms !== null) orderLatency.record(ms)
    },
    'poll.error'(d) {
      pollErrors.add(1, { symbol: String(d.symbol ?? 'unknown') })
    },
    'order.intent'(d) {
      if (typeof d.clientId === 'string') remember(intents, d.clientId, { symbol: String(d.symbol ?? 'unknown'), side: String(d.side ?? 'unknown').toLowerCase() })
    },
    'order.ack'(d) {
      const id = typeof d.clientId === 'string' ? d.clientId : ''
      const i = intents.get(id)
      intents.delete(id)
      orders.add(1, { symbol: i?.symbol ?? 'unknown', side: i?.side ?? 'unknown', status: String(d.status ?? 'unknown').toLowerCase() })
      const ms = num(d.decisionMs)
      if (ms !== null) decisionLatency.record(ms)
    },
    'entry.rejected'() {
      execRejected.add(1, { kind: 'entry' })
    },
    'tp.rejected'() {
      execRejected.add(1, { kind: 'tp' })
    },
    'exit.rejected'() {
      execRejected.add(1, { kind: 'exit' })
    },
    exit(d) {
      const frac = num(d.pnlFraction)
      if (frac === null) return
      const how = String(d.how ?? '').toLowerCase()
      closed.add(1, {
        symbol: String(d.symbol ?? 'unknown'),
        result: frac > 1e-4 ? 'win' : frac < -1e-4 ? 'loss' : 'breakeven',
        how: how === 'stop' ? 'stop' : how === 'take profit' ? 'tp' : how === 'time stop' ? 'time' : 'other',
      })
      recordSigned(pnlHist, frac)
    },
    'setup.accepted'(d) {
      setups.add(1, { outcome: 'accepted', reason: 'ok', model: models.norm(verdictModel.get(String(d.symbol)) ?? 'none') })
    },
    'setup.rejected'(d) {
      const v = obj(d.verdict)
      setups.add(1, { outcome: 'rejected', reason: reasons.norm(slugReason(d.reason)), model: models.norm(typeof v.model === 'string' ? v.model : 'none') })
    },
    'ai.verdict'(d) {
      remember(verdictModel, String(d.symbol), typeof d.model === 'string' ? d.model : 'none')
      verdicts.add(1, { action: verdictActions.norm(String(d.action ?? 'unknown')), source: verdictSources.norm(String(d.source ?? 'unknown')) })
      const ms = num(d.latencyMs)
      if (ms !== null) aiLatency.record(ms)
    },
  }

  const wrapper = ((event: string, data?: Record<string, unknown>) => {
    try {
      handlers[event]?.(obj(data))
      if (TRACKED_EVENTS.has(event)) events.add(1, { event })
    } catch {}
    return log(event, data)
  }) as Log

  const ready = prom
    .startServer()
    .then(() => {
      out.url = `http://${host}:${port}/metrics`
    })
    .catch((e) => {
      console.error(`telemetry: cannot start metrics endpoint on ${host}:${port}: ${String(e)}`)
    })

  const out: TelemetryLog = Object.assign(wrapper, {
    path: log.path,
    url: null as string | null,
    ready,
    async close() {
      try {
        await Promise.race([provider.shutdown(), new Promise((r) => setTimeout(r, 2_000))])
      } catch {}
    },
  })
  return out
}
