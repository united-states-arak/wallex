import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { ENV_CONFIG_DIR, ENV_PREFIX, ENV_PROFILE, LEGACY_ALIASES } from './aliases'
import { DEFAULTS } from './defaults'
import { EnvError, readEnv } from '../env-schema'
import { ARRAY_ITEMS, canonical, deepClone, didYouMean, elementType, getPath, hint, isObj, isSecret, leaves, nodeAt, setPath, typeName, type Obj } from './schema'
import { SECRET_PATHS, type DeepPartial, type Settings } from './types'
import { SettingsError, validateSettings } from './validate'

export { DEFAULTS } from './defaults'
export { LEGACY_ALIASES } from './aliases'
export { SettingsError, validateSettings } from './validate'
export { SECRET_PATHS, type DeepPartial, type Settings } from './types'

export interface LoadOptions {
  profile?: string
  overrides?: DeepPartial<Settings>
  configDir?: string
  env?: Record<string, string | undefined>
  // Read config/local.toml (default true). `config diff` turns it off to compare a profile with the defaults alone.
  local?: boolean
}

export const DEFAULT_CONFIG_DIR = resolve(import.meta.dir, '../../config')

const SECRET_KEYS = new Set(['apikey', 'secret', 'token', 'password', 'secretkey', 'accesstoken', 'authtoken', 'privatekey'])
const sources = new WeakMap<object, Map<string, string>>()

export interface Explained {
  path: string
  value: unknown
  source: string
}

interface Ctx {
  s: Obj
  src: Map<string, string>
  problems: string[]
}

function markSource(ctx: Ctx, path: string, tag: string) {
  for (const k of [...ctx.src.keys()]) if (k.startsWith(`${path}.`)) ctx.src.delete(k)
  ctx.src.set(path, tag)
}

function rejectSecrets(o: unknown, label: string, prefix = '') {
  if (Array.isArray(o)) return o.forEach((x, i) => rejectSecrets(x, label, `${prefix}.${i}`))
  if (!isObj(o)) return
  for (const [k, v] of Object.entries(o)) {
    const p = prefix ? `${prefix}.${k}` : k
    if (SECRET_KEYS.has(k.toLowerCase().replace(/[_-]/g, ''))) {
      throw new SettingsError([
        `${label}: "${p}" looks like a secret. Secrets are never read from or written to config files; set WALLEX_API_KEY / AI_API_KEY in the environment (or .env) instead`,
      ])
    }
    rejectSecrets(v, label, p)
  }
}

function readToml(file: string, label: string): Obj | null {
  if (!existsSync(file)) return null
  let parsed: unknown
  try {
    parsed = Bun.TOML.parse(readFileSync(file, 'utf8'))
  } catch (e) {
    throw new SettingsError([`${label}: invalid TOML: ${e instanceof Error ? e.message : String(e)}`])
  }
  rejectSecrets(parsed, label)
  return isObj(parsed) ? parsed : {}
}

function checkLeaf(label: string, dotted: string, tmpl: unknown, v: unknown, problems: string[]): boolean {
  const want = typeName(tmpl)
  if (want === 'array') {
    if (!Array.isArray(v)) {
      problems.push(`${label}: ${dotted} must be an array, got ${typeName(v)}`)
      return false
    }
    const et = elementType(dotted)
    let ok = true
    v.forEach((x, i) => {
      if (et === 'object') {
        const shape = ARRAY_ITEMS[dotted]!
        if (!isObj(x)) {
          problems.push(`${label}: ${dotted}.${i} must be a table`)
          ok = false
          return
        }
        for (const [k, val] of Object.entries(x)) {
          if (!(k in shape)) {
            problems.push(`${label}: unknown key "${dotted}.${i}.${k}"${hint(didYouMean(k, Object.keys(shape)), `${dotted}.${i}.`)}`)
            ok = false
          } else if (typeName(val) !== typeName(shape[k])) {
            problems.push(`${label}: ${dotted}.${i}.${k} must be a ${typeName(shape[k])}, got ${typeName(val)}`)
            ok = false
          }
        }
      } else if (typeName(x) !== et) {
        problems.push(`${label}: ${dotted}.${i} must be a ${et}, got ${typeName(x)}`)
        ok = false
      }
    })
    return ok
  }
  if (typeName(v) !== want || (want === 'number' && !Number.isFinite(v as number))) {
    problems.push(`${label}: ${dotted} must be a ${want}, got ${typeName(v)}${want === 'number' || want === 'string' ? ` ${JSON.stringify(v)}` : ''}`)
    return false
  }
  return true
}

// Layer a plain object (TOML file or code overrides) on top of the settings, rejecting unknown keys and wrong types.
function mergeLayer(ctx: Ctx, layer: Obj, label: string, tag: string, quietIfSame = false, prefix: string[] = []) {
  for (const [k, v] of Object.entries(layer)) {
    const path = [...prefix, k]
    const dotted = path.join('.')
    const tmpl = nodeAt(path)
    if (tmpl === undefined) {
      const siblings = nodeAt(prefix)
      const names = prefix.length === 0 ? Object.keys(DEFAULTS) : isObj(siblings) ? Object.keys(siblings) : []
      ctx.problems.push(`${label}: unknown key "${dotted}"${hint(didYouMean(k, names), prefix.length ? `${prefix.join('.')}.` : '')}`)
      continue
    }
    if (isObj(tmpl)) {
      if (!isObj(v)) ctx.problems.push(`${label}: ${dotted} must be a table of settings, got ${typeName(v)}`)
      else mergeLayer(ctx, v, label, tag, quietIfSame, path)
      continue
    }
    if (!checkLeaf(label, dotted, tmpl, v, ctx.problems)) continue
    setPath(ctx.s, path, deepClone(v))
    const same = quietIfSame && JSON.stringify(canonical(v)) === JSON.stringify(canonical(getPath(DEFAULTS, path)))
    if (same) ctx.src.delete(dotted)
    else markSource(ctx, dotted, tag)
  }
}

function coerce(raw: string, tmpl: unknown, dotted: string, varName: string, problems: string[]): unknown {
  const fail = (what: string) => {
    problems.push(`env ${varName}: ${dotted} expects ${what}, got ${JSON.stringify(raw)}`)
    return undefined
  }
  const text = raw.trim()
  switch (typeName(tmpl)) {
    case 'number': {
      const n = Number(text)
      return text !== '' && Number.isFinite(n) ? n : fail('a number')
    }
    case 'boolean': {
      const t = text.toLowerCase()
      if (['true', '1', 'yes', 'on'].includes(t)) return true
      if (['false', '0', 'no', 'off'].includes(t)) return false
      return fail('a boolean (true/false)')
    }
    case 'array': {
      const et = elementType(dotted)
      if (text.startsWith('[')) {
        try {
          const v = JSON.parse(text)
          return Array.isArray(v) ? v : fail('a JSON array')
        } catch {
          return fail('a JSON array')
        }
      }
      if (et === 'object') return fail('a JSON array of objects')
      const parts = text.split(',').map((x) => x.trim()).filter(Boolean)
      if (et === 'number') {
        const nums = parts.map(Number)
        return nums.every(Number.isFinite) ? nums : fail('a comma-separated list of numbers')
      }
      return parts
    }
    default:
      return raw
  }
}

// `known` holds the legacy variables as validated by src/env-schema.ts (typed); `env` is the raw source for STARCOACH__ names.
function applyEnv(ctx: Ctx, env: Record<string, string | undefined>, known: Record<string, unknown>) {
  for (const a of LEGACY_ALIASES) {
    const v = known[a.env]
    const raw = v === undefined || v === null ? undefined : String(v)
    if (raw === undefined || raw.trim() === '') continue
    const segs = a.path.split('.')
    const value = a.parse ? a.parse(raw) : coerce(raw, nodeAt(segs), a.path, a.env, ctx.problems)
    if (value === undefined) continue
    setPath(ctx.s, segs, value)
    markSource(ctx, a.path, `env:${a.env}`)
  }

  for (const [name, raw] of Object.entries(env)) {
    if (!name.startsWith(ENV_PREFIX) || raw === undefined) continue
    const parts = name.slice(ENV_PREFIX.length).split('__').filter(Boolean)
    const path: string[] = []
    let bad = false
    for (const part of parts) {
      const here = nodeAt(path)
      const keys = isObj(here) ? Object.keys(here) : []
      const key = /^\d+$/.test(part) && Array.isArray(here) ? part : keys.find((k) => k.toLowerCase() === part.toLowerCase())
      if (key === undefined) {
        const near = didYouMean(part, keys)
        ctx.problems.push(`env ${name}: unknown key "${[...path, part].join('.')}"${hint(near, path.length ? `${path.join('.')}.` : '')}`)
        bad = true
        break
      }
      path.push(key)
    }
    if (bad) continue
    const dotted = path.join('.')
    const tmpl = nodeAt(path)
    if (!path.length || isObj(tmpl)) {
      ctx.problems.push(`env ${name}: ${dotted || '(root)'} is a section, name a setting inside it`)
      continue
    }
    if (raw.trim() === '' && typeName(tmpl) !== 'string') continue
    const value = coerce(raw, tmpl, dotted, name, ctx.problems)
    if (value === undefined) continue
    if (typeName(tmpl) === 'array') {
      const probe: string[] = []
      if (!checkLeaf(`env ${name}`, dotted, tmpl, value, probe)) {
        ctx.problems.push(...probe)
        continue
      }
    }
    setPath(ctx.s, path, value)
    markSource(ctx, dotted, `env:${name}`)
  }
}

export function listProfiles(configDir = DEFAULT_CONFIG_DIR): string[] {
  const dir = join(configDir, 'profiles')
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter((f) => f.endsWith('.toml')).map((f) => f.slice(0, -5)).sort()
}

// Layers, lowest to highest: code defaults, config/default.toml, profile, config/local.toml, environment, overrides.
export function loadSettings(opts: LoadOptions = {}): Settings {
  const env = opts.env ?? process.env
  const ctx: Ctx = { s: deepClone(DEFAULTS) as unknown as Obj, src: new Map(), problems: [] }

  // Known variables come from the validated env module; a bad value is reported here with the other problems.
  let known: Record<string, unknown> = {}
  try {
    known = readEnv(env) as Record<string, unknown>
  } catch (e) {
    if (!(e instanceof EnvError)) throw e
    ctx.problems.push(...e.problems)
  }
  const configDir = resolve(opts.configDir ?? (known[ENV_CONFIG_DIR] as string | undefined) ?? process.env[ENV_CONFIG_DIR] ?? DEFAULT_CONFIG_DIR)

  const base = readToml(join(configDir, 'default.toml'), 'file:default.toml')
  if (base) mergeLayer(ctx, base, 'file:default.toml', 'file:default.toml', true)

  const profile = String(opts.profile ?? known[ENV_PROFILE] ?? '').trim()
  if (profile) {
    const name = `profiles/${profile}.toml`
    if (!/^[A-Za-z0-9_-]+$/.test(profile) || !existsSync(join(configDir, name))) {
      ctx.problems.push(`profile "${profile}" does not exist in ${join(configDir, 'profiles')} (available: ${listProfiles(configDir).join(', ') || 'none'})`)
    } else {
      const layer = readToml(join(configDir, name), `file:${name}`)
      if (layer) mergeLayer(ctx, layer, `file:${name}`, `file:${name}`)
    }
  }

  if (opts.local !== false) {
    const local = readToml(join(configDir, 'local.toml'), 'file:local.toml')
    if (local) mergeLayer(ctx, local, 'file:local.toml', 'file:local.toml')
  }

  applyEnv(ctx, env, known)
  if (opts.overrides) mergeLayer(ctx, opts.overrides as Obj, 'overrides', 'override')

  // Bad layer entries were skipped above, so the tree is still well typed and range checks can report everything at once.
  ctx.problems.push(...validateSettings(ctx.s as unknown as Settings))
  if (ctx.problems.length) throw new SettingsError(ctx.problems)

  const settings = ctx.s as unknown as Settings
  sources.set(settings, ctx.src)
  return settings
}

let cached: Settings | null = null

export function getSettings(): Settings {
  return (cached ??= loadSettings())
}

export function resetSettings() {
  cached = null
}

const stripSecrets = (s: Settings): Obj => {
  const copy = deepClone(s) as unknown as Obj
  for (const p of SECRET_PATHS) {
    const segs = p.split('.')
    const parent = getPath(copy, segs.slice(0, -1)) as Obj | undefined
    if (parent) delete parent[segs[segs.length - 1]!]
  }
  return copy
}

export function settingsHash(s: Settings): string {
  return createHash('sha256').update(JSON.stringify(canonical(stripSecrets(s)))).digest('hex')
}

export function redact(s: Settings): Settings {
  const copy = deepClone(s) as unknown as Obj
  for (const p of SECRET_PATHS) {
    const segs = p.split('.')
    const parent = getPath(copy, segs.slice(0, -1)) as Obj | undefined
    const key = segs[segs.length - 1]!
    if (parent && typeof parent[key] === 'string' && parent[key] !== '') parent[key] = '***'
  }
  return copy as unknown as Settings
}

export function explain(s: Settings): Explained[] {
  const src = sources.get(s) ?? new Map<string, string>()
  const safe = redact(s)
  return leaves(safe as unknown as Obj).map(([path, value]) => {
    let source = src.get(path)
    if (!source) {
      const kids = [...new Set([...src.entries()].filter(([k]) => k.startsWith(`${path}.`)).map(([, v]) => v))]
      source = kids.length ? kids.join(',') : 'default'
    }
    return { path, value, source }
  })
}

export { isSecret }
