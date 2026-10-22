import { appendFileSync, mkdirSync } from 'node:fs'
import { cfg } from './config'
import { env } from './env'

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

export function openLog(name: string): Log {
  mkdirSync(cfg.logDir, { recursive: true })
  const path = `${cfg.logDir}/${logFileName(name)}`
  const fn = (event: string, data: Record<string, unknown> = {}) => {
    appendFileSync(path, JSON.stringify({ ts: new Date().toISOString(), sha: gitSha, event, ...data }) + '\n')
  }
  return Object.assign(fn, { path })
}
