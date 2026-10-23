// Compatibility layer between the agent runtime (libfx) and OpenAI-compatible providers that deviate from the reference API.
// Two deviations are handled, both verified against the configured provider:
//  1. Reasoning models that refuse tool calls unless `reasoning_effort` is "none". Detected from the provider's 400 reply,
//     then remembered for the rest of the process, so other providers never see the extra field.
//  2. Azure-style content-filter chunks (`"choices": []` with `prompt_filter_results`) at the start of a stream, which the
//     runtime rejects as invalid. They carry no model output and are dropped.

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

const isChat = (url: string, init?: RequestInit) => (init?.method ?? 'GET').toUpperCase() === 'POST' && /\/chat\/completions(\?|$)/.test(url)

export function dropEmptyChoiceEvents(sse: string): string {
  return sse
    .split('\n\n')
    .filter((ev) => {
      const m = ev.match(/^data: (\{[\s\S]*\})\s*$/)
      if (!m) return true
      try {
        const j = JSON.parse(m[1]!) as { choices?: unknown[]; usage?: unknown }
        return !(Array.isArray(j.choices) && j.choices.length === 0 && !j.usage)
      } catch {
        return true
      }
    })
    .join('\n\n')
}

function filterStream(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const dec = new TextDecoder()
  const enc = new TextEncoder()
  let buf = ''
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, ctl) {
        buf += dec.decode(chunk, { stream: true })
        const cut = buf.lastIndexOf('\n\n')
        if (cut < 0) return
        const ready = buf.slice(0, cut + 2)
        buf = buf.slice(cut + 2)
        const out = dropEmptyChoiceEvents(ready)
        if (out) ctl.enqueue(enc.encode(out))
      },
      flush(ctl) {
        buf += dec.decode()
        if (buf) ctl.enqueue(enc.encode(dropEmptyChoiceEvents(buf)))
      },
    }),
  )
}

export function createCompatFetch(base: FetchLike = (u, i) => fetch(u, i), opts: { reasoningEffort?: string } = {}): FetchLike {
  let effort = opts.reasoningEffort?.trim() || ''
  const bodyText = (b: unknown): string | null => {
    if (typeof b === 'string') return b
    if (b instanceof Uint8Array) return new TextDecoder().decode(b)
    if (b instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(b))
    return null
  }
  const withEffort = (init: RequestInit | undefined, value: string): RequestInit | undefined => {
    const text = value ? bodyText(init?.body) : null
    if (text === null) return init
    try {
      const body = JSON.parse(text) as Record<string, unknown>
      return { ...init, body: JSON.stringify({ ...body, reasoning_effort: value }) }
    } catch {
      return init
    }
  }
  const finish = (res: Response) => {
    const type = res.headers.get('content-type') ?? ''
    if (!res.body || !type.includes('text/event-stream')) return res
    return new Response(filterStream(res.body), { status: res.status, statusText: res.statusText, headers: res.headers })
  }
  return async (url, init) => {
    if (!isChat(url, init)) return base(url, init)
    let res = await base(url, withEffort(init, effort))
    if (res.status === 400 && !effort) {
      const text = await res.clone().text().catch(() => '')
      if (/reasoning[_ ]effort/i.test(text)) {
        effort = 'none'
        res = await base(url, withEffort(init, effort))
      }
    }
    return finish(res)
  }
}
