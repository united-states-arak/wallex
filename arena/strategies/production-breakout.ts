// The production breakout strategy exactly as it ships in src/strategy/breakout (risk guard with profit-lock tiers,
// AI supervisor slot filled by the mock, as in every backtest). ARENA_PARITY=1 switches the profit locks off to compare
// like-for-like with the contestant's flat 1% risk.
import { createMockSupervisor } from '../../src/ai/mock'
import { withGuardFeed, type StatefulStrategy } from '../../src/daemon'
import { nullLog } from '../../src/log'
import { createGuard } from '../../src/risk/guard'
import { createBreakoutStrategy } from '../../src/strategy/breakout'
import type { Markets } from '../../src/types'

export default function create(ctx: { meta: Markets; startTmn: number }) {
  const parity = process.env.ARENA_PARITY === '1'
  const guard = createGuard({ startEquity: ctx.startTmn, limits: { killFile: '', ...(parity ? { lock1Pnl: Infinity, lock2Pnl: Infinity } : {}) } })
  const s = createBreakoutStrategy({ guard, supervisor: createMockSupervisor(), log: nullLog, meta: ctx.meta }) as StatefulStrategy
  return withGuardFeed(s, guard, ctx.meta)
}
