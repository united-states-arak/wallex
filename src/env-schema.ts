import { createEnv } from '@t3-oss/env-core'
import { z } from 'zod'

// Every environment variable the app reads. Variables that also have a setting (listed in LEGACY_ALIASES) are only type
// checked here; ranges and cross-field rules stay in src/settings/validate.ts so there is one place for them.
const clean = (v: unknown) => (typeof v === 'string' ? v.trim() : v)
const text = (inner: z.ZodType = z.string()) => z.preprocess(clean, inner)
const lower = (v: unknown) => (typeof v === 'string' ? v.trim().toLowerCase() : v)

const flag = z.preprocess(lower, z.enum(['true', 'false', '1', '0', 'yes', 'no'])).transform((v) => v === 'true' || v === '1' || v === 'yes')
const num = z.coerce.number({ error: 'must be a number' })
const int = z.coerce.number({ error: 'must be a number' }).int({ error: 'must be a whole number' })
const isoTime = text(z.string().refine((v) => !Number.isNaN(Date.parse(v)), 'must be an ISO time such as 2026-10-23T18:00:00Z'))
const url = text(z.string().url({ error: 'must be a URL' }))

export const envShape = {
  // Operational variables (not settings).
  STARCOACH_MODE: z.preprocess(lower, z.enum(['live', 'paper', 'dry'])).default('paper'),
  STARCOACH_CONFIRM_LIVE: z.literal('yes').optional(),
  STARCOACH_ARGS: z.string().optional(),
  HEALTH_MAX_AGE_S: int.positive().optional(),
  GIT_SHA: z.string().optional(),

  // Config selection.
  STARCOACH_PROFILE: text(z.string().regex(/^[a-z0-9_-]+$/i, 'must be a profile name from config/profiles')).optional(),
  STARCOACH_CONFIG_DIR: z.string().optional(),

  // Secrets: environment only, never read from config files.
  WALLEX_API_KEY: text(z.string().min(1)).optional(),
  AI_API_KEY: text(z.string().min(1)).optional(),
  // Shared secret for the dashboard's kill-switch button. At least 16 characters. Required when the dashboard is bound off localhost.
  DASHBOARD_TOKEN: text(z.string().min(16, 'must be at least 16 characters')).optional(),

  // Legacy names for settings (see LEGACY_ALIASES).
  WALLEX_BASE_URL: url.optional(),
  MAKER_FEE: num.optional(),
  TAKER_FEE: num.optional(),
  PAPER_SPREAD_BPS: num.optional(),
  PAPER_SLIPPAGE_BPS: num.optional(),
  START_TMN: num.optional(),
  SYMBOLS: z.string().optional(),

  RISK_PCT: num.optional(),
  LOCK1_PNL: num.optional(),
  LOCK1_RISK: num.optional(),
  LOCK2_PNL: num.optional(),
  LOCK2_RISK: num.optional(),
  DAILY_LOSS_HALT: num.optional(),
  HARD_DRAWDOWN: num.optional(),

  RUN_END: isoTime.optional(),
  ENTRY_CUTOFF_MIN: num.optional(),

  AI_BASE_URL: url.optional(),
  AI_MODEL: text(z.string().min(1)).optional(),
  AI_TIMEOUT_MS: int.optional(),
  AI_FAIL_MODE: z.preprocess(lower, z.enum(['approve', 'veto'])).optional(),

  OTEL_SDK_DISABLED: flag.optional(),
  OTEL_PROMETHEUS_PORT: int.optional(),
  OTEL_PROMETHEUS_HOST: text().optional(),
  OTEL_EXPORTER_OTLP_ENDPOINT: url.optional(),
  OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: url.optional(),
  OTEL_EXPORTER_OTLP_HEADERS: z.string().optional(),
  DASHBOARD_ROOT: z.string().optional(),
}

export class EnvError extends Error {
  constructor(public readonly problems: string[]) {
    super(problems.join('\n'))
    this.name = 'EnvError'
  }
}

type Source = Record<string, string | undefined>

// Validates `source` against the schema. Throws EnvError listing every problem.
export function readEnv(source: Source) {
  return createEnv({
    server: envShape,
    // copy: emptyStringAsUndefined edits the object it is given
    runtimeEnv: { ...source },
    emptyStringAsUndefined: true,
    skipValidation: source.SKIP_ENV_VALIDATION === '1',
    onValidationError: (issues) => {
      throw new EnvError(issues.map((i) => `env ${i.path?.map(String).join('.') ?? '?'}: ${i.message}`))
    },
  })
}
