import { getSettings } from './settings'

export interface UniverseOpts {
  minVolTmn?: number
  maxSpreadPct?: number
  minRangePct?: number
  max?: number
}

export interface MarketsPayload {
  result?: { symbols?: Record<string, any> }
}

const JUNK_BASES = new Set(['USDT', 'USDC', 'DAI', 'TUSD', 'FDUSD', 'PAXG', 'XAUT', 'XAUT0'])

const num = (v: unknown) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

export async function fetchMarketsPayload(base = getSettings().wallex.baseUrl): Promise<MarketsPayload> {
  const res = await fetch(new URL('/v1/markets', base), { signal: AbortSignal.timeout(getSettings().wallex.requestTimeoutMs) })
  if (!res.ok) throw new Error(`GET /v1/markets -> ${res.status}`)
  return (await res.json()) as MarketsPayload
}

// Liquid, volatile TMN markets for a 1m intraday strategy, best first by 24h range * 24h TMN volume.
export async function selectUniverse(
  src: MarketsPayload | (() => Promise<MarketsPayload>) = fetchMarketsPayload,
  blocked: Set<string> = new Set(),
  opts: UniverseOpts = {},
): Promise<string[]> {
  const U = getSettings().market.universe
  const { minVolTmn = U.minVolTmn, maxSpreadPct = U.maxSpreadPct, minRangePct = U.minRangePct, max = U.max } = opts
  const excluded = new Set(U.exclude)
  const payload = typeof src === 'function' ? await src() : src
  const scored: { symbol: string; score: number }[] = []
  for (const s of Object.values<any>(payload.result?.symbols ?? {})) {
    const symbol = String(s.symbol ?? '')
    if (s.quoteAsset !== 'TMN' || symbol === 'USDTTMN' || blocked.has(symbol) || excluded.has(symbol)) continue
    if (JUNK_BASES.has(String(s.baseAsset))) continue
    const st = s.stats ?? {}
    const vol = num(st['24h_tmnVolume'])
    const hi = num(st['24h_highPrice'])
    const lo = num(st['24h_lowPrice'])
    const bid = num(st.bidPrice)
    const ask = num(st.askPrice)
    if (!(vol >= minVolTmn && lo > 0 && hi >= lo && bid > 0 && ask >= bid)) continue
    const range = (hi - lo) / lo
    if (range < minRangePct || (ask - bid) / bid > maxSpreadPct) continue
    scored.push({ symbol, score: range * vol })
  }
  return scored.sort((a, b) => b.score - a.score || a.symbol.localeCompare(b.symbol)).slice(0, max).map((x) => x.symbol)
}
