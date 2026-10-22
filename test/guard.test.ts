import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolve } from 'node:path'
import { createGuard, defaultLimits } from '../src/risk/guard'

const START = 5_000_000
const DAY0 = 1_800_000_000 - (1_800_000_000 % 86_400) // a UTC midnight
let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'guard-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const make = (o: Parameters<typeof createGuard>[0] extends infer T ? Partial<T> : never = {}) =>
  createGuard({ startEquity: START, now: () => DAY0 + 3600, limits: { killFile: '' }, ...o })

test('fresh guard allows entries at 1% risk', () => {
  const g = make()
  expect(g.blockReason(DAY0 + 3600)).toBeNull()
  expect(g.riskPct()).toBe(0.01)
  const s = g.state()
  expect(s).toMatchObject({ equity: START, startEquity: START, totalPnlPct: 0, halted: false, consecutiveLosses: 0, riskPct: 0.01 })
})

test('profit lock tiers lower the risk and release when equity falls back', () => {
  const g = make()
  g.updateEquity(START * 1.149, DAY0 + 4000)
  expect(g.riskPct()).toBe(0.01)
  g.updateEquity(START * 1.15, DAY0 + 4001)
  expect(g.riskPct()).toBe(0.005)
  expect(g.state().totalPnlPct).toBeCloseTo(0.15)
  g.updateEquity(START * 1.3, DAY0 + 4002)
  expect(g.riskPct()).toBe(0.0025)
  g.updateEquity(START * 1.1, DAY0 + 4003)
  expect(g.riskPct()).toBe(0.01)
})

test('daily loss halt triggers at 12% below the day peak and clears on the next UTC day', () => {
  const g = make()
  g.updateEquity(START * 1.1, DAY0 + 4000)
  g.updateEquity(START * 1.1 * 0.89, DAY0 + 4100)
  expect(g.blockReason(DAY0 + 4200)).toBeNull()
  g.updateEquity(START * 1.1 * 0.88, DAY0 + 4300)
  expect(g.blockReason(DAY0 + 4400)).toContain('daily loss halt')
  expect(g.state().halted).toBe(true)
  expect(g.state().haltReason).toBeDefined()
  // equity recovering does not lift the halt within the same day
  g.updateEquity(START * 1.1, DAY0 + 5000)
  expect(g.blockReason(DAY0 + 5100)).toContain('daily loss halt')
  // next UTC day: halted no more, the day peak restarts from current equity
  expect(g.blockReason(DAY0 + 86_400 + 10)).toBeNull()
  expect(g.state().halted).toBe(false)
  expect(g.state().dayPeak).toBe(START * 1.1)
})

test('day rollover resets the day peak to current equity', () => {
  const g = make()
  g.updateEquity(START * 1.2, DAY0 + 4000)
  g.updateEquity(START * 1.1, DAY0 + 4100)
  expect(g.state().dayPeak).toBe(START * 1.2)
  g.updateEquity(START * 1.1, DAY0 + 86_400 + 5)
  expect(g.state().dayPeak).toBe(START * 1.1)
  expect(g.state().dayPnlPct).toBeCloseTo(0)
})

test('hard drawdown halts permanently, even after a day change or recovery', () => {
  const g = make({ limits: { killFile: '', dailyLossHalt: 0.99 } })
  g.updateEquity(START * 0.7, DAY0 + 4000)
  expect(g.state().halted).toBe(true)
  expect(g.state().haltReason).toContain('hard drawdown')
  expect(g.blockReason(DAY0 + 4001)).toContain('hard drawdown')
  g.updateEquity(START * 1.2, DAY0 + 90_000)
  expect(g.blockReason(DAY0 + 5 * 86_400)).toContain('hard drawdown')
  expect(g.state().halted).toBe(true)
})

test('invalid equity values are ignored', () => {
  const g = make()
  g.updateEquity(0, DAY0 + 4000)
  g.updateEquity(NaN, DAY0 + 4001)
  expect(g.state().halted).toBe(false)
  expect(g.state().equity).toBe(START)
})

test('three losses in a row pause entries for 30 minutes, then they resume', () => {
  const g = make()
  const t = DAY0 + 4000
  g.recordTrade(-0.01, t)
  g.recordTrade(-0.01, t + 10)
  expect(g.blockReason(t + 20)).toBeNull()
  g.recordTrade(-0.01, t + 30)
  expect(g.state().consecutiveLosses).toBe(3)
  expect(g.blockReason(t + 31)).toContain('loss pause')
  expect(g.blockReason(t + 30 + 1799)).toContain('loss pause')
  expect(g.blockReason(t + 30 + 1800)).toBeNull()
  // another loss after the pause pauses again, a win resets the streak
  g.recordTrade(-0.01, t + 2000)
  expect(g.blockReason(t + 2001)).toContain('loss pause')
  g.recordTrade(0.02, t + 2002)
  expect(g.state().consecutiveLosses).toBe(0)
})

test('a win between losses resets the streak', () => {
  const g = make()
  g.recordTrade(-0.01, DAY0 + 4000)
  g.recordTrade(-0.01, DAY0 + 4001)
  g.recordTrade(0.01, DAY0 + 4002)
  g.recordTrade(-0.01, DAY0 + 4003)
  expect(g.blockReason(DAY0 + 4004)).toBeNull()
})

test('at most 6 entries per hour', () => {
  const g = make()
  const t = DAY0 + 4000
  for (let i = 0; i < 6; i++) {
    expect(g.blockReason(t + i * 60)).toBeNull()
    g.recordEntry(t + i * 60)
  }
  expect(g.blockReason(t + 400)).toContain('max entries per hour')
  expect(g.blockReason(t + 3599)).toContain('max entries per hour')
  // the first entry leaves the window after one hour
  expect(g.blockReason(t + 3601)).toBeNull()
})

test('the kill file path comes from risk.killFile (STARCOACH__risk__killFile), relative to the repo root', () => {
  expect(defaultLimits({ STARCOACH__risk__killFile: 'control/STOP' }).killFile).toBe(resolve(import.meta.dir, '../control/STOP'))
  const killFile = join(dir, 'control', 'STOP')
  const limits = defaultLimits({ STARCOACH__risk__killFile: killFile })
  const g = make({ limits })
  expect(g.blockReason(DAY0 + 4000)).toBeNull()
  mkdirSync(join(dir, 'control'))
  writeFileSync(killFile, '')
  expect(g.blockReason(DAY0 + 4001)).toBe('kill switch file')
})

test('kill switch file blocks entries while it exists', () => {
  const killFile = join(dir, 'STOP')
  const g = make({ limits: { killFile } })
  expect(g.blockReason(DAY0 + 4000)).toBeNull()
  writeFileSync(killFile, '')
  expect(g.blockReason(DAY0 + 4001)).toBe('kill switch file')
  rmSync(killFile)
  expect(g.blockReason(DAY0 + 4002)).toBeNull()
})

test('limits are overridable', () => {
  const g = make({ limits: { killFile: '', riskPct: 0.02, maxEntriesPerHour: 1 } })
  expect(g.riskPct()).toBe(0.02)
  g.recordEntry(DAY0 + 4000)
  expect(g.blockReason(DAY0 + 4001)).toContain('max entries per hour')
})

test('state persists to disk and a new guard with the same start equity restores it', () => {
  const statePath = join(dir, 'sub', 'guard.json')
  const a = make({ statePath })
  a.updateEquity(START * 1.2, DAY0 + 4000)
  a.recordTrade(-0.01, DAY0 + 4001)
  a.recordTrade(-0.01, DAY0 + 4002)
  a.recordTrade(-0.01, DAY0 + 4003)
  a.recordEntry(DAY0 + 4004)
  expect(existsSync(statePath)).toBe(true)
  expect(JSON.parse(readFileSync(statePath, 'utf8')).startEquity).toBe(START)

  const b = make({ statePath })
  expect(b.state()).toEqual(a.state())
  expect(b.riskPct()).toBe(0.005)
  expect(b.blockReason(DAY0 + 4010)).toContain('loss pause')
})

test('persisted hard halt survives a restart', () => {
  const statePath = join(dir, 'guard.json')
  make({ statePath }).updateEquity(START * 0.5, DAY0 + 4000)
  const b = make({ statePath })
  expect(b.state().halted).toBe(true)
  expect(b.blockReason(DAY0 + 4001)).toContain('hard drawdown')
})

test('state with a different start equity or corrupt content is ignored', () => {
  const statePath = join(dir, 'guard.json')
  make({ statePath }).updateEquity(START * 0.5, DAY0 + 4000)
  const other = createGuard({ startEquity: 1_000_000, statePath, now: () => DAY0 + 3600, limits: { killFile: '' } })
  expect(other.state().halted).toBe(false)
  writeFileSync(statePath, '{not json')
  expect(make({ statePath }).state().halted).toBe(false)
})
