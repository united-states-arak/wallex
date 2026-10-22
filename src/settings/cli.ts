import '../env'
import { DEFAULTS, SettingsError, explain, listProfiles, loadSettings, settingsHash } from './index'
import { leaves, type Obj } from './schema'

const USAGE = `usage: bun run config <command> [--profile NAME]
  show            effective config with the layer each value came from (secrets redacted)
  validate        check the effective config and every profile; exit 78 and list all problems on error
  diff <profile>  settings that differ between the defaults and the profile
  hash            sha256 of the effective config (secrets excluded)`

const fmt = (v: unknown) => (typeof v === 'string' ? JSON.stringify(v) : JSON.stringify(v))

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? argv[i + 1] : undefined
}

// Importing '../env' exits 78 (EX_CONFIG) on a bad environment variable; bad config files exit 78 too.
function fail(e: unknown): never {
  console.error(e instanceof SettingsError ? e.message : String(e))
  process.exit(e instanceof SettingsError ? 78 : 1)
}

const [cmd, ...rest] = process.argv.slice(2)
const profile = flag(rest, 'profile')

switch (cmd) {
  case 'show': {
    let s
    try {
      s = loadSettings({ profile })
    } catch (e) {
      fail(e)
    }
    const rows = explain(s)
    let section = ''
    for (const r of rows) {
      const top = r.path.split('.')[0]!
      if (top !== section) {
        section = top
        console.log(`\n# [${section}]`)
      }
      console.log(`${r.path} = ${fmt(r.value)}   # ${r.source}`)
    }
    break
  }

  case 'validate': {
    const problems: string[] = []
    try {
      const s = loadSettings({ profile })
      console.log(`effective config OK${profile ? ` (profile ${profile})` : ''}, hash ${settingsHash(s).slice(0, 12)}`)
    } catch (e) {
      if (!(e instanceof SettingsError)) fail(e)
      problems.push(...e.problems.map((p) => `effective config: ${p}`))
    }
    for (const name of listProfiles()) {
      try {
        loadSettings({ profile: name, env: {}, local: false })
        console.log(`profile ${name} OK`)
      } catch (e) {
        if (!(e instanceof SettingsError)) fail(e)
        problems.push(...e.problems.map((p) => `profile ${name}: ${p}`))
      }
    }
    if (problems.length) {
      console.error(`\n${problems.length} problem${problems.length === 1 ? '' : 's'}:\n${problems.map((p) => `  - ${p}`).join('\n')}`)
      process.exit(78)
    }
    break
  }

  case 'diff': {
    const name = rest.find((a) => !a.startsWith('--'))
    if (!name) {
      console.error(USAGE)
      process.exit(1)
    }
    let s
    try {
      s = loadSettings({ profile: name, env: {}, local: false })
    } catch (e) {
      fail(e)
    }
    const base = new Map(leaves(DEFAULTS as unknown as Obj))
    let n = 0
    for (const r of explain(s)) {
      if (JSON.stringify(base.get(r.path)) === JSON.stringify(r.value)) continue
      n++
      console.log(`${r.path}: ${fmt(base.get(r.path))} -> ${fmt(r.value)}`)
    }
    if (!n) console.log(`profile ${name} is identical to the defaults`)
    break
  }

  case 'hash': {
    try {
      console.log(settingsHash(loadSettings({ profile })))
    } catch (e) {
      fail(e)
    }
    break
  }

  default:
    console.error(USAGE)
    process.exit(cmd ? 1 : 0)
}
