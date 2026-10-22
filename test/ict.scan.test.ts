import { expect, test } from 'bun:test'
import { netRr, parseParams } from '../src/ict/scan'

test('--param overrides parse numbers, booleans and comma lists', () => {
  const p = parseParams(['minScore=3', 'freshnessUseClose=false', 'scanTimeframes=1,5', 'models=sweep'])
  expect(p).toEqual({ minScore: 3, freshnessUseClose: false, scanTimeframes: [1, 5], models: ['sweep'] })
  expect(parseParams([], 'continuation')).toEqual({ models: ['continuation'] })
  expect(parseParams([], 'both')).toEqual({})
  expect(() => parseParams(['nope=1'])).toThrow()
  expect(() => parseParams([], 'x')).toThrow()
})

test('net RR is below gross RR after fees', () => {
  const gross = (110 - 100) / (100 - 98)
  const net = netRr(100, 98, 110)
  expect(net).toBeLessThan(gross)
  expect(net).toBeGreaterThan(0)
})
