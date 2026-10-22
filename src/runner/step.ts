import type { Candle, Exchange, Strategy } from '../types'
import type { Log } from '../log'

export async function stepStrategy(strategy: Strategy, ex: Exchange, symbol: string, bars: Candle[], log: Log) {
  const t0 = performance.now()
  const orders = await strategy.onBar({ symbol, bars, ex })
  for (const o of orders) {
    log('order.intent', { ...o, bar: bars[bars.length - 1]?.t })
    const ack = await ex.place(o)
    log('order.ack', { ...ack, mode: ex.mode, decisionMs: Math.round(performance.now() - t0) })
  }
}
