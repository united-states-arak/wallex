import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { defaultDetectParams } from '../src/ict/types'
import { defaultLimits } from '../src/risk/guard'
import { positionSize } from '../src/risk/size'
import { DEFAULTS, LEGACY_ALIASES, SettingsError, explain, listProfiles, loadSettings, redact, settingsHash, type Settings } from '../src/settings'
import { cfg } from '../src/config'
import { nodeAt } from '../src/settings/schema'

const REAL_CONFIG = resolve(import.meta.dir, '../config')
const dirs: string[] = []
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })))

function conf(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'starcoach-cfg-'))
  dirs.push(dir)
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(join(dir, name, '..'), { recursive: true })
    writeFileSync(join(dir, name), body)
  }
  return dir
}

const load = (files: Record<string, string> = {}, o: Parameters<typeof loadSettings>[0] = {}) => loadSettings({ configDir: conf(files), env: {}, ...o })

function problems(fn: () => unknown): string[] {
  try {
    fn()
  } catch (e) {
    expect(e).toBeInstanceOf(SettingsError)
    return (e as SettingsError).problems
  }
  throw new Error('expected SettingsError')
}

describe('defaults reproduce the previous behaviour', () => {
  const s = load()

  test('key numbers', () => {
    expect(s.risk.riskPct).toBe(0.01)
    expect(s.risk.maxPositionPct).toBe(0.5)
    expect(s.risk.slippagePct).toBe(0.001)
    expect(s.risk.maxPositions).toBe(2)
    expect(s.fees).toEqual({ maker: 0.0025, taker: 0.003 })
    expect(s.paper).toEqual({ spreadBps: 10, slippageBps: 10, startTmn: 5_000_000 })
    expect(s.market.symbols).toEqual(['PEPETMN', 'PUMPTMN', 'DOGETMN'])
    expect(s.market.universe).toMatchObject({ minVolTmn: 3e9, maxSpreadPct: 0.01, minRangePct: 0.03, max: 12 })
    expect(s.strategy.ict).toMatchObject({ maxSpreadPct: 0.01, minNetRr: 1.5, tp1Fraction: 0.5, timeStopBars: 240, stopExitSlip: 0.005, stopExitSlipMax: 0.12, breakEvenBuffer: 0.006 })
    expect(s.run).toMatchObject({ entryCutoffMin: 45, flattenMin: 15, defaultHours: 24, end: '' })
    expect(s.wallex).toMatchObject({ baseUrl: 'https://api.wallex.ir', requestTimeoutMs: 10_000, pollMs: 20_000, tickMs: 5_000 })
    expect(s.ai).toMatchObject({ model: 'gpt-4o-mini', timeoutMs: 12_000, failMode: 'approve', newsTtlMin: 15, newsTimeoutMs: 8000, maxHeadlines: 15, contextWindow: 128_000 })
    expect(s.ai.feeds.map((f) => f.source)).toEqual(['CoinDesk', 'Cointelegraph'])
    expect(s.pullout.slippageSteps).toEqual([0.002, 0.004, 0.008, 0.015, 0.03, 0.05, 0.08, 0.12])
    expect(s.pullout.waitMs).toBe(2500)
    expect(s.research).toEqual({ trainSplit: 0.57, minTrainTrades: 5, warmupHours: 12, defaultDays: 7 })
    expect(s.data).toEqual({ dataDir: 'data', cacheCompleteAfterSec: 300, historyBars: 3000 })
    expect(s.logging.dir).toBe('logs')
  })

  test('detector defaults', () => {
    expect(s.detect).toMatchObject({
      swingN: 1, minFvgAtr: 0.15, displacementAtr: 1.5, minSweepDepthPct: 0.0002, oteLow: 0.62, oteHigh: 0.79, stopBufferAtr: 0.05,
      minStopPct: 0.01, maxStopPct: 0.025, setupMaxAgeBars1m: 180, minScore: 4, minGrossRr: 2, continuationMaxPullbackBars: 16,
      shortSwingLevels: true, freshnessUseClose: true, atrPeriod: 14, atrFloorPct: 0.001, bodyRatio: 0.6, max1mBars: 4000,
      mssRefBack: 24, bosRefBack: 60, sessionStartHour: 7, sessionEndHour: 21, window1m: 1500, window5m: 600, window15m: 400, window1h: 200,
      legMax1m: 30, legMax5m: 12, legMax15m: 8, htfBiasBars: 8, strongDisplacementAtr: 2, deepDiscountPos: 0.3, strongRr: 3,
    })
    expect(s.detect.models).toEqual(['sweep', 'continuation'])
    expect(s.detect.scanTimeframes).toEqual([5, 15])
    expect(defaultDetectParams).toEqual(s.detect)
  })

  test('guard limits equal the old hard-coded ones', () => {
    const l = defaultLimits({})
    expect(l).toMatchObject({
      riskPct: 0.01, lock1Pnl: 0.15, lock1Risk: 0.005, lock2Pnl: 0.3, lock2Risk: 0.0025, dailyLossHalt: 0.12, hardDrawdown: 0.3,
      lossStreak: 3, lossPauseSec: 1800, maxEntriesPerHour: 6,
    })
    expect(l.killFile).toBe(resolve(import.meta.dir, '../STOP'))
  })

  test('size and cfg view use the settings', () => {
    const r = positionSize({ equity: 1_000_000, entry: 100, stop: 98, qtyDecimals: 2, minNotional: 1 })
    expect(r.ok).toBe(true)
    expect(r.lossPct).toBeCloseTo(0.01, 3)
    expect(cfg).toMatchObject({ makerFee: 0.0025, takerFee: 0.003, spreadBps: 10, slippageBps: 10, startTmn: 5_000_000, dataDir: 'data', logDir: 'logs', blockedFile: 'config/blocked-markets.txt', apiKey: '', baseUrl: 'https://api.wallex.ir' })
    expect(cfg.symbols).toEqual(['PEPETMN', 'PUMPTMN', 'DOGETMN'])
  })

  test('config/default.toml is the same as the code defaults', () => {
    const fromFile = loadSettings({ configDir: REAL_CONFIG, env: {}, local: false })
    expect(fromFile).toEqual(DEFAULTS)
    expect(explain(fromFile).every((r) => r.source === 'default')).toBe(true)
  })

  test('default.toml parses to exactly the defaults (no key missing)', () => {
    const parsed = Bun.TOML.parse(readFileSync(join(REAL_CONFIG, 'default.toml'), 'utf8'))
    const expected = JSON.parse(JSON.stringify(DEFAULTS))
    delete expected.wallex.apiKey // secrets are environment-only, so they are not documented as TOML keys
    delete expected.ai.apiKey
    expect(parsed).toEqual(expected)
  })
})

describe('layering', () => {
  const files = {
    'default.toml': '[risk]\nriskPct = 0.02\nmaxPositions = 3\nlossStreak = 4\n[fees]\nmaker = 0.002\n',
    'profiles/p.toml': '[risk]\nriskPct = 0.015\nmaxPositions = 4\n',
    'local.toml': '[risk]\nmaxPositions = 5\n',
  }

  test('later layers win and sources are tracked', () => {
    const s = load(files, { profile: 'p', env: { MAX_ENTRIES_PER_HOUR: '9', STARCOACH__risk__lossStreak: '7' }, overrides: { risk: { riskPct: 0.03 } } })
    expect(s.risk.riskPct).toBe(0.03)
    expect(s.risk.maxPositions).toBe(5)
    expect(s.risk.lossStreak).toBe(7)
    expect(s.risk.maxEntriesPerHour).toBe(9)
    expect(s.fees.maker).toBe(0.002)
    expect(s.fees.taker).toBe(0.003)
    const src = Object.fromEntries(explain(s).map((r) => [r.path, r.source]))
    expect(src['risk.riskPct']).toBe('override')
    expect(src['risk.maxPositions']).toBe('file:local.toml')
    expect(src['risk.lossStreak']).toBe('env:STARCOACH__risk__lossStreak')
    expect(src['risk.maxEntriesPerHour']).toBe('env:MAX_ENTRIES_PER_HOUR')
    expect(src['fees.maker']).toBe('file:default.toml')
    expect(src['fees.taker']).toBe('default')
  })

  test('profile layer sits between default.toml and local.toml', () => {
    expect(load(files, { profile: 'p' }).risk).toMatchObject({ riskPct: 0.015, maxPositions: 5 })
    expect(load({ ...files, 'local.toml': '' }, { profile: 'p' }).risk.maxPositions).toBe(4)
    expect(load(files).risk.riskPct).toBe(0.02)
  })

  test('profile from STARCOACH_PROFILE; the argument wins over it', () => {
    const dir = conf({ ...files, 'profiles/q.toml': '[risk]\nriskPct = 0.004\n', 'local.toml': '' })
    expect(loadSettings({ configDir: dir, env: { STARCOACH_PROFILE: 'q' } }).risk.riskPct).toBe(0.004)
    expect(loadSettings({ configDir: dir, env: { STARCOACH_PROFILE: 'q' }, profile: 'p' }).risk.riskPct).toBe(0.015)
  })

  test('local: false skips local.toml', () => {
    expect(load(files, { local: false }).risk.maxPositions).toBe(3)
  })

  test('missing profile is an error that lists the available ones', () => {
    const p = problems(() => load(files, { profile: 'nope' }))
    expect(p[0]).toContain('profile "nope" does not exist')
    expect(p[0]).toContain('available: p')
    expect(problems(() => load(files, { profile: '../x' }))[0]).toContain('does not exist')
  })

  test('arrays replace as a whole', () => {
    const s = load({ 'local.toml': '[[risk.lockTiers]]\npnl = 0.1\nriskPct = 0.004\n' })
    expect(s.risk.lockTiers).toEqual([{ pnl: 0.1, riskPct: 0.004 }])
    expect(defaultLimits({}).lock2Pnl).toBe(0.3)
  })
})

describe('environment', () => {
  test('legacy aliases', () => {
    const s = load({}, {
      env: {
        WALLEX_BASE_URL: 'https://example.test', MAKER_FEE: '0.001', TAKER_FEE: '0.002', PAPER_SPREAD_BPS: '5', PAPER_SLIPPAGE_BPS: '7', START_TMN: '9000000',
        SYMBOLS: 'AAATMN, BBBTMN', RISK_PCT: '0.004', LOCK1_PNL: '0.1', LOCK1_RISK: '0.003', LOCK2_PNL: '0.2', LOCK2_RISK: '0.002', DAILY_LOSS_HALT: '0.1',
        HARD_DRAWDOWN: '0.25', LOSS_STREAK: '2', LOSS_PAUSE_MIN: '10', MAX_ENTRIES_PER_HOUR: '4', AI_BASE_URL: ' https://ai.test/v1/ ', AI_MODEL: 'm', AI_TIMEOUT_MS: '500',
        AI_FAIL_MODE: ' VETO ', RUN_END: '2030-01-01T00:00:00Z', ENTRY_CUTOFF_MIN: '60', FLATTEN_MIN: '20',
        OTEL_PROMETHEUS_PORT: '9999', OTEL_PROMETHEUS_HOST: '0.0.0.0', OTEL_SDK_DISABLED: 'true', OTEL_EXPORTER_OTLP_ENDPOINT: 'http://otel:4318',
      },
    })
    expect(s.wallex.baseUrl).toBe('https://example.test')
    expect(s.fees).toEqual({ maker: 0.001, taker: 0.002 })
    expect(s.paper).toEqual({ spreadBps: 5, slippageBps: 7, startTmn: 9_000_000 })
    expect(s.market.symbols).toEqual(['AAATMN', 'BBBTMN'])
    expect(s.risk).toMatchObject({ riskPct: 0.004, dayLossHalt: 0.1, hardDrawdown: 0.25, lossStreak: 2, lossPauseMin: 10, maxEntriesPerHour: 4 })
    expect(s.risk.lockTiers).toEqual([{ pnl: 0.1, riskPct: 0.003 }, { pnl: 0.2, riskPct: 0.002 }])
    expect(s.ai).toMatchObject({ baseUrl: 'https://ai.test/v1', model: 'm', timeoutMs: 500, failMode: 'veto' })
    expect(s.run).toMatchObject({ end: '2030-01-01T00:00:00Z', entryCutoffMin: 60, flattenMin: 20 })
    expect(s.telemetry).toMatchObject({ prometheusPort: 9999, prometheusHost: '0.0.0.0', enabled: false, otlpEndpoint: 'http://otel:4318' })
    const l = defaultLimits({ RISK_PCT: '0.004', LOCK1_PNL: '0.1', LOSS_PAUSE_MIN: '10', LOCK2_RISK: '0.002' })
    expect(l).toMatchObject({ riskPct: 0.004, lock1Pnl: 0.1, lossPauseSec: 600, lock2Risk: 0.002 })
  })

  test('every alias maps to a real setting', () => {
    for (const a of LEGACY_ALIASES) expect(nodeAt(a.path.split('.'))).toBeDefined()
    expect(new Set(LEGACY_ALIASES.map((a) => a.env)).size).toBe(LEGACY_ALIASES.length)
  })

  test('empty legacy values are ignored', () => {
    expect(load({}, { env: { RISK_PCT: '', SYMBOLS: '', AI_BASE_URL: '' } }).risk.riskPct).toBe(0.01)
  })

  test('new-style variables are typed from the default, names are case-insensitive', () => {
    const s = load({}, {
      env: {
        STARCOACH__risk__riskPct: '0.005',
        STARCOACH__DETECT__SHORTSWINGLEVELS: 'false',
        STARCOACH__detect__models: '["sweep"]',
        STARCOACH__detect__scanTimeframes: '5, 15, 1',
        STARCOACH__market__symbols: 'XTMN,YTMN',
        STARCOACH__market__universe__exclude: 'ZTMN',
        STARCOACH__ai__failMode: 'veto',
        STARCOACH__risk__killFile: '',
        STARCOACH__risk__lockTiers__1__pnl: '0.4',
      },
    })
    expect(s.risk.riskPct).toBe(0.005)
    expect(s.detect.shortSwingLevels).toBe(false)
    expect(s.detect.models).toEqual(['sweep'])
    expect(s.detect.scanTimeframes).toEqual([5, 15, 1])
    expect(s.market.symbols).toEqual(['XTMN', 'YTMN'])
    expect(s.market.universe.exclude).toEqual(['ZTMN'])
    expect(s.ai.failMode).toBe('veto')
    expect(s.risk.killFile).toBe('')
    expect(s.risk.lockTiers[1]).toEqual({ pnl: 0.4, riskPct: 0.0025 })
  })

  test('bad env values and unknown env keys are reported with hints', () => {
    const p = problems(() => load({}, { env: { RISK_PCT: 'abc', STARCOACH__risk__riskPtc: '1', STARCOACH__detect__shortSwingLevels: 'maybe', STARCOACH__nope__x: '1', STARCOACH__risk: '1' } }))
    expect(p.some((x) => x.includes('RISK_PCT') && x.includes('a number'))).toBe(true)
    expect(p.some((x) => x.includes('STARCOACH__risk__riskPtc') && x.includes('did you mean "risk.riskPct"'))).toBe(true)
    expect(p.some((x) => x.includes('shortSwingLevels') && x.includes('boolean'))).toBe(true)
    expect(p.some((x) => x.includes('STARCOACH__nope__x') && x.includes('unknown key "nope"'))).toBe(true)
    expect(p.some((x) => x.includes('STARCOACH__risk') && x.includes('section'))).toBe(true)
  })

  test('an unknown profile named in the environment is an error', () => {
    expect(() => loadSettings({ configDir: conf(), env: { STARCOACH_PROFILE: 'ghost' } })).toThrow('ghost')
  })
})

describe('strict files', () => {
  test('unknown keys are errors with a did-you-mean hint', () => {
    const p = problems(() => load({ 'local.toml': '[risk]\nriskPtc = 0.02\n[detct]\nswingN = 2\n[detect]\nminScor = 3\n' }))
    expect(p).toHaveLength(3)
    expect(p[0]).toContain('file:local.toml')
    expect(p[0]).toContain('unknown key "risk.riskPtc"')
    expect(p[0]).toContain('did you mean "risk.riskPct"')
    expect(p[1]).toContain('unknown key "detct"')
    expect(p[1]).toContain('did you mean "detect"')
    expect(p[2]).toContain('did you mean "detect.minScore"')
  })

  test('wrong types are errors', () => {
    const p = problems(() => load({ 'local.toml': '[risk]\nriskPct = "high"\nlockTiers = [1]\n[detect]\nmodels = "sweep"\n' }))
    expect(p.some((x) => x.includes('risk.riskPct must be a number'))).toBe(true)
    expect(p.some((x) => x.includes('risk.lockTiers.0 must be a table'))).toBe(true)
    expect(p.some((x) => x.includes('detect.models must be an array'))).toBe(true)
  })

  test('unknown key inside a table array', () => {
    const p = problems(() => load({ 'local.toml': '[[risk.lockTiers]]\npnl = 0.1\nriskpct = 0.1\n' }))
    expect(p[0]).toContain('risk.lockTiers.0.riskpct')
  })

  test('invalid TOML is a clear error', () => {
    expect(problems(() => load({ 'local.toml': 'risk = = 1' }))[0]).toContain('file:local.toml: invalid TOML')
  })

  test.each(['apiKey = "x"', 'api_key = "x"', 'secret = "x"', 'token = "x"'])('secret key in TOML is rejected: %s', (line) => {
    for (const where of ['local.toml', 'default.toml', 'profiles/p.toml']) {
      const p = problems(() => load({ [where]: `[wallex]\n${line}\n` }, { profile: 'p' }))
      expect(p[0]).toContain('looks like a secret')
      expect(p[0]).toContain('environment')
    }
  })

  test('secrets from env work, and never come from files', () => {
    const s = load({}, { env: { WALLEX_API_KEY: 'wk-123456789', AI_API_KEY: 'ak-123456789' } })
    expect(s.wallex.apiKey).toBe('wk-123456789')
    expect(s.ai.apiKey).toBe('ak-123456789')
  })
})

describe('validation', () => {
  const bad = (toml: string): string[] => {
    try {
      load({ 'local.toml': toml })
      return []
    } catch (e) {
      return (e as SettingsError).problems
    }
  }

  test('ranges', () => {
    expect(bad('[risk]\nriskPct = 0.06')[0]).toContain('risk.riskPct')
    expect(bad('[risk]\nriskPct = 0')[0]).toContain('risk.riskPct')
    expect(bad('[risk]\nriskPct = 0.05')).toEqual([])
    expect(bad('[risk]\nmaxPositionPct = 1.2')[0]).toContain('risk.maxPositionPct')
    expect(bad('[risk]\nmaxPositionPct = 1')).toEqual([])
    expect(bad('[fees]\nmaker = 0.03')[0]).toContain('fees.maker')
    expect(bad('[fees]\ntaker = -0.001')[0]).toContain('fees.taker')
    expect(bad('[fees]\nmaker = 0.02\ntaker = 0')).toEqual([])
    expect(bad('[risk]\ndayLossHalt = 1')[0]).toContain('risk.dayLossHalt')
    expect(bad('[risk]\nmaxPositions = 1.5')[0]).toContain('risk.maxPositions')
    expect(bad('[strategy.ict]\ntp1Fraction = 0')[0]).toContain('tp1Fraction')
    expect(bad('[ai]\nfailMode = "maybe"')[0]).toContain('ai.failMode')
    expect(bad('[wallex]\nbaseUrl = "not a url"')[0]).toContain('wallex.baseUrl')
    expect(bad('[telemetry]\nprometheusPort = 70000')[0]).toContain('telemetry.prometheusPort')
    expect(bad('[detect]\nmodels = ["x"]')[0]).toContain('detect.models.0')
    expect(bad('[market]\nsymbols = ["pepe"]')[0]).toContain('market.symbols.0')
  })

  test('cross-field checks', () => {
    expect(bad('[detect]\nminStopPct = 0.03')[0]).toContain('detect.minStopPct: must be less than detect.maxStopPct')
    expect(bad('[detect]\noteLow = 0.9')[0]).toContain('detect.oteLow')
    expect(bad('[risk]\ndayLossHalt = 0.5')[0]).toContain('risk.dayLossHalt: must be <= risk.hardDrawdown')
    expect(bad('[run]\nflattenMin = 2000')[0]).toContain('run.flattenMin: must be less than the run length')
    expect(bad('[run]\nentryCutoffMin = 5')[0]).toContain('run.entryCutoffMin: must be >= run.flattenMin')
    expect(bad('[detect]\nsessionStartHour = 22')[0]).toContain('detect.sessionStartHour')
    expect(bad('[[risk.lockTiers]]\npnl = 0.3\nriskPct = 0.005\n[[risk.lockTiers]]\npnl = 0.2\nriskPct = 0.004')[0]).toContain('risk.lockTiers.1.pnl')
    expect(bad('[[risk.lockTiers]]\npnl = 0.3')[0]).toContain('risk.lockTiers.0.riskPct: is missing')
    expect(bad('[ai]\ninstructionsFile = "/nonexistent/prompt.txt"')[0]).toContain('ai.instructionsFile')
  })

  test('every problem is listed, not just the first', () => {
    const p = bad('[risk]\nriskPct = 0.5\ndayLossHalt = 2\n[fees]\nmaker = 1\n[detect]\nminStopPct = 0.5\nmaxStopPct = 0.01\n')
    expect(p.length).toBeGreaterThanOrEqual(5)
    const err = (() => {
      try {
        load({ 'local.toml': '[risk]\nriskPct = 0.5\n[fees]\nmaker = 1' })
      } catch (e) {
        return e as SettingsError
      }
    })()!
    expect(err.message).toContain('risk.riskPct')
    expect(err.message).toContain('fees.maker')
    expect(err.message).toContain('2 problems')
  })

  test('overrides are validated too', () => {
    expect(problems(() => load({}, { overrides: { risk: { riskPct: 0.9 } } }))[0]).toContain('risk.riskPct')
  })
})

describe('redaction and hash', () => {
  const env = { WALLEX_API_KEY: 'wk-SECRET-123456', AI_API_KEY: 'ak-SECRET-123456' }

  test('redact hides secrets and keeps the rest', () => {
    const s = load({}, { env })
    const r = redact(s)
    expect(r.wallex.apiKey).toBe('***')
    expect(r.ai.apiKey).toBe('***')
    expect(r.risk).toEqual(s.risk)
    expect(s.wallex.apiKey).toBe('wk-SECRET-123456')
    expect(JSON.stringify(r)).not.toContain('SECRET')
    expect(redact(load()).wallex.apiKey).toBe('')
  })

  test('explain never exposes a secret', () => {
    const rows = explain(load({}, { env }))
    expect(JSON.stringify(rows)).not.toContain('SECRET')
    expect(rows.find((r) => r.path === 'wallex.apiKey')).toMatchObject({ value: '***', source: 'env:WALLEX_API_KEY' })
    expect(rows.find((r) => r.path === 'risk.lockTiers')?.value).toEqual(DEFAULTS.risk.lockTiers)
  })

  test('hash is stable, ignores key order and secrets, and changes with settings', () => {
    const a = settingsHash(load())
    expect(a).toMatch(/^[0-9a-f]{64}$/)
    expect(settingsHash(load())).toBe(a)
    expect(settingsHash(load({}, { env }))).toBe(a)
    const reordered = JSON.parse(JSON.stringify(load())) as Settings
    reordered.risk = Object.fromEntries(Object.entries(reordered.risk).reverse()) as Settings['risk']
    expect(settingsHash(reordered)).toBe(a)
    expect(settingsHash(load({}, { env: { RISK_PCT: '0.004' } }))).not.toBe(a)
  })
})

describe('profiles shipped in config/', () => {
  const real = (profile?: string) => loadSettings({ configDir: REAL_CONFIG, env: {}, local: false, profile })

  test('they all exist and validate', () => {
    expect(listProfiles(REAL_CONFIG)).toEqual(['aggressive', 'backtest', 'balanced', 'conservative'])
    for (const p of listProfiles(REAL_CONFIG)) expect(() => real(p)).not.toThrow()
  })

  test('balanced equals the defaults', () => {
    expect(real('balanced')).toEqual(DEFAULTS)
  })

  test('conservative', () => {
    const s = real('conservative')
    expect(s.risk).toMatchObject({ riskPct: 0.005, maxPositions: 1 })
    expect(s.risk.dayLossHalt).toBeLessThan(DEFAULTS.risk.dayLossHalt)
    expect(s.risk.hardDrawdown).toBeLessThan(DEFAULTS.risk.hardDrawdown)
  })

  test('aggressive loosens gates but keeps the stop band and sizing', () => {
    const s = real('aggressive')
    expect(s.strategy.ict.minNetRr).toBe(1.3)
    expect(s.detect.minScore).toBe(3)
    expect(s.risk).toMatchObject({ maxEntriesPerHour: 10, dayLossHalt: 0.15, riskPct: 0.01, maxPositionPct: 0.5 })
    expect(s.detect.minStopPct).toBe(0.01)
    expect(s.detect.maxStopPct).toBe(0.025)
  })

  test('backtest', () => {
    const s = real('backtest')
    expect(s.risk.killFile).toBe('')
    expect(s.telemetry.enabled).toBe(false)
  })
})
