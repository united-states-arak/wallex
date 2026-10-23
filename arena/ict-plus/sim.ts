// Offline research simulator (train window only). Mirrors the arena fill rules on 1m bars for one setup at a time.
import '../env'
import { readFileSync } from 'node:fs'
import { loadCandles } from '../../src/data/candles'
import type { Candle } from '../../src/types'
import { WallexRest } from '../../src/wallex/rest'

export const DAY = 86_400
export const END = Date.parse('2026-10-22T00:00:00Z') / 1000
export const START = END - 180 * DAY
export const SPLIT = START + 120 * DAY
export const SYMBOLS = ['PEPETMN', 'PUMPTMN', 'USOONTMN', 'BNBTMN', 'ETHTMN', 'XRPTMN', 'ARBTMN', 'DOGETMN', 'ADATMN', 'STMN', 'SOLTMN', 'APETMN', 'TRXTMN', 'LTCTMN', 'AAVETMN']
export const MAKER = 0.0025
export const TAKER = 0.003
export const HALF = 0.0015

export interface Setup {
  symbol: string
  model: 'sweep' | 'continuation'
  entry: number
  stop: number
  tp1: number
  tp2?: number
  score: number
  scoreParts: Record<string, number>
  sweep: { level: number; kind: string; extreme: number; t: number }
  mss: { level: number; t: number; displacementAtr: number }
  fvg: { low: number; high: number; ce: number; t: number }
  dealingRange: { low: number; high: number }
  t: number
  day: number
}

export interface Cfg {
  expire: number // minutes to wait for fill
  tp1Frac: number // fraction sold at tp1
  tp2Mode: 'tp2' | 'tp1' | 'none' // where the rest goes
  be: boolean // move stop to entry*(1+beBuf) after tp1
  beBuf: number
  timeStop: number // bars, 0 = off
  timeStopOnlyBelow: boolean
  entryFn?: (s: Setup) => number
  stopFn?: (s: Setup, entry: number) => number
  tp1Fn?: (s: Setup, entry: number, stop: number) => number
  trailAfterTp1?: number // trail stop at high*(1-x) after TP1 (0 = off)
}

export const BASE: Cfg = { expire: 180, tp1Frac: 0.5, tp2Mode: 'tp2', be: true, beBuf: 0.006, timeStop: 240, timeStopOnlyBelow: true }

export interface Res {
  filled: boolean
  net: number // net return on notional (fees included)
  how: string
  hold: number
  entry: number
  stop: number
  size: number // fraction of equity
  eq: number // equity contribution = size * net
  tEnd: number
}

export function sim(bars: Candle[], idx: Map<number, number>, s: Setup, cfg: Cfg, tick: number): Res {
  const entry = cfg.entryFn ? cfg.entryFn(s) : s.entry
  const stop = cfg.stopFn ? cfg.stopFn(s, entry) : s.stop
  const tp1 = cfg.tp1Fn ? cfg.tp1Fn(s, entry, stop) : s.tp1
  const tp2 = cfg.tp2Mode === 'tp2' ? s.tp2 ?? tp1 : tp1
  const none: Res = { filled: false, net: 0, how: 'nofill', hold: 0, entry, stop, size: 0, eq: 0, tEnd: s.t }
  if (!(stop < entry && tp1 > entry)) return none
  const i0 = idx.get(s.t)
  if (i0 === undefined) return none
  let i = i0 + 1
  const expireT = s.t + cfg.expire * 60
  let fillI = -1
  for (; i < bars.length; i++) {
    const b = bars[i]!
    if (b.t > expireT) return { ...none, how: 'expired' }
    if (b.l <= entry - tick) {
      fillI = i
      break
    }
    if (b.c < stop) return { ...none, how: 'invalid' }
  }
  if (fillI < 0) return none
  const sc = stop / entry
  const costPer = 1 - sc + MAKER + sc * TAKER + 0.001
  const size = Math.min(0.5, 0.01 / costPer)
  const cost = entry * (1 + MAKER)
  let rem = 1
  let proceeds = 0
  let curStop = stop
  let tp1Done = false
  let stopFrom = fillI
  let high = entry
  const frac1 = cfg.tp1Frac
  const sellAt = (px: number, q: number, fee: number) => {
    proceeds += px * q * (1 - fee)
    rem -= q
  }
  const done = (how: string, k: number): Res => {
    const net = proceeds / cost - 1
    return { filled: true, net, how, hold: k - fillI, entry, stop, size, eq: size * net, tEnd: bars[k]!.t }
  }
  // fill bar: TPs are placed after the fill bar, so only the stop applies there
  for (let k = fillI; k < bars.length; k++) {
    const b = bars[k]!
    if (k > fillI) {
      // resting TP legs
      if (!tp1Done) {
        if (b.h >= tp1 + tick) {
          sellAt(tp1, frac1, MAKER)
          tp1Done = true
          if (cfg.be) curStop = Math.max(curStop, entry * (1 + cfg.beBuf))
          stopFrom = k + 1
          if (frac1 >= 1) return done('tp1', k)
          if (tp2 === tp1 && b.h >= tp1 + tick) {
            sellAt(tp1, rem, MAKER)
            return done('tp', k)
          }
        }
      }
      if (tp1Done && cfg.tp2Mode !== 'none' && b.h >= tp2 + tick && rem > 1e-12) {
        sellAt(tp2, rem, MAKER)
        return done('tp2', k)
      }
    }
    high = Math.max(high, b.h)
    if (tp1Done && cfg.trailAfterTp1) curStop = Math.max(curStop, high * (1 - cfg.trailAfterTp1))
    const hold = k - fillI
    let why = ''
    if (k >= stopFrom && b.l <= curStop) why = tp1Done ? 'be-stop' : 'stop'
    else if (cfg.timeStop && hold >= cfg.timeStop && (!cfg.timeStopOnlyBelow || b.c < entry)) why = 'time'
    if (why) {
      sellAt(b.c * (1 - HALF), rem, TAKER)
      return done(why, k)
    }
  }
  const lb = bars[bars.length - 1]!
  sellAt(lb.c * (1 - HALF), rem, TAKER)
  return done('end', bars.length - 1)
}

export async function load() {
  const rest = new WallexRest()
  const markets = await rest.markets()
  const bars: Record<string, Candle[]> = {}
  const idx: Record<string, Map<number, number>> = {}
  const tick: Record<string, number> = {}
  for (const s of SYMBOLS) {
    bars[s] = await loadCandles(rest, s, START - 3 * DAY, SPLIT)
    idx[s] = new Map(bars[s]!.map((c, i) => [c.t, i]))
    tick[s] = 10 ** -(markets[s]?.priceDecimals ?? 0)
  }
  return { bars, idx, tick }
}

export function readSetups(file = 'arena/ict-plus/setups.jsonl'): Setup[] {
  return readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
}
