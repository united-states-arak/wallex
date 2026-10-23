import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { getSettings } from '../settings'
import type { Candle } from '../types'
import type { WallexRest } from '../wallex/rest'

const DAY = 86_400

// Wallex returns `no_data` for 1m ranges over about 1.5 days, so fetch one UTC day at a time.
export async function loadCandles(rest: Pick<WallexRest, 'history'>, symbol: string, fromSec: number, toSec: number): Promise<Candle[]> {
  const out = new Map<number, Candle>()
  const { dataDir, cacheCompleteAfterSec } = getSettings().data
  const dir = `${dataDir}/candles/${symbol}`
  mkdirSync(dir, { recursive: true })
  const nowSec = Math.floor(Date.now() / 1000)
  for (let day = Math.floor(fromSec / DAY) * DAY; day < toSec; day += DAY) {
    const file = `${dir}/${day}.json`
    const complete = day + DAY <= nowSec - cacheCompleteAfterSec
    let bars: Candle[]
    if (complete && existsSync(file)) {
      bars = JSON.parse(readFileSync(file, 'utf8'))
    } else {
      bars = await rest.history(symbol, day, Math.min(day + DAY, nowSec))
      if (complete && bars.length > 0) writeFileSync(file, JSON.stringify(bars))
    }
    for (const b of bars) if (b.t >= fromSec && b.t < toSec) out.set(b.t, b)
  }
  return [...out.values()].sort((a, b) => a.t - b.t)
}

export function aggregate(bars: Candle[], minutes: number, nowSec?: number): Candle[] {
  const size = minutes * 60
  const out: Candle[] = []
  for (const b of bars) {
    const t = Math.floor(b.t / size) * size
    const cur = out[out.length - 1]
    if (cur && cur.t === t) {
      cur.h = Math.max(cur.h, b.h)
      cur.l = Math.min(cur.l, b.l)
      cur.c = b.c
      cur.v += b.v
    } else {
      out.push({ t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v })
    }
  }
  const last = out[out.length - 1]
  if (nowSec !== undefined && last && last.t + size > nowSec) out.pop()
  return out
}
