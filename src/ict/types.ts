import { DEFAULTS } from '../settings/defaults'
import type { Candle } from '../types'

// A long-only ICT setup found on closed candles. All times are unix seconds, all prices are quote-asset prices.
export type SetupModel = 'sweep' | 'continuation'

export interface SetupCandidate {
  symbol: string
  model: SetupModel // 'sweep' = sell-side sweep + MSS (Model A). 'continuation' = BOS + pullback (Model E; sweep.kind is 'impulse-low', sweep.extreme is the impulse low)
  detectedAt: number // time of the last closed 1m bar the detector saw
  entry: number // limit buy price (FVG consequent encroachment, or OTE inside the FVG)
  stop: number // below the swept low, with buffer
  tp1: number // next liquidity pool above entry
  tp2?: number
  score: number
  scoreParts: Record<string, number>
  sweep: { level: number; kind: string; extreme: number; t: number }
  mss: { level: number; t: number; displacementAtr: number }
  fvg: { low: number; high: number; ce: number; t: number }
  dealingRange: { low: number; high: number }
  expiresAt: number // cancel the pending entry after this time
  invalidateBelow: number // cancel if a bar closes below this
  rationale: string // one or two sentences a human can read in the decision log
}

export interface DetectParams {
  swingN: number
  minFvgAtr: number
  displacementAtr: number
  minSweepDepthPct: number
  oteLow: number
  oteHigh: number
  stopBufferAtr: number
  minStopPct: number
  maxStopPct: number
  setupMaxAgeBars1m: number
  minScore: number
  models: SetupModel[] // which models to run
  minGrossRr: number // tp1 must give at least this gross reward:risk
  scanTimeframes: (1 | 5 | 15)[] // timeframes (minutes) the sweep and continuation scans run on
  continuationMaxPullbackBars: number // max scan-timeframe bars between the BOS candle and now
  shortSwingLevels: boolean // also treat 15m swing lows (n=swingN) and 5m swing lows (n=2) as rank-0 sweep levels and targets
  freshnessUseClose: boolean // true: a zone is mitigated only when a 1m bar closes below it. false: a wick below it is enough
  atrPeriod: number // bars in the simple-average ATR
  atrFloorPct: number // ATR is never taken below this fraction of price
  bodyRatio: number // a displacement body must be at least this fraction of its candle range
  eqlTolPct: number // equal highs/lows: max price gap as a fraction of price...
  eqlTolAtr: number // ...or this many ATRs, whichever is larger
  max1mBars: number // the detector looks at most this many recent 1m bars
  minBars1m: number // fewer 1m bars than this: no setup
  window1m: number // bars kept per scan timeframe (1m, 5m, 15m) and for the 1H bias/levels
  window5m: number
  window15m: number
  window1h: number
  legMax1m: number // max bars between sweep and structure shift, per scan timeframe
  legMax5m: number
  legMax15m: number
  mssRefBack: number // the swing high broken by the MSS may be at most this many scan bars before the sweep
  bosRefBack: number // the swing high broken by a continuation BOS may be at most this many scan bars back
  htfBiasBars: number // 1H bars averaged for the bullish bias check
  sessionStartHour: number // UTC hour (inclusive) from which a setup earns the session point
  sessionEndHour: number // UTC hour (exclusive) at which the session point ends
  strongDisplacementAtr: number // displacement of at least this many ATR earns the displacement point
  deepDiscountPos: number // entry at or below this position in the dealing range (0 low, 1 high) earns the deep-discount point
  strongRr: number // gross RR of at least this earns the rr3 point
}

// Values live in src/settings/defaults.ts (the single source of truth). Copy so callers cannot mutate the defaults.
export const defaultDetectParams: DetectParams = structuredClone(DEFAULTS.detect)

// Pure function. Uses only closed candles from `bars1m` (ascending, last bar is closed). Aggregates to 5m, 15m, 1H internally.
// Returns null when there is no valid setup. Must not look ahead.
export type FindSetup = (symbol: string, bars1m: Candle[], params?: Partial<DetectParams>) => SetupCandidate | null
