import { envShape } from '../src/env-schema'

// Keep the suite hermetic: no user config folder, profile or environment variable may change defaults under test.
// (Only the schema module is imported here, so nothing validates the real environment before it is cleared.)
for (const k of Object.keys(envShape)) delete process.env[k]
delete process.env.SKIP_ENV_VALIDATION
for (const k of Object.keys(process.env)) if (k.startsWith('STARCOACH__')) delete process.env[k]
process.env.STARCOACH_CONFIG_DIR = '/nonexistent-starcoach-config'
