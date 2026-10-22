import { loadCandles } from '../data/candles'
import { cfg } from '../config'
import type { Candle } from '../types'
import { WallexRest } from '../wallex/rest'
import { findSetup } from './detect'
import { defaultDetectParams, type DetectParams, type SetupCandidate, type SetupModel } from './types'

const FEES = { maker: cfg.makerFee, taker: cfg.takerFee, slip: 0.001 }
const MODELS: SetupModel[] = ['sweep', 'continuation']

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

const args = (name: string) => process.argv.flatMap((a, i) => (a === `--${name}` && process.argv[i + 1] ? [process.argv[i + 1]!] : []))

export function parseParams(overrides: string[], model?: string): Partial<DetectParams> {
  const out: Record<string, unknown> = {}
  for (const o of overrides) {
    const eq = o.indexOf('=')
    if (eq < 0) throw new Error(`bad --param ${o}, expected key=value`)
    const key = o.slice(0, eq)
    const raw = o.slice(eq + 1)
    if (!(key in defaultDetectParams)) throw new Error(`unknown param ${key}`)
    const def = (defaultDetectParams as unknown as Record<string, unknown>)[key]
    if (Array.isArray(def)) out[key] = raw.split(',').filter(Boolean).map((x) => (typeof def[0] === 'number' ? Number(x) : x))
    else if (typeof def === 'boolean') out[key] = raw === 'true' || raw === '1'
    else out[key] = Number(raw)
  }
  if (model && model !== 'both') {
    if (!MODELS.includes(model as SetupModel)) throw new Error(`--model must be sweep, continuation or both`)
    out.models = [model]
  }
  return out as Partial<DetectParams>
}

const key = (s: SetupCandidate) => [s.symbol, s.model, s.sweep.t, s.mss.t, s.fvg.t, s.entry, s.stop].join('|')

// Net of fees: maker in, maker out at tp1, taker plus slippage out at the stop.
export function netRr(entry: number, stop: number, tp1: number): number {
  const cost = entry * (1 + FEES.maker)
  return (tp1 * (1 - FEES.maker) - cost) / (cost - stop * (1 - FEES.taker - FEES.slip))
}

function walkOutcome(s: SetupCandidate, bars: Candle[], from: number) {
  const net = netRr(s.entry, s.stop, s.tp1)
  let filled = false
  for (let i = from; i < bars.length; i++) {
    const b = bars[i]!
    if (!filled) {
      if (b.t > s.expiresAt || b.c < s.invalidateBelow) return { fill: false, result: 'unfilled' as const, r: 0, rNet: 0 }
      if (b.l <= s.entry) filled = true
      else continue
    }
    if (b.l <= s.stop) return { fill: true, result: 'stop' as const, r: -1, rNet: -1 }
    if (b.h >= s.tp1) return { fill: true, result: 'tp1' as const, r: (s.tp1 - s.entry) / (s.entry - s.stop), rNet: net }
  }
  return { fill: filled, result: filled ? ('open' as const) : ('unfilled' as const), r: 0, rNet: 0 }
}

async function main() {
  const symbols = (arg('symbols') ?? cfg.symbols.join(',')).split(',').map((x) => x.trim()).filter(Boolean)
  const days = Number(arg('days') ?? 7)
  const walk = process.argv.includes('--walk')
  const params = parseParams(args('param'), arg('model'))
  const rest = new WallexRest()
  const to = Math.floor(Date.now() / 1000)
  const from = to - days * 86_400

  const all: { s: SetupCandidate; out?: ReturnType<typeof walkOutcome> }[] = []
  for (const symbol of symbols) {
    const bars = await loadCandles(rest, symbol, from, to)
    const seen = new Map<string, { s: SetupCandidate; idx: number }>()
    const t0 = performance.now()
    let calls = 0
    for (let i = 0; i < bars.length; i++) {
      calls++
      const s = findSetup(symbol, bars.slice(Math.max(0, i - 3999), i + 1), params)
      if (s && !seen.has(key(s))) seen.set(key(s), { s, idx: i })
    }
    const ms = (performance.now() - t0) / Math.max(1, calls)
    const list = [...seen.values()]
    const perModel = MODELS.map((m) => `${m}=${list.filter((x) => x.s.model === m).length}`).join(' ')
    console.log(`${symbol}: ${bars.length} bars, ${list.length} setups (${perModel}), ${(list.length / days).toFixed(2)}/day, ${ms.toFixed(2)} ms/call`)
    if (!process.argv.includes('--quiet')) console.log(JSON.stringify(list.slice(0, 5).map((x) => x.s), null, 2))
    for (const x of list) all.push({ s: x.s, out: walk ? walkOutcome(x.s, bars, x.idx + 1) : undefined })
  }

  console.log(`TOTAL: ${all.length} setups over ${symbols.length} symbols, ${days}d: ${(all.length / days).toFixed(2)}/day, ${MODELS.map((m) => `${m}=${all.filter((x) => x.s.model === m).length}`).join(' ')}`)
  const gates = [1.5, 2].map((g) => `net RR>=${g}: ${all.filter((x) => netRr(x.s.entry, x.s.stop, x.s.tp1) >= g).length}`)
  console.log(`gates (maker ${FEES.maker * 100}% in/out, stop taker ${FEES.taker * 100}% + ${FEES.slip * 100}% slip): ${gates.join(', ')}`)
  if (walk) {
    const sum = (rows: typeof all) => {
      const o = rows.map((x) => x.out!)
      const filled = o.filter((r) => r.fill)
      return `setups=${rows.length} filled=${filled.length} tp1=${o.filter((r) => r.result === 'tp1').length} stop=${o.filter((r) => r.result === 'stop').length} open=${o.filter((r) => r.result === 'open').length} grossR=${filled.reduce((a, r) => a + r.r, 0).toFixed(2)} netR=${filled.reduce((a, r) => a + r.rNet, 0).toFixed(2)}`
    }
    console.log(`walk all: ${sum(all)} (stop wins ties, tp1 only, no time stop)`)
    for (const m of MODELS) console.log(`walk ${m}: ${sum(all.filter((x) => x.s.model === m))}`)
    for (const g of [1.5, 2]) console.log(`walk net RR>=${g}: ${sum(all.filter((x) => netRr(x.s.entry, x.s.stop, x.s.tp1) >= g))}`)
  }
}

if (import.meta.main) await main()
