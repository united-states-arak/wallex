# Challenge compliance and judging criteria

This page maps every requirement of the Wallex challenge brief and every line of the scoring table to where it is met and how to verify it.

## 1. Expected outputs of the algorithm

| The algorithm must | How | Evidence |
|---|---|---|
| Receive and analyse market data | Polls 1m candles for 15 markets every 20 s and live quotes every 5 s; builds hourly bars, trend, volatility, volume and market-breadth indicators | `src/runner/poll.ts`, `src/strategy/breakout/tracker.ts`, `poll.warmup` and `strategy.primed` events |
| Identify opportunities with a defined strategy | Two defined models (trend breakout with a market gate, washout bounce), rules in STRATEGY.md | [STRATEGY.md](STRATEGY.md), `setup.accepted` events with the rationale |
| Decide buys and sells algorithmically, without manual intervention | Entry, size, stop, trailing stop and exit are all computed by code; the AI can only approve, shrink or veto | `src/strategy/engine.ts`, `src/strategy/breakout/`, `src/strategy/washout.ts`, decision log |
| Execute trades automatically | Wallex REST orders through the live adapter, with automatic fill tracking | `src/exchange/live.ts`, `order.intent`, `order.ack`, `exchange.place` events |
| Manage capital and risk for positive return | Stop-based sizing at 1% risk, 50% position cap, 2 positions, guard halts, profit locks | [RISK.md](RISK.md) |
| Fast, reviewable and repeatable | 136 ms median order placement; every decision logged with git SHA and config hash; same code in every mode | [WALLEX.md](WALLEX.md), [ARCHITECTURE.md](ARCHITECTURE.md) |
| Let judges re-run and review it | One-command backtests with public data, tournament harness, replayable decision logs, 252 automated tests | [TESTING.md](TESTING.md), README quick start |
| Not depend on one lucky trade | Researched over 180 days and selected on a held-out window; 255 round trips in the 180-day backtest with a 58.8% win rate | [RESEARCH.md](RESEARCH.md) |

## 2. Tools and infrastructure

| Tool | Use |
|---|---|
| Wallex API | Market data, account, order placement, cancellation and lookup (`src/wallex/rest.ts`), verified against the live API |
| Wallex MCP | Registered for the AI development agent in `opencode.json` (key from `WALLEX_API_KEY`) |
| Agentic AI | `libfx` agent with three tools (setup, news digest, verdict) reviewing every trade; autonomous research agents in the strategy tournament |

## 3. Rules and restrictions

| Rule | How it is met | Evidence |
|---|---|---|
| No manual trading | Every order is created by code and logged with a machine-written reason. The daemon has no manual order path. The end-of-run conversion to TMN is the bot's own pullout routine, which places and logs its orders the same way | `grep '"order.intent"' logs/live-*.jsonl` |
| No self-trading | One account, one process, one strategy; no second account and no counterparty logic | Code review |
| No coordinated team trades | The bot trades only the team's challenge account | Code review |
| No wash trading or artificial volume | Orders only follow a qualified breakout or washout signal that passed the risk guard and the AI review; at most 2 positions and one per market; with about 0.6% round-trip cost a volume loop could only lose money, and the strategy trades only when the market offers a signal | `setup.accepted` events |
| Allowed markets only | Buys on markets in `config/blocked-markets.txt` are refused before sending; holdings are sold only through TMN markets; the 15 traded markets are all allowed | `src/exchange/validate.ts`, `src/pullout.ts`, `test/pullout.test.ts` |
| Profit realised in TMN, not held as coins | All markets are TMN pairs; at the end of the run `bun run pullout --yes` converts every holding to TMN; the result is TMN on the account | [RISK.md](RISK.md) section 5 |
| Return net of fees on 5,000,000 TMN | Fees are in every sizing, gate and simulation calculation; the orders spend the challenge's 5,000,000 TMN credit (verified live) | [WALLEX.md](WALLEX.md) |
| Three-day trading period, no withdrawals | `RUN_END` sets the run length; the key is trade-only and the code contains no withdrawal call | [OPERATIONS.md](OPERATIONS.md) |
| Submitted source equals the traded code | Every log line carries the git SHA; the config hash is in the startup banner and `daemon.start`; the run is started from a tagged clean commit | `sha` field in every log line |
| Team can explain the algorithm | Exact rules, parameters and a worked example | [STRATEGY.md](STRATEGY.md) |
| Decision log per trade with the reason | JSONL: signal and rationale (`setup.accepted`), rejections with reason (`setup.rejected`), AI verdict and reason (`ai.verdict`), order intent with reason, acknowledgements, fills, trailing-stop moves, exit with PnL | `logs/` (handed in with the code) |
| Demo video | Persian script with backtest, dashboard and monitoring scenes | [VIDEO_SCRIPT_FA.md](VIDEO_SCRIPT_FA.md) |

## 4. Required documentation contents

| The md document must cover | Where |
|---|---|
| Architecture and main logic | [ARCHITECTURE.md](ARCHITECTURE.md), [STRATEGY.md](STRATEGY.md), [OVERVIEW.md](OVERVIEW.md) |
| How AI and the Wallex tools are used | [AI.md](AI.md), [WALLEX.md](WALLEX.md) |
| Buy and sell decision conditions | [STRATEGY.md](STRATEGY.md) sections 2 and 4 (breakout) and 8 (washout) |
| Capital and risk management | [RISK.md](RISK.md) |
| Re-running and evaluating the algorithm | [TESTING.md](TESTING.md), [RESEARCH.md](RESEARCH.md) section 5, README quick start |

## 5. Scoring table

### Part 1: trading performance (150)

| Criterion (points) | What the bot does | Evidence |
|---|---|---|
| Final return (90) | A strategy profitable on unseen data (+17.52% on the held-out 60 days under 3x harsher costs; +41.43% over 180 days in the production backtest), net of fees, realised in TMN | [RESEARCH.md](RESEARCH.md), final account value |
| Loss control (30) | 1% risk per trade, 50% position cap, 2 positions, market gate and crash filter keep the bot out of weak and crashing markets, day halt, hard halt, profit locks. Maximum drawdown 6.15% over 180 days and 7.85% on the held-out window | [RISK.md](RISK.md), `test/guard.test.ts`, `test/breakout.test.ts`, `test/combo.test.ts` |
| Activity (15) | Regular, reasoned trading: about 4 round trips per 3 days in the backtests (255 in 180 days), from washout bounces every few hours and breakouts in trending markets. Every 15 minutes the bot evaluates all 15 markets and every candidate is reviewed by the AI and logged. A heartbeat every 20 s shows the bot working | `daemon.heartbeat`, `setup.*`, `ai.verdict` events, Grafana |
| Stability (15) | Error backoff per market, strategy exceptions caught, restart-safe state with stops restored, degraded alarm, graceful shutdown, health check, order replies parsed from the real API, 252 tests | [ARCHITECTURE.md](ARCHITECTURE.md) failure table, `test/daemon.test.ts` |

Trading metrics the judges list (number of trades, volume, average trade size, return, speed) are all in the decision log and the metrics: `exit` events (trades and PnL), `exchange.place` (order values and latency), `starcoach_orders_total`, `starcoach_order_latency_ms`, `starcoach_equity_tmn`.

### Part 2: technical quality (150)

| Criterion (points) | What the bot does | Evidence |
|---|---|---|
| Strategy logic (40) | Clear, explainable rules: it buys a 4-day breakout on volume in a rising market, or a sharp coin-specific overshoot; it sells at a trailing stop, a take-profit, a stop or a time stop, each with a stated reason and a worked example | [STRATEGY.md](STRATEGY.md) |
| Real use of AI (35) | An agent with tools reads every candidate, the news and the market mood and decides approve, shrink or veto with a reasoned explanation, verified live with the configured model; autonomous AI agents designed and competed the strategies; an AI agent verified the live system | [AI.md](AI.md), `ai.verdict` events, `arena/*/NOTES.md` |
| Risk and capital management (30) | Order size cap (50% and an absolute 3,000,000 TMN sanity limit), stop on every position, never all-in, account halts, kill switch | [RISK.md](RISK.md), [SECURITY.md](SECURITY.md) section 5 |
| Re-runnable (25) | Tidy TypeScript, typed validated config, a run guide, one-command backtests on public data, Docker, CI | README, [OPERATIONS.md](OPERATIONS.md), [TESTING.md](TESTING.md) |
| Backtest and shadow test (20) | 180-day backtests (+41.43%, max DD 6.15%), a held-out strategy tournament, shadow runs on the live market, dry runs, live order-path verification, all with results | [RESEARCH.md](RESEARCH.md), [TESTING.md](TESTING.md) |

## 6. Hand-in checklist

| Item | Source |
|---|---|
| Source code on GitHub at the traded commit (tagged) | This repository |
| Markdown documentation | `README.md`, `docs/` |
| Decision logs | `logs/live-*.jsonl` plus the backtest, shadow and dry logs |
| Backtest and shadow results | [RESEARCH.md](RESEARCH.md), [TESTING.md](TESTING.md), logs |
| Demo video (about 5 minutes) | Recorded from [VIDEO_SCRIPT_FA.md](VIDEO_SCRIPT_FA.md) |
| Run facts | Start and end time, command, commit SHA, config hash, final TMN balance |
