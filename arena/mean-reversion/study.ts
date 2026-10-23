// Exploration on train days 0:80 only.
import '../env'
import { loadCandles, aggregate } from '../../src/data/candles'
import { WallexRest } from '../../src/wallex/rest'
const DAY = 86400
const END = Date.parse('2026-10-22T00:00:00Z') / 1000
const START = END - 180 * DAY
const TO = START + 80 * DAY
const SYMS = ['PEPETMN','PUMPTMN','USOONTMN','BNBTMN','ETHTMN','XRPTMN','ARBTMN','DOGETMN','ADATMN','STMN','SOLTMN','APETMN','TRXTMN','LTCTMN','AAVETMN']
const tf = Number(process.argv[2] ?? 15)
const H = Number(process.argv[3] ?? 16)
const rest = new WallexRest()
const rows: { sym: string; t: number; z: number; rsi: number; trend: number; atrp: number; fwd: number; mfe: number; mae: number; ret1h: number }[] = []
for (const s of SYMS) {
  const m1 = await loadCandles(rest, s, START - 3 * DAY, TO)
  const b = aggregate(m1, tf, TO)
  const c = b.map((x) => x.c)
  let gain = 0, loss = 0, atr = 0
  for (let i = 1; i < b.length; i++) {
    const ch = c[i]! - c[i - 1]!
    const tr = Math.max(b[i]!.h - b[i]!.l, Math.abs(b[i]!.h - c[i - 1]!), Math.abs(b[i]!.l - c[i - 1]!))
    if (i <= 14) { gain += Math.max(ch, 0) / 14; loss += Math.max(-ch, 0) / 14; atr += tr / 14 } else { gain = (gain * 13 + Math.max(ch, 0)) / 14; loss = (loss * 13 + Math.max(-ch, 0)) / 14; atr = (atr * 13 + tr) / 14 }
    if (i < 400 || b[i]!.t < START || i + H >= b.length) continue
    let s20 = 0; for (let j = i - 19; j <= i; j++) s20 += c[j]!
    const mean = s20 / 20
    let v = 0; for (let j = i - 19; j <= i; j++) v += (c[j]! - mean) ** 2
    const sd = Math.sqrt(v / 20)
    let sl = 0; for (let j = i - 383; j <= i; j++) sl += c[j]!
    const z = sd > 0 ? (c[i]! - mean) / sd : 0
    const rsi = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss)
    let mfe = 0, mae = 0
    for (let j = i + 1; j <= i + H; j++) { mfe = Math.max(mfe, b[j]!.h / c[i]! - 1); mae = Math.min(mae, b[j]!.l / c[i]! - 1) }
    const k = Math.round(60 / tf)
    rows.push({ sym: s, t: b[i]!.t, z, rsi, trend: c[i]! / (sl / 384) - 1, atrp: atr / c[i]!, fwd: c[i + H]! / c[i]! - 1, mfe, mae, ret1h: c[i]! / c[i - k]! - 1 })
  }
}
const avg = (a: number[]) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length)
const show = (name: string, r: typeof rows) => console.log(name.padEnd(34), 'n', String(r.length).padStart(6), 'fwd%', (avg(r.map((x) => x.fwd)) * 100).toFixed(3), 'mfe%', (avg(r.map((x) => x.mfe)) * 100).toFixed(2), 'mae%', (avg(r.map((x) => x.mae)) * 100).toFixed(2), 'atr%', (avg(r.map((x) => x.atrp)) * 100).toFixed(2))
show('all', rows)
for (const zt of [1, 1.5, 2, 2.5, 3]) {
  const r = rows.filter((x) => x.z <= -zt)
  show(`z<=-${zt}`, r)
  show(`  +rsi<30`, r.filter((x) => x.rsi <= 30))
  show(`  +trend>0`, r.filter((x) => x.trend > 0))
  show(`  +trend>0.03`, r.filter((x) => x.trend > 0.03))
  show(`  +trend<0`, r.filter((x) => x.trend < 0))
}
for (const [lo, hi] of [[-1, -0.05], [-0.05, -0.03], [-0.03, -0.02], [-0.02, -0.01], [-0.01, 0]]) show(`ret1h in ${lo}..${hi}`, rows.filter((x) => x.ret1h >= lo && x.ret1h < hi))
console.log('--- deep drops')
const q = (a: number[], p: number) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(p * (s.length - 1))]! }
for (const d of [0.02, 0.03, 0.04, 0.05]) {
  const r = rows.filter((x) => x.ret1h <= -d)
  show(`ret1h<=-${d}`, r)
  console.log('   fwd q10/25/50/75/90', [0.1, 0.25, 0.5, 0.75, 0.9].map((p) => (q(r.map((x) => x.fwd), p) * 100).toFixed(2)).join(' '), ' mae q50/q25', (q(r.map((x) => x.mae), 0.5) * 100).toFixed(2), (q(r.map((x) => x.mae), 0.25) * 100).toFixed(2), 'mfe q50', (q(r.map((x) => x.mfe), 0.5) * 100).toFixed(2))
  show(`   +trend>0`, r.filter((x) => x.trend > 0))
  show(`   +trend<=0`, r.filter((x) => x.trend <= 0))
  show(`   +trend<-0.05`, r.filter((x) => x.trend < -0.05))
  show(`   +rsi<25`, r.filter((x) => x.rsi < 25))
  // by half
  const mid = START + 40 * DAY
  show(`   first40d`, r.filter((x) => x.t < mid))
  show(`   second40d`, r.filter((x) => x.t >= mid))
  const byS: Record<string, number[]> = {}
  for (const x of r) (byS[x.sym] ??= []).push(x.fwd)
  console.log('   per sym', Object.entries(byS).map(([k, v]) => `${k.replace('TMN', '')}:${v.length}/${(avg(v) * 100).toFixed(1)}`).join(' '))
}
