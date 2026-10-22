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
  lossStreak: number
  lossPauseSec: number
  maxEntriesPerHour: number
  // Path of the kill switch file. Empty string disables the check.
  killFile: string
}

export type Guard = RiskGuard & { save(): void; recordEntry(now: number): void }

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
    lossStreak: r.lossStreak,
    lossPauseSec: r.lossPauseMin * 60,
    maxEntriesPerHour: r.maxEntriesPerHour,
    killFile: r.killFile ? resolve(REPO_ROOT, r.killFile) : '',
  }
}

export function writeJsonAtomic(path: string, data: unknown) {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify(data))
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
  pausedUntil: number
  entries: number[]
  lastNow: number
}

const dayOf = (t: number) => Math.floor(t / 86_400)
const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x)

function load(path: string | undefined, startEquity: number): Persisted | null {
  if (!path || !existsSync(path)) return null
  try {
    const j = JSON.parse(readFileSync(path, 'utf8'))
    if (j?.startEquity !== startEquity) return null
    const ok = [j.equity, j.day, j.dayStart, j.dayPeak, j.consecutiveLosses, j.pausedUntil, j.lastNow].every(isNum)
    if (!ok || !Array.isArray(j.entries)) return null
    return {
      ...j,
      dailyHaltDay: isNum(j.dailyHaltDay) ? j.dailyHaltDay : null,
      hardHalt: typeof j.hardHalt === 'string' ? j.hardHalt : null,
      entries: j.entries.filter(isNum),
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
    pausedUntil: 0,
    entries: [],
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
      if (pnlFraction < 0) {
        s.consecutiveLosses += 1
        if (s.consecutiveLosses >= L.lossStreak) s.pausedUntil = now + L.lossPauseSec
      } else {
        s.consecutiveLosses = 0
      }
      save()
    },

    recordEntry(now) {
      touch(now)
      s.entries = s.entries.filter((t) => t > now - 3600)
      s.entries.push(now)
      save()
    },

    blockReason(now) {
      if (L.killFile && existsSync(L.killFile)) return 'kill switch file'
      const before = `${s.day}|${s.dayPeak}`
      touch(now)
      if (before !== `${s.day}|${s.dayPeak}`) save()
      if (s.hardHalt) return s.hardHalt
      if (dailyHalted()) return `daily loss halt: equity ${Math.round(s.equity)} is ${((1 - s.equity / s.dayPeak) * 100).toFixed(1)}% below the day peak`
      if (now < s.pausedUntil) return `loss pause: ${s.consecutiveLosses} losses in a row, resumes in ${Math.ceil((s.pausedUntil - now) / 60)} min`
      const recent = s.entries.filter((t) => t > now - 3600).length
      if (recent >= L.maxEntriesPerHour) return `max entries per hour (${L.maxEntriesPerHour})`
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
