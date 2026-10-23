# Operator handbook

Everything an operator needs for the three-day run, in order.

## What is built

| Area | State |
|---|---|
| Combo strategy (breakout + washout), risk guard, sizing, order sanity check | Production, 252 tests passing |
| AI supervisor with news and sentiment | Verified live with the configured model (`bun src/ai/try.ts`) |
| Wallex client and live adapter | Verified with real orders on the challenge account; response shapes documented in [WALLEX.md](WALLEX.md) |
| Backtests and strategy tournament | 180 days of data, held-out test window, results in [RESEARCH.md](RESEARCH.md) |
| Shadow and dry modes | Run on the live market with all 15 markets primed |
| Dashboard, metrics, Grafana dashboard and alerts | `bun run dashboard`, `ops/` |
| Docker and CI | Hardened compose file, CI with tests, audit and secret scan |

## Before the run (30 minutes)

1. `bun install && bun run test && bun run typecheck`
2. Keys in `.env` (git-ignored): `WALLEX_API_KEY` (trade only), `AI_BASE_URL`, `AI_API_KEY`, `AI_MODEL`.
3. `bun run config validate` and `bun run check`: about 5,000,000 TMN, no open orders.
4. `bun src/ai/try.ts`: a verdict with `"source": "ai"`.
5. `bun run dry --minutes 15`: `dry.would_send` lines look sane.
6. Commit, push and tag the exact code: `git tag run-1 && git push --tags`. Every log line carries the short SHA.

## Start

```bash
RUN_END=<official end minus 30 min, ISO> caffeinate -i bun run live --confirm-live
```

Inside `tmux` or Docker (`STARCOACH_MODE=live`, `STARCOACH_CONFIRM_LIVE=yes`, `RUN_END` in `.env`, then `docker compose up -d trader dashboard`). At start the bot loads 8 days of candles for the 15 markets (`strategy.primed`) and is ready to trade immediately.

## During the run

| Check | Where |
|---|---|
| Heartbeat every 20 s: phase, equity, risk, positions, API errors | Console, `daemon.heartbeat` |
| Decisions with reasons | `bun run dashboard` (http://127.0.0.1:8787) or the log |
| Alerts | Grafana (`ops/`), 10 rules |
| Stop new entries | `touch STOP` or the dashboard button |
| Restart for any reason | Same command and same `RUN_END`: guard history, positions and stops are restored |

## End of the run

1. At `RUN_END` minus 45 minutes new entries stop; at `RUN_END` pending buys are cancelled and the daemon exits with a summary.
2. Convert everything to TMN: `bun run pullout` (plan), then `bun run pullout --yes`, until the plan shows nothing to sell.
3. `bun run check`: TMN only. Note the final balance and take a screenshot.
4. Hand in: the tagged commit, `docs/`, the decision logs (`git add -f logs/live-*.jsonl` or a zip), the video.

## Map of the code

`src/strategy` trade engine (`engine.ts`), breakout (`breakout/`) and washout (`washout.ts`) models · `src/risk` sizing and guard · `src/ai` supervisor, news, provider compatibility · `src/exchange` live, dry, paper · `src/wallex` REST client · `src/runner` backtest and polling · `src/daemon.ts` live loop · `src/security` redaction and safe HTTP · `src/settings`, `src/env*.ts` config · `src/dashboard` · `src/telemetry` · `arena/` strategy tournament · `ops/` Grafana · `docker/` entrypoint and health check. Diagrams: [ARCHITECTURE.md](ARCHITECTURE.md).
