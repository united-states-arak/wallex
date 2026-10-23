// Regime study on train days 0:80: basket index above its EMA -> forward basket return (gross).
import { load, START, SYMS } from './research'
const DAY = 86400
const d = load(START, START + 80 * DAY)
const T = d.BNBTMN!.length
const idx: number[] = [1]
for (let i = 1; i < T; i++) {
  let r = 0
  for (const s of SYMS) r += d[s]![i]!.c / d[s]![i - 1]!.c - 1
  idx.push(idx[i - 1]! * (1 + r / SYMS.length))
}
const ema = (a: number[], n: number) => {
  const k = 2 / (n + 1)
  const o = [a[0]!]
  for (let i = 1; i < a.length; i++) o.push(o[i - 1]! + k * (a[i]! - o[i - 1]!))
  return o
}
console.log('index total', ((idx[T - 1]! - 1) * 100).toFixed(1))
for (const n of [24, 48, 96, 168, 336]) {
  const e = ema(idx, n)
  const row: string[] = []
  for (const H of [6, 24, 72]) {
    const up: number[] = []
    const dn: number[] = []
    for (let i = 340; i < T - H; i++) (idx[i]! > e[i]! ? up : dn).push(idx[i + H]! / idx[i]! - 1)
    const m = (x: number[]) => ((x.reduce((p, q) => p + q, 0) / Math.max(1, x.length)) * 100).toFixed(2)
    row.push(`H${H} up ${m(up)}% (${up.length}) dn ${m(dn)}% (${dn.length})`)
  }
  console.log('EMA', n, row.join(' | '))
}
// cross-sectional momentum: past-L-hour return rank -> next H forward return, every 24h rebalance
for (const L of [24, 72, 168]) {
  for (const H of [24, 72]) {
    const top: number[] = []
    const all: number[] = []
    const bot: number[] = []
    for (let i = 340; i < T - H; i += 6) {
      const r = SYMS.map((s) => ({ s, p: d[s]![i]!.c / d[s]![i - L]!.c - 1, f: d[s]![i + H]!.c / d[s]![i]!.c - 1 })).sort((a, b) => b.p - a.p)
      top.push((r[0]!.f + r[1]!.f + r[2]!.f) / 3)
      bot.push((r[12]!.f + r[13]!.f + r[14]!.f) / 3)
      all.push(r.reduce((p, q) => p + q.f, 0) / 15)
    }
    const m = (x: number[]) => ((x.reduce((p, q) => p + q, 0) / x.length) * 100).toFixed(2)
    console.log(`xs-mom L${L} H${H}: top3 ${m(top)} bottom3 ${m(bot)} all ${m(all)}`)
  }
}
