import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { getSettings, loadSettings } from '../settings'
import type { GuardState, RiskGuard } from './types'

// All percentages are fractions (0.01 = 1%). All times are unix seconds.
export interface GuardLimits {
  riskPct: number
  lock1Pnl: number
  lock1Risk: number
  lock2Pnl: number
  lock2Risk: number
  dailyLossHalt: number
  hardDrawdown: number
  // Path of the kill switch file. Empty string disables the check.
  killFile: string
}

export type Guard = RiskGuard & { save(): void }

const REPO_ROOT = resolve(import.meta.dir, '../..')

// Limits come from the settings risk section (config files, STARCOACH__risk__* and the legacy RISK_PCT, LOCK1_PNL ... variables).
// Pass `env` to resolve against a specific environment instead of the process one. A missing tier never triggers.
export function defaultLimits(env?: Record<string, string | undefined>): GuardLimits {
  const r = (env ? loadSettings({ env }) : getSettings()).risk
  const [t1, t2] = r.lockTiers
  return {
    riskPct: r.riskPct,
    lock1Pnl: t1?.pnl ?? Infinity,
    lock1Risk: t1?.riskPct ?? r.riskPct,
    lock2Pnl: t2?.pnl ?? Infinity,
    lock2Risk: t2?.riskPct ?? r.riskPct,
    dailyLossHalt: r.dayLossHalt,
    hardDrawdown: r.hardDrawdown,
    killFile: r.killFile ? resolve(REPO_ROOT, r.killFile) : '',
  }
}

export function writeJsonAtomic(path: string, data: unknown) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 })
  renameSync(tmp, path)
}

interface Persisted {
  startEquity: number
  equity: number
  day: number
  dayStart: number
  dayPeak: number
  dailyHaltDay: number | null
  hardHalt: string | null
  consecutiveLosses: number
  lastNow: number
}

const dayOf = (t: number) => Math.floor(t / 86_400)
const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x)

function load(path: string | undefined, startEquity: number): Persisted | null {
  if (!path || !existsSync(path)) return null
  try {
    const j = JSON.parse(readFileSync(path, 'utf8'))
    if (j?.startEquity !== startEquity) return null
    if (![j.equity, j.day, j.dayStart, j.dayPeak, j.consecutiveLosses, j.lastNow].every(isNum)) return null
    return {
      startEquity: j.startEquity,
      equity: j.equity,
      day: j.day,
      dayStart: j.dayStart,
      dayPeak: j.dayPeak,
      dailyHaltDay: isNum(j.dailyHaltDay) ? j.dailyHaltDay : null,
      hardHalt: typeof j.hardHalt === 'string' ? j.hardHalt : null,
      consecutiveLosses: j.consecutiveLosses,
      lastNow: j.lastNow,
    }
  } catch {
    return null
  }
}

export function createGuard(opts: {
  startEquity: number
  statePath?: string
  now?: () => number
  limits?: Partial<GuardLimits>
}): Guard {
  const L: GuardLimits = { ...defaultLimits(), ...opts.limits }
  const clock = opts.now ?? (() => Math.floor(Date.now() / 1000))
  const t0 = clock()
  const s: Persisted = load(opts.statePath, opts.startEquity) ?? {
    startEquity: opts.startEquity,
    equity: opts.startEquity,
    day: dayOf(t0),
    dayStart: opts.startEquity,
    dayPeak: opts.startEquity,
    dailyHaltDay: null,
    hardHalt: null,
    consecutiveLosses: 0,
    lastNow: t0,
  }
  let lastWritten = ''
  let warned = false

  const save = () => {
    if (!opts.statePath) return
    const body = JSON.stringify(s)
    if (body === lastWritten) return
    try {
      writeJsonAtomic(opts.statePath, s)
      lastWritten = body
    } catch (e) {
      if (!warned) console.error(`guard: cannot write ${opts.statePath}: ${String(e)}`)
      warned = true
    }
  }

  const touch = (now: number) => {
    s.lastNow = now
    const d = dayOf(now)
    if (d !== s.day) {
      s.day = d
      s.dayStart = s.dayPeak = s.equity
    }
  }

  const totalPnl = () => s.equity / s.startEquity - 1

  const riskPct = () => {
    const p = totalPnl()
    if (p >= L.lock2Pnl - 1e-9) return L.lock2Risk
    if (p >= L.lock1Pnl - 1e-9) return L.lock1Risk
    return L.riskPct
  }

  const dailyHalted = () => s.dailyHaltDay === s.day

  save()

  return {
    save,

    riskPct,

    updateEquity(equity, now) {
      if (!isNum(equity) || equity <= 0) return
      touch(now)
      s.equity = equity
      s.dayPeak = Math.max(s.dayPeak, equity)
      if (!s.hardHalt && equity <= s.startEquity * (1 - L.hardDrawdown)) {
        s.hardHalt = `hard drawdown: equity ${Math.round(equity)} <= ${Math.round(s.startEquity * (1 - L.hardDrawdown))}`
      }
      if (!dailyHalted() && equity <= s.dayPeak * (1 - L.dailyLossHalt)) s.dailyHaltDay = s.day
      save()
    },

    recordTrade(pnlFraction, now) {
      touch(now)
      s.consecutiveLosses = pnlFraction < 0 ? s.consecutiveLosses + 1 : 0
      save()
    },

    blockReason(now) {
      if (L.killFile && existsSync(L.killFile)) return 'kill switch file'
      const before = `${s.day}|${s.dayPeak}`
      touch(now)
      if (before !== `${s.day}|${s.dayPeak}`) save()
      if (s.hardHalt) return s.hardHalt
      if (dailyHalted()) return `daily loss halt: equity ${Math.round(s.equity)} is ${((1 - s.equity / s.dayPeak) * 100).toFixed(1)}% below the day peak`
      return null
    },

    state(): GuardState {
      const halted = Boolean(s.hardHalt) || dailyHalted()
      return {
        equity: s.equity,
        startEquity: s.startEquity,
        dayPeak: s.dayPeak,
        dayPnlPct: s.equity / s.dayStart - 1,
        totalPnlPct: totalPnl(),
        consecutiveLosses: s.consecutiveLosses,
        halted,
        ...(halted ? { haltReason: s.hardHalt ?? 'daily loss halt' } : {}),
        riskPct: riskPct(),
      }
    },
  }
}
