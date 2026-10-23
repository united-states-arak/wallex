# Testing and verification

The bot is verified at five levels: unit and scenario tests, backtests on historical data, a held-out strategy tournament, shadow and dry runs on the live market, and a live order-path verification with real orders on the challenge account.

## 1. Automated tests

```bash
bun install
bun run test        # 252 tests, about 20 seconds, no network, no keys
bun run typecheck
```

The suite is hermetic: the preload (`test/setup.ts`) removes every application environment variable, so tests never see real keys or touch the network.

| Suite | Tests | What it proves |
|---|---|---|
| `engine` | 15 | Live-like exchange script (fee charged in the coin, partial fills, lost replies, slow balance updates): exits retry after cancelling their own resting sells, failed take-profit cancels are retried, unconfirmed fills and lost replies are reconciled instead of orphaning coins, unsellable remainders are closed as dust, entries sized under the live order cap |
| `combo` | 4 | Washout bounce bought and sold at the take-profit, market-wide crash not bought, take-profit tracked in one shared position book, closed signal bars only |
| `breakout` | 10 | Full trade lifecycle on synthetic markets: breakout detected, AI approves, sized at 1% risk and under 50% of equity, trailing stop rises, profitable trailing exit; AI veto and resize; guard halt; closed market gate; restart persistence; forming hour never used; breadth |
| `security` | 18 | Secret redaction (values, patterns, nested objects), owner-only redacted log files, bounded response reads, constant-time comparison, TLS rules, headline sanitisation, secrets refused in config, dashboard token authentication, body limits, rate limiting, security headers |
| `live-exchange` | 9 | Fill parsing from real Wallex replies, order sanity check (oversized, overpriced, absurd prices refused; sells never blocked), identifier validation, TLS enforcement, AI provider compatibility |
| `guard`, `size` | 20 | Day halt, hard halt, profit locks, kill file, persistence, sizing formula and caps |
| `daemon` | 12 | Run loop survives strategy errors, entry cutoff, nothing sold automatically, state files, restart resume, shutdown cancels pending buys |
| `pullout`, `paper` | 10 | TMN-only routing, dust reporting, cancel failures tolerated, simulator fills and fees, no same-bar fills |
| `ai.supervisor`, `ai.news` | 21 | Tool calls, verdict schema, retries on invalid output, timeouts and fallback, key never logged, feed parsing and caching |
| `dashboard` | 21 | State folding, origin and confirm checks, path traversal refused, SSE |
| `settings`, `env` | 49 | Layering, validation, every alias, profiles, config hash |
| `telemetry`, `healthcheck`, `cli-gate`, `universe`, `research` | 26 | Metrics names against a real scrape, health logic, live confirmation gate |
| `ict.*`, `ict-strategy` | 37 | The alternative ICT model, including no-lookahead tests |

CI (`.github/workflows/ci.yml`) runs the type check, the full suite, `bun audit` and a gitleaks secret scan on every push and pull request, and builds the Docker image and checks that it runs as a non-root user.

## 2. Backtests

```bash
bun run backtest --from 2026-08-23T00:00:00Z --to 2026-10-22T00:00:00Z     # 60 days: +26.79%, max DD 7.82%, 75 round trips
bun run backtest --from 2026-04-25T00:00:00Z --to 2026-10-22T00:00:00Z     # 180 days: +41.43%, max DD 6.15%, 255 round trips
```

The backtest runs the production strategy, risk guard and decision log unchanged against a simulated exchange. Candles come from the public Wallex API (no key) and are cached per day in `data/candles/`.

Simulator assumptions (`src/exchange/paper.ts`):

| Assumption | Value |
|---|---|
| Spread | 10 bps around each close by default (`PAPER_SPREAD_BPS`); the tournament used 30 bps |
| Slippage on taker fills | 10 bps (`PAPER_SLIPPAGE_BPS`) |
| Fees | Maker 0.25%, taker 0.30% |
| Limit fills | Only if price trades through the limit by one tick, from the next bar |
| Marketable orders | Fill at the ask (buy) or bid (sell) |

Every backtest writes a full decision log (`logs/backtest-*.jsonl`) that can be replayed in the dashboard: `bun run dashboard --replay logs/<file>.jsonl --speed 20`.

## 3. Strategy tournament (held-out test)

```bash
bun arena/run.ts --strategy arena/strategies/production-combo.ts                                     # train window
ARENA_FINAL=1 bun arena/run.ts --strategy arena/strategies/production-combo.ts --window test         # held-out window
```

Four AI research agents built competing strategies on 120 days of data; every strategy was then judged once on the following 60 days. The production module reproduces the winning research strategy trade for trade. Full protocol and results: [RESEARCH.md](RESEARCH.md).

## 4. Shadow test (live market, no real orders)

```bash
bun run shadow --minutes 1440
```

Runs the full strategy and the live AI supervisor on live Wallex data with a virtual 5,000,000 TMN account. At start it preloads 8 days of candles for all 15 markets (`strategy.primed` events), then logs `shadow.equity` every cycle and every decision as it happens. Shadow runs of both the combo default and the breakout model were performed on the live market with all 15 markets primed and polled without errors.

## 5. Dry run (live market, orders validated but never sent)

```bash
bun run dry --minutes 60
```

Every order is validated against the live market rules and logged as `dry.would_send`; nothing reaches the exchange. A wiring probe order is validated at start.

## 6. Live order-path verification

Before the run, the production exchange adapter was exercised on the challenge account with small real orders:

| Check | Result |
|---|---|
| Resting limit buy, listed in open orders, cancelled by client id | Passed |
| Marketable buy and sell on BTCTMN and SOLTMN | Filled at once |
| Resting take-profit sell, coin locked, cancelled | Passed |
| `pullout --yes` | Sold the holding on its first price step; account flat |
| Orders spend the 5,000,000 TMN challenge credit | Confirmed |
| Latency to Wallex | Place 136 ms median, cancel 60 ms median |

Every response shape was compared with the client's parsers and the results are documented in [WALLEX.md](WALLEX.md).

## 7. AI supervisor check

```bash
bun src/ai/try.ts
```

Fetches the live news digest and reviews a sample breakout with the configured model. Expected: `"source": "ai"` and the tool calls `get_setup`, `get_news_digest`, `submit_verdict`. See [AI.md](AI.md) for a recorded verdict.

## 8. Pre-run checklist

1. `bun run test && bun run typecheck`
2. `bun run config validate`
3. `bun run check` (balances show the challenge TMN, no open orders)
4. `bun src/ai/try.ts` (`source: "ai"`)
5. `bun run dry --minutes 30`
6. `bun run live --paper --run-end <ISO>` for a few hours
7. Tag the commit, then `bun run live --confirm-live --run-end <ISO>`
