// The production default strategy exactly as it ships (src/strategy, combo = breakout + washout in one position book, risk
// guard with profit locks, mock AI as in every backtest). ARENA_WASHOUT_RISK overrides strategy.washout.riskMult.
import { createMockSupervisor } from '../../src/ai/mock'
import { withGuardFeed, type StatefulStrategy } from '../../src/daemon'
import { nullLog } from '../../src/log'
import { createGuard } from '../../src/risk/guard'
import { createBreakoutModel } from '../../src/strategy/breakout'
import { createTradeEngine } from '../../src/strategy/engine'
import { createWashoutModel } from '../../src/strategy/washout'
import type { Markets } from '../../src/types'

export default function create(ctx: { meta: Markets; startTmn: number }) {
  const guard = createGuard({ startEquity: ctx.startTmn, limits: { killFile: '' } })
  const riskMult = process.env.ARENA_WASHOUT_RISK ? Number(process.env.ARENA_WASHOUT_RISK) : undefined
  const engine = createTradeEngine('combo', [createBreakoutModel(), createWashoutModel(riskMult ? { riskMult } : {})], { guard, supervisor: createMockSupervisor(), log: nullLog, meta: ctx.meta })
  return withGuardFeed(engine as StatefulStrategy, guard, ctx.meta)
}
