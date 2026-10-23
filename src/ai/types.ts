// A trade the deterministic strategy wants to open. Every strategy fills the common fields; strategy-specific evidence goes
// in `features` (breakout) or the ICT fields (sweep, mss, fvg), so one supervisor reviews any strategy.
export interface TradeCandidate {
  symbol: string
  model: string
  entry: number
  stop: number
  tp1?: number
  score?: number
  rationale: string
  features?: Record<string, unknown>
  sweep?: { kind: string; level: number; extreme: number; [k: string]: unknown }
  mss?: { level: number; displacementAtr: number; [k: string]: unknown }
  fvg?: { low: number; high: number; [k: string]: unknown }
}

export interface NewsItem {
  title: string
  source: string
  publishedAt: string
  url: string
}

export interface NewsDigest {
  fetchedAt: string
  fearGreed: { value: number; label: string } | null
  trending: string[]
  headlines: NewsItem[]
}

export interface ReviewInput {
  setup: TradeCandidate
  equityTmn: number
  proposedNotionalTmn: number
  proposedPctOfEquity: number
  openPositions: { symbol: string; notionalTmn: number }[]
  dayPnlPct: number
  usdtTmn?: number
}

export interface Verdict {
  action: 'approve' | 'veto' | 'resize'
  sizeMult: number // 0 to 1. The AI can shrink a position, never grow it.
  reason: string
  source: 'ai' | 'fallback'
  model: string
  latencyMs: number
  toolCalls?: string[]
}

export interface Supervisor {
  review(input: ReviewInput): Promise<Verdict>
  refreshNews(): Promise<NewsDigest | null>
  close?(): Promise<void>
}
