// Research: mean gross drift after the fill (close vs entry), ignoring stops. Is there any directional edge at all?
import { BASE, load, readSetups, sim } from './sim'

const { bars, idx, tick } = await load()
const setups = readSetups(process.argv[2] ?? 'arena/ict-plus/setups.jsonl')
const hs = [5, 15, 30, 60, 120, 240, 480]
const acc = (rows: { s: any; d: number[] }[]) => hs.map((_, j) => ((rows.reduce((a, x) => a + x.d[j]!, 0) / Math.max(1, rows.length)) * 100).toFixed(2).padStart(6)).join(' ')
const rows: { s: any; d: number[] }[] = []
for (const s of setups) {
  const r = sim(bars[s.symbol]!, idx[s.symbol]!, s, BASE, tick[s.symbol]!)
  if (!r.filled) continue
  const b = bars[s.symbol]!
  const fi = idx[s.symbol]!.get(r.tEnd - r.hold * 60)!
  rows.push({ s, d: hs.map((h) => (b[Math.min(b.length - 1, fi + h)]!.c / r.entry) - 1) })
}
console.log('horizons', hs.join(' '))
console.log('fit all', acc(rows.filter((x) => x.s.day < 80)), rows.filter((x) => x.s.day < 80).length)
console.log('val all', acc(rows.filter((x) => x.s.day >= 80)))
for (const m of ['sweep', 'continuation']) {
  console.log('fit', m, acc(rows.filter((x) => x.s.day < 80 && x.s.model === m)))
  console.log('val', m, acc(rows.filter((x) => x.s.day >= 80 && x.s.model === m)))
}
