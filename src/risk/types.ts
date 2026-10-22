export interface GuardState {
  equity: number
  startEquity: number
  dayPeak: number
  dayPnlPct: number
  totalPnlPct: number
  consecutiveLosses: number
  halted: boolean
  haltReason?: string
  riskPct: number // current risk per trade: 1%, then 0.5% or 0.25% after profit lock
}

export interface RiskGuard {
  // Called by the strategy before every entry. Returns why entry is blocked, or null when allowed.
  blockReason(now: number): string | null
  // Risk per trade as a fraction of equity right now (0.01 by default, lowered by profit lock).
  riskPct(): number
  // Called with current equity every cycle and with each closed trade result (pnl as fraction of equity).
  updateEquity(equity: number, now: number): void
  recordTrade(pnlFraction: number, now: number): void
  state(): GuardState
}
