import { expect, test } from 'bun:test'
import { createNewsSource, parseRss } from '../src/ai/news'

const rss = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/"><channel><title>Feed</title>
<item>
  <title><![CDATA[Bitcoin ETF sees record inflows]]></title>
  <link>https://example.com/a</link>
  <pubDate>Thu, 22 Oct 2026 09:00:00 +0000</pubDate>
</item>
<item>
  <title>Exchange &amp; wallet &quot;hack&quot; drains $10M</title>
  <link>https://example.com/b</link>
  <dc:date>2026-10-22T10:30:00Z</dc:date>
</item>
<item><link>https://example.com/no-title</link></item>
</channel></rss>`

test('parseRss reads CDATA, entities, dates and skips untitled items', () => {
  const items = parseRss(rss, 'CoinDesk')
  expect(items).toHaveLength(2)
  expect(items[0]).toEqual({ title: 'Bitcoin ETF sees record inflows', source: 'CoinDesk', publishedAt: '2026-10-22T09:00:00.000Z', url: 'https://example.com/a' })
  expect(items[1].title).toBe('Exchange & wallet "hack" drains $10M')
  expect(items[1].publishedAt).toBe('2026-10-22T10:30:00.000Z')
})

test('parseRss tolerates garbage', () => {
  expect(parseRss('not xml', 'x')).toEqual([])
  expect(parseRss('', 'x')).toEqual([])
})

const json = (o: unknown) => new Response(JSON.stringify(o), { headers: { 'content-type': 'application/json' } })

function fakeFetch(overrides: Record<string, () => Response | Promise<Response>> = {}) {
  const calls: string[] = []
  const f = async (url: string) => {
    calls.push(url)
    for (const [k, v] of Object.entries(overrides)) if (url.includes(k)) return v()
    if (url.includes('alternative.me')) return json({ data: [{ value: '23', value_classification: 'Extreme Fear' }] })
    if (url.includes('trending')) return json({ coins: [{ item: { symbol: 'pepe' } }, { item: { symbol: 'doge' } }] })
    if (url.includes('coindesk')) return new Response(rss)
    if (url.includes('cointelegraph')) {
      const items = Array.from({ length: 20 }, (_, i) => `<item><title>CT ${i}</title><link>https://ct/${i}</link><pubDate>Thu, 22 Oct 2026 0${i % 10}:00:00 GMT</pubDate></item>`)
      return new Response(`<rss><channel>${items.join('')}</channel></rss>`)
    }
    return new Response('nope', { status: 404 })
  }
  return { f, calls }
}

test('builds a digest from all sources, newest 15 headlines, cached', async () => {
  const { f, calls } = fakeFetch()
  let t = 1_000_000
  const src = createNewsSource({ fetch: f, now: () => t })
  const d = await src.get()
  expect(d?.fearGreed).toEqual({ value: 23, label: 'Extreme Fear' })
  expect(d?.trending).toEqual(['PEPE', 'DOGE'])
  expect(d?.headlines).toHaveLength(15)
  const times = d!.headlines.map((h) => Date.parse(h.publishedAt))
  expect([...times].sort((a, b) => b - a)).toEqual(times)
  expect(d!.headlines[0].title).toBe('Exchange & wallet "hack" drains $10M')
  expect(calls).toHaveLength(4)

  t += 14 * 60_000
  await src.get()
  expect(calls).toHaveLength(4)
  t += 2 * 60_000
  await src.get()
  expect(calls).toHaveLength(8)
  await src.refresh()
  expect(calls).toHaveLength(12)
})

test('each source fails independently', async () => {
  const { f } = fakeFetch({
    alternative: () => new Response('x', { status: 503 }),
    trending: () => {
      throw new Error('network down')
    },
    cointelegraph: () => new Response('<<<garbage', { status: 200 }),
  })
  const d = await createNewsSource({ fetch: f }).get()
  expect(d?.fearGreed).toBeNull()
  expect(d?.trending).toEqual([])
  expect(d?.headlines.map((h) => h.source)).toEqual(['CoinDesk', 'CoinDesk'])
})

test('returns null when everything fails and never throws', async () => {
  const src = createNewsSource({
    fetch: async () => {
      throw new Error('offline')
    },
  })
  expect(await src.get()).toBeNull()
  expect(await src.refresh()).toBeNull()
})

test('keeps serving the last good digest when a refresh fails entirely', async () => {
  let down = false
  const { f } = fakeFetch()
  const src = createNewsSource({
    fetch: async (url) => {
      if (down) throw new Error('offline')
      return f(url)
    },
  })
  const good = await src.refresh()
  down = true
  expect(await src.refresh()).toEqual(good)
})

test('a hung source is cut off by the timeout', async () => {
  const { f } = fakeFetch()
  const src = createNewsSource({
    timeoutMs: 100,
    fetch: (url, init) => (url.includes('alternative') ? new Promise((_, rej) => init?.signal?.addEventListener('abort', () => rej(new Error('aborted')))) : f(url)),
  })
  const t0 = Date.now()
  const d = await src.get()
  expect(Date.now() - t0).toBeLessThan(2000)
  expect(d?.fearGreed).toBeNull()
  expect(d?.trending).toEqual(['PEPE', 'DOGE'])
})

test('concurrent get calls share one fetch round', async () => {
  const { f, calls } = fakeFetch()
  const src = createNewsSource({ fetch: f })
  await Promise.all([src.get(), src.get(), src.refresh()])
  expect(calls).toHaveLength(4)
})
