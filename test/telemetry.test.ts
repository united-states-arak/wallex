import { afterEach, describe, expect, test } from 'bun:test'
import { attachTelemetry, slugReason, type TelemetryLog } from '../src/telemetry/otel'
import type { Log } from '../src/log'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runDaemon } from '../src/daemon'
import { PaperExchange } from '../src/exchange/paper'
import { bar, meta } from './fixtures'

const freePort = () => {
  const s = Bun.serve({ port: 0, fetch: () => new Response('') })
  const p = s.port!
  s.stop(true)
  return p
}

const open: TelemetryLog[] = []
const envKeys = ['OTEL_SDK_DISABLED', 'OTEL_EXPORTER_OTLP_ENDPOINT', 'OTEL_EXPORTER_OTLP_HEADERS'] as const
afterEach(async () => {
  for (const t of open.splice(0)) await t.close()
  for (const k of envKeys) delete process.env[k]
})

async function start(extra: Partial<Parameters<typeof attachTelemetry>[1]> = {}) {
  const seen: [string, unknown][] = []
  const base: Log = (e, d) => void seen.push([e, d])
  const port = freePort()
  const t = attachTelemetry(base, { mode: 'live', sha: 'abc123', symbols: ['PEPETMN', 'DOGETMN'], startEquity: 1_000_000, port, ...extra })
  open.push(t)
  await t.ready
  const scrape = async () => (await fetch(`http://127.0.0.1:${port}/metrics`)).text()
  return { t, seen, scrape, port }
}

const line = (body: string, re: RegExp) => body.split('\n').find((l) => re.test(l))
const val = (body: string, re: RegExp) => Number(line(body, re)?.split(' ').pop())

describe('telemetry', () => {
  test('slugReason bounds free text', () => {
    expect(slugReason('guard: daily loss halt: equity 9 is 12.0% below the day peak')).toBe('guard_daily_loss_halt')
    expect(slugReason('max entries per hour (6)')).toBe('max_entries_per_hour')
    expect(slugReason('no quote: Error: timeout 5000ms')).toBe('no_quote')
    expect(slugReason('')).toBe('unknown')
  })

  test('derives series from a canned event sequence', async () => {
    const { t, seen, scrape } = await start()
    t('daemon.start', { runEnd: new Date(Date.now() + 3600_000).toISOString(), startEquity: 1_000_000 })
    t('ai.verdict', { symbol: 'PEPETMN', action: 'approve', source: 'ai', model: 'm1', latencyMs: 1500 })
    t('ai.verdict', { symbol: 'DOGETMN', action: 'veto', source: 'fallback', model: 'm1', latencyMs: 20000 })
    t('setup.accepted', { symbol: 'PEPETMN', verdict: 'approve' })
    t('setup.rejected', { symbol: 'DOGETMN', reason: 'guard: loss pause: 3 losses in a row, resumes in 12 min' })
    t('setup.rejected', { symbol: 'DOGETMN', reason: 'net RR too low', netRr: 1.1 })
    t('order.intent', { clientId: 'a1', symbol: 'PEPETMN', side: 'BUY' })
    t('exchange.place', { ms: 120, body: {}, result: {} })
    t('order.ack', { clientId: 'a1', status: 'NEW', mode: 'live', decisionMs: 40 })
    t('order.intent', { clientId: 'a2', symbol: 'PEPETMN', side: 'SELL' })
    t('order.ack', { clientId: 'a2', status: 'REJECTED', error: 'x' })
    t('exit.rejected', { symbol: 'PEPETMN', id: 'a2', error: 'x' })
    t('exit', { symbol: 'PEPETMN', how: 'stop', pnlFraction: -0.012, pnlTmn: -1 })
    t('exit', { symbol: 'PEPETMN', how: 'take profit', pnlFraction: 0.02 })
    t('daemon.api_error', { kind: 'quote', error: 'boom', consecutive: 1 })
    t('poll.error', { symbol: 'DOGETMN', error: 'x' })
    t('daemon.degraded', {})
    t('daemon.heartbeat', {
      mode: 'live',
      equity: 950_000,
      guard: { equity: 950_000, dayPeak: 1_000_000, dayPnlPct: -0.05, totalPnlPct: -0.05, consecutiveLosses: 2, halted: true, haltReason: 'daily loss halt', riskPct: 0.01 },
      blockReason: 'daily loss halt: equity 950000 is 5.0% below the day peak',
      positions: [{ symbol: 'PEPETMN', notional: 95_000 }],
      barAgeSec: { PEPETMN: 30, DOGETMN: null },
      msToEnd: 1_800_000,
    })

    expect(seen.length).toBe(18)
    const m = await scrape()
    expect(m).toMatch(/starcoach_up\{[^}]*mode="live"[^}]*sha="abc123"[^}]*\} 1/)
    expect(m).toContain('service_name="starcoach-trader"')
    expect(val(m, /^starcoach_equity_tmn /)).toBe(950_000)
    expect(val(m, /^starcoach_start_equity_tmn /)).toBe(1_000_000)
    expect(val(m, /^starcoach_pnl_pct /)).toBeCloseTo(-0.05)
    expect(val(m, /^starcoach_drawdown_pct /)).toBeCloseTo(0.05)
    expect(val(m, /^starcoach_exposure_pct /)).toBeCloseTo(0.1)
    expect(val(m, /^starcoach_open_positions /)).toBe(1)
    expect(val(m, /^starcoach_consecutive_losses /)).toBe(2)
    expect(val(m, /^starcoach_guard_halted\{reason="daily_loss_halt"\}/)).toBe(1)
    expect(val(m, /^starcoach_run_seconds_remaining /)).toBeGreaterThan(1790)
    expect(val(m, /^starcoach_last_bar_age_seconds\{symbol="PEPETMN"\}/)).toBeGreaterThanOrEqual(30)
    expect(line(m, /^starcoach_last_bar_age_seconds\{symbol="DOGETMN"\}/)).toBeDefined()

    expect(val(m, /^starcoach_orders_total\{[^}]*side="buy"[^}]*status="new"|^starcoach_orders_total\{[^}]*status="new"[^}]*\}/)).toBe(1)
    expect(m).toMatch(/starcoach_orders_total\{(?=[^}]*symbol="PEPETMN")(?=[^}]*side="sell")(?=[^}]*status="rejected")[^}]*\} 1/)
    expect(m).toMatch(/starcoach_trades_closed_total\{(?=[^}]*result="loss")(?=[^}]*how="stop")[^}]*\} 1/)
    expect(m).toMatch(/starcoach_trades_closed_total\{(?=[^}]*result="win")(?=[^}]*how="tp")[^}]*\} 1/)
    expect(m).toMatch(/starcoach_setups_total\{(?=[^}]*outcome="rejected")(?=[^}]*reason="guard_loss_pause")[^}]*\} 1/)
    expect(m).toMatch(/starcoach_setups_total\{(?=[^}]*outcome="rejected")(?=[^}]*reason="net_rr_too_low")[^}]*\} 1/)
    expect(m).toMatch(/starcoach_setups_total\{(?=[^}]*outcome="accepted")(?=[^}]*model="m1")[^}]*\} 1/)
    expect(m).toMatch(/starcoach_ai_verdicts_total\{(?=[^}]*action="veto")(?=[^}]*source="fallback")[^}]*\} 1/)
    expect(val(m, /^starcoach_exec_rejected_total\{kind="exit"\}/)).toBe(1)
    expect(val(m, /^starcoach_exec_rejected_total\{kind="tp"\}/)).toBe(0)
    expect(val(m, /^starcoach_api_errors_total\{kind="quote"\}/)).toBe(1)
    expect(val(m, /^starcoach_poll_errors_total\{symbol="DOGETMN"\}/)).toBe(1)
    expect(val(m, /^starcoach_daemon_degraded_total /)).toBe(1)

    expect(val(m, /^starcoach_trade_pnl_pct_count /)).toBe(2)
    expect(val(m, /^starcoach_trade_pnl_pct_bucket\{le="-0.02"\}/)).toBe(0)
    expect(val(m, /^starcoach_trade_pnl_pct_bucket\{le="-0.01"\}/)).toBe(1)
    expect(val(m, /^starcoach_trade_pnl_pct_bucket\{le="0.02"\}/)).toBe(2)
    expect(val(m, /^starcoach_ai_latency_ms_count /)).toBe(2)
    expect(val(m, /^starcoach_ai_latency_ms_bucket\{le="2000"\}/)).toBe(1)
    expect(val(m, /^starcoach_decision_latency_ms_count /)).toBe(1)
    expect(val(m, /^starcoach_order_latency_ms_bucket\{le="250"\}/)).toBe(1)
    expect(m).not.toContain('_milliseconds')
  })

  test('heartbeat age grows between scrapes and resets on a new heartbeat', async () => {
    const { t, scrape } = await start()
    t('daemon.heartbeat', { guard: { equity: 1, dayPeak: 1 }, positions: [], barAgeSec: {} })
    const a = val(await scrape(), /^starcoach_heartbeat_age_seconds /)
    await Bun.sleep(1100)
    const b = val(await scrape(), /^starcoach_heartbeat_age_seconds /)
    expect(b).toBeGreaterThan(a + 0.9)
    t('daemon.heartbeat', { guard: { equity: 1, dayPeak: 1 }, positions: [], barAgeSec: {} })
    expect(val(await scrape(), /^starcoach_heartbeat_age_seconds /)).toBeLessThan(0.5)
  })

  test('bad events never throw and are still forwarded', async () => {
    const { t, seen } = await start()
    const bad: unknown[] = [undefined, null, 'str', 42, { guard: 'x', positions: 'y', barAgeSec: 7 }, { pnlFraction: 'NaN' }, { clientId: {} }]
    for (const d of bad) for (const e of ['daemon.heartbeat', 'exit', 'order.ack', 'order.intent', 'setup.rejected', 'ai.verdict', 'weird.event']) {
      expect(() => t(e, d as never)).not.toThrow()
    }
    expect(seen.length).toBe(bad.length * 7)
  })

  test('unreachable OTLP endpoint does not throw or block', async () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = `http://127.0.0.1:${freePort()}`
    const { t, scrape } = await start({ otlpIntervalMs: 100 })
    expect(() => t('daemon.heartbeat', { guard: {}, positions: [] })).not.toThrow()
    await Bun.sleep(350)
    expect(await scrape()).toContain('starcoach_up')
    const t0 = Date.now()
    await t.close()
    expect(Date.now() - t0).toBeLessThan(3000)
  })

  test('pushes OTLP/HTTP with headers from env', async () => {
    const got: { path: string; auth: string | null; len: number }[] = []
    const sink = Bun.serve({
      port: 0,
      fetch: async (r) => {
        got.push({ path: new URL(r.url).pathname, auth: r.headers.get('authorization'), len: (await r.arrayBuffer()).byteLength })
        return new Response('{}')
      },
    })
    try {
      process.env.OTEL_EXPORTER_OTLP_ENDPOINT = `http://127.0.0.1:${sink.port}`
      process.env.OTEL_EXPORTER_OTLP_HEADERS = 'authorization=Basic dGVzdA=='
      const { t } = await start({ otlpIntervalMs: 100 })
      t('exit', { symbol: 'X', how: 'stop', pnlFraction: -0.01 })
      await Bun.sleep(500)
      expect(got.length).toBeGreaterThan(0)
      expect(got[0]!.path).toBe('/v1/metrics')
      expect(got[0]!.auth).toBe('Basic dGVzdA==')
      expect(got[0]!.len).toBeGreaterThan(100)
      await t.close()
    } finally {
      sink.stop(true)
    }
  })

  test('disabled mode forwards events and opens no server', async () => {
    const port = freePort()
    for (const mode of ['opt', 'env']) {
      if (mode === 'env') process.env.OTEL_SDK_DISABLED = 'true'
      const seen: string[] = []
      const t = attachTelemetry(Object.assign((e: string) => void seen.push(e), { path: 'p.jsonl' }) as Log, {
        mode: 'live', sha: 's', symbols: [], startEquity: 1, port, disabled: mode === 'opt',
      })
      await t.ready
      t('exit', { pnlFraction: 1 })
      expect(seen).toEqual(['exit'])
      expect(t.path).toBe('p.jsonl')
      expect(t.url).toBeNull()
      await t.close()
      expect(fetch(`http://127.0.0.1:${port}/metrics`)).rejects.toBeDefined()
    }
  })

  test('port already in use degrades to forwarding only', async () => {
    const taken = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('') })
    try {
      const seen: string[] = []
      const t = attachTelemetry(((e: string) => void seen.push(e)) as Log, { mode: 'live', sha: 's', symbols: [], startEquity: 1, port: taken.port })
      open.push(t)
      await t.ready
      t('exit', {})
      expect(seen).toEqual(['exit'])
      expect(t.url).toBeNull()
    } finally {
      taken.stop(true)
    }
  })
})

test('real daemon heartbeat and order events feed the metrics', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tele-'))
  const { t, scrape } = await start({ symbols: ['PEPETMN'], startEquity: 5_000_000 })
  const t0 = Math.floor(Date.now() / 60_000) * 60 - 600
  let calls = 0
  let n = 0
  try {
    const runEnd = Date.now() + 2_500
    const res = runDaemon({
      tickMs: 100, pollMs: 100, signals: false,
      rest: {
        hasKey: true,
        markets: async () => meta,
        depth: async () => ({ bid: 1.19, ask: 1.2 }),
        history: async (_s, from) => {
          calls++
          const out = []
          for (let i = 0; i <= Math.min(calls, 5); i++) out.push(bar(t0 + i * 60, 1.2, 1.21, 1.19, 1.2))
          return out.filter((c) => c.t >= from - 3600)
        },
      },
      mode: 'paper', symbols: ['PEPETMN'], meta, ex: new PaperExchange(meta, new Set(), { TMN: 5_000_000 }),
      log: t, runEnd, entryCutoffMin: 0.01, stateDir: dir,
      makeStrategy: () => ({
        name: 'stub',
        async onBar() {
          return n++ === 0 ? [{ clientId: 'b1', symbol: 'PEPETMN', side: 'BUY' as const, type: 'LIMIT' as const, price: 1.3, quantity: 1_000_000, reason: 'test' }] : []
        },
        getState: () => ({}),
        restoreState() {},
        openPositions: () => [],
      }),
    })
    await Bun.sleep(1200)
    const m = await scrape()
    expect(val(m, /^starcoach_equity_tmn /)).toBeGreaterThan(4_000_000)
    expect(val(m, /^starcoach_start_equity_tmn /)).toBe(5_000_000)
    expect(val(m, /^starcoach_run_seconds_remaining /)).toBeGreaterThan(0)
    expect(val(m, /^starcoach_heartbeat_age_seconds /)).toBeLessThan(2)
    expect(m).toMatch(/starcoach_orders_total\{(?=[^}]*symbol="PEPETMN")(?=[^}]*side="buy")[^}]*\} 1/)
    expect(line(m, /^starcoach_guard_halted\{reason="none"\} 0/)).toBeDefined()
    await res
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
