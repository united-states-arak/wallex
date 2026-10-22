import { PaperExchange } from '../exchange/paper'
import type { Log } from '../log'
import { pullout } from '../pullout'
import type { Candle, Markets, Strategy } from '../types'
import { getSettings } from '../settings'
import { stepStrategy } from './step'

export interface BacktestSummary {
  strategy: string
  symbols: string[]
  bars: number
  startTmn: number
  endTmn: number
  returnPct: number
  fills: number
  volumeTmn: number
  feesTmn: number
  maxDrawdownPct: number
}

// Same strategy code and same exchange rules as shadow mode. An order placed on bar i can only fill from bar i+1.
export async function runBacktest(o: {
  bars: Record<string, Candle[]>
  meta: Markets
  blocked: Set<string>
  strategy: Strategy
  log: Log
  startTmn?: number
}): Promise<BacktestSummary> {
  const startTmn = o.startTmn ?? getSettings().paper.startTmn
  const ex = new PaperExchange(o.meta, o.blocked, { TMN: startTmn })
  const feed = Object.entries(o.bars)
    .flatMap(([symbol, list]) => list.map((c) => ({ symbol, c })))
    .sort((a, b) => a.c.t - b.c.t || a.symbol.localeCompare(b.symbol))

  const history: Record<string, Candle[]> = {}
  const maxHistory = getSettings().data.historyBars
  let peak = startTmn
  let maxDd = 0
  for (const { symbol, c } of feed) {
    ex.onCandle(symbol, c)
    const h = (history[symbol] ??= [])
    h.push(c)
    if (h.length > maxHistory) h.shift()
    await stepStrategy(o.strategy, ex, symbol, h, o.log)
    const eq = ex.equity()
    peak = Math.max(peak, eq)
    maxDd = Math.max(maxDd, (peak - eq) / peak)
  }

  const report = await pullout(ex, o.meta, { execute: true, waitMs: 0, log: o.log })
  const endTmn = (await ex.balances()).TMN?.free ?? 0
  const volumeTmn = ex.fills.reduce((s, f) => s + f.price * f.qty, 0)
  const feesTmn = ex.fills.reduce((s, f) => s + f.fee, 0)
  const summary: BacktestSummary = {
    strategy: o.strategy.name,
    symbols: Object.keys(o.bars),
    bars: feed.length,
    startTmn,
    endTmn,
    returnPct: ((endTmn - startTmn) / startTmn) * 100,
    fills: ex.fills.length,
    volumeTmn,
    feesTmn,
    maxDrawdownPct: maxDd * 100,
  }
  o.log('backtest.summary', { ...summary, leftover: report.remaining.length })
  return summary
}
