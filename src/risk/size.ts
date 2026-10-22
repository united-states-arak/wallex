import { getSettings } from '../settings'
import { floorTo } from '../exchange/validate'

export interface SizeInput {
  equity: number
  entry: number
  stop: number
  qtyDecimals: number
  minNotional: number
  riskPct?: number
  capPct?: number
  slipPct?: number
  makerFee?: number
  takerFee?: number
}

export interface SizeResult {
  ok: boolean
  reason?: string
  qty: number
  notional: number
  capped: boolean
  lossAtStop: number
  lossPct: number
}

// Position value N is chosen so that a stop-out loses riskPct of equity,
// counting maker fee on entry, taker fee on the stop exit, and slippage.
export function positionSize(i: SizeInput): SizeResult {
  const S = getSettings()
  const { riskPct = S.risk.riskPct, capPct = S.risk.maxPositionPct, slipPct = S.risk.slippagePct, makerFee = S.fees.maker, takerFee = S.fees.taker } = i
  const none = (reason: string): SizeResult => ({ ok: false, reason, qty: 0, notional: 0, capped: false, lossAtStop: 0, lossPct: 0 })
  if (!(i.stop > 0 && i.stop < i.entry)) return none('stop must be below entry')

  const s = (i.entry - i.stop) / i.entry
  const costPerValue = s + makerFee + (1 - s) * takerFee + slipPct
  let notional = (i.equity * riskPct) / costPerValue
  const cap = i.equity * capPct
  const capped = notional > cap
  if (capped) notional = cap

  const qty = floorTo(notional / i.entry, i.qtyDecimals)
  const value = qty * i.entry
  if (!(qty > 0) || value < i.minNotional) return none(`position value ${Math.round(value)} below minNotional ${i.minNotional}`)

  const lossAtStop = value * costPerValue
  return { ok: true, qty, notional: value, capped, lossAtStop, lossPct: lossAtStop / i.equity }
}
