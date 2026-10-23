// Read-only: sub-account transfer history summary (types/currency/value only).
import { raw } from './raw'
const r = await raw('GET', '/sub-accounts/transfers')
console.log(r.status, r.rl, JSON.stringify((r.json?.result ?? []).map((t: any) => ({ src: t.source_user_type, dst: t.destination_user_type, currency: t.currency, value: t.value, reason: t.reason, at: t.createdAt }))), JSON.stringify(r.json?.result_info ?? r.json?.message))
