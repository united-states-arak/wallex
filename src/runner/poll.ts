import { getSettings } from '../settings'
import type { PaperExchange } from '../exchange/paper'
import type { Log } from '../log'
import type { Candle, Exchange, Strategy } from '../types'
import type { WallexRest } from '../wallex/rest'
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

  for (const symbol of o.symbols) {
    const bars = (await o.rest.history(symbol, nowSec() - warmupSec, nowSec())).filter((c) => c.t + 60 <= nowSec())
    history[symbol] = bars
    lastT[symbol] = bars[bars.length - 1]?.t ?? 0
    for (const c of bars) o.paper?.onCandle(symbol, c)
    o.log('poll.warmup', { symbol, bars: bars.length })
  }

  const end = Date.now() + o.durationMs
  do {
    for (const symbol of o.symbols) {
      if (o.shouldStop?.()) break
      try {
        const fresh = (await o.rest.history(symbol, lastT[symbol]! - 60, nowSec())).filter(
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
