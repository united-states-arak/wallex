// Runs the real libfx supervisor agent through a local logging proxy to see the upstream reply that libfx turns into "refused".
// The proxy adds the key itself; only redacted status and bodies are printed.
import { createFxAgent, memory } from 'libfx'
import { getSettings } from '../../src/settings'

const S = getSettings().ai
const KEY = S.apiKey
const model = process.env.PROBE_MODEL ?? S.model
const redact = (s: string) => (KEY ? s.split(KEY).join('<REDACTED>') : s)
const upstream = `${S.baseUrl.trim().replace(/\/+$/, '')}/chat/completions`
const patch = process.env.PROBE_PATCH ? JSON.parse(process.env.PROBE_PATCH) : {}

const server = Bun.serve({
  port: 0,
  idleTimeout: 120,
  async fetch(req) {
    const body: any = await req.json()
    Object.assign(body, patch)
    console.log('-> request keys', Object.keys(body), 'stream', body.stream, 'tools', body.tools?.map((t: any) => t.function?.name), 'tool0', JSON.stringify(body.tools?.[0]).slice(0, 300))
    const res = await fetch(upstream, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` }, body: JSON.stringify(body) })
    let text = await res.text()
    if (process.env.PROBE_DROP_EMPTY) {
      text = text
        .split('\n\n')
        .filter((ev) => {
          const m = ev.match(/^data: (\{.*\})$/s)
          if (!m) return true
          const j = JSON.parse(m[1]!)
          return !(Array.isArray(j.choices) && j.choices.length === 0 && !j.usage)
        })
        .join('\n\n')
    }
    console.log('<- upstream', res.status, redact(text.slice(0, 600)).replace(/\n/g, ' | '))
    return new Response(text, { status: res.status, headers: { 'content-type': res.headers.get('content-type') ?? 'application/json' } })
  },
})

const agent = createFxAgent({
  provider: { name: 'ai', baseUrl: `http://localhost:${server.port}/v1`, models: { [model]: { contextWindow: 128000, supportsToolUse: true } } },
  model,
  instructions: 'Call submit_verdict once with action approve.',
  durability: memory(),
  tools: [{ name: 'submit_verdict', description: 'Submit.', inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ['approve', 'veto', 'resize'] } }, required: ['action'], additionalProperties: false }, idempotent: false, async execute() { return 'recorded' } }],
} as any)
const turn = agent.session().prompt('Go.')
for await (const e of turn as any) if (e.type !== 'text_delta' && e.type !== 'reasoning_delta') console.log('event', e.type, e.name ?? '', e.isError ?? '')
const r = await turn.result
console.log('result', r.stopReason, JSON.stringify(r.error ?? null))
await agent.close()
server.stop(true)
