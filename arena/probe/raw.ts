// Raw HTTP helper for inspecting response shapes the repo does not expose. The key is read from settings and never printed.
import { getSettings } from '../../src/settings'

const S = getSettings()
const KEY = S.wallex.apiKey

export function redact(x: unknown): string {
  let s = typeof x === 'string' ? x : JSON.stringify(x)
  if (KEY) s = s.split(KEY).join('<REDACTED>')
  return s
}

export async function raw(method: string, path: string, o: { query?: Record<string, string>; body?: unknown; headers?: Record<string, string>; auth?: boolean } = {}) {
  const url = new URL(path, S.wallex.baseUrl)
  for (const [k, v] of Object.entries(o.query ?? {})) url.searchParams.set(k, v)
  const headers: Record<string, string> = { 'content-type': 'application/json', ...(o.headers ?? {}) }
  if (o.auth !== false) headers['x-api-key'] = KEY
  const t0 = performance.now()
  const res = await fetch(url, { method, headers, body: o.body ? JSON.stringify(o.body) : undefined, signal: AbortSignal.timeout(15_000) })
  const ms = Math.round(performance.now() - t0)
  const text = await res.text()
  let json: any
  try {
    json = JSON.parse(text)
  } catch {
    json = text.slice(0, 500)
  }
  const rl: Record<string, string> = {}
  res.headers.forEach((v, k) => {
    if (/rate|limit|retry|remaining/i.test(k)) rl[k] = v
  })
  return { status: res.status, ms, rl, json }
}

// Replace leaf values with their type (and keep short strings that look like enums) so shapes can be reported safely.
export function shape(x: any, depth = 0): any {
  if (Array.isArray(x)) return x.length ? [shape(x[0], depth + 1), `(${x.length} items)`] : []
  if (x && typeof x === 'object') {
    const out: Record<string, any> = {}
    for (const [k, v] of Object.entries(x)) out[k] = shape(v, depth + 1)
    return out
  }
  if (typeof x === 'string') return `string(${x.length > 24 ? x.slice(0, 6) + '…' : x})`
  return `${typeof x}(${x})`
}
