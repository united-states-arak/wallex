// Episodes of basket above EMA(n) on train 0:80: basket return per episode (gross), with a hysteresis band.
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
for (const n of [72, 120, 168, 240]) {
  for (const band of [0, 0.01]) {
    const e = ema(idx, n)
    let inn = false
    let t0 = 0
    const eps: string[] = []
    let sum = 0
    for (let i = 24; i < T; i++) {
      if (!inn && idx[i]! > e[i]! * (1 + band)) {
        inn = true
        t0 = i
      } else if (inn && idx[i]! < e[i]! * (1 - band)) {
        inn = false
        const r = idx[i]! / idx[t0]! - 1
        sum += r
        eps.push(`${((i - t0) / 24).toFixed(1)}d:${(r * 100).toFixed(1)}`)
      }
    }
    console.log(`EMA${n} band${band}: n=${eps.length} sum=${(sum * 100).toFixed(1)}%  ${eps.join(' ')}`)
  }
}
