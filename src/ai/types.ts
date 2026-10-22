import type { SetupCandidate } from '../ict/types'

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
  setup: SetupCandidate
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
