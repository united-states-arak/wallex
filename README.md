# starcoach-trader

An autonomous, AI-supervised trading engine for **Wallex spot TMN markets**, built for the StarCoach × Wallex Agentic AI trading challenge.

- **Strategy ("combo"):** two researched models in one position book. A **trend breakout** buys when a coin's hourly close breaks its 4-day high on strong volume while most of the market trends up, and rides it with an ATR trailing stop. A **washout bounce** buys sharp, coin-specific drops and sells the rebound within hours. The breakout won a strategy tournament on **held-out data**; the washout model adds steady activity, about four round trips per three days ([STRATEGY](docs/STRATEGY.md), [RESEARCH](docs/RESEARCH.md)).
- **Agentic AI:** an AI supervisor agent reviews **every** candidate trade with live news, Fear and Greed and trending data, and approves, shrinks or vetoes it with a written reason. The strategy itself came from a tournament of autonomous AI research agents. Verified live against the configured model ([AI](docs/AI.md)).
- **Risk first:** every trade risks 1% of equity at its stop, no position exceeds 50% of the account, at most 2 positions, day-loss and drawdown halts, profit locks, an independent order sanity check and a one-command kill switch ([RISK](docs/RISK.md)).
- **Auditable:** every signal, filter, AI verdict, order, fill and exit is written to a JSONL decision log stamped with the git commit and config hash. The same code runs in backtest, shadow, dry and live modes.
- **Verified on the live exchange:** the full order path was exercised with real orders on the challenge account, with 136 ms median order placement ([WALLEX](docs/WALLEX.md)).
- **Secure by design:** secrets only in the environment and redacted from every log, TLS-only outbound traffic, a hardened non-root container, and CI with tests, dependency audit and secret scanning ([SECURITY](docs/SECURITY.md)).

## Results

| Test | Return | Max drawdown |
|---|---|---|
| **Production backtest, 180 days** (255 round trips, 58.8% wins, about 4 per 3 days) | **+41.43%** | **6.15%** |
| Production backtest, last 60 days (75 round trips) | +26.79% | 7.82% |
| Tournament harness, 60-day held-out window (3x harsher spread) | +17.52% | 7.85% |
| Tournament harness, 120-day training window | +30.73% | 7.60% |
| Breakout model alone, held-out window | +23.86% | 7.85% |

## Quick start

Requires [Bun](https://bun.sh) 1.3.x. No build step.

```bash
bun install
bun run test                     # 252 tests, no network, no keys
bun run typecheck
```

Reproduce the results without any API key (public market data, cached locally):

```bash
bun run backtest --from 2026-08-23T00:00:00Z --to 2026-10-22T00:00:00Z
bun run backtest --from 2026-04-25T00:00:00Z --to 2026-10-22T00:00:00Z
ARENA_FINAL=1 bun arena/run.ts --strategy arena/strategies/production-combo.ts --window test
bun run dashboard --replay logs/<backtest log>.jsonl --speed 20      # watch the decisions at http://127.0.0.1:8787
```

Run on the live market:

```bash
cp .env.example .env             # WALLEX_API_KEY (trade only), AI_BASE_URL, AI_API_KEY, AI_MODEL
bun run check                    # account, balances, open orders
bun src/ai/try.ts                # the AI supervisor reviews a sample trade with live news
bun run shadow --minutes 1440    # live data, simulated fills
bun run dry --minutes 60         # live data, orders validated, never sent
bun run live --confirm-live --run-end 2026-10-25T12:00:00Z
bun run pullout --yes            # end of run: sell everything to TMN
```

| Goal | Command |
|---|---|
| Backtest | `bun run backtest [--from ISO --to ISO \| --days N]` |
| Shadow test (live data, paper fills) | `bun run shadow --minutes N` |
| Dry run (validate and log orders, send nothing) | `bun run dry --minutes N` |
| Full daemon on paper | `bun run live --paper --run-end ISO` |
| Full daemon, real orders | `bun run live --confirm-live --run-end ISO` |
| Sell everything to TMN | `bun run pullout` (plan), `bun run pullout --yes` (execute) |
| Stop new entries | `touch STOP` (remove to resume) |
| Dashboard | `bun run dashboard` (`--demo`, `--replay <log>`), http://127.0.0.1:8787 |
| Metrics and alerts | `docker compose -f ops/docker-compose.yml up -d` (Grafana :3000, Prometheus :9090) |
| Strategy tournament | `bun arena/run.ts --strategy <file>` (see [arena/README.md](arena/README.md)) |

The default strategy is `combo` (`strategy.active`). `--strategy breakout` runs the breakout model alone, `--strategy ict` the alternative ICT model.

## Configuration

Priority: **environment > `config/local.toml` > `config/profiles/<name>.toml` > `config/default.toml` > code defaults**. Every strategy and risk parameter is documented in `config/default.toml`. The environment is validated at start (exit 78 with a list of problems on a bad value). Secrets (`WALLEX_API_KEY`, `AI_API_KEY`, `DASHBOARD_TOKEN`) are environment-only.

```bash
bun run config show        # every effective value and the layer it came from
bun run config validate    # environment, effective config and every profile
bun run config hash        # the hash also written to the decision log at start
```

## Docker

```bash
cp .env.example .env
docker compose build
docker compose up -d trader dashboard     # paper mode by default; dashboard on 127.0.0.1:8787
docker compose logs -f trader
docker compose run --rm trader bun run pullout --yes
touch control/STOP
```

Real orders need `STARCOACH_MODE=live` and `STARCOACH_CONFIRM_LIVE=yes`. Both services run as non-root with a read-only filesystem, no capabilities and resource limits.

## Architecture

| Area | What it does | Where |
|---|---|---|
| Strategy | Shared trade engine with two signal models: hourly breakout with a market gate, washout bounce | `src/strategy/engine.ts`, `src/strategy/breakout/`, `src/strategy/washout.ts` |
| AI | Supervisor agent with news and sentiment tools, provider compatibility | `src/ai/` |
| Risk | Stop-based sizing, guard (halts, profit locks, kill switch) | `src/risk/` |
| Exchange | Live, dry and paper adapters behind one interface, order sanity check | `src/exchange/` |
| Wallex | REST client verified against the live API | `src/wallex/rest.ts` |
| Daemon | Schedule, multi-day warm-up, restart-safe state, tick-level stops, backoff | `src/daemon.ts`, `src/runner/` |
| Security | Secret redaction, bounded and TLS-only requests | `src/security/` |
| Research | Strategy tournament harness and contestant reports | `arena/` |
| Observability | Dashboard, Prometheus metrics, Grafana dashboard and 10 alert rules | `src/dashboard/`, `src/telemetry/`, `ops/` |

## Documentation

| Doc | Content |
|---|---|
| [docs/OVERVIEW.md](docs/OVERVIEW.md) | One-page summary |
| [docs/STRATEGY.md](docs/STRATEGY.md) | Exact buy and sell rules with a worked example |
| [docs/RESEARCH.md](docs/RESEARCH.md) | Strategy tournament, held-out results, backtests |
| [docs/AI.md](docs/AI.md) | AI supervisor and AI research agents |
| [docs/RISK.md](docs/RISK.md) | Capital and risk management |
| [docs/WALLEX.md](docs/WALLEX.md) | Wallex API and MCP usage, live verification |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Components, data flow, modes, failure handling |
| [docs/SECURITY.md](docs/SECURITY.md) | Threat model, controls, standards alignment |
| [docs/OPERATIONS.md](docs/OPERATIONS.md) | Runbook, configuration, dashboard, metrics |
| [docs/TESTING.md](docs/TESTING.md) | Tests, backtests, shadow and dry runs |
| [docs/COMPLIANCE.md](docs/COMPLIANCE.md) | Challenge requirements and judging criteria, point by point |
| [docs/HANDOFF.md](docs/HANDOFF.md) | Operator handbook for the run |
| [docs/VIDEO_SCRIPT_FA.md](docs/VIDEO_SCRIPT_FA.md) | Persian demo video script |
| [docs/ICT_MODEL.md](docs/ICT_MODEL.md) | The alternative ICT model (`--strategy ict`), historical |
| [SECURITY.md](SECURITY.md) | Vulnerability reporting policy |

## License

Hackathon project, no license granted yet.
