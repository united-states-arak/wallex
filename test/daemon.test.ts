import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { guardedExchange, resolveSchedule, runDaemon, stateExposure, type DaemonRest, type StatefulStrategy } from '../src/daemon'
import { PaperExchange } from '../src/exchange/paper'
import type { Log } from '../src/log'
import type { Exchange, OrderReq } from '../src/types'
import { bar, meta } from './fixtures'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'daemon-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function capture() {
  const events: { event: string; data: Record<string, unknown> }[] = []
  const log: Log = (event, data = {}) => {
    events.push({ event, data })
  }
  return { events, log, of: (name: string) => events.filter((e) => e.event === name) }
}

// Scripted market: history() returns a warm-up window first, then one extra closed bar per later call.
function fakeRest(): DaemonRest & { calls: number } {
  const t0 = Math.floor(Date.now() / 60_000) * 60 - 600
  let calls = 0
  return {
    get calls() {
      return calls
    },
    hasKey: true,
    markets: async () => meta,
    depth: async () => ({ bid: 1.19, ask: 1.2 }),
    history: async (_symbol, from) => {
      calls++
      const extra = Math.min(calls, 5)
      const out = []
      for (let i = 0; i <= extra; i++) out.push(bar(t0 + i * 60, 1.2, 1.21, 1.19, 1.2))
      return out.filter((c) => c.t >= from - 3600)
    },
  }
}

const buy = (id: string): OrderReq => ({ clientId: id, symbol: 'PEPETMN', side: 'BUY', type: 'LIMIT', price: 1.3, quantity: 1_000_000, reason: 'test' })

interface Stub {
  barCalls: number
  tickCalls: number
  enabled: boolean[]
  restored: unknown
  strategy: StatefulStrategy
}

function stub(over: Partial<StatefulStrategy> = {}): Stub {
  const s: Stub = {
    barCalls: 0,
    tickCalls: 0,
    enabled: [] as boolean[],
    restored: undefined as unknown,
    strategy: {
      name: 'stub',
      async onBar() {
        s.barCalls++
        if (s.barCalls === 1) return [buy('b1')]
        if (s.barCalls === 2) throw new Error('boom in onBar')
        return []
      },
      onTick() {
        s.tickCalls++
        return []
      },
      setEntriesEnabled(e: boolean) {
        s.enabled.push(e)
      },
      getState: () => ({ barCalls: s.barCalls }),
      restoreState(x: unknown) {
        s.restored = x
      },
      openPositions: () => [],
      ...over,
    } as StatefulStrategy,
  }
  return s
}

const fast = { tickMs: 100, pollMs: 100, verifyMs: 200, pulloutWaitMs: 0, signals: false }

test('runs, survives an onBar exception, stops entries at the cutoff, flattens to TMN and writes state', async () => {
  const c = capture()
  const ex = new PaperExchange(meta, new Set(), { TMN: 5_000_000 })
  const st = stub()
  const runEnd = Date.now() + 3_500
  const res = await runDaemon({
    ...fast,
    rest: fakeRest(),
    mode: 'paper',
    symbols: ['PEPETMN'],
    meta,
    ex,
    log: c.log,
    runEnd,
    entryCutoffMin: 2.4 / 60,
    flattenMin: 1.4 / 60,
    stateDir: dir,
    makeStrategy: () => st.strategy,
  })

  const start = c.of('daemon.start')[0]!.data
  expect(start).toMatchObject({ mode: 'paper', symbols: ['PEPETMN'], startEquity: 5_000_000 })
  expect(typeof start.sha).toBe('string')
  expect(c.of('daemon.heartbeat').length).toBeGreaterThan(2)
  const hb = c.of('daemon.heartbeat')[0]!.data
  expect(hb).toHaveProperty('guard')
  expect(hb).toHaveProperty('barAgeSec')
  expect(hb).toHaveProperty('marks')
  expect(c.of('daemon.heartbeat').some((h) => (h.data.marks as Record<string, number>).PEPETMN > 0)).toBe(true)
  expect(hb).toHaveProperty('api')

  // the exception in onBar was logged and later bars were still processed
  expect(c.of('daemon.strategy_error').length).toBeGreaterThanOrEqual(1)
  expect(st.barCalls).toBeGreaterThanOrEqual(3)
  expect(st.tickCalls).toBeGreaterThan(0)

  expect(st.enabled).toEqual([false])
  expect(c.of('daemon.entries_disabled')).toHaveLength(1)
  expect(c.of('daemon.flatten_phase')).toHaveLength(1)
  expect(c.of('daemon.flatten').length).toBeGreaterThanOrEqual(1)

  const bals = await ex.balances()
  expect(ex.fills.some((f) => f.side === 'BUY')).toBe(true)
  expect(bals.PEPE!.free + bals.PEPE!.locked).toBe(0)
  expect(bals.TMN!.free).toBeGreaterThan(4_000_000)

  expect(res).toMatchObject({ reason: 'run_end', flat: true, positionsLeft: [] })
  expect(Date.now()).toBeGreaterThanOrEqual(runEnd)
  expect(c.of('daemon.stop')).toHaveLength(1)

  for (const f of ['paper-run.json', 'paper-guard.json', 'paper-strategy.json']) expect(existsSync(join(dir, f))).toBe(true)
  expect(JSON.parse(readFileSync(join(dir, 'paper-strategy.json'), 'utf8')).state.barCalls).toBeGreaterThanOrEqual(1)
  expect(JSON.parse(readFileSync(join(dir, 'paper-guard.json'), 'utf8')).startEquity).toBe(5_000_000)
  expect(JSON.parse(readFileSync(join(dir, 'paper-run.json'), 'utf8')).runEnd).toBe(new Date(runEnd).toISOString())
}, 15_000)

test('buy orders after the cutoff are refused even if the strategy ignores setEntriesEnabled', async () => {
  const c = capture()
  const ex = new PaperExchange(meta, new Set(), { TMN: 5_000_000 })
  let n = 0
  const st = stub({ onBar: async () => [buy(`late${n++}`)], setEntriesEnabled: undefined })
  await runDaemon({
    ...fast,
    rest: fakeRest(),
    mode: 'paper',
    symbols: ['PEPETMN'],
    meta,
    ex,
    log: c.log,
    runEnd: Date.now() + 2_000,
    entryCutoffMin: 5, // already past the cutoff at start
    flattenMin: 0.01,
    stateDir: dir,
    makeStrategy: () => st.strategy,
  })
  expect(c.of('order.ack').some((e) => e.data.error === 'entries disabled')).toBe(true)
  expect(ex.fills.filter((f) => f.side === 'BUY')).toHaveLength(0)
}, 15_000)

test('abort signal stops entries, cancels pending BUY orders only and reports open positions', async () => {
  const c = capture()
  const ex = new PaperExchange(meta, new Set(), { TMN: 5_000_000, PEPE: 2_000_000 })
  ex.setQuote('PEPETMN', 1.19, 1.2)
  await ex.place({ clientId: 'tp1', symbol: 'PEPETMN', side: 'SELL', type: 'LIMIT', price: 2, quantity: 500_000, reason: 'resting tp' })
  let placed = false
  const st = stub({
    onBar: async ({ ex: e }) => {
      if (!placed) {
        placed = true
        await e.place({ clientId: 'pend', symbol: 'PEPETMN', side: 'BUY', type: 'LIMIT', price: 1.0, quantity: 100_000, reason: 'pending entry' })
      }
      return []
    },
  })
  const ac = new AbortController()
  const run = runDaemon({
    ...fast,
    rest: fakeRest(),
    mode: 'paper',
    symbols: ['PEPETMN'],
    meta,
    ex,
    log: c.log,
    runEnd: Date.now() + 2 * 3_600_000,
    stateDir: dir,
    signal: ac.signal,
    makeStrategy: () => st.strategy,
  })
  await Bun.sleep(1_200)
  ac.abort()
  const res = await run
  expect(res.reason).toBe('signal')
  expect(placed).toBe(true)
  const open = (await ex.openOrders()).map((o) => o.clientId)
  expect(open).toEqual(['tp1'])
  expect(res.flat).toBe(false)
  expect(res.positionsLeft).toEqual(['PEPE'])
  expect(c.of('daemon.cancel_entry').map((e) => e.data.clientId)).toEqual(['pend'])
  expect(c.of('daemon.unflat_exit')).toHaveLength(1)
  expect(existsSync(join(dir, 'paper-strategy.json'))).toBe(true)
}, 15_000)

test('live start aborts clearly when balances have no TMN entry', async () => {
  const ex: Exchange = {
    mode: 'live',
    balances: async () => ({}),
    quote: async () => ({ bid: 1, ask: 1 }),
    place: async (o) => ({ clientId: o.clientId, status: 'REJECTED' }),
    cancel: async () => {},
    openOrders: async () => [],
  }
  await expect(
    runDaemon({ ...fast, rest: fakeRest(), mode: 'live', symbols: ['PEPETMN'], meta, ex, runEnd: Date.now() + 5_000, stateDir: dir, makeStrategy: () => stub().strategy }),
  ).rejects.toThrow(/no TMN entry/)
})

test('state is restored only for the same RUN_END', async () => {
  const runEnd = Date.now() + 2 * 3_600_000
  const run = async (end: number, st: Stub) => {
    const ac = new AbortController()
    const p = runDaemon({
      ...fast,
      rest: fakeRest(),
      mode: 'paper',
      symbols: ['PEPETMN'],
      meta,
      ex: new PaperExchange(meta, new Set(), { TMN: 5_000_000 }),
      runEnd: end,
      stateDir: dir,
      signal: ac.signal,
      makeStrategy: () => st.strategy,
    })
    await Bun.sleep(700)
    ac.abort()
    await p
  }
  await run(runEnd, stub())
  const resumed = stub()
  await run(runEnd, resumed)
  expect(resumed.restored).toMatchObject({ barCalls: expect.any(Number) })
  const fresh = stub()
  await run(runEnd + 1_000, fresh)
  expect(fresh.restored).toBeUndefined()
}, 15_000)

// A different RUN_END normally starts clean, but saved positions or pending entries must survive the restart.
async function restartWith(savedState: unknown) {
  const prevEnd = new Date(Date.now() + 3_600_000).toISOString()
  writeFileSync(join(dir, 'paper-run.json'), JSON.stringify({ runEnd: prevEnd, startEquity: 5_000_000, startedAt: prevEnd, sha: 't' }))
  writeFileSync(join(dir, 'paper-strategy.json'), JSON.stringify({ savedAt: prevEnd, state: savedState }))
  const c = capture()
  let restored: unknown
  const st = stub({
    restoreState: (x: unknown) => void (restored = x),
    getState: () => restored ?? null,
  })
  const ac = new AbortController()
  const p = runDaemon({
    ...fast,
    rest: fakeRest(),
    mode: 'paper',
    symbols: ['PEPETMN'],
    meta,
    ex: new PaperExchange(meta, new Set(), { TMN: 5_000_000 }),
    runEnd: Date.now() + 2 * 3_600_000,
    stateDir: dir,
    signal: ac.signal,
    log: c.log,
    makeStrategy: () => st.strategy,
  })
  await Bun.sleep(500)
  ac.abort()
  await p
  const file = join(dir, 'paper-strategy.json')
  return { c, restored, saved: existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')).state : undefined }
}

test('a new RUN_END keeps saved state that still has open positions or pending entries', async () => {
  const state = { positions: { PEPETMN: { symbol: 'PEPETMN', qty: 10 } }, pending: {}, traded: [] }
  const r = await restartWith(state)
  expect(r.restored).toEqual(state)
  expect(r.saved).toEqual(state)
  expect(r.c.of('daemon.state_kept')[0]!.data.exposure).toEqual(['positions: PEPETMN'])
  expect(r.c.of('daemon.start')[0]!.data).toMatchObject({ stateKept: true, resumed: false })

  const pend = await restartWith({ positions: {}, pending: { DOGETMN: { id: 'x' } } })
  expect(pend.c.of('daemon.state_kept').length).toBe(1)
}, 15_000)

test('a new RUN_END discards saved state that is flat', async () => {
  const r = await restartWith({ positions: {}, pending: {}, traded: ['PEPETMN'] })
  expect(r.restored).toBeUndefined()
  expect(r.c.of('daemon.state_kept').length).toBe(0)
  expect(r.c.of('daemon.start')[0]!.data.stateKept).toBe(false)
}, 15_000)

test('stateExposure lists open positions and pending entries only', () => {
  expect(stateExposure(null)).toEqual([])
  expect(stateExposure({ barCalls: 3 })).toEqual([])
  expect(stateExposure({ positions: {}, pending: {} })).toEqual([])
  expect(stateExposure({ positions: { A: {} }, pending: { B: {}, C: {} } })).toEqual(['positions: A', 'pending: B,C'])
  expect(stateExposure({ positions: [{}] })).toEqual(['positions: 0'])
})

test('guardedExchange counts accepted entries only and refuses entries when disabled', async () => {
  const entries: number[] = []
  let on = true
  const raw: Exchange = {
    mode: 'paper',
    balances: async () => ({}),
    quote: async () => ({ bid: 1, ask: 1 }),
    place: async (o) => ({ clientId: o.clientId, status: o.clientId.startsWith('bad') ? 'REJECTED' : 'NEW' }),
    cancel: async () => {},
    openOrders: async () => [],
  }
  const ex = guardedExchange(raw, { guard: { recordEntry: (t) => entries.push(t) }, now: () => 42, entriesOn: () => on })
  await ex.place(buy('ok1'))
  await ex.place(buy('bad1'))
  await ex.place({ ...buy('s1'), side: 'SELL' })
  expect(entries).toEqual([42])
  on = false
  expect((await ex.place(buy('ok2'))).error).toBe('entries disabled')
  expect((await ex.place({ ...buy('s2'), side: 'SELL' })).status).toBe('NEW')
})

test('resolveSchedule reads env, flags override, bad RUN_END throws', () => {
  const now = Date.parse('2026-01-01T00:00:00Z')
  const d = resolveSchedule({}, {}, now)
  expect(d).toMatchObject({ runEnd: now + 86_400_000, defaulted: true, entryCutoffMin: 45, flattenMin: 15 })
  const e = resolveSchedule({}, { RUN_END: '2026-01-02T12:00:00Z', ENTRY_CUTOFF_MIN: '30', FLATTEN_MIN: '10' }, now)
  expect(e).toMatchObject({ runEnd: Date.parse('2026-01-02T12:00:00Z'), defaulted: false, entryCutoffMin: 30, flattenMin: 10 })
  expect(resolveSchedule({ flattenMin: 5 }, {}, now).flattenMin).toBe(5)
  expect(() => resolveSchedule({}, { RUN_END: 'nope' }, now)).toThrow(/RUN_END/)
})

test('resolveSchedule follows the run settings, including STARCOACH__ overrides', () => {
  const now = Date.parse('2026-01-01T00:00:00Z')
  const r = resolveSchedule({}, { STARCOACH__run__defaultHours: '6', STARCOACH__run__flattenMin: '5' }, now)
  expect(r).toMatchObject({ runEnd: now + 6 * 3_600_000, defaulted: true, flattenMin: 5 })
})
