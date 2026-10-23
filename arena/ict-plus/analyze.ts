// Research only. Uses days 0:80 for choices; days 80:120 are printed separately as "val" and never used to pick filters.
import { BASE, load, readSetups, sim, type Res, type Setup } from './sim'

const { bars, idx, tick } = await load()
const setups = readSetups(process.argv[2])
const rows = setups.map((s) => ({ s, r: sim(bars[s.symbol]!, idx[s.symbol]!, s, BASE, tick[s.symbol]!) })).filter((x) => x.r.filled)
const fit = rows.filter((x) => x.s.day < 80)
const val = rows.filter((x) => x.s.day >= 80)
const sum = (xs: typeof rows) => {
  const n = xs.length
  const eq = xs.reduce((a, x) => a + x.r.eq, 0) * 100
  const net = xs.reduce((a, x) => a + x.r.net, 0) / Math.max(1, n) * 100
  const w = xs.filter((x) => x.r.net > 0).length
  return `n=${String(n).padStart(3)} win=${((w / Math.max(1, n)) * 100).toFixed(0).padStart(3)}% avgNet=${net.toFixed(2).padStart(6)}% eqSum=${eq.toFixed(1).padStart(6)}%`
}
console.log('setups', setups.length, 'filled', rows.length)
console.log('FIT ', sum(fit))
console.log('VAL ', sum(val))
const by = (name: string, f: (s: Setup) => string | number) => {
  console.log('--', name)
  const keys = [...new Set(fit.map((x) => f(x.s)))].sort()
  for (const k of keys) console.log(' ', String(k).padEnd(12), 'fit', sum(fit.filter((x) => f(x.s) === k)))
}
by('model', (s) => s.model)
by('tf', (s) => (s.sweep.t % 900 === 0 && s.mss.t % 900 === 0 ? '15?' : '5?'))
by('score', (s) => s.score)
by('bias', (s) => s.scoreParts.bias!)
by('level', (s) => s.scoreParts.level!)
by('session', (s) => s.scoreParts.session!)
by('disp', (s) => s.scoreParts.displacement!)
by('fvgOte', (s) => s.scoreParts.fvgOte!)
by('deep', (s) => s.scoreParts.deepDiscount!)
by('rr3', (s) => s.scoreParts.rr3!)
by('stop%', (s) => ((s.entry - s.stop) / s.entry < 0.015 ? '<1.5' : (s.entry - s.stop) / s.entry < 0.02 ? '1.5-2' : '>2'))
by('rr', (s) => { const rr = (s.tp1 - s.entry) / (s.entry - s.stop); return rr < 2.5 ? '2-2.5' : rr < 3.5 ? '2.5-3.5' : rr < 5 ? '3.5-5' : '5+' })
by('hourUTC', (s) => String(Math.floor((s.t % 86400) / 3600 / 4) * 4).padStart(2, '0'))
by('symbol', (s) => s.symbol)
by('how', (s) => sim(bars[s.symbol]!, idx[s.symbol]!, s, BASE, tick[s.symbol]!).how)
const hows: Record<string, number> = {}
for (const x of fit) hows[x.r.how] = (hows[x.r.how] ?? 0) + 1
console.log(hows)
