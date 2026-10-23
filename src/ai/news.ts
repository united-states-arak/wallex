import { readCapped } from '../security/http'
import { getSettings } from '../settings'
import type { NewsDigest, NewsItem } from './types'

export interface NewsSource {
  get(): Promise<NewsDigest | null>
  refresh(): Promise<NewsDigest | null>
}

export interface NewsOptions {
  fetch?: (url: string, init?: RequestInit) => Promise<Response>
  ttlMs?: number
  timeoutMs?: number
  now?: () => number
  maxHeadlines?: number
  feeds?: { source: string; url: string }[]
}

const FAILURE_TTL_MS = 60_000
const MAX_TITLE = 160
const MAX_BODY_BYTES = 1_000_000 // an RSS feed or JSON payload larger than this is refused

// Headlines are untrusted text that ends up in a model prompt: drop control characters and markup, keep it one short line.
export function sanitizeUntrusted(s: string, max = MAX_TITLE): string {
  return s
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, ' ')
    .replace(/[<>`]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

export function decodeXml(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m)
}

function tagText(block: string, tag: string): string {
  const m = block.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i'))
  if (!m) return ''
  const raw = m[1].trim()
  const cdata = raw.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/)
  return (cdata ? cdata[1] : decodeXml(raw)).replace(/\s+/g, ' ').trim()
}

// Handles RSS 2.0 <item> and Atom <entry>. Items without a title are dropped.
export function parseRss(xml: string, source: string): NewsItem[] {
  const out: NewsItem[] = []
  const blocks = xml.match(/<(item|entry)(?:\s[^>]*)?>[\s\S]*?<\/\1>/gi) ?? []
  for (const block of blocks) {
    const title = tagText(block, 'title')
    if (!title) continue
    const when = tagText(block, 'pubDate') || tagText(block, 'dc:date') || tagText(block, 'published') || tagText(block, 'updated')
    const t = Date.parse(when)
    const atomLink = block.match(/<link[^>]*href="([^"]+)"/i)?.[1]
    out.push({
      title: sanitizeUntrusted(title),
      source,
      publishedAt: Number.isFinite(t) ? new Date(t).toISOString() : '',
      url: tagText(block, 'link') || (atomLink ? decodeXml(atomLink) : ''),
    })
  }
  return out
}

export function createNewsSource(opts: NewsOptions = {}): NewsSource {
  const doFetch = opts.fetch ?? ((url: string, init?: RequestInit) => fetch(url, init))
  const S = getSettings().ai
  const FNG_URL = S.fearGreedUrl
  const TRENDING_URL = S.trendingUrl
  const ttlMs = opts.ttlMs ?? S.newsTtlMin * 60_000
  const timeoutMs = opts.timeoutMs ?? S.newsTimeoutMs
  const now = opts.now ?? Date.now
  const maxHeadlines = opts.maxHeadlines ?? S.maxHeadlines
  const feeds = opts.feeds ?? S.feeds

  let cached: { digest: NewsDigest | null; at: number; ttl: number } | null = null
  let inflight: Promise<NewsDigest | null> | null = null

  const request = async (url: string): Promise<Response> => {
    const res = await doFetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { 'user-agent': 'starcoach-trader/1.0', accept: '*/*' } })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return res
  }

  const fearGreed = async (): Promise<NewsDigest['fearGreed']> => {
    const body = JSON.parse(await readCapped(await request(FNG_URL), MAX_BODY_BYTES)) as { data?: { value?: string; value_classification?: string }[] }
    const d = body.data?.[0]
    const value = Number(d?.value)
    if (!d || !Number.isFinite(value)) throw new Error('bad fear and greed payload')
    return { value, label: String(d.value_classification ?? '') }
  }

  const trending = async (): Promise<string[]> => {
    const body = JSON.parse(await readCapped(await request(TRENDING_URL), MAX_BODY_BYTES)) as { coins?: { item?: { symbol?: string } }[] }
    if (!Array.isArray(body.coins)) throw new Error('bad trending payload')
    return body.coins.map((c) => c.item?.symbol?.toUpperCase()).filter((s): s is string => !!s).slice(0, 10)
  }

  const feed = async (f: { source: string; url: string }): Promise<NewsItem[]> => parseRss(await readCapped(await request(f.url), MAX_BODY_BYTES), f.source)

  const build = async (): Promise<NewsDigest | null> => {
    const [fg, tr, ...rss] = await Promise.allSettled([fearGreed(), trending(), ...feeds.map(feed)])
    const items = rss.flatMap((r) => (r.status === 'fulfilled' ? r.value : []))
    const anyOk = [fg, tr, ...rss].some((r) => r.status === 'fulfilled')
    if (!anyOk) return null
    items.sort((a, b) => (Date.parse(b.publishedAt) || 0) - (Date.parse(a.publishedAt) || 0))
    return {
      fetchedAt: new Date(now()).toISOString(),
      fearGreed: fg.status === 'fulfilled' ? fg.value : null,
      trending: tr.status === 'fulfilled' ? tr.value : [],
      headlines: items.slice(0, maxHeadlines),
    }
  }

  const refresh = (): Promise<NewsDigest | null> => {
    if (inflight) return inflight
    inflight = build()
      .catch(() => null)
      .then((digest) => {
        // keep serving the last good digest when every source fails
        const result = digest ?? cached?.digest ?? null
        cached = { digest: result, at: now(), ttl: digest ? ttlMs : FAILURE_TTL_MS }
        return result
      })
      .finally(() => {
        inflight = null
      })
    return inflight
  }

  return {
    async get() {
      if (cached && now() - cached.at < cached.ttl) return cached.digest
      return refresh()
    },
    refresh,
  }
}
