// Read-only: compare balances / open orders with and without the sub-account-client-id header.
import { openLog } from '../../src/log'
import { raw, redact } from './raw'

const log = openLog('probe')
const subs = await raw('GET', '/sub-accounts')
const prop = (subs.json?.result ?? []).find((s: any) => s.type === 'prop')
if (!prop) throw new Error('no prop sub-account')
const cid = String(prop.clientId)
const tmn = (j: any) => j?.result?.balances?.TMN ? { value: j.result.balances.TMN.value, locked: j.result.balances.TMN.locked } : redact(j).slice(0, 300)
for (const [label, headers] of [
  ['no header', {}],
  ['sub-account-client-id', { 'sub-account-client-id': cid }],
  ['Sub-Account-Client-id', { 'Sub-Account-Client-id': cid }],
  ['bogus sub id', { 'sub-account-client-id': 'X-NOT-A-REAL-ID' }],
] as const) {
  const b = await raw('GET', '/v1/account/balances', { headers: headers as Record<string, string> })
  const o = await raw('GET', '/v1/account/openOrders', { headers: headers as Record<string, string> })
  const d = await raw('GET', '/v1/account/balances-detail', { headers: headers as Record<string, string> })
  log('probe.subhdr', { reason: 'compare balance visibility with/without sub-account header', label, bStatus: b.status, oStatus: o.status, dStatus: d.status })
  console.log(label, { balances: [b.status, b.ms, tmn(b.json), b.rl], openOrders: [o.status, redact(o.json).slice(0, 200)], detailTMN: [d.status, d.json?.result?.TMN ? { total: d.json.result.TMN.total, freeze: d.json.result.TMN.freeze } : redact(d.json).slice(0, 200)] })
}
