import { expect, test } from 'bun:test'

function run(extra: Record<string, string>) {
  const p = Bun.spawnSync(['bun', 'src/cli.ts', 'live'], {
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', WALLEX_API_KEY: 'test-key-0123456789', ...extra },
    stderr: 'pipe',
    stdout: 'pipe',
  })
  return { code: p.exitCode, out: p.stderr.toString() + p.stdout.toString() }
}

test('live mode without confirmation refuses to start', () => {
  const r = run({})
  expect(r.code).toBe(1)
  expect(r.out).toContain('--confirm-live')
})

test('live mode without an API key refuses to start', () => {
  const r = run({ WALLEX_API_KEY: '' })
  expect(r.code).toBe(1)
  expect(r.out).toContain('WALLEX_API_KEY')
})
