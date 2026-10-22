# Compliance map

Each requirement of the challenge statement (`raw-starcoach-task.txt`) and of the management announcement, with the feature that covers it and how to check it. Items marked **open** are listed again in section 4.

## 1. Rules

| Requirement | How it is met | Check |
|---|---|---|
| All trades by the algorithm, no manual trades | One daemon places every order. There is no manual order path in the code. Every order has `order.intent` with a machine-written `reason` | `grep order.intent logs/live-*.jsonl` |
| Spot only, no leverage (announcement) | Only spot `/v1/account/orders` is called. No margin or credit endpoints. Long only | `src/wallex/rest.ts` |
| Allowed markets only | `config/blocked-markets.txt` (from the announcement) is loaded and every BUY on a blocked symbol is rejected before sending. `--symbols auto` excludes blocked markets. Only TMN pairs are traded | `src/exchange/validate.ts`, `test/universe.test.ts`. Sells are not blocked, so existing holdings can always be closed |
| No self-trading, no coordinated team trades | One account, one process, one strategy. No second account, no counterparty logic | Code review |
| No wash trading or artificial volume | Orders only come from a scored setup that passed fee-aware gates. Each setup trades once. Max 6 entries per hour. At 0.5% to 0.55% round-trip fees a volume loop only loses money | `src/risk/guard.ts`, `setup.accepted` events |
| Profit realised in TMN, no coin left at the end | TMN pairs only. Entries stop 45 min before `RUN_END`, flatten starts 15 min before, `pullout --yes` as manual fallback. `daemon.stop` records `flat` | `daemon.flatten`, `daemon.stop`, RISK.md section 4 |
| Return is net of fees, on 5,000,000 TMN | Fees are in every sizing, gate and simulator calculation. Start equity is `START_TMN` (5,000,000) or the real TMN balance in live mode | `src/config.ts`, `src/risk/size.ts` |
| Trading period 3 days, no withdrawals | `RUN_END` is configurable (set it to the official end minus the flatten window). The key is trade-only | OPERATIONS.md |
| Source on GitHub equals what traded | Every log line carries the git SHA. `state/<mode>-run.json` stores it. `daemon.start` and the startup banner also carry the config hash (`bun run config hash`), so the settings used are verifiable. Commit and tag before the run, run from a clean tree | `sha` field, `git status` |
| Team can explain the algorithm | STRATEGY.md has every rule with the numbers and a worked example | docs |
| Provide md document | README plus `docs/` cover architecture, logic, AI and Wallex tools, buy and sell conditions, risk, re-run and evaluation | see section 2 |
| Decision log per trade, with the reason | JSONL: signal and rationale (`setup.accepted`), rejections with reason, AI verdict and reason, order intent with `reason`, acks, fills, exits with PnL. Logs are part of the hand-in | `logs/` (git-ignored, hand in separately) |
| Demo video, about 5 min, output not source code | [VIDEO_SCRIPT_FA.md](VIDEO_SCRIPT_FA.md) | |

## 2. Required document contents

| Required topic | Where |
|---|---|
| Architecture and main logic | ARCHITECTURE.md, STRATEGY.md |
| Use of AI and Wallex tools | AI.md (supervisor, news, REST, MCP for development only) |
| Buy and sell conditions | STRATEGY.md sections 3 to 7 |
| Capital and risk management | RISK.md |
| Re-running and evaluating | README quick start, TESTING.md, OPERATIONS.md |

## 3. Judging criteria (300 points)

| Criterion (points) | Feature | Evidence |
|---|---|---|
| Final return % (90) | Net-of-fee strategy, TMN-only, flatten at end | Account value at the official end. Backtest: +1.14% over 7 days, tiny sample |
| Loss control (30) | 1% risk per trade, 50% cap, day halt 12%, kill at 30%, profit lock, loss pause | RISK.md, `test/guard.test.ts`, `test/size.test.ts` |
| Activity (15) | **Risk:** the fee-aware gates give few trades, about 3 to 5 in 7 days in the backtest. Regular activity is not guaranteed. Loosening the gates is a trade-off we have not made | RESEARCH.md |
| Stability (15) | Error backoff, strategy exceptions caught, state resume, degraded alarm, flatten retry | ARCHITECTURE.md failure table, `test/daemon.test.ts` |
| Strategy logic (40) | Explicit rules, scored setups, per-trade rationale | STRATEGY.md, logs |
| Real use of AI (35) | Agentic supervisor with news tools can veto or shrink and must justify. Honest scope: it never creates trades | AI.md, `ai.verdict` events. **Open:** real endpoint not yet tested |
| Risk and capital management (30) | Order size cap, stop on every trade, never all capital | RISK.md |
| Reproducibility (25) | One-command backtest, walk-forward, shadow, dry, tests, runbook, pinned `libfx` | README, TESTING.md |
| Backtest and shadow (20) | Same strategy code in every mode | TESTING.md, RESEARCH.md, `logs/` |
| Trades, volume, average size, speed (shown in judging part 1) | `order.ack` has `decisionMs`. Volume and fees in `backtest.summary`. Dashboard and metrics show live counts | logs, dashboard |

UI quality is explicitly not a criterion. The dashboard is an aid for the video and the operator.

## 4. Not yet verified

| Item | Why it matters |
|---|---|
| Private Wallex response shapes: balances, open orders, place and cancel bodies | Parsers are defensive guesses (`parseBalances`, `parseOpenOrders`). Run `bun run check` with the real key and compare |
| Whether the challenge (credit) account is visible through `/v1/account/balances` | The challenge capital is a credit trading plan. The MCP lists separate credit sub-account balance tools. If balances come from another endpoint, equity and flatten would read wrong |
| Order parameters: `client_id` on place, `clientOrderId` on cancel | Taken from the spec we had. A wrong name makes all orders fail at start |
| Real fills, partial fills, fee rates actually charged | Paper fills are all-or-nothing at the limit. Strategy adopts the balance delta, but this has not met a real exchange |
| Real LLM endpoint with tool calling | Only a fake server was used |
| Minimum order size per market, rate limits | Taken from `/v1/markets`, never exercised with real orders |
| 24 h and 72 h continuous run | Not done yet |
| Dashboard, Grafana and alert rules against a live daemon | Dashboard was started in demo mode only. The Docker stack and alert queries have not been run (`ops/README.md` says the same) |
| Whether the blocked list file is complete and current | Copied from the announcement text |
