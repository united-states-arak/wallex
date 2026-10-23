import type { DetectParams } from '../ict/types'

export type DeepPartial<T> = T extends readonly unknown[] ? T : T extends object ? { [K in keyof T]?: DeepPartial<T[K]> } : T

export interface LockTier {
  pnl: number
  riskPct: number
}

export interface NewsFeed {
  source: string
  url: string
}

export interface Settings {
  run: {
    end: string
    entryCutoffMin: number
    defaultHours: number
  }
  wallex: {
    baseUrl: string
    apiKey: string
    requestTimeoutMs: number
    pollMs: number
    tickMs: number
    warmupHours: number
  }
  fees: { maker: number; taker: number }
  paper: { spreadBps: number; slippageBps: number; startTmn: number }
  market: {
    symbols: string[]
    universe: {
      auto: boolean
      minVolTmn: number
      maxSpreadPct: number
      minRangePct: number
      max: number
      exclude: string[]
    }
    blockedFile: string
  }
  risk: {
    riskPct: number
    maxPositionPct: number
    slippagePct: number
    maxPositions: number
    dayLossHalt: number
    hardDrawdown: number
    lockTiers: LockTier[]
    killFile: string
    maxOrderTmn: number
    maxPriceDeviation: number
  }
  strategy: {
    active: 'combo' | 'breakout' | 'ict' | 'noop'
    washout: {
      signalMinutes: number
      lookbackMinutes: number
      dropPct: number
      takeProfitPct: number
      stopPct: number
      maxHoldMinutes: number
      crashDropPct: number
      crashBreadthMax: number
      riskMult: number
    }
    breakout: {
      lookbackHours: number
      emaHours: number
      atrHours: number
      stopAtr: number
      trailAtr: number
      volumeMult: number
      maxChaseAtr: number
      breadthMin: number
      breadthEmaHours: number
      maxHoldHours: number
      warmupDays: number
      entrySlip: number
      stopExitSlip: number
      stopExitSlipMax: number
    }
    ict: {
      maxSpreadPct: number
      minNetRr: number
      tp1Fraction: number
      timeStopBars: number
      stopExitSlip: number
      stopExitSlipMax: number
      breakEvenBuffer: number
    }
  }
  detect: DetectParams
  ai: {
    enabled: boolean
    baseUrl: string
    apiKey: string
    model: string
    timeoutMs: number
    failMode: 'approve' | 'veto'
    newsTtlMin: number
    newsTimeoutMs: number
    newsWaitMs: number
    feeds: NewsFeed[]
    fearGreedUrl: string
    trendingUrl: string
    maxHeadlines: number
    contextWindow: number
    instructionsFile: string
  }
  pullout: { slippageSteps: number[]; waitMs: number }
  research: { trainSplit: number; minTrainTrades: number; warmupHours: number; defaultDays: number }
  data: { dataDir: string; cacheCompleteAfterSec: number; historyBars: number }
  logging: { dir: string; stateDir: string }
  telemetry: { enabled: boolean; prometheusPort: number; prometheusHost: string; otlpEndpoint: string; otlpIntervalMs: number }
  dashboard: { host: string; port: number; root: string }
}

// Dotted paths of values that may only come from the environment.
export const SECRET_PATHS = ['wallex.apiKey', 'ai.apiKey'] as const
