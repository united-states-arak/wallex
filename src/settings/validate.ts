import { existsSync } from 'node:fs'
import type { Settings } from './types'

export class SettingsError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid configuration, ${problems.length} problem${problems.length === 1 ? '' : 's'}:\n${problems.map((p) => `  - ${p}`).join('\n')}`)
    this.name = 'SettingsError'
  }
}

interface Range {
  min?: number
  max?: number
  minEx?: number // exclusive lower bound
  maxEx?: number // exclusive upper bound
  int?: boolean
}

const describe = (r: Range) => {
  const lo = r.minEx !== undefined ? `> ${r.minEx}` : r.min !== undefined ? `>= ${r.min}` : ''
  const hi = r.maxEx !== undefined ? `< ${r.maxEx}` : r.max !== undefined ? `<= ${r.max}` : ''
  return [r.int ? 'an integer' : 'a number', lo, hi].filter(Boolean).join(' ')
}

// Remote endpoints must use TLS; plain http is accepted for the local machine only (a local model server, a local collector).
const isSecure = (s: string) => {
  try {
    const u = new URL(s)
    return u.protocol === 'https:' || (u.protocol === 'http:' && ['localhost', '127.0.0.1', '::1', '[::1]'].includes(u.hostname.toLowerCase()))
  } catch {
    return false
  }
}

const isUrl = (s: string) => {
  try {
    const u = new URL(s)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

// Range and cross-field checks on a structurally valid (right keys, right types) settings tree. Returns every problem.
export function validateSettings(s: Settings): string[] {
  const out: string[] = []
  const add = (path: string, msg: string) => out.push(`${path}: ${msg}`)

  const num = (path: string, v: unknown, r: Range = {}) => {
    const ok =
      typeof v === 'number' &&
      Number.isFinite(v) &&
      (r.min === undefined || v >= r.min) &&
      (r.max === undefined || v <= r.max) &&
      (r.minEx === undefined || v > r.minEx) &&
      (r.maxEx === undefined || v < r.maxEx) &&
      (!r.int || Number.isInteger(v))
    if (!ok) add(path, `must be ${describe(r)}, got ${JSON.stringify(v)}`)
    return ok
  }
  const str = (path: string, v: unknown, allowEmpty = false) => {
    const ok = typeof v === 'string' && (allowEmpty || v.trim().length > 0)
    if (!ok) add(path, `must be a ${allowEmpty ? '' : 'non-empty '}string`)
    return ok
  }
  const oneOf = (path: string, v: unknown, allowed: readonly unknown[]) => {
    if (!allowed.includes(v)) add(path, `must be one of ${allowed.join(', ')}, got ${JSON.stringify(v)}`)
  }
  const url = (path: string, v: string, allowEmpty = false) => {
    if (v === '' && allowEmpty) return
    if (!isUrl(v)) add(path, `must be an http(s) URL, got ${JSON.stringify(v)}`)
  }
  const list = <T>(path: string, v: unknown): v is T[] => {
    if (!Array.isArray(v)) {
      add(path, 'must be an array')
      return false
    }
    return true
  }

  const { run, wallex, fees, paper, market, risk, strategy, detect: d, ai, pullout, research, data, logging, telemetry, dashboard } = s

  num('run.entryCutoffMin', run.entryCutoffMin, { min: 0 })
  num('run.defaultHours', run.defaultHours, { minEx: 0, max: 24 * 14 })
  if (run.end !== '' && !Number.isFinite(Date.parse(run.end))) add('run.end', `must be empty or an ISO time such as 2026-10-23T18:00:00Z, got ${JSON.stringify(run.end)}`)
  const runMin = run.defaultHours * 60
  if (run.end === '' && run.entryCutoffMin >= runMin) add('run.entryCutoffMin', `must be less than the run length (${runMin} min = run.defaultHours)`)

  url('wallex.baseUrl', wallex.baseUrl)
  if (isUrl(wallex.baseUrl) && !isSecure(wallex.baseUrl)) add('wallex.baseUrl', 'must use https (the API key travels in a header)')
  num('wallex.requestTimeoutMs', wallex.requestTimeoutMs, { minEx: 0, int: true })
  num('wallex.pollMs', wallex.pollMs, { min: 1000, int: true })
  num('wallex.tickMs', wallex.tickMs, { min: 250, int: true })
  num('wallex.warmupHours', wallex.warmupHours, { minEx: 0, max: 36 })

  num('fees.maker', fees.maker, { min: 0, max: 0.02 })
  num('fees.taker', fees.taker, { min: 0, max: 0.02 })

  num('paper.spreadBps', paper.spreadBps, { min: 0, max: 1000 })
  num('paper.slippageBps', paper.slippageBps, { min: 0, max: 1000 })
  num('paper.startTmn', paper.startTmn, { minEx: 0 })

  if (list<string>('market.symbols', market.symbols)) {
    market.symbols.forEach((x, i) => {
      if (!/^[A-Z0-9]{3,}$/.test(x)) add(`market.symbols.${i}`, `must be an upper-case market symbol such as PEPETMN, got ${JSON.stringify(x)}`)
    })
    if (market.symbols.length === 0 && !market.universe.auto) add('market.symbols', 'must not be empty unless market.universe.auto is true')
  }
  const u = market.universe
  num('market.universe.minVolTmn', u.minVolTmn, { min: 0 })
  num('market.universe.maxSpreadPct', u.maxSpreadPct, { minEx: 0, max: 1 })
  num('market.universe.minRangePct', u.minRangePct, { min: 0, max: 1 })
  num('market.universe.max', u.max, { min: 1, int: true })
  if (list<string>('market.universe.exclude', u.exclude)) u.exclude.forEach((x, i) => str(`market.universe.exclude.${i}`, x))
  str('market.blockedFile', market.blockedFile)

  num('risk.riskPct', risk.riskPct, { minEx: 0, max: 0.05 })
  num('risk.maxPositionPct', risk.maxPositionPct, { minEx: 0, max: 1 })
  num('risk.slippagePct', risk.slippagePct, { min: 0, max: 0.05 })
  num('risk.maxPositions', risk.maxPositions, { min: 1, max: 20, int: true })
  num('risk.dayLossHalt', risk.dayLossHalt, { minEx: 0, maxEx: 1 })
  num('risk.hardDrawdown', risk.hardDrawdown, { minEx: 0, maxEx: 1 })
  if (risk.dayLossHalt > risk.hardDrawdown) add('risk.dayLossHalt', `must be <= risk.hardDrawdown (${risk.hardDrawdown}): the daily halt would never trigger first`)
  if (list<{ pnl: number; riskPct: number }>('risk.lockTiers', risk.lockTiers)) {
    if (risk.lockTiers.length > 2) add('risk.lockTiers', `at most 2 tiers are supported, got ${risk.lockTiers.length}`)
    risk.lockTiers.forEach((t, i) => {
      if (!t || typeof t !== 'object') return add(`risk.lockTiers.${i}`, 'must be a table with pnl and riskPct')
      if (t.pnl === undefined) add(`risk.lockTiers.${i}.pnl`, 'is missing')
      else num(`risk.lockTiers.${i}.pnl`, t.pnl, { minEx: 0 })
      if (t.riskPct === undefined) add(`risk.lockTiers.${i}.riskPct`, 'is missing')
      else num(`risk.lockTiers.${i}.riskPct`, t.riskPct, { minEx: 0, max: 0.05 })
      const prev = risk.lockTiers[i - 1]
      if (prev && typeof prev.pnl === 'number' && typeof t.pnl === 'number' && t.pnl <= prev.pnl) add(`risk.lockTiers.${i}.pnl`, `must be greater than the previous tier's pnl (${prev.pnl})`)
    })
  }
  str('risk.killFile', risk.killFile, true)
  num('risk.maxOrderTmn', risk.maxOrderTmn, { minEx: 0 })
  num('risk.maxPriceDeviation', risk.maxPriceDeviation, { minEx: 0, max: 0.5 })

  oneOf('strategy.active', strategy.active, ['combo', 'breakout', 'ict', 'noop'])
  const wo = strategy.washout
  num('strategy.washout.signalMinutes', wo.signalMinutes, { min: 1, max: 240, int: true })
  num('strategy.washout.lookbackMinutes', wo.lookbackMinutes, { min: 1, max: 1440, int: true })
  num('strategy.washout.dropPct', wo.dropPct, { minEx: 0, max: 0.5 })
  num('strategy.washout.takeProfitPct', wo.takeProfitPct, { minEx: 0, max: 1 })
  num('strategy.washout.stopPct', wo.stopPct, { minEx: 0, max: 0.5 })
  num('strategy.washout.maxHoldMinutes', wo.maxHoldMinutes, { min: 1, max: 24 * 60 * 14, int: true })
  num('strategy.washout.crashDropPct', wo.crashDropPct, { minEx: 0, max: 0.5 })
  num('strategy.washout.crashBreadthMax', wo.crashBreadthMax, { min: 0, max: 1 })
  num('strategy.washout.riskMult', wo.riskMult, { minEx: 0, max: 2 })
  const bo = strategy.breakout
  num('strategy.breakout.lookbackHours', bo.lookbackHours, { min: 2, max: 2000, int: true })
  num('strategy.breakout.emaHours', bo.emaHours, { min: 2, max: 2000, int: true })
  num('strategy.breakout.atrHours', bo.atrHours, { min: 2, max: 500, int: true })
  num('strategy.breakout.stopAtr', bo.stopAtr, { minEx: 0, max: 50 })
  num('strategy.breakout.trailAtr', bo.trailAtr, { minEx: 0, max: 50 })
  num('strategy.breakout.volumeMult', bo.volumeMult, { min: 0, max: 20 })
  num('strategy.breakout.maxChaseAtr', bo.maxChaseAtr, { minEx: 0, max: 50 })
  num('strategy.breakout.breadthMin', bo.breadthMin, { min: 0, max: 1 })
  num('strategy.breakout.breadthEmaHours', bo.breadthEmaHours, { min: 2, max: 2000, int: true })
  num('strategy.breakout.maxHoldHours', bo.maxHoldHours, { min: 1, max: 24 * 60 })
  num('strategy.breakout.warmupDays', bo.warmupDays, { min: 0, max: 30 })
  num('strategy.breakout.entrySlip', bo.entrySlip, { min: 0, max: 0.02 })
  num('strategy.breakout.stopExitSlip', bo.stopExitSlip, { min: 0, max: 0.12 })
  num('strategy.breakout.stopExitSlipMax', bo.stopExitSlipMax, { minEx: 0, max: 0.5 })
  if (bo.stopExitSlip > bo.stopExitSlipMax) add('strategy.breakout.stopExitSlip', `must be <= strategy.breakout.stopExitSlipMax (${bo.stopExitSlipMax})`)
  const ict = strategy.ict
  num('strategy.ict.maxSpreadPct', ict.maxSpreadPct, { minEx: 0, max: 1 })
  num('strategy.ict.minNetRr', ict.minNetRr, { minEx: 0, max: 20 })
  num('strategy.ict.tp1Fraction', ict.tp1Fraction, { minEx: 0, max: 1 })
  num('strategy.ict.timeStopBars', ict.timeStopBars, { min: 1, int: true })
  num('strategy.ict.stopExitSlip', ict.stopExitSlip, { min: 0, max: 0.12 })
  num('strategy.ict.stopExitSlipMax', ict.stopExitSlipMax, { minEx: 0, max: 0.5 })
  num('strategy.ict.breakEvenBuffer', ict.breakEvenBuffer, { min: 0, max: 0.05 })
  if (ict.stopExitSlip > ict.stopExitSlipMax) add('strategy.ict.stopExitSlip', `must be <= strategy.ict.stopExitSlipMax (${ict.stopExitSlipMax})`)

  num('detect.swingN', d.swingN, { min: 1, max: 10, int: true })
  num('detect.minFvgAtr', d.minFvgAtr, { min: 0 })
  num('detect.displacementAtr', d.displacementAtr, { minEx: 0 })
  num('detect.minSweepDepthPct', d.minSweepDepthPct, { min: 0, maxEx: 0.05 })
  num('detect.oteLow', d.oteLow, { min: 0, max: 1 })
  num('detect.oteHigh', d.oteHigh, { min: 0, max: 1 })
  if (d.oteLow >= d.oteHigh) add('detect.oteLow', `must be less than detect.oteHigh (${d.oteHigh})`)
  num('detect.stopBufferAtr', d.stopBufferAtr, { min: 0 })
  num('detect.minStopPct', d.minStopPct, { minEx: 0, max: 0.2 })
  num('detect.maxStopPct', d.maxStopPct, { minEx: 0, max: 0.2 })
  if (d.minStopPct >= d.maxStopPct) add('detect.minStopPct', `must be less than detect.maxStopPct (${d.maxStopPct})`)
  num('detect.setupMaxAgeBars1m', d.setupMaxAgeBars1m, { min: 1, int: true })
  num('detect.minScore', d.minScore, { min: 0, max: 9, int: true })
  if (list<string>('detect.models', d.models)) {
    if (!d.models.length) add('detect.models', 'must not be empty')
    d.models.forEach((m, i) => oneOf(`detect.models.${i}`, m, ['sweep', 'continuation']))
  }
  num('detect.minGrossRr', d.minGrossRr, { minEx: 0, max: 50 })
  if (list<number>('detect.scanTimeframes', d.scanTimeframes)) {
    if (!d.scanTimeframes.length) add('detect.scanTimeframes', 'must not be empty')
    d.scanTimeframes.forEach((t, i) => oneOf(`detect.scanTimeframes.${i}`, t, [1, 5, 15]))
  }
  num('detect.continuationMaxPullbackBars', d.continuationMaxPullbackBars, { min: 1, int: true })
  num('detect.atrPeriod', d.atrPeriod, { min: 1, max: 200, int: true })
  num('detect.atrFloorPct', d.atrFloorPct, { min: 0, max: 0.1 })
  num('detect.bodyRatio', d.bodyRatio, { minEx: 0, max: 1 })
  num('detect.eqlTolPct', d.eqlTolPct, { min: 0, max: 0.05 })
  num('detect.eqlTolAtr', d.eqlTolAtr, { min: 0, max: 5 })
  num('detect.max1mBars', d.max1mBars, { min: 100, int: true })
  num('detect.minBars1m', d.minBars1m, { min: 30, int: true })
  if (d.minBars1m > d.max1mBars) add('detect.minBars1m', `must be <= detect.max1mBars (${d.max1mBars})`)
  for (const k of ['window1m', 'window5m', 'window15m', 'window1h'] as const) num(`detect.${k}`, d[k], { min: 30, int: true })
  for (const k of ['legMax1m', 'legMax5m', 'legMax15m'] as const) num(`detect.${k}`, d[k], { min: 1, int: true })
  num('detect.mssRefBack', d.mssRefBack, { min: 1, int: true })
  num('detect.bosRefBack', d.bosRefBack, { min: 1, int: true })
  num('detect.htfBiasBars', d.htfBiasBars, { min: 1, int: true })
  num('detect.sessionStartHour', d.sessionStartHour, { min: 0, max: 24, int: true })
  num('detect.sessionEndHour', d.sessionEndHour, { min: 0, max: 24, int: true })
  if (d.sessionStartHour >= d.sessionEndHour) add('detect.sessionStartHour', `must be less than detect.sessionEndHour (${d.sessionEndHour})`)
  num('detect.strongDisplacementAtr', d.strongDisplacementAtr, { minEx: 0 })
  num('detect.deepDiscountPos', d.deepDiscountPos, { min: 0, max: 1 })
  num('detect.strongRr', d.strongRr, { minEx: 0 })

  oneOf('ai.failMode', ai.failMode, ['approve', 'veto'])
  url('ai.baseUrl', ai.baseUrl, true)
  if (ai.baseUrl && isUrl(ai.baseUrl) && !isSecure(ai.baseUrl)) add('ai.baseUrl', 'must use https unless it is a model server on this machine')
  str('ai.model', ai.model)
  num('ai.timeoutMs', ai.timeoutMs, { minEx: 0, int: true })
  num('ai.newsTtlMin', ai.newsTtlMin, { minEx: 0 })
  num('ai.newsTimeoutMs', ai.newsTimeoutMs, { minEx: 0, int: true })
  num('ai.newsWaitMs', ai.newsWaitMs, { min: 0, int: true })
  if (list<{ source: string; url: string }>('ai.feeds', ai.feeds)) {
    ai.feeds.forEach((f, i) => {
      if (!f || typeof f !== 'object') return add(`ai.feeds.${i}`, 'must be a table with source and url')
      if (f.source === undefined) add(`ai.feeds.${i}.source`, 'is missing')
      else str(`ai.feeds.${i}.source`, f.source)
      if (f.url === undefined) add(`ai.feeds.${i}.url`, 'is missing')
      else {
        url(`ai.feeds.${i}.url`, f.url)
        if (isUrl(f.url) && !isSecure(f.url)) add(`ai.feeds.${i}.url`, 'must use https')
      }
    })
  }
  url('ai.fearGreedUrl', ai.fearGreedUrl)
  url('ai.trendingUrl', ai.trendingUrl)
  for (const [k, v] of [['ai.fearGreedUrl', ai.fearGreedUrl], ['ai.trendingUrl', ai.trendingUrl]] as const) if (isUrl(v) && !isSecure(v)) add(k, 'must use https')
  num('ai.maxHeadlines', ai.maxHeadlines, { min: 0, int: true })
  num('ai.contextWindow', ai.contextWindow, { minEx: 0, int: true })
  if (ai.instructionsFile !== '' && !existsSync(ai.instructionsFile)) add('ai.instructionsFile', `file not found: ${ai.instructionsFile}`)

  if (list<number>('pullout.slippageSteps', pullout.slippageSteps)) {
    if (!pullout.slippageSteps.length) add('pullout.slippageSteps', 'must not be empty')
    pullout.slippageSteps.forEach((x, i) => {
      num(`pullout.slippageSteps.${i}`, x, { minEx: 0, max: 0.5 })
      if (i > 0 && x < pullout.slippageSteps[i - 1]!) add(`pullout.slippageSteps.${i}`, 'must not be smaller than the previous step')
    })
  }
  num('pullout.waitMs', pullout.waitMs, { min: 0, int: true })

  num('research.trainSplit', research.trainSplit, { minEx: 0, maxEx: 1 })
  num('research.minTrainTrades', research.minTrainTrades, { min: 0, int: true })
  num('research.warmupHours', research.warmupHours, { min: 0 })
  num('research.defaultDays', research.defaultDays, { minEx: 0 })

  str('data.dataDir', data.dataDir)
  num('data.cacheCompleteAfterSec', data.cacheCompleteAfterSec, { min: 0 })
  num('data.historyBars', data.historyBars, { min: 100, int: true })
  str('logging.dir', logging.dir)
  str('logging.stateDir', logging.stateDir)

  num('telemetry.prometheusPort', telemetry.prometheusPort, { min: 0, max: 65535, int: true })
  str('telemetry.prometheusHost', telemetry.prometheusHost)
  url('telemetry.otlpEndpoint', telemetry.otlpEndpoint, true)
  if (telemetry.otlpEndpoint && isUrl(telemetry.otlpEndpoint) && !isSecure(telemetry.otlpEndpoint) && !/^http:\/\/[a-z0-9-]+(:\d+)?(\/|$)/i.test(telemetry.otlpEndpoint)) add('telemetry.otlpEndpoint', 'must use https, a localhost URL or a single-label container host name')
  num('telemetry.otlpIntervalMs', telemetry.otlpIntervalMs, { min: 1000, int: true })
  str('dashboard.host', dashboard.host)
  num('dashboard.port', dashboard.port, { min: 0, max: 65535, int: true })
  str('dashboard.root', dashboard.root, true)
  return out
}
