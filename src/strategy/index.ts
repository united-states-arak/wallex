import type { Strategy } from '../types'
import { createBreakoutModel, createBreakoutStrategy } from './breakout'
import { createTradeEngine, type EngineDeps, type TradeEngine } from './engine'
import { createIctStrategy } from './ict'
import { createWashoutModel } from './washout'

export { createBreakoutStrategy, createIctStrategy }

// The default: trend breakouts plus washout bounces in one position book (breakout has priority on each bar).
export function createComboStrategy(deps: EngineDeps): TradeEngine {
  return createTradeEngine('combo', [createBreakoutModel(), createWashoutModel()], deps)
}

// Placeholder that never places an order.
export const noop: Strategy = { name: 'noop', onBar: () => [] }

// `ict` is built without market meta, so the CLI should call createIctStrategy({ meta, guard, supervisor, log }) instead.
export const strategies: Record<string, Strategy> = { noop, ict: createIctStrategy() }
