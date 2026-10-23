// Manual check of the AI supervisor against the configured provider, with live news: bun src/ai/try.ts
// Reviews a sample breakout candidate shaped exactly like the ones the strategy sends (see src/strategy/breakout).
import { createSupervisor } from './supervisor'
import type { ReviewInput } from './types'

const entry = 41_260
const stop = 39_550
const input: ReviewInput = {
  setup: {
    symbol: 'ARBTMN',
    model: 'breakout',
    entry,
    stop,
    rationale:
      '96h breakout: the 1h close 41,230 is above the 96h high 40,900 on 1.8x average volume, price is above its rising 96h EMA (39,800) and 80% of markets are above their 168h EMA. Initial stop 4 ATR below (39,550), trailing stop 8 ATR below the highest high.',
    features: { breakoutLevel: 40_900, hourClose: 41_230, atr: 420, trendEma: 39_800, volumeVsAverage: 1.8, marketBreadthPct: 80, stopDistancePct: 4.14, initialStopAtr: 4, trailingStopAtr: 8 },
  },
  equityTmn: 5_000_000,
  proposedNotionalTmn: 1_034_000,
  proposedPctOfEquity: 0.207,
  openPositions: [],
  dayPnlPct: 0,
}

const supervisor = createSupervisor({ log: (event, data) => console.log(event, JSON.stringify(data)) })
const news = await supervisor.refreshNews()
console.log('news', news ? { fearGreed: news.fearGreed, trending: news.trending, headlines: news.headlines.length } : null)
const verdict = await supervisor.review(input)
console.log(JSON.stringify(verdict, null, 2))
await supervisor.close?.()
