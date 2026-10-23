import { getSettings } from '../settings'
import type { PaperExchange } from '../exchange/paper'
import type { Log } from '../log'
import type { Candle, Exchange, Strategy } from '../types'
import type { WallexRest } from '../wallex/rest'
import { loadCandles } from '../data/candles'
import { stepStrategy } from './step'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// Sleeps in short slices so a stop request is noticed quickly.
async function sleepUnless(ms: number, stop?: () => boolean) {
  if (!stop) return sleep(ms)
  const until = Date.now() + ms
  while (!stop() && Date.now() < until) await sleep(Math.min(500, until - Date.now()))
}

// Live-data loop shared by shadow mode (PaperExchange) and dry run (DryExchange).
export async function runPoll(o: {
  rest: Pick<WallexRest, 'history'>
  symbols: string[]
  strategy: Strategy
  ex: Exchange
  log: Log
  durationMs: number
  pollMs: number | (() => number)
  once?: boolean
  paper?: PaperExchange
  onCycle?: () => Promise<void>
  // Optional serializer so bar handling does not interleave with other callers of the strategy.
  exclusive?: <T>(fn: () => Promise<T>) => Promise<T>
  shouldStop?: () => boolean
}) {
  const nowSec = () => Math.floor(Date.now() / 1000)
  const S = getSettings()
  const warmupSec = Math.round(S.wallex.warmupHours * 3600)
  const maxHistory = S.data.historyBars
  const history: Record<string, Candle[]> = {}
  const lastT: Record<string, number> = {}

  const primeDays = o.strategy.prime ? (o.strategy.primeDays ?? 0) : 0
  for (const symbol of o.symbols) {
    let bars: Candle[]
    if (primeDays > 0) {
      // Long warm-up, one UTC day per request (Wallex refuses longer 1m ranges); complete days come from the local cache.
      const all = (await loadCandles(o.rest, symbol, nowSec() - Math.round(primeDays * 86_400), nowSec())).filter((c) => c.t + 60 <= nowSec())
      o.strategy.prime!(symbol, all)
      bars = all.slice(-maxHistory)
    } else bars = (await o.rest.history(symbol, nowSec() - warmupSec, nowSec())).filter((c) => c.t + 60 <= nowSec())
    history[symbol] = bars
    lastT[symbol] = bars[bars.length - 1]?.t ?? 0
    for (const c of bars) o.paper?.onCandle(symbol, c)
    o.log('poll.warmup', { symbol, bars: bars.length, primeDays })
  }

  const end = Date.now() + o.durationMs
  do {
    for (const symbol of o.symbols) {
      if (o.shouldStop?.()) break
      try {
        // A market with no warm-up bars has lastT 0, and a long outage leaves it far behind; Wallex answers no_data to ranges over
        // about 1.5 days, which would stall the market for good, so never ask for more than the warm-up window.
        const from = Math.max(lastT[symbol]! - 60, nowSec() - Math.max(warmupSec, 3600))
        const fresh = (await o.rest.history(symbol, from, nowSec())).filter(
          (c) => c.t > lastT[symbol]! && c.t + 60 <= nowSec(),
        )
        for (const c of fresh) {
          o.paper?.onCandle(symbol, c)
          const h = history[symbol]!
          h.push(c)
          if (h.length > maxHistory) h.shift()
          lastT[symbol] = c.t
          const step = () => stepStrategy(o.strategy, o.ex, symbol, h, o.log)
          await (o.exclusive ? o.exclusive(step) : step())
        }
      } catch (e) {
        o.log('poll.error', { symbol, error: String(e) })
      }
    }
    await o.onCycle?.()
    if (o.once) break
    await sleepUnless(typeof o.pollMs === 'function' ? o.pollMs() : o.pollMs, o.shouldStop)
  } while (Date.now() < end && !o.shouldStop?.())
}
