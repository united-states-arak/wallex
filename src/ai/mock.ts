import type { Supervisor } from './types'

export function createMockSupervisor(): Supervisor {
  return {
    async review() {
      return { action: 'approve', sizeMult: 1, reason: 'ai disabled', source: 'fallback', model: 'none', latencyMs: 0 }
    },
    async refreshNews() {
      return null
    },
    async close() {},
  }
}
