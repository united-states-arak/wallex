import { parseArgs } from 'node:util'
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { getSettings, type Settings } from '../settings'
import { createDemo, type Scenario } from './demo'
import { loadReplay } from './replay'
import { KillSwitchDisabled, limitsFromSettings, Store } from './state'

export interface DashboardOptions {
  port?: number
  host?: string
  root?: string
  demo?: boolean
  scenario?: Scenario
  replay?: string
  speed?: number
  seed?: number
  refreshMs?: number
  settings?: Settings
}

const PUBLIC = resolve(import.meta.dir, 'public')
const REPO_ROOT = resolve(import.meta.dir, '../..')
const ASSETS: Record<string, string> = {
  '/': 'index.html',
  '/index.html': 'index.html',
  '/styles.css': 'styles.css',
  '/app.js': 'app.js',
  '/charts.js': 'charts.js',
  '/fmt.js': 'fmt.js',
  '/favicon.svg': 'favicon.svg',
}
const HEADERS = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
}
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { ...HEADERS, 'content-type': 'application/json; charset=utf-8' } })
const fail = (status: number, error: string) => json({ error }, status)

export function startDashboard(opts: DashboardOptions = {}) {
  const settings = opts.settings ?? getSettings()
  const host = opts.host ?? settings.dashboard.host
  const root = resolve(opts.root ?? (settings.dashboard.root || REPO_ROOT))
  const kill = settings.risk.killFile
  const paths = {
    logDir: resolve(root, settings.logging.dir),
    stateDir: resolve(root, settings.logging.stateDir),
    killFile: kill ? resolve(root, kill) : null,
    killLabel: kill || 'STOP',
    limits: limitsFromSettings(settings),
  }
  const refreshMs = opts.refreshMs ?? 500
  const stoppers: (() => void)[] = []

  let store: Store
  let demo: ReturnType<typeof createDemo> | null = null
  let sourceLabel: 'live' | 'demo' | 'replay' = 'live'

  if (opts.replay) {
    const rp = loadReplay(opts.replay, opts.speed ?? 20, (ev, raw) => store.ingest(ev, raw))
    store = new Store({ ...paths, mode: 'replay', clock: rp.clock, clockSpeed: () => rp.speed })
    stoppers.push(rp.run())
    sourceLabel = 'replay'
  } else if (opts.demo) {
    store = new Store({ ...paths, mode: 'demo' })
    demo = createDemo(store, { seed: opts.seed, scenario: opts.scenario })
    stoppers.push(demo.run())
    sourceLabel = 'demo'
  } else {
    store = new Store({ ...paths, mode: 'live' })
    if (paths.killFile) {
      try {
        mkdirSync(dirname(paths.killFile), { recursive: true })
      } catch {
        // read-only mount: the toggle reports the failure when used
      }
    }
    const h = setInterval(() => store.refresh(0), 1000)
    ;(h as { unref?: () => void }).unref?.()
    stoppers.push(() => clearInterval(h))
    store.refresh(0)
  }

  const hostAllowed = (req: Request) => {
    const h = (req.headers.get('host') ?? '').replace(/:\d+$/, '').toLowerCase()
    return LOOPBACK.has(h) || h === host.toLowerCase() || !LOOPBACK.has(host.toLowerCase())
  }

  const sameOrigin = (req: Request) => {
    const origin = req.headers.get('origin')
    if (origin && origin !== 'null') {
      try {
        if (new URL(origin).host !== req.headers.get('host')) return false
      } catch {
        return false
      }
    } else if (origin === 'null') return false
    const site = req.headers.get('sec-fetch-site')
    return !site || site === 'same-origin' || site === 'none'
  }

  const stream = (req: Request) => {
    const enc = new TextEncoder()
    let timer: ReturnType<typeof setInterval> | undefined
    let lastVersion = -1
    return new Response(
      new ReadableStream({
        start(controller) {
          const send = () => {
            try {
              store.refresh(refreshMs)
              const withSeries = store.seriesVersion !== lastVersion
              const snap = store.snapshot({ series: withSeries })
              lastVersion = store.seriesVersion
              controller.enqueue(enc.encode(`event: snapshot\nid: ${snap.seq}\ndata: ${JSON.stringify(snap)}\n\n`))
            } catch {
              clearInterval(timer)
            }
          }
          controller.enqueue(enc.encode('retry: 2000\n\n'))
          send()
          timer = setInterval(send, 1000)
          req.signal.addEventListener('abort', () => clearInterval(timer))
        },
        cancel() {
          clearInterval(timer)
        },
      }),
      { headers: { ...HEADERS, 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive', 'x-accel-buffering': 'no' } },
    )
  }

  const server = Bun.serve({
    port: opts.port ?? settings.dashboard.port,
    hostname: host,
    idleTimeout: 30,
    async fetch(req) {
      const url = new URL(req.url)
      if (!hostAllowed(req)) return fail(403, 'host not allowed')
      const { pathname } = url

      if (req.method === 'GET' || req.method === 'HEAD') {
        const asset = ASSETS[pathname]
        if (asset) {
          const file = Bun.file(resolve(PUBLIC, asset))
          if (!(await file.exists())) return fail(404, 'missing asset')
          return new Response(file, { headers: { ...HEADERS, 'content-type': file.type } })
        }
        if (pathname === '/api/state') {
          store.refresh(refreshMs)
          return json(store.snapshot())
        }
        if (pathname === '/api/stream') return stream(req)
        if (pathname === '/api/log') {
          store.refresh(refreshMs)
          const limit = Number(url.searchParams.get('limit') ?? 200)
          return json(store.queryLog({ event: url.searchParams.get('event') ?? '', q: url.searchParams.get('q') ?? '', limit: Number.isFinite(limit) ? limit : 200 }))
        }
        return fail(404, 'not found')
      }

      if (req.method === 'POST' && pathname === '/api/stop') {
        if (!sameOrigin(req)) return fail(403, 'cross-origin request refused')
        if (req.headers.get('x-confirm') !== 'stop') return fail(400, 'missing x-confirm: stop header')
        let body: unknown
        try {
          body = await req.json()
        } catch {
          return fail(400, 'body must be JSON')
        }
        const enabled = (body as { enabled?: unknown } | null)?.enabled
        if (typeof enabled !== 'boolean') return fail(400, 'enabled must be a boolean')
        try {
          const r = store.setKillSwitch(enabled)
          return json({ ok: true, ...r })
        } catch (e) {
          if (e instanceof KillSwitchDisabled) return fail(409, 'kill switch is disabled: risk.killFile is empty')
          return fail(500, 'could not change the kill switch file')
        }
      }

      if (req.method === 'POST' && pathname === '/api/demo') {
        if (!demo) return fail(404, 'not in demo mode')
        if (!sameOrigin(req)) return fail(403, 'cross-origin request refused')
        const body = (await req.json().catch(() => null)) as { scenario?: unknown } | null
        if (body?.scenario !== 'halt' && body?.scenario !== 'normal') return fail(400, 'scenario must be halt or normal')
        demo.setScenario(body.scenario)
        return json({ ok: true, scenario: body.scenario })
      }
      return fail(405, 'method not allowed')
    },
  })

  const hostName = host.includes(':') ? `[${host}]` : host
  return {
    server,
    store,
    demo,
    source: sourceLabel,
    url: `http://${hostName}:${server.port}`,
    close() {
      for (const s of stoppers) s()
      server.stop(true)
    },
  }
}

if (import.meta.main) {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      port: { type: 'string' },
      host: { type: 'string' },
      demo: { type: 'boolean', default: false },
      replay: { type: 'string' },
      speed: { type: 'string', default: '20' },
      scenario: { type: 'string' },
    },
    strict: false,
  })
  const port = typeof values.port === 'string' ? Number(values.port) : undefined
  const speed = Number(values.speed)
  if (port !== undefined && (!Number.isInteger(port) || port < 0 || port > 65535)) {
    console.error(`invalid --port: ${String(values.port)}`)
    process.exit(2)
  }
  const host = typeof values.host === 'string' ? values.host : getSettings().dashboard.host
  const d = startDashboard({
    port,
    host,
    demo: values.demo === true,
    replay: typeof values.replay === 'string' ? values.replay : undefined,
    speed,
    scenario: values.scenario === 'halt' ? 'halt' : 'normal',
  })
  console.log(`starcoach dashboard (${d.source}) on ${d.url}`)
  if (!['127.0.0.1', 'localhost', '::1'].includes(host)) console.error(`WARNING: bound to ${host}. The dashboard has no authentication and can toggle the STOP file. Keep it on localhost.`)
}
