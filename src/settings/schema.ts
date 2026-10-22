import { DEFAULTS } from './defaults'
import { SECRET_PATHS } from './types'

export type Obj = Record<string, unknown>
export const isObj = (x: unknown): x is Obj => typeof x === 'object' && x !== null && !Array.isArray(x)

// Arrays of tables: the shape of one element (values are only type examples).
export const ARRAY_ITEMS: Record<string, Obj> = {
  'risk.lockTiers': { pnl: 0, riskPct: 0 },
  'ai.feeds': { source: '', url: '' },
}

export const isSecret = (path: string) => (SECRET_PATHS as readonly string[]).includes(path)

export function levenshtein(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]!
    prev[0] = i
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j]!
      prev[j] = Math.min(prev[j]! + 1, prev[j - 1]! + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1))
      diag = tmp
    }
  }
  return prev[b.length]!
}

export function didYouMean(key: string, options: string[]): string {
  let best = ''
  let bestD = Infinity
  for (const o of options) {
    const d = levenshtein(key.toLowerCase(), o.toLowerCase())
    if (d < bestD) {
      bestD = d
      best = o
    }
  }
  return best && bestD <= Math.max(2, Math.floor(key.length / 3)) ? best : ''
}

export const hint = (suggestion: string, prefix = '') => (suggestion ? ` (did you mean "${prefix}${suggestion}"?)` : '')

// Every leaf (non-section value) of a settings tree as dotted path -> value. Arrays are leaves.
export function leaves(o: Obj, prefix = ''): [string, unknown][] {
  const out: [string, unknown][] = []
  for (const [k, v] of Object.entries(o)) {
    const p = prefix ? `${prefix}.${k}` : k
    if (isObj(v)) out.push(...leaves(v, p))
    else out.push([p, v])
  }
  return out
}

// Template node for a dotted path: a section object, an example leaf value, or an array-item shape. undefined if unknown.
export function nodeAt(path: string[]): unknown {
  let node: unknown = DEFAULTS
  let trail = ''
  for (const seg of path) {
    if (Array.isArray(node)) {
      const item = ARRAY_ITEMS[trail]
      if (!item || !/^\d+$/.test(seg)) return undefined
      node = item
      trail = `${trail}.${seg}`
      continue
    }
    if (!isObj(node) || !(seg in node)) return undefined
    node = node[seg]
    trail = trail ? `${trail}.${seg}` : seg
  }
  return node
}

export function typeName(v: unknown): string {
  return Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v
}

// Element type of an array leaf ('string' when the default is empty).
export function elementType(path: string): string {
  const node = nodeAt(path.split('.'))
  if (!Array.isArray(node)) return 'string'
  if (ARRAY_ITEMS[path]) return 'object'
  return node.length ? typeName(node[0]) : 'string'
}

export function deepClone<T>(x: T): T {
  return structuredClone(x)
}

export function getPath(root: unknown, segs: string[]): unknown {
  let n: unknown = root
  for (const s of segs) {
    if (n === null || typeof n !== 'object') return undefined
    n = (n as Record<string, unknown>)[s]
  }
  return n
}

export function setPath(root: Obj, segs: string[], value: unknown) {
  let n: any = root
  for (let i = 0; i < segs.length - 1; i++) {
    const s = segs[i]!
    if (n[s] === undefined || n[s] === null) n[s] = /^\d+$/.test(segs[i + 1]!) ? [] : {}
    n = n[s]
  }
  n[segs[segs.length - 1]!] = value
}

export function canonical(x: unknown): unknown {
  if (Array.isArray(x)) return x.map(canonical)
  if (isObj(x)) return Object.fromEntries(Object.keys(x).sort().map((k) => [k, canonical(x[k])]))
  return x
}
