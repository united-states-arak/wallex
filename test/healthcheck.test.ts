import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { daemonLogPattern, logFileName } from '../src/log'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'health-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const check = (extra: Record<string, string> = {}) =>
  Bun.spawnSync(['bun', 'docker/healthcheck.ts'], {
    env: { ...process.env, STARCOACH__logging__dir: dir, ...extra },
    stdout: 'pipe',
    stderr: 'pipe',
  })

test('the pattern matches the daemon log name and nothing else', () => {
  expect(daemonLogPattern.test(logFileName('live'))).toBe(true)
  for (const other of ['backtest', 'shadow', 'dry', 'pullout']) expect(daemonLogPattern.test(logFileName(other))).toBe(false)
})

test('healthy only with a fresh daemon log in logging.dir', () => {
  expect(check().exitCode).toBe(1)
  const file = join(dir, logFileName('live'))
  writeFileSync(join(dir, logFileName('shadow')), '{}\n')
  expect(check().exitCode).toBe(1)
  writeFileSync(file, '{}\n')
  expect(check().exitCode).toBe(0)
  const old = new Date(Date.now() - 600_000)
  utimesSync(file, old, old)
  expect(check().exitCode).toBe(1)
  expect(check({ HEALTH_MAX_AGE_S: '3600' }).exitCode).toBe(0)
})

test('a missing log directory is unhealthy', () => {
  mkdirSync(join(dir, 'x'))
  expect(check({ STARCOACH__logging__dir: join(dir, 'nope') }).exitCode).toBe(1)
})
