import { getSettings } from '../../settings'
import type { Candle } from '../../types'
import { createTradeEngine, type EngineDeps, type EngineOptions, type SignalModel, type TradeEngine } from '../engine'
import { HourlyTracker, type BreakoutParams, type BreakoutSignal } from './tracker'

export { HourlyTracker, type BreakoutParams, type BreakoutSignal }

export interface BreakoutModelOptions extends BreakoutParams {
  warmupDays: number
}

// Trend breakout: a closed 1h bar breaks the 4-day high in an uptrend, on above-average volume, while most of the basket
// trends up (see tracker.ts). Exits: ATR initial stop, ATR trailing stop, time stop. No fixed target.
export function createBreakoutModel(options: Partial<BreakoutModelOptions> = {}): SignalModel {
  const p: BreakoutModelOptions = { ...getSettings().strategy.breakout, ...options }
  const tracker = new HourlyTracker(p)
  return {
    name: 'breakout',
    primeDays: p.warmupDays,
    prime: (symbol, bars) => tracker.prime(symbol, bars),
    update: (symbol, bars) => void tracker.update(symbol, bars),
    signal(symbol: string, bars: Candle[]) {
      const sig = tracker.signal(symbol, bars[bars.length - 1]!.c)
      if (!sig) return null
      return {
        model: 'breakout',
        entryRef: sig.entryRef,
        stop: sig.stop,
        timeStopBars: p.maxHoldHours * 60,
        rationale: sig.rationale,
        features: {
          breakoutLevel: sig.level,
          hourClose: sig.hourClose,
          atr: sig.atr,
          trendEma: sig.ema,
          volumeVsAverage: Number(sig.volumeRatio.toFixed(2)),
          marketBreadthPct: Math.round(sig.breadth * 100),
          initialStopAtr: p.stopAtr,
          trailingStopAtr: p.trailAtr,
        },
      }
    },
    trail: (symbol, high) => tracker.trail(symbol, high),
  }
}

export type BreakoutStrategy = TradeEngine

export interface BreakoutDeps extends EngineDeps {
  options?: Partial<EngineOptions & BreakoutModelOptions>
}

export function createBreakoutStrategy(deps: BreakoutDeps): TradeEngine {
  return createTradeEngine('breakout', [createBreakoutModel(deps.options)], deps)
}
