// Research: regime features at setup time (closed bars only) vs outcome. Buckets are by terciles of the fit set.
import { BASE, SYMBOLS, load, readSetups, sim, type Cfg, type Setup } from './sim'

const { bars, idx, tick } = await load()
const setups = readSetups(process.argv[2] ?? 'arena/ict-plus/loose.jsonl').filter((s) => (s.entry - s.stop) / s.entry >= Number(process.env.MINSTOP ?? 0))
const at = (sym: string, t: number) => {
  const b = bars[sym]!
  let lo = 0, hi = b.length - 1
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (b[m]!.t <= t) lo = m; else hi = m - 1 }
  return lo
}
const ret = (sym: string, t: number, n: number) => {
  const i = at(sym, t)
  const b = bars[sym]!
  return b[i]!.c / b[Math.max(0, i - n)]!.c - 1
}
const feats: Record<string, (s: Setup) => number> = {
  ret1h: (s) => ret(s.symbol, s.t, 60),
  ret4h: (s) => ret(s.symbol, s.t, 240),
  ret24h: (s) => ret(s.symbol, s.t, 1440),
  ret3d: (s) => ret(s.symbol, s.t, 4320),
  mktRet24h: (s) => SYMBOLS.reduce((a, x) => a + ret(x, s.t, 1440), 0) / SYMBOLS.length,
  mktRet4h: (s) => SYMBOLS.reduce((a, x) => a + ret(x, s.t, 240), 0) / SYMBOLS.length,
  posIn3dRange: (s) => {
    const b = bars[s.symbol]!
    const i = at(s.symbol, s.t)
    let lo = Infinity, hi = -Infinity
    for (let k = i - 4320; k <= i; k++) { lo = Math.min(lo, b[k]!.l); hi = Math.max(hi, b[k]!.h) }
    return (b[i]!.c - lo) / (hi - lo)
  },
  atrPct1h: (s) => {
    const b = bars[s.symbol]!
    const i = at(s.symbol, s.t)
    let sum = 0
    for (let k = i - 59; k <= i; k++) sum += (b[k]!.h - b[k]!.l) / b[k]!.c
    return sum / 60
  },
  stopPct: (s) => (s.entry - s.stop) / s.entry,
  rr: (s) => (s.tp1 - s.entry) / (s.entry - s.stop),
  dispAtr: (s) => s.mss.displacementAtr,
  score: (s) => s.score,
  ageMin: (s) => 0,
  spreadProxy: (s) => {
    const b = bars[s.symbol]!
    const i = at(s.symbol, s.t)
    let z = 0
    for (let k = i - 59; k <= i; k++) if (b[k]!.h === b[k]!.l) z++
    return z / 60
  },
}
const cfgs: Record<string, Cfg> = { base: BASE, '1R': { ...BASE, tp1Frac: 1, tp1Fn: (s, e, st) => e + (e - st) } }
for (const [cn, cfg] of Object.entries(cfgs)) {
  const rows = setups.map((s) => ({ s, r: sim(bars[s.symbol]!, idx[s.symbol]!, s, cfg, tick[s.symbol]!) })).filter((x) => x.r.filled)
  const fit = rows.filter((x) => x.s.day < 80)
  const val = rows.filter((x) => x.s.day >= 80)
  const f = (xs: typeof rows) => `n=${String(xs.length).padStart(3)} w=${((xs.filter((x) => x.r.net > 0).length / Math.max(1, xs.length)) * 100).toFixed(0).padStart(2)}% avg=${((xs.reduce((a, x) => a + x.r.net, 0) / Math.max(1, xs.length)) * 100).toFixed(2).padStart(6)}%`
  console.log('=====', cn)
  for (const [fn, fx] of Object.entries(feats)) {
    const vals = fit.map((x) => fx(x.s)).sort((a, b) => a - b)
    const q1 = vals[Math.floor(vals.length / 3)]!
    const q2 = vals[Math.floor((2 * vals.length) / 3)]!
    const bk = (x: number) => (x < q1 ? 0 : x < q2 ? 1 : 2)
    const out = [0, 1, 2].map((b) => `${f(fit.filter((x) => bk(fx(x.s)) === b))} / ${f(val.filter((x) => bk(fx(x.s)) === b))}`)
    console.log(fn.padEnd(13), `[${q1.toFixed(4)} ${q2.toFixed(4)}]`)
    out.forEach((o, b) => console.log('   T' + b, o))
  }
}
