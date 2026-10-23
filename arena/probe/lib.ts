// Shared helpers for the real-money order lifecycle probe. Production path: WallexRest + LiveExchange.
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { LiveExchange } from '../../src/exchange/live'
import { loadBlocked } from '../../src/exchange/validate'
import { openLog, type Log } from '../../src/log'
import type { OrderReq } from '../../src/types'
import { WallexRest } from '../../src/wallex/rest'
import { raw, redact } from './raw'

export const MAX_NOTIONAL = 100_000
export const MAX_OPEN = 4
export const MAX_AT_RISK = 400_000

const LOG_PATH_FILE = 'arena/probe/.logpath'
// One probe log across all step invocations.
function probeLog(): Log {
  if (existsSync(LOG_PATH_FILE)) {
    const path = readFileSync(LOG_PATH_FILE, 'utf8').trim()
    const fn = (event: string, data: Record<string, unknown> = {}) => appendFileSync(path, JSON.stringify({ ts: new Date().toISOString(), event, ...data }) + '\n')
    return Object.assign(fn, { path })
  }
  const l = openLog('probe')
  Bun.write(LOG_PATH_FILE, l.path!)
  return l
}

export const log = probeLog()
export const rest = new WallexRest()
export const meta = await rest.markets()
export const blocked = loadBlocked()
export const ex = new LiveExchange(rest, meta, blocked, log)

export const lat: Record<string, number[]> = {}
export async function timed<T>(name: string, f: () => Promise<T>): Promise<T> {
  const t0 = performance.now()
  try {
    return await f()
  } finally {
    const ms = Math.round(performance.now() - t0)
    ;(lat[name] ??= []).push(ms)
    log('probe.latency', { call: name, ms })
  }
}

export const balances = () => timed('balances', () => ex.balances())
export const openOrders = (s?: string) => timed('openOrders', () => ex.openOrders(s))
export const quote = (s: string) => timed('depth', () => ex.quote(s))
export const rawOpen = () => timed('openOrders', () => rest.rawOpenOrders())

export async function getOrder(clientId: string) {
  const r = await timed('getOrder', () => raw('GET', `/v1/account/orders/${encodeURIComponent(clientId)}`))
  return r
}

export class Abort extends Error {}

export async function place(o: Omit<OrderReq, 'type'> & { reason: string }) {
  if (!o.symbol.endsWith('TMN') || blocked.has(o.symbol)) throw new Abort(`symbol ${o.symbol} not allowed`)
  const notional = o.quantity * (o.price ?? 0)
  if (!(notional > 0) || notional > MAX_NOTIONAL) throw new Abort(`notional ${notional} outside cap`)
  const open = await openOrders()
  if (open.length >= MAX_OPEN) throw new Abort(`already ${open.length} open orders`)
  const atRisk = open.reduce((s, x) => s + x.price * x.quantity, 0) + notional
  if (atRisk > MAX_AT_RISK) throw new Abort(`at-risk ${atRisk} above cap`)
  log('probe.order', { ...o, type: 'LIMIT', notional: Math.round(notional) })
  const ack = await timed('place', () => ex.place({ ...o, type: 'LIMIT' }))
  log('probe.ack', { ack })
  return ack
}

// via 'rest' returns the raw cancel result (LiveExchange.cancel discards it); via 'ex' is the daemon path.
export async function cancel(clientId: string, reason: string, via: 'rest' | 'ex' = 'rest') {
  log('probe.cancel', { clientId, reason, via })
  try {
    const result = await timed('cancel', () => (via === 'rest' ? rest.cancelOrder(clientId) : ex.cancel(clientId)))
    log('probe.cancel_result', { clientId, result })
    return { ok: true as const, result }
  } catch (e: any) {
    log('probe.cancel_failed', { clientId, error: String(e), body: e?.body })
    return { ok: false as const, error: String(e), body: e?.body }
  }
}

export const nz = (b: Record<string, { free: number; locked: number }>) => Object.fromEntries(Object.entries(b).filter(([, v]) => v.free > 0 || v.locked > 0))

export function saveLat() {
  const f = 'arena/probe/.latency.json'
  const prev: Record<string, number[]> = existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : {}
  for (const [k, v] of Object.entries(lat)) (prev[k] ??= []).push(...v)
  Bun.write(f, JSON.stringify(prev))
}

export const show = (label: string, x: unknown) => console.log(label, redact(JSON.stringify(x)))
