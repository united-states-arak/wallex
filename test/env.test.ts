import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { EnvError, envShape, readEnv } from '../src/env'
import { LEGACY_ALIASES, loadSettings, settingsHash } from '../src/settings'

// Names in LEGACY_ALIASES that src/env.ts deliberately does not validate (none today). Add the reason when listing one.
const HANDLED_ELSEWHERE: string[] = []

// Variables that are not settings: operational switches, config selection and secrets.
const ENV_ONLY = ['STARCOACH_MODE', 'STARCOACH_CONFIRM_LIVE', 'STARCOACH_ARGS', 'HEALTH_MAX_AGE_S', 'GIT_SHA', 'STARCOACH_PROFILE', 'STARCOACH_CONFIG_DIR', 'OTEL_EXPORTER_OTLP_HEADERS']

const problemsOf = (source: Record<string, string>) => {
  try {
    readEnv(source)
  } catch (e) {
    if (e instanceof EnvError) return e.problems
    throw e
  }
  return []
}

test('every legacy alias has a schema entry in src/env.ts or is listed as handled elsewhere', () => {
  const missing = LEGACY_ALIASES.map((a) => a.env).filter((n) => !(n in envShape) && !HANDLED_ELSEWHERE.includes(n))
  expect(missing).toEqual([])
  for (const n of HANDLED_ELSEWHERE) expect(n in envShape).toBe(false)
})

test('every schema entry is a legacy alias, an env-only name listed here', () => {
  const aliases = new Set(LEGACY_ALIASES.map((a) => a.env))
  const extra = Object.keys(envShape).filter((n) => !aliases.has(n) && !ENV_ONLY.includes(n))
  expect(extra).toEqual([])
})

test('operational variables are env-only: no setting is built from them', () => {
  const aliases = new Set(LEGACY_ALIASES.map((a) => a.env))
  for (const n of ['STARCOACH_MODE', 'STARCOACH_CONFIRM_LIVE', 'STARCOACH_ARGS', 'HEALTH_MAX_AGE_S', 'GIT_SHA']) {
    expect(n in envShape).toBe(true)
    expect(aliases.has(n)).toBe(false)
  }
})

test('defaults and typed values', () => {
  const e = readEnv({})
  expect(e.STARCOACH_MODE).toBe('paper')
  expect(e.RISK_PCT).toBeUndefined()
  const t = readEnv({ STARCOACH_MODE: ' LIVE ', STARCOACH_CONFIRM_LIVE: 'yes', HEALTH_MAX_AGE_S: '90', RISK_PCT: '0.004', OTEL_SDK_DISABLED: 'YES', AI_FAIL_MODE: 'Veto' })
  expect(t).toMatchObject({ STARCOACH_MODE: 'live', STARCOACH_CONFIRM_LIVE: 'yes', HEALTH_MAX_AGE_S: 90, RISK_PCT: 0.004, OTEL_SDK_DISABLED: true, AI_FAIL_MODE: 'veto' })
  expect(readEnv({ RISK_PCT: '' }).RISK_PCT).toBeUndefined()
})

test('bad values are all reported, naming the variable', () => {
  const p = problemsOf({ STARCOACH_MODE: 'yolo', STARCOACH_CONFIRM_LIVE: 'maybe', HEALTH_MAX_AGE_S: '0', RISK_PCT: 'abc', RUN_END: 'tomorrow', AI_BASE_URL: 'not a url', OTEL_PROMETHEUS_PORT: '9.5', STARCOACH_PROFILE: 'a/b' })
  for (const name of ['STARCOACH_MODE', 'STARCOACH_CONFIRM_LIVE', 'HEALTH_MAX_AGE_S', 'RISK_PCT', 'RUN_END', 'AI_BASE_URL', 'OTEL_PROMETHEUS_PORT', 'STARCOACH_PROFILE']) {
    expect(p.some((x) => x.startsWith(`env ${name}:`))).toBe(true)
  }
})

test('SKIP_ENV_VALIDATION=1 skips validation', () => {
  expect(problemsOf({ RISK_PCT: 'abc', SKIP_ENV_VALIDATION: '1' })).toEqual([])
})

test('the settings loader takes legacy variables from the validated env and reports bad ones with the other problems', () => {
  const s = loadSettings({ env: { RISK_PCT: '0.004', OTEL_SDK_DISABLED: 'yes', AI_FAIL_MODE: ' VETO ' } })
  expect(s.risk.riskPct).toBe(0.004)
  expect(s.telemetry.enabled).toBe(false)
  expect(s.ai.failMode).toBe('veto')
  expect(() => loadSettings({ env: { RISK_PCT: 'abc', STARCOACH__risk__nope: '1' } })).toThrow(/env RISK_PCT[\s\S]*STARCOACH__risk__nope/)
})

test('secrets reach settings from the environment only', () => {
  const s = loadSettings({ env: { WALLEX_API_KEY: 'wk-123456789', AI_API_KEY: 'ak-123456789' } })
  expect(s.wallex.apiKey).toBe('wk-123456789')
  expect(s.ai.apiKey).toBe('ak-123456789')
})

test('a bad environment exits 78 and lists every problem', () => {
  const run = (cmd: string[]) =>
    Bun.spawnSync(['bun', ...cmd], { env: { ...process.env, RISK_PCT: 'abc', MAKER_FEE: 'x', STARCOACH_CONFIG_DIR: '/nonexistent-starcoach-config' }, stdout: 'pipe', stderr: 'pipe' })
  for (const cmd of [['src/settings/cli.ts', 'hash'], ['src/cli.ts']]) {
    const r = run(cmd)
    const err = r.stderr.toString()
    expect(r.exitCode).toBe(78)
    expect(err).toContain('RISK_PCT')
    expect(err).toContain('MAKER_FEE')
  }
})

test('.env.example lists every variable, is valid as copied, and changes no setting', () => {
  const lines = readFileSync(`${import.meta.dir}/../.env.example`, 'utf8').split('\n')
  const listed = new Map<string, string>()
  for (const l of lines) {
    const m = /^(?:# )?([A-Z][A-Z0-9_]+)=(.*)$/.exec(l)
    if (m) listed.set(m[1]!, m[2]!)
  }
  expect(Object.keys(envShape).filter((n) => !listed.has(n))).toEqual([])
  const active = Object.fromEntries(lines.filter((l) => /^[A-Z][A-Z0-9_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]))
  expect(active.WALLEX_API_KEY).toBe('')
  expect(active.AI_API_KEY).toBe('')
  expect(() => readEnv(active)).not.toThrow()
  expect(settingsHash(loadSettings({ env: active }))).toBe(settingsHash(loadSettings({ env: {} })))
})
