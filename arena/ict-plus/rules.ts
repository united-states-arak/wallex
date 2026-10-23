// Research: a handful of principled filters evaluated on two universes (default detector, and a looser one with stop >= 1%).
import { BASE, SYMBOLS, load, readSetups, sim, type Cfg, type Setup } from './sim'

const { bars, idx, tick } = await load()
const at = (sym: string, t: number) => {
  const b = bars[sym]!
  let lo = 0, hi = b.length - 1
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (b[m]!.t <= t) lo = m; else hi = m - 1 }
  return lo
}
const ret = (sym: string, t: number, n: number) => { const i = at(sym, t); return bars[sym]![i]!.c / bars[sym]![Math.max(0, i - n)]!.c - 1 }
const pos3d = (s: Setup) => {
  const b = bars[s.symbol]!, i = at(s.symbol, s.t)
  let lo = Infinity, hi = -Infinity
  for (let k = i - 4320; k <= i; k++) { lo = Math.min(lo, b[k]!.l); hi = Math.max(hi, b[k]!.h) }
  return (b[i]!.c - lo) / (hi - lo)
}
const flat = (s: Setup) => { const b = bars[s.symbol]!, i = at(s.symbol, s.t); let z = 0; for (let k = i - 59; k <= i; k++) if (b[k]!.h === b[k]!.l) z++; return z / 60 }
const rr = (s: Setup) => (s.tp1 - s.entry) / (s.entry - s.stop)
const rules: Record<string, (s: Setup) => boolean> = {
  all: () => true,
  'rr<=3': (s) => rr(s) <= 3,
  'pos3d<.85': (s) => pos3d(s) < 0.85,
  'pos3d<.9': (s) => pos3d(s) < 0.9,
  'ret24h<.06': (s) => ret(s.symbol, s.t, 1440) < 0.06,
  'ret24h<.04': (s) => ret(s.symbol, s.t, 1440) < 0.04,
  'flat<=.9': (s) => flat(s) <= 0.9,
  'rr<=3&pos3d<.85': (s) => rr(s) <= 3 && pos3d(s) < 0.85,
  'rr<=3&ret24h<.06': (s) => rr(s) <= 3 && ret(s.symbol, s.t, 1440) < 0.06,
  'rr<=3&pos<.85&flat<=.9': (s) => rr(s) <= 3 && pos3d(s) < 0.85 && flat(s) <= 0.9,
  'rr<=3&ret<.06&flat<=.9': (s) => rr(s) <= 3 && ret(s.symbol, s.t, 1440) < 0.06 && flat(s) <= 0.9,
  'sweep only': (s) => s.model === 'sweep',
  'cont only': (s) => s.model === 'continuation',
  'score>=5': (s) => s.score >= 5,
}
const universes: Record<string, Setup[]> = {
  default: readSetups('arena/ict-plus/setups.jsonl'),
  'loose>=1%': readSetups('arena/ict-plus/loose.jsonl').filter((s) => (s.entry - s.stop) / s.entry >= 0.01),
}
const cfg: Cfg = BASE
for (const [un, list] of Object.entries(universes)) {
  console.log('=====', un, list.length)
  const rs = list.map((s) => ({ s, r: sim(bars[s.symbol]!, idx[s.symbol]!, s, cfg, tick[s.symbol]!) })).filter((x) => x.r.filled)
  const f = (xs: typeof rs) => `n=${String(xs.length).padStart(3)} w=${((xs.filter((x) => x.r.net > 0).length / Math.max(1, xs.length)) * 100).toFixed(0).padStart(2)}% avg=${((xs.reduce((a, x) => a + x.r.net, 0) / Math.max(1, xs.length)) * 100).toFixed(2).padStart(6)}% eq=${(xs.reduce((a, x) => a + x.r.eq, 0) * 100).toFixed(1).padStart(6)}%`
  for (const [rn, fn] of Object.entries(rules)) {
    const sel = rs.filter((x) => fn(x.s))
    console.log(rn.padEnd(26), 'fit', f(sel.filter((x) => x.s.day < 80)), '| val', f(sel.filter((x) => x.s.day >= 80)))
  }
}
