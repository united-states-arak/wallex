// Lists model ids on the configured AI provider (ids only, key never printed).
import { getSettings } from '../../src/settings'
const S = getSettings().ai
const res = await fetch(`${S.baseUrl.trim().replace(/\/+$/, '')}/models`, { headers: { authorization: `Bearer ${S.apiKey}` } })
const j: any = await res.json().catch(() => null)
console.log(res.status, (j?.data ?? []).map((m: any) => m.id).join(' '))
