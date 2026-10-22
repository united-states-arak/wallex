import { existsSync, readdirSync, statSync } from 'node:fs'
import { env } from '../src/env'
import { daemonLogPattern } from '../src/log'
import { loadSettings } from '../src/settings'

// Healthy while the daemon log (logs/live-*.jsonl in logging.dir) was written recently. The daemon logs a heartbeat
// every wallex.pollMs, so the default limit is 3 polls, at least 180 s. Override with HEALTH_MAX_AGE_S.
const S = loadSettings()
const dir = S.logging.dir
const maxAgeS = env.HEALTH_MAX_AGE_S ?? Math.max(180, (3 * S.wallex.pollMs) / 1000)

const newest = existsSync(dir)
  ? readdirSync(dir)
      .filter((f) => daemonLogPattern.test(f))
      .map((f) => ({ f, m: statSync(`${dir}/${f}`).mtimeMs }))
      .sort((a, b) => b.m - a.m)[0]
  : undefined

if (!newest) {
  console.error(`no daemon log (live-*.jsonl) in ${dir} yet`)
  process.exit(1)
}
const age = (Date.now() - newest.m) / 1000
if (age > maxAgeS) {
  console.error(`${newest.f} is ${Math.round(age)}s old (limit ${maxAgeS}s)`)
  process.exit(1)
}
console.log(`ok, ${newest.f} written ${Math.round(age)}s ago`)
