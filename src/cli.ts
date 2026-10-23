import { env } from './env'
import { cfg } from './config'
import { loadCandles } from './data/candles'
import { resolveSchedule, runDaemon, withGuardFeed, type StatefulStrategy } from './daemon'
import { DryExchange } from './exchange/dry'
import { LiveExchange } from './exchange/live'
import { PaperExchange } from './exchange/paper'
import { loadBlocked } from './exchange/validate'
import { DAEMON_LOG, gitSha, openLog, type Log } from './log'
import { pullout } from './pullout'
import { createGuard } from './risk/guard'
import { runBacktest } from './runner/backtest'
import { runPoll } from './runner/poll'
import { SettingsError, getSettings, settingsHash } from './settings'
import { strategies } from './strategy'
import { attachTelemetry } from './telemetry/otel'
import type { Markets, Strategy } from './types'
import { fetchMarketsPayload, selectUniverse } from './universe'
import { WallexRest } from './wallex/rest'

function parseArgs(argv: string[]) {
  const out: Record<string, string | boolean> = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (!a.startsWith('--')) continue
    const next = argv[i + 1]
    if (next && !next.startsWith('--')) {
      out[a.slice(2)] = next
      i++
    } else out[a.slice(2)] = true
  }
  return out
}

// `env` is validated when imported (exit 78 on a bad value); a bad config file or STARCOACH__ override exits 78 here.
function loadConfig() {
  try {
    return getSettings()
  } catch (e) {
    if (!(e instanceof SettingsError)) throw e
    console.error(e.message)
    process.exit(78)
  }
}

const S = loadConfig()
const configHash = settingsHash(S)
const [cmd, ...rest] = process.argv.slice(2)
const args = parseArgs(rest)
let symbols = typeof args.symbols === 'string' && args.symbols !== 'auto' ? args.symbols.split(',') : cfg.symbols
// `--symbols auto` always uses the universe; without --symbols, market.universe.auto decides. Explicit symbols win.
const useUniverse = args.symbols === 'auto' || (args.symbols === undefined && S.market.universe.auto)
const strategyName = (fallback: string = S.strategy.active) => String(args.strategy ?? fallback)
const aiOn = (fallback: boolean) => (args.ai === undefined ? fallback : String(args.ai) === 'on')

const api = new WallexRest()

async function makeSupervisor(on: boolean, log: Log) {
  if (on) return (await import('./ai/supervisor')).createSupervisor({ log })
  return (await import('./ai/mock')).createMockSupervisor()
}

// combo, breakout and ict need a guard and a supervisor. Other strategies come from the plain registry.
async function prepareStrategy(name: string, o: { ai: boolean; meta: Markets; log: Log }) {
  if (name === 'breakout' || name === 'combo') {
    const { createBreakoutStrategy, createComboStrategy } = await import('./strategy')
    const supervisor = await makeSupervisor(o.ai, o.log)
    const guard = createGuard({ startEquity: cfg.startTmn, limits: { killFile: '' } })
    const make = name === 'combo' ? createComboStrategy : createBreakoutStrategy
    const strategy = withGuardFeed(make({ guard, supervisor, log: o.log, meta: o.meta }) as StatefulStrategy, guard, o.meta)
    return { strategy: strategy as Strategy, close: async () => supervisor.close?.() }
  }
  if (name !== 'ict') {
    const plain = strategies[name]
    if (!plain) throw new Error(`unknown strategy ${name}`)
    return { strategy: plain as Strategy, close: async () => {} }
  }
  const { createIctStrategy } = await import('./strategy')
  const supervisor = await makeSupervisor(o.ai, o.log)
  const guard = createGuard({ startEquity: cfg.startTmn, limits: { killFile: '' } })
  const strategy = withGuardFeed(createIctStrategy({ guard, supervisor, log: o.log, meta: o.meta }) as StatefulStrategy, guard, o.meta)
  return { strategy: strategy as Strategy, close: async () => supervisor.close?.() }
}

async function main() {
  if (useUniverse && ['backtest', 'shadow', 'dry', 'live'].includes(cmd ?? '')) {
    symbols = await selectUniverse(fetchMarketsPayload, loadBlocked())
    if (!symbols.length) throw new Error('the auto universe selected nothing')
    console.log(`auto universe: ${symbols.join(',')}`)
  }
  switch (cmd) {
    case 'check': {
      const meta = await api.markets()
      console.log(`markets: ${Object.keys(meta).length}`)
      console.log(`api key: ${api.hasKey ? 'set' : 'MISSING'}`)
      if (!api.hasKey) return
      console.log('raw balances:', JSON.stringify(await api.rawBalances(), null, 2))
      console.log('raw open orders:', JSON.stringify(await api.rawOpenOrders(), null, 2))
      return
    }

    case 'backtest': {
      const toSec = args.to ? Math.floor(Date.parse(String(args.to)) / 1000) : Math.floor(Date.now() / 1000)
      const fromSec = args.from ? Math.floor(Date.parse(String(args.from)) / 1000) : toSec - Number(args.days ?? S.research.defaultDays) * 86_400
      const meta = await api.markets()
      const log = openLog('backtest')
      const bars: Record<string, Awaited<ReturnType<typeof loadCandles>>> = {}
      for (const s of symbols) {
        bars[s] = await loadCandles(api, s, fromSec, toSec)
        console.log(`${s}: ${bars[s]!.length} bars`)
      }
      const prepared = await prepareStrategy(strategyName(), { ai: aiOn(false), meta, log })
      // Slow-timeframe strategies get the days before the window as history, so the backtest has no dead warm-up period.
      const primeDays = prepared.strategy.prime ? (prepared.strategy.primeDays ?? 0) : 0
      if (primeDays > 0) for (const s of symbols) prepared.strategy.prime!(s, await loadCandles(api, s, fromSec - Math.round(primeDays * 86_400), fromSec))
      const summary = await runBacktest({ bars, meta, blocked: loadBlocked(), strategy: prepared.strategy, log })
      await prepared.close()
      console.log(summary)
      console.log(`log: ${log.path}`)
      return
    }

    case 'shadow': {
      const meta = await api.markets()
      const log = openLog('shadow')
      const ex = new PaperExchange(meta, loadBlocked())
      const minutes = Number(args.minutes ?? S.run.defaultHours * 60)
      const { strategy, close } = await prepareStrategy(strategyName(), { ai: aiOn(true), meta, log })
      console.log(`shadow: ${symbols.join(',')} for ${minutes} min, strategy ${strategy.name}, config ${configHash.slice(0, 12)}, log ${log.path}`)
      await runPoll({
        rest: api, symbols, strategy, ex, paper: ex, log,
        durationMs: minutes * 60_000, pollMs: S.wallex.pollMs,
        onCycle: async () => log('shadow.equity', { equity: Math.round(ex.equity()), fills: ex.fills.length }),
      })
      await close()
      console.log({ equity: ex.equity(), fills: ex.fills.length })
      return
    }

    case 'dry': {
      const meta = await api.markets()
      const log = openLog('dry')
      const ex = new DryExchange(api, meta, loadBlocked(), log)
      const { strategy, close } = await prepareStrategy(strategyName(), { ai: aiOn(true), meta, log })
      console.log(`dry run: exchange calls are validated and logged, never sent. log ${log.path}`)
      const probeSymbol = symbols[0]!
      const q = await api.depth(probeSymbol)
      const m = meta[probeSymbol]!
      const price = q.bid * 0.5
      const quantity = Math.ceil((m.minNotional * 1.2) / price)
      const ack = await ex.place({ clientId: `probe_${Date.now().toString(36)}`, symbol: probeSymbol, side: 'BUY', type: 'LIMIT', price, quantity, reason: 'dry-run wiring probe' })
      console.log('probe:', ack)
      await runPoll({
        rest: api, symbols, strategy, ex, log,
        durationMs: Number(args.minutes ?? 5) * 60_000, pollMs: S.wallex.pollMs, once: Boolean(args.once),
      })
      await close()
      return
    }

    case 'live': {
      const mode = args.paper ? 'paper' : args.dry ? 'dry' : 'live'
      if (mode === 'live' && !api.hasKey) throw new Error('WALLEX_API_KEY is required for live trading (use --paper or --dry to test)')
      if (mode === 'live' && !args['confirm-live'] && env.STARCOACH_CONFIRM_LIVE !== 'yes') {
        throw new Error('live mode places real orders. Pass --confirm-live or set STARCOACH_CONFIRM_LIVE=yes (or use --paper / --dry)')
      }
      const meta = await api.markets()
      const rawLog = openLog(DAEMON_LOG)
      const sched = resolveSchedule({
        runEnd: args['run-end'] ? Date.parse(String(args['run-end'])) : undefined,
        entryCutoffMin: args['entry-cutoff-min'] ? Number(args['entry-cutoff-min']) : undefined,
      })
      if (!Number.isFinite(sched.runEnd)) throw new Error('--run-end is not a valid ISO time')
      const tele = attachTelemetry(rawLog, { mode, sha: gitSha, symbols, runEndSec: Math.floor(sched.runEnd / 1000), startEquity: cfg.startTmn, disabled: Boolean(args['no-metrics']) })
      await tele.ready
      console.log(tele.url ? `metrics: ${tele.url}` : 'metrics: disabled')
      const log = tele
      const echo: Log = Object.assign(
        (event: string, data?: Record<string, unknown>) => {
          log(event, data)
          if (event === 'daemon.heartbeat') {
            const g = data!.guard as { riskPct: number; halted: boolean }
            console.log(`${new Date().toISOString()} ${data!.phase} equity=${data!.equity} risk=${g.riskPct} halted=${g.halted} positions=${(data!.positions as unknown[]).length} api_errors=${(data!.api as { total: number }).total}`)
          } else if (event.startsWith('daemon.')) console.log(event, JSON.stringify(data ?? {}))
        },
        { path: log.path },
      )
      const name = strategyName()
      const sup = name === 'ict' || name === 'breakout' || name === 'combo' ? await makeSupervisor(aiOn(true), echo) : null
      const ict = name === 'ict' ? (await import('./strategy')).createIctStrategy : null
      const mod = await import('./strategy')
      const breakout = name === 'breakout' ? mod.createBreakoutStrategy : name === 'combo' ? mod.createComboStrategy : null
      console.log(`live (${mode}): ${symbols.join(',')} strategy ${name} until ${new Date(sched.runEnd).toISOString()}, config ${configHash.slice(0, 12)}${S.risk.killFile ? `, kill file ${S.risk.killFile}` : ''}, log ${log.path}`)
      const result = await runDaemon({
        rest: api,
        mode,
        symbols,
        meta,
        log: echo,
        runEnd: sched.runEnd,
        entryCutoffMin: sched.entryCutoffMin,
        makeStrategy: ({ guard }) => {
          if (breakout) return breakout({ guard, supervisor: sup!, log: echo, meta }) as StatefulStrategy
          if (ict) return ict({ guard, supervisor: sup!, log: echo, meta }) as StatefulStrategy
          const plain = strategies[name]
          if (!plain) throw new Error(`unknown strategy ${name}`)
          return plain
        },
      })
      await sup?.close?.()
      await tele.close()
      console.log(result)
      // Reaching RUN_END with coins still held is a normal end (they are converted with `pullout --yes`), so it exits 0 and
      // Docker does not restart a finished run. A non-flat exit after a signal (crash, stop) is reported as 1.
      process.exit(result.flat || result.reason === 'run_end' ? 0 : 1)
    }

    case 'pullout': {
      if (!api.hasKey) throw new Error('WALLEX_API_KEY is required')
      const meta = await api.markets()
      const log = openLog('pullout')
      const ex = new LiveExchange(api, meta, loadBlocked(), log)
      const execute = Boolean(args.yes)
      const report = await pullout(ex, meta, { execute, log })
      const fmt = (h: { asset: string; qty: number; value: number }) => `  ${h.asset}: ${h.qty} (~${Math.round(h.value)} TMN)`
      if (!execute) {
        console.log('PLAN (nothing sent). Re-run with --yes to execute.')
        console.log('will sell:\n' + (report.sells.map(fmt).join('\n') || '  nothing'))
      } else {
        console.log(`done. TMN balance: ${Math.round(report.tmn)}`)
        if (report.remaining.length) console.log('STILL HELD (run again):\n' + report.remaining.map(fmt).join('\n'))
      }
      if (report.dust.length) console.log('dust below min order, cannot sell:\n' + report.dust.map(fmt).join('\n'))
      if (report.unroutable.length) console.log('no TMN market for: ' + report.unroutable.join(', '))
      console.log(`log: ${log.path}`)
      if (report.executed && report.remaining.length) process.exit(1)
      return
    }

    default:
      console.log('usage: bun src/cli.ts <check|backtest|shadow|dry|live|pullout> [--symbols A,B] [--days N] [--minutes N] [--once] [--yes] [--strategy combo|breakout|ict|noop (default strategy.active, combo)] [--ai on|off] [--paper|--dry|--confirm-live] [--run-end ISO] [--no-metrics]')
  }
}

main().catch((e) => {
  console.error(String(e))
  process.exit(1)
})
