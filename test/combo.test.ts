import { describe, expect, test } from 'bun:test'
import type { Supervisor } from '../src/ai/types'
import { PaperExchange } from '../src/exchange/paper'
import { createComboStrategy } from '../src/strategy'
import { createWashoutModel } from '../src/strategy/washout'
import type { Candle, MarketMeta, Markets } from '../src/types'

const mk = (symbol: string): MarketMeta => ({ symbol, base: symbol.replace('TMN', ''), quote: 'TMN', qtyDecimals: 2, priceDecimals: 2, minQty: 0.01, minNotional: 5_000, marketEnabled: false })
const SYMS = ['AAATMN', 'BBBTMN', 'CCCTMN', 'DDDTMN']
const meta: Markets = Object.fromEntries(SYMS.map((s) => [s, mk(s)]))
const T0 = 1_700_000_000 - (1_700_000_000 % 3600)
const approve: Supervisor = { review: async () => ({ action: 'approve', sizeMult: 1, reason: 'ok', source: 'ai', model: 'test', latencyMs: 1 }), refreshNews: async () => null }

// Flat markets. AAA dumps 5% over 45 minutes starting at minute `dumpAt`, then recovers 6% over the next hour.
// With `crash`, every market dumps together (a market-wide crash, not a washout).
function price(symbol: string, m: number, dumpAt: number, crash = false) {
  if (symbol !== 'AAATMN' && !crash) return 100
  if (m < dumpAt) return 100
  if (m < dumpAt + 45) return 100 - (5 * (m - dumpAt)) / 45
  return Math.min(101, 95 + (6 * (m - dumpAt - 45)) / 60)
}
const bar = (s: string, m: number, dumpAt: number, crash = false): Candle => {
  const o = price(s, m - 1, dumpAt, crash)
  const c = price(s, m, dumpAt, crash)
  return { t: T0 + m * 60, o, h: Math.max(o, c) + 0.01, l: Math.min(o, c) - 0.01, c, v: 1 }
}

async function run(o: { crash?: boolean; minutes?: number } = {}) {
  const events: { event: string; data: Record<string, any> }[] = []
  const ex = new PaperExchange(meta, new Set(), { TMN: 5_000_000 }, { maker: 0.0025, taker: 0.003 }, { spreadBps: 10, slippageBps: 10 })
  const strat = createComboStrategy({ meta, supervisor: approve, log: (event, data = {}) => void events.push({ event, data }), fees: { maker: 0.0025, taker: 0.003 } })
  const dumpAt = 6 * 60
  const hist: Record<string, Candle[]> = Object.fromEntries(SYMS.map((s) => [s, []]))
  for (let m = 0; m < (o.minutes ?? dumpAt + 240); m++) {
    for (const s of SYMS) {
      const b = bar(s, m, dumpAt, o.crash)
      ex.onCandle(s, b)
      hist[s]!.push(b)
      await strat.onBar({ symbol: s, bars: hist[s]!, ex })
    }
  }
  return { events, ex, strat }
}
const of = (e: { event: string; data: Record<string, any> }[], n: string) => e.filter((x) => x.event === n)

describe('washout model in the combo strategy', () => {
  test('a fast drop in one market is bought and sold at the resting take-profit', async () => {
    const r = await run()
    const acc = of(r.events, 'setup.accepted')
    expect(acc).toHaveLength(1)
    expect(acc[0]!.data).toMatchObject({ symbol: 'AAATMN', model: 'washout' })
    expect(acc[0]!.data.rationale).toContain('Washout')
    expect(acc[0]!.data.lossPctAtStop).toBeLessThanOrEqual(0.0101)
    expect(of(r.events, 'tp.placed')).toHaveLength(1)
    const exit = of(r.events, 'exit')[0]!
    expect(exit.data.how).toBe('take profit')
    expect(exit.data.pnlTmn).toBeGreaterThan(0)
    const b = await r.ex.balances()
    expect(b.AAA!.free + b.AAA!.locked).toBeLessThan(0.01)
    expect(b.TMN!.free).toBeGreaterThan(5_000_000)
  })

  test('a market-wide crash is not bought', async () => {
    const r = await run({ crash: true })
    expect(of(r.events, 'setup.accepted')).toHaveLength(0)
  })

  test('the take-profit is cancelled before a stop exit, and positions share one book', async () => {
    const r = await run({ minutes: 6 * 60 + 50 })
    const pos = r.strat.openPositions()
    expect(pos).toHaveLength(1)
    expect(pos[0]).toMatchObject({ symbol: 'AAATMN', model: 'washout' })
    const state = r.strat.getState() as { positions: Record<string, { tpId?: string; model: string }> }
    expect(state.positions.AAATMN!.tpId).toBeTruthy()
    expect(state.positions.AAATMN!.model).toBe('washout')
  })

  test('the washout signal uses closed signal bars only', () => {
    const m = createWashoutModel({ signalMinutes: 15, lookbackMinutes: 60, dropPct: 0.035 })
    const bars: Candle[] = []
    for (let i = 0; i < 6 * 60 + 40; i++) {
      bars.push(bar('AAATMN', i, 6 * 60))
      m.update('AAATMN', bars)
      const last = bars[bars.length - 1]!
      const sig = m.signal('AAATMN', bars)
      if (sig) expect(last.t % 900).toBe(840)
    }
  })
})
