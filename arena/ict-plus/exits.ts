// Research: exit / entry variants on the loose setup universe. Prints fit (days<80) and val (days>=80) side by side.
import { BASE, load, readSetups, sim, type Cfg, type Setup } from './sim'

const { bars, idx, tick } = await load()
const setups = readSetups(process.argv[2] ?? 'arena/ict-plus/loose.jsonl').filter((s) => (s.entry - s.stop) / s.entry >= Number(process.env.MINSTOP ?? 0))
const run = (name: string, cfg: Cfg, filter: (s: Setup) => boolean = () => true) => {
  const rs = setups.filter(filter).map((s) => ({ s, r: sim(bars[s.symbol]!, idx[s.symbol]!, s, cfg, tick[s.symbol]!) })).filter((x) => x.r.filled)
  const f = (xs: typeof rs) => {
    const eq = xs.reduce((a, x) => a + x.r.eq, 0) * 100
    const net = (xs.reduce((a, x) => a + x.r.net, 0) / Math.max(1, xs.length)) * 100
    const w = xs.filter((x) => x.r.net > 0).length / Math.max(1, xs.length)
    return `n=${String(xs.length).padStart(3)} w=${(w * 100).toFixed(0).padStart(2)}% avg=${net.toFixed(2).padStart(6)}% eq=${eq.toFixed(1).padStart(7)}%`
  }
  console.log(name.padEnd(34), 'fit', f(rs.filter((x) => x.s.day < 80)), '| val', f(rs.filter((x) => x.s.day >= 80)))
}
const tpk = (k: number) => (s: Setup, e: number, st: number) => e + k * (e - st)
run('base', BASE)
for (const k of [0.75, 1, 1.25, 1.5, 2]) run(`tp ${k}R full`, { ...BASE, tp1Frac: 1, tp1Fn: tpk(k) })
for (const k of [1, 1.5]) run(`tp ${k}R half + tp2 orig`, { ...BASE, tp1Fn: tpk(k) })
run('base no be', { ...BASE, be: false })
run('base time 120', { ...BASE, timeStop: 120 })
run('base time 60', { ...BASE, timeStop: 60 })
run('base time 60 any', { ...BASE, timeStop: 60, timeStopOnlyBelow: false })
run('entry=fvg.low', { ...BASE, entryFn: (s) => s.fvg.low })
run('entry=fvg.low tp1R full', { ...BASE, entryFn: (s) => s.fvg.low, tp1Frac: 1, tp1Fn: tpk(1) })
run('entry=mid(low,ce)', { ...BASE, entryFn: (s) => (s.fvg.low + s.fvg.ce) / 2 })
run('entry=fvg.high', { ...BASE, entryFn: (s) => s.fvg.high })
run('entry=fvg.high 1R', { ...BASE, entryFn: (s) => s.fvg.high, tp1Frac: 1, tp1Fn: tpk(1) })
run('expire 60', { ...BASE, expire: 60 })
run('expire 30', { ...BASE, expire: 30 })
