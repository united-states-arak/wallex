# starcoach-trader

An automated, long-only **spot** trading daemon for Wallex TMN markets, built for the StarCoach / Wallex Agentic AI trading challenge.

- Strategy: a simplified **ICT** model (sell-side liquidity sweep, market structure shift, fair value gap retracement) plus a trend continuation model, run on 1m candles aggregated to 5m, 15m and 1H.
- Code decides and places every order. An **AI supervisor** (OpenAI-compatible endpoint, `libfx` agent) can only **approve, veto or shrink** a candidate trade, and writes its reason to the decision log.
- Risk is fixed in code: 1% of equity lost at the stop, 50% position cap, max 2 positions, day-loss halt, drawdown kill, `STOP` file.
- Everything is logged as JSONL (signal, filters, sizing, AI verdict, orders, fills, git SHA). At the end of the run the daemon sells everything back to **TMN**.
- Same strategy code runs in backtest, shadow, dry, paper and live modes.

## Quick start

Requires [Bun](https://bun.sh) (tested with 1.3.4). No build step.

```bash
bun install
cp .env.example .env          # add WALLEX_API_KEY (trade only, no withdrawal) and the AI_* variables
bun run check                 # markets, key status, raw private API responses
bun run test                  # unit tests, no network
bun run typecheck
```

| Goal | Command |
|---|---|
| Backtest, 7 days, 12 auto-picked liquid markets | `bun run backtest --strategy ict --symbols auto --days 7` |
| Walk-forward research (writes `docs/RESEARCH.md`) | `bun run research -- --symbols auto --days 7` |
| Shadow test on live data, paper fills, 24 h | `bun run shadow --strategy ict --minutes 1440` |
| Dry run: validate and log orders, send nothing | `bun run dry --strategy ict --minutes 60` |
| Full daemon, paper exchange | `bun run live --paper --run-end 2026-10-25T12:00:00Z` |
| Full daemon, real orders | `bun run live --run-end 2026-10-25T12:00:00Z` |
| Emergency / end of run: sell everything to TMN | `bun run pullout` (plan), `bun run pullout --yes` (execute) |
| Dashboard | `bun run dashboard` then open http://127.0.0.1:8787 (`--demo`, `--replay <log>`) |
| Metrics and alerts | `docker compose -f ops/docker-compose.yml up -d` (Grafana :3000, Prometheus :9090). The bot exposes http://127.0.0.1:9464/metrics |

`backtest`, `shadow`, `dry` and `live` all default to the `ict` strategy. `--strategy noop` places no orders (wiring checks). Without `--symbols`, `market.symbols` is used, or the auto universe when `market.universe.auto = true`.

## Configuration

Priority: **environment > `config/local.toml` > `config/profiles/<name>.toml` > `config/default.toml` > code defaults**.
Environment variables are validated by `src/env.ts` (`@t3-oss/env-core` + zod): a bad value stops the process with exit 78 and a list of problems. Any setting can be set as `STARCOACH__section__key=value`; the old names (`RISK_PCT`, `RUN_END`, `AI_*`, `OTEL_*`, ...) still work. Secrets (`WALLEX_API_KEY`, `AI_API_KEY`) are environment-only.

```bash
bun run config show      # effective config, with the layer each value came from
bun run config validate  # environment, effective config and every profile
bun run config hash      # sha256 of the effective config; also printed in the startup banner and `daemon.start`
STARCOACH_PROFILE=conservative bun run live --paper
```

See [config/README.md](config/README.md) and [.env.example](.env.example).

## Docker

```bash
cp .env.example .env                              # add WALLEX_API_KEY; STARCOACH_MODE=paper by default
docker compose build
docker compose up -d trader dashboard             # dashboard on http://127.0.0.1:8787, metrics on :9464
docker compose logs -f trader
docker compose run --rm trader bun run pullout --yes
touch control/STOP                                # stop new entries (rm control/STOP to resume)
```

Real orders need `STARCOACH_MODE=live` **and** `STARCOACH_CONFIRM_LIVE=yes` in `.env`. Details, volumes and restart behaviour: [docs/OPERATIONS.md](docs/OPERATIONS.md).

## Features

| Area | What it does | Where |
|---|---|---|
| Detector | Sweep + MSS + FVG, continuation after BOS, no-lookahead scoring | `src/ict/` |
| Gates | Stop band 1.0-2.5%, gross RR 2, net RR 1.5 after fees, spread 1% | `src/ict/detect.ts`, `src/strategy/ict.ts` |
| Sizing | Position size from the stop distance, fees and slippage included | `src/risk/size.ts` |
| Guard | Day halt, hard drawdown, profit lock, loss pause, entry rate, `STOP` | `src/risk/guard.ts` |
| AI | Supervisor agent with news tools, veto / shrink only, fail-safe fallback | `src/ai/` |
| Exchange | Live, dry, paper adapters behind one interface; blocked-market check | `src/exchange/` |
| Daemon | Schedule, entry cutoff, flatten, state resume, API-failure backoff | `src/daemon.ts` |
| Pullout | Cancel all, sell every coin to TMN with marketable limits | `src/pullout.ts` |
| Research | Train / test grid on 8 variants | `src/research/walk.ts` |
| Observability | Local dashboard, Prometheus metrics, Grafana dashboard and 10 alert rules | `src/dashboard/`, `src/telemetry/`, `ops/` |

## Documentation

| Doc | Content |
|---|---|
| [docs/OVERVIEW.md](docs/OVERVIEW.md) | One-page summary |
| [docs/HANDOFF.md](docs/HANDOFF.md) | Start here if you are taking over: state, unverified items, first-hour checklist |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Components, data flow, modes, state files, failure handling |
| [docs/STRATEGY.md](docs/STRATEGY.md) | Exact algorithm with a worked numeric example |
| [docs/RISK.md](docs/RISK.md) | Sizing formula, guard limits, end-of-run flatten |
| [docs/AI.md](docs/AI.md) | Role of the AI, tools, prompts, fallback, logs |
| [docs/OPERATIONS.md](docs/OPERATIONS.md) | Runbook, env vars, 24 h run, emergencies, hand-in list |
| [docs/TESTING.md](docs/TESTING.md) | Reproducing every test mode, simulator assumptions, limits |
| [docs/COMPLIANCE.md](docs/COMPLIANCE.md) | Challenge requirement and judging criterion mapping |
| [docs/RESEARCH.md](docs/RESEARCH.md) | Generated walk-forward table |
| [docs/VIDEO_SCRIPT_FA.md](docs/VIDEO_SCRIPT_FA.md) | Persian script for the demo video |
| [ict-strategy.md](ict-strategy.md) | Original ICT specification (the code implements a subset) |

## Safety notes

- Use a **trade-only** API key. Withdrawal is disabled on the challenge account anyway.
- Stops are **not** resting exchange orders. The daemon watches price (5 s ticks) and sells itself, so the process must stay running. If it dies with positions open, restart it (same `RUN_END` resumes guard and positions) or run `bun run pullout --yes`. With a different `RUN_END`, a saved state that still holds positions or pending entries is **kept** with a warning; a flat state is discarded.
- `touch STOP` (`touch control/STOP` in Docker, setting `risk.killFile`) blocks all new entries. It does not close positions.
- Private Wallex response shapes (balances, open orders, order, cancel) are parsed defensively but **not yet verified against a real key**. Run `bun run check` first.
- Spot only, no leverage, no margin endpoints are called. `config/blocked-markets.txt` is enforced on every buy.

## Results, honestly

Sample sizes are tiny and none of this is a forecast.

- 7-day backtest, 12 markets, `ict`, mock AI, paper fills with fees: **+1.14%**, max drawdown 1.12%, 2 closed round trips plus one position closed by the harness at the end (log `logs/backtest-2026-10-22T19-20-08-606Z.jsonl`).
- Walk-forward (train 4 days, test 3 days): the config picked on train had **0 test trades**. Looser variants made +0.5% to +1.1% on test with 2 to 4 trades and small losses on train. See [docs/RESEARCH.md](docs/RESEARCH.md).
- The fee floor (0.25% maker, 0.3% taker, about 0.5% round trip plus spread) keeps trade count low. Expect a handful of trades per day and a result near zero in either direction.
- Not yet done: a live run against a funded account, a run with a real LLM endpoint.

## License

Hackathon project, no license granted yet.
