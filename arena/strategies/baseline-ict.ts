// The incumbent: the production ICT strategy exactly as it ships (mock AI, its own risk guard). The bar to beat.
import { createMockSupervisor } from '../../src/ai/mock'
import { withGuardFeed, type StatefulStrategy } from '../../src/daemon'
import { nullLog } from '../../src/log'
import { createGuard } from '../../src/risk/guard'
import { createIctStrategy } from '../../src/strategy/ict'
import type { Markets } from '../../src/types'

export default function create(ctx: { meta: Markets; startTmn: number }) {
  const guard = createGuard({ startEquity: ctx.startTmn, limits: { killFile: '' } })
  const ict = createIctStrategy({ guard, supervisor: createMockSupervisor(), log: nullLog, meta: ctx.meta }) as StatefulStrategy
  return withGuardFeed(ict, guard, ctx.meta)
}
