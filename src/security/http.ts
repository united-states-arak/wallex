import { createHash, timingSafeEqual } from 'node:crypto'

// Reads a response body but refuses to buffer more than `maxBytes`, so a hostile or broken upstream cannot exhaust memory.
export async function readCapped(res: Response, maxBytes: number): Promise<string> {
  const declared = Number(res.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error(`response too large (${declared} bytes, limit ${maxBytes})`)
  if (!res.body) {
    const text = await res.text()
    if (text.length > maxBytes) throw new Error(`response too large (limit ${maxBytes})`)
    return text
  }
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel().catch(() => {})
      throw new Error(`response too large (limit ${maxBytes})`)
    }
    chunks.push(value)
  }
  return new TextDecoder().decode(Buffer.concat(chunks))
}

// Constant-time comparison of two secrets of any length (both sides are hashed first, so length does not leak).
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest()
  const hb = createHash('sha256').update(b).digest()
  return timingSafeEqual(ha, hb)
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])

// Remote endpoints must use TLS. Plain http is accepted only for the local machine (a local model server, tests).
export function isSecureUrl(raw: string): boolean {
  try {
    const u = new URL(raw)
    return u.protocol === 'https:' || (u.protocol === 'http:' && LOCAL_HOSTS.has(u.hostname.toLowerCase()))
  } catch {
    return false
  }
}
