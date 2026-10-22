# Operations runbook

## 1. Prerequisites

| Need | Notes |
|---|---|
| Bun 1.3.x | `bun install`. Bun loads `.env` by itself |
| Network | `api.wallex.ir`, plus the news hosts for the AI (coindesk.com, cointelegraph.com, alternative.me, coingecko.com) |
| Wallex API key | **Trade only, no withdrawal.** Header `x-api-key` |
| LLM endpoint | OpenAI-compatible, tool calling. See AI.md |
| A machine that stays awake | The stops live in the process. On macOS: `caffeinate -i bun run live ...`, ideally inside `tmux` |
| Docker (optional) | Runs the daemon and dashboard from one image (section 10), and Grafana and Prometheus |

## 2. Environment variables

Priority: **environment > `config/local.toml` > `config/profiles/<name>.toml` > `config/default.toml` > code defaults**. `.env.example` lists every variable below. A bad value exits with code 78 and a list of problems (validation commands in section 10).

| Variable | Default | Meaning |
|---|---|---|
| `WALLEX_API_KEY` | none | Required for `live`, `pullout`, `check` private calls |
| `WALLEX_BASE_URL` | `https://api.wallex.ir` | |
| `MAKER_FEE`, `TAKER_FEE` | 0.0025, 0.003 | Used by sizing, gates and the simulator |
| `PAPER_SPREAD_BPS`, `PAPER_SLIPPAGE_BPS` | 10, 10 | Simulator only |
| `START_TMN` | 5000000 | Paper start balance. Live uses the real TMN balance |
| `SYMBOLS` | `PEPETMN,PUMPTMN,DOGETMN` | Or pass `--symbols A,B` or `--symbols auto` |
| `RUN_END` | now + 24 h | ISO time. Or `--run-end` |
| `ENTRY_CUTOFF_MIN`, `FLATTEN_MIN` | 45, 15 | Minutes before `RUN_END`. Or `--entry-cutoff-min`, `--flatten-min` |
| `RISK_PCT`, `LOCK1_PNL`, `LOCK1_RISK`, `LOCK2_PNL`, `LOCK2_RISK` | 0.01, 0.15, 0.005, 0.30, 0.0025 | RISK.md |
| `DAILY_LOSS_HALT`, `HARD_DRAWDOWN`, `LOSS_STREAK`, `LOSS_PAUSE_MIN`, `MAX_ENTRIES_PER_HOUR` | 0.12, 0.30, 3, 30, 6 | RISK.md |
| `AI_BASE_URL`, `AI_API_KEY`, `AI_MODEL`, `AI_TIMEOUT_MS`, `AI_FAIL_MODE` | empty, empty, `gpt-4o-mini`, 12000, `approve` | AI.md |
| `OTEL_PROMETHEUS_PORT`, `OTEL_PROMETHEUS_HOST` | 9464, 127.0.0.1 | Metrics endpoint |
| `OTEL_SDK_DISABLED` | false | `true` turns metrics off (or `--no-metrics`) |
| `OTEL_EXPORTER_OTLP_ENDPOINT` (or `..._METRICS_ENDPOINT`), `OTEL_EXPORTER_OTLP_HEADERS` | none | Optional OTLP push every 10 s |

Operational variables, environment only (not settings): `STARCOACH_MODE` (`paper` default, `dry`, `live`), `STARCOACH_CONFIRM_LIVE` (must be `yes` for live), `STARCOACH_ARGS` (extra `live` flags), `HEALTH_MAX_AGE_S` (healthcheck limit, default max(180, 3 x `wallex.pollMs`)), `GIT_SHA`. Also: `STARCOACH_PROFILE` picks a profile, `STARCOACH_CONFIG_DIR` moves the config folder, and every setting can be set as `STARCOACH__section__key` (see `bun run config show`). `WALLEX_API_KEY` and `AI_API_KEY` are never read from config files.

## 3. First-run checklist

1. `bun install && bun run test && bun run typecheck`.
2. Put the key in `.env`. `bun run check`. Confirm the balances show the challenge TMN balance (about 5,000,000) and open orders are empty. If the shape looks wrong, **stop**: parsers are unverified (COMPLIANCE.md section 4).
3. AI: `bun src/ai/try.ts` must print a news digest with a Fear and Greed value and a verdict with `"source": "ai"`.
4. Dry: `bun run dry --strategy ict --minutes 60`. Look in the log for `dry.would_send` with sane quantity and price, and no unexpected `dry.rejected`.
5. Paper rehearsal, several hours: `bun run live --paper --symbols auto --run-end <ISO, now+4h>`. Check heartbeats, a clean `daemon.stop` with `flat: true`, and the state files in `state/`.
6. Optional canary: `RISK_PCT=0.0025 RUN_END=... bun run live --confirm-live`. Restart later with the normal risk and the **same** `RUN_END` to resume.
7. `git status` clean, commit pushed, tag it (for example `git tag run-1`). Logs carry the short SHA.

## 4. Running for 24 h (or the whole challenge)

```bash
RUN_END=2026-10-23T09:00:00Z caffeinate -i bun run live --symbols auto --confirm-live
```

- `live` defaults to strategy `ict` and AI on. Without `RUN_END` it runs 24 h and logs a warning.
- For the 3-day challenge set `RUN_END` to the official end minus at least 30 minutes (45 min cutoff and 15 min flatten fit inside that).
- The console prints one heartbeat line per poll cycle: `phase equity risk halted positions api_errors`. `phase` goes `trading`, `entries_off`, `flattening`.
- Check in the first 5 minutes: `metrics:` URL printed, `daemon.start` has the right `runEnd`, `barAgeSec` values are small, `api_errors=0`.
- Env changes (for example `AI_FAIL_MODE=veto`) apply on restart. Restart with the **same** `RUN_END` to resume the guard history too. With a different `RUN_END` the guard starts fresh, saved open positions and pending entries are kept (warning `daemon.state_kept`), a flat state is discarded.

## 5. Dashboard

```bash
bun run dashboard                    # reads the log, state and kill-file paths from settings, http://127.0.0.1:8787
bun run dashboard --demo             # synthetic data for the video, add --scenario halt to show a halt
bun run dashboard --replay logs/<file>.jsonl --speed 20
```

Paths and limits come from the settings layer, resolved against the repo root (or `dashboard.root` / `DASHBOARD_ROOT`): `logging.dir`, `logging.stateDir`, `risk.killFile` (Docker: `control/STOP`; the parent directory is created on demand and an existing file is detected; an empty value disables the toggle), `dashboard.host` / `dashboard.port`, and the gauge limits `risk.dayLossHalt`, `risk.hardDrawdown`, `risk.lockTiers`. Flags: `--port`, `--host` override the settings (keep `127.0.0.1`, there is no authentication). Open positions show unrealized % and distance to the stop from the heartbeat `marks` (last bid, else last bar close), and closed trades show fees from the `exit` event (`feeTmn`, or `feeTmnEst` when estimated); older logs without those fields still load. It is a separate process that tails the JSONL log, so it also replays finished runs. Endpoints: `/api/state`, `/api/stream` (SSE), `/api/log?event=&q=&limit=`. A confirm-protected `POST /api/stop` creates or removes the `STOP` file.

## 6. Metrics and alerting

The `live` command serves Prometheus metrics at `http://127.0.0.1:9464/metrics` and optionally pushes OTLP. Names start with `starcoach_`: `equity_tmn`, `pnl_pct`, `day_pnl_pct`, `drawdown_pct`, `risk_pct`, `guard_halted`, `open_positions`, `exposure_pct`, `run_seconds_remaining`, `heartbeat_age_seconds`, `last_bar_age_seconds`, `consecutive_losses`, and counters `orders_total`, `trades_closed_total`, `setups_total`, `ai_verdicts_total`, `api_errors_total`, `exec_rejected_total`, `daemon_degraded_total`, plus histograms `trade_pnl_pct`, `ai_latency_ms`, `decision_latency_ms`, `order_latency_ms`.

```bash
docker compose -f ops/docker-compose.yml up -d     # Prometheus :9090 and Grafana :3000 (admin / admin), scrapes host.docker.internal:9464
```

Grafana dashboard "Starcoach trader" (`ops/grafana/dashboards/starcoach.json`, 28 panels) at http://localhost:3000/d/starcoach-trader. Alert rules (`ops/grafana/provisioning/alerting/alerts.yml`, evaluated every minute). Contact points are not provisioned, add one in Grafana. Details and Grafana Cloud push: `ops/README.md`.

| Alert | Condition |
|---|---|
| Bot down or heartbeat stale | Heartbeat older than 120 s for 1 min, or no series |
| Risk guard halted | `starcoach_guard_halted` above 0 (day halt, hard kill, `STOP` file) |
| Drawdown from day peak above 6% | 2 min |
| Day PnL below -8% | 2 min |
| Equity below 70% of start | 2 min |
| API errors above 5 per minute | 5 min |
| Exit or TP order rejected | any in 5 min |
| AI fallback ratio above 50% | over 15 min, at least 3 verdicts |
| Symbol bar age above 300 s | 2 min |
| Run ends in under 20 min with positions open | immediately |

The compose stack, the dashboard import and the alert queries have not been run against real Docker, Grafana or Prometheus yet (stated in `ops/README.md`). Metrics exist only for the `live` command (including `--paper` and `--dry`), not for `shadow` or `backtest`.

## 7. Emergency procedures

| Situation | Action |
|---|---|
| Stop new trades, keep managing open ones | `touch STOP` in the repo root (Docker: `touch control/STOP`), or the dashboard button. `rm` the file to resume |
| Sell everything now | Stop the daemon first (Ctrl+C), then `bun run pullout`, check the plan, `bun run pullout --yes`. Repeat until nothing is held. It cancels **all** open orders |
| Daemon stopped with positions open | Stops are unprotected. Restart with the same command and `RUN_END`, or `pullout --yes` |
| API down, `daemon.degraded` alarm | Fix network. If the loss would be large, a manual sale is a manual trade: avoid unless needed, and write it down for the hand-in |
| Guard halted (day or hard) | Nothing to do. Day halt lifts at 00:00 UTC. Hard kill lasts for the run |
| AI misbehaving | Restart with `AI_FAIL_MODE=veto` or `--ai off`, same `RUN_END` |
| Flatten incomplete | Console warning `flatten incomplete`. The daemon retries every 60 s. Run `pullout --yes` if it persists |

## 8. End of the competition

1. The daemon ends itself: entries off at minus 45 min, flatten from minus 15 min, exit at `RUN_END`. Exit code 0 means flat.
2. Verify: last log lines `daemon.flatten` with `flat: true` and `daemon.stop`. `bun run pullout` (plan) must say `nothing`. `bun run check` shows TMN only (dust excepted).
3. Note the final TMN balance and take a screenshot of the account.
4. Back up `logs/` and `state/`. Do not run `research` afterwards if you want the committed `RESEARCH.md` kept: it overwrites it.

## 9. What to hand in

| Item | Source |
|---|---|
| Code on GitHub at the traded commit (tagged) | repo. `.env`, `logs/`, `state/` are git-ignored |
| Markdown documentation | `README.md`, `docs/` |
| Decision logs | `logs/live-*.jsonl` (zip them, or `git add -f`) plus the backtest, shadow and dry logs used as evidence |
| Backtest and shadow results | `docs/RESEARCH.md`, backtest and shadow logs |
| Demo video, about 5 min | See VIDEO_SCRIPT_FA.md |
| Run facts | Start and end time, command, commit SHA, final TMN balance |

## 10. Docker, configuration and live confirmation

Check the configuration first (no network): `bun run config validate` (environment, effective config, every profile, exit 78 on problems), `bun run config show`, `bun run config hash`.

```bash
cp .env.example .env                              # fill WALLEX_API_KEY (and AI_*); leave the rest empty to use config/
docker compose build
docker compose up -d trader dashboard
docker compose logs -f trader
docker compose run --rm trader bun run pullout --yes
touch control/STOP                                # blocks new entries; rm control/STOP resumes
```

| Topic | Behaviour |
|---|---|
| Mode | `STARCOACH_MODE=paper` (default), `dry` or `live`. `live` needs `WALLEX_API_KEY` and `STARCOACH_CONFIRM_LIVE=yes`, otherwise the container exits 64 before trading |
| Run end | Set `RUN_END` in `.env`, or pass `STARCOACH_ARGS="--run-end 2026-10-25T12:00:00Z"`. Without it the run lasts `run.defaultHours` (24) |
| Kill file | Compose sets `STARCOACH__risk__killFile=control/STOP` for both services; `./control` is a volume, so `touch control/STOP` on the host works. The path is relative to the repo root (`/app` in the image) |
| Volumes | `./state`, `./logs`, `./data`, `./control` (read-write for the trader), `./config` (read-only, so `config/local.toml` applies). On Linux make them writable by uid 1000 (`chown -R 1000 state logs data control`) |
| Restart | `restart: on-failure:5`. A crash restarts the daemon and, with the same `RUN_END`, resumes guard and positions from `state/`. A finished run (exit 0) stays stopped. Exit 1 means not flat: run `pullout --yes`. `docker compose stop` sends SIGTERM (60 s grace): entries stop, pending buys are cancelled, state is saved |
| Healthcheck | `docker/healthcheck.ts`: healthy when `logs/live-*.jsonl` (in `logging.dir`) was written in the last `HEALTH_MAX_AGE_S` seconds (default max(180, 3 x `wallex.pollMs`)). Check with `docker compose ps` |
| Startup | The entrypoint runs `bun src/settings/cli.ts validate` and prints `config hash: ...`; the same hash is in `daemon.start` |
| Ports | Metrics `127.0.0.1:9464`, dashboard `127.0.0.1:8787`. There is no authentication, keep them on localhost |

The image was reviewed and `docker compose config -q` passes, but it has not been built or run in this environment.
