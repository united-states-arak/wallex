// Offline research tool (train window only): runs the incumbent detector every 5 minutes per symbol and writes each new setup to a JSONL file.
import '../env'
import { writeFileSync } from 'node:fs'
import { loadCandles } from '../../src/data/candles'
import { findSetup } from '../../src/ict/detect'
import { getSettings } from '../../src/settings'
import type { Candle } from '../../src/types'
import { WallexRest } from '../../src/wallex/rest'

const DAY = 86_400
const END = Date.parse('2026-10-22T00:00:00Z') / 1000
const START = END - 180 * DAY
const SPLIT = START + 120 * DAY
const SYMBOLS = ['PEPETMN', 'PUMPTMN', 'USOONTMN', 'BNBTMN', 'ETHTMN', 'XRPTMN', 'ARBTMN', 'DOGETMN', 'ADATMN', 'STMN', 'SOLTMN', 'APETMN', 'TRXTMN', 'LTCTMN', 'AAVETMN']
const out = process.argv[2] ?? 'arena/ict-plus/setups.jsonl'
const sym = process.argv[3] ? process.argv[3].split(',') : SYMBOLS
const params = process.env.DETECT ? JSON.parse(process.env.DETECT) : undefined
const rest = new WallexRest()
const maxHistory = getSettings().data.historyBars
const rows: string[] = []
for (const symbol of sym) {
  const bars: Candle[] = await loadCandles(rest, symbol, START - 3 * DAY, SPLIT)
  const hist: Candle[] = []
  const seen = new Set<string>()
  for (const c of bars) {
    hist.push(c)
    if (hist.length > maxHistory) hist.shift()
    if (c.t < START || (c.t + 60) % 300 !== 0) continue
    const s = findSetup(symbol, hist, params)
    if (!s) continue
    const key = `${s.sweep.t}:${s.fvg.t}`
    if (seen.has(key)) continue
    seen.add(key)
    rows.push(JSON.stringify({ ...s, t: c.t, day: (c.t - START) / DAY }))
  }
  console.error(symbol, rows.length)
}
writeFileSync(out, rows.join('\n') + '\n')
