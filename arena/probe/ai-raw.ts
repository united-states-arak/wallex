// Raw OpenAI-compatible probe of the configured AI endpoint, to see why libfx reports stopReason "refused".
// The key is read from settings and never printed; every output passes through redact().
import { getSettings } from '../../src/settings'
import { SUPERVISOR_INSTRUCTIONS } from '../../src/ai/supervisor'

const S = getSettings().ai
const KEY = S.apiKey
const redact = (s: string) => (KEY ? s.split(KEY).join('<REDACTED>') : s)
const url = `${S.baseUrl.trim().replace(/\/+$/, '')}/chat/completions`
console.log('host', new URL(url).host, 'model', S.model, 'keySet', KEY.length > 0)

const tools = [
  { type: 'function', function: { name: 'get_setup', description: 'The candidate setup under review.', parameters: { type: 'object', properties: {}, additionalProperties: false } } },
  {
    type: 'function',
    function: {
      name: 'submit_verdict',
      description: 'Submit the final decision for this setup. Call exactly once, last.',
      parameters: {
        type: 'object',
        properties: { action: { type: 'string', enum: ['approve', 'veto', 'resize'] }, size_mult: { type: 'number', minimum: 0, maximum: 1 }, reason: { type: 'string' } },
        required: ['action', 'size_mult', 'reason'],
        additionalProperties: false,
      },
    },
  },
]

async function call(label: string, body: Record<string, unknown>) {
  const t0 = performance.now()
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` }, body: JSON.stringify({ model: S.model, ...body }), signal: AbortSignal.timeout(60_000) })
    const text = await res.text()
    const ms = Math.round(performance.now() - t0)
    let j: any
    try { j = JSON.parse(text) } catch { j = null }
    const c = j?.choices?.[0]
    console.log(`\n== ${label}: HTTP ${res.status} ${ms}ms`)
    if (c) console.log(redact(JSON.stringify({ finish_reason: c.finish_reason, messageKeys: Object.keys(c.message ?? {}), refusal: c.message?.refusal, content: String(c.message?.content ?? '').slice(0, 300), tool_calls: c.message?.tool_calls, model: j.model, usage: j.usage })))
    else console.log(redact(text.slice(0, 800)))
  } catch (e) {
    console.log(`\n== ${label}: ERROR ${redact(String(e))}`)
  }
}

await call('plain', { messages: [{ role: 'user', content: 'Reply with the single word OK.' }] })
await call('tools-simple', { messages: [{ role: 'user', content: 'Call submit_verdict with action approve, size_mult 1, reason "test".' }], tools })
await call('supervisor-system', {
  messages: [
    { role: 'system', content: SUPERVISOR_INSTRUCTIONS },
    { role: 'user', content: 'Review this candidate setup and submit your verdict. {"symbol":"PEPETMN","entry":0.00001,"stop":0.0000098,"tp1":0.00001045,"score":7}' },
  ],
  tools,
})
