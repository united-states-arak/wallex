// Legacy environment variables that worked before the settings folder existed. They keep working, mapped onto
// the dotted setting they control. `parse` replaces the generic typing; returning undefined skips the variable.
// An empty value is always ignored, as it was before. Secrets (WALLEX_API_KEY, AI_API_KEY) are read from env only.
export interface LegacyAlias {
  env: string
  path: string
  parse?: (raw: string) => unknown
}

const trim = (raw: string) => raw.trim()

export const LEGACY_ALIASES: LegacyAlias[] = [
  { env: 'WALLEX_API_KEY', path: 'wallex.apiKey', parse: trim },
  { env: 'WALLEX_BASE_URL', path: 'wallex.baseUrl', parse: trim },
  { env: 'MAKER_FEE', path: 'fees.maker' },
  { env: 'TAKER_FEE', path: 'fees.taker' },
  { env: 'PAPER_SPREAD_BPS', path: 'paper.spreadBps' },
  { env: 'PAPER_SLIPPAGE_BPS', path: 'paper.slippageBps' },
  { env: 'START_TMN', path: 'paper.startTmn' },
  { env: 'SYMBOLS', path: 'market.symbols' },

  { env: 'RISK_PCT', path: 'risk.riskPct' },
  { env: 'LOCK1_PNL', path: 'risk.lockTiers.0.pnl' },
  { env: 'LOCK1_RISK', path: 'risk.lockTiers.0.riskPct' },
  { env: 'LOCK2_PNL', path: 'risk.lockTiers.1.pnl' },
  { env: 'LOCK2_RISK', path: 'risk.lockTiers.1.riskPct' },
  { env: 'DAILY_LOSS_HALT', path: 'risk.dayLossHalt' },
  { env: 'HARD_DRAWDOWN', path: 'risk.hardDrawdown' },

  { env: 'RUN_END', path: 'run.end', parse: trim },
  { env: 'ENTRY_CUTOFF_MIN', path: 'run.entryCutoffMin' },

  { env: 'AI_BASE_URL', path: 'ai.baseUrl', parse: (r) => r.trim().replace(/\/+$/, '') },
  { env: 'AI_API_KEY', path: 'ai.apiKey', parse: trim },
  { env: 'AI_MODEL', path: 'ai.model', parse: trim },
  { env: 'AI_TIMEOUT_MS', path: 'ai.timeoutMs' },
  { env: 'AI_FAIL_MODE', path: 'ai.failMode', parse: (r) => r.trim().toLowerCase() },

  // Telemetry and dashboard variables used by their own modules.
  { env: 'OTEL_PROMETHEUS_HOST', path: 'telemetry.prometheusHost', parse: trim },
  { env: 'OTEL_PROMETHEUS_PORT', path: 'telemetry.prometheusPort' },
  { env: 'OTEL_EXPORTER_OTLP_ENDPOINT', path: 'telemetry.otlpEndpoint', parse: trim },
  { env: 'OTEL_EXPORTER_OTLP_METRICS_ENDPOINT', path: 'telemetry.otlpEndpoint', parse: trim },
  { env: 'OTEL_SDK_DISABLED', path: 'telemetry.enabled', parse: (r) => (['true', '1'].includes(r.trim().toLowerCase()) ? false : undefined) },
  { env: 'DASHBOARD_ROOT', path: 'dashboard.root', parse: trim },
]

// Selects the profile file (config/profiles/<name>.toml) and the config folder. Not settings themselves.
export const ENV_PROFILE = 'STARCOACH_PROFILE'
export const ENV_CONFIG_DIR = 'STARCOACH_CONFIG_DIR'
export const ENV_PREFIX = 'STARCOACH__'
