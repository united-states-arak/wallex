import { expect, test } from 'bun:test'
import { createCompatFetch, dropEmptyChoiceEvents } from '../src/ai/compat'
import { orderSanity, parsePlaceResult } from '../src/exchange/live'
import { WallexError, WallexRest } from '../src/wallex/rest'

// Shapes below are copied from real Wallex replies (values changed).
test('a marketable order is reported FILLED with the real average price, not the echoed limit', () => {
  const ack = parsePlaceResult('b1', { symbol: 'SOLTMN', status: 'FILLED', price: '28322797', executedPrice: '28322797', executedQty: '0.00195', executedSum: '55229.4522', origQty: '0.00195' })
  expect(ack.status).toBe('FILLED')
  expect(ack.filledQty).toBe(0.00195)
  expect(ack.avgPrice!).toBeCloseTo(28_322_796, 0)
})

test('a resting order is NEW and carries no fill', () => {
  const ack = parsePlaceResult('b2', { status: 'NEW', executedQty: '0', executedSum: '0' })
  expect(ack).toEqual({ clientId: 'b2', status: 'NEW' })
})

const limits = { maxOrderTmn: 3_000_000, maxPriceDeviation: 0.03 }
const q = { bid: 100, ask: 101 }
const buy = (price: number, quantity: number) => ({ clientId: 'x', symbol: 'DOGETMN', side: 'BUY' as const, type: 'LIMIT' as const, price, quantity, reason: 't' })

test('order sanity: normal entries pass', () => {
  expect(orderSanity(buy(101.2, 10_000), q, limits)).toBeNull()
  expect(orderSanity(buy(95, 10_000), q, limits)).toBeNull()
})

test('order sanity: oversized, overpriced and absurdly low buys are refused', () => {
  expect(orderSanity(buy(101, 40_000), q, limits)).toMatch(/maxOrderTmn/)
  expect(orderSanity(buy(110, 100), q, limits)).toMatch(/above the ask/)
  expect(orderSanity(buy(10, 100), q, limits)).toMatch(/half the bid/)
})

test('order sanity: sells are never blocked, so a position can always be closed', () => {
  expect(orderSanity({ ...buy(50, 1_000_000), side: 'SELL' }, q, limits)).toBeNull()
})

test('the Wallex client refuses a non-TLS endpoint and malformed identifiers', async () => {
  expect(() => new WallexRest('k', 'http://api.wallex.ir')).toThrow(WallexError)
  const rest = new WallexRest('', 'https://api.wallex.ir')
  await expect(rest.depth('DOGE/TMN; DROP')).rejects.toThrow(/invalid symbol/)
  await expect(rest.cancelOrder('../../admin')).rejects.toThrow(/invalid client id/)
  await expect(rest.order('a b')).rejects.toThrow(/invalid client id/)
})

test('compat: empty-choices filter chunks are dropped, real chunks kept', () => {
  const sse = 'data: {"choices":[],"prompt_filter_results":[]}\n\ndata: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n'
  const out = dropEmptyChoiceEvents(sse)
  expect(out).not.toContain('prompt_filter_results')
  expect(out).toContain('"content":"hi"')
  expect(out).toContain('[DONE]')
})

test('compat: a provider that refuses tools with reasoning gets reasoning_effort none, once, then always', async () => {
  const seen: (string | undefined)[] = []
  const fake = async (_u: string, init?: RequestInit) => {
    const raw = init!.body
    const body = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw as Uint8Array))
    seen.push(body.reasoning_effort)
    if (!body.reasoning_effort) return new Response(JSON.stringify({ error: { message: "set reasoning_effort to 'none'", param: 'reasoning_effort' } }), { status: 400 })
    return new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }
  const f = createCompatFetch(fake)
  const body = new TextEncoder().encode(JSON.stringify({ model: 'm', messages: [] }))
  const r1 = await f('https://ai.example/v1/chat/completions', { method: 'POST', body })
  expect(r1.status).toBe(200)
  expect(await r1.text()).toContain('ok')
  await f('https://ai.example/v1/chat/completions', { method: 'POST', body })
  expect(seen).toEqual([undefined, 'none', 'none'])
})

test('compat: providers without the quirk see the request unchanged', async () => {
  const seen: unknown[] = []
  const fake = async (_u: string, init?: RequestInit) => {
    seen.push(JSON.parse(String(init!.body)).reasoning_effort)
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
  }
  const f = createCompatFetch(fake)
  await f('https://ai.example/v1/chat/completions', { method: 'POST', body: JSON.stringify({ model: 'm' }) })
  expect(seen).toEqual([undefined])
})
