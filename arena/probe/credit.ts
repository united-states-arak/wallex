// Read-only probe: is the challenge credit capital visible via /v1/account/balances or only via credit endpoints?
import { openLog } from '../../src/log'
import { raw, redact, shape } from './raw'

const log = openLog('probe')
const paths = [
  '/sub-accounts',
  '/v1/sub-accounts',
  '/v1/prop/user/packages/overview',
  '/v1/prop/user/packages/active',
  '/v1/prop/user/packages/history',
  '/v1/account/balances-detail',
  '/v1/account/fee',
]
for (const p of paths) {
  try {
    const r = await raw('GET', p)
    log('probe.credit', { reason: 'read-only credit/balance endpoint probe', path: p, status: r.status, ms: r.ms, rl: r.rl })
    const j = r.json
    let body: any = j
    if (p === '/v1/account/balances-detail' && j?.result && typeof j.result === 'object') {
      const nz = Object.fromEntries(Object.entries<any>(j.result).filter(([, v]) => Number(v?.total) > 0 || Number(v?.freeze) > 0))
      body = { ...j, result: { nonZero: nz, assetCount: Object.keys(j.result).length, sampleShape: shape(Object.values(j.result)[0]) } }
    }
    if (p === '/v1/account/fee' && j?.result) body = { ...j, result: shape(j.result) }
    console.log(`\n== ${p} -> ${r.status} (${r.ms} ms) rl=${JSON.stringify(r.rl)}`)
    console.log(redact(body).slice(0, 3000))
  } catch (e) {
    console.log(`\n== ${p} -> ERROR ${redact(String(e))}`)
  }
}
