import { EnvError, envShape, readEnv } from './env-schema'

export { EnvError, envShape, readEnv }

// Typed, validated view of the process environment. Importing this module validates it once: a bad value prints every
// problem and exits with status 78 (EX_CONFIG). Secrets and operational variables (STARCOACH_MODE, STARCOACH_CONFIRM_LIVE,
// STARCOACH_ARGS, HEALTH_MAX_AGE_S, GIT_SHA) live only here.
//
// Priority: ENV > config/local.toml > config/profiles/<name>.toml > config/default.toml > code defaults.
// The settings loader (src/settings) builds its environment layer from the same validated values, then adds the dynamic
// STARCOACH__section__key overrides and maps the legacy names in LEGACY_ALIASES onto settings.
function load() {
  try {
    return readEnv(process.env)
  } catch (e) {
    if (!(e instanceof EnvError)) throw e
    console.error(`Invalid environment variables:\n${e.problems.map((p) => `  ${p}`).join('\n')}`)
    process.exit(78)
  }
}

export const env = load()
export type Env = typeof env
