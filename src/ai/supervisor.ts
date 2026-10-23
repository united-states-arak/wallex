import { readFileSync } from 'node:fs'
import { createFxAgent, memory } from 'libfx'
import { getSettings, loadSettings } from '../settings'
import { nullLog, type Log } from '../log'
import { createCompatFetch } from './compat'
import { createMockSupervisor } from './mock'
import { createNewsSource, type NewsSource } from './news'
import type { NewsDigest, ReviewInput, Supervisor, Verdict } from './types'

export const SUPERVISOR_INSTRUCTIONS = `You are the AI risk supervisor of an automated long-only spot trading bot on Wallex TMN pairs.
It runs two models in one position book. The washout model buys a market that fell 3.5% or more within an hour while the rest of the market is calm, with a take-profit 4% above, a stop 6% below and an 8-hour time stop. The breakout model: a closed 1-hour candle breaks the 4-day high on above-average volume, the coin is above its rising trend average, and most of the market is trending up. It exits with an initial stop 4 ATR below entry and a trailing stop 8 ATR below the highest price, so it has no fixed target and lets winners run. The bot also has an ICT model (liquidity sweep, structure shift, fair value gap) whose setups you may see.
Deterministic code has already found the setup and sized it so that a stop-out costs about 1% of equity. You review ONE candidate setup and decide whether it should be taken. You can only approve it, veto it, or shrink it. You can never propose a bigger size, change prices, or place orders.

How to work:
1. Call get_setup to read the candidate (strategy, prices, stop distance, rationale and evidence, equity, proposed size, open positions, day PnL).
2. Call get_news_digest to read Fear & Greed, trending coins and the newest crypto headlines. Check whether any headline concerns this coin or the wider market. The symbol is a TMN pair such as PEPETMN, so the coin is the part before TMN.
3. Weigh the news, the market context and the setup together, then decide.

Veto when any of these holds:
- News shows a hack, exploit, delisting, regulatory crackdown or shock, or a large token unlock or similar supply event for this coin, or a market-wide crisis headline.
- Fear & Greed is at an extreme that contradicts a long entry (for example extreme fear with a falling market, where a long is catching a knife), and the setup has no unusually strong evidence to offset it.
- The proposed notional is a large share of equity (above about 35%) while the day PnL is already negative.
- The setup rationale is internally inconsistent: for example the numbers do not match the story, the stop is not below the entry, the target is not above the entry, or the stated risk/reward does not hold.
For a washout, veto when the drop is explained by real bad news for that coin (hack, delisting, exploit, regulatory action), because then it is not an overshoot. For a breakout, also veto when the breakout is driven by a one-off headline that is likely to reverse (a denied listing rumour, an exploit, a pump announcement) or when the coin has an imminent unlock or delisting, and shrink it when the market mood is euphoric (extreme greed) because breakouts late in a euphoric run fail more often.
Use resize (size_mult strictly between 0 and 1, for example 0.5) when there is real but not decisive concern: mixed news, elevated fear or greed, several open positions already, a weak score, or a thin edge. Otherwise approve. Do not veto just to be cautious; a clean setup with no adverse facts should be approved with size_mult 1.

Finish by calling submit_verdict exactly once, with action approve, veto or resize, size_mult (1 for approve, 0 for veto, between 0 and 1 for resize) and a one or two sentence reason that names the concrete facts you used (the Fear & Greed value, a specific headline, the notional share of equity, the day PnL, the score). Your reason is written to the trade decision log that judges read. Do not call submit_verdict more than once and do not trade or output anything after it.`

const VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['approve', 'veto', 'resize'] },
    size_mult: { type: 'number', minimum: 0, maximum: 1, description: '1 for approve, 0 for veto, strictly between 0 and 1 for resize' },
    reason: { type: 'string', description: 'One or two sentences naming the concrete facts used' },
  },
  required: ['action', 'size_mult', 'reason'],
  additionalProperties: false,
} as const

type RawVerdict = { action: Verdict['action']; sizeMult: number; reason: string }

function parseVerdictArgs(input: unknown): RawVerdict {
  const o = (input ?? {}) as Record<string, unknown>
  const action = o.action
  if (action !== 'approve' && action !== 'veto' && action !== 'resize') throw new Error('action must be approve, veto or resize')
  const sizeMult = Number(o.size_mult)
  if (!Number.isFinite(sizeMult)) throw new Error('size_mult must be a number between 0 and 1')
  const reason = typeof o.reason === 'string' ? o.reason.trim() : ''
  if (!reason) throw new Error('reason is required')
  return { action, sizeMult, reason: reason.slice(0, 600) }
}

export function normalizeVerdict(raw: RawVerdict): Pick<Verdict, 'action' | 'sizeMult' | 'reason'> {
  const mult = Math.min(1, Math.max(0, raw.sizeMult))
  if (raw.action === 'veto') return { action: 'veto', sizeMult: 0, reason: raw.reason }
  if (raw.action === 'resize') {
    if (mult > 0 && mult < 1) return { action: 'resize', sizeMult: mult, reason: raw.reason }
    return { action: 'approve', sizeMult: 1, reason: `${raw.reason} (resize with size_mult ${raw.sizeMult} is not a shrink, treated as approve)` }
  }
  return { action: 'approve', sizeMult: 1, reason: raw.reason }
}

const round = (x: number, d = 2) => (Number.isFinite(x) ? Number(x.toFixed(d)) : x)
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export function summarizeNews(d: NewsDigest | null) {
  if (!d) return { available: false }
  return {
    fearGreed: d.fearGreed ? `${d.fearGreed.value} ${d.fearGreed.label}` : null,
    trending: d.trending.slice(0, 7),
    headlineCount: d.headlines.length,
  }
}

// dayPnlPct is a fraction of equity (the risk guard's unit), so 0.03 is shown as 3 percent.
export function buildPrompt(input: ReviewInput, news: NewsDigest | null): string {
  const s = input.setup
  const risk = s.entry - s.stop
  const brief = {
    symbol: s.symbol,
    strategy: s.model,
    entry: s.entry,
    stop: s.stop,
    stopDistancePct: round((risk / s.entry) * 100),
    ...(s.tp1 !== undefined ? { tp1: s.tp1, rr: round(risk > 0 ? (s.tp1 - s.entry) / risk : NaN) } : { exit: 'trailing stop, no fixed target' }),
    ...(s.score !== undefined ? { score: s.score } : {}),
    rationale: s.rationale,
    ...(s.features ? { evidence: s.features } : {}),
    ...(s.sweep ? { sweep: { kind: s.sweep.kind, level: s.sweep.level, extreme: s.sweep.extreme } } : {}),
    ...(s.mss ? { mss: { level: s.mss.level, displacementAtr: round(s.mss.displacementAtr) } } : {}),
    ...(s.fvg ? { fvg: { low: s.fvg.low, high: s.fvg.high } } : {}),
    equityTmn: Math.round(input.equityTmn),
    proposedNotionalTmn: Math.round(input.proposedNotionalTmn),
    proposedPctOfEquity: round(input.equityTmn > 0 ? (input.proposedNotionalTmn / input.equityTmn) * 100 : NaN, 1),
    openPositions: input.openPositions,
    dayPnlPct: round(input.dayPnlPct * 100),
    news: summarizeNews(news),
  }
  return `Review this candidate setup and submit your verdict. Percent fields are already percentages.\n${JSON.stringify(brief)}`
}

export function createSupervisor(opts: { log?: Log; env?: Record<string, string | undefined>; news?: NewsSource } = {}): Supervisor {
  // `env` resolves the settings against a specific environment (tests); by default the process settings are used.
  const S = (opts.env ? loadSettings({ env: opts.env }) : getSettings()).ai
  const log = opts.log ?? nullLog
  const baseUrl = S.baseUrl.trim().replace(/\/+$/, '')
  if (!S.enabled || !baseUrl) return createMockSupervisor()

  const { model, apiKey, timeoutMs, failMode } = S
  const instructions = S.instructionsFile ? readFileSync(S.instructionsFile, 'utf8') : SUPERVISOR_INSTRUCTIONS
  const news = opts.news ?? createNewsSource()

  const slots = new Map<string, RawVerdict>()
  const redact = (s: string) => (apiKey ? s.split(apiKey).join('***') : s)

  const agent = createFxAgent({
    provider: { name: 'ai', baseUrl, models: { [model]: { contextWindow: S.contextWindow, supportsToolUse: true } } },
    model,
    ...(apiKey ? { credentials: async () => ({ apiKey }) } : {}),
    instructions,
    durability: memory(),
    fetch: createCompatFetch(),
    tools: [
      {
        name: 'get_news_digest',
        description: 'Latest crypto news digest: Fear & Greed index, trending coins and the newest headlines with source and time. Cached for 15 minutes.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        idempotent: true,
        async execute() {
          return (await news.get()) ?? { unavailable: true, note: 'news sources could not be reached, judge on the setup alone' }
        },
      },
      {
        name: 'get_setup',
        description: 'The candidate setup under review: prices, risk/reward, score, rationale, sweep and structure shift, equity, proposed size, open positions and day PnL.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        idempotent: true,
        async execute(_input, ctx) {
          return ctx.context ?? { error: 'no setup in context' }
        },
      },
      {
        name: 'submit_verdict',
        description: 'Submit the final decision for this setup. Call exactly once, last.',
        inputSchema: VERDICT_SCHEMA,
        idempotent: false,
        async execute(input, ctx) {
          const v = parseVerdictArgs(input)
          if (!slots.has(ctx.sessionId)) slots.set(ctx.sessionId, v)
          return 'recorded'
        },
      },
    ],
  })

  const fallback = (why: string, started: number, toolCalls: string[]): Verdict => {
    const action = failMode === 'veto' ? 'veto' : 'approve'
    return {
      action,
      sizeMult: action === 'veto' ? 0 : 1,
      reason: `AI supervisor unavailable (${redact(why).slice(0, 200)}); AI_FAIL_MODE=${failMode} so the setup is ${action === 'veto' ? 'vetoed' : 'approved unchanged'}`,
      source: 'fallback',
      model,
      latencyMs: Date.now() - started,
      toolCalls,
    }
  }

  async function runReview(input: ReviewInput, started: number, toolCalls: string[]): Promise<Verdict> {
    const digest = await Promise.race([news.get().catch(() => null), sleep(Math.min(S.newsWaitMs, timeoutMs / 3)).then(() => null)])
    const ac = new AbortController()
    const session = agent.session(undefined, { context: JSON.parse(JSON.stringify(input)) })
    const turn = session.prompt(buildPrompt(input, digest), { signal: ac.signal })
    let sessionId: string | null = null
    let timer: ReturnType<typeof setTimeout> | undefined

    const consume = async (): Promise<'verdict' | 'ended'> => {
      sessionId = (await turn.accepted).sessionId
      for await (const e of turn) {
        if (e.type === 'tool_start') toolCalls.push(e.name)
        // the verdict is recorded; skip the model's closing reply to save a round trip
        if (e.type === 'tool_end' && e.name === 'submit_verdict' && !e.isError && slots.has(sessionId)) return 'verdict'
      }
      return 'ended'
    }
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), Math.max(0, started + timeoutMs - Date.now()))
    })
    const consuming = consume()
    consuming.catch(() => {})
    turn.result.catch(() => {})

    try {
      const outcome = await Promise.race([consuming, timeout])
      const raw = sessionId ? slots.get(sessionId) : undefined
      if (raw) return { ...normalizeVerdict(raw), source: 'ai', model, latencyMs: Date.now() - started, toolCalls }
      if (outcome === 'timeout') return fallback(`timeout after ${timeoutMs}ms`, started, toolCalls)
      const result = await turn.result
      const detail = result.error ? `${result.error.name}: ${result.error.message}` : `turn ended (${result.stopReason}) without submit_verdict`
      return fallback(detail, started, toolCalls)
    } finally {
      clearTimeout(timer)
      ac.abort()
      session.cancel().catch(() => {})
      if (sessionId) slots.delete(sessionId)
    }
  }

  return {
    async review(input) {
      const started = Date.now()
      const toolCalls: string[] = []
      let verdict: Verdict
      try {
        verdict = await runReview(input, started, toolCalls)
      } catch (e) {
        verdict = fallback(e instanceof Error ? e.message : String(e), started, toolCalls)
      }
      log('ai.verdict', { symbol: input.setup.symbol, ...verdict })
      return verdict
    },
    async refreshNews() {
      return news.refresh().catch(() => null)
    },
    async close() {
      await agent.close()
    },
  }
}
