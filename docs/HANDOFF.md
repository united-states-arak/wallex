# Handoff

Read this first, then `README.md` and `docs/OPERATIONS.md`.

## What this is

A Bun/TypeScript trading bot for the Wallex algorithmic trading challenge: spot only, long only, TMN pairs, 5,000,000 TMN start, profit counted in TMN at the end. The code finds simplified ICT setups, sizes each trade so a stop-out loses 1% of equity, lets an AI supervisor veto or shrink it, and places limit orders. Everything is logged as JSONL.

## State of the work

| Area | State |
|---|---|
| Strategy (sweep + MSS + FVG, continuation), 1% sizing, guard, pullout | Built and unit tested |
| Backtest, walk-forward research, shadow, dry run | Built, run on real Wallex candles |
| AI supervisor (`libfx`, OpenAI-compatible) and news | Built, tested against a fake LLM server only |
| Live daemon, flatten before the end, restart state | Built, run in `--paper` mode only |
| Dashboard (`bun run dashboard`), Prometheus/OTLP metrics, Grafana files | Built, dashboard checked in Chrome, Grafana never loaded |
| Config (TOML layers, profiles, typed env) | Built and tested |
| Docker image and compose | Written, **never built or run** |

Tests: `bun test` (192 pass) and `bun run typecheck` are green.

## Not verified (do these before any real money)

1. **Wallex private API shapes.** Balances, open orders, place order and cancel response shapes and the `client_id` / `clientOrderId` names are guesses. Set `WALLEX_API_KEY` (trade only, no withdrawal) and run `bun run check`, then fix `parseBalances` / `parseOpenOrders` in `src/wallex/rest.ts` if the output differs. The Wallex MCP returned 503 during development, so account fee data was never read.
2. **The real LLM endpoint.** Set `AI_BASE_URL`, `AI_API_KEY`, `AI_MODEL`, then `bun src/ai/try.ts`.
3. **Credit account.** The challenge account may be a credit sub-account. Check that its balance appears under `/v1/account/balances`.
4. **Docker.** `docker compose build` and the healthcheck have not been run.
5. **Grafana alerts and dashboard.** The files parse, but have never been loaded.
6. **Real fills.** The paper exchange fills a limit order when price trades through it by one tick. Real Wallex queues are different.

## First hour

```sh
bun install
cp .env.example .env            # fill WALLEX_API_KEY, AI_* (never commit .env)
bun test && bun run typecheck
bun run config validate
bun run check                   # private API shapes
bun src/ai/try.ts               # LLM endpoint
bun run backtest --days 7       # ict strategy on an auto-selected universe
bun run live --dry              # validates and logs orders, sends none
bun run live --paper            # full loop with virtual money
```

Real orders need `bun run live --confirm-live` (or `STARCOACH_CONFIRM_LIVE=yes`) and `RUN_END`. Stops are monitored by the running process only, so keep it up. `touch STOP` blocks new entries (`control/STOP` in Docker). `bun run pullout --yes` sells everything to TMN.

## Decisions already made

- Long only. Spot has no shorts and the rules forbid leverage.
- Risk per trade 1% of equity, position cap 50%, at most 2 open positions. Details in `docs/RISK.md`.
- Stop distance must be 1.0–2.5%. Net reward:risk must be at least 1.5 after fees (maker 0.25%, taker 0.3%) and slippage. A net RR of 2 left almost no setups.
- The AI can approve, veto or shrink. It never places orders. If it fails, `AI_FAIL_MODE` decides (default approve).
- Config priority: environment, then `config/local.toml`, then the profile, then `config/default.toml`, then code defaults.

## Honest expectations

Over 7 days on about 12 pairs the detector finds around 2.6 setups per day, and a backtest places roughly 3 to 7 trades for about +1% (`docs/RESEARCH.md`). That sample is too small to show an edge. Do not expect +50% in a day. The activity score (15 points) is at risk because trades are rare. If you want more trades, the options are mirrored bearish setups used as filters, or selling held inventory; both were discussed and parked.

## Before the real run

- Commit and tag the exact code (`git tag run-1`). Every log line carries the short git SHA.
- Set `RUN_END`. The challenge trades for 3 days, while the default run is 24 hours.
- `logs/` and `state/` are gitignored. Add the final run's decision logs with `git add -f logs/<files>` or zip them. The task requires them.
- Record the demo video with `docs/VIDEO_SCRIPT_FA.md` (`bun run dashboard -- --demo` for visuals).

## Map

`src/ict` detectors · `src/strategy/ict.ts` order management · `src/risk` sizing and guard · `src/ai` supervisor and news · `src/exchange` live, dry, paper · `src/runner` backtest and polling · `src/daemon.ts` live loop · `src/settings` and `src/env*.ts` config · `src/dashboard` · `src/telemetry` · `ops/` Grafana · `docker/` entrypoint and healthcheck. Full diagram: `docs/ARCHITECTURE.md`.
