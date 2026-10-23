// Final state + latency summary.
import { readFileSync } from 'node:fs'
import { balances, nz, rawOpen, show } from './lib'
show('final open orders (raw)', await rawOpen())
show('final balances', nz(await balances()))
const lat: Record<string, number[]> = JSON.parse(readFileSync('arena/probe/.latency.json', 'utf8'))
for (const [k, v] of Object.entries(lat)) {
  const s = [...v].sort((a, b) => a - b)
  console.log(k.padEnd(11), 'n', s.length, 'median', s[Math.floor((s.length - 1) / 2)], 'worst', s[s.length - 1])
}
