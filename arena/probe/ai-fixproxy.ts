// Local workaround proxy for the configured AI provider: adds reasoning_effort "none" and drops empty-choices
// stream chunks (Azure prompt_filter_results) that libfx rejects as InvalidChunk. For testing only.
// Usage: bun arena/probe/ai-fixproxy.ts  (listens on 127.0.0.1:8799), then AI_BASE_URL=http://localhost:8799/v1 bun src/ai/try.ts
import { getSettings } from '../../src/settings'

const S = getSettings().ai
const upstream = `${S.baseUrl.trim().replace(/\/+$/, '')}/chat/completions`
Bun.serve({
  port: 8799,
  hostname: '127.0.0.1',
  idleTimeout: 120,
  async fetch(req) {
    const body: any = await req.json()
    body.reasoning_effort = 'none'
    const res = await fetch(upstream, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${S.apiKey}` }, body: JSON.stringify(body) })
    const text = (await res.text())
      .split('\n\n')
      .filter((ev) => {
        const m = ev.match(/^data: (\{.*\})$/s)
        if (!m) return true
        const j = JSON.parse(m[1]!)
        return !(Array.isArray(j.choices) && j.choices.length === 0 && !j.usage)
      })
      .join('\n\n')
    console.log('proxied', res.status, 'tools', body.tools?.length ?? 0)
    return new Response(text, { status: res.status, headers: { 'content-type': res.headers.get('content-type') ?? 'application/json' } })
  },
})
console.log('listening 8799')
