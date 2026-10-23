// 1) Capture what libfx actually sends (local echo server, no key involved).
// 2) Raw call to the real endpoint with reasoning_effort "none" + tools, to see whether tool use works then.
// 3) Real libfx agent with model { id, effort: 'none' } to see whether the supervisor path could work with that option.
import { createFxAgent, memory } from 'libfx'
import { getSettings } from '../../src/settings'

const S = getSettings().ai
const KEY = S.apiKey
const redact = (s: string) => (KEY ? s.split(KEY).join('<REDACTED>') : s)

let captured: any = null
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    captured = await req.json().catch(() => null)
    return new Response(JSON.stringify({ error: { message: 'probe echo', type: 'invalid_request_error' } }), { status: 400, headers: { 'content-type': 'application/json' } })
  },
})
const tool = { name: 'submit_verdict', description: 'x', inputSchema: { type: 'object', properties: { action: { type: 'string' } }, required: ['action'], additionalProperties: false }, idempotent: false, async execute() { return 'ok' } }
for (const effort of [undefined, 'none']) {
  captured = null
  try {
    const agent = createFxAgent({
      provider: { name: 'ai', baseUrl: `http://localhost:${server.port}/v1`, models: { [S.model]: { contextWindow: 128000, supportsToolUse: true } } },
      ...(effort ? { model: { id: S.model, effort } } : { model: S.model }),
      instructions: 'test',
      durability: memory(),
      tools: [tool as any],
    } as any)
    const turn = agent.session().prompt('hi')
    const r = await turn.result
    await agent.close()
    console.log(`libfx effort=${effort}:`, 'stopReason', r.stopReason, 'err', r.error?.message?.slice(0, 200), 'sent keys', captured ? Object.keys(captured) : null, 'reasoning_effort', captured?.reasoning_effort, 'tools', captured?.tools?.length)
  } catch (e) {
    console.log(`libfx effort=${effort}: threw`, String(e).slice(0, 300))
  }
}
server.stop(true)

const url = `${S.baseUrl.trim().replace(/\/+$/, '')}/chat/completions`
const t0 = performance.now()
const res = await fetch(url, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
  body: JSON.stringify({
    model: S.model,
    reasoning_effort: 'none',
    messages: [{ role: 'user', content: 'Call submit_verdict with action approve.' }],
    tools: [{ type: 'function', function: { name: 'submit_verdict', description: 'x', parameters: tool.inputSchema } }],
  }),
})
const j: any = await res.json().catch(() => null)
console.log('raw reasoning_effort=none:', res.status, Math.round(performance.now() - t0), 'ms', redact(JSON.stringify({ finish: j?.choices?.[0]?.finish_reason, tool_calls: j?.choices?.[0]?.message?.tool_calls, err: j?.error?.message })))
