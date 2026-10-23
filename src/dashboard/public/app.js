import { countTo, createEquityChart, createGauge, ladder, sparkline } from './charts.js'
import { esc, fmtAge, fmtClock, fmtDateTime, fmtDuration, fmtInt, fmtPct, fmtPrice, fmtQty, fmtR, fmtSignedTmn, fmtTmn, glyph, isNum, tone } from './fmt.js'

const $ = (id) => document.getElementById(id)
const VIEWS = ['overview', 'positions', 'setups', 'ai', 'trades', 'system', 'log']
const ERR_EVENTS = 'poll.error,daemon.api_error,exit.rejected,daemon.degraded,daemon.strategy_error,daemon.loop_error,daemon.poll_crashed,order.error,order.cancel_error,entry.rejected,tp.rejected,exit.no_quote,supervisor.error,exchange.place_failed,dry.rejected'
const FAMILIES = [
  ['All', ''],
  ['Daemon', 'daemon,poll'],
  ['Setups', 'setup'],
  ['Entries', 'entry,tp,stop'],
  ['Orders', 'order,exchange,pullout,dry'],
  ['AI', 'ai,supervisor'],
  ['Exits', 'exit'],
  ['Errors', ERR_EVENTS],
]

let snap = null
let recvAt = 0
let series = []
let view = 'overview'
let conn = 'connecting'
let lastMsg = 0
let es = null
let pollTimer = null
let pollFails = 0
const cache = new Map()
const seen = new Map()

const setHTML = (el, html, key = el.id) => {
  if (cache.get(key) === html) return false
  cache.set(key, html)
  el.innerHTML = html
  return true
}
const setText = (el, text) => {
  if (el.textContent !== text) el.textContent = text
}
const serverNow = () => (snap ? snap.now + (Date.now() - recvAt) * (snap.clockSpeed || 1) : Date.now())
const chip = (t, g, text) => `<span class="chip" data-tone="${t}"><span aria-hidden="true">${g}</span> ${esc(text)}</span>`
const symHtml = (s) => `<b>${esc(String(s).replace(/TMN$/, ''))}</b><small class="muted">/TMN</small>`
const toneChip = (n) => `<span class="${tone(n)}"><span aria-hidden="true">${glyph(n)}</span> `
const empty = (title, body, icon = 'i-overview') => `<div class="empty"><svg aria-hidden="true" viewBox="0 0 24 24"><use href="#${icon}"/></svg><b>${esc(title)}</b><span>${body}</span></div>`

function flashNew(container, key, selector, ids) {
  const prev = seen.get(key)
  const now = new Set(ids)
  seen.set(key, now)
  if (!prev) return
  container.querySelectorAll(selector).forEach((el) => {
    if (!prev.has(el.dataset.k)) el.classList.add('enter')
  })
}

/* ---------- connection ---------- */
function setConn(next) {
  if (conn === next) return
  conn = next
  const pill = $('conn-pill')
  pill.dataset.state = next
  setText($('conn-text'), { live: 'Live', polling: 'Polling', lost: 'Offline', connecting: 'Connecting' }[next])
  $('conn-banner').hidden = next !== 'lost'
  document.body.classList.toggle('is-lost', next === 'lost')
  measureBanners()
}
function measureBanners() {
  requestAnimationFrame(() => document.documentElement.style.setProperty('--banner-h', `${$('banners').offsetHeight}px`))
}
function apply(next) {
  if (next.equity && !next.equity.series) next.equity.series = series
  else if (next.equity) series = next.equity.series
  snap = next
  recvAt = Date.now()
  lastMsg = recvAt
  renderAll()
}
function startPolling() {
  if (pollTimer) return
  const tick = async () => {
    try {
      const r = await fetch('/api/state', { cache: 'no-store' })
      if (!r.ok) throw new Error(String(r.status))
      pollFails = 0
      if (!es) setConn('polling')
      apply(await r.json())
    } catch {
      pollFails++
      if (pollFails >= 2) {
        setConn('lost')
        setText($('conn-note'), snap ? `Showing data from ${fmtAge((Date.now() - recvAt) / 1000)} ago. Retrying…` : 'Could not reach the dashboard server. Retrying…')
      }
    }
  }
  tick()
  pollTimer = setInterval(tick, 2000)
}
function stopPolling() {
  clearInterval(pollTimer)
  pollTimer = null
}
function startSSE() {
  if (typeof EventSource === 'undefined') return startPolling()
  es = new EventSource('/api/stream')
  es.addEventListener('snapshot', (e) => {
    try {
      pollFails = 0
      stopPolling()
      setConn('live')
      apply(JSON.parse(e.data))
    } catch {
      /* ignore a malformed frame */
    }
  })
  es.onerror = () => {
    es?.close()
    es = null
    startPolling()
    setTimeout(startSSE, 8000)
  }
}

/* ---------- routing ---------- */
function route() {
  const id = location.hash.slice(1)
  view = VIEWS.includes(id) ? id : 'overview'
  for (const v of VIEWS) $(v).hidden = v !== view
  document.querySelectorAll('[data-nav]').forEach((a) => (a.dataset.nav === view ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current')))
  window.scrollTo({ top: 0 })
  if (snap) renderAll()
  if (view === 'log') fetchLog()
}
window.addEventListener('hashchange', route)

/* ---------- header ---------- */
const PHASES = {
  waiting: ['idle', '…', 'Waiting for daemon'],
  trading: ['good', '▶', 'Trading'],
  cutoff: ['warn', '◐', 'Entries off'],
  flattening: ['bad', '■', 'Flattening'],
  done: ['info', '✓', 'Run complete'],
}
function renderHeader() {
  const s = snap
  const badge = $('mode-badge')
  const mode = s.run.mode
  if (s.source === 'demo') { setText(badge, 'DEMO'); badge.dataset.mode = 'demo' }
  else if (s.source === 'replay') { setText(badge, `REPLAY ×${s.clockSpeed}`); badge.dataset.mode = 'replay' }
  else { setText(badge, mode ? mode.toUpperCase() : 'NO RUN'); badge.dataset.mode = mode ?? 'none' }
  const [t, g, label] = PHASES[s.run.phase] ?? PHASES.waiting
  const pc = $('phase-chip')
  pc.dataset.tone = t
  pc.firstElementChild.textContent = g
  setText($('phase-text'), label)
  $('kill-banner').hidden = !s.killSwitch
  setText($('kill-toggle-text'), s.killSwitch ? 'Release kill switch' : 'Kill switch')
  setText($('kill-note'), s.killSwitchVirtual ? 'Simulated in this demo or replay. No file was written.' : s.killSwitchConfigured === false ? 'The kill switch is disabled because risk.killFile is empty.' : `The ${s.killFile || 'STOP'} file exists, so the guard refuses new entries and pending entries are cancelled. Open positions stay managed.`)
  setText($('src-note'), s.source === 'demo' ? 'Synthetic data · Shift+H toggles the halt scenario' : s.source === 'replay' ? 'Replaying a log file' : s.system.logFile ? `Tailing ${s.system.logFile}` : 'No log file yet')
  document.title = isNum(s.equity.pnlPct) ? `${s.equity.pnlPct >= 0 ? '▲' : '▼'} ${fmtPct(s.equity.pnlPct, 2, true)} · Starcoach` : 'Starcoach · Mission control'
  const np = $('nav-positions')
  np.hidden = s.positions.length === 0
  setText(np, String(s.positions.length))
  const ne = $('nav-errors')
  ne.hidden = !(s.system.errors.total > 0)
  setText(ne, String(s.system.errors.total))
  ne.setAttribute('aria-label', `${s.system.errors.total} errors`)
  measureBanners()
}
function renderHealth() {
  if (!snap) return
  const hb = snap.health
  const age = snap.health.heartbeatAgeSec === null ? null : (serverNow() - (snap.now - snap.health.heartbeatAgeSec * 1000)) / 1000
  const stale = snap.run.phase !== 'done' && snap.run.phase !== 'waiting' && isNum(age) && age > 120
  let level = hb.level
  const reasons = [...hb.reasons]
  if (stale && level !== 'bad') { level = 'bad'; reasons.unshift(`Heartbeat is ${Math.round(age)}s old`) }
  const el = $('health')
  el.dataset.level = level
  const label = { ok: 'Healthy', warn: 'Attention', bad: 'Trouble', idle: 'No data', done: 'Finished' }[level]
  const hbText = isNum(age) && level !== 'idle' && level !== 'done' ? ` · heartbeat ${fmtAge(age)} ago` : ''
  setText($('health-text'), label + hbText)
  el.title = reasons.join('. ')
  el.setAttribute('aria-label', `Health: ${label}. ${reasons.join('. ')}`)
}

/* ---------- overview ---------- */
const eqChart = createEquityChart($('eq-chart'))
const gDay = createGauge($('g-day'), { title: 'Day loss', hint: 'Loss from the day peak. Entries halt at the limit.' })
const gDd = createGauge($('g-dd'), { title: 'Drawdown', hint: 'Loss from start equity. The hard kill triggers at the limit.' })
const gRisk = createGauge($('g-risk'), { title: 'Risk tier', hint: 'Risk per trade falls as profit locks in.' })

function gaugeTone(frac, halted) {
  if (halted) return ['halt', 'Halted', '■']
  if (frac < 0.5) return ['ok', 'Within limits', '✓']
  if (frac < 0.8) return ['watch', 'Watch', '◐']
  return ['danger', 'Near limit', '▲']
}

function renderTimeline() {
  const r = snap.run
  const now = serverNow()
  const start = r.startedAt ?? (isNum(r.runEnd) ? Math.min(now, r.runEnd - 3600e3) : now)
  const end = r.runEnd
  const track = $('tl-track')
  if (!isNum(end) || end <= start) {
    setText($('tl-time'), '–')
    setText($('tl-phase'), 'Run schedule unknown. It appears with the first daemon start.')
    ;['tl-trade', 'tl-cutoff', 'tl-flat'].forEach((id) => ($(id).style.width = '0'))
    setHTML($('tl-marks'), '')
    return
  }
  const pct = (t) => Math.max(0, Math.min(100, ((t - start) / (end - start)) * 100))
  const cut = isNum(r.entryCutoffAt) ? pct(r.entryCutoffAt) : 100
  const fl = isNum(r.flattenAt) ? pct(r.flattenAt) : 100
  $('tl-trade').style.width = `${cut}%`
  Object.assign($('tl-cutoff').style, { left: `${cut}%`, width: `${Math.max(0, fl - cut)}%` })
  Object.assign($('tl-flat').style, { left: `${fl}%`, width: `${Math.max(0, 100 - fl)}%` })
  const p = r.phase === 'done' ? 100 : pct(now)
  $('tl-fill').style.width = `${p}%`
  $('tl-now').style.left = `${p}%`
  const remain = (end - now) / 1000
  const done = r.phase === 'done'
  setText($('tl-label'), done ? 'Run finished' : 'Time to run end')
  setText($('tl-time'), done ? (r.stopped ? fmtClock(r.stopped.ts, false) : '00:00') : fmtDuration(remain))
  let note = ''
  if (r.phase === 'trading') note = isNum(r.entryCutoffAt) ? `Trading. New entries stop in ${fmtDuration((r.entryCutoffAt - now) / 1000)}` : 'Trading'
  else if (r.phase === 'cutoff') note = isNum(r.flattenAt) ? `Entries off. Flattening in ${fmtDuration(Math.max(0, (r.flattenAt - now) / 1000))}` : 'Entries off'
  else if (r.phase === 'flattening') note = 'Selling holdings back to TMN'
  else if (done) note = r.stopped ? `Stopped (${r.stopped.reason}), ${r.stopped.flat === false ? 'positions left open' : 'flat'}` : 'Run end reached'
  else note = 'Waiting for daemon'
  setText($('tl-phase'), note)
  track.setAttribute('aria-label', `Run progress ${Math.round(p)} percent. ${note}`)
  const marks = [[start, 'Start', '']]
  if (isNum(r.entryCutoffAt)) marks.push([r.entryCutoffAt, 'Entries stop', ''])
  if (isNum(r.flattenAt)) marks.push([r.flattenAt, 'Flatten', ''])
  marks.push([end, 'Run end', 'end'])
  let lastX = -100, lastLow = false, anyLow = false
  const spans = marks.map(([t, label, cls]) => {
    const x = pct(t)
    const low = x - lastX < 12 && !lastLow
    lastLow = low
    lastX = x
    anyLow ||= low
    return `<span class="${cls}${low ? ' low' : ''}" style="left:${x}%"><b>${fmtClock(t, false)}</b>${label}</span>`
  })
  $('tl-marks').classList.toggle('two', anyLow)
  setHTML($('tl-marks'), spans.join(''))
}

function renderOverview() {
  const s = snap
  const e = s.equity
  countTo($('eq-val'), e.last, fmtInt)
  const pc = tone(e.pnlTmn, 0.5)
  setHTML($('eq-delta'), isNum(e.pnlTmn) ? `<span class="${pc}">${glyph(e.pnlTmn, 0.5)} ${fmtSignedTmn(e.pnlTmn)}</span><span class="${pc}">${fmtPct(e.pnlPct, 2, true)} since start</span>` : '<span class="muted">Waiting for the first heartbeat</span>')
  setHTML($('eq-day'), isNum(e.dayPnlPct) ? `<span class="${tone(e.dayPnlPct, 1e-5)}">${glyph(e.dayPnlPct, 1e-5)} ${fmtPct(e.dayPnlPct, 2, true)}</span>` : '–')
  setHTML($('eq-dd'), isNum(e.drawdownFromPeak) ? `<span class="${e.drawdownFromPeak > 0.0005 ? 'down' : 'flat'}">${e.drawdownFromPeak > 0.0005 ? '▼ ' + fmtPct(-e.drawdownFromPeak, 2) : '0.00%'}</span>`: '–')
  setText($('eq-peak'), fmtTmn(e.peak))
  setText($('eq-start'), fmtTmn(e.start))
  setText($('eq-meta'), e.series.length ? `${e.series.length} heartbeats` : '')
  const markers = s.trades.rows.filter((t) => isNum(t.ts)).map((t) => ({ t: t.ts, win: (t.pnlTmn ?? t.pnlFraction ?? 0) > 0 }))
  const key = `${e.seriesVersion}|${e.series.length}|${markers.length}|${e.start}`
  if (eqChart.key !== key) {
    eqChart.key = key
    eqChart.update({ series: e.series, start: e.start, markers })
  }

  const gd = s.gauges.dayLoss
  const gk = s.gauges.drawdown
  const gr = s.gauges.risk
  const halted = s.guard?.halted
  const hardHalt = halted && /hard/i.test(s.guard?.haltReason ?? s.guard?.blockReason ?? '')
  const dayFrac = isNum(gd.value) ? gd.value / gd.limit : null
  if (dayFrac === null) gDay.update({ fraction: 0, center: '–', subtext: 'no equity yet', toneName: 'idle', statusText: 'No data', statusGlyph: '…' })
  else {
    const [tn, st, gl] = gaugeTone(dayFrac, halted && !hardHalt)
    gDay.update({ fraction: dayFrac, center: fmtPct(gd.value, 1), subtext: `halt at ${fmtPct(gd.limit, 0)}`, toneName: tn, statusText: st, statusGlyph: gl, tickAt: [1], aria: `Day loss ${fmtPct(gd.value, 1)} of ${fmtPct(gd.limit, 0)} halt limit. ${st}` })
  }
  const ddFrac = isNum(gk.value) ? gk.value / gk.limit : null
  if (ddFrac === null) gDd.update({ fraction: 0, center: '–', subtext: 'no equity yet', toneName: 'idle', statusText: 'No data', statusGlyph: '…' })
  else {
    const [tn, st, gl] = gaugeTone(ddFrac, hardHalt)
    gDd.update({ fraction: ddFrac, center: fmtPct(gk.value, 1), subtext: `kill at ${fmtPct(gk.limit, 0)}`, toneName: tn, statusText: st, statusGlyph: gl, tickAt: [1], aria: `Drawdown ${fmtPct(gk.value, 1)} of ${fmtPct(gk.limit, 0)} kill limit. ${st}` })
  }
  const tierLabel = ['Full risk', 'Profit lock 1', 'Profit lock 2'][gr.tier]
  gRisk.update({ fraction: gr.value / gr.lock2, center: fmtPct(gr.riskPct, 2), subtext: 'risk per trade', toneName: gr.tier ? 'lock' : 'ok', statusText: tierLabel, statusGlyph: gr.tier ? '◆'.repeat(gr.tier) : '✓', tickAt: [gr.lock1 / gr.lock2, 1], aria: `Risk per trade ${fmtPct(gr.riskPct, 2)}. ${tierLabel}. Profit ${fmtPct(gr.value, 1)}, locks at ${fmtPct(gr.lock1, 0)} and ${fmtPct(gr.lock2, 0)}.` })

  const g = s.guard
  setText($('guard-meta'), g ? `${g.consecutiveLosses} of 3 losses in a row` : '')
  if (!g) setHTML($('guard-line'), '<span class="muted">The guard state appears after the first heartbeat.</span>')
  else {
    const blocked = g.blockReason
    const parts = []
    parts.push(blocked ? chip('bad', '■', `Entries blocked: ${blocked}`) : chip('good', '✓', 'Entries allowed'))
    if (g.consecutiveLosses > 0) parts.push(chip(g.consecutiveLosses >= 2 ? 'warn' : 'idle', '↘', `${g.consecutiveLosses} loss${g.consecutiveLosses > 1 ? 'es' : ''} in a row`))
    if (g.halted) parts.push(chip('bad', '■', g.haltReason ?? 'Halted'))
    setHTML($('guard-line'), parts.join(''))
  }
  renderStats()
  renderActivity()
}

function renderStats() {
  const s = snap
  const t = s.trades
  const exposure = s.positions.reduce((a, p) => a + p.notional, 0)
  const setupsN = s.setups.accepted + s.setups.rejected
  const age = s.health.heartbeatAgeSec === null ? null : (serverNow() - (s.now - s.health.heartbeatAgeSec * 1000)) / 1000
  const card = (k, v, sub, extra = '') => `<article class="card stat"><span class="k">${k}</span><span class="v">${v}</span><span class="s">${sub}</span>${extra}</article>`
  const bar = (f) => `<span class="bar"><i style="width:${Math.max(0, Math.min(1, f)) * 100}%"></i></span>`
  setHTML(
    $('stat-row'),
    card('Open positions', fmtInt(s.positions.length), `${s.pending.length} pending · exposure ${isNum(s.equity.last) && s.equity.last > 0 ? fmtPct(exposure / s.equity.last, 0) : '–'}`, bar(s.positions.length / 2)) +
      card('Closed trades', fmtInt(t.count), t.count ? `Win rate ${fmtPct(t.winRate, 0)} · avg ${fmtR(t.avgR)}` : 'No trades closed yet', bar(t.winRate ?? 0)) +
      card('Setups accepted', setupsN ? `${s.setups.accepted} <small class="muted">/ ${setupsN}</small>` : '–', setupsN ? `${fmtPct(s.setups.accepted / setupsN, 0)} pass every check` : 'No setups seen yet', bar(setupsN ? s.setups.accepted / setupsN : 0)) +
      card('AI fallback rate', isNum(s.ai.fallbackRate) ? fmtPct(s.ai.fallbackRate, 0) : '–', isNum(s.ai.avgLatencyMs) ? `avg latency ${(s.ai.avgLatencyMs / 1000).toFixed(1)}s` : 'No verdicts yet', sparkline(s.ai.latencies)) +
      card('Heartbeat', isNum(age) ? fmtAge(age) : '–', isNum(age) && age > 120 && s.run.phase !== 'done' ? 'Stale: over 120s' : 'Warns after 120s', bar(isNum(age) ? age / 120 : 0)),
    'stat-row',
  )
}

const ACT_GLYPH = { good: '✓', bad: '✕', warn: '!', info: '•' }
function renderActivity() {
  const rows = snap.activity.slice(0, 8)
  const el = $('activity')
  const html = rows.length
    ? rows.map((a) => `<li data-k="${a.seq}"><time>${fmtClock(a.ts)}</time><span class="tg ${a.tone === 'good' ? 'up' : a.tone === 'bad' ? 'down' : a.tone === 'warn' ? 'warn-t' : 'flat'}" aria-hidden="true">${ACT_GLYPH[a.tone]}</span><span>${esc(a.text)}</span></li>`).join('')
    : `<li style="display:block;border:0">${empty('No events yet', 'Start the daemon with <code>bun run live</code>, or run this dashboard with <code>--demo</code>.', 'i-log')}</li>`
  if (setHTML(el, html, 'activity')) flashNew(el, 'activity', 'li', rows.map((a) => String(a.seq)))
}

/* ---------- positions ---------- */
function renderPositions() {
  const s = snap
  setText($('pos-sub'), `${s.positions.length} open · ${s.pending.length} pending`)
  const eq = s.equity.last
  const html = s.positions.length
    ? s.positions
        .map((p) => {
          const u = p.unrealizedPct
          const chips = [p.tp1Done ? chip('good', '✓', 'TP1 filled, stop at break-even') : '', p.stopping ? chip('bad', '■', 'Stop hit, closing') : ''].join(' ')
          return `<article class="card pos"><div class="pos-h"><h3>${symHtml(p.symbol)}</h3><span class="pnl ${tone(u, 1e-5)}">${isNum(u) ? `${glyph(u, 1e-5)} ${fmtPct(u, 2, true)}` : '<span class="muted" title="The heartbeat carries no mark price">mark n/a</span>'}</span></div>
          <div>${chips}</div>${ladder(p)}
          <dl><div><dt>Quantity</dt><dd>${fmtQty(p.qty)}</dd></div><div><dt>Notional</dt><dd>${fmtTmn(p.notional)}</dd></div><div><dt>Of equity</dt><dd>${isNum(eq) && eq > 0 ? fmtPct(p.notional / eq, 1) : '–'}</dd></div>
          <div><dt>Entry</dt><dd>${fmtPrice(p.entry)}</dd></div><div><dt>Stop</dt><dd>${fmtPrice(p.stop)}</dd></div><div><dt>TP1</dt><dd>${fmtPrice(p.tp1)}</dd></div>
          <div><dt>${isNum(p.riskToStopPct) && p.riskToStopPct < 0 ? 'Profit locked' : 'Risk to stop'}</dt><dd>${fmtPct(isNum(p.riskToStopPct) ? Math.abs(p.riskToStopPct) : null, 2)}</dd></div><div><dt>Distance to stop now</dt><dd>${isNum(p.distToStopPct) ? fmtPct(p.distToStopPct, 2) : '–'}</dd></div><div><dt>Opened</dt><dd>${isNum(p.openedAt) ? fmtClock(p.openedAt, false) : '–'}</dd></div></dl></article>`
        })
        .join('')
    : `<div style="grid-column:1/-1">${empty('No open positions', 'The daemon is flat. A position appears here once a limit entry fills.', 'i-positions')}</div>`
  setHTML($('pos-cards'), html)

  const now = serverNow()
  const pend = s.pending
  setHTML(
    $('pending'),
    pend.length
      ? `<div class="table-wrap"><table><thead><tr><th>Symbol</th><th class="r">Entry</th><th class="r">Stop</th><th class="r">TP1</th><th class="r">Qty</th><th class="r">Notional</th><th>Placed</th><th>Expires</th></tr></thead><tbody>${pend
          .map((p) => `<tr><td>${symHtml(p.symbol)}</td><td class="r">${fmtPrice(p.entry)}</td><td class="r">${fmtPrice(p.stop)}</td><td class="r">${fmtPrice(p.tp1)}</td><td class="r">${fmtQty(p.qty)}</td><td class="r">${fmtTmn(p.notional)}</td><td>${fmtAge((now - p.placedAt) / 1000)} ago</td><td>${isNum(p.expiresAt) ? (p.expiresAt > now ? 'in ' + fmtAge((p.expiresAt - now) / 1000) : 'expired') : '–'}</td></tr>`)
          .join('')}</tbody></table></div>`
      : empty('No pending entries', 'Limit buys that are waiting to fill show up here.', 'i-setups'),
    'pending',
  )
  const o = s.orders
  const st = (x) => (x.status === 'REJECTED' ? chip('bad', '✕', 'Rejected') : x.status === 'FILLED' ? chip('good', '✓', 'Filled') : x.status === 'NEW' ? chip('info', '•', 'Open') : chip('idle', '…', x.status === 'sent' ? 'Sent' : x.status))
  setHTML(
    $('orders'),
    o.length
      ? `<div class="table-wrap scroll"><table><thead><tr><th>Time</th><th>Symbol</th><th>Side</th><th class="r">Price</th><th class="r">Qty</th><th>Status</th><th>Reason</th></tr></thead><tbody>${o
          .slice(0, 40)
          .map((x) => `<tr><td class="mono">${fmtClock(x.ts)}</td><td>${symHtml(x.symbol)}</td><td>${esc(x.side || '–')} <span class="muted">${esc(x.type)}</span></td><td class="r">${fmtPrice(x.price)}</td><td class="r">${fmtQty(x.qty)}</td><td>${st(x)}</td><td class="wrap reason">${esc(x.error ? x.error : x.reason)}</td></tr>`)
          .join('')}</tbody></table></div>`
      : empty('No orders yet', 'Order intents and acknowledgements appear here as the strategy trades.', 'i-trades'),
    'orders',
  )
}

/* ---------- setups ---------- */
function renderSetups() {
  const s = snap.setups
  const n = s.accepted + s.rejected
  setText($('setups-sub'), n ? `${n} setups evaluated, ${fmtPct(s.accepted / n, 0)} accepted` : '')
  setText($('reason-meta'), s.rejected ? `${s.rejected} rejected` : '')
  const top = s.reasons.slice(0, 12)
  const max = top[0]?.count ?? 1
  setHTML(
    $('reasons'),
    top.length
      ? `<div class="hist">${top.map((r) => `<div class="hist-row"><span>${esc(r.reason)}</span><span class="track"><i style="width:${(r.count / max) * 100}%"></i></span><b>${r.count} <small class="muted">${fmtPct(r.count / s.rejected, 0)}</small></b></div>`).join('')}</div>`
      : empty('No rejections', 'When the strategy skips a setup, the reason is counted here.', 'i-setups'),
    'reasons',
  )
  setHTML(
    $('setup-split'),
    n
      ? `<div class="split" role="img" aria-label="${s.accepted} accepted, ${s.rejected} rejected"><i class="a" style="flex:${s.accepted || 0.0001}"></i><i class="r" style="flex:${s.rejected || 0.0001}"></i></div><div class="split-legend"><div><b class="up">${s.accepted}</b><span><span aria-hidden="true">✓</span> Accepted</span></div><div><b class="warn-t">${s.rejected}</b><span><span aria-hidden="true">✕</span> Rejected</span></div><div><b>${fmtPct(s.accepted / n, 0)}</b><span>Accept rate</span></div></div>`
      : empty('No setups yet', 'Setups are counted as soon as the strategy finds one.', 'i-setups'),
    'split',
  )
  const rows = s.rows
  const el = $('setup-feed')
  const html = rows.length
    ? `<div class="table-wrap scroll"><table><thead><tr><th>Time</th><th>Symbol</th><th>Decision</th><th>Reason</th><th class="r">Entry</th><th class="r">Stop</th><th class="r">TP1</th><th class="r">Net RR</th></tr></thead><tbody>${rows
        .map((r) => `<tr class="row" data-k="${r.seq}"><td class="mono">${fmtClock(r.ts)}</td><td>${symHtml(r.symbol)}</td><td>${r.status === 'accepted' ? chip('good', '✓', 'Accepted') : chip('warn', '✕', 'Rejected')}</td><td class="wrap reason">${esc(r.reason)}</td><td class="r">${fmtPrice(r.entry)}</td><td class="r">${fmtPrice(r.stop)}</td><td class="r">${fmtPrice(r.tp1)}</td><td class="r">${isNum(r.netRr) ? r.netRr.toFixed(2) : '–'}</td></tr>`)
        .join('')}</tbody></table></div>`
    : empty('No decisions yet', 'Accepted and rejected setups stream in here.', 'i-setups')
  if (setHTML(el, html, 'setup-feed')) flashNew(el, 'setup-feed', 'tr.row', rows.map((r) => String(r.seq)))
}

/* ---------- AI ---------- */
function renderAi() {
  const a = snap.ai
  setText($('ai-sub'), a.n ? `${a.n} verdicts reviewed` : '')
  const acts = Object.entries(a.actions).map(([k, v]) => `${k} ${v}`).join(' · ') || 'none yet'
  const card = (k, v, sub, extra = '') => `<article class="card stat"><span class="k">${k}</span><span class="v">${v}</span><span class="s">${sub}</span>${extra}</article>`
  const fb = a.fallbackRate
  setHTML(
    $('ai-stats'),
    card('Verdicts', fmtInt(a.n), esc(acts)) +
      card('Fallback rate', isNum(fb) ? fmtPct(fb, 0) : '–', isNum(fb) ? (fb > 0.25 ? '▲ High: the supervisor is often unavailable' : 'Rule-based approvals when the AI fails') : 'No verdicts yet', `<span class="bar"><i style="width:${(fb ?? 0) * 100}%;${fb > 0.25 ? 'background:var(--warn)' : ''}"></i></span>`) +
      card('Average latency', isNum(a.avgLatencyMs) ? `${(a.avgLatencyMs / 1000).toFixed(1)}s` : '–', 'AI-sourced verdicts only', sparkline(a.latencies)) +
      card('Slowest 5%', isNum(a.p95LatencyMs) ? `${(a.p95LatencyMs / 1000).toFixed(1)}s` : '–', 'p95 latency'),
    'ai-stats',
  )
  const el = $('ai-feed')
  const html = a.rows.length
    ? `<ol class="verdicts">${a.rows
        .map((r) => {
          const act = r.action === 'approve' ? chip('good', '✓', 'Approve') : r.action === 'veto' ? chip('bad', '✕', 'Veto') : r.action === 'resize' ? chip('warn', '◐', `Resize ×${isNum(r.sizeMult) ? r.sizeMult : '?'}`) : chip('idle', '?', r.action)
          return `<li class="verdict" data-k="${r.seq}"><div class="vh"><time class="mono">${fmtClock(r.ts)}</time>${symHtml(r.symbol)}${act}${r.source === 'fallback' ? chip('warn', '↯', 'Fallback') : chip('info', '✦', 'AI')}<span>${isNum(r.latencyMs) ? (r.latencyMs / 1000).toFixed(1) + 's' : ''}</span><span>${esc(r.model)}</span>${r.toolCalls.length ? `<span>tools: ${esc(r.toolCalls.join(', '))}</span>` : ''}</div><p>${esc(r.reason || 'No reason given')}</p></li>`
        })
        .join('')}</ol>`
    : empty('No verdicts yet', 'The supervisor reviews each setup before an order is placed.', 'i-ai')
  if (setHTML(el, html, 'ai-feed')) flashNew(el, 'ai-feed', 'li.verdict', a.rows.map((r) => String(r.seq)))
}

/* ---------- trades ---------- */
function renderTrades() {
  const t = snap.trades
  setText($('trades-sub'), t.count ? `${t.count} closed, ${t.wins} winners` : '')
  const card = (k, v, sub, cls = '') => `<article class="card stat"><span class="k">${k}</span><span class="v ${cls}">${v}</span><span class="s">${sub}</span></article>`
  setHTML(
    $('trade-stats'),
    card('Win rate', isNum(t.winRate) ? fmtPct(t.winRate, 0) : '–', t.count ? `${t.wins} of ${t.count}` : 'No trades yet') +
      card('Average R', isNum(t.avgR) ? fmtR(t.avgR) : '–', 'PnL over initial risk', tone(t.avgR)) +
      card('Total PnL', isNum(t.totalPnlTmn) ? `${glyph(t.totalPnlTmn, 0.5)} ${fmtSignedTmn(t.totalPnlTmn)}` : '–', t.count ? `best ${fmtSignedTmn(t.bestTmn)} · worst ${fmtSignedTmn(t.worstTmn)}` : '', tone(t.totalPnlTmn, 0.5)) +
      card('Fees paid', isNum(t.fees) ? `${t.feesEst ? '≈ ' : ''}${fmtTmn(t.fees)}` : 'not logged', isNum(t.fees) ? (t.feesEst ? 'summed from exit events, partly estimated' : 'summed from exit events') : 'Older logs carry net PnL only'),
    'trade-stats',
  )
  setHTML(
    $('trade-table'),
    t.rows.length
      ? `<div class="table-wrap scroll"><table><thead><tr><th>Closed</th><th>Symbol</th><th>How</th><th class="r">Entry</th><th class="r">Qty</th><th class="r">PnL (TMN)</th><th class="r">PnL (% equity)</th><th class="r">R</th><th class="r">Fees</th></tr></thead><tbody>${t.rows
          .map((r) => {
            const v = r.pnlTmn ?? r.pnlFraction
            return `<tr><td class="mono">${fmtDateTime(r.ts)}</td><td>${symHtml(r.symbol)}</td><td>${esc(r.how)}</td><td class="r">${fmtPrice(r.entry)}</td><td class="r">${fmtQty(r.qty)}</td><td class="r ${tone(v)}">${glyph(v)} ${fmtSignedTmn(r.pnlTmn)}</td><td class="r ${tone(v)}">${fmtPct(r.pnlFraction, 2, true)}</td><td class="r ${tone(r.r)}">${fmtR(r.r)}</td><td class="r muted">${isNum(r.fees) ? `${r.feesEst ? '≈ ' : ''}${fmtTmn(r.fees)}` : '–'}</td></tr>`
          })
          .join('')}</tbody></table></div>`
      : empty('No closed trades', 'Finished round trips are listed here with PnL and R multiple.', 'i-trades'),
    'trade-table',
  )
}

/* ---------- system ---------- */
function renderSystem() {
  const s = snap
  const sys = s.system
  const age = s.health.heartbeatAgeSec === null ? null : (serverNow() - (s.now - s.health.heartbeatAgeSec * 1000)) / 1000
  const stale = isNum(age) && age > 120 && s.run.phase !== 'done' && s.run.phase !== 'waiting'
  setHTML($('sys-sub'), stale ? chip('bad', '▲', `Heartbeat stale: ${fmtAge(age)}. Stops are not executed while the daemon is down.`) : '')
  setHTML(
    $('fresh'),
    sys.symbols.length
      ? sys.symbols
          .map((x) => {
            const a = x.ageSec
            const st = !isNum(a) ? ['idle', 'No bars yet', 0] : a <= 150 ? ['ok', 'Fresh', a] : a <= 300 ? ['warn', 'Slow', a] : ['bad', 'Stale', a]
            return `<div class="fresh-row" data-s="${st[0]}"><span>${symHtml(x.symbol)}</span><span class="track"><i style="width:${Math.min(100, (st[2] / 300) * 100)}%"></i></span><b>${isNum(a) ? fmtAge(a) + ' · ' : ''}${st[1]}</b></div>`
          })
          .join('')
      : empty('No symbols yet', 'Symbols appear after the daemon warms up its market data.', 'i-system'),
    'fresh',
  )
  const kv = (k, v) => `<dt>${k}</dt><dd>${v}</dd>`
  const r = s.run
  const fl = sys.flatten
  setHTML(
    $('daemon'),
    r.mode || s.seq
      ? `<dl class="kv">${kv('Mode', esc(r.mode ?? '–'))}${kv('Strategy', esc(r.strategy ?? '–'))}${kv('Git revision', `<span class="mono">${esc(r.sha ?? '–')}</span>`)}${kv('Started', isNum(r.startedAt) ? fmtDateTime(r.startedAt) : '–')}${kv('Resumed from state', r.resumed ? 'Yes' : 'No')}${kv('Heartbeat age', isNum(age) ? (stale ? chip('bad', '▲', fmtAge(age)) : fmtAge(age)) : '–')}${kv('Heartbeats seen', fmtInt(sys.heartbeats))}${kv('Holdings', esc(sys.holdings.join(', ') || 'none'))}${kv('Flatten', fl ? (fl.flat ? 'Flat' : `${fl.remaining} holdings remain`) : 'Not started')}${kv('State files', esc(sys.files.map((f) => `${f.name} (${fmtAge(f.ageSec)})`).join(', ') || 'none'))}</dl>`
      : empty('No daemon data', 'Nothing has been logged yet.', 'i-system'),
    'daemon',
  )
  const e = sys.errors
  const card = (k, v, sub, bad) => `<article class="card stat"><span class="k">${k}</span><span class="v ${v > 0 && bad ? 'warn-t' : ''}">${v > 0 && bad ? '▲ ' : ''}${fmtInt(v)}</span><span class="s">${sub}</span></article>`
  const kinds = Object.entries(sys.api.byKind).map(([k, v]) => `${k} ${v}`).join(' · ')
  setHTML(
    $('err-stats'),
    card('Poll errors', e.pollErrors, 'candle fetch failures', true) +
      card('API errors', e.apiErrors, esc(kinds || 'no failures by kind'), true) +
      card('Exit rejections', e.exitRejected, 'exits the exchange refused', true) +
      card('Degraded episodes', e.degraded, 'API down with positions open', true) +
      card('Strategy errors', sys.strategyErrors, 'exceptions caught in the strategy', true) +
      card('API failing in a row', sys.api.consecutive, `${fmtInt(sys.api.total)} failures in total`, true),
    'err-stats',
  )
  setHTML(
    $('err-feed'),
    e.recent.length
      ? `<ol class="feed">${e.recent.map((x) => `<li><time>${fmtClock(x.ts)}</time><span class="tg warn-t" aria-hidden="true">!</span><span><b class="mono">${esc(x.kind)}</b> ${esc(x.text)}</span></li>`).join('')}</ol>`
      : empty('No errors', 'Poll, API and exit errors are listed here when they happen.', 'i-system'),
    'err-feed',
  )
}

/* ---------- log ---------- */
let logFamily = 0
let logExpanded = new Set()
let logBusy = false
const famOf = (ev) => {
  if (ERR_EVENTS.split(',').includes(ev)) return 'err'
  if (ev === 'daemon.heartbeat' || ev === 'poll.warmup') return 'mute'
  if (ev.startsWith('ai.') || ev.startsWith('supervisor')) return 'ai'
  if (/^(setup\.accepted|entry\.filled|tp\.filled|exit)$/.test(ev)) return 'good'
  if (/^(daemon\.(entries_disabled|flatten.*|warn)|entry\.cancelled|stop\.hit|pullout.*)$/.test(ev)) return 'warn'
  return 'info'
}
function renderChips() {
  setHTML($('log-chips'), FAMILIES.map(([label], i) => `<button type="button" data-i="${i}" aria-pressed="${i === logFamily}">${label}</button>`).join(''))
}
async function fetchLog() {
  if (view !== 'log' || logBusy) return
  logBusy = true
  try {
    const sel = $('log-event').value
    const event = sel || FAMILIES[logFamily][1]
    const params = new URLSearchParams({ event, q: $('log-q').value, limit: '400' })
    const r = await fetch(`/api/log?${params}`, { cache: 'no-store' })
    if (!r.ok) return
    const data = await r.json()
    const selEl = $('log-event')
    const opts = ['<option value="">All events</option>', ...data.events.map((x) => `<option value="${esc(x.event)}"${x.event === sel ? ' selected' : ''}>${esc(x.event)} (${x.count})</option>`)].join('')
    if (cache.get('log-opts') !== opts) {
      cache.set('log-opts', opts)
      selEl.innerHTML = opts
      selEl.value = sel
    }
    setText($('log-sub'), `${data.total} matching entries${data.total > data.rows.length ? `, showing the latest ${data.rows.length}` : ''}`)
    const list = $('log-list')
    const html = data.rows.length
      ? data.rows
          .map((x) => `<div class="log-row" role="button" tabindex="0" data-seq="${x.seq}" aria-expanded="${logExpanded.has(x.seq)}"><time>${fmtClock(x.ts)}</time><span class="ev" data-f="${famOf(x.event)}">${esc(x.event)}</span><span class="sm">${esc(logExpanded.has(x.seq) ? pretty(x.raw) : x.summary)}</span></div>`)
          .join('')
      : empty('Nothing matches', 'Clear the search or choose another event type. The log fills as the daemon writes.', 'i-log')
    const stick = $('log-follow').checked
    if (setHTML(list, html, 'log-list') && stick) list.scrollTop = list.scrollHeight
  } catch {
    /* the connection banner already reports outages */
  } finally {
    logBusy = false
  }
}
function pretty(raw) {
  try { return JSON.stringify(JSON.parse(raw), null, 1) } catch { return raw }
}
function toggleRow(row) {
  const seq = Number(row.dataset.seq)
  if (logExpanded.has(seq)) logExpanded.delete(seq)
  else logExpanded.add(seq)
  cache.delete('log-list')
  fetchLog()
}

/* ---------- render loop ---------- */
function renderAll() {
  if (!snap) return
  renderHeader()
  renderHealth()
  const f = { overview: () => { renderTimeline(); renderOverview() }, positions: renderPositions, setups: renderSetups, ai: renderAi, trades: renderTrades, system: renderSystem, log: () => {} }[view]
  f()
}

/* ---------- actions ---------- */
function toast(msg) {
  const t = $('toast')
  t.textContent = msg
  t.hidden = false
  clearTimeout(toast.h)
  toast.h = setTimeout(() => (t.hidden = true), 3800)
}
function askConfirm({ title, body, ok, solidClass }) {
  const d = $('confirm')
  setText($('c-title'), title)
  $('c-body').innerHTML = body
  const okBtn = $('c-ok')
  okBtn.textContent = ok
  okBtn.className = `btn ${solidClass}`
  return new Promise((resolve) => {
    d.addEventListener('close', () => resolve(d.returnValue === 'ok'), { once: true })
    d.returnValue = 'cancel'
    d.showModal()
    $('c-cancel').focus()
  })
}
async function toggleKill() {
  if (!snap) return
  const engaged = snap.killSwitch
  const virtual = snap.killSwitchVirtual
  const yes = await askConfirm(
    engaged
      ? { title: 'Release the kill switch?', body: `<p>This removes the <b>${esc(snap.killFile || 'STOP')}</b> file${virtual ? ' (simulated here)' : ''}. The risk guard will allow new entries again, subject to its other limits.</p>`, ok: 'Release kill switch', solidClass: 'safe solid' }
      : { title: 'Engage the kill switch?', body: `<p>This creates the <b>${esc(snap.killFile || 'STOP')}</b> file${virtual ? ' (simulated here, nothing is written)' : ''}.</p><ul><li>The guard refuses every new entry.</li><li>Pending entry orders are cancelled.</li><li>Open positions keep their stops and exits. Nothing is sold.</li></ul><p>You can release it at any time.</p>`, ok: 'Engage kill switch', solidClass: 'danger solid' },
  )
  if (!yes) return
  try {
    const send = () => fetch('/api/stop', { method: 'POST', headers: { 'content-type': 'application/json', 'x-confirm': 'stop', 'x-dashboard-token': sessionStorage.getItem('sc-token') || '' }, body: JSON.stringify({ enabled: !engaged }) })
    let r = await send()
    if (r.status === 401) {
      const t = window.prompt('Dashboard token (DASHBOARD_TOKEN):')
      if (t) {
        sessionStorage.setItem('sc-token', t.trim())
        r = await send()
      }
    }
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.status)
    toast(engaged ? 'Kill switch released' : 'Kill switch engaged')
    const s = await fetch('/api/state', { cache: 'no-store' })
    if (s.ok) apply(await s.json())
  } catch (err) {
    toast(`Could not change the kill switch: ${err.message ?? err}`)
  }
}
async function demoScenario(scenario) {
  if (snap?.source !== 'demo') return
  await fetch('/api/demo', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ scenario }) }).catch(() => {})
}

$('kill-toggle').addEventListener('click', toggleKill)
$('kill-release').addEventListener('click', toggleKill)
$('log-q').addEventListener('input', () => { clearTimeout(fetchLog.h); fetchLog.h = setTimeout(fetchLog, 180) })
$('log-event').addEventListener('change', fetchLog)
$('log-follow').addEventListener('change', fetchLog)
$('log-chips').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-i]')
  if (!b) return
  logFamily = Number(b.dataset.i)
  $('log-event').value = ''
  renderChips()
  fetchLog()
})
$('log-list').addEventListener('click', (e) => { const r = e.target.closest('.log-row'); if (r) toggleRow(r) })
$('log-list').addEventListener('keydown', (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target.classList.contains('log-row')) { e.preventDefault(); toggleRow(e.target) } })

let haltOn = false
document.addEventListener('keydown', (e) => {
  const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement?.tagName ?? '')
  if (e.metaKey || e.ctrlKey || e.altKey || $('confirm').open) return
  if (e.key === '/' && !typing) { e.preventDefault(); location.hash = '#log'; setTimeout(() => $('log-q').focus(), 30); return }
  if (typing) return
  if (e.shiftKey && e.key.toLowerCase() === 'h') { haltOn = !haltOn; demoScenario(haltOn ? 'halt' : 'normal'); toast(haltOn ? 'Demo: halt scenario started' : 'Demo: back to normal'); return }
  const n = Number(e.key)
  if (n >= 1 && n <= VIEWS.length) location.hash = `#${VIEWS[n - 1]}`
})

/* ---------- boot ---------- */
renderChips()
route()
startSSE()
startPolling()
setInterval(() => {
  if (conn === 'live' && Date.now() - lastMsg > 6000) {
    es?.close()
    es = null
    startPolling()
    setTimeout(startSSE, 8000)
  }
  if (!snap) return
  renderHealth()
  if (view === 'overview') { renderTimeline(); renderStats() }
  if (view === 'system') renderSystem()
  if (conn === 'lost') setText($('conn-note'), `Showing data from ${fmtAge((Date.now() - recvAt) / 1000)} ago. Retrying…`)
}, 1000)
setInterval(() => { if (view === 'log' && $('log-follow').checked) fetchLog() }, 2000)
if (new URLSearchParams(location.search).get('scenario') === 'halt') {
  haltOn = true
  const kick = setInterval(() => { if (snap) { clearInterval(kick); demoScenario('halt') } }, 300)
}
