import { readFileSync } from 'node:fs'
import { parseLine, type LogEvent } from './state'

export interface Replay {
  clock: () => number
  speed: number
  events: number
  stepOnce: () => number
  run: (everyMs?: number) => () => void
}

export function loadReplay(path: string, speed: number, sink: (ev: LogEvent, raw: string) => void): Replay {
  const lines = readFileSync(path, 'utf8').split('\n')
  const events: { t: number; ev: LogEvent; raw: string }[] = []
  for (const line of lines) {
    const ev = parseLine(line)
    if (!ev) continue
    const t = Date.parse(ev.ts)
    if (Number.isFinite(t)) events.push({ t, ev, raw: line.trim() })
  }
  const base = events[0]?.t ?? Date.now()
  const realStart = Date.now()
  const sp = Number.isFinite(speed) && speed > 0 ? speed : 1
  const clock = () => base + (Date.now() - realStart) * sp
  let i = 0
  const stepOnce = () => {
    const now = clock()
    let n = 0
    while (i < events.length && events[i]!.t <= now) {
      sink(events[i]!.ev, events[i]!.raw)
      i++
      n++
    }
    return n
  }
  return {
    clock,
    speed: sp,
    events: events.length,
    stepOnce,
    run(everyMs = 100) {
      stepOnce()
      const h = setInterval(stepOnce, everyMs)
      ;(h as { unref?: () => void }).unref?.()
      return () => clearInterval(h)
    },
  }
}
