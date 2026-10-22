import { expect, test } from 'bun:test'
import { selectUniverse } from '../src/universe'

const mk = (symbol: string, base: string, quote: string, vol: number, hi: number, lo: number, bid: number, ask: number) => ({
  symbol,
  baseAsset: base,
  quoteAsset: quote,
  stats: { '24h_tmnVolume': String(vol), '24h_highPrice': String(hi), '24h_lowPrice': String(lo), bidPrice: String(bid), askPrice: String(ask) },
})

const payload = {
  result: {
    symbols: Object.fromEntries(
      [
        mk('AAATMN', 'AAA', 'TMN', 10e9, 1.1, 1, 1.0, 1.001), // range .1 * 10e9 = 1e9
        mk('BBBTMN', 'BBB', 'TMN', 20e9, 1.05, 1, 1.0, 1.001), // .05 * 20e9 = 1e9, tie -> alphabetical
        mk('CCCTMN', 'CCC', 'TMN', 50e9, 1.2, 1, 1.0, 1.001), // best
        mk('LOWVOLTMN', 'LOWVOL', 'TMN', 1e9, 2, 1, 1, 1.001),
        mk('FLATTMN', 'FLAT', 'TMN', 50e9, 1.01, 1, 1, 1.001),
        mk('WIDETMN', 'WIDE', 'TMN', 50e9, 2, 1, 1, 1.05),
        mk('BLOCKEDTMN', 'BLOCKED', 'TMN', 50e9, 2, 1, 1, 1.001),
        mk('USDTTMN', 'USDT', 'TMN', 90e9, 2, 1, 1, 1.001),
        mk('PAXGTMN', 'PAXG', 'TMN', 90e9, 2, 1, 1, 1.001),
        mk('AAAUSDT', 'AAA', 'USDT', 90e9, 2, 1, 1, 1.001),
        mk('NOBOOKTMN', 'NOBOOK', 'TMN', 50e9, 2, 1, 0, 0),
      ].map((m) => [m.symbol, m]),
    ),
  },
}

test('filters and sorts by range * volume', async () => {
  expect(await selectUniverse(payload, new Set(['BLOCKEDTMN']))).toEqual(['CCCTMN', 'AAATMN', 'BBBTMN'])
})

test('max and thresholds are applied, async source works', async () => {
  expect(await selectUniverse(async () => payload, new Set(['BLOCKEDTMN']), { max: 1 })).toEqual(['CCCTMN'])
  expect(await selectUniverse(payload, new Set(['BLOCKEDTMN']), { minVolTmn: 0.5e9, maxSpreadPct: 0.1, minRangePct: 0.001 })).toContain('LOWVOLTMN')
})
