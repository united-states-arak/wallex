import type { Exchange, Markets } from './types'
import { floorTo } from './exchange/validate'
import { nullLog, type Log } from './log'
import { getSettings } from './settings'

export interface Holding {
  asset: string
  symbol: string
  qty: number
  bid: number
  value: number
}

export interface PulloutReport {
  executed: boolean
  sells: Holding[]
  dust: Holding[]
  unroutable: string[]
  remaining: Holding[]
  tmn: number
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// Holdings are only ever sold through their TMN market: the challenge allows TMN markets only and requires the result in TMN.
export function routeFor(asset: string, meta: Markets): string | null {
  return meta[`${asset}TMN`] ? `${asset}TMN` : null
}

export async function planPullout(ex: Exchange, meta: Markets) {
  const bals = await ex.balances()
  const sells: Holding[] = []
  const dust: Holding[] = []
  const unroutable: string[] = []
  for (const [asset, b] of Object.entries(bals)) {
    if (asset === 'TMN') continue
    const qty = b.free + b.locked
    if (!(qty > 0)) continue
    const symbol = routeFor(asset, meta)
    if (!symbol) {
      unroutable.push(asset)
      continue
    }
    const m = meta[symbol]!
    const { bid } = await ex.quote(symbol)
    const sellQty = floorTo(qty, m.qtyDecimals)
    if (sellQty < m.minQty || sellQty * bid < m.minNotional) dust.push({ asset, symbol, qty, bid, value: qty * bid })
    else sells.push({ asset, symbol, qty: sellQty, bid, value: sellQty * bid })
  }
  sells.sort((a, b) => Number(a.asset === 'USDT') - Number(b.asset === 'USDT'))
  return { sells, dust, unroutable, tmn: (bals.TMN?.free ?? 0) + (bals.TMN?.locked ?? 0) }
}

export async function pullout(
  ex: Exchange,
  meta: Markets,
  opts: { execute: boolean; waitMs?: number; log?: Log },
): Promise<PulloutReport> {
  // Marketable limit sells walk the book, so they work on markets where market orders are disabled.
  const { slippageSteps: SLIPPAGE_STEPS, waitMs: defaultWaitMs } = getSettings().pullout
  const { execute, waitMs = defaultWaitMs, log = nullLog } = opts
  const runId = Date.now().toString(36)

  if (!execute) {
    const plan = await planPullout(ex, meta)
    log('pullout.plan', { ...plan })
    return { executed: false, ...plan, remaining: [] }
  }

  // One failed cancel (for example an order that filled a moment ago) must not stop the rest of the pullout.
  const cancel = async (clientId: string, symbol: string) => {
    try {
      await ex.cancel(clientId)
      log('pullout.cancel', { clientId, symbol })
    } catch (e) {
      log('pullout.cancel_failed', { clientId, symbol, error: String(e) })
    }
  }

  for (const o of await ex.openOrders()) await cancel(o.clientId, o.symbol)

  const attempts = new Map<string, number>()
  let seq = 0
  for (let round = 0; round < SLIPPAGE_STEPS.length; round++) {
    const plan = await planPullout(ex, meta)
    if (plan.sells.length === 0) break
    for (const h of plan.sells) {
      const m = meta[h.symbol]!
      const tries = attempts.get(h.asset) ?? 0
      attempts.set(h.asset, tries + 1)
      const slip = SLIPPAGE_STEPS[Math.min(tries, SLIPPAGE_STEPS.length - 1)]!
      const price = floorTo(h.bid * (1 - slip), m.priceDecimals)
      const clientId = `po_${runId}_${seq++}`
      const ack = await ex.place({
        clientId,
        symbol: h.symbol,
        side: 'SELL',
        type: 'LIMIT',
        price,
        quantity: h.qty,
        reason: 'pullout: convert holdings to TMN',
      })
      log('pullout.sell', { asset: h.asset, symbol: h.symbol, qty: h.qty, price, slip, round, ack })
    }
    if (waitMs > 0) await sleep(waitMs)
    for (const o of await ex.openOrders()) {
      if (!o.clientId.startsWith(`po_${runId}_`)) continue
      await cancel(o.clientId, o.symbol)
    }
  }

  const after = await planPullout(ex, meta)
  log('pullout.done', { tmn: after.tmn, remaining: after.sells, dust: after.dust, unroutable: after.unroutable })
  return { executed: true, sells: [], dust: after.dust, unroutable: after.unroutable, remaining: after.sells, tmn: after.tmn }
}
