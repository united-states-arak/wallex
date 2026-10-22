import type { Strategy } from '../types'
import { createIctStrategy } from './ict'

export { createIctStrategy }

// Placeholder that never places an order.
export const noop: Strategy = { name: 'noop', onBar: () => [] }

// `ict` is built without market meta, so the CLI should call createIctStrategy({ meta, guard, supervisor, log }) instead.
export const strategies: Record<string, Strategy> = { noop, ict: createIctStrategy() }
