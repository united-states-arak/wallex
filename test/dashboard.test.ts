import { afterEach, describe, expect, test } from 'bun:test'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDemo } from '../src/dashboard/demo'
import { startDashboard } from '../src/dashboard/server'
import { createView, fold, limitsFromSettings, LogTailer, parseLine, reasonKey, Store } from '../src/dashboard/state'
import { loadSettings, type DeepPartial, type Settings } from '../src/settings'

const T0 = Date.parse('2026-10-22T10:00:00.000Z')
const iso = (sec: number) => new Date(T0 + sec * 1000).toISOString()
const ev = (sec: number, event: string, data: Record<string, unknown> = {}) => ({ ts: iso(sec), sha: 'abc1234', event, ...data })
const guard = (equity: number, extra: Record<string, unknown> = {}) => ({ equity, startEquity: 5_000_000, dayPeak: 5_100_000, dayPnlPct: equity / 5_000_000 - 1, totalPnlPct: equity / 5_000_000 - 1, consecutiveLosses: 0, halted: false, riskPct: 0.01, ...extra })
const pos = { symbol: 'PEPETMN', qty: 1000, entry: 0.6, stop: 0.58, tp1: 0.64, notional: 600 }

const canned = () => [
  ev(0, 'daemon.start', { mode: 'paper', symbols: ['PEPETMN', 'DOGETMN'], runEnd: iso(7200), entryCutoffAt: iso(4500), flattenAt: iso(6300), startEquity: 5_000_000, strategy: 'ict' }),
  ev(1, 'daemon.heartbeat', { mode: 'paper', phase: 'trading', equity: 5_000_000, guard: guard(5_000_000), blockReason: null, positions: [], barAgeSec: { PEPETMN: 10, DOGETMN: 20 }, api: { total: 0, consecutive: 0, byKind: {} }, strategyErrors: 0 }),
  ev(10, 'setup.rejected', { symbol: 'PEPETMN', reason: 'net RR too low', netRr: 1.1 }),
  ev(11, 'setup.rejected', { symbol: 'DOGETMN', reason: 'net RR too low' }),
  ev(12, 'setup.rejected', { symbol: 'DOGETMN', reason: 'guard: loss pause: 3 losses in a row, resumes in 12 min' }),
  ev(13, 'ai.verdict', { symbol: 'PEPETMN', action: 'approve', sizeMult: 1, reason: 'clean sweep', source: 'ai', model: 'm', latencyMs: 2000 }),
  ev(14, 'ai.verdict', { symbol: 'PEPETMN', action: 'approve', sizeMult: 1, reason: 'supervisor timeout', source: 'fallback', model: 'none', latencyMs: 0 }),
  ev(15, 'setup.accepted', { symbol: 'PEPETMN', entry: 0.6, stop: 0.58, tp1: 0.64, qty: 1000, notional: 600, verdict: 'approve', verdictReason: 'clean sweep' }),
  ev(16, 'order.intent', { clientId: 'e1', symbol: 'PEPETMN', side: 'BUY', type: 'LIMIT', price: 0.6, quantity: 1000, reason: 'ict' }),
  ev(16, 'order.ack', { clientId: 'e1', status: 'NEW' }),
  ev(17, 'entry.placed', { symbol: 'PEPETMN', id: 'e1', qty: 1000, entry: 0.6, stop: 0.58, tp1: 0.64, tp2: 0.7, status: 'NEW' }),
  ev(30, 'entry.filled', { symbol: 'PEPETMN', id: 'e1', qty: 1000, entry: 0.6, stop: 0.58, tp1: 0.64, tp2: 0.7 }),
  ev(31, 'daemon.heartbeat', { mode: 'paper', phase: 'trading', equity: 5_050_000, guard: guard(5_050_000), blockReason: null, positions: [pos], barAgeSec: { PEPETMN: 5, DOGETMN: 200 }, api: { total: 1, consecutive: 0, byKind: { quote: 1 } }, strategyErrors: 0 }),
  ev(60, 'daemon.heartbeat', { mode: 'paper', phase: 'trading', equity: 5_100_000, guard: guard(5_100_000), blockReason: null, positions: [pos], barAgeSec: {}, api: { total: 1, consecutive: 0, byKind: {} }, strategyErrors: 0 }),
  ev(70, 'exit', { symbol: 'PEPETMN', id: 'e1', how: 'take profit', qty: 1000, entry: 0.6, pnlTmn: 40000, pnlFraction: 0.008 }),
  ev(71, 'poll.error', { symbol: 'DOGETMN', error: 'timeout' }),
  ev(72, 'exit', { symbol: 'DOGETMN', id: 'x2', how: 'stop loss', qty: 10, entry: 100, pnlTmn: -20000, pnlFraction: -0.004 }),
]

function folded(events = canned()) {
  const v = createView()
  for (const e of events) fold(v, e)
  return v
}

describe('fold', () => {
  test('builds equity series, positions, trades and histograms', () => {
    const store = new Store({ logDir: '/nonexistent', stateDir: '/nonexistent', killFile: '/nonexistent/STOP', mode: 'replay', clock: () => T0 + 120_000 })
    for (const e of canned()) store.ingest(e)
    const s = store.snapshot()
    expect(s.equity.series!.map((p) => p[1])).toEqual([5_000_000, 5_050_000, 5_100_000])
    expect(s.equity.start).toBe(5_000_000)
    expect(s.equity.pnlPct).toBeCloseTo(0.02)
    expect(s.equity.peak).toBe(5_100_000)
    expect(s.run.mode).toBe('paper')
    expect(s.run.phase).toBe('trading')
    expect(s.positions).toHaveLength(0)
    expect(s.pending).toHaveLength(0)
    expect(s.trades.count).toBe(2)
    expect(s.trades.wins).toBe(1)
    expect(s.trades.winRate).toBe(0.5)
    expect(s.trades.rows[1]!.r).toBeCloseTo(40000 / (1000 * 0.02))
    expect(s.setups.accepted).toBe(1)
    expect(s.setups.rejected).toBe(3)
    expect(s.setups.reasons).toEqual([
      { reason: 'net RR too low', count: 2 },
      { reason: 'guard: loss pause', count: 1 },
    ])
    expect(s.ai.n).toBe(2)
    expect(s.ai.fallbackRate).toBe(0.5)
    expect(s.ai.avgLatencyMs).toBe(2000)
    expect(s.orders[0]!.status).toBe('NEW')
    expect(s.system.errors.pollErrors).toBe(1)
    expect(s.system.symbols.find((x) => x.symbol === 'DOGETMN')).toBeTruthy()
    expect(s.gauges.dayLoss.limit).toBe(0.12)
    expect(s.gauges.drawdown.limit).toBe(0.3)
  })

  test('tracks an open position from the heartbeat before the exit', () => {
    const v = folded(canned().slice(0, 14))
    expect(v.positions).toHaveLength(1)
    expect(v.positions[0]!.stop0).toBe(0.58)
    expect(v.positions[0]!.symbol).toBe('PEPETMN')
  })

  test('phase follows run end, cutoff and flatten times', () => {
    const at = (sec: number, extra: ReturnType<typeof canned> = []) => {
      const store = new Store({ logDir: '/x', stateDir: '/x', killFile: '/x/STOP', mode: 'replay', clock: () => T0 + sec * 1000 })
      for (const e of [canned()[0]!, ...extra]) store.ingest(e)
      return store.snapshot().run.phase
    }
    expect(at(100)).toBe('trading')
    expect(at(4600)).toBe('cutoff')
    expect(at(6400)).toBe('flattening')
    expect(at(7300)).toBe('done')
    expect(at(100, [ev(90, 'daemon.stop', { reason: 'signal', flat: true })])).toBe('done')
  })

  test('malformed lines and unknown events never crash the view', () => {
    const store = new Store({ logDir: '/x', stateDir: '/x', killFile: '/x/STOP', mode: 'replay' })
    const bad = ['', '{', 'not json', '[]', '123', '{"event":5}', '{"ts":"x"}', 'null', '{"event":""}']
    for (const l of bad) expect(store.ingestLine(l)).toBe(false)
    expect(store.ingestLine(JSON.stringify(ev(0, 'brand.new_event', { whatever: [1, 2] })))).toBe(true)
    expect(store.ingestLine(JSON.stringify({ event: 'daemon.heartbeat', equity: 'oops', guard: 5, positions: [null, 3, { symbol: 1 }], api: 'x', barAgeSec: [] }))).toBe(true)
    expect(store.ingestLine(JSON.stringify({ event: 'setup.rejected' }))).toBe(true)
    expect(store.ingestLine(JSON.stringify({ event: 'exit', symbol: 'A' }))).toBe(true)
    expect(() => store.snapshot()).not.toThrow()
    expect(store.snapshot().setups.reasons[0]!.reason).toBe('unknown')
    expect(parseLine('{"event":"x","ts":1}')?.ts).toBe('')
  })

  test('reasonKey groups reasons by their stable part', () => {
    expect(reasonKey('guard: max entries per hour (6)')).toBe('guard: max entries per hour')
    expect(reasonKey('no quote: Error: boom')).toBe('no quote')
    expect(reasonKey('sizing: below min notional 100')).toBe('sizing: below min notional')
    expect(reasonKey('spread too wide')).toBe('spread too wide')
  })
})

describe('tailer', () => {
  const dirs: string[] = []
  const tmp = () => {
    const d = mkdtempSync(join(tmpdir(), 'dash-'))
    dirs.push(d)
    return d
  }
  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true })
  })

  test('handles partial last lines incrementally', () => {
    const d = tmp()
    const f = join(d, 'live-2026-01-01T00-00-00-000Z.jsonl')
    const line = JSON.stringify(ev(0, 'daemon.start', { mode: 'dry' }))
    writeFileSync(f, line + '\n{"event":"poll.err')
    const t = new LogTailer(d)
    expect(t.poll().lines).toEqual([line])
    expect(t.poll().lines).toEqual([])
    appendFileSync(f, 'or","ts":"2026-10-22T10:00:00.000Z"}\n')
    const r = t.poll()
    expect(r.lines).toEqual(['{"event":"poll.error","ts":"2026-10-22T10:00:00.000Z"}'])
    expect(r.reset).toBe(false)
  })

  test('switches to a newer file and resets, reads only the tail of huge files', () => {
    const d = tmp()
    const a = join(d, 'live-a.jsonl')
    writeFileSync(a, JSON.stringify(ev(0, 'daemon.start')) + '\n')
    utimesSync(a, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000))
    const t = new LogTailer(d, 400)
    expect(t.poll().lines).toHaveLength(1)
    const b = join(d, 'live-b.jsonl')
    const big = Array.from({ length: 50 }, (_, i) => JSON.stringify(ev(i, 'poll.warmup', { symbol: 'S' + i }))).join('\n') + '\n'
    writeFileSync(b, big)
    const r = t.poll()
    expect(r.reset).toBe(true)
    expect(t.file).toBe('live-b.jsonl')
    expect(r.lines.length).toBeGreaterThan(0)
    expect(r.lines.length).toBeLessThan(50)
    expect(r.lines.every((l) => parseLine(l) !== null)).toBe(true)
    expect(parseLine(r.lines.at(-1)!)?.symbol).toBe('S49')
  })

  test('store refresh folds new lines and resets the view on a new file', () => {
    const d = tmp()
    mkdirSync(join(d, 'logs'))
    const a = join(d, 'logs', 'live-a.jsonl')
    writeFileSync(a, canned().slice(0, 3).map((e) => JSON.stringify(e)).join('\n') + '\n')
    utimesSync(a, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000))
    const store = new Store({ logDir: join(d, 'logs'), stateDir: join(d, 'state'), killFile: join(d, 'STOP') })
    store.refresh(0)
    expect(store.view.run.mode).toBe('paper')
    expect(store.view.setupCounts.rejected).toBe(1)
    writeFileSync(join(d, 'logs', 'live-b.jsonl'), JSON.stringify(ev(0, 'daemon.start', { mode: 'dry' })) + '\n')
    store.refresh(0)
    expect(store.view.run.mode).toBe('dry')
    expect(store.view.setupCounts.rejected).toBe(0)
  })

  test('falls back to state files when no log exists', () => {
    const d = tmp()
    mkdirSync(join(d, 'state'))
    writeFileSync(join(d, 'state', 'dry-run.json'), JSON.stringify({ runEnd: iso(3600), startEquity: 1_000_000, startedAt: iso(0), sha: 'ff00aa1' }))
    writeFileSync(join(d, 'state', 'dry-guard.json'), JSON.stringify({ startEquity: 1_000_000, equity: 900_000, day: 1, dayStart: 1_000_000, dayPeak: 1_000_000, dailyHaltDay: null, hardHalt: null, consecutiveLosses: 2 }))
    const store = new Store({ logDir: join(d, 'logs'), stateDir: join(d, 'state'), killFile: join(d, 'STOP'), clock: () => T0 + 1000 })
    store.refresh(0)
    const s = store.snapshot()
    expect(s.run.mode).toBe('dry')
    expect(s.run.startEquity).toBe(1_000_000)
    expect(s.guard?.consecutiveLosses).toBe(2)
    expect(s.equity.last).toBe(900_000)
    expect(s.gauges.dayLoss.value).toBeCloseTo(0.1)
  })
})

describe('marks and fees', () => {
  const entered = () => {
    const v = createView()
    fold(v, ev(0, 'daemon.start', { mode: 'paper', symbols: ['PEPETMN'], runEnd: iso(7200), startEquity: 5_000_000 }))
    fold(v, ev(1, 'entry.filled', { symbol: 'PEPETMN', id: 'e1', qty: 1000, entry: 0.6, stop: 0.58, tp1: 0.64 }))
    return v
  }
  const snapOf = (v: ReturnType<typeof createView>) => {
    const store = new Store({ logDir: '/x', stateDir: '/x', killFile: null, mode: 'demo' })
    store.view = v
    return store.snapshot()
  }

  test('heartbeat marks give unrealized % and distance to stop, with a per-position mark taking precedence', () => {
    const v = entered()
    fold(v, ev(5, 'daemon.heartbeat', { positions: [pos], marks: { PEPETMN: 0.63 } }))
    let p = snapOf(v).positions[0]!
    expect(p.mark).toBe(0.63)
    expect(p.unrealizedPct).toBeCloseTo(0.05)
    expect(p.distToStopPct).toBeCloseTo((0.63 - 0.58) / 0.63)
    fold(v, ev(6, 'daemon.heartbeat', { positions: [{ ...pos, mark: 0.57 }], marks: { PEPETMN: 0.63 } }))
    p = snapOf(v).positions[0]!
    expect(p.mark).toBe(0.57)
    expect(p.distToStopPct!).toBeLessThan(0)
  })

  test('old heartbeats without marks leave the fields empty', () => {
    const v = entered()
    fold(v, ev(5, 'daemon.heartbeat', { positions: [pos] }))
    const p = snapOf(v).positions[0]!
    expect(p.mark).toBeNull()
    expect(p.unrealizedPct).toBeNull()
    expect(p.distToStopPct).toBeNull()
  })

  test('exit fees: feeTmn is exact, feeTmnEst is flagged, old exits have none', () => {
    const v = entered()
    fold(v, ev(70, 'exit', { symbol: 'PEPETMN', id: 'e1', how: 'take profit', qty: 1000, entry: 0.6, pnlTmn: 40000, feeTmn: 2500 }))
    fold(v, ev(71, 'exit', { symbol: 'DOGETMN', id: 'e2', how: 'stop', qty: 10, entry: 1, pnlTmn: -5, feeTmnEst: 100 }))
    fold(v, ev(72, 'exit', { symbol: 'XRPTMN', id: 'e3', how: 'stop', qty: 10, entry: 1, pnlTmn: -5 }))
    expect(v.trades.map((t) => [t.fees, t.feesEst])).toEqual([[2500, false], [100, true], [null, false]])
    const s = snapOf(v)
    expect(s.trades.fees).toBe(2600)
    expect(s.trades.feesEst).toBe(true)
  })
})

describe('settings wiring', () => {
  const dirs: string[] = []
  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true })
  })
  const cfg = (overrides: DeepPartial<Settings> = {}): Settings => {
    const configDir = mkdtempSync(join(tmpdir(), 'dash-cfg-'))
    dirs.push(configDir)
    return loadSettings({ configDir, env: {}, overrides })
  }

  const open: { close: () => void }[] = []
  afterEach(() => {
    while (open.length) open.pop()!.close()
  })
  const boot2 = (settings: Settings, extra: Parameters<typeof startDashboard>[0] = {}) => {
    const root = mkdtempSync(join(tmpdir(), 'dash-root-'))
    dirs.push(root)
    const d = startDashboard({ port: 0, root, refreshMs: 0, settings, ...extra })
    open.push(d)
    return { d, root }
  }
  const stopPost = (base: string, enabled: boolean) =>
    fetch(`${base}/api/stop`, { method: 'POST', body: JSON.stringify({ enabled }), headers: { 'content-type': 'application/json', 'x-confirm': 'stop' } })

  test('gauge limits come from settings.risk', async () => {
    const settings = cfg({ risk: { dayLossHalt: 0.05, hardDrawdown: 0.2, riskPct: 0.02, lockTiers: [{ pnl: 0.1, riskPct: 0.01 }, { pnl: 0.2, riskPct: 0.005 }] } })
    expect(limitsFromSettings(settings)).toEqual({ riskPct: 0.02, lock1Pnl: 0.1, lock1Risk: 0.01, lock2Pnl: 0.2, lock2Risk: 0.005, dailyLossHalt: 0.05, hardDrawdown: 0.2 })
    const { d } = boot2(settings)
    const s = await (await fetch(d.url + '/api/state')).json()
    expect(s.gauges.dayLoss.limit).toBe(0.05)
    expect(s.gauges.drawdown.limit).toBe(0.2)
    expect(s.gauges.risk).toMatchObject({ lock1: 0.1, lock2: 0.2 })
  })



  test('kill switch uses risk.killFile (parent dir created), detects an existing file, and reads log and state dirs from settings', async () => {
    const settings = cfg({ risk: { killFile: 'control/STOP' }, logging: { dir: 'out/logs', stateDir: 'out/state' } })
    const { d, root } = boot2(settings)
    expect(existsSync(join(root, 'control'))).toBe(true)
    expect(d.store.currentLogFile).toBeNull()
    mkdirSync(join(root, 'out', 'logs'), { recursive: true })
    writeFileSync(join(root, 'out', 'logs', 'live-x.jsonl'), canned().map((e) => JSON.stringify(e)).join('\n') + '\n')
    const s = await (await fetch(d.url + '/api/state')).json()
    expect(s.run.mode).toBe('paper')
    expect(s.killFile).toBe('control/STOP')
    expect(s.killSwitch).toBe(false)
    expect((await stopPost(d.url, true)).status).toBe(200)
    expect(existsSync(join(root, 'control', 'STOP'))).toBe(true)
    expect(existsSync(join(root, 'STOP'))).toBe(false)
    expect((await (await fetch(d.url + '/api/state')).json()).killSwitch).toBe(true)
    expect((await stopPost(d.url, false)).status).toBe(200)
    expect(existsSync(join(root, 'control', 'STOP'))).toBe(false)
  })

  test('an existing kill file at the configured path is detected and a missing parent dir is created on engage', async () => {
    const settings = cfg({ risk: { killFile: 'deep/er/STOP' } })
    const root = mkdtempSync(join(tmpdir(), 'dash-root-'))
    dirs.push(root)
    mkdirSync(join(root, 'deep', 'er'), { recursive: true })
    writeFileSync(join(root, 'deep', 'er', 'STOP'), 'x')
    const d = startDashboard({ port: 0, root, refreshMs: 0, settings })
    open.push(d)
    expect((await (await fetch(d.url + '/api/state')).json()).killSwitch).toBe(true)
    rmSync(join(root, 'deep'), { recursive: true })
    expect((await stopPost(d.url, true)).status).toBe(200)
    expect(existsSync(join(root, 'deep', 'er', 'STOP'))).toBe(true)
  })

  test('an empty risk.killFile disables the toggle with a 409', async () => {
    const { d } = boot2(cfg({ risk: { killFile: '' } }))
    expect((await stopPost(d.url, true)).status).toBe(409)
    const s = await (await fetch(d.url + '/api/state')).json()
    expect(s.killSwitch).toBe(false)
    expect(s.killSwitchConfigured).toBe(false)
  })

  test('host and port default to settings.dashboard.*, explicit options win', () => {
    const settings = cfg({ dashboard: { host: '127.0.0.1', port: 0 } })
    const a = boot2(settings).d
    expect(a.url.startsWith('http://127.0.0.1:')).toBe(true)
    const b = boot2(settings, { host: 'localhost' }).d
    expect(new URL(b.url).hostname).toBe('localhost')
  })
})

describe('server', () => {
  const open: { close: () => void }[] = []
  const dirs: string[] = []
  afterEach(() => {
    while (open.length) open.pop()!.close()
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true })
  })
  const boot = (o: Parameters<typeof startDashboard>[0] = {}) => {
    const root = mkdtempSync(join(tmpdir(), 'dash-root-'))
    dirs.push(root)
    mkdirSync(join(root, 'logs'))
    const d = startDashboard({ port: 0, root, refreshMs: 0, ...o })
    open.push(d)
    return { d, root }
  }
  const post = (base: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}/api/stop`, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', ...headers } })

  test('serves the app and /api/state as JSON, filtered log, SSE', async () => {
    const { d, root } = boot()
    writeFileSync(join(root, 'logs', 'live-x.jsonl'), canned().map((e) => JSON.stringify(e)).join('\n') + '\n')
    d.store.refresh(0)
    const html = await fetch(d.url + '/')
    expect(html.status).toBe(200)
    expect(await html.text()).toContain('Mission control')
    expect((await fetch(d.url + '/app.js')).headers.get('content-type')).toContain('javascript')
    const r = await fetch(d.url + '/api/state')
    expect(r.headers.get('content-type')).toContain('application/json')
    const s = await r.json()
    expect(s.run.mode).toBe('paper')
    expect(s.setups.rejected).toBe(3)
    const log = await (await fetch(`${d.url}/api/log?event=setup&q=dogetmn&limit=5`)).json()
    expect(log.rows.map((x: { event: string }) => x.event)).toEqual(['setup.rejected', 'setup.rejected'])
    const none = await (await fetch(`${d.url}/api/log?event=ai`)).json()
    expect(none.total).toBe(2)
    const sse = await fetch(d.url + '/api/stream')
    expect(sse.headers.get('content-type')).toContain('text/event-stream')
    const reader = sse.body!.getReader()
    let text = ''
    while (!text.includes('event: snapshot')) text += new TextDecoder().decode((await reader.read()).value)
    await reader.cancel()
    expect(text).toContain('"run"')
    expect((await fetch(d.url + '/nope')).status).toBe(404)
    expect((await fetch(d.url + '/../package.json')).status).toBe(404)
  })

  test('POST /api/stop needs the confirm header and toggles the STOP file in the temp root only', async () => {
    const { d, root } = boot()
    const stop = join(root, 'STOP')
    expect((await post(d.url, { enabled: true })).status).toBe(400)
    expect(existsSync(stop)).toBe(false)
    expect((await post(d.url, { enabled: 'yes' }, { 'x-confirm': 'stop' })).status).toBe(400)
    expect((await post(d.url, { enabled: true }, { 'x-confirm': 'stop', origin: 'http://evil.example' })).status).toBe(403)
    expect(existsSync(stop)).toBe(false)
    const on = await post(d.url, { enabled: true }, { 'x-confirm': 'stop' })
    expect(on.status).toBe(200)
    expect(existsSync(stop)).toBe(true)
    const state = await (await fetch(d.url + '/api/state')).json()
    expect(state.killSwitch).toBe(true)
    const same = await post(d.url, { enabled: false }, { 'x-confirm': 'stop', origin: d.url })
    expect(same.status).toBe(200)
    expect(existsSync(stop)).toBe(false)
    expect((await fetch(d.url + '/api/stop')).status).toBe(404)
  })

  test('demo mode produces a full state and never writes a STOP file', async () => {
    const { d, root } = boot({ demo: true, seed: 3 })
    const s = await (await fetch(d.url + '/api/state')).json()
    expect(s.source).toBe('demo')
    expect(s.run.mode).toBe('paper')
    expect(s.equity.series.length).toBeGreaterThan(50)
    expect(s.setups.accepted + s.setups.rejected).toBeGreaterThan(5)
    expect(s.ai.n).toBeGreaterThan(0)
    expect(s.system.symbols.length).toBe(4)
    const r = await post(d.url, { enabled: true }, { 'x-confirm': 'stop' })
    expect((await r.json()).virtual).toBe(true)
    expect(existsSync(join(root, 'STOP'))).toBe(false)
    expect((await (await fetch(d.url + '/api/state')).json()).killSwitch).toBe(true)
  })

  test('demo halt scenario trips the day-loss guard through the same fold path', () => {
    const store = new Store({ logDir: '/x', stateDir: '/x', killFile: '/x/STOP', mode: 'demo' })
    let clock = Date.now()
    const demo = createDemo(store, { seed: 5, scenario: 'normal', now: () => clock })
    demo.start()
    expect(store.snapshot().guard?.halted).toBe(false)
    demo.setScenario('halt')
    for (let i = 0; i < 300 && !store.snapshot().guard?.halted; i++) {
      clock += 1000
      demo.tick()
    }
    const s = store.snapshot()
    expect(s.guard?.halted).toBe(true)
    expect(s.guard?.blockReason).toContain('daily loss halt')
    expect(s.gauges.dayLoss.value!).toBeGreaterThanOrEqual(0.12)
  })
})
