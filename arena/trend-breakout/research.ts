// Offline research on TRAIN days 0:80 only (hard-capped below). Not part of the strategy.
import { existsSync, readFileSync } from 'node:fs'
import { aggregate } from '../../src/data/candles'
import type { Candle } from '../../src/types'

const DAY = 86400
const END = Date.parse('2026-10-22T00:00:00Z') / 1000
export const START = END - 180 * DAY
export const SYMS = ['PEPETMN', 'PUMPTMN', 'USOONTMN', 'BNBTMN', 'ETHTMN', 'XRPTMN', 'ARBTMN', 'DOGETMN', 'ADATMN', 'STMN', 'SOLTMN', 'APETMN', 'TRXTMN', 'LTCTMN', 'AAVETMN']

export function load(from: number, to: number, minutes = 60) {
  const cap = START + 80 * DAY // research window hard cap: train days 0:80
  if (to > cap) throw new Error('research is capped at train day 80')
  const out: Record<string, Candle[]> = {}
  for (const s of SYMS) {
    const bars: Candle[] = []
    for (let d = Math.floor(from / DAY) * DAY; d < to; d += DAY) {
      const f = `data/candles/${s}/${d}.json`
      if (!existsSync(f)) continue
      for (const b of JSON.parse(readFileSync(f, 'utf8')) as Candle[]) if (b.t >= from && b.t < to) bars.push(b)
    }
    out[s] = aggregate(bars, minutes)
  }
  return out
}

if (import.meta.main) {
  const d = load(START, START + 80 * DAY)
  for (const s of SYMS) {
    const h = d[s]!
    const wk: string[] = []
    for (let w = 0; w < 11; w++) {
      const a = h[w * 168]
      const b = h[Math.min(h.length - 1, (w + 1) * 168)]
      if (a && b) wk.push(((b.c / a.c - 1) * 100).toFixed(0))
    }
    console.log(s.padEnd(9), h.length, ((h.at(-1)!.c / h[0]!.c - 1) * 100).toFixed(1).padStart(7), wk.join(' '))
  }
}
