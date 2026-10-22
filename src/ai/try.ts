// Manual check: AI_BASE_URL=https://host/v1 AI_API_KEY=... AI_MODEL=... bun src/ai/try.ts
import { createSupervisor } from './supervisor'
import type { SetupCandidate } from '../ict/types'
import type { ReviewInput } from './types'

const nowSec = Math.floor(Date.now() / 1000)
const entry = 0.00001
const setup: SetupCandidate = {
  model: 'sweep',
  symbol: 'PEPETMN',
  detectedAt: nowSec,
  entry,
  stop: entry * 0.98,
  tp1: entry * 1.045,
  score: 7,
  scoreParts: { sweep: 2, mss: 2, fvg: 2, htfBias: 1 },
  sweep: { level: entry * 0.985, kind: 'equal-lows', extreme: entry * 0.981, t: nowSec - 600 },
  mss: { level: entry * 1.01, t: nowSec - 300, displacementAtr: 1.9 },
  fvg: { low: entry * 0.995, high: entry * 1.005, ce: entry, t: nowSec - 300 },
  dealingRange: { low: entry * 0.97, high: entry * 1.06 },
  expiresAt: nowSec + 3600,
  invalidateBelow: entry * 0.985,
  rationale: 'Sell-side liquidity swept below equal lows, displacement closed above the last swing high, entry at the FVG midpoint.',
}
const input: ReviewInput = {
  setup,
  equityTmn: 5_000_000,
  proposedNotionalTmn: 1_900_000,
  proposedPctOfEquity: 0.38,
  openPositions: [],
  dayPnlPct: 0,
}

const supervisor = createSupervisor({ log: (event, data) => console.log(event, JSON.stringify(data)) })
const news = await supervisor.refreshNews()
console.log('news', news ? { fearGreed: news.fearGreed, trending: news.trending, headlines: news.headlines.length } : null)
const verdict = await supervisor.review(input)
console.log(JSON.stringify(verdict, null, 2))
await supervisor.close?.()
