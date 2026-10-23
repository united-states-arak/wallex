import type { Store } from './state'

type Obj = Record<string, unknown>
export type Scenario = 'normal' | 'halt'

const SYMS: Record<string, { px: number; dec: number; qtyDec: number }> = {
  PEPETMN: { px: 0.5959, dec: 4, qtyDec: 0 },
  DOGETMN: { px: 14250, dec: 0, qtyDec: 1 },
  PUMPTMN: { px: 0.0213, dec: 5, qtyDec: 0 },
  SHIBTMN: { px: 1.31, dec: 3, qtyDec: 0 },
}
const SHA = 'a91c3de'
const START = 5_000_000
const MAKER = 0.0025
const TAKER = 0.003

const REJECTS: [number, string, (r: () => number) => Obj][] = [
  [26, 'net RR too low', (r) => ({ netRr: 0.9 + r() * 0.55, min: 1.5 })],
  [18, 'spread too wide', (r) => ({ spread: 0.011 + r() * 0.01, max: 0.01 })],
  [14, 'supervisor veto', () => ({})],
  [9, 'insufficient free TMN', () => ({})],
  [8, 'sizing: below min notional', () => ({})],
  [5, 'invalid levels', () => ({})],
  [4, 'resized below minimum', () => ({})],
]

const APPROVE = [
  'Sweep of the Asian low into a clean 5m FVG. Spread is tight and nothing adverse in the headlines. Approve full size.',
  'Liquidity grab below the prior day low with displacement back above. Fear and greed is neutral. Approve.',
  'Setup quality is high and day PnL leaves room for risk. No overlap with open positions. Approve.',
  'Structure shift confirmed on 15m, entry sits inside the imbalance. Approve at planned size.',
]
const RESIZE = [
  'Valid setup, but the token is trending on social feeds and volatility may spike. Halve the size.',
  'Already one open position in the same sector, so correlation risk is higher. Resize to 60 percent.',
  'Thin order book at the entry level. Shrink to limit slippage.',
]
const VETO = [
  'Headline about an exchange delisting vote for this token in the last hour. Veto.',
  'Spread has doubled over the last ten minutes and depth is thin. Veto.',
  'Day PnL is already negative and the setup is the third attempt at this level. Veto.',
]
const FALLBACK = ['supervisor timeout after 8000 ms, approving by rule', 'supervisor error: model returned invalid JSON, approving by rule']

function rng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

interface SimPos {
  id: string
  symbol: string
  qty: number
  qtyLeft: number
  entry: number
  stop: number
  stop0: number
  tp1: number
  tp2: number
  win: boolean
  tp1Done: boolean
  openedAt: number
  life: number
  realized: number
  fees: number
}
interface SimPend {
  id: string
  symbol: string
  qty: number
  entry: number
  stop: number
  tp1: number
  tp2: number
  fillAt: number
  cancel: boolean
}

export interface DemoOptions {
  seed?: number
  scenario?: Scenario
  backlogMinutes?: number
  now?: () => number
}

export function createDemo(store: Store, opts: DemoOptions = {}) {
  const r = rng(opts.seed ?? 10)
  const pick = <T>(xs: T[]) => xs[Math.floor(r() * xs.length)]!
  const gauss = () => (r() + r() + r() + r() - 2) * 1.7
  const price: Record<string, number> = Object.fromEntries(Object.entries(SYMS).map(([s, m]) => [s, m.px]))
  const names = Object.keys(SYMS)
  const nowMs = opts.now ?? Date.now
  let scenario: Scenario = opts.scenario ?? 'normal'
  let realized = 0
  let shock = 0
  let dayPeak = START
  let haltedDay = false
  let consecutiveLosses = 0
  let idn = 0
  let lastHb = 0
  let lastTick = 0
  let lastEquity = START
  const positions: SimPos[] = []
  const pending: SimPend[] = []
  const barPhase: Record<string, number> = {}
  const t0 = nowMs() - (opts.backlogMinutes ?? 95) * 60_000
  const runEnd = nowMs() + (3 * 60 + 40) * 60_000
  const cutoff = runEnd - 45 * 60_000

  const emit = (t: number, event: string, data: Obj = {}) => {
    store.ingest({ ts: new Date(t).toISOString(), sha: SHA, event, ...data })
  }
  const fx = (symbol: string, x: number) => Number(x.toFixed(SYMS[symbol]!.dec + 2))
  const qround = (symbol: string, x: number) => Number(x.toFixed(SYMS[symbol]!.qtyDec))

  const unrealized = () => positions.reduce((a, p) => a + p.qtyLeft * (price[p.symbol]! - p.entry), 0)
  const equity = () => START + realized + unrealized() - shock
  const totalPnl = () => equity() / START - 1
  const riskPct = () => (totalPnl() >= 0.3 ? 0.0025 : totalPnl() >= 0.15 ? 0.005 : 0.01)

  function blockReason(t: number): string | null {
    if (store.killSwitch()) return 'kill switch file'
    if (haltedDay) return `daily loss halt: equity ${Math.round(equity())} is ${((1 - equity() / dayPeak) * 100).toFixed(1)}% below the day peak`
    return null
  }

  function guardState() {
    const e = equity()
    return {
      equity: Math.round(e),
      startEquity: START,
      dayPeak: Math.round(dayPeak),
      dayPnlPct: e / START - 1,
      totalPnlPct: e / START - 1,
      consecutiveLosses,
      halted: haltedDay,
      ...(haltedDay ? { haltReason: 'daily loss halt' } : {}),
      riskPct: riskPct(),
    }
  }

  function heartbeat(t: number) {
    const e = equity()
    dayPeak = Math.max(dayPeak, e)
    const ages: Record<string, number> = {}
    for (const s of names) {
      barPhase[s] ??= Math.floor(r() * 60)
      ages[s] = (Math.floor(t / 1000) + barPhase[s]!) % 60
    }
    const marks: Record<string, number> = {}
    for (const p of positions) marks[p.symbol] = fx(p.symbol, price[p.symbol]!)
    emit(t, 'daemon.heartbeat', {
      mode: 'paper',
      phase: t >= cutoff ? 'entries_off' : 'trading',
      equity: Math.round(e),
      guard: guardState(),
      blockReason: blockReason(t),
      positions: positions.map((p) => ({ symbol: p.symbol, qty: qround(p.symbol, p.qtyLeft), entry: p.entry, stop: fx(p.symbol, p.stop), tp1: p.tp1, tp2: p.tp2, notional: Math.round(p.qtyLeft * p.entry), mark: marks[p.symbol] })),
      marks,
      holdings: positions.map((p) => p.symbol.replace('TMN', '')),
      barAgeSec: ages,
      api: { total: 3, consecutive: 0, byKind: { quote: 2, history: 1 } },
      strategyErrors: 0,
      msToEnd: runEnd - t,
    })
    lastEquity = e
  }

  function review(t: number, symbol: string, force?: 'approve' | 'resize' | 'veto') {
    const roll = r()
    const action = force ?? (roll < 0.62 ? 'approve' : roll < 0.84 ? 'resize' : 'veto')
    const fallback = r() < 0.09
    const verdict: Obj = fallback
      ? { symbol, action: 'approve', sizeMult: 1, reason: pick(FALLBACK), source: 'fallback', model: 'none', latencyMs: pick([0, 8000]) }
      : {
          symbol,
          action,
          sizeMult: action === 'approve' ? 1 : action === 'resize' ? pick([0.5, 0.6, 0.35]) : 0,
          reason: action === 'approve' ? pick(APPROVE) : action === 'resize' ? pick(RESIZE) : pick(VETO),
          source: 'ai',
          model: 'claude-haiku-4-5',
          latencyMs: Math.round(1300 + r() * 3600),
          toolCalls: r() < 0.5 ? ['news', 'fear_greed'] : ['news'],
        }
    emit(t, 'ai.verdict', verdict)
    return verdict
  }

  function spawnSetup(t: number) {
    const symbol = pick(names)
    const px = price[symbol]!
    const entry = fx(symbol, px * (1 - 0.001))
    const stopDist = 0.008 + r() * 0.01
    const stop = fx(symbol, entry * (1 - stopDist))
    const tp1 = fx(symbol, entry * (1 + stopDist * 1.6))
    const tp2 = fx(symbol, entry * (1 + stopDist * 3))
    const key = `${symbol}:${Math.floor(t / 1000)}`
    const block = blockReason(t)
    const base = { symbol, key, entry, stop, tp1 }
    if (block) return emit(t, 'setup.rejected', { ...base, reason: `guard: ${block}` })
    if (positions.some((p) => p.symbol === symbol) || pending.some((p) => p.symbol === symbol) || positions.length + pending.length >= 2) return
    const wantAccept = r() < 0.3
    if (!wantAccept) {
      const total = REJECTS.reduce((a, x) => a + x[0], 0)
      let roll = r() * total
      const row = REJECTS.find((x) => (roll -= x[0]) < 0) ?? REJECTS[0]!
      if (row[1] === 'supervisor veto') {
        const v = review(t, symbol, 'veto')
        return emit(t, 'setup.rejected', { ...base, reason: 'supervisor veto', verdict: v, ...row[2](r) })
      }
      return emit(t, 'setup.rejected', { ...base, reason: row[1], ...row[2](r) })
    }
    const v = review(t, symbol, 'approve')
    const mult = typeof v.sizeMult === 'number' && v.sizeMult > 0 ? v.sizeMult : 1
    const eq = equity()
    const risk = riskPct() * eq
    let notional = Math.min(risk / (stopDist + MAKER + TAKER + 0.001), eq * 0.4) * mult
    const qty = qround(symbol, notional / entry)
    notional = qty * entry
    const id = `ict-${symbol}-${Math.floor(t / 60000)}${++idn}`
    emit(t, 'setup.accepted', { ...base, tp2, qty, notional: Math.round(notional), pctOfEquity: notional / eq, riskPct: riskPct(), netRr: 1.6 + r() * 1.2, verdict: v.action, verdictReason: v.reason })
    emit(t, 'order.intent', { clientId: id, symbol, side: 'BUY', type: 'LIMIT', price: entry, quantity: qty, reason: 'ICT long: sweep + FVG retest', via: 'bar' })
    emit(t, 'order.ack', { clientId: id, status: 'NEW', mode: 'paper', decisionMs: Math.round(40 + r() * 160) })
    emit(t, 'entry.placed', { symbol, id, qty, entry, stop, tp1, tp2, expiresAt: Math.floor(t / 1000) + 2400, status: 'NEW' })
    pending.push({ id, symbol, qty, entry, stop, tp1, tp2, fillAt: t + 10_000 + r() * 40_000, cancel: r() < 0.15 })
  }

  function step(t: number, dt: number) {
    const vol = 0.0006 * Math.sqrt(dt)
    for (const s of names) price[s] = Math.max(1e-6, price[s]! * (1 + gauss() * vol))

    for (const pd of [...pending]) {
      if (t < pd.fillAt) continue
      pending.splice(pending.indexOf(pd), 1)
      if (pd.cancel) {
        emit(t, 'entry.cancelled', { symbol: pd.symbol, id: pd.id, reason: pick(['expired', 'invalidated']), close: price[pd.symbol] })
        continue
      }
      price[pd.symbol] = pd.entry
      const win = r() < 0.68
      positions.push({ id: pd.id, symbol: pd.symbol, qty: pd.qty, qtyLeft: pd.qty, entry: pd.entry, stop: pd.stop, stop0: pd.stop, tp1: pd.tp1, tp2: pd.tp2, win, tp1Done: false, openedAt: t, life: 90_000 + r() * 150_000, realized: 0, fees: 0 })
      emit(t, 'entry.filled', { symbol: pd.symbol, id: pd.id, qty: pd.qty, entry: pd.entry, stop: pd.stop, tp1: pd.tp1, tp2: pd.tp2 })
      emit(t, 'tp.placed', { symbol: pd.symbol, id: `${pd.id}-tp1`, qty: qround(pd.symbol, pd.qty / 2), price: pd.tp1 })
      emit(t, 'tp.placed', { symbol: pd.symbol, id: `${pd.id}-tp2`, qty: qround(pd.symbol, pd.qty / 2), price: pd.tp2 })
    }

    for (const p of [...positions]) {
      const age = (t - p.openedAt) / p.life
      const target = p.win ? (p.tp1Done ? p.tp2 : p.tp1) : p.stop0 * 0.999
      const from = p.tp1Done ? p.tp1 : p.entry
      const progress = Math.min(1, Math.max(0, p.tp1Done ? (age - 0.5) * 2 : age * (p.win ? 2 : 1.3)))
      const px = from + (target - from) * progress + gauss() * p.entry * 0.0006
      price[p.symbol] = px
      if (!p.tp1Done && p.win && px >= p.tp1) {
        p.tp1Done = true
        const q = qround(p.symbol, p.qty / 2)
        p.qtyLeft = Math.max(0, p.qtyLeft - q)
        p.realized += q * p.tp1 * (1 - MAKER)
        p.fees += q * p.tp1 * MAKER
        p.stop = fx(p.symbol, p.entry * 1.0005)
        emit(t, 'tp.filled', { symbol: p.symbol, id: `${p.id}-tp1`, qty: q, price: p.tp1, newStop: p.stop })
      } else if (!p.win && px <= p.stop) {
        emit(t, 'stop.hit', { symbol: p.symbol, reason: 'stop loss', stop: p.stop, bid: fx(p.symbol, px), qty: p.qtyLeft, now: Math.floor(t / 1000) })
        close(t, p, px * (1 - 0.003), 'stop loss')
      } else if (p.tp1Done && px >= p.tp2) {
        close(t, p, p.tp2, 'take profit')
      } else if (p.tp1Done && age > 1.1) {
        close(t, p, px, 'time stop')
      }
    }

    if (scenario === 'halt' && !haltedDay) {
      shock += START * 0.0035 * Math.min(dt, 5)
      if (equity() <= dayPeak * (1 - 0.12)) {
        haltedDay = true
        emit(t, 'daemon.api_error', { kind: 'quote', error: 'Error: HTTP 503 from upstream', consecutive: 1, symbol: 'PEPETMN', backoffMs: 10000 })
      }
    }
    if (scenario === 'normal' && haltedDay) {
      haltedDay = false
      shock = 0
      dayPeak = equity()
    }
    if (scenario === 'normal' && shock > 0) shock = Math.max(0, shock - START * 0.002 * Math.min(dt, 5))
  }

  function close(t: number, p: SimPos, px: number, how: string) {
    positions.splice(positions.indexOf(p), 1)
    const proceeds = p.realized + p.qtyLeft * px * (1 - TAKER)
    const cost = p.qty * p.entry * (1 + MAKER)
    const pnl = proceeds - cost
    const eqAtEntry = equity()
    realized += pnl
    consecutiveLosses = pnl < 0 ? consecutiveLosses + 1 : 0
    emit(t, 'exit', { symbol: p.symbol, id: p.id, how, qty: p.qty, entry: p.entry, pnlTmn: Math.round(pnl), pnlFraction: pnl / eqAtEntry, equityAtEntry: Math.round(eqAtEntry), dustQty: 0, feeTmn: Math.round(p.qty * p.entry * MAKER + p.fees + p.qtyLeft * px * TAKER) })
  }

  let started = false
  function start() {
    if (started) return
    started = true
    const now = nowMs()
    emit(t0, 'daemon.start', { mode: 'paper', symbols: names, runEnd: new Date(runEnd).toISOString(), entryCutoffAt: new Date(cutoff).toISOString(), startEquity: START, resumed: false, strategy: 'ict', startHoldings: [] })
    for (const s of names) emit(t0 + 1500, 'poll.warmup', { symbol: s, bars: 1440 })
    const dt = 30_000
    const wasScenario = scenario
    scenario = 'normal'
    for (let t = t0 + dt; t < now; t += dt) {
      step(t, dt / 1000)
      if (r() < 0.16) spawnSetup(t)
      if (r() < 0.012) emit(t, 'poll.error', { symbol: pick(names), error: 'Error: fetch failed: request timed out after 10000 ms' })
      heartbeat(t)
    }
    scenario = wasScenario
  }

  function tick() {
    start()
    const t = nowMs()
    const dt = lastTick ? Math.max(0.2, Math.min(5, (t - lastTick) / 1000)) : 1
    lastTick = t
    step(t, dt)
    if (r() < 0.07) spawnSetup(t)
    if (r() < 0.012) emit(t, 'poll.error', { symbol: pick(names), error: 'Error: fetch failed: request timed out after 10000 ms' })
    if (!lastHb || t - lastHb >= 2000) {
      heartbeat(t)
      lastHb = t
    }
  }

  return {
    start,
    tick,
    setScenario(s: Scenario) {
      scenario = s
    },
    get scenario() {
      return scenario
    },
    get equity() {
      return lastEquity
    },
    run(everyMs = 1000) {
      start()
      const h = setInterval(tick, everyMs)
      ;(h as { unref?: () => void }).unref?.()
      return () => clearInterval(h)
    },
  }
}
