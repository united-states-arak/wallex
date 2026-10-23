// Public: market metadata shape, parsed meta, and depth for candidate markets.
import { WallexRest } from '../../src/wallex/rest'
import { loadBlocked } from '../../src/exchange/validate'
import { raw, shape } from './raw'

const rest = new WallexRest()
const r = await raw('GET', '/v1/markets', { auth: false })
const syms = r.json.result.symbols
console.log('markets status', r.status, r.ms, 'ms rl', r.rl, 'keys', Object.keys(r.json.result))
console.log('entry shape DOGETMN:', JSON.stringify(shape(syms.DOGETMN), null, 1))
const meta = await rest.markets()
const blocked = loadBlocked()
const cands = ['DOGETMN', 'XRPTMN', 'BNBTMN', 'TRXTMN', 'SHIBTMN', 'ADATMN', 'USDTTMN', 'PEPETMN', 'XLMTMN', 'ETCTMN', 'LTCTMN', 'SOLTMN', 'TONTMN', 'ETHTMN', 'BTCTMN']
for (const s of cands) {
  const m = meta[s]
  if (!m) { console.log(s, 'missing'); continue }
  const raw0 = syms[s]
  let q: any = null
  const t0 = performance.now()
  try { q = await rest.depth(s) } catch (e) { q = String(e) }
  const ms = Math.round(performance.now() - t0)
  const spreadBps = q?.bid ? Math.round(((q.ask - q.bid) / q.bid) * 10000 * 10) / 10 : null
  console.log(s, blocked.has(s) ? 'BLOCKED' : 'allowed', JSON.stringify(m), 'raw step/tick', raw0.stepSize, raw0.tickSize, 'q', JSON.stringify(q), 'spreadBps', spreadBps, 'depthMs', ms, 'vol24h?', raw0.stats?.['24h_quoteVolume'] ?? raw0.stats?.volume)
}
const d = await raw('GET', '/v1/depth', { auth: false, query: { symbol: 'DOGETMN' } })
console.log('depth shape', d.status, d.rl, JSON.stringify(shape(d.json)).slice(0, 800))
