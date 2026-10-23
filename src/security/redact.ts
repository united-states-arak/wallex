// Secret redaction. Every log line, error message and AI-facing string passes through here so a credential can never be
// written to disk, printed to a console or sent to a model by accident, even when an upstream error echoes it back.

const MASK = '***'

// Environment variables whose values are credentials. Their values are masked wherever they appear.
const SECRET_ENV = ['WALLEX_API_KEY', 'AI_API_KEY', 'DASHBOARD_TOKEN', 'OTEL_EXPORTER_OTLP_HEADERS'] as const

// Shapes of credentials that are masked even when the exact value is unknown (a key pasted by a person, an upstream echo).
const PATTERNS: RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi,
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\b(x-api-key|authorization|api[_-]?key|token|secret|password)(["']?\s*[:=]\s*["']?)[^\s"',}]{8,}/gi,
]

export function secretValues(env: Record<string, string | undefined> = process.env): string[] {
  const out = new Set<string>()
  for (const name of SECRET_ENV) {
    const v = env[name]?.trim()
    if (!v || v.length < 8) continue
    out.add(v)
    // OTLP headers are "k=v,k2=v2": the individual values are secrets too
    if (name === 'OTEL_EXPORTER_OTLP_HEADERS') for (const part of v.split(',')) for (const piece of part.split('=').slice(1)) if (piece.trim().length >= 8) out.add(piece.trim())
  }
  return [...out].sort((a, b) => b.length - a.length)
}

export function redactString(text: string, secrets: string[] = secretValues()): string {
  let out = text
  for (const s of secrets) if (out.includes(s)) out = out.split(s).join(MASK)
  for (const re of PATTERNS) {
    re.lastIndex = 0
    out = out.replace(re, (m, k, sep) => (typeof k === 'string' && typeof sep === 'string' ? `${k}${sep}${MASK}` : MASK))
  }
  return out
}

// Deep copy with every string redacted. Cycles and non-plain values are handled, the input is never mutated.
export function redactDeep<T>(value: T, secrets: string[] = secretValues(), seen = new WeakSet<object>()): T {
  if (typeof value === 'string') return redactString(value, secrets) as T
  if (value === null || typeof value !== 'object') return value
  if (seen.has(value as object)) return '[circular]' as T
  seen.add(value as object)
  if (Array.isArray(value)) return value.map((x) => redactDeep(x, secrets, seen)) as T
  if (value instanceof Error) return redactString(`${value.name}: ${value.message}`, secrets) as T
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = /^(x-api-key|authorization|api[_-]?key|password|secret|token)$/i.test(k) ? MASK : redactDeep(v, secrets, seen)
  return out as T
}
