// Runs several arena strategies on one account. Each market belongs to the strategy that bought it until that position is
// closed, and the shared limit of 2 open positions plus pending entries is enforced across all of them. Strategies are
// asked in order on every bar, so the first one listed has priority. ARENA_ENSEMBLE=production-breakout,ict-plus
import type { Exchange, Markets, OrderAck, OrderReq, Strategy } from '../../src/types'

const PATHS: Record<string, string> = {
  'production-breakout': './production-breakout.ts',
  'trend-breakout': '../trend-breakout/strategy.ts',
  'ict-plus': '../ict-plus/strategy.ts',
  'mean-reversion': '../mean-reversion/strategy.ts',
  'rotation-momentum': '../rotation-momentum/strategy.ts',
}
const MAX_POSITIONS = 2

export default async function create(ctx: { meta: Markets; startTmn: number; symbols: string[] }): Promise<Strategy> {
  const names = (process.env.ARENA_ENSEMBLE ?? 'production-breakout,ict-plus').split(',').map((s) => s.trim())
  const subs: Strategy[] = []
  for (const n of names) {
    const p = PATHS[n]
    if (!p) throw new Error(`unknown ensemble member ${n}`)
    subs.push(await (await import(p)).default(ctx))
  }
  const owner = new Map<string, number>()

  const busy = async (ex: Exchange, symbol: string) => {
    const m = ctx.meta[symbol]
    if (!m) return false
    if ((await ex.openOrders(symbol)).length > 0) return true
    const b = (await ex.balances())[m.base]
    if (!b) return false
    const q = await ex.quote(symbol).catch(() => null)
    return (b.free + b.locked) * (q?.bid ?? 0) >= m.minNotional
  }

  const wrap = (ex: Exchange, i: number): Exchange => ({
    get mode() {
      return ex.mode
    },
    balances: () => ex.balances(),
    quote: (s) => ex.quote(s),
    openOrders: (s) => ex.openOrders(s),
    cancel: (id) => ex.cancel(id),
    async place(o: OrderReq): Promise<OrderAck> {
      if (o.side === 'BUY') {
        const refuse = (error: string): OrderAck => ({ clientId: o.clientId, status: 'REJECTED', error })
        const mine = await busy(ex, o.symbol)
        const own = owner.get(o.symbol)
        if (mine && own !== undefined && own !== i) return refuse('market held by another strategy')
        if (!mine) {
          let active = 0
          for (const s of ctx.symbols) if (await busy(ex, s)) active++
          if (active >= MAX_POSITIONS) return refuse('shared position limit')
        }
        owner.set(o.symbol, i)
      }
      return ex.place(o)
    },
  })

  return {
    name: names.join('+'),
    async onBar(c) {
      for (let i = 0; i < subs.length; i++) {
        const orders = await subs[i]!.onBar({ ...c, ex: wrap(c.ex, i) })
        for (const o of orders) await wrap(c.ex, i).place(o)
      }
      return []
    },
  }
}
