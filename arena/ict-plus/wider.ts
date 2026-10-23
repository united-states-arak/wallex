// Research: scale the stop distance by k (same structure entry), target at m*R, to dilute fixed costs.
import { BASE, load, readSetups, sim, type Cfg, type Setup } from './sim'

const { bars, idx, tick } = await load()
const universes: Record<string, Setup[]> = {
  default: readSetups('arena/ict-plus/setups.jsonl'),
  'loose>=1%': readSetups('arena/ict-plus/loose.jsonl').filter((s) => (s.entry - s.stop) / s.entry >= 0.01),
  'loose all': readSetups('arena/ict-plus/loose.jsonl'),
}
for (const [un, list] of Object.entries(universes)) {
  console.log('=====', un)
  const run = (name: string, cfg: Cfg) => {
    const rs = list.map((s) => ({ s, r: sim(bars[s.symbol]!, idx[s.symbol]!, s, cfg, tick[s.symbol]!) })).filter((x) => x.r.filled)
    const f = (xs: typeof rs) => `n=${String(xs.length).padStart(3)} w=${((xs.filter((x) => x.r.net > 0).length / Math.max(1, xs.length)) * 100).toFixed(0).padStart(2)}% avg=${((xs.reduce((a, x) => a + x.r.net, 0) / Math.max(1, xs.length)) * 100).toFixed(2).padStart(6)}% eq=${(xs.reduce((a, x) => a + x.r.eq, 0) * 100).toFixed(1).padStart(6)}%`
    console.log(name.padEnd(22), 'fit', f(rs.filter((x) => x.s.day < 80)), '| val', f(rs.filter((x) => x.s.day >= 80)))
  }
  run('base', BASE)
  for (const x of [0.03, 0.04, 0.05, 0.06]) for (const m of [1.5, 2, 3]) {
    run(`fixed stop ${x} tp${m}R full`, { ...BASE, timeStop: 0, stopFn: (s, e) => e * (1 - x), tp1Frac: 1, tp1Fn: (s, e, st) => e + m * (e - st) })
  }
  for (const x of [0.04, 0.05]) run(`fixed stop ${x} tp2R +time 720`, { ...BASE, timeStop: 720, stopFn: (s, e) => e * (1 - x), tp1Frac: 1, tp1Fn: (s, e, st) => e + 2 * (e - st) })
}
