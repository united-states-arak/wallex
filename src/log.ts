import { appendFileSync, mkdirSync } from 'node:fs'
import { cfg } from './config'
import { env } from './env'
import { redactDeep, secretValues } from './security/redact'

export const gitSha = (() => {
  if (env.GIT_SHA) return env.GIT_SHA
  try {
    return Bun.spawnSync(['git', 'rev-parse', '--short', 'HEAD']).stdout.toString().trim() || 'nogit'
  } catch {
    return 'nogit'
  }
})()

export type Log = ((event: string, data?: Record<string, unknown>) => void) & { path?: string }

export const nullLog: Log = () => {}

// The daemon (`live` command, any mode) writes logs named live-<ISO time>.jsonl; docker/healthcheck.ts looks for exactly this.
export const DAEMON_LOG = 'live'
export const logFileName = (name: string, at = new Date()) => `${name}-${at.toISOString().replace(/[:.]/g, '-')}.jsonl`
export const daemonLogPattern = new RegExp(`^${DAEMON_LOG}-.+\\.jsonl$`)

// Every line is redacted before it is written (credentials never reach disk) and the file is readable by its owner only.
export function openLog(name: string): Log {
  mkdirSync(cfg.logDir, { recursive: true, mode: 0o700 })
  const path = `${cfg.logDir}/${logFileName(name)}`
  const secrets = secretValues()
  const fn = (event: string, data: Record<string, unknown> = {}) => {
    const line = redactDeep({ ts: new Date().toISOString(), sha: gitSha, event, ...data }, secrets)
    appendFileSync(path, JSON.stringify(line) + '\n', { mode: 0o600 })
  }
  return Object.assign(fn, { path })
}
