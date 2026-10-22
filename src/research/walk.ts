import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { getSettings } from '../settings'
import { loadCandles } from '../data/candles'
import { withGuardFeed, type StatefulStrategy } from '../daemon'
import { loadBlocked } from '../exchange/validate'
import type { FindSetup } from '../ict/types'
import type { Log } from '../log'
import { createGuard } from '../risk/guard'
import { runBacktest } from '../runner/backtest'
import { createIctStrategy, type IctOptions } from '../strategy/ict'
import type { Candle, Markets, Strategy } from '../types'
import { fetchMarketsPayload, selectUniverse } from '../universe'
import { WallexRest } from '../wallex/rest'

export interface GridEntry {
  name: string
  detect?: Record<string, unknown>
  options?: Partial<IctOptions>
}

export interface RunMetrics {
  trades: number
  winRate: number
  avgR: number
  expectancyPct: number
  returnPct: number
  maxDrawdownPct: number
  feesTmn: number
  volumeTmn: number
  setupsAccepted: number
  setupsRejected: number
  execRejects: number
  rejectedByReason: Record<string, number>
}

export interface EntryResult {
  entry: GridEntry
  train: RunMetrics
  test: RunMetrics
}

export const MIN_TRAIN_TRADES = getSettings().research.minTrainTrades
export const WARMUP_SEC = Math.round(getSettings().research.warmupHours * 3600)

export const defaultGrid: GridEntry[] = [
  { name: 'strict-baseline', options: { minNetRr: 2 } },
  { name: 'rr1.5', options: { minNetRr: 1.5 } },
  { name: 'rr1.3', options: { minNetRr: 1.3 } },
  { name: 'both-models-rr1.5', detect: { models: ['sweep', 'continuation'] }, options: { minNetRr: 1.5 } },
  { name: 'sweep-only-rr1.5', detect: { models: ['sweep'] }, options: { minNetRr: 1.5 } },
  { name: 'cont-only-rr1.5', detect: { models: ['continuation'] }, options: { minNetRr: 1.5 } },
  { name: 'minStop0.007-rr1.5', detect: { minStopPct: 0.007 }, options: { minNetRr: 1.5 } },
  { name: 'minStop0.007-rr1.3', detect: { minStopPct: 0.007 }, options: { minNetRr: 1.3 } },
]

type Ev = { event: string; data: Record<string, any> }

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0)

// Round trips come from the strategy's own `exit` events. Planned risk is qty * (entry - stop) from the matching `entry.placed`.
// Positions still open at the end of the window are liquidated by the backtest and count in return, not in trades.
export function metricsFromLog(events: Ev[], summary: { returnPct: number; maxDrawdownPct: number; feesTmn: number; volumeTmn: number }): RunMetrics {
  const placed = new Map<string, { qty: number; entry: number; stop: number }>()
  const exits: { pnl: number; r: number; frac: number }[] = []
  const rejectedByReason: Record<string, number> = {}
  let accepted = 0
  let rejected = 0
  let execRejects = 0
  for (const { event, data } of events) {
    if (event === 'entry.placed') placed.set(String(data.id), { qty: data.qty, entry: data.entry, stop: data.stop })
    else if (event === 'setup.accepted') accepted++
    else if (event === 'exit.rejected' || event === 'tp.rejected') execRejects++
    else if (event === 'setup.rejected') {
      rejected++
      const reason = String(data.reason).replace(/\d[\d.,]*/g, '#').split(':').slice(0, data.reason?.startsWith('guard') || data.reason?.startsWith('sizing') ? 2 : 1).join(':').trim()
      rejectedByReason[reason] = (rejectedByReason[reason] ?? 0) + 1
    } else if (event === 'exit') {
      const p = placed.get(String(data.id))
      const qty = p?.qty ?? data.qty
      const entry = p?.entry ?? data.entry
      const risk = p ? qty * (entry - p.stop) : 0
      exits.push({ pnl: data.pnlTmn, r: risk > 0 ? data.pnlTmn / risk : 0, frac: data.pnlFraction })
    }
  }
  return {
    trades: exits.length,
    winRate: exits.length ? exits.filter((e) => e.pnl > 0).length / exits.length : 0,
    avgR: mean(exits.map((e) => e.r)),
    expectancyPct: mean(exits.map((e) => e.frac)) * 100,
    returnPct: summary.returnPct,
    maxDrawdownPct: summary.maxDrawdownPct,
    feesTmn: summary.feesTmn,
    volumeTmn: summary.volumeTmn,
    setupsAccepted: accepted,
    setupsRejected: rejected,
    execRejects,
    rejectedByReason,
  }
}

export interface EvalCtx {
  meta: Markets
  blocked: Set<string>
  risk: number
  startTmn: number
  findSetup?: FindSetup
}

// One fresh strategy + guard + exchange per call. Bars before `startT` are only history for the detector: no orders are placed.
export async function evaluate(entry: GridEntry, bars: Record<string, Candle[]>, startT: number, ctx: EvalCtx): Promise<RunMetrics> {
  const events: Ev[] = []
  const log: Log = (event, data = {}) => {
    events.push({ event, data })
  }
  const { createMockSupervisor } = await import('../ai/mock')
  const supervisor = createMockSupervisor()
  const guard = createGuard({ startEquity: ctx.startTmn, limits: { killFile: '', riskPct: ctx.risk } })
  const ict = createIctStrategy({
    guard,
    supervisor,
    log,
    meta: ctx.meta,
    detect: entry.detect,
    options: entry.options,
    ...(ctx.findSetup ? { findSetup: ctx.findSetup } : {}),
  }) as StatefulStrategy
  const fed = withGuardFeed(ict, guard, ctx.meta)
  const strategy: Strategy = {
    name: fed.name,
    onBar: async (c) => (c.bars[c.bars.length - 1]!.t < startT ? [] : fed.onBar(c)),
  }
  const summary = await runBacktest({ bars, meta: ctx.meta, blocked: ctx.blocked, strategy, log, startTmn: ctx.startTmn })
  return metricsFromLog(events, summary)
}

export function pickBest(results: EntryResult[], minTrades = MIN_TRAIN_TRADES): { index: number; basis: 'return' | 'drawdown' } {
  // Only train numbers are read here.
  const eligible = results.map((r, i) => ({ i, m: r.train })).filter((x) => x.m.trades >= minTrades)
  if (eligible.length) {
    eligible.sort((a, b) => b.m.returnPct - a.m.returnPct || a.i - b.i)
    return { index: eligible[0]!.i, basis: 'return' }
  }
  const all = results.map((r, i) => ({ i, m: r.train }))
  all.sort((a, b) => a.m.maxDrawdownPct - b.m.maxDrawdownPct || b.m.returnPct - a.m.returnPct || a.i - b.i)
  return { index: all[0]!.i, basis: 'drawdown' }
}

export interface WalkResult {
  results: EntryResult[]
  picked: { index: number; basis: 'return' | 'drawdown'; name: string }
  trainRange: [number, number]
  testRange: [number, number]
}

export async function walkForward(o: {
  bars: Record<string, Candle[]>
  fromSec: number
  toSec: number
  split: number
  grid: GridEntry[]
  ctx: EvalCtx
}): Promise<WalkResult> {
  const splitSec = Math.floor(o.fromSec + (o.toSec - o.fromSec) * o.split)
  const slice = (lo: number, hi: number) =>
    Object.fromEntries(Object.entries(o.bars).map(([s, list]) => [s, list.filter((c) => c.t >= lo && c.t < hi)]))
  // Train feed ends at the split. Test feed starts WARMUP_SEC early so the detector has context, but trades only from the split.
  const trainBars = slice(0, splitSec)
  const testBars = slice(splitSec - WARMUP_SEC, o.toSec)
  const results: EntryResult[] = []
  for (const entry of o.grid) {
    const train = await evaluate(entry, trainBars, o.fromSec, o.ctx)
    const test = await evaluate(entry, testBars, splitSec, o.ctx)
    results.push({ entry, train, test })
  }
  const pick = pickBest(results)
  return {
    results,
    picked: { ...pick, name: results[pick.index]!.entry.name },
    trainRange: [o.fromSec, splitSec],
    testRange: [splitSec, o.toSec],
  }
}

const f = (n: number, d = 2) => n.toFixed(d)
const tmn = (n: number) => (n >= 1e6 ? `${f(n / 1e6, 2)}M` : `${Math.round(n / 1e3)}k`)

export function renderTable(w: WalkResult): string {
  const head = '| entry | win | trades | win% | avgR | exp %/trade | ret % | maxDD % | fees | volume | setups acc/rej | exec rej |\n|---|---|---|---|---|---|---|---|---|---|---|---|'
  const row = (name: string, win: string, m: RunMetrics) =>
    `| ${name} | ${win} | ${m.trades} | ${f(m.winRate * 100, 0)} | ${f(m.avgR)} | ${f(m.expectancyPct, 3)} | ${f(m.returnPct)} | ${f(m.maxDrawdownPct)} | ${tmn(m.feesTmn)} | ${tmn(m.volumeTmn)} | ${m.setupsAccepted}/${m.setupsRejected} | ${m.execRejects} |`
  const lines = w.results.flatMap((r, i) => {
    const n = i === w.picked.index ? `**${r.entry.name}** (picked)` : r.entry.name
    return [row(n, 'train', r.train), row(n, 'test', r.test)]
  })
  return [head, ...lines].join('\n')
}

function parseArgs(argv: string[]) {
  const out: Record<string, string> = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (!a.startsWith('--')) continue
    const next = argv[i + 1]
    if (next !== undefined && !next.startsWith('--')) {
      out[a.slice(2)] = next
      i++
    } else out[a.slice(2)] = 'true'
  }
  return out
}

async function main() {
  const argv = process.argv.slice(2)
  const args = parseArgs(argv)
  const S = getSettings()
  const cfg = { startTmn: S.paper.startTmn, makerFee: S.fees.maker, takerFee: S.fees.taker, logDir: S.logging.dir }
  const days = Number(args.days ?? S.research.defaultDays)
  const split = Number(args.split ?? S.research.trainSplit)
  const risk = Number(args.risk ?? S.risk.riskPct)
  const toSec = args.to ? Math.floor(Date.parse(args.to) / 60_000) * 60 : Math.floor(Date.now() / 60_000) * 60
  const fromSec = toSec - Math.round(days * 86_400)
  if (!(split > 0 && split < 1) || !(days > 0) || !(risk > 0)) throw new Error('bad --days/--split/--risk')

  const grid: GridEntry[] = args.grid ? JSON.parse(readFileSync(args.grid, 'utf8')) : defaultGrid
  if (!Array.isArray(grid) || !grid.length || grid.some((g) => typeof g?.name !== 'string')) throw new Error('grid must be a non-empty array of {name, detect?, options?}')

  const api = new WallexRest()
  const meta = await api.markets()
  const blocked = loadBlocked()
  const symbols = !args.symbols || args.symbols === 'auto' ? await selectUniverse(fetchMarketsPayload, blocked) : args.symbols.split(',').map((s) => s.trim()).filter(Boolean)
  if (!symbols.length) throw new Error('no symbols')
  console.log(`symbols (${symbols.length}): ${symbols.join(',')}`)

  const bars: Record<string, Candle[]> = {}
  for (let i = 0; i < symbols.length; i += 4) {
    await Promise.all(symbols.slice(i, i + 4).map(async (s) => (bars[s] = await loadCandles(api, s, fromSec - WARMUP_SEC, toSec))))
  }
  console.log(Object.entries(bars).map(([s, b]) => `${s}:${b.length}`).join(' '))

  const t0 = performance.now()
  const w = await walkForward({ bars, fromSec, toSec, split, grid, ctx: { meta, blocked, risk, startTmn: cfg.startTmn } })
  const secs = Math.round((performance.now() - t0) / 1000)

  const iso = (t: number) => new Date(t * 1000).toISOString().slice(0, 16) + 'Z'
  const table = renderTable(w)
  const picked = w.results[w.picked.index]!
  const command = `bun run research -- ${argv.join(' ')}`.trim()
  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  mkdirSync(cfg.logDir, { recursive: true })
  const jsonPath = `${cfg.logDir}/research-${ts}.json`
  writeFileSync(jsonPath, JSON.stringify({ command, symbols, fromSec, toSec, split, risk, startTmn: cfg.startTmn, fees: { maker: cfg.makerFee, taker: cfg.takerFee }, ...w }, null, 2))

  const doc = `# Walk-forward research

Generated ${new Date().toISOString()} by:

\`${command}\`

- Symbols (${symbols.length}): ${symbols.join(', ')}
- Train: ${iso(w.trainRange[0])} to ${iso(w.trainRange[1])}. Test: ${iso(w.testRange[0])} to ${iso(w.testRange[1])} (split ${split}).
- Start equity ${cfg.startTmn} TMN, risk per trade ${risk * 100}%, mock supervisor, guard without kill file or state.
- Fees: maker ${cfg.makerFee * 100}%, taker ${cfg.takerFee * 100}%. Fills need price to trade through the limit by one tick. Entry on bar i fills from bar i+1.
- Pick rule: best train return with at least ${MIN_TRAIN_TRADES} train trades, else lowest train drawdown. Picked: **${w.picked.name}** (basis: ${w.picked.basis}).
- Picked entry on TEST: ${picked.test.trades} trades, return ${f(picked.test.returnPct)}%, maxDD ${f(picked.test.maxDrawdownPct)}%, avgR ${f(picked.test.avgR)}.

${table}

Columns: exec rej counts rejected exit or take-profit orders; anything above 0 means a position could not be managed as designed (for example a paper-exchange balance error), so that run's return is not trustworthy. Trades are round trips (strategy \`exit\` events); avgR is net PnL over planned risk qty*(entry-stop); exp is mean net PnL per trade as % of equity at entry; ret and maxDD are whole-window equity figures including fees.

## Caveats

This is a short sample (${days} days, one market regime) on a handful of symbols, so every number here has wide error bars; with only a few trades per window, a single trade can flip the sign. Picking the best of ${grid.length} variants on train and seeing it do well on test is weak evidence, and the table is shown in full so that selection noise and train/test gaps are visible. \`--symbols auto\` ranks symbols using today's 24h stats, which look ahead relative to the historical window and favour coins that have recently been active. Fills are simulated from 1m candles, so queue position, partial fills and real spread are not modelled beyond the paper exchange rules. Positions still open when a window ends are liquidated by the harness: they move return but are not counted as trades. The test window gets 12h of earlier bars as detector context (no orders placed), and the grid parameters were chosen by hand before this run. None of this is a forecast of live performance.
`
  if (!existsSync('docs')) mkdirSync('docs', { recursive: true })
  writeFileSync('docs/RESEARCH.md', doc)

  console.log(`\n${table}\n`)
  console.log(`picked on train: ${w.picked.name} (${w.picked.basis}); test: ${picked.test.trades} trades, ret ${f(picked.test.returnPct)}%, maxDD ${f(picked.test.maxDrawdownPct)}%`)
  console.log(`rejects (picked, test): ${JSON.stringify(picked.test.rejectedByReason)}`)
  console.log(`done in ${secs}s. json: ${jsonPath}, doc: docs/RESEARCH.md`)
}

if (import.meta.main) {
  main().catch((e) => {
    console.error(String(e))
    process.exit(1)
  })
}
