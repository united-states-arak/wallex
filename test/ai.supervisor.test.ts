import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { createSupervisor } from '../src/ai/supervisor'
import { createMockSupervisor } from '../src/ai/mock'
import type { NewsSource } from '../src/ai/news'
import type { NewsDigest, ReviewInput, Supervisor } from '../src/ai/types'
import type { SetupCandidate } from '../src/ict/types'

type Step = { calls: { name: string; args: unknown }[] } | { text: string } | { status: number } | { hang: true }

const KEY = 'sk-test-secret-key-123'
let script: Step[] = []
let requests: { auth: string | null; body: any }[] = []
let server: ReturnType<typeof Bun.serve>

const chunk = (delta: object, finish?: string) => ({ id: 'c', object: 'chat.completion.chunk', model: 'fake', choices: [{ index: 0, delta, finish_reason: finish ?? null }] })
const sse = (chunks: object[]) => {
  const body = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n'
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
}

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      if (req.method !== 'POST' || url.pathname !== '/v1/chat/completions') return new Response('not found', { status: 404 })
      const body = (await req.json()) as any
      requests.push({ auth: req.headers.get('authorization'), body })
      const idx = body.messages.filter((m: any) => m.role === 'assistant').length
      const step = script[idx] ?? { text: 'done' }
      if ('status' in step) return new Response('{"error":"boom"}', { status: step.status })
      if ('hang' in step) return new Response(new ReadableStream({ start() {} }), { headers: { 'content-type': 'text/event-stream' } })
      if ('text' in step) return sse([chunk({ role: 'assistant', content: step.text }), chunk({}, 'stop')])
      const tool_calls = step.calls.map((c, i) => ({ index: i, id: `call_${idx}_${i}`, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } }))
      return sse([chunk({ role: 'assistant', tool_calls }), chunk({}, 'tool_calls')])
    },
  })
})

afterAll(() => server.stop(true))

const open: Supervisor[] = []
afterEach(async () => {
  for (const s of open.splice(0)) await s.close?.()
  requests = []
})

const digest: NewsDigest = {
  fetchedAt: '2026-10-22T10:00:00.000Z',
  fearGreed: { value: 12, label: 'Extreme Fear' },
  trending: ['PEPE', 'DOGE'],
  headlines: [{ title: 'PEPE team wallet exploited', source: 'CoinDesk', publishedAt: '2026-10-22T09:30:00.000Z', url: 'https://example.com/a' }],
}
let newsCalls = 0
const news: NewsSource = {
  async get() {
    newsCalls++
    return digest
  },
  async refresh() {
    return digest
  },
}

function make(env: Record<string, string> = {}, log?: (e: string, d?: Record<string, unknown>) => void) {
  const s = createSupervisor({
    env: { AI_BASE_URL: `http://localhost:${server.port}/v1`, AI_API_KEY: KEY, AI_MODEL: 'fake-model', ...env },
    news,
    log,
  })
  open.push(s)
  return s
}

const entry = 0.00001
const ictSetup: SetupCandidate = {
    model: 'sweep',
    symbol: 'PEPETMN',
    detectedAt: 1_700_000_000,
    entry,
    stop: entry * 0.98,
    tp1: entry * 1.045,
    score: 7,
    scoreParts: { sweep: 2 },
    sweep: { level: entry * 0.985, kind: 'equal-lows', extreme: entry * 0.981, t: 1_699_999_400 },
    mss: { level: entry * 1.01, t: 1_699_999_700, displacementAtr: 1.9 },
    fvg: { low: entry * 0.995, high: entry * 1.005, ce: entry, t: 1_699_999_700 },
    dealingRange: { low: entry * 0.97, high: entry * 1.06 },
    expiresAt: 1_700_003_600,
    invalidateBelow: entry * 0.985,
    rationale: 'Sweep of equal lows then displacement and FVG retrace.',
}
const input: ReviewInput = {
  setup: ictSetup,
  equityTmn: 5_000_000,
  proposedNotionalTmn: 1_900_000,
  proposedPctOfEquity: 0.38,
  openPositions: [{ symbol: 'DOGETMN', notionalTmn: 800_000 }],
  dayPnlPct: -0.02,
}

const submit = (action: string, size_mult: number, reason = 'because') => ({ calls: [{ name: 'submit_verdict', args: { action, size_mult, reason } }] })

test('missing AI_BASE_URL returns the mock supervisor', async () => {
  const s = createSupervisor({ env: {} })
  const v = await s.review(input)
  expect(v).toMatchObject({ action: 'approve', sizeMult: 1, source: 'fallback', reason: 'ai disabled' })
  expect(await s.refreshNews()).toBeNull()
  expect(await createMockSupervisor().review(input)).toMatchObject({ reason: 'ai disabled' })
})

test('approve', async () => {
  script = [submit('approve', 1, 'Fear and Greed 12 but setup is clean')]
  const v = await make().review(input)
  expect(v).toMatchObject({ action: 'approve', sizeMult: 1, source: 'ai', model: 'fake-model', toolCalls: ['submit_verdict'] })
  expect(v.reason).toContain('Fear and Greed 12')
  expect(requests[0].auth).toBe(`Bearer ${KEY}`)
  expect(requests[0].body.tools.map((t: any) => t.function.name).sort()).toEqual(['get_news_digest', 'get_setup', 'submit_verdict'])
  expect(requests[0].body.messages.at(-1).content).toContain('PEPETMN')
})

test('veto after reading setup and news, tool calls recorded and verdict logged without the key', async () => {
  newsCalls = 0
  script = [
    { calls: [{ name: 'get_setup', args: {} }, { name: 'get_news_digest', args: {} }] },
    submit('veto', 0, 'Headline: PEPE team wallet exploited'),
  ]
  const logged: { event: string; data: any }[] = []
  const v = await make({}, (event, data) => logged.push({ event, data })).review(input)
  expect(v).toMatchObject({ action: 'veto', sizeMult: 0, source: 'ai' })
  expect(v.toolCalls).toEqual(['get_setup', 'get_news_digest', 'submit_verdict'])
  expect(v.latencyMs).toBeGreaterThanOrEqual(0)
  const toolMsgs = requests[1].body.messages.filter((m: any) => m.role === 'tool').map((m: any) => String(m.content))
  expect(toolMsgs.some((c: string) => c.includes('"symbol":"PEPETMN"') && c.includes('equityTmn'))).toBe(true)
  expect(toolMsgs.some((c: string) => c.includes('PEPE team wallet exploited'))).toBe(true)
  expect(newsCalls).toBeGreaterThan(0)
  expect(logged).toHaveLength(1)
  expect(logged[0].event).toBe('ai.verdict')
  expect(logged[0].data).toMatchObject({ symbol: 'PEPETMN', action: 'veto', source: 'ai' })
  expect(JSON.stringify(logged)).not.toContain(KEY)
})

test('resize keeps a size in (0,1)', async () => {
  script = [submit('resize', 0.5, 'two positions open and fear is high')]
  const v = await make().review(input)
  expect(v).toMatchObject({ action: 'resize', sizeMult: 0.5, source: 'ai' })
})

test('size is clamped: never grows, veto forces 0, approve forces 1', async () => {
  script = [submit('resize', 1.7)]
  expect(await make().review(input)).toMatchObject({ action: 'approve', sizeMult: 1, source: 'ai' })
  script = [submit('resize', 0)]
  expect(await make().review(input)).toMatchObject({ action: 'approve', sizeMult: 1 })
  script = [submit('veto', 0.9)]
  expect(await make().review(input)).toMatchObject({ action: 'veto', sizeMult: 0 })
  script = [submit('approve', 0.3)]
  expect(await make().review(input)).toMatchObject({ action: 'approve', sizeMult: 1 })
})

test('invalid submit_verdict args come back as a tool error and the model can retry', async () => {
  script = [{ calls: [{ name: 'submit_verdict', args: { action: 'maybe', size_mult: 1, reason: 'x' } }] }, submit('approve', 1, 'ok after retry')]
  const v = await make().review(input)
  expect(v).toMatchObject({ action: 'approve', source: 'ai', reason: 'ok after retry' })
})

test('timeout falls back (approve by default)', async () => {
  script = [{ hang: true }]
  const t0 = Date.now()
  const v = await make({ AI_TIMEOUT_MS: '400' }).review(input)
  expect(Date.now() - t0).toBeLessThan(3000)
  expect(v).toMatchObject({ action: 'approve', sizeMult: 1, source: 'fallback' })
  expect(v.reason).toContain('timeout')
})

test('AI_FAIL_MODE=veto makes the fallback a veto', async () => {
  script = [{ hang: true }]
  const v = await make({ AI_TIMEOUT_MS: '300', AI_FAIL_MODE: 'veto' }).review(input)
  expect(v).toMatchObject({ action: 'veto', sizeMult: 0, source: 'fallback' })
})

test('server 500 falls back and does not leak the key', async () => {
  script = [{ status: 500 }]
  const logged: string[] = []
  const v = await make({ AI_TIMEOUT_MS: '1500' }, (e, d) => logged.push(JSON.stringify({ e, d }))).review(input)
  expect(v).toMatchObject({ action: 'approve', sizeMult: 1, source: 'fallback' })
  expect(v.reason.length).toBeGreaterThan(10)
  expect(JSON.stringify(v)).not.toContain(KEY)
  expect(logged.join('')).not.toContain(KEY)
})

test('model that never calls submit_verdict falls back', async () => {
  script = [{ text: 'I think it is fine.' }]
  const v = await make({ AI_FAIL_MODE: 'veto' }).review(input)
  expect(v).toMatchObject({ action: 'veto', source: 'fallback' })
  expect(v.reason).toContain('submit_verdict')
})

test('unreachable endpoint falls back', async () => {
  const v = await make({ AI_BASE_URL: 'http://localhost:1/v1', AI_TIMEOUT_MS: '2000' }).review(input)
  expect(v).toMatchObject({ source: 'fallback', action: 'approve' })
})

test('refreshNews goes to the news source', async () => {
  expect(await make().refreshNews()).toEqual(digest)
})

test('concurrent reviews keep their verdicts separate', async () => {
  script = [submit('veto', 0, 'a')]
  const s = make()
  const [a, b] = await Promise.all([s.review(input), s.review({ ...input, setup: { ...input.setup, symbol: 'DOGETMN' } })])
  expect(a.action).toBe('veto')
  expect(b.action).toBe('veto')
})
